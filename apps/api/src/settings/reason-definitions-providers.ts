import type { FactoryProvider } from '@nestjs/common';

import { OPERATION_RUNNER } from '../platform/authorization/authorization-providers.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { ReasonDefinitionsService } from './reason-definitions.service.js';

/** The injection token of the service of `listReasonDefinitions` (S0.35), which its controller asks for. */
export const REASON_DEFINITIONS_SERVICE = Symbol('REASON_DEFINITIONS_SERVICE');

/**
 * The service, built on the operation runner the platform provides, and `undefined` where there is none: an application composed
 * without a database has no runner, so it has no service, and the read fails closed (`503`).
 */
export const reasonDefinitionsProviders: readonly FactoryProvider[] = [
  {
    provide: REASON_DEFINITIONS_SERVICE,
    useFactory: (runner: OperationRunner | undefined): ReasonDefinitionsService | undefined =>
      runner === undefined ? undefined : new ReasonDefinitionsService({ runner }),
    inject: [{ token: OPERATION_RUNNER, optional: true }],
  },
];
