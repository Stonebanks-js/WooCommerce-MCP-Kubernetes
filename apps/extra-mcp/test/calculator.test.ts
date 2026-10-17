import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CalcError, MAX_EXPRESSION_LENGTH, evaluate } from '../src/lib/calculator.ts';

describe('calculator', () => {
  const table: Array<[string, number]> = [
    ['2+3*4', 14],
    ['(2+3)*4', 20],
    ['2^10', 1024],
    ['7%3', 1],
    ['-3+5', 2],
    ['1 + 2', 3],
    ['  10 / 4 ', 2.5],
    ['2 ^ 3 ^ 2', 512], // right-associative
    ['-2^2', -4], // unary minus binds looser than ^
    ['2^-1', 0.5],
    ['(-3)^2', 9],
    ['--3', 3],
    ['+4', 4],
    ['3.5*2', 7],
    ['.5+.25', 0.75],
    ['1e3+1', 1001],
    ['2.5E-1*4', 1],
    ['((1+2)*(3+4))', 21],
    ['10%4*2', 4], // left-to-right: (10%4)*2
    ['-7%3', -1], // JS remainder semantics
    ['0^0', 1],
    ['-0', 0],
  ];

  for (const [expression, expected] of table) {
    test(`evaluates ${JSON.stringify(expression)} = ${expected}`, () => {
      assert.equal(evaluate(expression), expected);
    });
  }

  const errors: Array<[string, RegExp]> = [
    ['1/0', /Division by zero/],
    ['7%0', /Modulo by zero/],
    ['2+', /Unexpected end of expression/],
    ['abc', /Unexpected character 'a'/],
    ['', /empty/],
    ['   ', /empty/],
    ['(2+3', /Missing closing parenthesis/],
    ['2+3)', /Unexpected '\)'/],
    ['()', /Unexpected '\)'/],
    ['2 3', /Unexpected number 3/],
    ['2**3', /Unexpected '\*'/],
    ['1.2.3', /Unexpected number/],
    ['10^400', /not a finite number/],
    ['(-8)^(1/3)', /not a finite number/], // NaN in IEEE arithmetic
    ['2 + $', /Unexpected character '\$'/],
    ['1e999', /too large/],
  ];

  for (const [expression, pattern] of errors) {
    test(`rejects ${JSON.stringify(expression)}`, () => {
      assert.throws(() => evaluate(expression), (err: unknown) => {
        assert.ok(err instanceof CalcError, `expected CalcError, got ${String(err)}`);
        assert.match(err.message, pattern);
        return true;
      });
    });
  }

  test('rejects expressions longer than the cap', () => {
    const long = `${'1+'.repeat(MAX_EXPRESSION_LENGTH / 2)}1`;
    assert.throws(() => evaluate(long), /longer than/);
  });

  test('handles deep nesting within the length cap', () => {
    const depth = 200;
    const expression = `${'('.repeat(depth)}1${')'.repeat(depth)}`;
    assert.equal(evaluate(expression), 1);
  });
});
