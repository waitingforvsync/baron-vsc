// Language tables, kept in step with baron's src/assemble.c and src/opcodes.c.

/** Every mnemonic baron recognises (NMOS 6502 plus the 65C02 extras). */
export const MNEMONICS = new Set([
  'adc', 'and', 'asl', 'bcc', 'bcs', 'beq', 'bit', 'bmi', 'bne', 'bpl',
  'brk', 'bvc', 'bvs', 'clc', 'cld', 'cli', 'clv', 'cmp', 'cpx', 'cpy',
  'dec', 'dex', 'dey', 'eor', 'inc', 'inx', 'iny', 'jmp', 'jsr', 'lda',
  'ldx', 'ldy', 'lsr', 'nop', 'ora', 'pha', 'php', 'pla', 'plp', 'rol',
  'ror', 'rti', 'rts', 'sbc', 'sec', 'sed', 'sei', 'sta', 'stx', 'sty',
  'tax', 'tay', 'tsx', 'txa', 'txs', 'tya',
  // 65C02 only
  'bra', 'dea', 'ina', 'phx', 'phy', 'plx', 'ply', 'stz', 'clr', 'trb', 'tsb',
  // BIT opcodes that swallow the following one/two bytes
  'bitzp', 'bitabs',
]);

/** Mnemonics that exist only on the 65C02, whatever the addressing mode. */
export const CMOS_ONLY_MNEMONICS = new Set([
  'bra', 'dea', 'ina', 'phx', 'phy', 'plx', 'ply', 'stz', 'clr', 'trb', 'tsb',
]);

/** NMOS mnemonics that gain the (zp) addressing mode on the 65C02. */
export const CMOS_INDIRECT_MNEMONICS = new Set([
  'adc', 'and', 'cmp', 'eor', 'lda', 'ora', 'sbc', 'sta',
]);

/** Statement-starting directive keywords. */
export const DIRECTIVES = new Set([
  'skip', 'skipto', 'align', 'section', 'za_pool', 'za_auto', 'za_auto1',
  'za_auto2', 'za_unreachable', 'za_cancall', 'za_canjump', 'za_return',
  'za_returnto', 'za_discard', 'za_entry', 'za_interrupt', 'equb', 'equs', 'equw',
  'equd', 'if', 'for', 'include', 'incbin', 'incsection',
  'basic', 'macro', 'function', 'print', 'error',
]);

/** Block closers. */
export const CLOSERS = new Set([
  'elif', 'else', 'endif', 'next', 'endmacro', 'endsection', 'endbasic',
]);

/** Reserved constants: cannot be labels or symbols. */
export const RESERVED_CONSTANTS = new Set(['true', 'false', 'pi']);

/** Word-shaped binary operators usable inside expressions. */
export const WORD_OPERATORS = new Set(['div', 'mod', 'and', 'or', 'eor']);

/** Built-in functions callable as name(args). */
export const BUILTIN_FUNCTIONS = new Set([
  'lo', 'hi', 'abs', 'int', 'floor', 'round', 'trunc', 'ceil', 'sqrt',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'log', 'ln', 'exp',
  'not', 'rnd',
  'len', 'shape', 'rank', 'full', 'repeated', 'flatten', 'concat', 'zip', 'reverse',
  'sort', 'sum', 'product', 'min', 'max', 'defined',
  'codes', 'chr', 'find', 'is_string', 'is_number', 'error',
]);

/** Attributes baron acts on in a SECTION statement. */
export const SECTION_ATTRIBUTES = ['org', 'filename', 'load', 'exec', 'cmos', 'guard'];

export function isStatementKeyword(lower: string): boolean {
  return DIRECTIVES.has(lower) || CLOSERS.has(lower) || MNEMONICS.has(lower)
    || RESERVED_CONSTANTS.has(lower);
}
