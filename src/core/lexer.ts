// A tolerant lexer for Baron source, mirroring the rules of baron's src/lexer.c:
// whitespace is space/tab/CR; comments run from ';' or '\' to end of line; a run of
// newlines and ':' separators (with interleaved whitespace/comments) coalesces into a
// single terminator whose `newlineOnly` flag records whether a ':' took part.

export const enum TokKind {
  Ident,
  Number,
  String,
  Punct,
  Terminator,
  Eof,
}

export interface Token {
  kind: TokKind;
  /** Raw source slice (lower-cased copy in `lower` for idents/puncts). */
  text: string;
  lower: string;
  start: number;
  end: number;
  /** Numeric value, for Number tokens. */
  num?: number;
  /** Decoded value, for String tokens ("" collapsed to "). */
  str?: string;
  /** For terminators: true when the run contained only newlines (no ':'). */
  newlineOnly?: boolean;
}

const isWhitespace = (c: string) => c === ' ' || c === '\t' || c === '\r';
const isNewline = (c: string) => c === '\n';
const isCommentStart = (c: string) => c === ';' || c === '\\';
const isDigit = (c: string) => c >= '0' && c <= '9';
const isHexDigit = (c: string) => isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
const isBinDigit = (c: string) => c === '0' || c === '1';
const isIdentStart = (c: string) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
const isIdentChar = (c: string) => isIdentStart(c) || isDigit(c);

/** Multi-character punctuation, longest first. */
const MULTI_PUNCT = ['..<', '..', '<<', '>>', '<=', '>=', '==', '!=', '<>', '@+', '@-'];

export class Lexer {
  readonly text: string;
  private pos = 0;
  private lookahead: Token | undefined;

  constructor(text: string) {
    this.text = text;
  }

  /** Reposition (invalidates lookahead). Used to skip over BASIC blocks. */
  setPos(pos: number): void {
    this.pos = Math.min(pos, this.text.length);
    this.lookahead = undefined;
  }

  getPos(): number {
    return this.lookahead ? this.lookahead.start : this.pos;
  }

  peek(): Token {
    if (!this.lookahead) {
      this.lookahead = this.lex();
    }
    return this.lookahead;
  }

  next(): Token {
    const tok = this.peek();
    this.lookahead = undefined;
    return tok;
  }

  private at(i: number): string {
    return i < this.text.length ? this.text[i] : '';
  }

  private skipWhitespaceAndComment(): void {
    while (this.pos < this.text.length && isWhitespace(this.text[this.pos])) {
      this.pos++;
    }
    if (this.pos < this.text.length && isCommentStart(this.text[this.pos])) {
      while (this.pos < this.text.length && !isNewline(this.text[this.pos])) {
        this.pos++;
      }
    }
  }

  private make(kind: TokKind, start: number, extra?: Partial<Token>): Token {
    const text = this.text.slice(start, this.pos);
    return { kind, text, lower: text.toLowerCase(), start, end: this.pos, ...extra };
  }

  private lex(): Token {
    this.skipWhitespaceAndComment();
    const start = this.pos;

    if (this.pos >= this.text.length) {
      return this.make(TokKind.Eof, start);
    }

    const c = this.text[this.pos];

    // Terminator run: ':' and newlines coalesce, comments/whitespace between them included.
    if (isNewline(c) || c === ':') {
      let newlineOnly = true;
      do {
        if (this.text[this.pos] === ':') {
          newlineOnly = false;
        }
        this.pos++;
        this.skipWhitespaceAndComment();
      } while (this.pos < this.text.length
        && (isNewline(this.text[this.pos]) || this.text[this.pos] === ':'));
      return { kind: TokKind.Terminator, text: '', lower: '', start, end: this.pos, newlineOnly };
    }

    // Numbers: decimal (with optional fraction), &hex / $hex, %binary.
    if (isDigit(c)) {
      while (this.pos < this.text.length && isDigit(this.text[this.pos])) {
        this.pos++;
      }
      // A fraction only if a digit follows the '.', and the '.' is not the start of '..'
      if (this.at(this.pos) === '.' && isDigit(this.at(this.pos + 1))) {
        this.pos++;
        while (this.pos < this.text.length && isDigit(this.text[this.pos])) {
          this.pos++;
        }
      }
      const tok = this.make(TokKind.Number, start);
      tok.num = parseFloat(tok.text);
      return tok;
    }
    if ((c === '&' || c === '$') && isHexDigit(this.at(this.pos + 1))) {
      this.pos++;
      while (this.pos < this.text.length && isHexDigit(this.text[this.pos])) {
        this.pos++;
      }
      const tok = this.make(TokKind.Number, start);
      tok.num = parseInt(tok.text.slice(1), 16);
      return tok;
    }
    if (c === '%' && isBinDigit(this.at(this.pos + 1))) {
      this.pos++;
      while (this.pos < this.text.length && isBinDigit(this.text[this.pos])) {
        this.pos++;
      }
      const tok = this.make(TokKind.Number, start);
      tok.num = parseInt(tok.text.slice(1), 2);
      return tok;
    }

    // Strings: "..." with "" as an escaped quote. Unterminated strings end at the newline.
    if (c === '"') {
      this.pos++;
      let value = '';
      while (this.pos < this.text.length && !isNewline(this.text[this.pos])) {
        if (this.text[this.pos] === '"') {
          if (this.at(this.pos + 1) === '"') {
            value += '"';
            this.pos += 2;
            continue;
          }
          this.pos++;
          break;
        }
        value += this.text[this.pos];
        this.pos++;
      }
      const tok = this.make(TokKind.String, start);
      tok.str = value;
      return tok;
    }

    // Identifiers, possibly dotted: ident('.' ident)*, consuming a '.' only when an
    // identifier-start follows (so `a.b` is one identifier, but `a..b` stops at `a`) -
    // exactly as baron's scan_dotted_identifier does. P% folds into a single token, as
    // baron's "P%" token-table entry does.
    if (isIdentStart(c)) {
      while (this.pos < this.text.length && isIdentChar(this.text[this.pos])) {
        this.pos++;
      }
      if ((this.text.slice(start, this.pos).toLowerCase() === 'p') && this.at(this.pos) === '%') {
        this.pos++;
        return this.make(TokKind.Ident, start);
      }
      while (this.at(this.pos) === '.' && isIdentStart(this.at(this.pos + 1))) {
        this.pos++;
        while (this.pos < this.text.length && isIdentChar(this.text[this.pos])) {
          this.pos++;
        }
      }
      return this.make(TokKind.Ident, start);
    }

    // Punctuation, longest first.
    for (const p of MULTI_PUNCT) {
      if (this.text.startsWith(p, this.pos)) {
        this.pos += p.length;
        return this.make(TokKind.Punct, start);
      }
    }
    this.pos++;
    return this.make(TokKind.Punct, start);
  }
}

/** Precomputed line starts, for offset <-> line/character conversion. */
export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

export function offsetToLineChar(lineStarts: number[], offset: number): { line: number; character: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return { line: lo, character: offset - lineStarts[lo] };
}
