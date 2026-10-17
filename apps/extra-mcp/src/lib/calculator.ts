/**
 * Safe arithmetic evaluator for the utils server's `calculate` tool.
 *
 * A hand-written recursive-descent parser over this grammar (no `eval`, no `Function`,
 * no identifiers, no function calls):
 *
 *   expr   := term  (('+' | '-') term)*
 *   term   := unary (('*' | '/' | '%') unary)*
 *   unary  := ('+' | '-') unary | power
 *   power  := atom ('^' unary)?            // right-associative: 2^3^2 = 2^(3^2); -2^2 = -(2^2)
 *   atom   := NUMBER | '(' expr ')'
 *   NUMBER := decimal literal such as 42, 3.14, .5, 1e3, 2.5E-2
 *
 * `%` is the remainder operator with JavaScript semantics (7 % 3 = 1, -7 % 3 = -1).
 */

export const MAX_EXPRESSION_LENGTH = 1000;

/** Thrown for any syntax or arithmetic problem; the message is safe to show to the caller. */
export class CalcError extends Error {
  override readonly name = 'CalcError';
}

type Operator = '+' | '-' | '*' | '/' | '%' | '^' | '(' | ')';

type Token =
  | { kind: 'num'; value: number; pos: number }
  | { kind: 'op'; value: Operator; pos: number }
  | { kind: 'end'; pos: number };

const OPERATORS = new Set<string>(['+', '-', '*', '/', '%', '^', '(', ')']);
const WHITESPACE = new Set<string>([' ', '\t', '\n', '\r']);
const NUMBER_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

function describe(token: Token): string {
  switch (token.kind) {
    case 'num':
      return `number ${token.value}`;
    case 'op':
      return `'${token.value}'`;
    case 'end':
      return 'end of expression';
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (WHITESPACE.has(ch)) {
      i += 1;
      continue;
    }
    if (OPERATORS.has(ch)) {
      tokens.push({ kind: 'op', value: ch as Operator, pos: i });
      i += 1;
      continue;
    }
    NUMBER_RE.lastIndex = i;
    const match = NUMBER_RE.exec(source);
    if (match) {
      const value = Number(match[0]);
      if (!Number.isFinite(value)) {
        throw new CalcError(`Number literal at position ${i} is too large`);
      }
      tokens.push({ kind: 'num', value, pos: i });
      i += match[0].length;
      continue;
    }
    throw new CalcError(`Unexpected character '${ch}' at position ${i}`);
  }
  tokens.push({ kind: 'end', pos: source.length });
  return tokens;
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): number {
    const value = this.expr();
    const trailing = this.peek();
    if (trailing.kind !== 'end') {
      throw new CalcError(`Unexpected ${describe(trailing)} at position ${trailing.pos}`);
    }
    return value;
  }

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.index] as Token;
    if (token.kind !== 'end') this.index += 1;
    return token;
  }

  private peekOp(...ops: Operator[]): Operator | undefined {
    const token = this.peek();
    return token.kind === 'op' && ops.includes(token.value) ? token.value : undefined;
  }

  private expr(): number {
    let left = this.term();
    for (;;) {
      const op = this.peekOp('+', '-');
      if (op === undefined) return left;
      this.next();
      const right = this.term();
      left = op === '+' ? left + right : left - right;
    }
  }

  private term(): number {
    let left = this.unary();
    for (;;) {
      const op = this.peekOp('*', '/', '%');
      if (op === undefined) return left;
      this.next();
      const right = this.unary();
      if (op === '*') {
        left = left * right;
      } else if (right === 0) {
        throw new CalcError(op === '/' ? 'Division by zero' : 'Modulo by zero');
      } else {
        left = op === '/' ? left / right : left % right;
      }
    }
  }

  private unary(): number {
    const op = this.peekOp('+', '-');
    if (op === undefined) return this.power();
    this.next();
    const value = this.unary();
    return op === '-' ? -value : value;
  }

  private power(): number {
    const base = this.atom();
    if (this.peekOp('^') === undefined) return base;
    this.next();
    const exponent = this.unary();
    return base ** exponent;
  }

  private atom(): number {
    const token = this.next();
    if (token.kind === 'num') return token.value;
    if (token.kind === 'op' && token.value === '(') {
      const value = this.expr();
      const close = this.next();
      if (close.kind === 'op' && close.value === ')') return value;
      if (close.kind === 'end') throw new CalcError('Missing closing parenthesis');
      throw new CalcError(`Expected ')' but found ${describe(close)} at position ${close.pos}`);
    }
    if (token.kind === 'end') throw new CalcError('Unexpected end of expression');
    throw new CalcError(`Unexpected ${describe(token)} at position ${token.pos}`);
  }
}

/**
 * Evaluate an arithmetic expression. Throws `CalcError` on empty/too long input, bad syntax,
 * division or modulo by zero, and non-finite results (overflow, 0^-1-style undefined forms).
 */
export function evaluate(expression: string): number {
  if (typeof expression !== 'string' || expression.trim().length === 0) {
    throw new CalcError('Expression is empty');
  }
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new CalcError(`Expression is longer than ${MAX_EXPRESSION_LENGTH} characters`);
  }
  const result = new Parser(tokenize(expression)).parse();
  if (!Number.isFinite(result)) {
    throw new CalcError('Result is not a finite number (overflow or undefined operation)');
  }
  // Normalise -0 so the JSON result reads 0 rather than carrying a hidden sign.
  return result === 0 ? 0 : result;
}
