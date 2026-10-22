import type { FactoryProvider } from '@nestjs/common';

import { SettingsReader } from '../../settings/settings-reader.js';
import { CLOCK, type Clock } from '../ports/clock.port.js';
import { DELIVERY_QUEUE, type DeliveryQueue } from '../ports/delivery-queue.port.js';
import { TOKEN_SERVICE, type TokenService } from '../ports/token-service.port.js';
import { SetupGrantStore } from './setup-grant-store.js';

/** The injection token of the store of setup grants, which the credential operations of the tasks after S0.29 ask for. */
export const SETUP_GRANT_STORE = Symbol('SETUP_GRANT_STORE');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The store, built from the ports the composition root bound (S0.29) and `undefined` where one is missing, as the session services
 * are (`session-providers.ts`): an application composed without a database or without local key material has no delivery queue to
 * queue a message on, so it has no store, and an operation that asks for one fails closed. Nothing falls back to a stand-in that
 * pretends to have issued a grant.
 */
export const setupGrantProviders: readonly FactoryProvider[] = [
  {
    provide: SETUP_GRANT_STORE,
    useFactory: (
      tokens: TokenService | undefined,
      queue: DeliveryQueue | undefined,
      clock: Clock | undefined,
    ): SetupGrantStore | undefined =>
      tokens === undefined || queue === undefined || clock === undefined
        ? undefined
        : new SetupGrantStore({ tokens, queue, settings: new SettingsReader(), clock }),
    inject: [optional(TOKEN_SERVICE), optional(DELIVERY_QUEUE), optional(CLOCK)],
  },
];
