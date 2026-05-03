/**
 * sxml.js Demo — streaming LLM XML parser with colored terminal output.
 *
 * Usage:
 *   pnpm demo
 *   # or
 *   node --import tsx project/demo/demo.js
 *
 * Edit CONFIG below to set your API key / endpoint / model.
 */

// ================================================================
// Configuration — edit these before running
// ================================================================
const CONFIG = {
  // OpenAI-compatible API endpoint
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-your-api-key-here',
  model: 'gpt-4o-mini',


  // System prompt — instructs the model to use <think> and <tool_call>
  systemPrompt:
    'You are a helpful assistant. When reasoning or thinking step-by-step, wrap your thoughts in <think></think> tags. ' +
    'When you need to call a tool, use exact XML syntax like: ' +
    '<tool_call name="toolName" arg1="val1">parameters</tool_call>. ' +
    // 'You should always call end-chat(isEnd=true) tool when at the end of this chat. ' +
    // 'Or mid-chat(isMid=true) tool when in the middle of this chat. ' +
    'You may use multiple think blocks and tool calls in one response.',

  // Request parameters
  temperature: 0.7,
  maxTokens: 4096,

  // Delay in ms to simulate realistic chunk boundaries (0 = no artificial delay)
  chunkDelay: 0,
};

// ================================================================
// ANSI escape codes
// ================================================================
const GRAY = '\x1b[90m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

// ================================================================
// Imports
// ================================================================
const readline = require('readline');
const { SxmlParser } = require('../../src/sxml-parser');

// ================================================================
// Helpers
// ================================================================

/** Pad visible characters to the given width to cover previous content */
function padToWidth(str, width) {
  const visible = str.replace(/\x1b\[\d+m/g, '').length;
  const pad = Math.max(0, width - visible);
  return str + ' '.repeat(pad);
}

/** Count visible characters (strip ANSI codes) */
function visibleLen(str) {
  return str.replace(/\x1b\[\d+m/g, '').length;
}

// ================================================================
// Display state
// ================================================================

let currentLine = '';         // text currently on the "pending" line
let currentLineWidth = 0;     // visible width of that line
let lastTextContent = '';     // last known text event content
let textClean = '';           // accumulated clean text (tags stripped)
let hadThink = false;         // whether we've output a think block
let hadTool = false;          // whether we've output a tool_call block

function resetDisplay() {
  if (currentLineWidth > 0) process.stdout.write('\n');
  currentLine = '';
  currentLineWidth = 0;
  lastTextContent = '';
  textClean = '';
  hadThink = false;
  hadTool = false;
}

/**
 * Write text to the current line.  If we already have text on this line,
 * overwrite it using \r.  Pad with spaces to clear stale characters.
 */
function writeText(text) {
  if (currentLineWidth > 0) {
    // Overwrite the existing line
    const line = padToWidth(text, currentLineWidth);
    process.stdout.write('\r' + line);
    currentLine = line;
    currentLineWidth = Math.max(currentLineWidth, visibleLen(line));
  } else {
    process.stdout.write(text);
    currentLine = text;
    currentLineWidth = visibleLen(text);
  }
}

/** Flush the current line to a newline, starting a fresh line. */
function endLine() {
  if (currentLineWidth > 0) {
    process.stdout.write('\n');
    currentLine = '';
    currentLineWidth = 0;
  }
}

/** Output a think block on its own line in gray. */
function outputThink(content) {
  endLine();
  const text = content.trim();
  if (!text) return;
  // Split into lines and indent each
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.trim()) {
      process.stdout.write(GRAY + '  ' + line.trim() + RESET + '\n');
    }
  }
  hadThink = true;
}

/** Output a tool_call block on its own line in red. */
function outputToolCall(event) {
  endLine();
  const name = event.name || event.type;
  const attrs = { ...event };
  delete attrs.type;
  delete attrs.name;
  delete attrs.content;

  const attrStr = Object.entries(attrs)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');

  const contentStr = event.content ? ' ' + event.content : '';
  process.stdout.write(RED + `  [${name}] ${attrStr}${contentStr}` + RESET + '\n');
  hadTool = true;
}

// ================================================================
// LLM streaming client
// ================================================================

/**
 * Call the LLM API with streaming enabled.
 * Returns an async iterable of string chunks.
 */
async function* streamLLM(messages) {
  const url = `${CONFIG.baseUrl}/chat/completions`;
  const body = JSON.stringify({
    model: CONFIG.model,
    messages,
    temperature: CONFIG.temperature,
    max_tokens: CONFIG.maxTokens,
    stream: true,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.apiKey}`,
    },
    body,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API error ${response.status}: ${errText}`);
  }

  // Read SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') return;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // skip malformed lines
      }
    }
  }
}

// ================================================================
// Core parse-and-display loop
// ================================================================

function processResult(result, events) {
  if (result.update) {
    // Update the last event in our event list
    events[events.length - 1] = result.update;

    // If the update is a text event, refresh the current line
    if (result.update.type === 'text') {
      const content = result.update.content;
      lastTextContent = content;
      writeText(content);
    }
  }

  for (const ev of result.append) {
    events.push(ev);

    if (ev.type === 'text') {
      lastTextContent = ev.content;
      writeText(ev.content);
    } else if (ev.type === 'think') {
      outputThink(ev.content);
    } else if (ev.type === 'tool_call') {
      outputToolCall(ev);
    } else {
      // Other business events — print generically
      endLine();
      process.stdout.write(GRAY + `  [${ev.type}] ${JSON.stringify(ev)}` + RESET + '\n');
    }
  }
}

// ================================================================
// Main interactive loop
// ================================================================

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   sxml.js — LLM Streaming Demo       ║');
  console.log('╠══════════════════════════════════════╣');
  console.log('║  Text …… normal output               ║');
  console.log('║  Think …… gray lines                 ║');
  console.log('║  Tool  …… red lines                  ║');
  console.log('║  Type /exit to quit, /clear to reset ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  // readline 👍
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  const messages = [
    { role: 'system', content: CONFIG.systemPrompt },
  ];

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();

    if (input === '/exit' || input === '/quit') {
      break;
    }
    if (input === '/clear') {
      messages.length = 1;
      resetDisplay();
      console.log('[Conversation cleared]');
      rl.prompt();
      continue;
    }
    if (!input) {
      rl.prompt();
      continue;
    }

    messages.push({ role: 'user', content: input });
    resetDisplay();

    // ---- SXML Demo 实现 ----
    const parser = new SxmlParser({
      legalTags: ['think', 'tool_call'],
    });
    const events = [];
    let _fullText = '';

    try {
      for await (const chunk of streamLLM(messages)) {
        parser.write(chunk);
        _fullText += chunk;

        // Pull and process results
        let result;
        // write 后 pull 所有事件
        while ((result = parser.tryPull()) !== null) {
          processResult(result, events);
        }

        if (CONFIG.chunkDelay > 0) {
          await new Promise(r => setTimeout(r, CONFIG.chunkDelay));
        }
      }

      // Final drain
      parser.end();
      let result;
      while ((result = parser.tryPull()) !== null) {
        processResult(result, events);
      }
      console.log(GRAY + '--- [End of response]' + RESET);
      console.log('');
      console.log(GRAY + `Full response text: ${_fullText}` + RESET);
    } catch (err) {
      endLine();
      process.stdout.write(RED + `  Error: ${err.message}` + RESET + '\n');
      // Remove the failed user message so we can retry
      messages.pop();
    }

    // Finish the last line and add assistant response to history
    endLine();

    // Build assistant content from events (for multi-turn)
    const assistantContent = events
      .filter(e => e.type === 'text')
      .map(e => e.content)
      .join('')
      + events.filter(e => e.type !== 'text').map(e => {
        if (e.type === 'think') return `<think>${e.content}</think>`;
        if (e.type === 'tool_call') {
          const attrs = { ...e };
          delete attrs.type; delete attrs.name; delete attrs.content;
          const a = Object.entries(attrs).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
          return `<tool_call name="${e.name}" ${a}>${e.content || ''}</tool_call>`;
        }
        return '';
      }).join('');

    if (assistantContent.trim()) {
      messages.push({ role: 'assistant', content: assistantContent });
    }

    rl.prompt();
  }

  console.log('');
  rl.close();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
