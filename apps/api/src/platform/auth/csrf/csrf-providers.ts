import type { FactoryProvider } from '@nestjs/common';
import type { Logger } from 'pino';

import { LOGGER } from '../../platform.tokens.js';
import { AUDIT_WRITER, type AuditWriter } from '../ports/audit-writer.port.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../ports/unit-of-work.port.js';
import { CsrfRejectionRecorder } from './csrf-rejection.js';

/** The injection token of the recorder of rejected CSRF and Origin checks, which the CSRF guard asks for. */
export const CSRF_REJECTION_RECORDER = Symbol('CSRF_REJECTION_RECORDER');

/**
 * The recorder, built from the ports the composition root bound (S0.25) and `undefined` where one is missing, as the session
 * services are (`session-providers.ts`): an application composed without a database or an audit writer cannot record a rejection,
 * and its guard refuses all the same. Nothing falls back to a stand-in that pretends to have recorded.
 */
export const csrfProviders: readonly FactoryProvider[] = [
  {
    provide: CSRF_REJECTION_RECORDER,
    useFactory: (
      unitOfWork: UnitOfWork | undefined,
      audit: AuditWriter | undefined,
      logger: Logger,
    ): CsrfRejectionRecorder | undefined =>
      unitOfWork === undefined || audit === undefined
        ? undefined
        : new CsrfRejectionRecorder({ unitOfWork, audit, logger }),
    inject: [
      { token: UNIT_OF_WORK, optional: true },
      { token: AUDIT_WRITER, optional: true },
      LOGGER,
    ],
  },
];
