import {
  TokenizerState,
  TokenizerEvent,
  DEFAULT_TAG_CHAR_PATTERN,
  ErrorStrategy,
} from './types';

export class Tokenizer {
  private legalTags: string[] | null = null;
  private tagCharPattern: RegExp = DEFAULT_TAG_CHAR_PATTERN;
  private maxBufferSize: number = 1048576;
  private maxNestingDepth: number = 1;

  private state: TokenizerState = TokenizerState.TEXT;
  private buffer: string = '';
  private flushedIndex: number = 0;
  private eventQueue: TokenizerEvent[] = [];

  private tagName: string = '';
  private attrName: string = '';
  private attrValue: string = '';
  private attributes: Record<string, string> = {};

  private depth: number = 0;
  private ended: boolean = false;

  constructor(
    legalTags?: string[],
    tagCharPattern?: RegExp,
    maxBufferSize?: number,
    errorStrategy?: ErrorStrategy,
    maxNestingDepth?: number,
  ) {
    if (legalTags && legalTags.length > 0) this.legalTags = legalTags;
    if (tagCharPattern) this.tagCharPattern = tagCharPattern;
    if (maxBufferSize !== undefined) this.maxBufferSize = maxBufferSize;
    if (maxNestingDepth !== undefined) this.maxNestingDepth = maxNestingDepth;
    // errorStrategy is used by L2, not L1 directly
  }

  write(chunk: string): void {
    if (this.ended) return;

    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      this.buffer += ch;

      if (this.buffer.length > this.maxBufferSize) {
        throw new Error(
          `Buffer size exceeded ${this.maxBufferSize} bytes.`
        );
      }

      this.processChar(ch);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;

    // Flush any text in suspect state
    if (
      this.state === TokenizerState.TAG_SUSPECTED ||
      this.state === TokenizerState.TAG_NAME ||
      this.state === TokenizerState.AFTER_NAME ||
      this.state === TokenizerState.ATTR_NAME ||
      this.state === TokenizerState.BEFORE_ATTR_EQ ||
      this.state === TokenizerState.ATTR_VALUE_START ||
      this.state === TokenizerState.ATTR_VALUE_DQ ||
      this.state === TokenizerState.ATTR_VALUE_SQ ||
      this.state === TokenizerState.BEFORE_CLOSE ||
      this.state === TokenizerState.CLOSE_TAG_NAME
    ) {
      this.state = TokenizerState.TEXT;
    }
  }

  reset(): void {
    this.state = TokenizerState.TEXT;
    this.buffer = '';
    this.flushedIndex = 0;
    this.eventQueue = [];
    this.tagName = '';
    this.attrName = '';
    this.attrValue = '';
    this.attributes = {};
    this.depth = 0;
    this.ended = false;
  }

  pull(): TokenizerEvent | null {
    return this.eventQueue.shift() ?? null;
  }

  /** Flush text from last flush point up to the given buffer position */
  flushUpTo(bufferPos: number): string {
    if (bufferPos <= this.flushedIndex) return '';
    const text = this.buffer.substring(this.flushedIndex, bufferPos);
    this.flushedIndex = bufferPos;
    return text;
  }

  flushPendingText(): string {
    const newText = this.buffer.substring(this.flushedIndex);
    this.flushedIndex = this.buffer.length;
    return newText;
  }

  isInTagSuspect(): boolean {
    return (
      this.state === TokenizerState.TAG_SUSPECTED ||
      this.state === TokenizerState.TAG_NAME ||
      this.state === TokenizerState.AFTER_NAME ||
      this.state === TokenizerState.ATTR_NAME ||
      this.state === TokenizerState.BEFORE_ATTR_EQ ||
      this.state === TokenizerState.ATTR_VALUE_START ||
      this.state === TokenizerState.ATTR_VALUE_DQ ||
      this.state === TokenizerState.ATTR_VALUE_SQ ||
      this.state === TokenizerState.BEFORE_CLOSE ||
      this.state === TokenizerState.CLOSE_TAG_NAME
    );
  }

  currentDepth(): number {
    return this.depth;
  }

  setMaxNestingDepth(depth: number): void {
    this.maxNestingDepth = depth;
  }

  // ============================================================
  // #region Character dispatch
  // ============================================================

  private processChar(ch: string): void {
    switch (this.state) {
      case TokenizerState.TEXT:             this.handleText(ch); break;
      case TokenizerState.TAG_SUSPECTED:    this.handleTagSuspect(ch); break;
      case TokenizerState.TAG_NAME:         this.handleTagName(ch); break;
      case TokenizerState.AFTER_NAME:       this.handleAfterName(ch); break;
      case TokenizerState.ATTR_NAME:        this.handleAttrName(ch); break;
      case TokenizerState.BEFORE_ATTR_EQ:   this.handleBeforeAttrEq(ch); break;
      case TokenizerState.ATTR_VALUE_START: this.handleAttrValueStart(ch); break;
      case TokenizerState.ATTR_VALUE_DQ:    this.handleAttrValueDQ(ch); break;
      case TokenizerState.ATTR_VALUE_SQ:    this.handleAttrValueSQ(ch); break;
      case TokenizerState.BEFORE_CLOSE:     this.handleBeforeClose(ch); break;
      case TokenizerState.CLOSE_TAG_NAME:   this.handleCloseTagName(ch); break;
    }
  }

  // ============================================================
  // #region State handlers
  // ============================================================

  private suspectStartPos: number = -1; // buffer position where '<' was seen

  private handleText(ch: string): void {
    if (ch === '<') {
      this.suspectStartPos = this.buffer.length - 1; // position of '<'
      this.state = TokenizerState.TAG_SUSPECTED;
    }
  }

  private handleTagSuspect(ch: string): void {
    if (ch === '/') {
      // Close tags are always allowed (they decrement depth)
      this.state = TokenizerState.CLOSE_TAG_NAME;
      this.tagName = '';
    } else if (this.isNameChar(ch)) {
      if (this.depth <= this.maxNestingDepth) {
        this.tagName = ch;
        this.state = TokenizerState.TAG_NAME;
      } else {
        this.state = TokenizerState.TEXT;
      }
    } else {
      this.state = TokenizerState.TEXT;
    }
  }

  private handleTagName(ch: string): void {
    if (ch === '>') {
      if (this.validateTagName()) {
        this.emitElementOpen();
      } else {
        this.state = TokenizerState.TEXT;
      }
    } else if (ch === '/') {
      this.state = TokenizerState.BEFORE_CLOSE;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (this.tagName.length === 0) { this.state = TokenizerState.TEXT; return; }
      this.state = TokenizerState.AFTER_NAME;
    } else if (this.isNameChar(ch)) {
      this.tagName += ch;
      if (this.legalTags && !this.matchesPrefix(this.tagName)) {
        this.state = TokenizerState.TEXT;
      }
    } else {
      this.state = TokenizerState.TEXT;
    }
  }

  private handleAfterName(ch: string): void {
    if (ch === '>') {
      if (this.validateTagName()) {
        this.emitElementOpen();
      } else {
        this.state = TokenizerState.TEXT;
      }
    } else if (ch === '/') {
      this.state = TokenizerState.BEFORE_CLOSE;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      // skip whitespace
    } else if (this.isNameChar(ch)) {
      this.attrName = ch;
      this.state = TokenizerState.ATTR_NAME;
    } else {
      this.state = TokenizerState.TEXT;
    }
  }

  private handleAttrName(ch: string): void {
    if (ch === '=') {
      this.state = TokenizerState.ATTR_VALUE_START;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      this.state = TokenizerState.BEFORE_ATTR_EQ;
    } else if (ch === '>') {
      if (this.attrName) this.attributes[this.attrName] = '';
      if (this.validateTagName()) {
        this.emitElementOpen();
      } else {
        this.state = TokenizerState.TEXT;
      }
    } else if (this.isNameChar(ch)) {
      this.attrName += ch;
    } else {
      this.state = TokenizerState.TEXT;
    }
  }

  private handleBeforeAttrEq(ch: string): void {
    if (ch === '=') {
      this.state = TokenizerState.ATTR_VALUE_START;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      // skip
    } else if (this.isNameChar(ch)) {
      if (this.attrName) this.attributes[this.attrName] = '';
      this.attrName = ch;
      this.state = TokenizerState.ATTR_NAME;
    } else if (ch === '>') {
      if (this.attrName) this.attributes[this.attrName] = '';
      if (this.validateTagName()) {
        this.emitElementOpen();
      } else {
        this.state = TokenizerState.TEXT;
      }
    } else {
      this.state = TokenizerState.TEXT;
    }
  }

  private handleAttrValueStart(ch: string): void {
    if (ch === '"') {
      this.attrValue = '';
      this.state = TokenizerState.ATTR_VALUE_DQ;
    } else if (ch === "'") {
      this.attrValue = '';
      this.state = TokenizerState.ATTR_VALUE_SQ;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      this.state = TokenizerState.BEFORE_ATTR_EQ;
    } else if (ch === '>') {
      if (this.validateTagName()) {
        this.emitElementOpen();
      } else {
        this.state = TokenizerState.TEXT;
      }
    } else {
      this.state = TokenizerState.TEXT;
    }
  }

  private handleAttrValueDQ(ch: string): void {
    if (ch === '"') {
      this.attributes[this.attrName] = this.attrValue;
      this.attrName = '';
      this.attrValue = '';
      this.state = TokenizerState.AFTER_NAME;
    } else {
      this.attrValue += ch;
    }
  }

  private handleAttrValueSQ(ch: string): void {
    if (ch === "'") {
      this.attributes[this.attrName] = this.attrValue;
      this.attrName = '';
      this.attrValue = '';
      this.state = TokenizerState.AFTER_NAME;
    } else {
      this.attrValue += ch;
    }
  }

  private handleBeforeClose(ch: string): void {
    if (ch === '>') {
      if (this.validateTagName()) {
        this.emitSelfClose();
      } else {
        this.state = TokenizerState.TEXT;
      }
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      // <tag /> — space before /> allowed
    } else {
      this.state = TokenizerState.TEXT;
    }
  }

  private handleCloseTagName(ch: string): void {
    if (ch === '>') {
      this.emitElementClose();
    } else if (this.isNameChar(ch)) {
      this.tagName += ch;
    } else {
      this.state = TokenizerState.TEXT;
      this.processChar(ch); // re-process in TEXT (e.g. '<' → TAG_SUSPECTED)
    }
  }

  // ============================================================
  // #region Helpers
  // ============================================================

  private isNameChar(ch: string): boolean {
    return this.tagCharPattern.test(ch);
  }

  private validateTagName(): boolean {
    if (!this.tagName) return false;
    if (this.legalTags) return this.legalTags.includes(this.tagName);
    return true;
  }

  private matchesPrefix(prefix: string): boolean {
    if (!this.legalTags) return true;
    return this.legalTags.some(tag => tag.startsWith(prefix));
  }

  private emitElementOpen(): void {
    const event: any = {
      type: 'elementOpen',
      name: this.tagName,
      attributes: { ...this.attributes },
      _bufferPos: this.buffer.length,
      _tagStart: this.suspectStartPos,
    };
    this.eventQueue.push(event);
    this.depth++;
    this.resetTagState();
    this.state = TokenizerState.TEXT;
    this.compactBuffer();
  }

  private emitElementClose(): void {
    const event: any = {
      type: 'elementClose',
      name: this.tagName,
      _bufferPos: this.buffer.length,
    };
    this.eventQueue.push(event);
    this.depth = Math.max(0, this.depth - 1);
    this.resetTagState();
    this.state = TokenizerState.TEXT;
  }

  private emitSelfClose(): void {
    const event: any = {
      type: 'selfClose',
      name: this.tagName,
      attributes: { ...this.attributes },
      _bufferPos: this.buffer.length,
      _tagStart: this.suspectStartPos,
    };
    this.eventQueue.push(event);
    this.resetTagState();
    this.state = TokenizerState.TEXT;
  }

  private resetTagState(): void {
    this.tagName = '';
    this.attrName = '';
    this.attrValue = '';
    this.attributes = {};
    this.suspectStartPos = -1;
  }

  private compactBuffer(): void {
    const keepFrom = Math.max(0, this.flushedIndex - 256);
    if (keepFrom > 0) {
      this.buffer = this.buffer.substring(keepFrom);
      this.flushedIndex -= keepFrom;
    }
  }
}
