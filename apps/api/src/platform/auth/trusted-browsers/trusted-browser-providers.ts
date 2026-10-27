import type { FactoryProvider } from '@nestjs/common';

import { OPERATION_RUNNER } from '../../authorization/authorization-providers.js';
import type { OperationRunner } from '../../authorization/operation-runner.js';
import { AUDIT_WRITER, type AuditWriter } from '../ports/audit-writer.port.js';
import { CLOCK, type Clock } from '../ports/clock.port.js';
import { TOKEN_SERVICE, type TokenService } from '../ports/token-service.port.js';
import { TrustedBrowserOperations } from './trusted-browser-operations.js';
import { TrustedBrowserStore } from './trusted-browser-store.js';

/** The injection token of the store of trusted browsers, which the sign-ins, the resets and the operations ask for. */
export const TRUSTED_BROWSER_STORE = Symbol('TRUSTED_BROWSER_STORE');

/** The injection token of the operations on the caller's own trusted browsers, which their controller asks for. */
export const TRUSTED_BROWSER_OPERATIONS = Symbol('TRUSTED_BROWSER_OPERATIONS');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The store, built from the clock that makes its identifiers, and the operations on the caller's own trusted browsers, built on the
 * runner, the store, the audit writer and the token service. Both are `undefined` where one of those is missing (an application composed
 * without a database or without local key material), so the two operations fail closed (`503`) and never answer as though a browser had
 * been listed or removed.
 */
export const trustedBrowserProviders: readonly FactoryProvider[] = [
  {
    provide: TRUSTED_BROWSER_STORE,
    useFactory: (clock: Clock | undefined): TrustedBrowserStore | undefined =>
      clock === undefined ? undefined : new TrustedBrowserStore({ clock }),
    inject: [optional(CLOCK)],
  },
  {
    provide: TRUSTED_BROWSER_OPERATIONS,
    useFactory: (
      runner: OperationRunner | undefined,
      store: TrustedBrowserStore | undefined,
      audit: AuditWriter | undefined,
      tokens: TokenService | undefined,
    ): TrustedBrowserOperations | undefined =>
      runner === undefined || store === undefined || audit === undefined || tokens === undefined
        ? undefined
        : new TrustedBrowserOperations({ runner, store, audit, tokens }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(TRUSTED_BROWSER_STORE),
      optional(AUDIT_WRITER),
      optional(TOKEN_SERVICE),
    ],
  },
];
