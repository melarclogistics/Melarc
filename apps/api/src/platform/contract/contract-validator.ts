import { createRequire } from 'node:module';

import type { Ajv2020, ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';

import {
  brokenAttributes,
  expectedCookie,
  parseCookieHeader,
  parseSetCookies,
  type ExpectedCookie,
} from './cookies.js';
import { credentialCheck, type CredentialCheck } from './credentials.js';
import { isJsonObject, type Json, type JsonObject } from './json.js';
import { encodeSegment, PointerOwnership } from './violation-pointer.js';

/** The most violations one validation reports. A hostile body must not make the answer grow with it. */
export const MAX_VIOLATIONS = 20;

/** Where in a request or a response a rule was broken. */
export type ViolationLocation =
  | 'path'
  | 'query'
  | 'header'
  | 'cookie'
  | 'body'
  | 'status'
  | 'response-header'
  | 'response-cookie'
  | 'response-body';

/**
 * One broken rule. It is built only from what the contract says (property names, rule keywords) and from
 * array positions, never from what the caller sent, so it can be returned to the caller as it is.
 */
export interface ContractViolation {
  readonly in: ViolationLocation;
  /**
   * For a body, a JSON pointer inside it (`''` for the whole body, `*` for a key that is the data's); for
   * anything else, the parameter, header or cookie name, or `*` for a cookie the contract does not know.
   */
  readonly pointer: string;
  /**
   * The schema keyword that was broken (`required`, `enum`, `type`, `additionalProperties`, ...), or
   * `undeclared`, `unexpected` and `sent-by-handler`; for a cookie, `required`, `undeclared` or the attribute
   * that is wrong (`httponly`, `secure`, `samesite`, `path`, `domain`).
   */
  readonly rule: string;
}

export interface RequestParts {
  readonly params: Readonly<Record<string, unknown>>;
  readonly query: Readonly<Record<string, unknown>>;
  /** Header names lower-cased, as Node delivers them. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: unknown;
  /** Whether the request carried a body at all, which is not the same as the body being a value. */
  readonly hasBody: boolean;
}

export interface ResponseParts {
  readonly status: number;
  readonly body: unknown;
  /** Header names lower-cased. */
  readonly headers: Readonly<Record<string, unknown>>;
}

const CONTRACT_ID = 'urn:melarc:contract';

/** The hyphenated text form of a UUID, in either case, and nothing around it. */
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const requireModule = createRequire(import.meta.url);

/**
 * Ajv is loaded the first time a validator is built, not when this module is imported: it costs about
 * 200 ms, and an application with no handler bound to the contract (today's) never builds one. Both
 * packages are CommonJS; the plugin is the module itself.
 */
function loadAjv(): {
  Ajv2020: typeof import('ajv/dist/2020.js').Ajv2020;
  addFormats: (ajv: Ajv2020) => unknown;
} {
  const { Ajv2020: Ajv } = requireModule('ajv/dist/2020.js') as {
    Ajv2020: typeof import('ajv/dist/2020.js').Ajv2020;
  };
  return { Ajv2020: Ajv, addFormats: requireModule('ajv-formats') as (ajv: Ajv2020) => unknown };
}

type ParameterLocation = 'path' | 'query' | 'header' | 'cookie';

/** A compiled schema, and the schema it was compiled from: the latter says which names in a path are the contract's. */
interface Compiled {
  readonly validate: ValidateFunction;
  readonly schema: Json;
}

interface PreparedResponse {
  readonly body: Compiled | undefined;
  readonly declaresContent: boolean;
  readonly requiredHeaders: readonly string[];
  /** The value schema of each declared header, by lower-cased name. `Set-Cookie` is judged as cookies instead. */
  readonly headerValues: ReadonlyMap<string, Compiled>;
  /** The cookies this response sets (`x-set-cookies`), each with what `x-cookies` says it must carry. */
  readonly cookies: ReadonlyMap<string, ExpectedCookie>;
  /**
   * `x-set-cookies-for`: the cookies apply only to a request that presented this scheme's credential. Any other
   * request is owed none, and one that gets some has an undeclared cookie.
   */
  readonly cookiesFor: { readonly scheme: string; readonly presented: CredentialCheck } | undefined;
}

interface Prepared {
  readonly parameters: Partial<Record<ParameterLocation, Compiled>>;
  readonly body: (Compiled & { readonly required: boolean }) | undefined;
  readonly responses: ReadonlyMap<string, PreparedResponse>;
}

function objectAt(value: Json | undefined, what: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`The contract's ${what} must be an object.`);
  return value;
}

/** Points every reference inside the document at the contract's own resources, so a schema can be compiled alone. */
function anchorReferences(value: Json): Json {
  if (Array.isArray(value)) return value.map((item) => anchorReferences(item as Json));
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === '$ref' && typeof child === 'string' && child.startsWith('#')
        ? `${CONTRACT_ID}${child}`
        : anchorReferences(child),
    ]),
  );
}

/**
 * Whether Ajv read this text as a value of another type that the text does not write. Its coercion takes
 * `0x10`, ` 5`, `1e1`, `+5` and `05` for an integer, so the parameter validates while the handler, which is
 * given the text as it was sent, may read it another way (`parseInt` and `Number` disagree on those). A value
 * is accepted only when the text is exactly what the number or boolean would be written as, and a number is
 * finite.
 */
function readAsOther(sent: unknown, read: unknown): boolean {
  if (typeof sent === 'string') {
    if (typeof read === 'number') return !Number.isFinite(read) || String(read) !== sent;
    if (typeof read === 'boolean' || read === null) return String(read) !== sent;
    if (Array.isArray(read)) return read.length !== 1 || readAsOther(sent, read[0]);
    return false;
  }
  if (Array.isArray(sent) && Array.isArray(read)) {
    return sent.some((item, index) => readAsOther(item, read[index]));
  }
  return false;
}

/** The names of the parameters in `sent` that were read as another type that their text does not write. */
function namesReadAsOther(sent: Record<string, unknown>, read: Record<string, unknown>): string[] {
  return Object.keys(read).filter((name) => readAsOther(sent[name], read[name]));
}

function decodeSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

/**
 * The errors that belong to a branch of a `oneOf` or `anyOf` that matched nothing. Ajv reports every failed
 * branch's own errors and then the choice's error, so the branch errors are the run just before it, at or
 * below its place in the data. A schema's own sibling rules (`required`, `properties`) are not in that run:
 * Ajv evaluates the applicators (`$ref`, `enum`, `anyOf`, `oneOf`, `allOf`) before the type-specific
 * keywords, so those are reported after the choice. Paths cannot be used to tell the two apart: Ajv drops the
 * base of a reference's path, so a referenced branch looks like the owner's own `allOf`.
 */
function branchErrorIndexes(errors: readonly ErrorObject[]): Set<number> {
  const dropped = new Set<number>();
  errors.forEach((choice, index) => {
    if (choice.keyword !== 'oneOf' && choice.keyword !== 'anyOf') return;
    for (let before = index - 1; before >= 0; before -= 1) {
      const error = errors[before];
      if (!error?.instancePath.startsWith(choice.instancePath)) break;
      dropped.add(before);
    }
  });
  return dropped;
}

/**
 * Turns what Ajv reports into violations: one per distinct place and rule. Errors that only summarise others
 * (`if`) or that belong to a branch of a `oneOf`/`anyOf` that did not match are dropped, because the branch
 * that failed is not the problem; the `oneOf` or `anyOf` that none matched is.
 *
 * `pointerTo` turns the place in the data into what may be said about it (see PointerOwnership). A missing
 * required property is named by the schema's own `required` list, so it is added to that pointer as it is.
 */
function violationsOf(
  location: ViolationLocation,
  errors: readonly ErrorObject[] | null | undefined,
  pointerTo: (instancePath: string) => string,
  finish: (pointer: string) => string = (pointer) => pointer,
): ContractViolation[] {
  const seen = new Set<string>();
  const violations: ContractViolation[] = [];
  const branches = branchErrorIndexes(errors ?? []);
  for (const [index, error] of (errors ?? []).entries()) {
    if (error.keyword === 'if' || branches.has(index)) continue;
    const pointer = finish(
      error.keyword === 'required'
        ? `${pointerTo(error.instancePath)}/${encodeSegment((error.params as { missingProperty: string }).missingProperty)}`
        : pointerTo(error.instancePath),
    );
    const key = `${pointer}\u0000${error.keyword}`;
    if (seen.has(key)) continue;
    seen.add(key);
    violations.push({ in: location, pointer, rule: error.keyword });
  }
  return violations;
}

/**
 * Validates requests and responses against the schemas of contracts/openapi.yaml itself: the parameters, the
 * headers, the body, the status and the response body of one operation, by `operationId`. It enforces what a
 * description of the code cannot state, such as a conditional requirement or an object closed to unknown
 * properties, because it reads the contract and not the code's account of it.
 *
 * It compiles lazily, one operation at a time, and `prepare` compiles an operation at once so that a schema
 * that cannot be compiled fails at startup and not at the first request.
 */
export class ContractValidator {
  private readonly strictAjv: Ajv2020;
  private readonly coercingAjv: Ajv2020;
  private readonly operations = new Map<string, JsonObject>();
  private readonly pathItems = new Map<string, JsonObject>();
  private readonly prepared = new Map<string, Prepared>();
  private readonly pointers: PointerOwnership;

  constructor(private readonly contract: JsonObject) {
    this.pointers = new PointerOwnership(contract);
    const options = { strict: false, allErrors: true, logger: false } as const;
    // Bodies are checked exactly as sent. Path, query and header values are always text on the wire, and
    // the contract types them, so those are read as the type the contract gives.
    const { Ajv2020: Ajv, addFormats } = loadAjv();
    this.strictAjv = new Ajv(options);
    this.coercingAjv = new Ajv({ ...options, coerceTypes: 'array' });
    for (const ajv of [this.strictAjv, this.coercingAjv]) {
      addFormats(ajv);
      // ajv-formats' own `uuid` allows a `urn:uuid:` prefix. That text is valid here, refused by the database
      // (22P02, a server error and an alert) and a second way to write one identifier.
      ajv.addFormat('uuid', UUID_TEXT);
      ajv.addSchema({ $id: CONTRACT_ID, components: contract.components ?? {} }, CONTRACT_ID);
    }

    for (const item of Object.values(objectAt(contract.paths, 'paths'))) {
      if (!isJsonObject(item)) continue;
      for (const method of ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']) {
        const operation = item[method];
        if (!isJsonObject(operation) || typeof operation.operationId !== 'string') continue;
        if (this.operations.has(operation.operationId)) {
          throw new Error(
            `The operation id ${operation.operationId} is used by more than one operation.`,
          );
        }
        this.operations.set(operation.operationId, operation);
        this.pathItems.set(operation.operationId, item);
      }
    }
  }

  hasOperation(operationId: string): boolean {
    return this.operations.has(operationId);
  }

  /** Compiles everything the operation needs now. Throws if the contract has no such operation, or a schema will not compile. */
  prepare(operationId: string): void {
    this.preparedFor(operationId);
  }

  validateRequest(operationId: string, request: RequestParts): ContractViolation[] {
    const prepared = this.preparedFor(operationId);
    const violations: ContractViolation[] = [];

    // A parameter's violation is named by the parameter (`idempotency-key`), without the path inside its value.
    const named = (pointer: string): string => pointer.split('/')[1] ?? '';
    const sentHeaders = Object.fromEntries(
      Object.entries(request.headers).filter(([, value]) => value !== undefined),
    );
    // What was sent, and a copy of it that Ajv reads as the type the contract gives and so changes.
    const checks: [ParameterLocation, Record<string, unknown>, Record<string, unknown>][] = [
      ['path', { ...request.params }, structuredClone({ ...request.params })],
      ['query', { ...request.query }, structuredClone({ ...request.query })],
      ['header', sentHeaders, structuredClone(sentHeaders)],
      // Only the cookies the operation declares are looked at. That one is present and well formed says
      // nothing about whether it is a valid session: that is for the guard.
      [
        'cookie',
        Object.fromEntries(parseCookieHeader(request.headers.cookie)),
        Object.fromEntries(parseCookieHeader(request.headers.cookie)),
      ],
    ];
    for (const [location, sent, read] of checks) {
      const compiled = prepared.parameters[location];
      if (compiled === undefined) continue;
      if (!compiled.validate(read)) {
        violations.push(
          ...violationsOf(
            location,
            compiled.validate.errors,
            (path) => this.pointers.pointer(compiled.schema, path),
            named,
          ),
        );
        continue;
      }
      // Valid as read. It must also be the text of what it was read as: see readAsOther. The name is the
      // contract's, because only a parameter the contract declares has a type to be read as.
      for (const name of namesReadAsOther(sent, read)) {
        violations.push({ in: location, pointer: name, rule: 'type' });
      }
    }

    if (prepared.body !== undefined) {
      const { validate, schema } = prepared.body;
      if (!request.hasBody) {
        if (prepared.body.required) violations.push({ in: 'body', pointer: '', rule: 'required' });
      } else if (!validate(request.body)) {
        violations.push(
          ...violationsOf('body', validate.errors, (path) => this.pointers.pointer(schema, path)),
        );
      }
    }
    return violations.slice(0, MAX_VIOLATIONS);
  }

  /**
   * Checks the response an operation gave. `request` is the request it answers: it is needed only by a response
   * whose cookies depend on how the caller authenticated (`x-set-cookies-for`), and such a response cannot be
   * judged without it, so asking without it fails rather than skipping the rule.
   */
  validateResponse(
    operationId: string,
    response: ResponseParts,
    request?: Pick<RequestParts, 'headers'>,
  ): ContractViolation[] {
    const prepared = this.preparedFor(operationId);
    // The exact status first, then its range (`2XX`, `4XX`), then the catch-all.
    const declared =
      prepared.responses.get(String(response.status)) ??
      prepared.responses.get(`${String(Math.trunc(response.status / 100))}XX`) ??
      prepared.responses.get('default');
    if (declared === undefined) {
      return [{ in: 'status', pointer: String(response.status), rule: 'undeclared' }];
    }

    const violations: ContractViolation[] = [];
    for (const header of declared.requiredHeaders) {
      if (response.headers[header] === undefined) {
        violations.push({ in: 'response-header', pointer: header, rule: 'required' });
      }
    }
    // A header that is there must also be what its schema says. Header values are text on the wire (and Node
    // may hand back a number), so they are read as the type the contract gives them.
    for (const [name, { validate }] of declared.headerValues) {
      const value: unknown = response.headers[name];
      if (value === undefined) continue;
      const single = Array.isArray(value) && value.length === 1 ? (value[0] as unknown) : value;
      if (!validate(single)) {
        violations.push(
          ...violationsOf(
            'response-header',
            validate.errors,
            () => '',
            () => name,
          ),
        );
      }
    }
    violations.push(
      ...this.cookieViolations(
        this.cookiesOwed(operationId, declared, request),
        response.headers['set-cookie'],
      ),
    );

    if (declared.body !== undefined) {
      const { validate, schema } = declared.body;
      if (response.body === undefined) {
        violations.push({ in: 'response-body', pointer: '', rule: 'required' });
      } else if (!validate(response.body)) {
        violations.push(
          ...violationsOf('response-body', validate.errors, (path) =>
            this.pointers.pointer(schema, path),
          ),
        );
      }
    } else if (!declared.declaresContent && response.body !== undefined && response.body !== null) {
      violations.push({ in: 'response-body', pointer: '', rule: 'unexpected' });
    }
    return violations.slice(0, MAX_VIOLATIONS);
  }

  /**
   * The cookies this answer owes: all the ones the response declares, unless it declares them for one credential
   * and the request did not present that one, and then none. A request that presented both credentials is judged
   * as one that presented the declared one, because a cookie it still holds is the one to deal with.
   */
  private cookiesOwed(
    operationId: string,
    declared: PreparedResponse,
    request: Pick<RequestParts, 'headers'> | undefined,
  ): ReadonlyMap<string, ExpectedCookie> {
    if (declared.cookiesFor === undefined) return declared.cookies;
    if (request === undefined) {
      throw new Error(
        `The cookies ${operationId} sets depend on the credential the request presented (x-set-cookies-for ${declared.cookiesFor.scheme}), so its response cannot be validated without the request.`,
      );
    }
    return declared.cookiesFor.presented(request.headers) ? declared.cookies : new Map();
  }

  /**
   * The cookies a response set against the ones it declares: each declared cookie is set and carries the
   * attributes `x-cookies` promises, and no other cookie is set. A cookie the contract names is reported by
   * name; any other as `*`. Values are never read into a violation.
   */
  private cookieViolations(
    declared: ReadonlyMap<string, ExpectedCookie>,
    header: unknown,
  ): ContractViolation[] {
    const known = isJsonObject(this.contract['x-cookies']) ? this.contract['x-cookies'] : {};
    const violations: ContractViolation[] = [];
    const set = parseSetCookies(header);

    for (const name of declared.keys()) {
      if (!set.some((cookie) => cookie.name === name)) {
        violations.push({ in: 'response-cookie', pointer: name, rule: 'required' });
      }
    }
    for (const cookie of set) {
      const expected = declared.get(cookie.name);
      if (expected === undefined) {
        const pointer = Object.hasOwn(known, cookie.name) ? cookie.name : '*';
        violations.push({ in: 'response-cookie', pointer, rule: 'undeclared' });
        continue;
      }
      for (const rule of brokenAttributes(cookie, expected)) {
        violations.push({ in: 'response-cookie', pointer: cookie.name, rule });
      }
    }

    const seen = new Set<string>();
    return violations
      .filter((violation) => {
        const key = `${violation.pointer}\u0000${violation.rule}`;
        return seen.has(key) ? false : (seen.add(key), true);
      })
      .toSorted((a, b) => a.pointer.localeCompare(b.pointer) || a.rule.localeCompare(b.rule));
  }

  /**
   * The credential a response's cookies are set for (`x-set-cookies-for`), read as the security scheme it names.
   * A condition that names nothing the contract defines, or that has no cookies to apply to, or whose scheme
   * cannot be recognised in a request, cannot be checked, so preparing fails.
   */
  private cookiesFor(
    operationId: string,
    status: string,
    response: JsonObject,
    cookieCount: number,
  ): PreparedResponse['cookiesFor'] {
    const scheme = response['x-set-cookies-for'];
    if (scheme === undefined) return undefined;
    const where = `x-set-cookies-for of response ${status} of ${operationId}`;
    if (typeof scheme !== 'string') {
      throw new Error(`The contract's ${where} must name one security scheme.`);
    }
    if (cookieCount === 0) {
      throw new Error(`The contract's ${where} applies to no cookies: x-set-cookies lists none.`);
    }
    const components = isJsonObject(this.contract.components) ? this.contract.components : {};
    const schemes = isJsonObject(components.securitySchemes) ? components.securitySchemes : {};
    if (!Object.hasOwn(schemes, scheme)) {
      throw new Error(
        `The contract's ${where} names ${scheme}, which securitySchemes does not define.`,
      );
    }
    try {
      return { scheme, presented: credentialCheck(scheme, this.resolve(schemes[scheme], where)) };
    } catch (error) {
      throw new Error(
        `The contract's ${where}: ${error instanceof Error ? error.message : 'cannot be read'}`,
        {
          cause: error,
        },
      );
    }
  }

  private resolve(value: Json | undefined, what: string): JsonObject {
    let current = value;
    for (let hops = 0; isJsonObject(current) && typeof current.$ref === 'string'; hops += 1) {
      if (hops > 20) throw new Error(`The contract's ${what}: references loop.`);
      let node: Json | undefined = this.contract;
      for (const segment of current.$ref.replace(/^#\//, '').split('/').map(decodeSegment)) {
        node = isJsonObject(node) ? node[segment] : undefined;
      }
      current = node;
    }
    return objectAt(current, what);
  }

  private compile(ajv: Ajv2020, schema: Json): Compiled {
    return { validate: ajv.compile(anchorReferences(schema) as object), schema };
  }

  private preparedFor(operationId: string): Prepared {
    const cached = this.prepared.get(operationId);
    if (cached !== undefined) return cached;
    const operation = this.operations.get(operationId);
    const item = this.pathItems.get(operationId);
    if (operation === undefined || item === undefined) {
      throw new Error(`The contract has no operation ${operationId}.`);
    }

    const properties: Record<ParameterLocation, Record<string, Json>> = {
      path: {},
      query: {},
      header: {},
      cookie: {},
    };
    const required: Record<ParameterLocation, string[]> = {
      path: [],
      query: [],
      header: [],
      cookie: [],
    };
    for (const list of [item.parameters, operation.parameters]) {
      if (!Array.isArray(list)) continue;
      for (const entry of list as Json[]) {
        const parameter = this.resolve(entry, `parameter of ${operationId}`);
        const location = parameter.in;
        const name = parameter.name;
        if (
          (location !== 'path' &&
            location !== 'query' &&
            location !== 'header' &&
            location !== 'cookie') ||
          typeof name !== 'string'
        ) {
          continue;
        }
        const key = location === 'header' ? name.toLowerCase() : name;
        properties[location][key] = parameter.schema ?? {};
        const list = required[location].filter((existing) => existing !== key);
        required[location] =
          location === 'path' || parameter.required === true ? [...list, key] : list;
      }
    }
    const parameters: Prepared['parameters'] = {};
    for (const location of ['path', 'query', 'header', 'cookie'] as const) {
      if (Object.keys(properties[location]).length === 0) continue;
      parameters[location] = this.compile(this.coercingAjv, {
        type: 'object',
        properties: properties[location],
        required: required[location],
      });
    }

    let body: Prepared['body'];
    if (operation.requestBody !== undefined) {
      const requestBody = this.resolve(operation.requestBody, `request body of ${operationId}`);
      const json = isJsonObject(requestBody.content)
        ? requestBody.content['application/json']
        : undefined;
      if (isJsonObject(json)) {
        body = {
          required: requestBody.required === true,
          ...this.compile(this.strictAjv, json.schema ?? {}),
        };
      }
    }

    const responses = new Map<string, PreparedResponse>();
    for (const [status, raw] of Object.entries(
      objectAt(operation.responses, `responses of ${operationId}`),
    )) {
      const response = this.resolve(raw, `response ${status} of ${operationId}`);
      const content = isJsonObject(response.content) ? response.content : undefined;
      const json = content?.['application/json'];
      const headers = isJsonObject(response.headers)
        ? Object.entries(response.headers).map(
            ([name, header]) =>
              [name.toLowerCase(), this.resolve(header, `header of ${operationId}`)] as const,
          )
        : [];
      const requiredHeaders = headers
        .filter(([, header]) => header.required === true)
        .map(([name]) => name);
      const headerValues = new Map(
        headers
          .filter(([name, header]) => name !== 'set-cookie' && header.schema !== undefined)
          .map(
            ([name, header]) =>
              [name, this.compile(this.coercingAjv, header.schema ?? {})] as const,
          ),
      );

      // The cookies the response sets are named by `x-set-cookies` and defined once, at the root, by
      // `x-cookies`. A name the root does not define cannot be checked, so preparing fails.
      const setCookies = response['x-set-cookies'];
      const definitions = isJsonObject(this.contract['x-cookies'])
        ? this.contract['x-cookies']
        : {};
      const cookies = new Map(
        (Array.isArray(setCookies) ? (setCookies as Json[]) : []).map((name) => {
          if (typeof name !== 'string') {
            throw new Error(
              `The contract's x-set-cookies of ${operationId} must list cookie names.`,
            );
          }
          return [name, expectedCookie(name, definitions[name])] as const;
        }),
      );

      responses.set(status, {
        body: isJsonObject(json) ? this.compile(this.strictAjv, json.schema ?? {}) : undefined,
        declaresContent: content !== undefined && Object.keys(content).length > 0,
        requiredHeaders,
        headerValues,
        cookies,
        cookiesFor: this.cookiesFor(operationId, status, response, cookies.size),
      });
    }

    const prepared: Prepared = { parameters, body, responses };
    this.prepared.set(operationId, prepared);
    return prepared;
  }
}
