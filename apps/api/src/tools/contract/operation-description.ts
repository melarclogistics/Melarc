import {
  canonicalize,
  isJsonObject,
  sortedUnique,
  type Json,
  type JsonObject,
} from '../../platform/contract/json.js';
import { ContractModelError, type DocumentModel, type NormSchema } from './schema-normalizer.js';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/**
 * How a parameter's value is written into the request, with every default OpenAPI gives filled in, so that a
 * document that says its defaults and one that leaves them out are the same. A parameter described by `content`
 * is written as that media type and has no style.
 */
export interface Serialization {
  readonly style?: string;
  readonly explode?: boolean;
  readonly allowReserved?: boolean;
  readonly allowEmptyValue?: boolean;
  readonly content?: string;
}

export interface ParameterDescription {
  /** As written in the document; the key it is filed under is case-folded for headers. */
  readonly name: string;
  readonly in: string;
  readonly required: boolean;
  readonly schema: NormSchema;
  readonly serialization: Serialization;
  readonly deprecated: boolean;
}

export interface BodyDescription {
  readonly required: boolean;
  /** By media type, lower-cased and without parameters such as a charset. */
  readonly content: Readonly<Record<string, NormSchema>>;
}

export interface HeaderDescription {
  readonly name: string;
  readonly required: boolean;
  readonly schema: NormSchema;
}

export interface ResponseDescription {
  readonly content: Readonly<Record<string, NormSchema>>;
  /** By lower-cased header name. */
  readonly headers: Readonly<Record<string, HeaderDescription>>;
  /** The cookies the response sets or expires (`x-set-cookies`), sorted. */
  readonly setCookies: readonly string[];
  /**
   * The security scheme whose credential a request must have presented to be owed those cookies
   * (`x-set-cookies-for`), or undefined when every caller is.
   */
  readonly setCookiesFor: string | undefined;
  /**
   * The type of principal whose answer is owed those cookies (`x-set-cookies-when: { principal_type }`), or undefined
   * when an answer for any principal is. Both conditions hold when both are stated.
   */
  readonly setCookiesWhen: string | undefined;
}

export interface SecurityDescription {
  /** Each alternative is the sorted names of the schemes that must all be satisfied, with any scopes. */
  readonly alternatives: readonly (readonly string[])[];
  /** The definition of each scheme the alternatives name. */
  readonly schemes: Readonly<Record<string, Json>>;
}

export interface OperationDescription {
  readonly operationId: string | undefined;
  readonly method: string;
  readonly path: string;
  /** By `in:name`, with header names lower-cased. */
  readonly parameters: Readonly<Record<string, ParameterDescription>>;
  readonly requestBody: BodyDescription | undefined;
  /** By status code (or `default`). */
  readonly responses: Readonly<Record<string, ResponseDescription>>;
  readonly security: SecurityDescription;
  /** `x-permission`. */
  readonly permission: string | undefined;
  /** `x-error-codes`, sorted. */
  readonly errorCodes: readonly string[];
  readonly deprecated: boolean;
  /**
   * The servers the operation (or its path) names for itself, by url and variables, sorted, or undefined when it
   * inherits the document's. The eight Rider operations name their dedicated host this way.
   */
  readonly servers: readonly Json[] | undefined;
  /**
   * Every statement the description does not read, by where it sits (`response 200 > links`), with references
   * resolved. The comparison reports one that only a side states, or that differs, so that nothing the contract
   * says is dropped because this module has no field for it.
   */
  readonly unmodelled: Readonly<Record<string, Json>>;
}

/** Records the statements of `object` that the description neither reads nor ignores on purpose. */
type Collect = (
  where: string,
  object: JsonObject,
  read: readonly string[],
  ignored?: readonly string[],
) => void;

const PROSE = ['description', 'example', 'examples'] as const;

function objectOf(value: Json | undefined, what: string): JsonObject {
  if (!isJsonObject(value)) throw new ContractModelError(`${what} must be an object.`);
  return value;
}

/** Follows `$ref` until what it points to is not itself a reference. */
function dereference(model: DocumentModel, value: Json | undefined, what: string): JsonObject {
  let current = value;
  for (let hops = 0; isJsonObject(current) && typeof current.$ref === 'string'; hops += 1) {
    if (hops > 20) throw new ContractModelError(`${what}: references loop.`);
    current = model.resolve(current.$ref);
  }
  return objectOf(current, what);
}

function operationsOf(
  document: JsonObject,
): { path: string; method: string; operation: JsonObject }[] {
  const found: { path: string; method: string; operation: JsonObject }[] = [];
  for (const [path, item] of Object.entries(objectOf(document.paths, 'paths'))) {
    if (!isJsonObject(item)) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (isJsonObject(operation)) found.push({ path, method: method.toUpperCase(), operation });
    }
  }
  return found;
}

/** Every operation of a document, where it is and the id it declares, if any. */
export function listOperations(
  document: JsonObject,
): { id: string | undefined; method: string; path: string }[] {
  return operationsOf(document).map(({ path, method, operation }) => ({
    id: typeof operation.operationId === 'string' ? operation.operationId : undefined,
    method,
    path,
  }));
}

export function listOperationIds(document: JsonObject): string[] {
  return operationsOf(document)
    .map(({ operation }) => operation.operationId)
    .filter((id): id is string => typeof id === 'string');
}

/** Where an operation sits, by its id. An id used twice is an error: "the operation" would be ambiguous. */
export function findOperation(
  document: JsonObject,
  operationId: string,
): { path: string; method: string } | undefined {
  const matches = operationsOf(document).filter(
    ({ operation }) => operation.operationId === operationId,
  );
  if (matches.length > 1) {
    throw new ContractModelError(
      `The operation id ${operationId} is used by more than one operation.`,
    );
  }
  const [match] = matches;
  return match === undefined ? undefined : { path: match.path, method: match.method };
}

function mediaType(raw: string): string {
  return (raw.split(';')[0] ?? raw).trim().toLowerCase();
}

/** `content` of a body, a response or a parameter: each media type's schema, and any statement beside it. */
function describeContent(
  model: DocumentModel,
  content: Json | undefined,
  where: string,
  collect: Collect,
): Record<string, NormSchema> {
  if (!isJsonObject(content)) return {};
  return Object.fromEntries(
    Object.keys(content)
      .toSorted()
      .map((raw) => {
        const media = objectOf(content[raw], `media type ${raw}`);
        collect(`${where} > ${mediaType(raw)}`, media, ['schema'], PROSE);
        return [mediaType(raw), model.normalize(media.schema ?? {})];
      }),
  );
}

const DEFAULT_STYLE: Readonly<Record<string, string>> = {
  query: 'form',
  cookie: 'form',
  path: 'simple',
  header: 'simple',
};

/**
 * What goes on the wire: the style, `explode` (true by default for `form` and false for every other style),
 * and the two query flags, or the media type of a parameter described by `content`.
 */
function describeSerialization(parameter: JsonObject, location: string): Serialization {
  if (isJsonObject(parameter.content)) {
    const [first] = Object.keys(parameter.content);
    if (first !== undefined) return { content: mediaType(first) };
  }
  const style = typeof parameter.style === 'string' ? parameter.style : DEFAULT_STYLE[location];
  return {
    ...(style === undefined ? {} : { style }),
    explode: typeof parameter.explode === 'boolean' ? parameter.explode : style === 'form',
    allowReserved: parameter.allowReserved === true,
    allowEmptyValue: parameter.allowEmptyValue === true,
  };
}

function describeParameters(
  model: DocumentModel,
  lists: readonly (Json | undefined)[],
  collect: Collect,
): Record<string, ParameterDescription> {
  // A parameter the operation states replaces one of the same name and location on its path item, so the one
  // that counts is the last, and only that one is described.
  const counted = new Map<string, { name: string; location: string; parameter: JsonObject }>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list as Json[]) {
      const parameter = dereference(model, entry, 'a parameter');
      const name = parameter.name;
      const location = parameter.in;
      if (typeof name !== 'string' || typeof location !== 'string') {
        throw new ContractModelError('A parameter needs a name and a location.');
      }
      counted.set(`${location}:${location === 'header' ? name.toLowerCase() : name}`, {
        name,
        location,
        parameter,
      });
    }
  }

  const parameters: Record<string, ParameterDescription> = {};
  for (const [key, { name, location, parameter }] of counted) {
    const where = `parameter ${key}`;
    collect(
      where,
      parameter,
      [
        'name',
        'in',
        'required',
        'schema',
        'content',
        'style',
        'explode',
        'allowReserved',
        'allowEmptyValue',
        'deprecated',
      ],
      PROSE,
    );
    const byContent = describeContent(model, parameter.content, where, collect);
    parameters[key] = {
      name,
      in: location,
      // A path parameter is required by definition, whatever the document says.
      required: location === 'path' || parameter.required === true,
      // `byContent` is already normalized; normalizing it again would read its fields as unknown keywords.
      schema:
        parameter.schema !== undefined
          ? model.normalize(parameter.schema)
          : (Object.values(byContent).at(0) ?? model.normalize({})),
      serialization: describeSerialization(parameter, location),
      deprecated: parameter.deprecated === true,
    };
  }
  return parameters;
}

function describeResponse(
  model: DocumentModel,
  raw: Json | undefined,
  where: string,
  collect: Collect,
): ResponseDescription {
  const response = dereference(model, raw, 'a response');
  collect(where, response, ['content', 'headers'], ['description']);
  const headers: Record<string, HeaderDescription> = {};
  if (isJsonObject(response.headers)) {
    for (const name of Object.keys(response.headers).toSorted()) {
      const header = dereference(model, response.headers[name], `header ${name}`);
      collect(`${where} > header ${name}`, header, ['required', 'schema'], PROSE);
      headers[name.toLowerCase()] = {
        name,
        required: header.required === true,
        schema: model.normalize(header.schema ?? {}),
      };
    }
  }
  const cookies = response['x-set-cookies'];
  const cookiesFor = response['x-set-cookies-for'];
  const cookiesWhen = response['x-set-cookies-when'];
  return {
    content: describeContent(model, response.content, where, collect),
    headers,
    setCookies: Array.isArray(cookies) ? sortedUnique(cookies as string[]) : [],
    setCookiesFor: typeof cookiesFor === 'string' ? cookiesFor : undefined,
    setCookiesWhen:
      isJsonObject(cookiesWhen) && typeof cookiesWhen.principal_type === 'string'
        ? cookiesWhen.principal_type
        : undefined,
  };
}

/** A server by what a client builds a URL from: its url and its variables' defaults and allowed values. */
function describeServers(value: Json | undefined): Json[] | undefined {
  // An empty list says the same as no list: the document's servers apply.
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return sortedUnique(
    (value as Json[]).map((entry) => {
      const server = objectOf(entry, 'a server');
      if (typeof server.url !== 'string') throw new ContractModelError('A server needs a url.');
      const variables = isJsonObject(server.variables) ? server.variables : {};
      const described = Object.fromEntries(
        Object.keys(variables)
          .toSorted()
          .map((name) => {
            const variable = objectOf(variables[name], `server variable ${name}`);
            return [
              name,
              {
                default: variable.default ?? null,
                ...(Array.isArray(variable.enum)
                  ? { enum: sortedUnique(variable.enum as Json[]) }
                  : {}),
              },
            ];
          }),
      );
      return canonicalize({
        url: server.url,
        ...(Object.keys(described).length === 0 ? {} : { variables: described }),
      });
    }),
  );
}

const SCHEME_FACTS = [
  'type',
  'in',
  'name',
  'scheme',
  'bearerFormat',
  'flows',
  'openIdConnectUrl',
] as const;

function describeSecurity(
  model: DocumentModel,
  document: JsonObject,
  operation: JsonObject,
): SecurityDescription {
  const declared = operation.security ?? document.security ?? [];
  const alternatives = (Array.isArray(declared) ? (declared as Json[]) : []).map((alternative) =>
    Object.entries(objectOf(alternative, 'a security requirement'))
      .map(([name, scopes]) => {
        const list = Array.isArray(scopes) ? sortedUnique(scopes as string[]) : [];
        return list.length > 0 ? `${name}:${list.join(',')}` : name;
      })
      .toSorted(),
  );

  const definitions = isJsonObject(document.components)
    ? objectOf(document.components.securitySchemes ?? {}, 'securitySchemes')
    : {};
  const names = new Set(
    alternatives.flatMap((alternative) => alternative.map((n) => n.split(':')[0] ?? n)),
  );
  const schemes = Object.fromEntries(
    [...names].toSorted().map((name) => {
      const definition = definitions[name];
      if (definition === undefined) return [name, null];
      const resolved = dereference(model, definition, `security scheme ${name}`);
      return [
        name,
        canonicalize(
          Object.fromEntries(
            SCHEME_FACTS.filter((fact) => resolved[fact] !== undefined).map((fact) => [
              fact,
              resolved[fact] as Json,
            ]),
          ),
        ),
      ];
    }),
  );

  return {
    alternatives: alternatives.toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
    schemes,
  };
}

/**
 * One operation of a document reduced to what a client can observe or rely on: where it is, what it takes,
 * what it answers with, which credentials it needs and the extensions the contract uses to state its
 * permission and error codes. Written so that two documents that mean the same compare equal.
 */
export function describeOperation(
  model: DocumentModel,
  document: JsonObject,
  path: string,
  method: string,
): OperationDescription {
  const item = objectOf(objectOf(document.paths, 'paths')[path], `path ${path}`);
  const operation = objectOf(item[method.toLowerCase()], `${method} ${path}`);

  // Anything an object states that this description neither reads nor ignores on purpose (prose, examples and
  // `x-` extensions are ignored; the permission, error codes and cookies are read by name) is kept, resolved of
  // references, under the place it was found.
  const unmodelled: Record<string, Json> = {};
  const collect: Collect = (where, object, read, ignored = []) => {
    for (const key of Object.keys(object).toSorted()) {
      if (read.includes(key) || ignored.includes(key) || key.startsWith('x-')) continue;
      unmodelled[where === '' ? key : `${where} > ${key}`] = canonicalize(
        model.inlineReferences(object[key] as Json),
      );
    }
  };
  collect(
    '',
    operation,
    ['operationId', 'parameters', 'requestBody', 'responses', 'security', 'deprecated', 'servers'],
    ['summary', 'description', 'tags', 'externalDocs'],
  );

  const body = operation.requestBody;
  const requestBody =
    body === undefined
      ? undefined
      : (() => {
          const resolved = dereference(model, body, 'a request body');
          collect('request body', resolved, ['required', 'content'], ['description']);
          return {
            required: resolved.required === true,
            content: describeContent(model, resolved.content, 'request body', collect),
          };
        })();

  const responses = isJsonObject(operation.responses) ? operation.responses : {};
  const permission = operation['x-permission'];
  const errorCodes = operation['x-error-codes'];

  return {
    operationId: typeof operation.operationId === 'string' ? operation.operationId : undefined,
    method: method.toUpperCase(),
    path,
    parameters: describeParameters(model, [item.parameters, operation.parameters], collect),
    requestBody,
    responses: Object.fromEntries(
      Object.keys(responses)
        .toSorted()
        .map((status) => [
          status,
          describeResponse(model, responses[status], `response ${status}`, collect),
        ]),
    ),
    security: describeSecurity(model, document, operation),
    permission: typeof permission === 'string' ? permission : undefined,
    errorCodes: Array.isArray(errorCodes) ? sortedUnique(errorCodes as string[]) : [],
    deprecated: operation.deprecated === true,
    servers: describeServers(operation.servers ?? item.servers),
    unmodelled,
  };
}
