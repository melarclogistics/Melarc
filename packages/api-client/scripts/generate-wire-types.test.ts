import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FIXTURE_CONTRACT as FIXTURE } from './fixture-contract.ts';
import { generateWireTypes, installedGeneratorVersion } from './generate-wire-types.ts';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');

describe('generateWireTypes', () => {
  // Break caught: output that no longer says where it came from, so nobody can tell which contract
  // revision a client was built from, or that the file must not be edited by hand.
  it('opens with a provenance header naming the contract, its content hash and the generator', async () => {
    const output = await generateWireTypes(FIXTURE);
    const hash = createHash('sha256').update(FIXTURE).digest('hex');

    const header = output.slice(0, output.indexOf('*/') + 2);
    expect(header).toContain('GENERATED FILE - DO NOT EDIT');
    expect(header).toContain('Fixture API 1.2.3-fixture');
    expect(header).toContain(`SHA-256 ${hash}`);
    expect(header).toContain(`openapi-typescript ${installedGeneratorVersion()}`);
    expect(header).toContain('pnpm run api-client:generate');
  });

  // Break caught: output that depends on the clock, the machine, or iteration order, which makes the
  // freshness check fail on a clean checkout.
  it('produces byte-identical output for identical input', async () => {
    const first = await generateWireTypes(FIXTURE);
    const second = await generateWireTypes(FIXTURE);

    expect(second).toBe(first);
  });

  // Break caught: the working copy of the contract using CRLF on Windows and LF on Linux CI, which
  // would make one of them report a stale client for an unchanged contract.
  it('produces byte-identical output whether the contract uses LF or CRLF line endings', async () => {
    const lf = await generateWireTypes(FIXTURE);
    const crlf = await generateWireTypes(FIXTURE.replaceAll('\n', '\r\n'));

    expect(crlf).toBe(lf);
    expect(crlf).not.toContain('\r');
  });

  // Break caught: a contract edit that changes no type, such as dropping the csrfToken requirement
  // from an operation, leaving the client looking current. The hash makes every edit visible.
  it('changes when the contract changes in a way that alters no type', async () => {
    const before = await generateWireTypes(FIXTURE);
    const after = await generateWireTypes(`# an edit that alters no type\n${FIXTURE}`);

    expect(after).not.toBe(before);
    expect(after.replace(/SHA-256 [0-9a-f]{64}/, '')).toBe(
      before.replace(/SHA-256 [0-9a-f]{64}/, ''),
    );
  });

  // Break caught: the generator's default of treating a defaulted property as required, which would
  // force every caller to send fields the contract lets them omit.
  it('makes a property required only when the contract lists it as required', async () => {
    const output = await generateWireTypes(FIXTURE);

    expect(output).toMatch(/^\s+name: string;$/m);
    expect(output).toMatch(/^\s+flag\?: boolean;$/m);
    expect(output).not.toMatch(/^\s+flag: boolean;$/m);
  });

  // Break caught: the generator's option that opens every object the contract does not close. It adds
  // `[key: string]: unknown` to each of them, which makes any misspelt property a valid one and hides the
  // very mistakes the client exists to catch. An object is open only when the contract says so itself.
  it('adds no index signature to an object the contract does not declare open', async () => {
    const output = await generateWireTypes(FIXTURE);

    expect(output).toMatch(/^\s+Thing: \{$/m);
    expect(output).toMatch(/^\s+ThingCreate: \{$/m);
    expect(output).not.toMatch(/\[key: string\]/);
  });

  // Break caught: the check above passing because the pattern it looks for is not what the generator writes.
  // An object the contract does declare open, by name, as a map of strings, does get an index signature, and
  // this is what the first test would see if the option were on.
  it('writes an index signature for a map the contract declares, so the check above can fail', async () => {
    const withMap = FIXTURE.replace(
      '        flag: { type: boolean, default: false }\n',
      '        flag: { type: boolean, default: false }\n        labels: { type: object, additionalProperties: { type: string } }\n',
    );
    expect(withMap, 'the fixture no longer has the line this test extends').not.toBe(FIXTURE);

    const output = await generateWireTypes(withMap);

    expect(output).toMatch(/^\s+labels\?: \{\s+\[key: string\]: string;\s+\};$/m);
  });

  // Break caught: a generator that ignores the contract's nullability, typing a value the server can
  // send as null as always present. Both spellings occur in the real contract.
  it('types a nullable property as nullable, in both the 3.0 and the 3.1 spelling', async () => {
    const output = await generateWireTypes(FIXTURE);

    expect(output).toMatch(/^\s+note\?: string \| null;$/m);
    expect(output).toMatch(/^\s+label\?: string \| null;$/m);
  });

  // Break caught: runtime values (enums, constants) emitted into a file that browser code imports,
  // which would put hundreds of kilobytes into the bundle for what is a compile-time contract.
  it('emits types only, with no runtime export', async () => {
    const output = await generateWireTypes(FIXTURE);

    expect(output).not.toMatch(/^export (?:const|let|var|enum|function|class|default)\b/m);
    expect(output).toMatch(/^export interface paths\b/m);
    expect(output).toMatch(/^export interface components\b/m);
    expect(output).toMatch(/^export interface operations\b/m);
    // The fixture has an enumeration on purpose: it is what a runtime enum would be emitted for.
    expect(output).toContain('status?: "OPEN" | "CLOSED";');
  });

  // Break caught: an alias for every schema at the top level of the file, which adds hundreds of names to
  // the module's surface. Callers reach a schema through components['schemas'].
  it('exposes schemas only through components, never as top-level aliases', async () => {
    const output = await generateWireTypes(FIXTURE);

    expect(output).toMatch(/^\s+Thing: \{$/m);
    expect(output).not.toMatch(/^export type Schema/m);
  });

  // Break caught: a malformed or non-OpenAPI file producing an empty or partial client that is then
  // written over a good one.
  it.each([
    ['not an OpenAPI document', 'title: not a contract\n'],
    ['empty', ''],
    ['syntactically invalid', 'openapi: 3.1.0\ninfo: [unclosed\n'],
  ])('rejects a contract that is %s', async (_label, text) => {
    await expect(generateWireTypes(text)).rejects.toThrow();
  });

  // Break caught: a generator upgrade that nobody decided on. A floating range would let a different
  // generator produce different types between two installs of the same lockfile revision.
  it('pins the generator to one exact version, and that version is the one installed', () => {
    const manifest = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    const pinned = manifest.devDependencies['openapi-typescript'];

    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(installedGeneratorVersion()).toBe(pinned);
  });
});
