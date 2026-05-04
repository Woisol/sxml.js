# sxml.js

Streaming XML parser designed for LLM streaming output.

## Motivation

When LLMs stream output incrementally, XML tags (like `<think>`, `<tool_call>`) can be arbitrarily split across chunks. Traditional SAX/StAX parsers assume complete input and struggle with this scenario. sxml.js is purpose-built for this:

- Accepts arbitrarily fragmented string chunks, emits parse results immediately
- Two confirmation modes: `confirmAt:'close'` (default) — emits structured event on tag closure; `confirmAt:'open'` — emits immediately on opening, content streamed live via updates
- Tags support nesting — default 1 level, child tags auto-absorbed as parent attributes

## Installation

```bash
npm install @woisol-g/sxml.js
# or
pnpm add @woisol-g/sxml.js
```

## Quick Start

```typescript
import { SxmlParser } from '@woisol-g/sxml.js';

const parser = new SxmlParser({
  legalTags: ['think', 'tool_call'],
});

// Stream chunks incrementally
parser.write('Let me think');
parser.write('<think>this is a');
parser.write('thinking step</think>');
parser.write('<tool_call name="calc">4</tool_call>');
parser.end();

// Synchronous pull
let result;
while ((result = parser.tryPull()) !== null) {
  // result.update — replaces the last text event
  // result.append — appends new events
}

// Or async pull
const result = await parser.pull();
```

## Core Concepts

### Three-Layer Architecture

```
L1 Tokenizer (character-level state machine)
  ↓ XML semantic events
L2 XmlProcessor (tag stack manager)
  ↓ stack-context events
L3 SxmlParser (business event layer)
  ↓ SxmlResult incremental patches
Consumer
```

### SxmlResult

Incremental patches telling the consumer how to update its event list:

```typescript
interface SxmlResult {
  update?: SxmlEvent | null; // replace the last event; null clears it
  append: SxmlEvent[];    // append new events
}
```

Consumer event list maintenance:

```typescript
if (result.update === null) events.pop();
else if (result.update !== undefined) events[events.length - 1] = result.update;
events.push(...result.append);
```

### Backtracking

Unclosed tags stream as raw text. When the tag closes, the raw text is truncated and a structured event is appended.

```
Input chunks: '<think' → '>hello</think>'

chunk 1: "<think"     → { append: [text("<think")] }
chunk 2: "hello</think>"  → { update: null, append: [think("hello")] }
```

### Instant Confirmation (confirmAt: 'open')

Tags with `confirmAt:'open'` emit a business event immediately when the opening tag is seen, without waiting for `</tag>`. Subsequent text content is streamed directly into the event via `update`.

```
legalTags: [{ name: 'think', confirmAt: 'open' }]
Input: before<think>hello</think>after

Output sequence:
  1. { append: [text("before"), think(content="")] }
  2. { update: think(content="hello") }          ← live text update
  3. { update: think(content="hello") }          ← close confirmation
  4. { append: [text("after")] }
```

This is useful for tags like `<think>` where the UI should immediately enter a "thinking" state and stream content live, without needing `\r` overwrites.

### Default Tag Handler

Tags in `legalTags` automatically use the default handler, producing events shaped as `{ type, name, ...attrs, content }`. Nested child tags are absorbed as parent attributes (when both use the default handler).

```typescript
// Input: <outer><inner>val</inner>text</outer>
// Output:
{ type: 'outer', name: 'outer', content: 'text', inner: 'val' }
```

### Custom Tag Handler

Override specific tags via `tagHandlers`:

```typescript
const parser = new SxmlParser({
  legalTags: ['tool_call'],
  tagHandlers: {
    tool_call: {
      build(tagName, attrs, children) {
        const content = children
          .filter(c => c.type === 'text')
          .map(c => c.content)
          .join('');
        return {
          type: 'tool_call',
          toolName: attrs.name,
          result: Number(content),
        };
      },
    },
  },
});
```

## API

### SxmlParser

| Method | Description |
|--------|-------------|
| `write(chunk)` | Write a string chunk |
| `end()` | Signal end of stream |
| `isEnd` | Read-only getter indicating whether the stream has ended |
| `lastConfirm` | Read-only getter indicating whether the last public event is stable and will not be changed by later `update` patches; useful for persistence |
| `tryPull()` | Pull next result synchronously, returns `null` if none available |
| `pull()` | Pull next result asynchronously, returns `Promise<SxmlResult \| null>` |
| `reset()` | Reset parser to initial state |

### SxmlConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `legalTags` | `LegalTagConfig[]` | — | Whitelist of tag names. Each entry can be a string (`confirmAt:'close'`) or `{ name, confirmAt }` object |
| `tagCharPattern` | `RegExp` | `/^[a-zA-Z0-9_\-.:]$/` | Tag name character regex (used when `legalTags` is not set) |
| `tagHandlers` | `Record<string, TagHandler>` | — | Custom tag handler overrides |
| `maxNestingDepth` | `number` | `1` | Maximum nesting depth for tag parsing |
| `maxBufferSize` | `number` | `1048576` | Maximum buffer size in bytes |
| `errorStrategy` | `ErrorStrategy` | `lenient` | Error handling strategy |

### LegalTagConfig

Each entry in `legalTags` can be a plain string or an object:

```typescript
type LegalTagConfig = string | { name: string; confirmAt: 'open' | 'close' };
```

- String shorthand → `{ name: 'tagname', confirmAt: 'close' }`
- `{ name: 'think', confirmAt: 'open' }` → emit immediately on opening, stream content via updates

### ErrorStrategy

| Mode | Description |
|------|-------------|
| `strict` | Throw immediately on XML syntax errors |
| `lenient` | Skip erroneous chars, emit error events, continue (default) |
| `silent` | Skip erroneous chars silently |

## Edge Cases

**Self-closing tags**: Supports both `<br/>` and `<br />` (space variant).

**Attribute quotes**: Supports double and single quotes. Values can contain the other quote type.

**Nesting depth limit**: Default parses 1 level only. Tags beyond `maxNestingDepth` remain as raw XML text.

## Development

```bash
pnpm install
pnpm test    # type-check + 65 tests
pnpm build   # build dist bundle
pnpm check   # lint + test
```

## License

ISC
