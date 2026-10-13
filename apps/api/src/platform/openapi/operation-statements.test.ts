import { readFileSync } from 'node:fs';

import { Controller, Get, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApiResponse } from '@nestjs/swagger';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';

import { ContractOperation } from '../contract/contract-operation.js';
import { isJsonObject, type Json, type JsonObject } from '../contract/json.js';
import { locateContract } from '../contract/locate-contract.js';
import { TechnicalEndpoint } from '../routes/access-declaration.js';
import { buildOpenApiDocument } from './build-openapi-document.js';
import {
  DEFAULT_SECURITY,
  DescribeCookies,
  DescribeSecurity,
  DescribeServers,
  RIDER_SERVERS,
  SAME_ORIGIN_SERVER,
  SECURITY_SCHEMES,
} from './operation-statements.js';

const contract = parse(readFileSync(locateContract(import.meta.dirname), 'utf8')) as JsonObject;

function object(value: Json | undefined, what: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`${what} is not an object`);
  return value;
}

/** The facts of a security scheme that the comparison reads; its prose is not one. */
const FACTS = ['type', 'in', 'name', 'scheme', 'bearerFormat', 'flows', 'openIdConnectUrl'];
const facts = (definition: JsonObject): JsonObject =>
  Object.fromEntries(
    FACTS.filter((fact) => definition[fact] !== undefined).map((fact) => [
      fact,
      definition[fact] as Json,
    ]),
  );

let app: INestApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Describes a bare application made of the given controllers: what the builder reads, with nothing else around it. */
async function describe_(...controllers: (new () => object)[]): Promise<JsonObject> {
  const module = await Test.createTestingModule({ controllers }).compile();
  app = module.createNestApplication({ logger: false });
  await app.init();
  return JSON.parse(JSON.stringify(buildOpenApiDocument(app))) as JsonObject;
}

const operation = (document: JsonObject, path: string, method: string): JsonObject =>
  object(object(object(document.paths, 'paths')[path], path)[method], `${method} ${path}`);

describe('what the description says about credentials, as the contract does', () => {
  // Break caught (the bootstrap carry-forward): a description with no scheme definitions, which makes every secured operation
  // report security drift, or definitions that differ from the contract's.
  it('defines the four security schemes exactly as the contract does', async () => {
    @Controller('probe')
    @TechnicalEndpoint()
    class Probe {
      @Get()
      @ContractOperation('probe')
      probe(): string {
        return 'x';
      }
    }
    const document = await describe_(Probe);

    const defined = object(object(document.components, 'components').securitySchemes, 'schemes');
    const contracted = object(object(contract.components, 'components').securitySchemes, 'schemes');
    expect(Object.keys(defined).toSorted()).toEqual(Object.keys(contracted).toSorted());
    for (const [name, definition] of Object.entries(contracted)) {
      expect(facts(object(defined[name], name)), name).toEqual(facts(object(definition, name)));
    }
  });

  // Break caught: the platform's default posture not being the contract's, so an operation that states nothing is described as
  // something the contract does not say it is.
  it('inherits, as the contract does, a browser session with its CSRF token, or a rider session', () => {
    expect(DEFAULT_SECURITY).toEqual([['browserSession', 'csrfToken'], ['riderSession']]);
    expect(contract.security).toEqual([
      { browserSession: [], csrfToken: [] },
      { riderSession: [] },
    ]);
  });

  it('puts that default at the root of the description, and leaves an operation that states nothing to inherit it', async () => {
    @Controller('probe')
    @TechnicalEndpoint()
    class Probe {
      @Post()
      @ContractOperation('stateless')
      stateless(): string {
        return 'x';
      }
    }
    const document = await describe_(Probe);

    expect(document.security).toEqual([
      { browserSession: [], csrfToken: [] },
      { riderSession: [] },
    ]);
    expect(operation(document, '/probe', 'post').security).toBeUndefined();
  });
});

describe('DescribeSecurity: credentials that must all hold, and alternatives', () => {
  @Controller('security')
  @TechnicalEndpoint()
  class Security {
    @Post('and')
    @ContractOperation('andOperation')
    @DescribeSecurity(['browserSession', 'csrfToken'])
    and(): string {
      return 'x';
    }

    @Post('or')
    @ContractOperation('orOperation')
    @DescribeSecurity(['browserSession', 'csrfToken'], ['riderSession'])
    or(): string {
      return 'x';
    }

    @Get('reads')
    @ContractOperation('readsOperation')
    @DescribeSecurity(['browserSession'], ['riderSession'])
    reads(): string {
      return 'x';
    }

    @Post('device')
    @ContractOperation('deviceOperation')
    @DescribeSecurity(['vendorDevice'])
    device(): string {
      return 'x';
    }

    @Post('anonymous')
    @ContractOperation('anonymousOperation')
    @DescribeSecurity()
    anonymous(): string {
      return 'x';
    }
  }

  // Break caught (the bootstrap carry-forward): "decorators cannot state two schemes that must both hold". browserSession and
  // csrfToken are one requirement, an AND: two alternatives instead would make the CSRF token optional.
  it('states two schemes that must both hold as one requirement', async () => {
    const document = await describe_(Security);

    expect(operation(document, '/security/and', 'post').security).toEqual([
      { browserSession: [], csrfToken: [] },
    ]);
  });

  it('states alternatives as separate requirements, in the order given', async () => {
    const document = await describe_(Security);

    expect(operation(document, '/security/or', 'post').security).toEqual([
      { browserSession: [], csrfToken: [] },
      { riderSession: [] },
    ]);
    expect(operation(document, '/security/reads', 'get').security).toEqual([
      { browserSession: [] },
      { riderSession: [] },
    ]);
    expect(operation(document, '/security/device', 'post').security).toEqual([
      { vendorDevice: [] },
    ]);
  });

  // Break caught: an anonymous operation left to inherit the default, which would make it authenticated in the description, or an
  // explicit `security: []` dropped from the document, which is how an anonymous operation is told from one that inherits.
  it('states an anonymous operation as an explicit empty list, which is not the same as stating nothing', async () => {
    const document = await describe_(Security);

    const anonymous = operation(document, '/security/anonymous', 'post');
    expect(anonymous.security).toEqual([]);
    expect('security' in anonymous).toBe(true);
  });

  // Break caught: a typo in a scheme name or an empty requirement reaching the description, where it would be compared as if it
  // meant something. Both are refused when the decorator is applied, which is when the module is loaded and the application
  // does not start.
  it('refuses a scheme that is not one of the four, when it is declared', () => {
    expect(() => DescribeSecurity(['basicAuth' as never])).toThrow(
      /basicAuth is not a security scheme/,
    );
  });

  it('refuses a requirement that names no scheme, which would describe nothing', () => {
    expect(() => DescribeSecurity([])).toThrow(/names no scheme/);
  });
});

describe('DescribeCookies: the cookies a response sets or expires', () => {
  @Controller('cookies')
  @TechnicalEndpoint()
  class Cookies {
    @Post('in')
    @ContractOperation('signInOperation')
    @ApiResponse({ status: 200, description: 'OK' })
    @DescribeCookies(200, ['melarc_session', 'melarc_csrf'])
    signIn(): string {
      return 'x';
    }

    @Post('out')
    @ContractOperation('signOutOperation')
    @ApiResponse({ status: 204, description: 'No content' })
    @DescribeCookies(204, ['melarc_session', 'melarc_csrf'], { for: 'browserSession' })
    signOut(): void {
      return undefined;
    }

    @Post('vendor')
    @ContractOperation('vendorOperation')
    @ApiResponse({ status: 204, description: 'No content' })
    @DescribeCookies(204, ['melarc_vendor_device'], { when: { principalType: 'VENDOR' } })
    vendor(): void {
      return undefined;
    }
  }

  const response = (document: JsonObject, path: string, status: string): JsonObject =>
    object(object(operation(document, path, 'post').responses, 'responses')[status], status);

  it('states the cookies on the response that sets them', async () => {
    const document = await describe_(Cookies);

    expect(response(document, '/cookies/in', '200')['x-set-cookies']).toEqual([
      'melarc_session',
      'melarc_csrf',
    ]);
    expect(response(document, '/cookies/in', '200')['x-set-cookies-for']).toBeUndefined();
    expect(response(document, '/cookies/in', '200')['x-set-cookies-when']).toBeUndefined();
  });

  // Break caught: the sign-out cookies stated for every caller, when only a request that presented a browser session is owed them.
  it('limits the declaration to a request that presented a scheme, or to an answer for a type of principal', async () => {
    const document = await describe_(Cookies);

    expect(response(document, '/cookies/out', '204')['x-set-cookies-for']).toBe('browserSession');
    expect(response(document, '/cookies/vendor', '204')['x-set-cookies-when']).toEqual({
      principal_type: 'VENDOR',
    });
  });

  // Break caught: a cookie stated for a response the description does not have, which would add a response by the side.
  it('refuses to state cookies on a response the handler does not describe', async () => {
    @Controller('bad')
    @TechnicalEndpoint()
    class Bad {
      @Post()
      @ContractOperation('badOperation')
      @ApiResponse({ status: 200, description: 'OK' })
      @DescribeCookies(204, ['melarc_session'])
      bad(): string {
        return 'x';
      }
    }

    await expect(describe_(Bad)).rejects.toThrow(/204/);
  });

  it('refuses a cookie that is not one of the three, and a limit that is not a scheme, when they are declared', () => {
    expect(() => DescribeCookies(200, ['analytics'])).toThrow(/analytics is not a cookie/);
    expect(() => DescribeCookies(200, ['melarc_session'], { for: 'basicAuth' as never })).toThrow(
      /basicAuth is not a security scheme/,
    );
  });
});

describe('DescribeServers: the hosts an operation is reachable at', () => {
  @Controller('servers')
  @TechnicalEndpoint()
  class Servers {
    @Post('rider')
    @ContractOperation('riderOperation')
    @DescribeServers(RIDER_SERVERS)
    rider(): string {
      return 'x';
    }

    @Post('browser')
    @ContractOperation('browserOperation')
    browser(): string {
      return 'x';
    }
  }

  it('states the servers of an operation that names its own, and none for one that inherits', async () => {
    const document = await describe_(Servers);

    expect(operation(document, '/servers/rider', 'post').servers).toEqual(
      RIDER_SERVERS.map((server) => ({ url: server.url, description: server.description })),
    );
    expect(operation(document, '/servers/browser', 'post').servers).toBeUndefined();
  });

  // Break caught: the constant the Rider operations will state drifting from what the contract says of its eight Rider
  // operations. Their hosts are the same-origin default and the dedicated non-browser host, in that form.
  it('has the hosts the contract gives each of its operations that names its own', () => {
    const named: string[][] = [];
    for (const item of Object.values(object(contract.paths, 'paths'))) {
      for (const [method, each] of Object.entries(object(item, 'a path'))) {
        if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
        const servers = object(each, 'an operation').servers;
        if (Array.isArray(servers)) {
          named.push(
            (servers as Json[]).map((server) => {
              const url = object(server, 'server').url;
              return typeof url === 'string' ? url : '';
            }),
          );
        }
      }
    }

    expect(named).toHaveLength(8);
    for (const urls of named) expect(urls).toEqual(RIDER_SERVERS.map((server) => server.url));
    expect(RIDER_SERVERS[0]).toBe(SAME_ORIGIN_SERVER);
  });
});

describe('a statement that cannot be placed', () => {
  // Break caught: a statement quietly dropped because its handler is not bound to an operation, which would make the description
  // say less than the code does.
  it.each([
    ['security', () => DescribeSecurity()],
    ['cookies', () => DescribeCookies(200, ['melarc_session'])],
    ['servers', () => DescribeServers(RIDER_SERVERS)],
  ] as const)(
    'refuses a %s statement on a handler bound to no operation',
    async (_label, decorate) => {
      @Controller('unbound')
      @TechnicalEndpoint()
      class Unbound {
        @Post()
        @decorate()
        unbound(): string {
          return 'x';
        }
      }

      await expect(describe_(Unbound)).rejects.toThrow(/not bound to an operation/);
    },
  );

  it('has the same security schemes in code as it states', () => {
    expect(Object.keys(SECURITY_SCHEMES).toSorted()).toEqual([
      'browserSession',
      'csrfToken',
      'riderSession',
      'vendorDevice',
    ]);
  });
});
