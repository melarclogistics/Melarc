import type { FactoryProvider } from '@nestjs/common';

import { AUDIT_WRITER, type AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import { OPERATION_RUNNER } from '../platform/authorization/authorization-providers.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { NotificationLogService } from './notification-log.service.js';

/** The injection token of the service of the Ops message log (S1.12e), which its controller asks for. */
export const NOTIFICATION_LOG_SERVICE = Symbol('NOTIFICATION_LOG_SERVICE');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The service, built on the operation runner and the audit writer the platform provides, and `undefined` where either is missing: an
 * application composed without a database has none, so it has no service, and the read fails closed (`503`).
 */
export const notificationLogProviders: readonly FactoryProvider[] = [
  {
    provide: NOTIFICATION_LOG_SERVICE,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
    ): NotificationLogService | undefined =>
      runner === undefined || audit === undefined
        ? undefined
        : new NotificationLogService({ runner, audit }),
    inject: [optional(OPERATION_RUNNER), optional(AUDIT_WRITER)],
  },
];
