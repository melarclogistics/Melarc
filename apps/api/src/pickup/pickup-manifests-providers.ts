import type { FactoryProvider } from '@nestjs/common';

import { AUDIT_WRITER, type AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import { CLOCK, type Clock } from '../platform/auth/ports/clock.port.js';
import {
  IDEMPOTENCY_STORE,
  type IdempotencyStore,
} from '../platform/auth/ports/idempotency-store.port.js';
import { HandshakeCodes } from '../platform/auth/crypto/handshake-codes.js';
import { OPERATION_RUNNER } from '../platform/authorization/authorization-providers.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import type { AppConfig } from '../platform/config/load-config.js';
import { RUN_ACCESS, type RunAccess } from '../platform/domain-ports/run-access.port.js';
import { OutboxWriter } from '../platform/notifications/outbox-writer.js';
import { APP_CONFIG } from '../platform/platform.tokens.js';
import { ReasonValidator } from '../platform/settings/reason-validator.js';
import { Disputes } from './collection-dispute.service.js';
import { Handshakes } from './collection-handshake.service.js';
import { Collections } from './collection.service.js';
import { PickupManifestCreation } from './pickup-manifest-creation.service.js';
import { PickupManifestDispatch } from './pickup-manifest-dispatch.service.js';
import { PickupManifestPlanning } from './pickup-manifest-planning.service.js';
import { PickupFailures } from './pickup-failure.service.js';
import { PickupManifestsService } from './pickup-manifests.service.js';
import { PickupRunExecution } from './pickup-run-execution.service.js';
import { PickupStopSkip } from './pickup-stop-skip.service.js';

/** The injection token of the service of `createPickupManifest` (S1.20), which its controller asks for. */
export const PICKUP_MANIFEST_CREATION = Symbol('PICKUP_MANIFEST_CREATION');

/** The injection token of the service of the planning of a manifest (S1.21: ordering, assigning a rider, cancelling), which its controller asks for. */
export const PICKUP_MANIFEST_PLANNING = Symbol('PICKUP_MANIFEST_PLANNING');

/** The injection token of the service of the dispatch of a manifest (S1.21), which its controller asks for. */
export const PICKUP_MANIFEST_DISPATCH = Symbol('PICKUP_MANIFEST_DISPATCH');

/** The injection token of the service of the rider's two acts on a run (S1.22: starting it and arriving at a stop), which their controllers ask for. */
export const PICKUP_RUN_EXECUTION = Symbol('PICKUP_RUN_EXECUTION');

/** The injection token of the service of Ops's skip of a stop (S1.23), which its controller asks for. */
export const PICKUP_STOP_SKIP = Symbol('PICKUP_STOP_SKIP');

/** The injection token of the service of the rider's count at the door (S1.26), which its controller asks for. */
export const PICKUP_COLLECTION = Symbol('PICKUP_COLLECTION');

/** The injection token of the service of the collection handshake (S1.27), which its controller asks for. */
export const PICKUP_HANDSHAKES = Symbol('PICKUP_HANDSHAKES');

/** The injection token of the service of the vendor's dispute of a collection (S1.29), which its controller asks for. */
export const PICKUP_DISPUTES = Symbol('PICKUP_DISPUTES');

/** The injection token of the service of the rider's report of a failed stop (S1.28), which its controller asks for. */
export const PICKUP_FAILURES = Symbol('PICKUP_FAILURES');

/** The injection token of the service of the manifest reads (S1.20), which its controller asks for. */
export const PICKUP_MANIFESTS_SERVICE = Symbol('PICKUP_MANIFESTS_SERVICE');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The services of the manifest, each `undefined` where what it needs is missing: an application composed without a database has none,
 * so it has no service, and the operations fail closed (`503`). The creation needs the runner, the audit, the idempotency store and the
 * clock (for the identifiers of the manifest and its stops), and puts the reasons of its carry-overs to the catalogue; the reads need the
 * runner and the audit.
 */
export const pickupManifestsProviders: readonly FactoryProvider[] = [
  {
    provide: PICKUP_MANIFEST_CREATION,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      idempotency: IdempotencyStore | undefined,
      clock: Clock | undefined,
    ): PickupManifestCreation | undefined =>
      runner === undefined ||
      audit === undefined ||
      idempotency === undefined ||
      clock === undefined
        ? undefined
        : new PickupManifestCreation({
            runner,
            audit,
            idempotency,
            reasons: new ReasonValidator(),
            clock,
          }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(AUDIT_WRITER),
      optional(IDEMPOTENCY_STORE),
      optional(CLOCK),
    ],
  },
  {
    provide: PICKUP_MANIFEST_PLANNING,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      idempotency: IdempotencyStore | undefined,
    ): PickupManifestPlanning | undefined =>
      runner === undefined || audit === undefined || idempotency === undefined
        ? undefined
        : new PickupManifestPlanning({ runner, audit, idempotency }),
    inject: [optional(OPERATION_RUNNER), optional(AUDIT_WRITER), optional(IDEMPOTENCY_STORE)],
  },
  {
    // The dispatch needs the clock as well, for the envelope of the rider's text (the writer takes the identifier of the envelope from it).
    provide: PICKUP_MANIFEST_DISPATCH,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      clock: Clock | undefined,
    ): PickupManifestDispatch | undefined =>
      runner === undefined || audit === undefined || clock === undefined
        ? undefined
        : new PickupManifestDispatch({ runner, audit, outbox: new OutboxWriter(clock) }),
    inject: [optional(OPERATION_RUNNER), optional(AUDIT_WRITER), optional(CLOCK)],
  },
  {
    // The rider's start of a run and arrival at a stop (S1.22): the runner, the audit and the idempotency store of the arrival's retry.
    provide: PICKUP_RUN_EXECUTION,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      idempotency: IdempotencyStore | undefined,
    ): PickupRunExecution | undefined =>
      runner === undefined || audit === undefined || idempotency === undefined
        ? undefined
        : new PickupRunExecution({ runner, audit, idempotency }),
    inject: [optional(OPERATION_RUNNER), optional(AUDIT_WRITER), optional(IDEMPOTENCY_STORE)],
  },
  {
    // Ops's skip of a stop (S1.23): the runner, the audit, the idempotency store, the reason catalogue, the clock for the envelope of the
    // Vendor's notice (the writer takes the identifier of the envelope from it), and the run port for the completion of the run.
    provide: PICKUP_STOP_SKIP,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      idempotency: IdempotencyStore | undefined,
      clock: Clock | undefined,
      runs: RunAccess | undefined,
    ): PickupStopSkip | undefined =>
      runner === undefined ||
      audit === undefined ||
      idempotency === undefined ||
      clock === undefined ||
      runs === undefined
        ? undefined
        : new PickupStopSkip({
            runner,
            audit,
            idempotency,
            reasons: new ReasonValidator(),
            outbox: new OutboxWriter(clock),
            runs,
          }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(AUDIT_WRITER),
      optional(IDEMPOTENCY_STORE),
      optional(CLOCK),
      optional(RUN_ACCESS),
    ],
  },
  {
    // The rider's report of a failed stop (S1.28): the runner, the audit, the idempotency store, the reason catalogue, and the run port for the completion of the
    // run when the failed stop was its last and nothing was collected.
    provide: PICKUP_FAILURES,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      idempotency: IdempotencyStore | undefined,
      runs: RunAccess | undefined,
    ): PickupFailures | undefined =>
      runner === undefined || audit === undefined || idempotency === undefined || runs === undefined
        ? undefined
        : new PickupFailures({ runner, audit, idempotency, reasons: new ReasonValidator(), runs }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(AUDIT_WRITER),
      optional(IDEMPOTENCY_STORE),
      optional(RUN_ACCESS),
    ],
  },
  {
    // The rider's count at the door (S1.26): the runner, the audit, the idempotency store, the clock for the identifier of the record, and the
    // reason catalogue of the short count.
    provide: PICKUP_COLLECTION,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      idempotency: IdempotencyStore | undefined,
      clock: Clock | undefined,
    ): Collections | undefined =>
      runner === undefined ||
      audit === undefined ||
      idempotency === undefined ||
      clock === undefined
        ? undefined
        : new Collections({ runner, audit, idempotency, clock, reasons: new ReasonValidator() }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(AUDIT_WRITER),
      optional(IDEMPOTENCY_STORE),
      optional(CLOCK),
    ],
  },
  {
    // The collection handshake (S1.27): the runner, the audit, the idempotency store, the clock for the identifier of a handshake, and the code, which
    // is made under a key of the `credential_delivery` purpose. Without the keys (a deployment whose custody is not local) there is no code to make,
    // so no handshake service, and its five operations fail closed (`503`).
    provide: PICKUP_HANDSHAKES,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      idempotency: IdempotencyStore | undefined,
      clock: Clock | undefined,
      config: AppConfig,
    ): Handshakes | undefined =>
      runner === undefined ||
      audit === undefined ||
      idempotency === undefined ||
      clock === undefined ||
      config.keys.custody !== 'local'
        ? undefined
        : new Handshakes({
            runner,
            audit,
            idempotency,
            clock,
            codes: new HandshakeCodes(config.keys),
          }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(AUDIT_WRITER),
      optional(IDEMPOTENCY_STORE),
      optional(CLOCK),
      APP_CONFIG,
    ],
  },
  {
    // The vendor's dispute of a collection (S1.29): the runner, the idempotency store and the clock for the identifier of the item. The events are the database's.
    provide: PICKUP_DISPUTES,
    useFactory: (
      runner: OperationRunner | undefined,
      idempotency: IdempotencyStore | undefined,
      clock: Clock | undefined,
    ): Disputes | undefined =>
      runner === undefined || idempotency === undefined || clock === undefined
        ? undefined
        : new Disputes({ runner, idempotency, clock }),
    inject: [optional(OPERATION_RUNNER), optional(IDEMPOTENCY_STORE), optional(CLOCK)],
  },
  {
    provide: PICKUP_MANIFESTS_SERVICE,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
    ): PickupManifestsService | undefined =>
      runner === undefined || audit === undefined
        ? undefined
        : new PickupManifestsService({ runner, audit }),
    inject: [optional(OPERATION_RUNNER), optional(AUDIT_WRITER)],
  },
];
