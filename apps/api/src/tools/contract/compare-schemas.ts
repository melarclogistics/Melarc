import type { Finding } from './findings.js';
import { canonicalJson, type Json } from '../../platform/contract/json.js';
import type { NormSchema } from './schema-normalizer.js';

const asJson = (value: unknown): Json => value as Json;
const same = (a: unknown, b: unknown): boolean =>
  canonicalJson(asJson(a)) === canonicalJson(asJson(b));
/**
 * Equal values, and equally present. `null` is a value: `const: null` and no `const` are different rules (the
 * first rejects a string, the second accepts it), and comparing `a ?? null` with `b ?? null` cannot tell them apart.
 */
const sameWhenPresent = (a: unknown, b: unknown): boolean =>
  (a === undefined) === (b === undefined) && same(a ?? null, b ?? null);
const show = (value: unknown): string => (value === undefined ? 'nothing' : JSON.stringify(value));
const showAll = (values: readonly unknown[]): string => values.map(show).join(', ');

/** The members of `from` that `other` lacks, comparing by value. */
function without(from: readonly Json[], other: readonly Json[]): Json[] {
  const present = new Set(other.map((value) => canonicalJson(value)));
  return from.filter((value) => !present.has(canonicalJson(value)));
}

function additionalPropertiesName(value: NormSchema['additionalProperties']): string {
  if (value === undefined) return 'open (any other property is allowed)';
  if (value === 'closed') return 'closed (no other property is allowed)';
  return 'open to properties of a given schema';
}

function compareNode(expected: NormSchema, actual: NormSchema, at: string, out: Finding[]): void {
  if (expected.recursive !== undefined || actual.recursive !== undefined) {
    if ((expected.recursive === undefined) !== (actual.recursive === undefined)) {
      out.push({
        code: 'SCHEMA_SHAPE',
        at,
        message:
          expected.recursive === undefined
            ? 'The code describes a self-referencing schema here and the contract does not.'
            : 'The contract describes a self-referencing schema here and the code does not.',
      });
    }
    return;
  }

  if ((expected.never === true) !== (actual.never === true)) {
    out.push({
      code: 'SCHEMA_SHAPE',
      at,
      message:
        expected.never === true
          ? 'The contract accepts nothing here and the code accepts something.'
          : 'The code accepts nothing here and the contract accepts something.',
    });
    return;
  }

  const expectedTypes = expected.types ?? [];
  const actualTypes = actual.types ?? [];
  if (!same(expectedTypes, actualTypes)) {
    const withoutNull = (types: readonly string[]) => types.filter((type) => type !== 'null');
    if (same(withoutNull(expectedTypes), withoutNull(actualTypes))) {
      const contractAllowsNull = expectedTypes.includes('null');
      out.push({
        code: 'SCHEMA_NULLABLE',
        at,
        message: contractAllowsNull
          ? 'The contract allows null here and the code does not.'
          : 'The code allows null here and the contract does not.',
        expected: asJson(expectedTypes),
        actual: asJson(actualTypes),
      });
    } else {
      out.push({
        code: 'SCHEMA_TYPE',
        at,
        message: `The contract says the type is ${expectedTypes.length > 0 ? showAll(expectedTypes) : 'unspecified'} and the code says ${actualTypes.length > 0 ? showAll(actualTypes) : 'unspecified'}.`,
        expected: asJson(expectedTypes),
        actual: asJson(actualTypes),
      });
    }
  }

  if (expected.format !== actual.format) {
    out.push({
      code: 'SCHEMA_FORMAT',
      at,
      message: `The contract says the format is ${show(expected.format)} and the code says ${show(actual.format)}.`,
      ...(expected.format === undefined ? {} : { expected: expected.format }),
      ...(actual.format === undefined ? {} : { actual: actual.format }),
    });
  }

  if (!sameWhenPresent(expected.enum, actual.enum)) {
    const onlyContract = without(expected.enum ?? [], actual.enum ?? []);
    const onlyCode = without(actual.enum ?? [], expected.enum ?? []);
    const parts = [
      expected.enum === undefined ? 'The contract does not restrict the value.' : undefined,
      actual.enum === undefined ? 'The code does not restrict the value.' : undefined,
      onlyContract.length > 0 ? `Only the contract allows ${showAll(onlyContract)}.` : undefined,
      onlyCode.length > 0 ? `Only the code allows ${showAll(onlyCode)}.` : undefined,
    ].filter((part) => part !== undefined);
    out.push({
      code: 'SCHEMA_ENUM',
      at,
      message: `The allowed values differ. ${parts.join(' ')}`,
      expected: expected.enum ?? null,
      actual: actual.enum ?? null,
    });
  }
  if (!sameWhenPresent(expected.const, actual.const)) {
    out.push({
      code: 'SCHEMA_ENUM',
      at,
      message: `The contract fixes the value to ${show(expected.const)} and the code to ${show(actual.const)}.`,
      ...(expected.const === undefined ? {} : { expected: expected.const }),
      ...(actual.const === undefined ? {} : { actual: actual.const }),
    });
  }

  const expectedRequired = expected.required ?? [];
  const actualRequired = actual.required ?? [];
  if (!same(expectedRequired, actualRequired)) {
    const onlyContract = without(expectedRequired, actualRequired);
    const onlyCode = without(actualRequired, expectedRequired);
    out.push({
      code: 'SCHEMA_REQUIRED',
      at,
      message: [
        'The required properties differ.',
        onlyContract.length > 0
          ? `Only the contract requires ${showAll(onlyContract)}.`
          : undefined,
        onlyCode.length > 0 ? `Only the code requires ${showAll(onlyCode)}.` : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(' '),
      expected: expectedRequired,
      actual: actualRequired,
    });
  }

  const expectedProperties = expected.properties ?? {};
  const actualProperties = actual.properties ?? {};
  for (const name of [
    ...new Set([...Object.keys(expectedProperties), ...Object.keys(actualProperties)]),
  ].toSorted()) {
    const child = `${at}.properties.${name}`;
    const contractProperty = expectedProperties[name];
    const codeProperty = actualProperties[name];
    if (contractProperty !== undefined && codeProperty !== undefined) {
      compareNode(contractProperty, codeProperty, child, out);
    } else if (contractProperty !== undefined) {
      out.push({
        code: 'SCHEMA_PROPERTY_MISSING',
        at: child,
        message: `The contract defines ${show(name)} and the code does not.`,
      });
    } else {
      out.push({
        code: 'SCHEMA_PROPERTY_EXTRA',
        at: child,
        message: `The code defines ${show(name)} and the contract does not.`,
      });
    }
  }

  const expectedExtra = expected.additionalProperties;
  const actualExtra = actual.additionalProperties;
  if (typeof expectedExtra === 'object' && typeof actualExtra === 'object') {
    compareNode(expectedExtra, actualExtra, `${at}.additionalProperties`, out);
  } else if (expectedExtra !== actualExtra) {
    out.push({
      code: 'SCHEMA_ADDITIONAL_PROPERTIES',
      at,
      message: `The contract makes the object ${additionalPropertiesName(expectedExtra)} and the code makes it ${additionalPropertiesName(actualExtra)}.`,
    });
  }

  if (expected.items !== undefined && actual.items !== undefined) {
    compareNode(expected.items, actual.items, `${at}.items`, out);
  } else if (expected.items !== undefined || actual.items !== undefined) {
    out.push({
      code: 'SCHEMA_ITEMS',
      at,
      message:
        expected.items === undefined
          ? 'The code describes the items and the contract does not.'
          : 'The contract describes the items and the code does not.',
    });
  }

  for (const keyword of ['allOf', 'oneOf', 'anyOf'] as const) {
    const contractBranches = expected[keyword] ?? [];
    const codeBranches = actual[keyword] ?? [];
    if (!same(contractBranches, codeBranches)) {
      out.push({
        code: 'SCHEMA_COMPOSITION',
        at,
        message: `The branches of ${keyword} differ: the contract has ${String(contractBranches.length)} and the code has ${String(codeBranches.length)}.`,
        expected: asJson(contractBranches),
        actual: asJson(codeBranches),
      });
    }
  }

  const expectedLimits = expected.constraints ?? {};
  const actualLimits = actual.constraints ?? {};
  for (const limit of [
    ...new Set([...Object.keys(expectedLimits), ...Object.keys(actualLimits)]),
  ].toSorted()) {
    if (!sameWhenPresent(expectedLimits[limit], actualLimits[limit])) {
      out.push({
        code: 'SCHEMA_CONSTRAINT',
        at,
        message: `${limit} is ${expectedLimits[limit] === undefined ? 'not set' : show(expectedLimits[limit])} in the contract and ${actualLimits[limit] === undefined ? 'not set' : show(actualLimits[limit])} in the code.`,
        expected: expectedLimits[limit] ?? null,
        actual: actualLimits[limit] ?? null,
      });
    }
  }

  if (!sameWhenPresent(expected.default, actual.default)) {
    out.push({
      code: 'SCHEMA_DEFAULT',
      at,
      message: `The default is ${expected.default === undefined ? 'not set' : show(expected.default)} in the contract and ${actual.default === undefined ? 'not set' : show(actual.default)} in the code.`,
    });
  }

  for (const flag of ['readOnly', 'writeOnly'] as const) {
    if ((expected[flag] ?? false) !== (actual[flag] ?? false)) {
      out.push({
        code: 'SCHEMA_ACCESS',
        at,
        message: `${flag} is ${String(expected[flag] ?? false)} in the contract and ${String(actual[flag] ?? false)} in the code.`,
      });
    }
  }

  const expectedOpaque = expected.opaque ?? {};
  const actualOpaque = actual.opaque ?? {};
  for (const keyword of [
    ...new Set([...Object.keys(expectedOpaque), ...Object.keys(actualOpaque)]),
  ].toSorted()) {
    const contractValue = expectedOpaque[keyword];
    const codeValue = actualOpaque[keyword];
    if (
      !same(contractValue ?? null, codeValue ?? null) ||
      (contractValue === undefined) !== (codeValue === undefined)
    ) {
      out.push({
        code: 'SCHEMA_UNMODELLED',
        at,
        message:
          contractValue === undefined
            ? `The code has the rule ${show(keyword)} and the contract does not.`
            : codeValue === undefined
              ? `The contract has the rule ${show(keyword)} and the code does not.`
              : `The rule ${show(keyword)} differs between the contract and the code.`,
        ...(contractValue === undefined ? {} : { expected: contractValue }),
        ...(codeValue === undefined ? {} : { actual: codeValue }),
      });
    }
  }
}

/**
 * Every way `actual`, the code's description of a schema, differs from `expected`, the contract's. It
 * never stops at the first: fixing one difference should not be how the next is found. `at` says where
 * the schemas sit; each finding extends it down to the difference.
 */
export function compareSchemas(expected: NormSchema, actual: NormSchema, at: string): Finding[] {
  const findings: Finding[] = [];
  compareNode(expected, actual, at, findings);
  return findings;
}
