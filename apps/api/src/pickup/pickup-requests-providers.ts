import type { FactoryProvider } from '@nestjs/common';

import { AUDIT_WRITER, type AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import { CLOCK, type Clock } from '../platform/auth/ports/clock.port.js';
import {
  IDEMPOTENCY_STORE,
  type IdempotencyStore,
} from '../platform/auth/ports/idempotency-store.port.js';
import { OPERATION_RUNNER } from '../platform/authorization/authorization-providers.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { RUN_ACCESS, type RunAccess } from '../platform/domain-ports/run-access.port.js';
import { DatabaseService } from '../platform/database/database.service.js';
import { ConfigurationReader } from '../platform/settings/configuration-reader.js';
import { ReasonValidator } from '../platform/settings/reason-validator.js';
import { AdHocSendersService } from './ad-hoc-senders.service.js';
import { CutoffExceptionResolution } from './cutoff-exception.service.js';
import { OnePackageExceptions } from './one-package-exception.service.js';
import { PickupRequestCancellation } from './pickup-request-cancellation.service.js';
import { PickupRequestChain } from './pickup-request-chain.service.js';
import { OutboxWriter } from '../platform/notifications/outbox-writer.js';
import { PickupRequestConfirmation } from './pickup-request-confirmation.service.js';
import { PickupRequestCreation } from './pickup-request-creation.service.js';
import { PickupRequestsService } from './pickup-requests.service.js';

/** The injection token of the service of the pickup request reads (S1.13), which its controller asks for. */
export const PICKUP_REQUESTS_SERVICE = Symbol('PICKUP_REQUESTS_SERVICE');

/** The injection token of the service of `createPickupRequest` (S1.14), which its controller asks for. */
export const PICKUP_REQUEST_CREATION = Symbol('PICKUP_REQUEST_CREATION');

/** The injection token of the service of `findAdHocSender` (S1.14), which its controller asks for. */
export const AD_HOC_SENDERS_SERVICE = Symbol('AD_HOC_SENDERS_SERVICE');

/** The injection token of the service of `confirmPickupRequest` (S1.15), which its controller asks for. */
export const PICKUP_REQUEST_CONFIRMATION = Symbol('PICKUP_REQUEST_CONFIRMATION');

/** The injection token of the service of `resolveCutoffException` (S1.15), which its controller asks for. */
export const CUTOFF_EXCEPTION_RESOLUTION = Symbol('CUTOFF_EXCEPTION_RESOLUTION');

/** The injection token of the service of the one-package exception (S1.16), which its controller asks for. */
export const ONE_PACKAGE_EXCEPTIONS = Symbol('ONE_PACKAGE_EXCEPTIONS');

/** The injection token of the service of the cancellation and its charge (S1.17), which its controller asks for. */
export const PICKUP_REQUEST_CANCELLATION = Symbol('PICKUP_REQUEST_CANCELLATION');

/** The injection token of the service of the force-extension and the escalation (S1.18), which its controller asks for. */
export const PICKUP_REQUEST_CHAIN = Symbol('PICKUP_REQUEST_CHAIN');

const optional = (token: symbol | typeof DatabaseService) => ({ token, optional: true });

/**
 * The service, built on the operation runner and the audit writer the platform provides, and `undefined` where either is missing: an
 * application composed without a database has none, so it has no service, and the reads fail closed (`503`).
 */
export const pickupRequestsProviders: readonly FactoryProvider[] = [
  {
    provide: PICKUP_REQUESTS_SERVICE,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
    ): PickupRequestsService | undefined =>
      runner === undefined || audit === undefined
        ? undefined
        : new PickupRequestsService({ runner, audit }),
    inject: [optional(OPERATION_RUNNER), optional(AUDIT_WRITER)],
  },
  {
    provide: AD_HOC_SENDERS_SERVICE,
    useFactory: (runner: OperationRunner | undefined): AdHocSendersService | undefined =>
      runner === undefined ? undefined : new AdHocSendersService({ runner }),
    inject: [optional(OPERATION_RUNNER)],
  },
  {
    // The booking needs the runner, the audit, the idempotency store, the clock and the database (for the configuration reader, which opens
    // its own read transaction under the `configuration` capability so that a vendor session reads no table it is denied): any one
    // missing and the operation fails closed (`503`).
    provide: PICKUP_REQUEST_CREATION,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      idempotency: IdempotencyStore | undefined,
      clock: Clock | undefined,
      database: DatabaseService | undefined,
    ): PickupRequestCreation | undefined =>
      runner === undefined ||
      audit === undefined ||
      idempotency === undefined ||
      clock === undefined ||
      database === undefined
        ? undefined
        : new PickupRequestCreation({
            runner,
            audit,
            idempotency,
            clock,
            configuration: new ConfigurationReader(database),
          }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(AUDIT_WRITER),
      optional(IDEMPOTENCY_STORE),
      optional(CLOCK),
      optional(DatabaseService),
    ],
  },
  {
    // The confirmation needs the runner, the audit, the clock (for the outbox envelope) and the database (for the configuration reader), as
    // the booking does; any one missing and it fails closed (`503`).
    provide: PICKUP_REQUEST_CONFIRMATION,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      database: DatabaseService | undefined,
      clock: Clock | undefined,
    ): PickupRequestConfirmation | undefined =>
      runner === undefined || audit === undefined || database === undefined || clock === undefined
        ? undefined
        : new PickupRequestConfirmation({
            runner,
            audit,
            outbox: new OutboxWriter(clock),
            configuration: new ConfigurationReader(database),
          }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(AUDIT_WRITER),
      optional(DatabaseService),
      optional(CLOCK),
    ],
  },
  {
    // The decision on a late booking reads no configuration (the hub clock is a constant and the day is the database's), so it needs the
    // runner, the audit, the idempotency store and the clock; any one missing and it fails closed (`503`).
    provide: CUTOFF_EXCEPTION_RESOLUTION,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      idempotency: IdempotencyStore | undefined,
      clock: Clock | undefined,
    ): CutoffExceptionResolution | undefined =>
      runner === undefined ||
      audit === undefined ||
      idempotency === undefined ||
      clock === undefined
        ? undefined
        : new CutoffExceptionResolution({ runner, audit, idempotency, clock }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(AUDIT_WRITER),
      optional(IDEMPOTENCY_STORE),
      optional(CLOCK),
    ],
  },
  {
    // The exception needs the runner, the audit, the clock (for the identifier of a new one) and the database (for the configuration reader,
    // which reads the single-package fee of the hub an approval is made in); any one missing and it fails closed (`503`).
    provide: ONE_PACKAGE_EXCEPTIONS,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      clock: Clock | undefined,
      database: DatabaseService | undefined,
    ): OnePackageExceptions | undefined =>
      runner === undefined || audit === undefined || clock === undefined || database === undefined
        ? undefined
        : new OnePackageExceptions({
            runner,
            audit,
            clock,
            configuration: new ConfigurationReader(database),
          }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(AUDIT_WRITER),
      optional(CLOCK),
      optional(DatabaseService),
    ],
  },
  {
    // The cancellation needs the runner, the audit, the idempotency store, the clock (for the identifier of a replacement) and the database
    // (for the configuration reader, which reads the amount of the charge and the attempt cap of the hub); any one missing and it fails
    // closed (`503`). The reason validator reads the catalogue in the transaction of the act.
    provide: PICKUP_REQUEST_CANCELLATION,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      idempotency: IdempotencyStore | undefined,
      clock: Clock | undefined,
      database: DatabaseService | undefined,
      runs: RunAccess | undefined,
    ): PickupRequestCancellation | undefined =>
      runner === undefined ||
      audit === undefined ||
      idempotency === undefined ||
      clock === undefined ||
      database === undefined ||
      runs === undefined
        ? undefined
        : new PickupRequestCancellation({
            runner,
            audit,
            idempotency,
            clock,
            configuration: new ConfigurationReader(database),
            reasons: new ReasonValidator(),
            runs,
          }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(AUDIT_WRITER),
      optional(IDEMPOTENCY_STORE),
      optional(CLOCK),
      optional(DatabaseService),
      optional(RUN_ACCESS),
    ],
  },
  {
    // The force-extension and the escalation need the runner, the audit, the idempotency store, the clock (for the identifier of an
    // extension) and the database (for the configuration reader, which reads the attempt cap of the hub); any one missing and it fails
    // closed (`503`).
    provide: PICKUP_REQUEST_CHAIN,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      idempotency: IdempotencyStore | undefined,
      clock: Clock | undefined,
      database: DatabaseService | undefined,
    ): PickupRequestChain | undefined =>
      runner === undefined ||
      audit === undefined ||
      idempotency === undefined ||
      clock === undefined ||
      database === undefined
        ? undefined
        : new PickupRequestChain({
            runner,
            audit,
            idempotency,
            clock,
            configuration: new ConfigurationReader(database),
          }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(AUDIT_WRITER),
      optional(IDEMPOTENCY_STORE),
      optional(CLOCK),
      optional(DatabaseService),
    ],
  },
];
