import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import openapiTS, { astToString, type OpenAPITSOptions } from 'openapi-typescript';
import { parse } from 'yaml';

/**
 * Every option that changes what the output means is stated here, so a reader can see the choices and a
 * generator upgrade, which is a deliberate change of the exact pin, cannot move them silently.
 *
 * The aim is the contract's own words and nothing more: what it lists as `required` is required, and
 * nothing else is.
 */
const GENERATOR_OPTIONS: OpenAPITSOptions = {
  // A property with a `default` is optional unless the contract also lists it as required. The generator's
  // own default makes it required, which would force a caller to send fields the contract lets it omit
  // (CollectionRecordCreate.handshake_channel and is_high_value are such request fields today).
  defaultNonNullable: false,
  propertiesRequiredByDefault: false,
  // No index signature on objects the contract does not close, and no `Record<string, never>` guesses.
  additionalProperties: false,
  emptyObjectsUnknown: false,
  // Types only. A runtime enum or constant would be bundled into the browser for a compile-time contract.
  enum: false,
  // Contract order, so the output depends on the contract's text and nothing else.
  alphabetize: false,
  // No `SchemaX` alias for each of the contract's schemas. They would add hundreds of names to the module for
  // no gain: callers reach a schema as `components['schemas']['X']`, and `index.ts` names the few it needs.
  rootTypes: false,
};

export const GENERATE_COMMAND = 'pnpm run api-client:generate';

const require = createRequire(import.meta.url);

/** The generator version that is actually installed, which the header records and a test compares to the pin. */
export function installedGeneratorVersion(): string {
  const manifest = require('openapi-typescript/package.json') as { version: string };
  return manifest.version;
}

/** Line endings differ between a Windows working copy and a Linux checkout, and mean nothing in YAML. */
export function normalizeLineEndings(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

interface ContractIdentity {
  readonly title: string;
  readonly version: string;
}

function readIdentity(contractText: string): ContractIdentity {
  const document: unknown = parse(contractText);
  const info = (document as { info?: unknown } | null)?.info as
    { title?: unknown; version?: unknown } | null | undefined;
  const openapi = (document as { openapi?: unknown } | null)?.openapi;
  if (typeof openapi !== 'string' || !openapi.startsWith('3.')) {
    throw new Error('The contract is not an OpenAPI 3 document: it has no "openapi: 3.x" field.');
  }
  if (typeof info?.title !== 'string' || typeof info.version !== 'string') {
    throw new Error('The contract has no info.title and info.version to record in the output.');
  }
  return { title: info.title, version: info.version };
}

function headerFor(identity: ContractIdentity, contractText: string): string {
  const hash = createHash('sha256').update(contractText).digest('hex');
  return [
    '/**',
    ' * GENERATED FILE - DO NOT EDIT.',
    ' *',
    ' * Wire types for the Melarc API, generated from contracts/openapi.yaml:',
    ` *   ${identity.title} ${identity.version}`,
    ` *   SHA-256 ${hash} (of the contract, line endings normalized to LF)`,
    ` * Generator: openapi-typescript ${installedGeneratorVersion()}`,
    ` * Regenerate with: ${GENERATE_COMMAND}`,
    ' */',
    '',
  ].join('\n');
}

/**
 * The generated wire types for a contract, as the exact text of the file. Pure: the same contract text
 * always gives the same output, whatever the line endings, machine or time. Nothing is written here, so a
 * contract that fails to generate can never leave a partial file behind.
 */
export async function generateWireTypes(contractText: string): Promise<string> {
  const normalized = normalizeLineEndings(contractText);
  const identity = readIdentity(normalized);
  const body = astToString(await openapiTS(normalized, GENERATOR_OPTIONS));
  return `${headerFor(identity, normalized)}${body.trimEnd()}\n`;
}
