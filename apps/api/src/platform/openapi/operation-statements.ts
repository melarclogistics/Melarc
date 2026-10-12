import 'reflect-metadata';

import { ModulesContainer } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { DECORATORS, type OpenAPIObject } from '@nestjs/swagger';

import { COOKIES } from '../auth/cookies/cookie-writer.js';
import { API_PREFIX } from '../http/routes.constants.js';

/**
 * What the application's own description says about an operation that a decorated class cannot say (the bootstrap's carried-
 * forward notes; S0.21): which credentials it takes, with the rule that two of them must both hold; the cookies a response sets or
 * expires; and the hosts it is reachable at. `@nestjs/swagger` states alternatives and not conjunctions, has no response-level
 * extension and no `servers`, so a handler states them here and `applyOperationStatements` puts them into the description after
 * the framework has made it.
 *
 * **This is the implementation's own account, never a copy of the contract.** Nothing here reads `contracts/openapi.yaml`: the
 * schemes, the default posture and the servers are written in code, and the conformance check compares them with the contract
 * (`tools/contract`), so a drift of either side is a finding. That is what makes the comparison evidence and not a tautology.
 */

export type SchemeName = 'browserSession' | 'csrfToken' | 'vendorDevice' | 'riderSession';

/**
 * The four security schemes of the contract and the facts the comparison reads of each (type, where it is carried, its name).
 * Prose is for the reader and is not compared. The Rider scheme carries no `bearerFormat`: the contract says the value is opaque
 * and not a JWT, and the framework's own bearer helper would add one.
 */
export const SECURITY_SCHEMES = {
  browserSession: {
    type: 'apiKey',
    in: 'cookie',
    name: COOKIES.session,
    description:
      'An opaque server-side session in an HttpOnly, Secure, SameSite=Lax cookie. Ops Portal and Vendor PWA.',
  },
  csrfToken: {
    type: 'apiKey',
    in: 'header',
    name: 'X-CSRF-Token',
    description:
      'The synchronizer half of a cookie-authenticated browser request, composed with browserSession.',
  },
  vendorDevice: {
    type: 'apiKey',
    in: 'cookie',
    name: COOKIES.vendorDevice,
    description:
      'Pre-session proof that this browser is the vendor’s registered one. Not a session.',
  },
  riderSession: {
    type: 'http',
    scheme: 'bearer',
    description:
      'The same opaque session as browserSession, as a Bearer credential. Melarc Rider only.',
  },
} as const satisfies Readonly<Record<SchemeName, object>>;

/**
 * An operation that states no security inherits this: a browser session with its CSRF token, both required, or a rider session.
 * It is the platform's deny-by-default posture in the description: an operation is authenticated unless it says, with an explicit
 * empty requirement, that it is not (`AC-SLICE-000-43`).
 */
export const DEFAULT_SECURITY: readonly (readonly SchemeName[])[] = [
  ['browserSession', 'csrfToken'],
  ['riderSession'],
];

export interface DescribedServer {
  readonly url: string;
  readonly description: string;
}

/** The server every operation inherits: relative, so a browser surface resolves it against its own origin and its host-only cookies are sent. */
export const SAME_ORIGIN_SERVER: DescribedServer = {
  url: `/${API_PREFIX}`,
  description: 'Same-origin. The default for any browser-delivered surface.',
};

/**
 * The hosts of an operation the Melarc Rider native client calls: the same-origin default and a dedicated, bearer-authenticated,
 * non-browser host. The host name is the contract's placeholder (`api.melarc.example`); a deployment substitutes its own at the
 * edge. A browser would not attach the host-only session cookie to that host, which is why it is safe for the native app and not
 * for Ops or Vendor.
 */
export const RIDER_SERVERS: readonly DescribedServer[] = [
  SAME_ORIGIN_SERVER,
  {
    url: 'https://api.melarc.example/v1',
    description:
      'Dedicated non-browser host for the Rider native client. Bearer-authenticated, never cookie-authenticated.',
  },
];

interface CookieStatement {
  readonly status: number;
  readonly cookies: readonly string[];
  /** `x-set-cookies-for`: the scheme whose credential a request must have presented to be owed these cookies. */
  readonly for?: SchemeName;
  /** `x-set-cookies-when`: the type of principal whose answer is owed them. */
  readonly when?: { readonly principalType: 'STAFF' | 'VENDOR' | 'RIDER' };
}

interface Statements {
  readonly security?: readonly (readonly SchemeName[])[];
  readonly cookies?: readonly CookieStatement[];
  readonly servers?: readonly DescribedServer[];
}

/** Metadata key under which a handler keeps what it states about its operation. */
const STATEMENTS_KEY = 'melarc:operation-statements';

const SCHEME_NAMES = Object.keys(SECURITY_SCHEMES);
const COOKIE_NAMES: readonly string[] = Object.values(COOKIES);

function state(update: (current: Statements) => Statements): MethodDecorator {
  return (_target, _key, descriptor) => {
    const handler = descriptor.value as object;
    const current = (Reflect.getMetadata(STATEMENTS_KEY, handler) ?? {}) as Statements;
    Reflect.defineMetadata(STATEMENTS_KEY, update(current), handler);
  };
}

/**
 * States the credentials an operation takes: each argument is one alternative (any one may be presented), and the schemes
 * inside it must **all** hold. `DescribeSecurity(['browserSession', 'csrfToken'], ['riderSession'])` is "a browser session with
 * its CSRF token, or a rider session". **No argument states that the operation is anonymous** (`security: []`), which is not
 * the same as stating nothing: an operation that states nothing inherits the default posture above.
 */
export function DescribeSecurity(
  ...alternatives: readonly (readonly SchemeName[])[]
): MethodDecorator {
  for (const alternative of alternatives) {
    if (alternative.length === 0) {
      throw new TypeError(
        'A security requirement that names no scheme describes nothing; state none as no argument',
      );
    }
    for (const scheme of alternative) {
      if (!SCHEME_NAMES.includes(scheme)) {
        throw new TypeError(`${scheme} is not a security scheme of the contract`);
      }
    }
  }
  return state((current) => ({ ...current, security: alternatives }));
}

/**
 * States the credentials of an operation **only if nothing has stated them yet**. A declaration that implies a posture (an
 * anonymous operation is `security: []`) uses this, so that an operation which names its own (`vendorSignIn` takes the registered
 * browser's cookie alone) says so with `DescribeSecurity` in either order and is not overwritten.
 */
export function DescribeSecurityByDefault(
  ...alternatives: readonly (readonly SchemeName[])[]
): MethodDecorator {
  const decorator = DescribeSecurity(...alternatives);
  return (target, key, descriptor) => {
    const handler = descriptor.value as object;
    const current = (Reflect.getMetadata(STATEMENTS_KEY, handler) ?? {}) as Statements;
    if (current.security !== undefined) return;
    decorator(target, key, descriptor);
  };
}

/**
 * States the cookies a response sets or expires (`x-set-cookies`), optionally limited to a request that presented a scheme
 * (`for`) or to an answer for a type of principal (`when`). The response must be one the handler describes; a statement about a
 * response the description lacks is refused when the description is built.
 */
export function DescribeCookies(
  status: number,
  cookies: readonly string[],
  limits: { readonly for?: SchemeName; readonly when?: CookieStatement['when'] } = {},
): MethodDecorator {
  for (const cookie of cookies) {
    if (!COOKIE_NAMES.includes(cookie))
      throw new TypeError(`${cookie} is not a cookie of the identity slice`);
  }
  if (limits.for !== undefined && !SCHEME_NAMES.includes(limits.for)) {
    throw new TypeError(`${limits.for} is not a security scheme of the contract`);
  }
  return state((current) => ({
    ...current,
    cookies: [...(current.cookies ?? []), { status, cookies, ...limits }],
  }));
}

/** States the hosts an operation is reachable at, where they are not the document's own (the Rider operations: `RIDER_SERVERS`). */
export function DescribeServers(servers: readonly DescribedServer[]): MethodDecorator {
  return state((current) => ({ ...current, servers }));
}

/** How a request presents its session credential: the cookie of a browser session, or the bearer credential of a Rider's. */
export type CredentialMode = 'COOKIE' | 'BEARER';

/**
 * The credential modes an operation accepts, read from the **same statement** the description makes of it (S0.25): an alternative
 * that names `browserSession` takes the cookie and one that names `riderSession` takes the bearer credential, and an operation
 * that states nothing inherits the default posture, which takes both. One source for the description and the guard means a route
 * cannot be described as Rider-only and still accept a browser cookie, and the conformance check that compares the description
 * with the contract compares this too.
 *
 * It is not the question "is this a browser operation": a request is never judged native by a header it sends (a `User-Agent`, a
 * client-type string). The mode is how the credential arrived, which authentication has already decided from the request itself.
 */
export function credentialModesOf(handler: object): ReadonlySet<CredentialMode> {
  const statements = Reflect.getMetadata(STATEMENTS_KEY, handler) as Statements | undefined;
  const modes = new Set<CredentialMode>();
  for (const alternative of statements?.security ?? DEFAULT_SECURITY) {
    if (alternative.includes('browserSession')) modes.add('COOKIE');
    if (alternative.includes('riderSession')) modes.add('BEARER');
  }
  return modes;
}

function requirementOf(alternative: readonly SchemeName[]): Record<string, string[]> {
  return Object.fromEntries(alternative.map((scheme) => [scheme, [] as string[]]));
}

interface Handler {
  readonly where: string;
  readonly operationId: string | undefined;
  readonly statements: Statements;
}

/** Every handler of the application that states something, with the operation it is bound to if it is bound to one. */
function statingHandlers(modules: ModulesContainer): Handler[] {
  const found: Handler[] = [];
  for (const moduleRef of modules.values()) {
    for (const wrapper of moduleRef.controllers.values()) {
      const controller = wrapper.metatype;
      if (typeof controller !== 'function') continue;
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const statements = Reflect.getMetadata(STATEMENTS_KEY, handler) as Statements | undefined;
        if (statements === undefined) continue;
        found.push({
          where: `${controller.name}.${name}`,
          operationId: (
            Reflect.getMetadata(DECORATORS.API_OPERATION, handler) as
              { readonly operationId?: string } | undefined
          )?.operationId,
          statements,
        });
      }
    }
  }
  return found;
}

/** The operations of a description by `operationId`. */
function operationsOf(document: OpenAPIObject): Map<string, Record<string, unknown>> {
  const found = new Map<string, Record<string, unknown>>();
  for (const item of Object.values(document.paths)) {
    for (const operation of Object.values(item as Record<string, unknown>)) {
      if (typeof operation !== 'object' || operation === null) continue;
      const each = operation as Record<string, unknown>;
      if (typeof each.operationId === 'string') found.set(each.operationId, each);
    }
  }
  return found;
}

/**
 * Puts the application's own statements into its description, after the framework has made the description:
 * the scheme definitions and the default posture at the root, then each handler's credentials, response cookies and servers
 * onto the operation it is bound to.
 *
 * **A statement is never dropped silently.** One on a handler that has no `operationId` at all, and cookies stated for a response
 * the description lacks, are errors when the description is built: the description would otherwise say less than the code does,
 * and a conformance check that compared it would pass on silence. A handler the framework left out of the description on purpose
 * (`@ApiExcludeEndpoint`) has nowhere to put its statements; that is a route hidden from the description, which the conformance
 * check reports as the drift it is, so it is not an error here (an exception would hide the finding).
 */
export function applyOperationStatements(document: OpenAPIObject, app: INestApplication): void {
  document.components ??= {};
  document.components.securitySchemes = structuredClone(SECURITY_SCHEMES);
  document.security = DEFAULT_SECURITY.map(requirementOf);

  const operations = operationsOf(document);
  for (const { where, operationId, statements } of statingHandlers(
    app.get(ModulesContainer, { strict: false }),
  )) {
    if (operationId === undefined) {
      throw new Error(
        `${where} states how its operation is described but is not bound to an operation (@ContractOperation)`,
      );
    }
    const operation = operations.get(operationId);
    if (operation === undefined) continue;
    if (statements.security !== undefined)
      operation.security = statements.security.map(requirementOf);
    if (statements.servers !== undefined) {
      operation.servers = statements.servers.map((server) => ({
        url: server.url,
        description: server.description,
      }));
    }
    for (const statement of statements.cookies ?? []) {
      const responses = (operation.responses ?? {}) as Record<string, Record<string, unknown>>;
      const response = responses[String(statement.status)];
      if (response === undefined) {
        throw new Error(
          `${where} states the cookies of the ${String(statement.status)} response of ${operationId}, which it does not describe`,
        );
      }
      response['x-set-cookies'] = [...statement.cookies];
      if (statement.for !== undefined) response['x-set-cookies-for'] = statement.for;
      if (statement.when !== undefined) {
        response['x-set-cookies-when'] = { principal_type: statement.when.principalType };
      }
    }
  }
}
