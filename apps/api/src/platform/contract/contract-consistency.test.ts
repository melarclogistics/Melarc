import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { IMPLEMENTED_OPERATIONS } from '../../tools/contract/implemented-scope.js';
import { JsonEditor } from '../../test-support/json-edit.js';
import { isJsonObject, type Json, type JsonObject } from './json.js';
import { locateContract } from './locate-contract.js';

/**
 * The contract against itself and against the documents that own the facts it uses. contracts/openapi.yaml
 * names error codes, permission keys, security schemes and references, and states how many operations it has;
 * the validator, the comparison and every client built from it take those names on trust. A name the contract
 * uses and nothing defines is a request that can never be authorized or an error no client can branch on,
 * and no other test reads the documents together.
 *
 * Each check is a function of the parsed contract and the text of the document that owns the fact. The real
 * repository must pass it, and a copy changed in exactly one way, held in memory, must not: the contract
 * itself is the Product Owner's and is never edited here.
 */
const CONTRACT_FILE = locateContract(import.meta.dirname);
const ROOT = dirname(dirname(CONTRACT_FILE));
const read = (...segments: string[]): string => readFileSync(join(ROOT, ...segments), 'utf8');

const CONTRACT = parse(read('contracts', 'openapi.yaml')) as JsonObject;
const PERMISSIONS = read('contracts', 'permissions.md');
const ERRORS = read('contracts', 'errors-and-enums.md');
const PERFORMANCE = read('architecture', 'OBSERVABILITY_AND_RECOVERY.md');

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
const PATH_ITEM_FIELDS = ['$ref', 'summary', 'description', 'servers', 'parameters'];

interface Operation {
  readonly method: string;
  readonly path: string;
  readonly operation: JsonObject;
}

function operationsOf(contract: JsonObject): Operation[] {
  if (!isJsonObject(contract.paths)) throw new Error('The contract has no paths.');
  const found: Operation[] = [];
  for (const [path, item] of Object.entries(contract.paths)) {
    if (!isJsonObject(item)) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (isJsonObject(operation)) found.push({ method: method.toUpperCase(), path, operation });
    }
  }
  return found;
}

const at = ({ method, path }: Operation): string => `${method} ${path}`;
const stringsOf = (value: Json | undefined): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

// ---------------------------------------------------------------------------------------------------------
// (a) Every operation has an operationId, and no two share one.

function operationIdProblems(contract: JsonObject): string[] {
  const problems: string[] = [];
  const owners = new Map<string, string[]>();
  for (const operation of operationsOf(contract)) {
    const id = operation.operation.operationId;
    if (typeof id !== 'string' || id === '') {
      problems.push(`${at(operation)} has no operationId`);
    } else {
      owners.set(id, [...(owners.get(id) ?? []), at(operation)]);
    }
  }
  for (const [id, places] of owners) {
    if (places.length > 1) problems.push(`operationId ${id} is used by ${places.join(' and ')}`);
  }
  // An operation under a key this test does not know would escape every check below.
  if (isJsonObject(contract.paths)) {
    for (const [path, item] of Object.entries(contract.paths)) {
      if (!isJsonObject(item)) continue;
      for (const [key, value] of Object.entries(item)) {
        const known =
          (METHODS as readonly string[]).includes(key) || PATH_ITEM_FIELDS.includes(key);
        if (!known && !key.startsWith('x-') && isJsonObject(value) && 'responses' in value) {
          problems.push(`${path} holds an operation under the unknown key ${key}`);
        }
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------
// (b) Every error code an operation states is a member of the Error code enumeration, which is the live
// catalogue of errors-and-enums.md.

function errorEnum(contract: JsonObject): string[] {
  const schemas = isJsonObject(contract.components) ? contract.components.schemas : undefined;
  const error = isJsonObject(schemas) ? schemas.Error : undefined;
  const properties = isJsonObject(error) ? error.properties : undefined;
  const code = isJsonObject(properties) ? properties.code : undefined;
  const values = isJsonObject(code) ? stringsOf(code.enum) : [];
  if (values.length === 0) throw new Error('components.schemas.Error.properties.code has no enum.');
  return values;
}

function errorCodeProblems(contract: JsonObject): string[] {
  const members = new Set(errorEnum(contract));
  const problems: string[] = [];
  for (const operation of operationsOf(contract)) {
    const stated = operation.operation['x-error-codes'];
    if (!Array.isArray(stated)) {
      problems.push(`${at(operation)} states no x-error-codes list`);
      continue;
    }
    for (const code of stated) {
      if (typeof code !== 'string' || !members.has(code)) {
        problems.push(
          `${at(operation)} states the error code ${String(code)}, which is not in the Error enum`,
        );
      }
    }
  }
  return problems;
}

/** The codes errors-and-enums.md calls live (sections 4 and 5.1 to 5.8), and the ones it withdrew. */
function errorCatalogue(markdown: string): { live: Set<string>; withdrawn: Set<string> } {
  const lines = markdown.split(/\r?\n/);
  const first = lines.findIndex((line) => line.startsWith('## 4. '));
  const withdrawnAt = lines.findIndex((line) => line.startsWith('### 5.9 '));
  const after = lines.findIndex((line, index) => index > withdrawnAt && line.startsWith('## '));
  if (first < 0 || withdrawnAt < first || after < 0) {
    throw new Error('errors-and-enums.md no longer has sections 4, 5.9 and 6 where they were.');
  }
  const row = /^\|\s*(~~)?`([A-Z][A-Z0-9_]*)`(~~)?\s*\|/;
  const live = new Set<string>();
  const withdrawn = new Set<string>();
  lines.slice(first, withdrawnAt).forEach((line) => {
    const match = row.exec(line);
    if (match?.[2] !== undefined) (match[1] === undefined ? live : withdrawn).add(match[2]);
  });
  lines.slice(withdrawnAt, after).forEach((line) => {
    const match = row.exec(line);
    if (match?.[2] !== undefined) withdrawn.add(match[2]);
  });
  return { live, withdrawn };
}

function errorCatalogueProblems(contract: JsonObject, markdown: string): string[] {
  const members = new Set(errorEnum(contract));
  const { live, withdrawn } = errorCatalogue(markdown);
  return [
    ...[...members]
      .filter((code) => withdrawn.has(code))
      .map((code) => `${code} is in the Error enum and errors-and-enums.md withdrew it`),
    ...[...members]
      .filter((code) => !live.has(code) && !withdrawn.has(code))
      .map((code) => `${code} is in the Error enum and errors-and-enums.md does not define it`),
    ...[...live]
      .filter((code) => !members.has(code))
      .map((code) => `${code} is live in errors-and-enums.md and missing from the Error enum`),
  ];
}

// ---------------------------------------------------------------------------------------------------------
// (c) Every x-permission is a key permissions.md defines, or one of the three words the contract uses for
// "no key": `none` (any signed-in caller), `self` and `owner` (the caller's own record, by the act it
// attaches to). The contract's own header says `none` is not anonymity; these do not name a permission.

const NO_KEY = ['none', 'self', 'owner'];
const KEY = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;

/** The keys of the action catalogue (section 7), including the second key a row such as `a.enable` / `.disable` names. */
function permissionKeys(markdown: string): Set<string> {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('## 7. '));
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## 8. '));
  if (start < 0 || end < 0) throw new Error('permissions.md no longer has sections 7 and 8.');
  const keys = new Set<string>();
  for (const line of lines.slice(start, end)) {
    if (!line.startsWith('|')) continue;
    const cell = line.split('|')[1] ?? '';
    const [first, ...rest] = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
    if (first === undefined || !KEY.test(first)) continue;
    keys.add(first);
    for (const suffix of rest) {
      if (suffix.startsWith('.')) keys.add(first.slice(0, first.lastIndexOf('.')) + suffix);
    }
  }
  return keys;
}

/** The total the document states for itself ("Total grantable keys"), which the extraction above must reproduce. */
function statedKeyTotal(markdown: string): number {
  const stated = /\|\s*\*\*Total grantable keys\*\*\s*\|\s*\*\*(\d+)\*\*/.exec(markdown)?.[1];
  if (stated === undefined) throw new Error('permissions.md no longer states its total of keys.');
  return Number(stated);
}

function permissionProblems(contract: JsonObject, markdown: string): string[] {
  const keys = permissionKeys(markdown);
  const problems: string[] = [];
  for (const operation of operationsOf(contract)) {
    const permission = operation.operation['x-permission'];
    if (typeof permission !== 'string') {
      problems.push(`${at(operation)} states no x-permission`);
    } else if (!NO_KEY.includes(permission) && !keys.has(permission)) {
      problems.push(
        `${at(operation)} states x-permission ${permission}, which permissions.md does not define`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------
// (d) Every security scheme an operation names exists, and every operation says how it is authenticated.

function securityProblems(contract: JsonObject): string[] {
  const schemes = isJsonObject(contract.components)
    ? Object.keys(
        isJsonObject(contract.components.securitySchemes)
          ? contract.components.securitySchemes
          : {},
      )
    : [];
  const problems: string[] = [];
  const check = (where: string, requirements: Json | undefined): void => {
    if (!Array.isArray(requirements)) {
      problems.push(`${where} states its security as something other than a list`);
      return;
    }
    for (const requirement of requirements) {
      if (!isJsonObject(requirement)) {
        problems.push(`${where} has a security requirement that is not an object`);
        continue;
      }
      for (const name of Object.keys(requirement)) {
        if (!schemes.includes(name)) {
          problems.push(
            `${where} requires the security scheme ${name}, which components.securitySchemes lacks`,
          );
        }
      }
    }
  };

  if (contract.security !== undefined) check('the document', contract.security);
  for (const operation of operationsOf(contract)) {
    if (operation.operation.security !== undefined)
      check(at(operation), operation.operation.security);
    else if (contract.security === undefined) {
      problems.push(`${at(operation)} states no security and the document has no default`);
    }
  }

  // A response says whose credential its cookies are owed to, by scheme name.
  (function walk(node: Json, place: string): void {
    if (Array.isArray(node))
      (node as readonly Json[]).forEach((child, index) => {
        walk(child, `${place}/${String(index)}`);
      });
    else if (isJsonObject(node)) {
      for (const [key, child] of Object.entries(node)) {
        if (
          key === 'x-set-cookies-for' &&
          (typeof child !== 'string' || !schemes.includes(child))
        ) {
          problems.push(
            `${place} names the security scheme ${typeof child === 'string' ? child : JSON.stringify(child)} in x-set-cookies-for, which is not defined`,
          );
        }
        walk(child, `${place}/${key}`);
      }
    }
  })(contract, '');
  return problems;
}

// ---------------------------------------------------------------------------------------------------------
// (e) Every $ref resolves, inside this document: the contract is one file and refers to nothing outside it.

/** The value a local reference such as `#/components/schemas/Error` points to, or undefined. */
function resolveReference(document: JsonObject, reference: string): Json | undefined {
  if (!reference.startsWith('#')) return undefined;
  const pointer = reference.slice(1);
  if (pointer === '') return document;
  if (!pointer.startsWith('/')) return undefined;
  let node: Json | undefined = document;
  for (const step of pointer.slice(1).split('/')) {
    let key: string;
    try {
      const decoded = decodeURIComponent(step);
      // A tilde is only ever the start of ~0 or ~1 (RFC 6901): any other is a pointer no tool can follow.
      if (/~(?![01])/.test(decoded)) return undefined;
      key = decoded.replaceAll('~1', '/').replaceAll('~0', '~');
    } catch {
      return undefined;
    }
    if (Array.isArray(node))
      node = /^\d+$/.test(key) ? (node as readonly Json[])[Number(key)] : undefined;
    else if (isJsonObject(node) && Object.hasOwn(node, key)) node = node[key];
    else return undefined;
  }
  return node;
}

function listReferences(document: JsonObject): { place: string; reference: string }[] {
  const found: { place: string; reference: string }[] = [];
  (function walk(node: Json, place: string): void {
    if (Array.isArray(node))
      (node as readonly Json[]).forEach((child, index) => {
        walk(child, `${place}/${String(index)}`);
      });
    else if (isJsonObject(node)) {
      for (const [key, child] of Object.entries(node)) {
        if (key === '$ref' && typeof child === 'string') found.push({ place, reference: child });
        else walk(child, `${place}/${key}`);
      }
    }
  })(document, '#');
  return found;
}

function referenceProblems(contract: JsonObject): string[] {
  return listReferences(contract).flatMap(({ place, reference }) => {
    if (!reference.startsWith('#')) return [`${place} refers outside the document: ${reference}`];
    return resolveReference(contract, reference) === undefined
      ? [`${place} refers to ${reference}, which does not exist`]
      : [];
  });
}

// ---------------------------------------------------------------------------------------------------------
// (f) The number of operations is the one the repository pins. The implemented-scope tooling pins no figure
// (its list is empty and is compared by id), so the figure is the performance catalogue's in
// OBSERVABILITY_AND_RECOVERY.md, which says every operation carries exactly one class and states how many
// there are in each. Its table of ids must be the contract's ids.

const CLASSES = ['CRITICAL_WRITE', 'ASYNC', 'NORMAL'] as const;

function performanceCatalogue(markdown: string): {
  stated: { total: number } & Record<(typeof CLASSES)[number], number>;
  rows: { id: string; kind: string }[];
} {
  const lines = markdown.split(/\r?\n/);
  const statement = lines.findIndex((line) => /^\*\*\d+ operations: /.test(line));
  const figures =
    /^\*\*(\d+) operations: (\d+) `CRITICAL_WRITE` · (\d+) `ASYNC` · (\d+) `NORMAL`\.\*\*$/.exec(
      lines[statement] ?? '',
    );
  if (figures === null) throw new Error('The performance catalogue no longer states its figures.');
  const rows: { id: string; kind: string }[] = [];
  for (const line of lines.slice(statement + 1)) {
    const match = /^\|\s*`([A-Za-z][A-Za-z0-9]*)`\s*\|\s*`(CRITICAL_WRITE|ASYNC|NORMAL)`\s*\|/.exec(
      line,
    );
    if (match?.[1] !== undefined && match[2] !== undefined)
      rows.push({ id: match[1], kind: match[2] });
    else if (rows.length > 0 && line.trim() === '') break;
  }
  return {
    stated: {
      total: Number(figures[1]),
      CRITICAL_WRITE: Number(figures[2]),
      ASYNC: Number(figures[3]),
      NORMAL: Number(figures[4]),
    },
    rows,
  };
}

function operationCountProblems(
  contract: JsonObject,
  markdown: string,
  scope: readonly string[],
): string[] {
  const { stated, rows } = performanceCatalogue(markdown);
  const operations = operationsOf(contract);
  const ids = new Set(
    operations.flatMap(({ operation }) =>
      typeof operation.operationId === 'string' ? [operation.operationId] : [],
    ),
  );
  const problems: string[] = [];

  if (operations.length !== stated.total) {
    problems.push(
      `The contract has ${String(operations.length)} operations and the catalogue states ${String(stated.total)}`,
    );
  }
  const catalogued = new Map<string, number>();
  for (const { id } of rows) catalogued.set(id, (catalogued.get(id) ?? 0) + 1);
  for (const id of ids) {
    if (!catalogued.has(id))
      problems.push(`${id} is in the contract and in no class of the catalogue`);
  }
  for (const [id, times] of catalogued) {
    if (!ids.has(id))
      problems.push(`${id} is classified in the catalogue and the contract has no such operation`);
    if (times > 1) problems.push(`${id} is classified ${String(times)} times in the catalogue`);
  }
  for (const kind of CLASSES) {
    const counted = rows.filter((row) => row.kind === kind).length;
    if (counted !== stated[kind]) {
      problems.push(
        `The catalogue states ${String(stated[kind])} ${kind} operations and lists ${String(counted)}`,
      );
    }
  }
  for (const id of scope) {
    if (!ids.has(id))
      problems.push(`The implemented scope lists ${id}, which the contract does not have`);
  }
  if (scope.length > operations.length) {
    problems.push('The implemented scope lists more operations than the contract has');
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------
// (g) The status each cross-cutting code is answered with (errors-and-enums.md section 4; the Product Owner's
// decision of 6 October 2026). `VALIDATION_FAILED` is always a 400, and a business rule is a 422, so no operation
// may carry the first through the second's response. `CSRF_VALIDATION_FAILED` is a 403 and every operation that
// lists it has a 403 that carries it. `IDEMPOTENCY_KEY_CONFLICT` is a 409 and is declared, with its 409, on every
// operation that takes an `Idempotency-Key`. A shared response is only ever filed under its own status.

const SHARED_RESPONSE_STATUS: Readonly<Record<string, string>> = {
  ValidationFailed: '400',
  Forbidden: '403',
  Conflict: '409',
  RuleViolation: '422',
};

/** What an operation declares for a status, with a reference followed, or undefined. */
function answerOf(
  contract: JsonObject,
  operation: JsonObject,
  status: string,
): JsonObject | undefined {
  const responses = isJsonObject(operation.responses) ? operation.responses : {};
  const answer = responses[status];
  const resolved =
    isJsonObject(answer) && typeof answer.$ref === 'string'
      ? resolveReference(contract, answer.$ref)
      : answer;
  return isJsonObject(resolved) ? resolved : undefined;
}

function takesIdempotencyKey(contract: JsonObject, path: string, operation: JsonObject): boolean {
  const item = isJsonObject(contract.paths) ? contract.paths[path] : undefined;
  const lists = [isJsonObject(item) ? item.parameters : undefined, operation.parameters];
  return lists.some(
    (list) =>
      Array.isArray(list) &&
      (list as readonly Json[]).some((entry) => {
        const parameter =
          isJsonObject(entry) && typeof entry.$ref === 'string'
            ? resolveReference(contract, entry.$ref)
            : entry;
        return (
          isJsonObject(parameter) &&
          parameter.in === 'header' &&
          typeof parameter.name === 'string' &&
          parameter.name.toLowerCase() === 'idempotency-key'
        );
      }),
  );
}

function statusProblems(contract: JsonObject): string[] {
  const problems: string[] = [];
  const description = (answer: JsonObject | undefined): string =>
    typeof answer?.description === 'string' ? answer.description : '';

  for (const operation of operationsOf(contract)) {
    const codes = stringsOf(operation.operation['x-error-codes']);
    const where = at(operation);
    const responses = isJsonObject(operation.operation.responses)
      ? operation.operation.responses
      : {};

    if (takesIdempotencyKey(contract, operation.path, operation.operation)) {
      if (!codes.includes('IDEMPOTENCY_KEY_CONFLICT')) {
        problems.push(
          `${where} takes an Idempotency-Key and does not declare IDEMPOTENCY_KEY_CONFLICT`,
        );
      }
      if (answerOf(contract, operation.operation, '409') === undefined) {
        problems.push(`${where} takes an Idempotency-Key and declares no 409 to carry it`);
      }
    }

    const raw400 = responses['400'];
    const validation400 =
      isJsonObject(raw400) && raw400.$ref === '#/components/responses/ValidationFailed';
    if (codes.includes('VALIDATION_FAILED') && !validation400) {
      problems.push(
        `${where} declares VALIDATION_FAILED and has no 400 ValidationFailed to carry it`,
      );
    }
    if (validation400 && !codes.includes('VALIDATION_FAILED')) {
      problems.push(`${where} answers 400 ValidationFailed and does not declare VALIDATION_FAILED`);
    }
    const raw422 = responses['422'];
    if (
      isJsonObject(raw422) &&
      raw422.$ref === undefined &&
      description(raw422).includes('VALIDATION_FAILED')
    ) {
      problems.push(`${where} carries VALIDATION_FAILED under a 422`);
    }

    if (codes.includes('CSRF_VALIDATION_FAILED')) {
      const forbidden = answerOf(contract, operation.operation, '403');
      if (forbidden === undefined) {
        problems.push(`${where} declares CSRF_VALIDATION_FAILED and has no 403 to carry it`);
      } else if (!description(forbidden).includes('CSRF_VALIDATION_FAILED')) {
        problems.push(`${where} declares CSRF_VALIDATION_FAILED and its 403 does not carry it`);
      }
    }

    for (const [status, answer] of Object.entries(responses)) {
      if (!isJsonObject(answer) || typeof answer.$ref !== 'string') continue;
      const shared = /^#\/components\/responses\/(\w+)$/.exec(answer.$ref)?.[1];
      const owner = shared === undefined ? undefined : SHARED_RESPONSE_STATUS[shared];
      if (owner !== undefined && owner !== status) {
        problems.push(
          `${where} files the ${String(shared)} response under ${status}, which is ${owner}`,
        );
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------
// (h) The cookies a response sets for one type of principal (`x-set-cookies-when`): the type is one the Session can
// have, the response names cookies to apply it to, and the lifetime a cookie carries agrees with how `x-cookies`
// classes it (a browser-session cookie has none, and a persistent one says what it is).

function cookieConditionProblems(contract: JsonObject): string[] {
  const problems: string[] = [];
  const schemas =
    isJsonObject(contract.components) && isJsonObject(contract.components.schemas)
      ? contract.components.schemas
      : {};
  const session = isJsonObject(schemas.Session) ? schemas.Session : {};
  const properties = isJsonObject(session.properties) ? session.properties : {};
  const principal = isJsonObject(properties.principal_type) ? properties.principal_type : {};
  const types = stringsOf(principal.enum);
  if (types.length === 0) throw new Error('Session.principal_type has no enum.');

  for (const operation of operationsOf(contract)) {
    const responses = isJsonObject(operation.operation.responses)
      ? operation.operation.responses
      : {};
    for (const [status, answer] of Object.entries(responses)) {
      if (!isJsonObject(answer) || answer['x-set-cookies-when'] === undefined) continue;
      const where = `${at(operation)} response ${status}`;
      const condition = answer['x-set-cookies-when'];
      const type = isJsonObject(condition) ? condition.principal_type : undefined;
      if (typeof type !== 'string' || !types.includes(type)) {
        problems.push(
          `${where} sets its cookies for the principal type ${typeof type === 'string' ? type : JSON.stringify(condition)}, which Session does not define`,
        );
      }
      if (stringsOf(answer['x-set-cookies']).length === 0) {
        problems.push(`${where} states x-set-cookies-when and no cookie to apply it to`);
      }
    }
  }

  const cookies = isJsonObject(contract['x-cookies']) ? contract['x-cookies'] : {};
  for (const [name, definition] of Object.entries(cookies)) {
    if (!isJsonObject(definition)) continue;
    const attributes = typeof definition.attributes === 'string' ? definition.attributes : '';
    const lifetime = /(^|;)\s*(max-age|expires)\s*=/i.test(attributes);
    if (definition.browser_session === true && lifetime) {
      problems.push(`${name} is a browser-session cookie and its attributes give it a lifetime`);
    }
    if (definition.browser_session !== true && !lifetime) {
      problems.push(
        `${name} is not a browser-session cookie and its attributes give it no lifetime`,
      );
    }
    if (!/(^|;)\s*secure\s*(;|$)/i.test(attributes)) {
      problems.push(`${name} is not Secure`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------

describe('the contract against itself and the documents that own its facts', () => {
  it('reads as many operations as there are, so no check below can pass for having read none', () => {
    const operations = operationsOf(CONTRACT);

    expect(operations.length).toBeGreaterThan(100);
    expect(errorEnum(CONTRACT).length).toBeGreaterThan(100);
    expect(permissionKeys(PERMISSIONS).size).toBeGreaterThan(100);
    expect(listReferences(CONTRACT).length).toBeGreaterThan(100);
    expect(performanceCatalogue(PERFORMANCE).rows.length).toBe(operations.length);
  });

  // Break caught: a request that cannot be told from another, or an operation a client cannot name. Clients
  // are generated by operationId and a duplicate silently shadows one.
  it('gives every operation an operationId, and no two the same', () => {
    expect(operationIdProblems(CONTRACT)).toEqual([]);
  });

  // Break caught: an operation that promises an error nobody defined, which a client could not branch on.
  it('states only error codes that are members of the Error enumeration', () => {
    expect(errorCodeProblems(CONTRACT)).toEqual([]);
  });

  // Break caught: the enumeration and its owning document disagreeing: a code returned and never defined,
  // a defined code no response can carry, or a withdrawn code (which is never reused) back in service.
  it('keeps the Error enumeration equal to the live codes of errors-and-enums.md, with none withdrawn', () => {
    expect(errorCatalogueProblems(CONTRACT, ERRORS)).toEqual([]);
  });

  // Break caught: an operation guarded by a permission nobody can be granted, which is denied for everyone
  // forever (deny by default), or one that names a key by a typo.
  it('guards every operation with a key permissions.md defines, or with none, self or owner', () => {
    expect(permissionProblems(CONTRACT, PERMISSIONS)).toEqual([]);
  });

  // Break caught: the extraction of keys from permissions.md reading more or fewer keys than the document
  // has, which would make the check above weaker or stricter than it looks. The document states its own
  // total, and says the key count and the row count differ because one row declares two keys.
  it('reads exactly as many permission keys as the document says it holds', () => {
    expect(permissionKeys(PERMISSIONS).size).toBe(statedKeyTotal(PERMISSIONS));
  });

  // Break caught: an operation that names a way to sign in that the document does not define, or none at all.
  it('names only security schemes that exist, and leaves no operation without a statement', () => {
    expect(securityProblems(CONTRACT)).toEqual([]);
  });

  // Break caught: a reference to a schema, response, parameter or header that was renamed or removed, which
  // no generator can resolve and a validator reads as "anything".
  it('resolves every $ref inside the document', () => {
    expect(referenceProblems(CONTRACT)).toEqual([]);
  });

  // Break caught: an operation added to or dropped from the contract without the performance catalogue
  // saying so: a critical write with no class, or a class for an operation that is gone.
  it('has as many operations as the performance catalogue pins, the same ones, and a scope within them', () => {
    expect(operationCountProblems(CONTRACT, PERFORMANCE, IMPLEMENTED_OPERATIONS)).toEqual([]);
  });

  // Break caught: an operation that a client cannot tell the refusal of from, because the status its code is
  // answered with is missing or is another's: VALIDATION_FAILED reachable only through a 422, a failed CSRF check
  // with no 403 to carry it, or a replayed key with a different payload and no 409.
  it('answers every cross-cutting code with its own status, on every operation that can return it', () => {
    expect(statusProblems(CONTRACT)).toEqual([]);
  });

  // Break caught: a response that says a cookie is owed to a type of principal nothing has, so that no answer ever
  // is, or a cookie whose lifetime contradicts how the contract classes it.
  it('sets cookies only for principal types the Session has, and gives each cookie the lifetime it is classed with', () => {
    expect(cookieConditionProblems(CONTRACT)).toEqual([]);
  });
});

/** The real contract with one change, in memory. */
function changed(edit: (copy: JsonEditor) => void): JsonObject {
  const copy = new JsonEditor(CONTRACT);
  edit(copy);
  return copy.document;
}
const LIST = ['paths', '/pickup-requests', 'get'] as const;
const CREATE = ['paths', '/pickup-requests', 'post'] as const;

describe('(a) operation ids: each way to break it is found', () => {
  it('finds an operation with no id, and an id used twice', () => {
    const missing = changed((copy) => {
      copy.remove([...LIST, 'operationId']);
    });
    const twice = changed((copy) => {
      copy.set([...LIST, 'operationId'], 'createPickupRequest');
    });
    const empty = changed((copy) => {
      copy.set([...LIST, 'operationId'], '');
    });

    expect(operationIdProblems(missing)).toEqual(['GET /pickup-requests has no operationId']);
    expect(operationIdProblems(empty)).toEqual(['GET /pickup-requests has no operationId']);
    expect(operationIdProblems(twice)).toEqual([
      'operationId createPickupRequest is used by GET /pickup-requests and POST /pickup-requests',
    ]);
  });

  it('finds an operation hiding under a method key the checks do not read', () => {
    const hidden = changed((copy) => {
      copy.set(['paths', '/pickup-requests', 'query'], {
        operationId: 'queryPickups',
        responses: {},
      });
    });

    expect(operationIdProblems(hidden)).toEqual([
      '/pickup-requests holds an operation under the unknown key query',
    ]);
  });
});

describe('(b) error codes: each way to break it is found', () => {
  const STATES = [...CREATE, 'x-error-codes'] as const;

  it('finds an error code an operation states that the enumeration lacks', () => {
    const invented = changed((copy) => {
      copy.push(STATES, 'NOT_A_REAL_CODE');
    });
    const withdrawn = changed((copy) => {
      copy.push(STATES, 'WRONG_HUB');
    });
    const absent = changed((copy) => {
      copy.remove(STATES);
    });

    expect(errorCodeProblems(invented)).toEqual([
      'POST /pickup-requests states the error code NOT_A_REAL_CODE, which is not in the Error enum',
    ]);
    expect(errorCodeProblems(withdrawn)).toHaveLength(1);
    expect(errorCodeProblems(absent)).toEqual([
      'POST /pickup-requests states no x-error-codes list',
    ]);
  });

  it('finds a code removed from the enumeration, once for every operation that states it', () => {
    const shrunk = changed((copy) => {
      copy.update<string[]>(
        ['components', 'schemas', 'Error', 'properties', 'code', 'enum'],
        (codes) => codes.filter((code) => code !== 'STATE_CONFLICT'),
      );
    });
    const problems = errorCodeProblems(shrunk);
    const users = operationsOf(CONTRACT).filter((operation) =>
      stringsOf(operation.operation['x-error-codes']).includes('STATE_CONFLICT'),
    );

    expect(users.length).toBeGreaterThan(5);
    expect(problems).toHaveLength(users.length);
    expect(problems.every((problem) => problem.includes('STATE_CONFLICT'))).toBe(true);
  });

  it('finds the enumeration and errors-and-enums.md disagreeing, in each direction', () => {
    const plus = (code: string) =>
      changed((copy) => {
        copy.push(['components', 'schemas', 'Error', 'properties', 'code', 'enum'], code);
      });
    const minus = (code: string) =>
      changed((copy) => {
        copy.update<string[]>(
          ['components', 'schemas', 'Error', 'properties', 'code', 'enum'],
          (codes) => codes.filter((member) => member !== code),
        );
      });

    expect(errorCatalogueProblems(plus('SMUGGLED_CODE'), ERRORS)).toEqual([
      'SMUGGLED_CODE is in the Error enum and errors-and-enums.md does not define it',
    ]);
    // A code the document withdrew, struck through in its table (WRONG_HUB) and listed in 5.9 (OWNERSHIP_VIOLATION).
    expect(errorCatalogueProblems(plus('WRONG_HUB'), ERRORS)).toEqual([
      'WRONG_HUB is in the Error enum and errors-and-enums.md withdrew it',
    ]);
    expect(errorCatalogueProblems(plus('OWNERSHIP_VIOLATION'), ERRORS)).toEqual([
      'OWNERSHIP_VIOLATION is in the Error enum and errors-and-enums.md withdrew it',
    ]);
    expect(errorCatalogueProblems(minus('STATE_CONFLICT'), ERRORS)).toEqual([
      'STATE_CONFLICT is live in errors-and-enums.md and missing from the Error enum',
    ]);
  });

  it('reads the withdrawn codes of the document, struck through or listed in 5.9', () => {
    const { live, withdrawn } = errorCatalogue(ERRORS);

    expect(live.has('STATE_CONFLICT')).toBe(true);
    expect([...withdrawn]).toEqual(expect.arrayContaining(['WRONG_HUB', 'OWNERSHIP_VIOLATION']));
    expect([...live].filter((code) => withdrawn.has(code))).toEqual([]);
  });
});

describe('(c) permissions: each way to break it is found', () => {
  const PERMISSION = [...CREATE, 'x-permission'] as const;

  it('finds a key permissions.md does not define, a near miss, and a missing statement', () => {
    const invented = changed((copy) => {
      copy.set(PERMISSION, 'pickup.request.vanish');
    });
    const nearMiss = changed((copy) => {
      copy.set(PERMISSION, 'pickup.request.create ');
    });
    const wordCased = changed((copy) => {
      copy.set(PERMISSION, 'None');
    });
    const missing = changed((copy) => {
      copy.remove(PERMISSION);
    });

    expect(permissionProblems(invented, PERMISSIONS)).toEqual([
      'POST /pickup-requests states x-permission pickup.request.vanish, which permissions.md does not define',
    ]);
    expect(permissionProblems(nearMiss, PERMISSIONS)).toHaveLength(1);
    expect(permissionProblems(wordCased, PERMISSIONS)).toHaveLength(1);
    expect(permissionProblems(missing, PERMISSIONS)).toEqual([
      'POST /pickup-requests states no x-permission',
    ]);
  });

  it('allows none, self and owner, and no other word', () => {
    for (const word of NO_KEY) {
      expect(
        permissionProblems(
          changed((copy) => {
            copy.set(PERMISSION, word);
          }),
          PERMISSIONS,
        ),
      ).toEqual([]);
    }
    expect(
      permissionProblems(
        changed((copy) => {
          copy.set(PERMISSION, 'anyone');
        }),
        PERMISSIONS,
      ),
    ).toHaveLength(1);
  });

  // Break caught: the document losing a key the contract still uses (a renamed or removed row).
  it('finds a key removed from, or renamed in, permissions.md', () => {
    const renamed = PERMISSIONS.replace(
      '| `pickup.request.create`|',
      '| `pickup.request.created`|',
    );
    const dropped = PERMISSIONS.replace(/^\| `pickup\.request\.create`\|.*\r?\n/m, '');
    const users = operationsOf(CONTRACT).filter(
      (operation) => operation.operation['x-permission'] === 'pickup.request.create',
    );

    expect(renamed).not.toBe(PERMISSIONS);
    expect(dropped).not.toBe(PERMISSIONS);
    expect(users.length).toBeGreaterThan(0);
    expect(permissionProblems(CONTRACT, renamed)).toHaveLength(users.length);
    expect(permissionProblems(CONTRACT, dropped)).toHaveLength(users.length);
  });

  // Break caught: the extraction missing the second key of a row that declares two.
  it('reads both keys of the row that declares vendor.allowance.enable and .disable', () => {
    const keys = permissionKeys(PERMISSIONS);

    expect(keys.has('vendor.allowance.enable')).toBe(true);
    expect(keys.has('vendor.allowance.disable')).toBe(true);
    expect(keys.has('vendor.allowance')).toBe(false);
  });

  it('stops reading keys at a document that has lost or gained a row, by its own stated total', () => {
    const lost = PERMISSIONS.replace(/^\| `pickup\.request\.cancel`\|.*\r?\n/m, '');

    expect(permissionKeys(lost).size).toBe(statedKeyTotal(PERMISSIONS) - 1);
    expect(permissionKeys(lost).size).not.toBe(statedKeyTotal(lost));
  });
});

describe('(d) security: each way to break it is found', () => {
  it('finds an operation that names a scheme the document does not define', () => {
    const typo = changed((copy) => {
      copy.set([...LIST, 'security'], [{ browserSesion: [] }]);
    });
    const alongside = changed((copy) => {
      copy.set([...LIST, 'security'], [{ browserSession: [], ghost: [] }]);
    });

    expect(securityProblems(typo)).toEqual([
      'GET /pickup-requests requires the security scheme browserSesion, which components.securitySchemes lacks',
    ]);
    expect(securityProblems(alongside)).toHaveLength(1);
  });

  it('finds a scheme that was removed while operations still name it', () => {
    const removed = changed((copy) => {
      copy.remove(['components', 'securitySchemes', 'csrfToken']);
    });
    const problems = securityProblems(removed);
    // The default every unmarked operation inherits, and each operation that states its own.
    const own = operationsOf(CONTRACT).filter((operation) =>
      JSON.stringify(operation.operation.security ?? []).includes('csrfToken'),
    );

    expect(own.length).toBeGreaterThan(0);
    expect(problems).toHaveLength(1 + own.length);
    expect(problems.some((problem) => problem.startsWith('the document requires'))).toBe(true);
    expect(problems.every((problem) => problem.includes('csrfToken'))).toBe(true);
  });

  it('finds an operation with no statement of its own and no default to inherit', () => {
    const noDefault = changed((copy) => {
      copy.remove(['security']);
    });
    const problems = securityProblems(noDefault);

    expect(problems.length).toBeGreaterThan(10);
    expect(
      problems.every((problem) =>
        problem.endsWith('states no security and the document has no default'),
      ),
    ).toBe(true);
    // Saying `security: []` is a statement: it is how an operation says it needs no credential.
    expect(
      securityProblems(
        changed((copy) => {
          copy.set([...LIST, 'security'], []);
        }),
      ),
    ).toEqual([]);
  });

  it('finds a response whose cookies are owed to a scheme that does not exist', () => {
    const answer = [
      'paths',
      '/auth/session',
      'delete',
      'responses',
      '204',
      'x-set-cookies-for',
    ] as const;
    const ghost = changed((copy) => {
      copy.set(answer, 'ghostSession');
    });

    expect(securityProblems(ghost)).toEqual([
      '/paths//auth/session/delete/responses/204 names the security scheme ghostSession in x-set-cookies-for, which is not defined',
    ]);
  });
});

describe('(e) references: each way to break it is found', () => {
  const BODY = [...CREATE, 'requestBody', 'content', 'application/json', 'schema'] as const;

  it('finds a reference to a component that does not exist, and one that leaves the document', () => {
    const typo = changed((copy) => {
      copy.set(BODY, { $ref: '#/components/schemas/PickupRequestCreated' });
    });
    const outside = changed((copy) => {
      copy.set(BODY, { $ref: 'other.yaml#/components/schemas/Error' });
    });
    const bare = changed((copy) => {
      copy.set(BODY, { $ref: 'PickupRequestCreate' });
    });

    expect(referenceProblems(typo)).toEqual([
      '#/paths//pickup-requests/post/requestBody/content/application/json/schema refers to #/components/schemas/PickupRequestCreated, which does not exist',
    ]);
    expect(referenceProblems(outside)).toHaveLength(1);
    expect(referenceProblems(outside)[0]).toContain('refers outside the document');
    expect(referenceProblems(bare)).toHaveLength(1);
  });

  it('finds a component removed while references to it remain', () => {
    const removed = changed((copy) => {
      copy.remove(['components', 'schemas', 'Error']);
    });
    const users = listReferences(CONTRACT).filter(
      ({ reference }) => reference === '#/components/schemas/Error',
    );

    expect(users.length).toBeGreaterThan(10);
    expect(referenceProblems(removed)).toHaveLength(users.length);
  });

  it('resolves the way JSON Pointer says: ~1 is a slash, ~0 a tilde, an index is a position', () => {
    const document: JsonObject = {
      paths: { '/a/b': { get: { ok: true } }, 'x~y': 1 },
      list: [{ name: 'first' }, { name: 'second' }],
    };

    expect(resolveReference(document, '#/paths/~1a~1b/get/ok')).toBe(true);
    expect(resolveReference(document, '#/paths/x~0y')).toBe(1);
    expect(resolveReference(document, '#/list/1/name')).toBe('second');
    expect(resolveReference(document, '#')).toBe(document);
    expect(resolveReference(document, '#/list/2')).toBeUndefined();
    // A fragment is a URI part, so it is percent-decoded before the ~ escapes are.
    expect(resolveReference(document, '#/paths/%2Fa%2Fb/get/ok')).toBe(true);
    expect(resolveReference(document, '#/paths/%E0%A4%A')).toBeUndefined();
    expect(resolveReference(document, '#/toString')).toBeUndefined();
    expect(resolveReference(document, '#/paths/x~y')).toBeUndefined();
    expect(resolveReference(document, 'other.yaml#/paths')).toBeUndefined();
  });
});

describe('(f) the number of operations: each way to break it is found', () => {
  it('finds an operation removed from, or added to, the contract', () => {
    const removed = changed((copy) => {
      copy.remove(['paths', '/pickup-requests', 'get']);
    });
    const added = changed((copy) => {
      copy.set(['paths', '/ghosts'], { get: { operationId: 'listGhosts', responses: {} } });
    });

    expect(operationCountProblems(removed, PERFORMANCE, [])).toEqual([
      'The contract has 171 operations and the catalogue states 172',
      'listPickupRequests is classified in the catalogue and the contract has no such operation',
    ]);
    expect(operationCountProblems(added, PERFORMANCE, [])).toEqual([
      'The contract has 173 operations and the catalogue states 172',
      'listGhosts is in the contract and in no class of the catalogue',
    ]);
  });

  it('finds an operation renamed in the contract and not in the catalogue, at the same count', () => {
    const renamed = changed((copy) => {
      copy.set([...LIST, 'operationId'], 'listPickups');
    });

    expect(operationCountProblems(renamed, PERFORMANCE, [])).toEqual([
      'listPickups is in the contract and in no class of the catalogue',
      'listPickupRequests is classified in the catalogue and the contract has no such operation',
    ]);
  });

  it('finds the catalogue changed: a row dropped, an operation classified twice, a class moved', () => {
    const row = /^\| `listPickupRequests`\|.*\r?\n/m;
    const dropped = PERFORMANCE.replace(row, '');
    const twice = PERFORMANCE.replace(row, (line) => `${line}${line}`);
    const moved = PERFORMANCE.replace(
      /^\| `listPickupRequests`\| `NORMAL`\|/m,
      '| `listPickupRequests`| `CRITICAL_WRITE`|',
    );

    expect(dropped).not.toBe(PERFORMANCE);
    expect(operationCountProblems(CONTRACT, dropped, [])).toEqual([
      'listPickupRequests is in the contract and in no class of the catalogue',
      'The catalogue states 63 NORMAL operations and lists 62',
    ]);
    expect(operationCountProblems(CONTRACT, twice, [])).toEqual([
      'listPickupRequests is classified 2 times in the catalogue',
      'The catalogue states 63 NORMAL operations and lists 64',
    ]);
    expect(moved).not.toBe(PERFORMANCE);
    expect(operationCountProblems(CONTRACT, moved, [])).toEqual([
      'The catalogue states 109 CRITICAL_WRITE operations and lists 110',
      'The catalogue states 63 NORMAL operations and lists 62',
    ]);
  });

  it('finds the stated figure changed', () => {
    const edited = PERFORMANCE.replace('**172 operations:', '**173 operations:');

    expect(edited).not.toBe(PERFORMANCE);
    expect(operationCountProblems(CONTRACT, edited, [])).toEqual([
      'The contract has 172 operations and the catalogue states 173',
    ]);
  });

  // Break caught: the implemented scope naming an operation the contract does not have, or more than it has.
  it('finds an implemented scope that names an operation the contract lacks', () => {
    expect(operationCountProblems(CONTRACT, PERFORMANCE, ['listPickupRequests'])).toEqual([]);
    expect(operationCountProblems(CONTRACT, PERFORMANCE, ['listPickupRequestz'])).toEqual([
      'The implemented scope lists listPickupRequestz, which the contract does not have',
    ]);
  });
});

describe('(g) statuses: each way to break it is found', () => {
  const answers = (id: string) => {
    const found = operationsOf(CONTRACT).find((entry) => entry.operation.operationId === id);
    if (found === undefined) throw new Error(`No operation ${id}`);
    return ['paths', found.path, found.method.toLowerCase()] as const;
  };

  it('finds an operation that takes an Idempotency-Key and lacks its code or its 409', () => {
    const noCode = changed((copy) => {
      copy.update<string[]>([...answers('registerRiderDevice'), 'x-error-codes'], (codes) =>
        codes.filter((code) => code !== 'IDEMPOTENCY_KEY_CONFLICT'),
      );
    });
    const noAnswer = changed((copy) => {
      copy.remove([...answers('registerRiderDevice'), 'responses', '409']);
    });

    expect(statusProblems(noCode)).toEqual([
      'POST /ops/riders/{riderId}/device/register takes an Idempotency-Key and does not declare IDEMPOTENCY_KEY_CONFLICT',
    ]);
    expect(statusProblems(noAnswer)).toEqual([
      'POST /ops/riders/{riderId}/device/register takes an Idempotency-Key and declares no 409 to carry it',
    ]);
  });

  it('finds an operation that takes the key through its path item, by a name written in lower case', () => {
    const onThePath = changed((copy) => {
      copy.set(['paths', '/ghosts'], {
        parameters: [{ name: 'idempotency-key', in: 'header', schema: { type: 'string' } }],
        post: { operationId: 'makeGhost', 'x-error-codes': [], responses: {} },
      });
    });

    expect(statusProblems(onThePath)).toEqual([
      'POST /ghosts takes an Idempotency-Key and does not declare IDEMPOTENCY_KEY_CONFLICT',
      'POST /ghosts takes an Idempotency-Key and declares no 409 to carry it',
    ]);
  });

  it('finds VALIDATION_FAILED with no 400, a 400 that is not declared, and the code under a 422', () => {
    const no400 = changed((copy) => {
      copy.remove([...answers('requestRiderSignInChallenge'), 'responses', '400']);
    });
    const undeclared = changed((copy) => {
      copy.update<string[]>([...answers('requestRiderSignInChallenge'), 'x-error-codes'], (codes) =>
        codes.filter((code) => code !== 'VALIDATION_FAILED'),
      );
    });
    const under422 = changed((copy) => {
      copy.set([...answers('requestRiderSignInChallenge'), 'responses', '422'], {
        description: '`VALIDATION_FAILED` for a phone that is not E.164',
      });
    });
    const filed = changed((copy) => {
      copy.set([...answers('requestRiderSignInChallenge'), 'responses', '422'], {
        $ref: '#/components/responses/ValidationFailed',
      });
    });

    expect(statusProblems(no400)).toEqual([
      'POST /auth/rider/sign-in/challenge declares VALIDATION_FAILED and has no 400 ValidationFailed to carry it',
    ]);
    expect(statusProblems(undeclared)).toEqual([
      'POST /auth/rider/sign-in/challenge answers 400 ValidationFailed and does not declare VALIDATION_FAILED',
    ]);
    expect(statusProblems(under422)).toEqual([
      'POST /auth/rider/sign-in/challenge carries VALIDATION_FAILED under a 422',
    ]);
    expect(statusProblems(filed)).toEqual([
      'POST /auth/rider/sign-in/challenge files the ValidationFailed response under 422, which is 400',
    ]);
  });

  it('finds CSRF_VALIDATION_FAILED with no 403, and a 403 that does not carry it', () => {
    const none = changed((copy) => {
      copy.remove([...answers('signOut'), 'responses', '403']);
    });
    const silent = changed((copy) => {
      copy.set(['components', 'responses', 'Forbidden', 'description'], '`PERMISSION_DENIED`.');
    });

    expect(statusProblems(none)).toEqual([
      'DELETE /auth/session declares CSRF_VALIDATION_FAILED and has no 403 to carry it',
    ]);
    const quiet = statusProblems(silent);
    expect(quiet.length).toBeGreaterThan(50);
    expect(quiet.every((problem) => problem.endsWith('and its 403 does not carry it'))).toBe(true);
  });

  it('keeps the shared 422 from naming VALIDATION_FAILED, except to say it is not one', () => {
    const description = (
      ((CONTRACT.components as JsonObject).responses as JsonObject).RuleViolation as JsonObject
    ).description as string;

    expect(description).toContain('Never `VALIDATION_FAILED`');
  });
});

describe('(h) cookie conditions and lifetimes: each way to break it is found', () => {
  const RECOVERY = [
    'paths',
    '/auth/recovery/complete',
    'post',
    'responses',
    '204',
    'x-set-cookies-when',
  ] as const;

  it('finds a condition on a type of principal that Session does not have, or on no cookie', () => {
    const ghost = changed((copy) => {
      copy.set(RECOVERY, { principal_type: 'VENDER' });
    });
    const bare = changed((copy) => {
      copy.set(RECOVERY, 'VENDOR');
    });
    const none = changed((copy) => {
      copy.set(
        ['paths', '/auth/recovery/complete', 'post', 'responses', '204', 'x-set-cookies'],
        [],
      );
    });

    expect(cookieConditionProblems(ghost)).toEqual([
      'POST /auth/recovery/complete response 204 sets its cookies for the principal type VENDER, which Session does not define',
    ]);
    expect(cookieConditionProblems(bare)).toEqual([
      'POST /auth/recovery/complete response 204 sets its cookies for the principal type "VENDOR", which Session does not define',
    ]);
    expect(cookieConditionProblems(none)).toEqual([
      'POST /auth/recovery/complete response 204 states x-set-cookies-when and no cookie to apply it to',
    ]);
  });

  it('finds a cookie whose lifetime contradicts how it is classed, and one that is not Secure', () => {
    const persistent = changed((copy) => {
      copy.set(
        ['x-cookies', 'melarc_session', 'attributes'],
        'HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600',
      );
    });
    const forgotten = changed((copy) => {
      copy.set(
        ['x-cookies', 'melarc_vendor_device', 'attributes'],
        'HttpOnly; Secure; SameSite=Lax; Path=/',
      );
    });
    const open = changed((copy) => {
      copy.set(['x-cookies', 'melarc_csrf', 'attributes'], 'SameSite=Lax; Path=/');
    });

    expect(cookieConditionProblems(persistent)).toEqual([
      'melarc_session is a browser-session cookie and its attributes give it a lifetime',
    ]);
    expect(cookieConditionProblems(forgotten)).toEqual([
      'melarc_vendor_device is not a browser-session cookie and its attributes give it no lifetime',
    ]);
    expect(cookieConditionProblems(open)).toEqual(['melarc_csrf is not Secure']);
  });
});
