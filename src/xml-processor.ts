import { TokenizerEvent, ErrorStrategy } from './types';

export type XmlEvent = TokenizerEvent;

/**
 * L2 XmlProcessor — maintains XML tag stack and validates open/close matching.
 * Passes through tokenizer events with stack context.
 */
export class XmlProcessor {
  private tagStack: string[] = [];
  private eventQueue: XmlEvent[] = [];
  private errorStrategy: ErrorStrategy;
  private tryFallback: boolean = false;

  constructor(errorStrategy: ErrorStrategy = ErrorStrategy.LENIENT, tryFallback?: boolean) {
    this.errorStrategy = errorStrategy;
    if (tryFallback !== undefined) this.tryFallback = tryFallback;
  }

  /** Push a L1 event into the processor */
  push(event: TokenizerEvent): void {
    switch (event.type) {
      case 'elementOpen':
        this.handleElementOpen(event);
        break;
      case 'elementClose':
        this.handleElementClose(event);
        break;
        // Self-closing: passthrough, no stack change
      case 'selfClose':
      case 'text':
      case 'error':
        // Passthrough
        this.eventQueue.push(event);
        break;
    }
  }

  /** Pull next L2 event */
  pull(): XmlEvent | null {
    return this.eventQueue.shift() ?? null;
  }

  /** Current tag stack depth */
  get depth(): number {
    return this.tagStack.length;
  }

  /** Top of tag stack (null if empty) */
  get topTag(): string | null {
    return this.tagStack.length > 0 ? this.tagStack[this.tagStack.length - 1] : null;
  }

  /** Signal end of input. Handle unclosed tags. */
  end(): void {
    if (this.tagStack.length === 0) return;

    if (this.tryFallback) {
      // B/D: synthesize close events for all open tags (innermost first)
      const unclosed = [...this.tagStack];
      for (let i = unclosed.length - 1; i >= 0; i--) {
        this.eventQueue.push({
          type: 'elementClose',
          name: unclosed[i],
          _fallback: true,
        } as any);
      }
      this.tagStack = [];
      return;
    }

    if (this.errorStrategy === ErrorStrategy.STRICT) {
      throw new Error(
        `Unclosed tags at end of input: ${this.tagStack.join(', ')}`
      );
    }

    if (this.errorStrategy === ErrorStrategy.LENIENT) {
      // Emit synthetic close events for unclosed tags (bottom to top)
      const unclosed = [...this.tagStack];
      for (let i = unclosed.length - 1; i >= 0; i--) {
        this.eventQueue.push({
          type: 'error',
          message: `Unclosed tag <${unclosed[i]}> at end of input`,
        });
        this.eventQueue.push({
          type: 'elementClose',
          name: unclosed[i],
        });
      }
    }
    // SILENT: just clear
    this.tagStack = [];
  }

  /** Reset processor state */
  reset(): void {
    this.tagStack = [];
    this.eventQueue = [];
  }

  // ============================================================
  // Handlers
  // ============================================================

  private handleElementOpen(event: TokenizerEvent & { type: 'elementOpen' }): void {
    this.tagStack.push(event.name);
    this.eventQueue.push(event);
  }

  private handleElementClose(event: TokenizerEvent & { type: 'elementClose' }): void {
    const top = this.tagStack.length > 0
      ? this.tagStack[this.tagStack.length - 1]
      : null;

    if (top === event.name) {
      this.tagStack.pop();
      this.eventQueue.push(event);
    } else if (top === null) {
      // Close without matching open
      if (this.errorStrategy === ErrorStrategy.STRICT) {
        throw new Error(`Unexpected closing tag </${event.name}> with empty stack`);
      }
      if (this.errorStrategy === ErrorStrategy.LENIENT) {
        this.eventQueue.push({
          type: 'error',
          message: `Unexpected closing tag </${event.name}>`,
        });
      }
      // SILENT: ignore
    } else {
      // Mismatch: <a><b></a> — close doesn't match top
      if (this.errorStrategy === ErrorStrategy.STRICT) {
        throw new Error(
          `Mismatched closing tag: expected </${top}>, got </${event.name}>`
        );
      }
      if (this.errorStrategy === ErrorStrategy.LENIENT) {
        this.eventQueue.push({
          type: 'error',
          message: `Mismatched closing tag: expected </${top}>, got </${event.name}>`,
        });
        // Try to recover: find and pop matching tag
        const idx = this.tagStack.lastIndexOf(event.name);
        if (idx >= 0) {
          // Pop everything above and including the matching tag
          this.tagStack = this.tagStack.slice(0, idx);
          this.eventQueue.push(event);
        }
        // If not found, ignore the close
      }
      // SILENT: try recovery
      if (this.errorStrategy === ErrorStrategy.SILENT) {
        const idx = this.tagStack.lastIndexOf(event.name);
        if (idx >= 0) {
          this.tagStack = this.tagStack.slice(0, idx);
          this.eventQueue.push(event);
        }
      }
    }
  }
}
