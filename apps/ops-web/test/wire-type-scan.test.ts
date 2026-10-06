import { describe, expect, it } from 'vitest';

import { declaredTypeNames, moduleSpecifiers } from './support/wire-type-scan';

describe('declaredTypeNames', () => {
  // Break caught: a scanner that misses one way of declaring a type, so a hand-written copy of a contract
  // schema written that way would go unnoticed.
  it.each([
    ['an interface', 'interface Money { amount_minor: number }', 'Money'],
    ['an exported interface', 'export interface Money { amount_minor: number }', 'Money'],
    ['a type alias', "type Money = { amount_minor: number; currency: 'GHS' };", 'Money'],
    ['a class', 'export class Money { amount_minor = 0 }', 'Money'],
    ['an enum', "enum Money { A = 'A' }", 'Money'],
    ['an ambient declaration', 'declare interface Money { a: 1 }', 'Money'],
    [
      'a type nested in a function',
      'function f() { type Money = number; return 1 as Money; }',
      'Money',
    ],
    ['a type nested in a namespace', 'declare namespace N { interface Money { a: 1 } }', 'Money'],
  ])('finds %s', (_label, source, name) => {
    expect(declaredTypeNames(source)).toContain(name);
  });

  // Break caught: a scanner that reports every mention, which would forbid using the generated types at
  // all. Importing, referencing and aliasing the contract's types is the whole point.
  it('does not report an import, a reference, a value or a differently named alias', () => {
    const source = `
      import type { components } from '@melarc/api-client';
      import type { Money } from '@melarc/api-client';
      type Price = components['schemas']['Money'];
      const Money = 1;
      function f(value: Money): Price { return value; }
    `;

    expect(declaredTypeNames(source)).toEqual(['Price']);
  });

  it('reads JSX files', () => {
    expect(declaredTypeNames('interface Props { a: 1 }\nconst x = <div />;', 'x.tsx')).toEqual([
      'Props',
    ]);
  });
});

describe('moduleSpecifiers', () => {
  // Break caught: a way of importing that the check does not see, such as a type-only or dynamic import.
  it.each([
    ['an import', "import { a } from 'one';"],
    ['a type import', "import type { a } from 'one';"],
    ['a side-effect import', "import 'one';"],
    ['a re-export', "export { a } from 'one';"],
    ['a namespace re-export', "export * from 'one';"],
    ['a dynamic import', "const m = await import('one');"],
    ['an import type expression', "type T = import('one').a;"],
  ])('finds the specifier of %s', (_label, source) => {
    expect(moduleSpecifiers(source)).toEqual(['one']);
  });

  it('finds every specifier, in order', () => {
    expect(moduleSpecifiers("import a from 'x';\nimport b from './y';")).toEqual(['x', './y']);
  });
});
