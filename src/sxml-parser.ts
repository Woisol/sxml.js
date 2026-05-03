import {
  SxmlConfig,
  SxmlEvent,
  SxmlResult,
  TagHandler,
  TextEvent,
  BusinessEvent,
  OpenTagEntry,
  DEFAULT_CONFIG,
} from './types';
import { Tokenizer } from './tokenizer';
import { XmlProcessor, XmlEvent } from './xml-processor';

const DefaultTagHandler: TagHandler = {
  build(tagName, attributes, children) {
    const content = children
      .filter(c => c.type === 'text')
      .map(c => (c as TextEvent).content)
      .join('');

    const nestedAttrs: Record<string, unknown> = {};
    for (const c of children) {
      if (c.type !== 'text') {
        const be = c as BusinessEvent;
        nestedAttrs[be.type] = (be as any).content ?? '';
      }
    }

    return {
      type: tagName,
      name: tagName,
      ...attributes,
      ...nestedAttrs,
      content,
    };
  },
};

export class SxmlParser {
  private tokenizer: Tokenizer;
  private xmlProcessor: XmlProcessor;
  private tagHandlers: Record<string, TagHandler>;

  private events: SxmlEvent[] = [];
  private pendingText: string = '';
  private tagStack: OpenTagEntry[] = [];
  private resultQueue: SxmlResult[] = [];
  private pendingResolve: ((value: SxmlResult | null) => void) | null = null;
  private ended: boolean = false;
  private consumerLen: number = 0; // how many events consumer has seen

  constructor(config: SxmlConfig) {
    this.tagHandlers = config.tagHandlers ?? {};

    this.tokenizer = new Tokenizer(
      config.legalTags,
      config.tagCharPattern,
      config.maxBufferSize ?? DEFAULT_CONFIG.maxBufferSize,
      config.errorStrategy ?? DEFAULT_CONFIG.errorStrategy,
      config.maxNestingDepth ?? DEFAULT_CONFIG.maxNestingDepth,
    );

    this.xmlProcessor = new XmlProcessor(
      config.errorStrategy ?? DEFAULT_CONFIG.errorStrategy,
    );
  }

  // ============================================================
  // Public API
  // ============================================================

  write(chunk: string): void {
    if (this.ended) return;
    this.tokenizer.write(chunk);
    this.processTokenizerEvents();
    this.resolvePendingIfReady();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;

    this.tokenizer.end();
    this.processTokenizerEvents();
    this.xmlProcessor.end();
    this.flushL2Events();
    this.endOpenTags();
    this.resolvePendingIfReady();
  }

  reset(): void {
    this.tokenizer.reset();
    this.xmlProcessor.reset();
    this.events = [];
    this.pendingText = '';
    this.tagStack = [];
    this.resultQueue = [];
    this.pendingResolve = null;
    this.ended = false;
    this.consumerLen = 0;
  }

  async pull(): Promise<SxmlResult | null> {
    const result = this.tryPull();
    if (result !== null) return result;
    if (this.ended && this.resultQueue.length === 0) return null;

    return new Promise(resolve => {
      this.pendingResolve = resolve;
    });
  }

  tryPull(): SxmlResult | null {
    this.processTokenizerEvents();
    if (this.resultQueue.length > 0) {
      return this.resultQueue.shift()!;
    }
    return this.flushPendingTextOutput();
  }

  // ============================================================
  // Core pipeline — interleaved flush + L1→L2→L3
  // ============================================================

  private processTokenizerEvents(): void {
    let l1Event: any;
    while ((l1Event = this.tokenizer.pull()) !== null) {
      // Flush text up to this event's position in the buffer
      const bufferPos: number = l1Event._bufferPos ?? 0;
      const flushed = this.tokenizer.flushUpTo(bufferPos);
      if (flushed) {
        this.pendingText += flushed;
      }

      // Feed to L2 (without _bufferPos)
      const cleanEvent = { ...l1Event };
      delete cleanEvent._bufferPos;
      this.xmlProcessor.push(cleanEvent);

      // Immediately process L2 output
      this.flushL2Events();
    }

    // Flush any remaining text
    const flushed = this.tokenizer.flushPendingText();
    if (flushed) {
      this.pendingText += flushed;
    }
  }

  private flushL2Events(): void {
    let l2Event: XmlEvent | null;
    while ((l2Event = this.xmlProcessor.pull()) !== null) {
      this.handleL2Event(l2Event);
    }
  }

  // ============================================================
  // L2 event dispatch
  // ============================================================

  private handleL2Event(event: XmlEvent): void {
    switch (event.type) {
      case 'text':
        // L2 text events: add to pendingText (no tag boundaries)
        this.pendingText += event.content;
        break;

      case 'elementOpen':
        this.handleElementOpen(event.name, event.attributes);
        break;

      case 'elementClose':
        this.handleElementClose(event.name);
        break;

      case 'selfClose':
        this.handleSelfClose(event.name, event.attributes);
        break;

      case 'error':
        break;
    }
  }

  // ============================================================
  // Tag handlers
  // ============================================================

  private handleElementOpen(name: string, attributes: Record<string, string>): void {
    // pendingText includes everything since last event, e.g. "text<before<tagname>"
    // Find where '<' of this tag sits in pendingText
    const tagIdx = this.pendingText.indexOf('<');
    const pendingLen = this.pendingText.length;
    let rawTextStartOffset: number;
    let openTagLength: number;
    let result: { eventIndex: number; offset: number };

    if (tagIdx >= 0) {
      // '<' found in current pendingText
      openTagLength = pendingLen - tagIdx;
      result = this.commitPendingText();
      rawTextStartOffset = result.offset + tagIdx;
    } else {
      // '<' was committed in a previous flush (or there's no pending text).
      // Search backwards in the last text event for the '<'.
      const lastIdx = this.events.length - 1;
      const lastEv = lastIdx >= 0 ? this.events[lastIdx] : null;
      result = this.commitPendingText();

      if (lastEv && lastEv.type === 'text') {
        const lastContent = (lastEv as TextEvent).content;
        // content before pendingText was appended: first {result.offset} chars
        const ltPos = lastContent.lastIndexOf('<', result.offset - 1);
        if (ltPos >= 0) {
          rawTextStartOffset = ltPos;
          openTagLength = (result.offset - ltPos) + pendingLen;
        } else {
          rawTextStartOffset = result.offset;
          openTagLength = pendingLen;
        }
      } else {
        rawTextStartOffset = result.offset;
        openTagLength = pendingLen;
      }
    }

    const entry: OpenTagEntry = {
      name,
      attributes: { ...attributes },
      childrenStartIndex: this.events.length,
      rawTextEventIndex: result.eventIndex,
      rawTextStartOffset,
      openTagLength,
      depth: this.tagStack.length,
      pendingChildren: [],
      useDefaultHandler: !this.tagHandlers[name],
    };

    this.tagStack.push(entry);

    // Tell consumer about the new/updated text
    this.emitTextResult(result);
  }

  private handleElementClose(name: string): void {
    this.commitPendingText();

    // Find matching open tag
    let entryIdx = -1;
    for (let i = this.tagStack.length - 1; i >= 0; i--) {
      if (this.tagStack[i].name === name) {
        entryIdx = i;
        break;
      }
    }

    if (entryIdx < 0) return;

    // Resolve any inner tags (above the matching entry) as unclosed first.
    // They never received their own close tag (mismatch scenario).
    const closeTagLength = `</${name}>`.length;
    while (this.tagStack.length - 1 > entryIdx) {
      const inner = this.tagStack.pop()!;
      this.resolveTagAsUnclosed(inner, closeTagLength);
    }

    // Resolve the matching entry with its correct close name
    const matched = this.tagStack.pop()!;
    this.resolveTag(matched, name);
  }

  /** Resolve a tag that never received its own close tag (mismatch recovery) */
  private resolveTagAsUnclosed(entry: OpenTagEntry, outerCloseTagLength: number): void {
    const textChildren = this.extractEndTextChildren(entry, outerCloseTagLength);
    const allChildren: SxmlEvent[] = [
      ...textChildren,
      ...this.events.slice(entry.childrenStartIndex),
      ...entry.pendingChildren,
    ];

    this.truncateTextAt(entry.rawTextEventIndex, entry.rawTextStartOffset);
    this.events.splice(entry.childrenStartIndex);

    const handler = this.tagHandlers[entry.name] ?? DefaultTagHandler;
    const bizEvent = handler.build(entry.name, entry.attributes, allChildren);

    if (!bizEvent) return;

    if (this.tagStack.length > 0) {
      const parent = this.tagStack[this.tagStack.length - 1];
      if (parent.useDefaultHandler && entry.useDefaultHandler) {
        parent.pendingChildren.push(bizEvent);
        this.emitResolveResult(entry.rawTextEventIndex, null, true);
        return;
      }
    }

    this.events.push(bizEvent);
    this.emitResolveResult(entry.rawTextEventIndex, bizEvent);
  }

  private handleSelfClose(name: string, attributes: Record<string, string>): void {
    // Find where '<' of this tag sits in pendingText (like handleElementOpen)
    const tagIdx = this.pendingText.indexOf('<');
    const tagOffsetInPending = tagIdx >= 0 ? tagIdx : 0;

    const result = this.commitPendingText();
    const rawTextStartOffset = result.offset + tagOffsetInPending;

    // Truncate at the position where the self-closing tag starts
    this.truncateTextAt(result.eventIndex, rawTextStartOffset);

    // Remove the text event if it's now empty (e.g. consecutive self-closing tags)
    let textEventIndex = result.eventIndex;
    if (textEventIndex >= 0 && textEventIndex < this.events.length) {
      const ev = this.events[textEventIndex];
      if (ev.type === 'text' && (ev as TextEvent).content === '') {
        this.events.splice(textEventIndex, 1);
        this.consumerLen = Math.min(this.consumerLen, this.events.length);
        textEventIndex = -1;
      }
    }

    const handler = this.tagHandlers[name] ?? DefaultTagHandler;
    const bizEvent = handler.build(name, attributes, []);

    if (bizEvent) {
      this.events.push(bizEvent);
      this.emitResolveResult(textEventIndex, bizEvent);
    }
  }

  // ============================================================
  // Tag resolution
  // ============================================================

  private resolveTag(entry: OpenTagEntry, closeName: string): void {
    const closeTagLength = `</${closeName}>`.length;
    const textChildren = this.extractTextChildren(entry, closeTagLength);

    // Combine with pending children (from absorbed sub-tags)
    const allChildren: SxmlEvent[] = [
      ...textChildren,
      ...this.events.slice(entry.childrenStartIndex),
      ...entry.pendingChildren,
    ];

    // Truncate the main text event
    this.truncateTextAt(entry.rawTextEventIndex, entry.rawTextStartOffset);

    // Remove children region
    this.events.splice(entry.childrenStartIndex);

    // Build business event
    const handler = this.tagHandlers[entry.name] ?? DefaultTagHandler;
    const bizEvent = handler.build(entry.name, entry.attributes, allChildren);

    if (!bizEvent) return;

    const parentDepth = this.tagStack.length;

    if (parentDepth > 0) {
      const parent = this.tagStack[this.tagStack.length - 1];
      if (parent.useDefaultHandler && entry.useDefaultHandler) {
        parent.pendingChildren.push(bizEvent);
        this.emitResolveResult(entry.rawTextEventIndex, null, true);
        return;
      }
    }

    this.events.push(bizEvent);
    this.emitResolveResult(entry.rawTextEventIndex, bizEvent);
  }

  /**
   * Extract text children from the merged text event.
   * The text between `>` of opening tag and `<` of closing tag is the text content.
   */
  private extractTextChildren(entry: OpenTagEntry, closeTagLength: number): SxmlEvent[] {
    if (entry.rawTextEventIndex < 0 || entry.rawTextEventIndex >= this.events.length) return [];

    const textEvent = this.events[entry.rawTextEventIndex];
    if (textEvent.type !== 'text') return [];

    const content = (textEvent as TextEvent).content;
    const contentStart = entry.rawTextStartOffset + entry.openTagLength;
    const contentEnd = content.length - closeTagLength;

    if (contentStart >= contentEnd) return [];

    const childText = content.substring(contentStart, contentEnd);
    if (childText.length > 0) {
      return [{ type: 'text', content: childText }];
    }
    return [];
  }

  private endOpenTags(): void {
    while (this.tagStack.length > 0) {
      const entry = this.tagStack.pop()!;

      // No close tag, so the text from offset to end is the children content
      const textChildren = this.extractEndTextChildren(entry);

      const allChildren: SxmlEvent[] = [
        ...textChildren,
        ...this.events.slice(entry.childrenStartIndex),
        ...entry.pendingChildren,
      ];

      this.truncateTextAt(entry.rawTextEventIndex, entry.rawTextStartOffset);
      this.events.splice(entry.childrenStartIndex);

      const handler = this.tagHandlers[entry.name] ?? DefaultTagHandler;
      const bizEvent = handler.build(entry.name, entry.attributes, allChildren);

      if (!bizEvent) continue;

      if (this.tagStack.length > 0) {
        const parent = this.tagStack[this.tagStack.length - 1];
        if (parent.useDefaultHandler && entry.useDefaultHandler) {
          parent.pendingChildren.push(bizEvent);
          this.emitResolveResult(entry.rawTextEventIndex, null, true);
          continue;
        }
      }

      this.events.push(bizEvent);
      this.emitResolveResult(entry.rawTextEventIndex, bizEvent);
    }
  }

  private extractEndTextChildren(entry: OpenTagEntry, outerCloseTagLength?: number): SxmlEvent[] {
    if (entry.rawTextEventIndex < 0 || entry.rawTextEventIndex >= this.events.length) return [];

    const textEvent = this.events[entry.rawTextEventIndex];
    if (textEvent.type !== 'text') return [];

    const content = (textEvent as TextEvent).content;
    const contentStart = entry.rawTextStartOffset + entry.openTagLength;
    const contentEnd = outerCloseTagLength !== undefined
      ? content.length - outerCloseTagLength
      : content.length;

    if (contentStart >= contentEnd) return [];

    const childText = content.substring(contentStart, contentEnd);
    if (childText.length > 0) {
      return [{ type: 'text', content: childText }];
    }
    return [];
  }

  // ============================================================
  // Text helpers
  // ============================================================

  private commitPendingText(): { eventIndex: number; offset: number } {
    if (this.pendingText.length === 0) {
      const lastIdx = this.events.length - 1;
      if (lastIdx >= 0 && this.events[lastIdx].type === 'text') {
        return { eventIndex: lastIdx, offset: (this.events[lastIdx] as TextEvent).content.length };
      }
      return { eventIndex: -1, offset: 0 };
    }

    const lastIdx = this.events.length - 1;
    let eventIndex: number;
    let offset: number;

    if (lastIdx >= 0 && this.events[lastIdx].type === 'text') {
      const te = this.events[lastIdx] as TextEvent;
      offset = te.content.length;
      te.content += this.pendingText;
      eventIndex = lastIdx;
    } else {
      offset = 0;
      eventIndex = this.events.length;
      this.events.push({ type: 'text', content: this.pendingText });
    }

    this.pendingText = '';
    return { eventIndex, offset };
  }

  private truncateTextAt(eventIndex: number, offset: number): void {
    if (eventIndex < 0 || eventIndex >= this.events.length) return;
    const ev = this.events[eventIndex];
    if (ev.type !== 'text') return;
    (ev as TextEvent).content = (ev as TextEvent).content.substring(0, offset);
  }

  private makeUpdate(eventIndex: number): SxmlEvent | undefined {
    if (eventIndex < 0 || eventIndex >= this.events.length) return undefined;
    const ev = this.events[eventIndex];
    if (ev.type === 'text') {
      return { type: 'text', content: (ev as TextEvent).content };
    }
    return undefined;
  }

  // ============================================================
  // Output helpers
  // ============================================================

  /** Create a snapshot copy of an event so results are immutable */
  private cloneEvent(ev: SxmlEvent): SxmlEvent {
    if (ev.type === 'text') {
      return { type: 'text', content: (ev as TextEvent).content };
    }
    return { ...ev };
  }

  /** Emit a text result: tells consumer a text event was created or updated */
  private emitTextResult(commit: { eventIndex: number; offset: number }): void {
    if (commit.eventIndex < 0) return;

    if (this.consumerLen === 0 && this.events.length > 0) {
      // Consumer hasn't seen any events yet — use append for the first one
      this.emitResult({ append: [this.cloneEvent(this.events[0])] });
      this.consumerLen = 1;
    } else if (commit.eventIndex < this.consumerLen) {
      // Consumer already has this event — use update
      this.emitResult({ update: this.cloneEvent(this.events[commit.eventIndex]), append: [] });
    } else {
      // New event consumer hasn't seen
      this.emitResult({ append: [this.cloneEvent(this.events[commit.eventIndex])] });
      this.consumerLen = this.events.length;
    }
  }

  /** Emit a resolve result: text truncated + business event appended */
  private emitResolveResult(textEventIndex: number, bizEvent: SxmlEvent | null, appendOnly: boolean = false): void {
    const append: SxmlEvent[] = [];
    let update: SxmlEvent | undefined = undefined;

    // Determine whether the text event at textEventIndex should be
    // sent as an update (replaces consumer's last event) or as append.
    if (textEventIndex >= 0 && textEventIndex < this.events.length) {
      const textEv = this.events[textEventIndex];
      const textContent = textEv.type === 'text' ? (textEv as TextEvent).content : '';

      if (textEventIndex < this.consumerLen) {
        // Consumer already knows about this text event.
        // Only use update if no business events were emitted
        // between this text event and the consumer's cursor —
        // otherwise the update would overwrite a biz event.
        let blocked = false;
        for (let i = textEventIndex + 1; i < this.consumerLen && i < this.events.length; i++) {
          if (this.events[i].type !== 'text') { blocked = true; break; }
        }
        if (!blocked) {
          update = this.cloneEvent(textEv);
        } else if (textContent.length > 0) {
          append.push(this.cloneEvent(textEv));
        }
      } else if (textContent.length > 0) {
        // Consumer hasn't seen this event yet — append it
        append.push(this.cloneEvent(textEv));
      }
    }

    if (bizEvent) append.push(bizEvent);

    if (appendOnly) {
      this.emitResult({ update, append: [] });
    } else {
      this.emitResult({ update, append });
    }

    this.consumerLen = this.events.length;
  }

  // ============================================================
  // Output
  // ============================================================

  private flushPendingTextOutput(): SxmlResult | null {
    if (this.pendingText.length === 0) return null;

    const lastIdx = this.events.length - 1;
    if (lastIdx >= 0 && this.events[lastIdx].type === 'text' && this.consumerLen > lastIdx) {
      // Consumer has the last event — extend it
      const te = this.events[lastIdx] as TextEvent;
      te.content += this.pendingText;
      const result: SxmlResult = { update: { type: 'text', content: te.content }, append: [] };
      this.pendingText = '';
      return result;
    } else {
      // New event
      const te: TextEvent = { type: 'text', content: this.pendingText };
      this.pendingText = '';
      this.events.push(te);
      this.consumerLen = this.events.length;
      return { append: [this.cloneEvent(te)] };
    }
  }

  private emitResult(result: SxmlResult): void {
    if (result.update === undefined && result.append.length === 0) return;
    this.resultQueue.push(result);
  }

  private resolvePendingIfReady(): void {
    if (!this.pendingResolve) return;

    const resolve = this.pendingResolve;
    this.pendingResolve = null;

    if (this.resultQueue.length > 0) {
      resolve(this.resultQueue.shift()!);
    } else {
      const flushed = this.flushPendingTextOutput();
      if (flushed) {
        resolve(flushed);
      } else if (this.ended) {
        resolve(null);
      } else {
        this.pendingResolve = resolve;
      }
    }
  }
}
