import 'reflect-metadata';

import {
  applyDecorators,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Post,
  type Type,
} from '@nestjs/common';
import { ApiExtension, ApiParam, ApiResponse } from '@nestjs/swagger';

import { ContractOperation } from '../platform/contract/contract-operation.js';
import {
  DescribeCookies,
  DescribeSecurity,
  DescribeServers,
  RIDER_SERVERS,
  SAME_ORIGIN_SERVER,
} from '../platform/openapi/operation-statements.js';
import { TechnicalEndpoint } from '../platform/routes/access-declaration.js';

/**
 * A small slice written the way the identity slice will write its operations, for the three statements a decorated class cannot
 * make (S0.21): credentials that must all hold, the cookies a response sets, and the hosts an operation is reachable at.
 * `ACCOUNT_CONTRACT` is the hand-authored contract for it; the conforming controller matches it, and each other controller
 * differs by the single thing it **omits or gets wrong**, so the conformance check is shown to catch each in a real
 * application's own description. It exists only in tests and borrows the technical access declaration, as the other fixtures do.
 */

const X_COOKIES = {
  melarc_session: {
    purpose: 'Opaque browser Session credential',
    attributes: 'HttpOnly; Secure; SameSite=Lax; Path=/',
    browser_session: true,
    host_only: true,
    read_by_javascript: false,
  },
  melarc_csrf: {
    purpose: 'CSRF synchronizer token',
    attributes: 'Secure; SameSite=Lax; Path=/',
    browser_session: true,
    host_only: true,
    read_by_javascript: true,
  },
} as const;

const SERVER_JSON = RIDER_SERVERS.map((server) => ({
  url: server.url,
  description: server.description,
}));

/** The operations as the contract states them. The root default is the platform's own: a browser session with its CSRF token, or a rider session. */
export const ACCOUNT_CONTRACT = {
  openapi: '3.1.0',
  info: { title: 'Account fixture contract', version: '1' },
  servers: [{ url: SAME_ORIGIN_SERVER.url }],
  security: [{ browserSession: [], csrfToken: [] }, { riderSession: [] }],
  'x-cookies': X_COOKIES,
  paths: {
    '/accounts/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        operationId: 'getAccount',
        security: [{ browserSession: [] }, { riderSession: [] }],
        'x-permission': 'account.read',
        responses: { '200': { description: 'OK' } },
      },
      post: {
        operationId: 'updateAccount',
        // No `security` here: the operation inherits the root default, which is the AND of the two schemes or the rider session.
        'x-permission': 'account.update',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/sessions/end': {
      post: {
        operationId: 'endSession',
        'x-permission': 'none',
        responses: {
          '204': {
            description: 'Signed out',
            'x-set-cookies': ['melarc_session', 'melarc_csrf'],
            'x-set-cookies-for': 'browserSession',
          },
        },
      },
    },
    '/rider/runs/start': {
      post: {
        operationId: 'startRiderRun',
        security: [{ riderSession: [] }],
        servers: SERVER_JSON,
        'x-permission': 'run.start',
        responses: { '200': { description: 'OK' } },
      },
    },
  },
  components: {
    securitySchemes: {
      browserSession: { type: 'apiKey', in: 'cookie', name: 'melarc_session' },
      csrfToken: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' },
      vendorDevice: { type: 'apiKey', in: 'cookie', name: 'melarc_vendor_device' },
      riderSession: { type: 'http', scheme: 'bearer' },
    },
  },
} as const;

interface AccountOptions {
  /** What `getAccount` states of its credentials; `undefined` states nothing. */
  readonly read?: MethodDecorator | null;
  /** What `updateAccount` states; `null` states nothing and inherits the default. */
  readonly update?: MethodDecorator | null;
  /** What `endSession` states about its cookies; `null` states none. */
  readonly cookies?: MethodDecorator | null;
  /** What `startRiderRun` states about its hosts; `null` states none. */
  readonly servers?: MethodDecorator | null;
  /** What `startRiderRun` states about its credentials. */
  readonly rider?: MethodDecorator;
}

const optional = (decorator: MethodDecorator | null | undefined): MethodDecorator[] =>
  decorator === null || decorator === undefined ? [] : [decorator];

function describeRead(options: AccountOptions): MethodDecorator {
  return applyDecorators(
    ContractOperation('getAccount'),
    ApiParam({ name: 'id', type: String }),
    ApiExtension('x-permission', 'account.read'),
    ...(options.read === undefined
      ? [DescribeSecurity(['browserSession'], ['riderSession'])]
      : optional(options.read)),
    ApiResponse({ status: 200, description: 'OK' }),
  );
}

function describeUpdate(options: AccountOptions): MethodDecorator {
  return applyDecorators(
    ContractOperation('updateAccount'),
    ApiParam({ name: 'id', type: String }),
    ApiExtension('x-permission', 'account.update'),
    ...optional(options.update),
    ApiResponse({ status: 200, description: 'OK' }),
  );
}

function describeEnd(options: AccountOptions): MethodDecorator {
  return applyDecorators(
    ContractOperation('endSession'),
    ApiExtension('x-permission', 'none'),
    ApiResponse({ status: 204, description: 'Signed out' }),
    ...(options.cookies === undefined
      ? [DescribeCookies(204, ['melarc_session', 'melarc_csrf'], { for: 'browserSession' })]
      : optional(options.cookies)),
  );
}

function describeStart(options: AccountOptions): MethodDecorator {
  return applyDecorators(
    ContractOperation('startRiderRun'),
    ApiExtension('x-permission', 'run.start'),
    options.rider ?? DescribeSecurity(['riderSession']),
    ApiResponse({ status: 200, description: 'OK' }),
    ...(options.servers === undefined
      ? [DescribeServers(RIDER_SERVERS)]
      : optional(options.servers)),
  );
}

function controllerFor(options: AccountOptions = {}): Type<unknown> {
  @Controller()
  @TechnicalEndpoint()
  class AccountsController {
    @Get('accounts/:id')
    @describeRead(options)
    read(@Param('id') id: string): { id: string } {
      return { id };
    }

    @Post('accounts/:id')
    @HttpCode(200)
    @describeUpdate(options)
    update(@Param('id') id: string): { id: string } {
      return { id };
    }

    @Post('sessions/end')
    @HttpCode(204)
    @describeEnd(options)
    end(): void {
      return undefined;
    }

    @Post('rider/runs/start')
    @HttpCode(200)
    @describeStart(options)
    start(): { started: boolean } {
      return { started: true };
    }
  }
  return AccountsController;
}

function moduleOf(controller: Type<unknown>): Type<unknown> {
  @Module({ controllers: [controller] })
  class AccountsModule {}
  return AccountsModule;
}

/** The implementation that matches `ACCOUNT_CONTRACT`. */
export const ConformingAccountsModule = moduleOf(controllerFor());

/** Each module below omits or gets wrong exactly one statement. */

/** `updateAccount` states the browser session and leaves out the CSRF token that must hold with it. */
export const CsrfOmittedAccountsModule = moduleOf(
  controllerFor({ update: DescribeSecurity(['browserSession']) }),
);

/** `updateAccount` states the two schemes as alternatives, which makes the CSRF token optional. */
export const CsrfOptionalAccountsModule = moduleOf(
  controllerFor({ update: DescribeSecurity(['browserSession'], ['csrfToken']) }),
);

/** `updateAccount` states itself anonymous where the contract's default makes it authenticated. */
export const AnonymousUpdateAccountsModule = moduleOf(
  controllerFor({ update: DescribeSecurity() }),
);

/** `getAccount` leaves out the rider session the contract accepts. */
export const RiderOmittedAccountsModule = moduleOf(
  controllerFor({ read: DescribeSecurity(['browserSession']) }),
);

/** `endSession` states no cookie at all. */
export const NoCookiesAccountsModule = moduleOf(controllerFor({ cookies: null }));

/** `endSession` states the cookies for every caller, where the contract owes them only to a request that presented a browser session. */
export const CookiesForEveryoneAccountsModule = moduleOf(
  controllerFor({ cookies: DescribeCookies(204, ['melarc_session', 'melarc_csrf']) }),
);

/** `endSession` expires the session cookie and leaves the CSRF cookie in the browser. */
export const OneCookieAccountsModule = moduleOf(
  controllerFor({ cookies: DescribeCookies(204, ['melarc_session'], { for: 'browserSession' }) }),
);

/** `startRiderRun` states no servers, so it is described as reachable on the document's own host only. */
export const NoServersAccountsModule = moduleOf(controllerFor({ servers: null }));

/** `startRiderRun` states only the dedicated host. */
export const OneServerAccountsModule = moduleOf(
  controllerFor({ servers: DescribeServers(RIDER_SERVERS.slice(1)) }),
);
