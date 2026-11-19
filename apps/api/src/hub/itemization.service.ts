import { sql } from 'drizzle-orm';

import { noteRefusal } from '../platform/audit/audit-record.js';
import { randomUUIDv7 } from '../platform/auth/crypto/uuid-v7.js';
import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { Clock } from '../platform/auth/ports/clock.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { guardReasonIn } from '../platform/database/database-failures.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import { normalisePhone } from '../platform/lookup/normalise-phone.js';
import { hubCodeOf, operationalCode } from '../platform/records/operational-code.js';
import type { ConfigurationReader } from '../platform/settings/configuration-reader.js';
import type { HubConfiguration } from '../platform/settings/hub-configuration.js';
import { isCalendarDay } from '../platform/time/calendar-day.js';
import {
  OrderRuleRefusal,
  priceOrder,
  type OrderFacts,
  type PricedOrder,
} from '../pricing/order-pricing.js';
import { PricingRefusal } from '../pricing/price-calculation.js';
import { resolveZone, type LocationText } from '../pricing/zone-resolver.js';
import { receivingRefusalOf } from './check-in.service.js';
import { noteHubCrossing } from './hub-crossing.js';
import { hubIntakeEtagMatches } from './hub-intake-etag.js';
import { loadOrder, orderViewOf, type OrderView } from './order-view.js';
import { recordCommercialGate } from './order-confirmation.js';
import {
  RECEIVING_INTAKE_COLUMNS,
  loadIntakes,
  type ReceivingIntakeRow,
} from './receiving-views.js';

const OPERATION = 'itemizeOrder';

/** The largest amount of pesewas the database holds in an integer column: a declared value or a carrier's cost beyond it is not a number this record can keep. */
const MAX_PESEWAS = 2_000_000_000;

export interface ItemizationOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly idempotency: IdempotencyStore;
  /** The identifiers of the orders and of their first commitments are time-ordered, from the clock it is given, no more. */
  readonly clock: Pick<Clock, 'now'>;
  /** The hub's configuration at the database's moment, read in a transaction of its own under the `configuration` capability. */
  readonly configuration: Pick<ConfigurationReader, 'forHub'>;
}

/** The body of `itemizeOrder` as the contract's schema has validated it (the interceptor ran before this). */
export interface ItemizeBody {
  readonly parcel_id?: string;
  readonly recipient: {
    readonly name: string;
    readonly phone: string;
    readonly location: LocationText;
  };
  readonly size_class?: 'SMALL' | 'MEDIUM' | 'LARGE';
  readonly carrier_cost?: { readonly amount_minor: number; readonly currency: 'GHS' };
  readonly is_high_value?: boolean;
  readonly lane?: 'DOORSTEP' | 'THIRD_PARTY_HANDOFF';
  readonly commercial_mode?: 'STATION_DROP' | 'MELARC_COVERED_THIRD_PARTY_DELIVERY';
  readonly payer_override?: {
    readonly payer_intent: 'RECIPIENT_PAYS' | 'SENDER_PAYS_FULL' | 'SPLIT';
    readonly split_basis?: 'FIXED_AMOUNT' | 'PERCENTAGE';
    readonly split_sender_amount?: { readonly amount_minor: number; readonly currency: 'GHS' };
    readonly split_sender_percentage?: number;
  };
  readonly declared_value_minor?: number;
  readonly is_serialized_goods?: boolean;
  readonly serial_imei?: string;
  readonly requested_delivery_date?: string;
  readonly service_level?: 'STANDARD';
  readonly destination_zone_authorization?: { readonly zone_id: string; readonly note: string };
  readonly evidence_ids?: readonly string[];
  readonly carrier_waybill_evidence_id?: string;
}

/** The body after its cross-field rules are judged: the values the rest of the operation uses. */
interface Checked {
  readonly lane: 'DOORSTEP' | 'THIRD_PARTY_HANDOFF';
  readonly mode: ItemizeBody['commercial_mode'];
  readonly phone: string;
  readonly evidence: readonly string[];
  readonly payerOverride: Readonly<Record<string, unknown>> | null;
  readonly serial: string | null;
}

/** What the database says of the order it made. */
interface Made {
  readonly order_id: string;
  readonly previous_state: string;
  readonly resulting_state: string;
  readonly frozen: boolean;
}

/** What an order is made from (`melarc.itemization_source`): the intake's hub, where its request was collected, whether the booking acknowledged the liability cap, and the moment custody passed. */
interface Source {
  readonly responsible_hub_id: string;
  readonly origin_location: Record<string, unknown> | string | null;
  readonly acknowledged_at_booking: boolean;
  readonly custody_at: string | Date | null;
}

const invalid = (
  pointer: string,
  rule: string,
  extra: Record<string, unknown> = {},
): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
    ...extra,
  });

const conflict = (rule: string, message: string): ApiException =>
  ApiException.of(ErrorCode.StateConflict, message, { rule });

/** Where a rule of the order's own pricing is about, in the body, for the violation it is answered as. */
const POINTER_OF_RULE: Readonly<Record<string, string>> = {
  destination_zone_resolved: '/destination_zone_authorization',
  destination_zone_ambiguous: '/recipient/location',
  destination_zone_not_available: '/destination_zone_authorization/zone_id',
  requested_before_default: '/requested_delivery_date',
};

/**
 * `itemizeOrder` (S1.36 and Run D, D-D6; `hub.intake.itemize`; `AC-SLICE-001-47` to `-50`, `-53`, `-54`, `-56`, `-58`, `-59`, `-90` and `-104`; features/hub/itemization.md sections 5.1, 5.2 and 5.4; domain-model.md
 * sections 6.7 and `DeliveryCommitment`; state-machines.md sections 7 and 8; `MSC-DEC-207`, `-209`, `-210`, `-213`; D-06, D-D6): the order is made for one parcel, and **price first becomes authoritative here**.
 *
 * - **The body is closed**: no price, total, margin, surcharge or zone is accepted (the schema answers `VALIDATION_FAILED`); `carrier_cost` is the one amount, an observation with the photograph of the carrier's
 *   waybill behind it, accepted only in the covered third-party mode. The officer **selects the size class** (a judgement, never defaulted or derived; `SIZE_CLASS_REQUIRED`) and is recorded with an enhanced event.
 * - **Judged in this order** (the repo's): the principal and the key's format; the body's own rules; then, in the transaction, the retry (a replay is answered before anything about the intake is judged), the intake
 *   under its lock (`NOT_FOUND`) and the `ETag` the officer read (`STATE_CONFLICT`, rule `stale`), the intake's and the parcel's states (`STATE_CONFLICT`, each rule named), what the order is made from (the moment custody
 *   passed: `COMMITMENT_SOURCE_UNRESOLVED`), and the order's own price and promise in the fixed order of `priceOrder` (size class, declaration, destination, date, fee, evidence), then the evidence the database judges
 *   (`EVIDENCE_NOT_STORED`). **Every refusal of the price is raised here, when the order is made, even for an order that waits for its parcel**, so that the check-in that later confirms it is never refused for one.
 * - **The price is calculated here and frozen when the parcel's arrival can no longer be taken back**: an order for a parcel that has arrived (or for an intake counted blind) is frozen at once and the first of them
 *   moves the intake to `ITEMIZING`; an order for a parcel not yet checked in waits, with its calculated price and its first commitment, and is confirmed by the check-in (`melarc.freeze_orders`).
 * - **The order and its first `DeliveryCommitment` are one change** (`melarc.itemize_order`, migration 0110): the SLA clock is the moment custody passed, read by the database from the stop's collection and never
 *   the hub's arrival or the time of itemization. A retry under the same key mints neither a second order nor a second commitment (the replay is the stored answer; `order_parcel_key` and the commitment's own key are the
 *   backstop under it).
 * - **The events** (audit.md): `hub.intake.itemized`, `pricing.price.calculated`, `pricing.price.locked` (when frozen), and the two enhanced ones, `pricing.size_class.selected` and `pricing.carrier_cost.captured`.
 */
export class HubItemization {
  readonly #options: ItemizationOptions;

  constructor(options: ItemizationOptions) {
    this.#options = options;
  }

  async itemize(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    request: {
      readonly body: ItemizeBody;
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<OrderView> {
    const { runner, audit, idempotency, clock, configuration } = this.#options;
    this.#requireStaff(authorized);
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
    const { body } = request;
    const checked = this.#checked(body);
    const staff = authorized.session.principalId.toLowerCase();

    // The hub of the intake is found in a short transaction of its own, the configuration of that hub is read next (as the booking does), and the transaction that acts runs last and judges the hub again.
    const hubId = await runner.mutate(authorized, correlationId, (handle) =>
      this.#hubOf(handle, id),
    );
    const config = await configuration.forHub(hubId);

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType: 'STAFF',
        principalId: staff,
        operationId: OPERATION,
        key: request.idempotencyKey,
      } as const;
      const begun = await idempotency.begin(handle, scope, request.fingerprint);
      if (begun.outcome === 'REPLAY') {
        return JSON.parse(Buffer.from(begun.response.body).toString('utf8')) as OrderView;
      }
      if (begun.outcome === 'CONFLICT') {
        throw ApiException.of(
          ErrorCode.IdempotencyKeyConflict,
          'That Idempotency-Key was used with a different request',
        );
      }
      if (begun.outcome !== 'NEW') {
        // A record that began and did not complete is a stranded one (OB-100): the command is not run again, and nothing is invented.
        throw new Error('An idempotency record of this command is stranded');
      }

      const intake = await this.#lock(handle, authorized, id, request.ifMatch);
      if (intake.responsible_hub_id.toLowerCase() !== hubId) {
        // The hub of an intake never changes; a different one means the configuration was read for another record.
        throw new Error('The hub of the intake changed while the order was being made');
      }
      const parcelId = body.parcel_id === undefined ? undefined : body.parcel_id.toLowerCase();
      await this.#judgeStates(tx, intake, id, parcelId);

      const source = await this.#sourceOf(tx, id);
      const custodyAt = new Date(source.custody_at);

      // The order's price and promise, or the refusal, in the order of the pure assembly.
      const facts: OrderFacts = {
        lane: checked.lane,
        commercialMode: checked.mode,
        sizeClass: body.size_class,
        carrierCostMinor: body.carrier_cost?.amount_minor,
        declaredValueMinor: body.declared_value_minor,
        manualHighValue: body.is_high_value === true,
        location: body.recipient.location,
        authorization:
          body.destination_zone_authorization === undefined
            ? undefined
            : {
                zoneId: body.destination_zone_authorization.zone_id.toLowerCase(),
                note: body.destination_zone_authorization.note.trim(),
              },
        custodyAt,
        requestedDeliveryDate: body.requested_delivery_date,
        acknowledgedAtBooking: source.acknowledged_at_booking,
        highValueEvidenceCount: checked.evidence.length,
      };
      let priced: PricedOrder;
      try {
        priced = priceOrder(config, facts);
      } catch (error) {
        throw this.#refusal(error) ?? error;
      }
      if (body.carrier_cost !== undefined && body.carrier_waybill_evidence_id === undefined) {
        throw ApiException.of(
          ErrorCode.CarrierCostRequired,
          'The carrier’s charge is transcribed with the photograph of its waybill',
          { rule: 'waybill_required' },
        );
      }

      const origin = await this.#originOf(tx, id, config, source.origin_location);
      const orderId = randomUUIDv7(clock);
      const commitmentId = randomUUIDv7(clock);
      const code = await this.#codeOf(tx, config);
      const given = {
        order_id: orderId,
        code,
        initial_commitment_id: commitmentId,
        parcel_id: parcelId ?? null,
        recipient: {
          name: body.recipient.name.trim(),
          phone: checked.phone,
          phone_as_entered: body.recipient.phone,
          location: body.recipient.location,
        },
        origin_zone_snapshot: origin,
        destination_zone_snapshot: priced.destinationSnapshot,
        destination_zone_resolution: priced.destinationResolution,
        declared_value_minor: body.declared_value_minor ?? null,
        is_serialized_goods: body.is_serialized_goods === true,
        serial_imei: checked.serial,
        requested_delivery_date: priced.dates.requestedDate,
        derived_delivery_date: priced.dates.defaultDate,
        size_class: body.size_class ?? null,
        carrier_cost_minor: body.carrier_cost?.amount_minor ?? null,
        carrier_waybill_evidence_id: body.carrier_waybill_evidence_id?.toLowerCase() ?? null,
        is_high_value: priced.isHighValue,
        high_value_evidence_ids: checked.evidence,
        lane: checked.lane,
        commercial_mode: checked.mode ?? null,
        payer_override: checked.payerOverride,
        price_components_snapshot: priced.snapshot,
        commitment: {
          default_date: priced.dates.defaultDate,
          requested_date: priced.dates.requestedDate,
          committed_date: priced.dates.committedDate,
          window_start: priced.window.start,
          window_end: priced.window.end,
        },
      };

      let made: Made | undefined;
      try {
        const done = await tx.execute(
          sql`select order_id, previous_state, resulting_state, frozen from melarc.itemize_order(${id}::uuid, ${JSON.stringify(given)}::jsonb)`,
        );
        made = done.rows[0] as unknown as Made | undefined;
      } catch (error) {
        throw this.#databaseRefusal(error) ?? error;
      }
      if (made === undefined) throw new Error('A locked intake was not itemized');

      const stored = await loadOrder(tx, made.order_id);
      if (stored === undefined) throw new Error('An order that was made could not be read');
      const view = orderViewOf(stored);

      const related = {
        pickup_intake_id: id,
        pickup_manifest_id: intake.pickup_manifest_id,
        pickup_request_id: intake.pickup_request_id,
        ...(parcelId === undefined ? {} : { intake_parcel_id: parcelId }),
      };
      await audit.write(handle, {
        code: 'hub.intake.itemized',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'Order', id: made.order_id },
        responsibleHubId: hubId,
        relatedIds: related,
        detail: {
          lane: checked.lane,
          intake_state_before: made.previous_state,
          intake_state_after: made.resulting_state,
          frozen: made.frozen,
          awaiting_arrival: stored.intake_parcel_state === 'EXPECTED',
        },
      });
      await audit.write(handle, {
        code: 'pricing.price.calculated',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'Order', id: made.order_id },
        responsibleHubId: hubId,
        relatedIds: related,
        detail: {
          total_minor: priced.price.totalMinor,
          components: priced.price.components.map((component) => component.kind).join(','),
          destination_resolution: priced.destinationResolution,
          committed_date: priced.dates.committedDate,
          high_value: priced.isHighValue,
        },
      });
      await audit.write(handle, {
        code: 'pricing.size_class.selected',
        enhanced: true,
        outcome: 'SUCCEEDED',
        object: { type: 'Order', id: made.order_id },
        responsibleHubId: hubId,
        relatedIds: related,
        // The judgement the order did not have before: the class and the officer who selected it (the audit actor is the same officer, and the moment is the event's).
        beforeAfter: {
          size_class: { before: null, after: String(body.size_class) },
          size_class_selected_by: { before: null, after: staff },
        },
        detail: { size_class: String(body.size_class) },
      });
      if (body.carrier_cost !== undefined) {
        await audit.write(handle, {
          code: 'pricing.carrier_cost.captured',
          enhanced: true,
          outcome: 'SUCCEEDED',
          object: { type: 'Order', id: made.order_id },
          responsibleHubId: hubId,
          relatedIds: {
            ...related,
            waybill_evidence_id: body.carrier_waybill_evidence_id?.toLowerCase() ?? null,
          },
          // The one amount a client gives, an observation with its waybill behind it: nothing was recorded before it.
          beforeAfter: {
            carrier_cost_minor: { before: null, after: body.carrier_cost.amount_minor },
          },
          detail: {
            carrier_cost_minor: body.carrier_cost.amount_minor,
            commercial_mode: String(checked.mode),
          },
        });
      }
      if (made.frozen) {
        await audit.write(handle, {
          code: 'pricing.price.locked',
          enhanced: false,
          outcome: 'SUCCEEDED',
          object: { type: 'Order', id: made.order_id },
          responsibleHubId: hubId,
          relatedIds: related,
          detail: {
            locked_price_minor: stored.locked_price_minor,
            sender_minor: view.payer_allocation?.sender_minor ?? null,
            recipient_minor: view.payer_allocation?.recipient_minor ?? null,
          },
        });
        await recordCommercialGate(handle, audit, {
          orderId: made.order_id,
          hubId,
          relatedIds: related,
          commercialState: stored.commercial_state,
          lockedPriceMinor: stored.locked_price_minor ?? 0,
          senderMinor: view.payer_allocation?.sender_minor ?? 0,
          recipientMinor: view.payer_allocation?.recipient_minor ?? 0,
        });
      }

      await idempotency.complete(handle, scope, {
        status: 201,
        body: new TextEncoder().encode(JSON.stringify(view)),
      });
      return view;
    });
  }

  /** The staff of the Ops Portal alone: a vendor and a rider never reach the service (the route's surface and key), and this does not rely on that alone. */
  #requireStaff(authorized: AuthorizedRequest): void {
    if (authorized.session.principalType !== 'STAFF') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
  }

  /** The body's own rules that no schema can say: what goes with what. Each is `VALIDATION_FAILED` naming the member, before anything is read. */
  #checked(body: ItemizeBody): Checked {
    const lane = body.lane ?? 'DOORSTEP';
    const mode = body.commercial_mode;
    if (lane === 'DOORSTEP' && mode !== undefined) throw invalid('/commercial_mode', 'not_allowed');
    if (lane === 'THIRD_PARTY_HANDOFF' && mode === undefined)
      throw invalid('/commercial_mode', 'required');
    // The carrier's cost is an observation with a waybill behind it, accepted only in the covered third-party mode (AC-SLICE-001-47): in no other mode is a money value the client's to give.
    if (body.carrier_cost !== undefined) {
      if (mode !== 'MELARC_COVERED_THIRD_PARTY_DELIVERY')
        throw invalid('/carrier_cost', 'not_allowed');
      if (
        !Number.isSafeInteger(body.carrier_cost.amount_minor) ||
        body.carrier_cost.amount_minor > MAX_PESEWAS
      ) {
        throw invalid('/carrier_cost/amount_minor', 'range');
      }
    }
    if (body.carrier_waybill_evidence_id !== undefined && body.carrier_cost === undefined) {
      throw invalid('/carrier_waybill_evidence_id', 'not_allowed');
    }
    if (body.declared_value_minor !== undefined && body.declared_value_minor > MAX_PESEWAS) {
      throw invalid('/declared_value_minor', 'range');
    }
    const serial = body.serial_imei === undefined ? null : body.serial_imei.trim();
    if (body.is_serialized_goods === true && (serial === null || serial === '')) {
      throw invalid('/serial_imei', 'required');
    }
    if (body.recipient.name.trim() === '') throw invalid('/recipient/name', 'required');
    if (body.recipient.location.address.trim() === '')
      throw invalid('/recipient/location/address', 'required');
    const phone = normalisePhone(body.recipient.phone);
    if (phone === undefined) throw invalid('/recipient/phone', 'format');
    if (
      body.requested_delivery_date !== undefined &&
      !isCalendarDay(body.requested_delivery_date)
    ) {
      throw invalid('/requested_delivery_date', 'not_a_date');
    }
    if (body.destination_zone_authorization !== undefined) {
      const rule = noteRefusal(body.destination_zone_authorization.note);
      if (rule !== undefined || body.destination_zone_authorization.note.trim() === '') {
        throw invalid('/destination_zone_authorization/note', rule ?? 'required');
      }
    }
    const evidence = (body.evidence_ids ?? []).map((each) => each.toLowerCase());
    if (new Set(evidence).size !== evidence.length) throw invalid('/evidence_ids', 'unique');
    return {
      lane,
      mode,
      phone,
      evidence,
      payerOverride: this.#payerOverride(body.payer_override),
      serial: serial === '' ? null : serial,
    };
  }

  /** The parcel-level override of the request's payer arrangement, as an intent and the numbers that go with it: never a portion of a price, which the database resolves at the freeze. */
  #payerOverride(
    override: ItemizeBody['payer_override'],
  ): Readonly<Record<string, unknown>> | null {
    if (override === undefined) return null;
    const {
      payer_intent: intent,
      split_basis: basis,
      split_sender_amount: amount,
      split_sender_percentage: percentage,
    } = override;
    if (intent !== 'SPLIT') {
      if (basis !== undefined || amount !== undefined || percentage !== undefined) {
        throw invalid('/payer_override', 'split_not_allowed');
      }
      return { payer_intent: intent };
    }
    if (basis === undefined) throw invalid('/payer_override/split_basis', 'required');
    if (basis === 'FIXED_AMOUNT') {
      if (percentage !== undefined)
        throw invalid('/payer_override/split_sender_percentage', 'not_allowed');
      if (
        amount === undefined ||
        !Number.isSafeInteger(amount.amount_minor) ||
        amount.amount_minor < 1 ||
        amount.amount_minor > MAX_PESEWAS
      ) {
        throw invalid('/payer_override/split_sender_amount', 'required');
      }
      return {
        payer_intent: intent,
        split_basis: basis,
        split_sender_amount_minor: amount.amount_minor,
      };
    }
    if (amount !== undefined) throw invalid('/payer_override/split_sender_amount', 'not_allowed');
    if (percentage === undefined)
      throw invalid('/payer_override/split_sender_percentage', 'required');
    return { payer_intent: intent, split_basis: basis, split_sender_percentage: percentage };
  }

  /** The hub of the intake, in the caller's hubs (a miss is `NOT_FOUND`: the route's guard has told another hub's from an absent one). */
  async #hubOf(handle: TransactionHandle, id: string): Promise<string> {
    const found = await transactionOf(handle).execute(
      sql`select responsible_hub_id from pickup_intake where id = ${id}::uuid`,
    );
    const hub = (found.rows[0] as { responsible_hub_id?: string } | undefined)?.responsible_hub_id;
    if (typeof hub !== 'string') throw ApiException.of(ErrorCode.NotFound, 'Not found');
    return hub.toLowerCase();
  }

  /**
   * The intake under its lock, as the officer read it: `NOT_FOUND` for one that is not in the caller's hubs or does not exist, a hub crossing audited, and the `ETag` of the read compared with the one recomputed
   * here (`STATE_CONFLICT`, rule `stale`: missing, weak, another intake's and out of date are one answer). The representation is the one a read answers in the intake's own shape, so the token compared is the one held.
   */
  async #lock(
    handle: TransactionHandle,
    authorized: AuthorizedRequest,
    id: string,
    ifMatch: string | undefined,
  ): Promise<ReceivingIntakeRow> {
    const tx = transactionOf(handle);
    const found = await tx.execute(
      sql`select ${RECEIVING_INTAKE_COLUMNS} from pickup_intake where id = ${id}::uuid for update`,
    );
    const row = found.rows[0] as unknown as ReceivingIntakeRow | undefined;
    if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
    await noteHubCrossing(this.#options.audit, handle, authorized, row);
    const loaded = await loadIntakes(tx, [row], authorized.session.principalId.toLowerCase());
    const current = loaded.checkIns.get(row.id)?.etag ?? loaded.blind.get(row.id)?.etag;
    if (current === undefined || !hubIntakeEtagMatches(ifMatch, current)) {
      throw conflict('stale', 'The intake has changed since it was read');
    }
    return row;
  }

  /**
   * The states of the intake and of the parcel, judged before the price (a state is told before a reason, as the other services of the hub do): **the database repeats every rule for every writer** with the same
   * `details.rule`. A checked-in intake's order is made for one of its parcels and a blind-count intake's for none; a parcel that arrived is ordered once the vendor is cleared, one that has not been checked in
   * waits while the vendor's check-in is open, and one that is missing or void has no order.
   */
  async #judgeStates(
    tx: ReturnType<typeof transactionOf>,
    intake: ReceivingIntakeRow,
    id: string,
    parcelId: string | undefined,
  ): Promise<void> {
    const open = intake.state === 'READY_FOR_ITEMIZATION' || intake.state === 'ITEMIZING';
    const closedRule = (state: string): string =>
      state === 'AWAITING_COUNT'
        ? 'intake_not_counted'
        : state === 'RECONCILIATION_REQUIRED'
          ? 'reconciliation_open'
          : 'intake_not_ready';
    if (intake.receiving_mode !== 'PHOTO_CHECK_IN') {
      if (parcelId !== undefined) throw invalid('/parcel_id', 'parcel_not_allowed');
      if (!open)
        throw conflict(closedRule(intake.state), 'The intake is not cleared for itemization');
      return;
    }
    if (parcelId === undefined) throw invalid('/parcel_id', 'parcel_required');
    const found = await tx.execute(
      sql`select state from intake_parcel where id = ${parcelId}::uuid and pickup_intake_id = ${id}::uuid`,
    );
    const parcel = found.rows[0] as { state: string } | undefined;
    if (parcel === undefined) throw invalid('/parcel_id', 'unknown_parcel');
    if (parcel.state === 'VOID')
      throw conflict('parcel_void', 'A parcel that was taken back has no order');
    if (parcel.state === 'MISSING') {
      throw conflict('parcel_missing', 'A parcel that is missing is never priced or dispatched');
    }
    const ordered = await tx.execute(
      sql`select 1 from "order" where intake_parcel_id = ${parcelId}::uuid limit 1`,
    );
    if (ordered.rows.length > 0) throw conflict('parcel_ordered', 'A parcel has one order');
    if (parcel.state === 'EXPECTED' && intake.state !== 'AWAITING_COUNT') {
      throw conflict('check_in_finished', 'The vendor’s check-in is finished');
    }
    if (parcel.state === 'ARRIVED' && !open) {
      throw conflict(
        intake.state === 'AWAITING_COUNT' ? 'check_in_open' : closedRule(intake.state),
        'An order for a parcel that has arrived is made once the vendor is cleared',
      );
    }
  }

  /** What the order is made from, as the database says it: the moment custody passed is read from the stop's collection and never given (`COMMITMENT_SOURCE_UNRESOLVED` when it cannot be read). */
  async #sourceOf(
    tx: ReturnType<typeof transactionOf>,
    id: string,
  ): Promise<Source & { readonly custody_at: string | Date }> {
    const found = await tx.execute(
      sql`select responsible_hub_id, origin_location, acknowledged_at_booking, custody_at from melarc.itemization_source(${id}::uuid)`,
    );
    const source = found.rows[0] as unknown as Source | undefined;
    if (source === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
    if (source.custody_at === null) {
      throw ApiException.of(
        ErrorCode.CommitmentSourceUnresolved,
        'The moment pickup custody passed cannot be read, so no delivery can be promised',
      );
    }
    return { ...source, custody_at: source.custody_at };
  }

  /**
   * The origin zone of the order, **resolved once for the request** (`AC-SLICE-001-57`): the first order of an intake resolves it from the place the request was collected at, and every later one carries
   * the same snapshot. **It is no longer a pricing input** (domain-model.md §6.7), so a place the server cannot place is recorded as unresolved and does not refuse the order (a reading: itemization.md
   * §5.1 step 2 says pricing waits for both zones, the domain model says the origin is kept for reporting and disputes, and the contract's body has no way to authorize an origin).
   */
  async #originOf(
    tx: ReturnType<typeof transactionOf>,
    intakeId: string,
    config: HubConfiguration,
    location: Source['origin_location'],
  ): Promise<Record<string, unknown>> {
    const first = await tx.execute(
      sql`select origin_zone_snapshot from "order" where pickup_intake_id = ${intakeId}::uuid order by created_at, id limit 1`,
    );
    const carried = (first.rows[0] as { origin_zone_snapshot?: unknown } | undefined)
      ?.origin_zone_snapshot;
    if (carried !== undefined && carried !== null) {
      return (typeof carried === 'string' ? JSON.parse(carried) : carried) as Record<
        string,
        unknown
      >;
    }
    const place = (typeof location === 'string' ? JSON.parse(location) : location) as {
      address?: unknown;
      landmark?: unknown;
    } | null;
    const address = typeof place?.address === 'string' ? place.address : '';
    const resolved = resolveZone(config, {
      address,
      ...(typeof place?.landmark === 'string' ? { landmark: place.landmark } : {}),
    });
    if (resolved.kind === 'RESOLVED') {
      return {
        scope: 'SERVICE_AREA',
        zone_id: resolved.zone.id,
        zone_code: resolved.zone.code,
        zone_name: resolved.zone.name,
        service_area: resolved.zone.serviceArea,
        ...(resolved.alias === undefined ? {} : { alias: resolved.alias }),
      };
    }
    return { scope: 'UNRESOLVED', reason: resolved.kind };
  }

  /** An operational code for the order that no other order has (`ORD`-style, with the hub's own prefix): the unique key is the backstop of the rare collision. */
  async #codeOf(tx: ReturnType<typeof transactionOf>, config: HubConfiguration): Promise<string> {
    const prefix = hubCodeOf(config.hubName ?? '');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = operationalCode(prefix, 'OR');
      const taken = await tx.execute(sql`select 1 from "order" where code = ${code} limit 1`);
      if (taken.rows.length === 0) return code;
    }
    throw new Error('No unused operational code was found for the order');
  }

  /** A refusal of the order's own price and promise, as the answer the contract names; anything else is not one and is rethrown by the caller. */
  #refusal(error: unknown): ApiException | undefined {
    if (error instanceof OrderRuleRefusal) {
      switch (error.code) {
        case 'SIZE_CLASS_REQUIRED':
          return ApiException.of(ErrorCode.SizeClassRequired, error.message, { rule: error.rule });
        case 'VALUE_DECLARATION_REQUIRED':
          return ApiException.of(ErrorCode.ValueDeclarationRequired, error.message, {
            rule: error.rule,
          });
        case 'REASON_REQUIRED':
          return ApiException.of(ErrorCode.ReasonRequired, error.message, { rule: error.rule });
        case 'SETTING_MISSING':
          // The business answer of a hub-settings path, `422` (errors-and-enums.md §4, decided with this operation).
          return ApiException.of(ErrorCode.SettingMissing, error.message, { rule: error.rule });
        case 'VALIDATION_FAILED':
          return invalid(POINTER_OF_RULE[error.rule] ?? '/', error.rule, error.details);
      }
    }
    if (error instanceof PricingRefusal) {
      switch (error.code) {
        case 'SETTING_MISSING':
          return ApiException.of(ErrorCode.SettingMissing, error.message);
        case 'MARGIN_NOT_CONFIGURED':
          return ApiException.of(ErrorCode.MarginNotConfigured, error.message);
        case 'SIZE_CLASS_REQUIRED':
          return ApiException.of(ErrorCode.SizeClassRequired, error.message);
        case 'CARRIER_COST_REQUIRED':
          return ApiException.of(ErrorCode.CarrierCostRequired, error.message);
        case 'SERVICE_DATE_NOT_PERMITTED':
          return ApiException.of(ErrorCode.ServiceDateNotPermitted, error.message);
      }
    }
    return undefined;
  }

  /** What the database refused, as the answer the contract names (the guards of the order and of the commitment name the code in the DETAIL and the rule in the HINT). */
  #databaseRefusal(error: unknown): ApiException | undefined {
    if (guardReasonIn(error) === 'COMMITMENT_SOURCE_UNRESOLVED') {
      return ApiException.of(
        ErrorCode.CommitmentSourceUnresolved,
        'The moment pickup custody passed cannot be read, so no delivery can be promised',
      );
    }
    return receivingRefusalOf(error, '/parcel_id');
  }
}
