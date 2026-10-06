import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  API_BASE_PATH,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  createBrowserApiClient,
} from './browser/index.ts';

/**
 * What the browser transport does has to agree with what the retained contract says a browser must do.
 * Everything here is read straight from contracts/openapi.yaml, not from the generated file, so it is an
 * independent account of the contract: if the contract changes in a way that matters to a browser, a test
 * below names it, instead of the transport quietly drifting.
 */

type Alternative = Record<string, readonly string[]>;

interface ParameterObject {
  readonly $ref?: string;
  readonly name?: string;
  readonly in?: string;
}

interface OperationObject {
  readonly operationId: string;
  readonly security?: readonly Alternative[];
  readonly servers?: readonly { readonly url: string }[];
  readonly parameters?: readonly ParameterObject[];
}

interface Contract {
  readonly servers: readonly { readonly url: string }[];
  readonly security: readonly Alternative[];
  readonly 'x-cookies': Record<string, { readonly read_by_javascript: boolean }>;
  readonly paths: Record<string, Record<string, unknown>>;
  readonly components: {
    readonly securitySchemes: Record<
      string,
      {
        readonly type: string;
        readonly in?: string;
        readonly name?: string;
        readonly scheme?: string;
      }
    >;
    readonly parameters: Record<string, ParameterObject>;
  };
}

interface Operation {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly alternatives: readonly Alternative[];
  readonly servers: readonly { readonly url: string }[] | undefined;
  readonly parameterNames: readonly string[];
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
const UNSAFE_METHODS: ReadonlySet<string> = new Set(['post', 'put', 'patch', 'delete']);

const contract = parse(
  readFileSync(resolve(import.meta.dirname, '../../../contracts/openapi.yaml'), 'utf8'),
) as Contract;

function operationsOf(source: Contract): Operation[] {
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(source.paths)) {
    const shared = (item.parameters ?? []) as readonly ParameterObject[];
    for (const method of HTTP_METHODS) {
      const operation = item[method] as OperationObject | undefined;
      if (operation === undefined) continue;
      const parameters = [...shared, ...(operation.parameters ?? [])];
      operations.push({
        id: operation.operationId,
        method,
        path,
        // An operation's own `security` replaces the root default, including with an empty list.
        alternatives: operation.security ?? source.security,
        servers: operation.servers,
        parameterNames: parameters.map((parameter) =>
          parameter.$ref === undefined
            ? (parameter.name ?? '')
            : (source.components.parameters[parameter.$ref.split('/').pop() ?? '']?.name ?? ''),
        ),
      });
    }
  }
  return operations;
}

const operations = operationsOf(contract);

const BROWSER_SESSION = 'browserSession';
const CSRF = 'csrfToken';

/** The alternatives a browser satisfies with its session cookie, which is where CSRF protection applies. */
function browserAlternatives(operation: Operation): Alternative[] {
  return operation.alternatives.filter((alternative) => BROWSER_SESSION in alternative);
}

const TOKEN = 'tok_conformance_0123';

describe('the contract the transport is written against', () => {
  // Break caught: a contract with no operations, which would make every check below pass over nothing.
  it('has operations to check', () => {
    expect(operations.length).toBeGreaterThan(100);
    expect(new Set(operations.map((operation) => operation.id)).size).toBe(operations.length);
  });

  // Break caught: a new HTTP method or security scheme entering the contract unnoticed. The transport
  // knows POST/PUT/PATCH/DELETE as unsafe and the four schemes below; anything else needs a decision.
  it('uses only the methods and security schemes the transport knows', () => {
    expect(new Set(operations.map((operation) => operation.method))).toEqual(
      new Set(['get', 'post', 'put', 'patch', 'delete']),
    );
    expect(Object.keys(contract.components.securitySchemes).sort()).toEqual([
      'browserSession',
      'csrfToken',
      'riderSession',
      'vendorDevice',
    ]);
    const used = new Set(
      operations.flatMap((operation) =>
        operation.alternatives.flatMap((alternative) => Object.keys(alternative)),
      ),
    );
    expect([...used].sort()).toEqual([
      'browserSession',
      'csrfToken',
      'riderSession',
      'vendorDevice',
    ]);
  });
});

describe('where a browser may send requests', () => {
  // Break caught: the transport and the contract disagreeing on the base. The contract has one root
  // server, relative, so that a browser resolves it against its own origin and its host-only cookies go.
  it("has one root server, and it is the transport's base path", () => {
    expect(contract.servers.map((server) => server.url)).toEqual([API_BASE_PATH]);
  });

  // Break caught: an operation whose first listed server is the dedicated host, which a generated client
  // would take as its default. Eight Rider operations list two servers, and the same-origin one must come
  // first; the transport only ever uses that one.
  it('lists the same-origin server first on every operation that declares its own', () => {
    const withServers = operations.filter((operation) => operation.servers !== undefined);

    expect(withServers.length).toBeGreaterThan(0);
    for (const operation of withServers) {
      expect(operation.servers?.[0]?.url, operation.id).toBe(API_BASE_PATH);
    }
  });
});

describe('the credentials a browser holds', () => {
  const schemes = contract.components.securitySchemes;

  // Break caught: the transport echoing a cookie, or a header, that the contract names differently.
  it('are the cookie and header the transport reads and writes', () => {
    expect(schemes.csrfToken).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: CSRF_HEADER_NAME,
    });
    expect(Object.keys(contract['x-cookies'])).toContain(CSRF_COOKIE_NAME);
  });

  // Break caught: the transport reading the session cookie, or the CSRF cookie being made HttpOnly so that
  // it cannot be echoed. The pair has opposite readability on purpose (SECURITY_DESIGN.md 13.8).
  it('keep the session out of JavaScript and the CSRF token in it', () => {
    expect(schemes.browserSession).toMatchObject({
      type: 'apiKey',
      in: 'cookie',
      name: 'melarc_session',
    });
    expect(contract['x-cookies'].melarc_session?.read_by_javascript).toBe(false);
    expect(contract['x-cookies'][CSRF_COOKIE_NAME]?.read_by_javascript).toBe(true);
  });

  // Break caught: the Rider's Bearer credential becoming something a browser could be expected to send.
  it('keep Bearer for the Rider session alone', () => {
    expect(schemes.riderSession).toMatchObject({ type: 'http', scheme: 'bearer' });
  });
});

describe('CSRF in the contract', () => {
  // Break caught: a contract where the CSRF requirement is not a function of the method. The transport's
  // whole rule is "state-changing method, so echo the token", and this is the premise it rests on.
  it('is required of a cookie-authenticated request exactly when its method changes state', () => {
    for (const operation of operations) {
      for (const alternative of browserAlternatives(operation)) {
        expect(CSRF in alternative, `${operation.id} (${operation.method.toUpperCase()})`).toBe(
          UNSAFE_METHODS.has(operation.method),
        );
      }
    }
  });

  // Break caught: the token demanded of, or offered with, anything but a browser session. A Bearer client
  // sends none, and a request with no session has no token to send.
  it('is only ever composed with the browser session', () => {
    for (const operation of operations) {
      for (const alternative of operation.alternatives) {
        if (!(CSRF in alternative)) continue;
        expect(Object.keys(alternative).sort(), operation.id).toEqual([BROWSER_SESSION, CSRF]);
      }
    }
  });

  // Break caught: a state-changing operation that a browser can reach with a session cookie alone.
  // Every unsafe operation either requires the token alongside the cookie, or takes no session cookie.
  it('leaves no state-changing operation reachable with a session cookie alone', () => {
    const unprotected = operations
      .filter((operation) => UNSAFE_METHODS.has(operation.method))
      .filter((operation) =>
        browserAlternatives(operation).some((alternative) => !(CSRF in alternative)),
      )
      .map((operation) => operation.id);

    expect(unprotected).toEqual([]);
  });

  // Break caught: the token declared as a parameter of an operation, which would be optional in a
  // generated type and which callers would then have to supply by hand. It is a security scheme.
  it('is never a parameter, and neither is Authorization', () => {
    for (const operation of operations) {
      const names = operation.parameterNames.map((name) => name.toLowerCase());
      expect(names, operation.id).not.toContain(CSRF_HEADER_NAME.toLowerCase());
      expect(names, operation.id).not.toContain('authorization');
      expect(names, operation.id).not.toContain('cookie');
    }
  });

  // Break caught: an operation that a browser cannot call at all, because its only way in is the Rider's
  // Bearer session. The transport has no way to authenticate it, so it would need to refuse it by name.
  it('leaves no operation that only a Bearer session can satisfy', () => {
    const bearerOnly = operations
      .filter((operation) => operation.alternatives.length > 0)
      .filter((operation) =>
        operation.alternatives.every((alternative) => 'riderSession' in alternative),
      )
      .map((operation) => operation.id);

    expect(bearerOnly).toEqual([]);
  });
});

describe('the real transport, driven once for every operation in the contract', () => {
  /** Sends one request for the operation through the real client, and returns the header it carried. */
  async function csrfHeaderSentFor(operation: Operation, cookies: string): Promise<string | null> {
    let sent: Request | undefined;
    const client = createBrowserApiClient({
      origin: 'https://ops.melarc.test',
      readCookies: () => cookies,
      fetch: (request) => {
        sent = request;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    // The path is filled in by hand: this checks how a method is treated, not what a path looks like.
    const path = operation.path.replace(/\{[^}]+\}/g, 'x1');
    await client.request(operation.method as 'get', path as never);
    expect(sent, operation.id).toBeDefined();
    return sent?.headers.get(CSRF_HEADER_NAME) ?? null;
  }

  // Break caught: any operation whose browser request leaves without the token its contract requires, or
  // a safe read that carries one. This is the check that the transport matches the contract operation by
  // operation, not method by method.
  it('echoes the token where the contract requires it, and never on a read', async () => {
    const checked = { required: 0, notRequired: 0 };

    for (const operation of operations) {
      const alternatives = browserAlternatives(operation);
      if (alternatives.length === 0) continue;
      const header = await csrfHeaderSentFor(operation, `${CSRF_COOKIE_NAME}=${TOKEN}`);

      if (alternatives.every((alternative) => CSRF in alternative)) {
        expect(header, `${operation.id} must carry the token`).toBe(TOKEN);
        checked.required += 1;
      } else {
        expect(header, `${operation.id} must not carry the token`).toBeNull();
        checked.notRequired += 1;
      }
    }

    // Guard against an empty loop: the contract has both kinds, and each was exercised.
    expect(checked.required).toBeGreaterThan(100);
    expect(checked.notRequired).toBeGreaterThan(30);
  });

  // Break caught: a request with no session yet being blocked, or sent with a made-up token. Sign-in and
  // recovery are POSTs that have no cookie to echo; the transport sends them as they are.
  it('still sends every operation when there is no CSRF cookie, and with no token', async () => {
    for (const operation of operations) {
      expect(await csrfHeaderSentFor(operation, ''), operation.id).toBeNull();
    }
  });
});

describe('the answers the browser transport judges', () => {
  /** The media types of every success response of the contract, resolving a response that is a reference. */
  function successMediaTypes(): string[] {
    const responses =
      (contract as unknown as { components: { responses?: Record<string, unknown> } }).components
        .responses ?? {};
    const types: string[] = [];
    for (const item of Object.values(contract.paths)) {
      for (const method of HTTP_METHODS) {
        const operation = item[method] as { responses?: Record<string, unknown> } | undefined;
        for (const [status, declared] of Object.entries(operation?.responses ?? {})) {
          if (!status.startsWith('2')) continue;
          const reference = (declared as { $ref?: string }).$ref;
          const response = (
            reference === undefined ? declared : responses[reference.split('/').pop() ?? '']
          ) as { content?: Record<string, unknown> } | undefined;
          types.push(...Object.keys(response?.content ?? {}));
        }
      }
    }
    return types;
  }

  // Break caught: the premise of the transport's check of a success answer. It refuses a success that is not JSON
  // (a proxy's page, a portal's login form) because the contract has no other kind. The day the contract declares a
  // download, that check would refuse it, and this test says so first, naming what to change.
  it('is JSON everywhere: no success of the contract is anything else, so the transport may refuse the rest', () => {
    const types = successMediaTypes();

    expect(types.length).toBeGreaterThan(100);
    expect(new Set(types)).toEqual(new Set(['application/json']));
  });
});
