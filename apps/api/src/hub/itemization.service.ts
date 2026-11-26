import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { noteRefusal } from '../platform/audit/audit-record.js';
import { requiredNote } from '../platform/audit/required-note.js';
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
import { PricingRefusal, isHighValue } from '../pricing/price-calculation.js';
import { resolveZone, type LocationText } from '../pricing/zone-resolver.js';
import { receivingRefusalOf } from './check-in.service.js';
import { noteHubCrossing } from './hub-crossing.js';
import { hubIntakeEtagMatches } from './hub-intake-etag.js';
import { orderEtagMatches, orderEtagOf } from './order-reads.service.js';
import { loadOrder, orderViewOf, type OrderRow, type OrderView } from './order-view.js';
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

/**
 * The body of `itemizeOrder` and of `previewOrder` as the contract's schema has validated it (the interceptor ran before this). `reviewed_terms` is the `terms_token` of the preview the officer read: the save
 * is made only when what confirming gives now is what that preview said (the review of 20 November 2026, finding 3); a preview takes none.
 */
export interface ItemizeBody {
  readonly reviewed_terms?: string;
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

/**
 * The body of `amendOrder` (Stage 7): a patch of what was transcribed, with the reason in words. A member that is not named is kept; `null` clears one that may be empty (the carrier's cost with its waybill, the
 * order's own payer arrangement, the declared value, the serial, the requested date, the authorization of a destination).
 */
export interface AmendBody {
  readonly note: string;
  /** The `terms_token` of the amendment's preview the officer read (the review of 20 November 2026, finding 3). */
  readonly reviewed_terms?: string;
  readonly recipient?: ItemizeBody['recipient'];
  readonly size_class?: ItemizeBody['size_class'];
  readonly carrier_cost?: ItemizeBody['carrier_cost'] | null;
  readonly carrier_waybill_evidence_id?: string | null;
  readonly is_high_value?: boolean;
  readonly lane?: ItemizeBody['lane'];
  readonly commercial_mode?: ItemizeBody['commercial_mode'] | null;
  readonly payer_override?: ItemizeBody['payer_override'] | null;
  readonly declared_value_minor?: number | null;
  readonly is_serialized_goods?: boolean;
  readonly serial_imei?: string | null;
  readonly requested_delivery_date?: string | null;
  readonly destination_zone_authorization?: ItemizeBody['destination_zone_authorization'] | null;
  readonly evidence_ids?: readonly string[];
}

/** The location an order holds: the text, and the place it may carry. */
interface StoredLocation {
  readonly address: string;
  readonly landmark?: string;
  readonly map_link?: string;
  readonly latitude?: number;
  readonly longitude?: number;
}

/**
 * The body of `correctOrderRecipient` (Run F, D-S7-1): the recipient's name, phone and address as they are now to be, any of the three, and the reason in words. A member that is not given stays as it was.
 */
export interface RecipientCorrectionBody {
  readonly note: string;
  readonly recipient: {
    readonly name?: string;
    readonly phone?: string;
    /** The text of the address and its landmark, and nothing else: the place it may carry (a map link, coordinates) is the order's own and does not move with a correction. */
    readonly location?: { readonly address: string; readonly landmark?: string };
  };
}

/** The order as it now stands and the `ETag` of what `getOrder` shows of it. */
export interface AmendResult {
  readonly order: OrderView;
  readonly etag: string;
}

interface PayerPreviewRow {
  readonly source: 'ORDER' | 'REQUEST';
  readonly payer_intent: string;
  readonly sender_minor: number | string;
  readonly recipient_minor: number | string;
  readonly commercial_state: 'NO_VENDOR_CHARGE' | 'PAYMENT_REQUIRED';
}

/** The body of `previewOrderAmendment`: what an amendment says, without the reason (a preview writes nothing) and without the token it will be given. */
export type AmendPreviewBody = Omit<AmendBody, 'note' | 'reviewed_terms'> & {
  readonly note?: string;
};

/** The evidence an order cites, by identity: the records of a high-value parcel and the photograph of the carrier's waybill. */
export interface CitedEvidence {
  readonly high_value: readonly string[];
  readonly carrier_waybill: string | null;
}

/** The money the preview and an order's quote speak in. */
interface MoneyView {
  readonly amount_minor: number;
  readonly currency: 'GHS';
}

const TERMS_DOMAIN = 'melarc.order-terms.v1';

/**
 * What confirming an order would give, calculated by the server and written nowhere (`previewOrder`, `previewOrderAmendment`). **`terms_token` is the digest of everything the officer is shown but
 * `current`**, and the save takes it back as `reviewed_terms`: a change of the rates, the payer arrangement, the promise or the evidence between the preview and the save is a different token, and the save is
 * refused (`STATE_CONFLICT`, rule `terms_changed`) with the terms as they are now, for the officer to read again.
 */
export interface OrderPreviewView {
  readonly intake_id: string;
  readonly parcel_id: string | null;
  /** The order the preview is of an amendment of; null for an order that is not made yet. */
  readonly order_id: string | null;
  /** The version of that order the preview was made on; null with it. */
  readonly order_version: number | null;
  /** What this is, in a word, beside an early quote and a frozen price: the terms as they are calculated now. */
  readonly status: 'CURRENT_PREVIEW';
  readonly validation: { readonly evidence: 'NONE_CITED' | 'VERIFIED' };
  /** The records the order cites, by identity (sorted, lower case): the officer is asked again when a record is another, though each is as valid as the one before it (the review of 21 November 2026, finding 2). */
  readonly cited_evidence: CitedEvidence;
  readonly will_confirm: 'ON_CONFIRMATION' | 'WHEN_ARRIVAL_IS_COMMITTED';
  readonly quote_policy: 'PROTECTED_UNTIL_AMENDED';
  readonly price: {
    readonly total: { readonly amount_minor: number; readonly currency: 'GHS' };
    readonly components: readonly {
      readonly kind: string;
      readonly amount: { readonly amount_minor: number; readonly currency: 'GHS' };
    }[];
  };
  readonly is_high_value: boolean;
  readonly high_value_surcharge: { readonly amount_minor: number; readonly currency: 'GHS' } | null;
  readonly destination_zone_snapshot: Record<string, unknown>;
  readonly destination_zone_resolution: 'SERVER_RESOLVED' | 'EXPLICITLY_AUTHORIZED';
  readonly delivery: {
    readonly default_date: string;
    readonly requested_date: string | null;
    readonly committed_date: string;
    readonly window_start: string | null;
    readonly window_end: string | null;
  };
  readonly payer: {
    readonly source: 'ORDER' | 'REQUEST';
    readonly payer_intent: string;
    readonly sender: { readonly amount_minor: number; readonly currency: 'GHS' };
    readonly recipient: { readonly amount_minor: number; readonly currency: 'GHS' };
    readonly commercial_state_after_confirmation: 'NO_VENDOR_CHARGE' | 'PAYMENT_REQUIRED';
  };
  /** Of the preview of an amendment: the early quote the order holds now, so that the difference is shown and not rebuilt. Not part of the terms the token is of. */
  readonly current: {
    readonly total: MoneyView;
    readonly is_high_value: boolean;
    readonly derived_delivery_date: string | null;
    readonly destination_zone_resolution: string;
    /** The evidence the order cites now, to be read beside the evidence of the amendment. */
    readonly cited_evidence: CitedEvidence;
  } | null;
  /** The digest of the terms above: what the save is given back as `reviewed_terms`. */
  readonly terms_token: string;
}

/** The token of terms: a digest of the terms as calculated, in the one order in which they are built. */
export function termsTokenOf(terms: Omit<OrderPreviewView, 'terms_token' | 'current'>): string {
  return createHash('sha256')
    .update(JSON.stringify([TERMS_DOMAIN, terms]), 'utf8')
    .digest('hex');
}

/** A value as text, each string trimmed and each object's members in order: two places that differ by spacing alone are the same place. */
function canonical(value: unknown): string {
  const normal = (each: unknown): unknown => {
    if (typeof each === 'string') return each.trim();
    if (Array.isArray(each)) return each.map(normal);
    if (each !== null && typeof each === 'object') {
      return Object.fromEntries(
        Object.entries(each)
          .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, member]) => [key, normal(member)]),
      );
    }
    return each;
  };
  return JSON.stringify(normal(value));
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

/**
 * The hub's configuration moved while a save waited for its locks (the review of 21 November 2026, finding 5): the save is taken back and made again on the configuration as it is. Never leaves the service.
 */
class ConfigurationMoved extends Error {
  constructor() {
    super('The hub’s configuration changed while the save waited for its locks');
  }
}

/** A save is made again on a configuration that moved while it waited, this many times at most: three changes of the hub's rates in the milliseconds of one save is not a thing to wait for. */
const CONFIGURATION_ATTEMPTS = 3;

/** Where a rule of the order's own pricing is about, in the body, for the violation it is answered as. */
const POINTER_OF_RULE: Readonly<Record<string, string>> = {
  destination_zone_resolved: '/destination_zone_authorization',
  destination_zone_ambiguous: '/recipient/location',
  destination_zone_not_available: '/destination_zone_authorization/zone_id',
  requested_before_default: '/requested_delivery_date',
};

/** What `itemizeOrder` answers: the order, and the vendor's token after it (the `Intake-ETag` header of the answer). */
export interface MadeOrder {
  readonly order: OrderView;
  readonly intakeEtag: string;
}

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
 * - **Made only on terms the officer was shown** (the review of 20 November 2026, finding 3): the body carries `reviewed_terms`, the `terms_token` of `previewOrder`; the terms are calculated again here, after the
 *   states and the price and **under the lock on the request's payer arrangement that the freeze takes** (`melarc.hold_request_payer`, finding 2), and a token that is not theirs is `STATE_CONFLICT`, rule `terms_changed`,
 *   with the terms as they are (`details.current_terms`). The preview and the save are one calculation (`#termsOf`), so they cannot disagree about what they judge.
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
  ): Promise<MadeOrder> {
    const { runner, audit, idempotency, clock } = this.#options;
    this.#requireStaff(authorized);
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
    const { body } = request;
    const checked = this.#checked(body);
    // An order is made only on terms the officer reviewed (a preview's `terms_token`): a body without one is not a request to confirm what was not shown.
    if (body.reviewed_terms === undefined) throw invalid('/reviewed_terms', 'required');
    const staff = authorized.session.principalId.toLowerCase();

    // The hub of the intake is found in a short transaction of its own, the configuration of that hub is read next (as the booking does), and the transaction that acts runs last and judges the hub again.
    const hubId = await runner.mutate(authorized, correlationId, (handle) =>
      this.#hubOf(handle, id),
    );
    return this.#whileConfigurationHolds(hubId, (config) =>
      runner.mutate(authorized, correlationId, async (handle) => {
        const tx = transactionOf(handle);
        const scope = {
          principalType: 'STAFF',
          principalId: staff,
          operationId: OPERATION,
          key: request.idempotencyKey,
        } as const;
        const begun = await idempotency.begin(handle, scope, request.fingerprint);
        if (begun.outcome === 'REPLAY') {
          // The order is the first answer; the vendor's token is the one it has now, which is what the next order is made on.
          return {
            order: JSON.parse(Buffer.from(begun.response.body).toString('utf8')) as OrderView,
            intakeEtag: await this.#intakeEtag(handle, authorized, id),
          };
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
        // The request's payer arrangement is held next, and only then is the configuration compared: a save that waits for the payer (an edit of it is in progress) must not carry the rates it read before it waited
        // (the review of 22 November 2026, finding 5, the third case). Both locks are held to the end of the transaction.
        await this.#holdPayer(tx, id);
        // The rates, zones, aliases and company rules the price is calculated from are the hub's as they are in force now that the save holds both locks, and not as they were when it began to wait.
        await this.#requireConfigurationCurrent(tx, hubId, config);
        const parcelId = body.parcel_id === undefined ? undefined : body.parcel_id.toLowerCase();
        const parcelState = await this.#judgeStates(tx, intake, id, parcelId);

        const source = await this.#sourceOf(tx, id);
        const custodyAt = new Date(source.custody_at);

        // The order's price and promise, or the refusal, in the order of the pure assembly.
        const priced = this.#pricedOf(
          config,
          body,
          checked,
          source.acknowledged_at_booking,
          custodyAt,
        );
        // What confirming gives now, calculated under the lock of the request's payer arrangement (the freeze takes the same lock), against what the officer reviewed: a rate, a payer, a promise or a piece
        // of evidence that changed since the preview is a different token, and nothing is made (the review of 20 November 2026, findings 2 and 3).
        const terms = await this.#termsOf(tx, {
          intakeId: id,
          parcelId: parcelId ?? null,
          parcelState,
          priced,
          checked,
          waybill: body.carrier_waybill_evidence_id,
          order: null,
        });
        this.#requireReviewed(body.reviewed_terms, terms);

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
          is_high_value_manual: body.is_high_value === true,
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
        // The vendor's token after this order: the first order of a cleared vendor moves it from ready to being worked, and the screen makes the next order on this one with no read between.
        return { order: view, intakeEtag: await this.#intakeEtag(handle, authorized, id) };
      }),
    );
  }

  /**
   * Makes a save on the hub's configuration as it is when the save holds its locks: the configuration is read before the transaction (the reader may not run inside one), the transaction compares its fingerprint
   * again once it holds the intake **and the request's payer** (the configuration in force at that moment: a version that took effect while the save waited, a change that committed meanwhile, a company rule that
   * changed), and a configuration that moved is read again and the save made again (the reviews of 21 and 22 November 2026, finding 5; the terms the officer reviewed are compared on the new one, so a rate that
   * moved is `terms_changed`, with the new terms, and a rule that now refuses the order refuses it with its own code). After three moves the answer is `STATE_CONFLICT`, rule `configuration_changing`: the screen
   * keeps the form and offers a new preview. A retry begins afresh: the attempt that was taken back left no idempotency record.
   */
  async #whileConfigurationHolds<T>(
    hubId: string,
    work: (config: HubConfiguration) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= CONFIGURATION_ATTEMPTS; attempt += 1) {
      const config = await this.#options.configuration.forHub(hubId, undefined, true);
      try {
        return await work(config);
      } catch (error) {
        if (!(error instanceof ConfigurationMoved)) throw error;
      }
    }
    throw conflict(
      'configuration_changing',
      'The hub’s rates are being changed: try again in a moment',
    );
  }

  /**
   * Whether the configuration the save was given is still the one in force now that the save holds the intake and the request's payer (`melarc.hub_configuration_fingerprint`, migration `0120`): the digest of the
   * versions in force **at this moment** (`clock_timestamp()`, not the transaction's start: a version that took effect while the save waited is in force now), of the zones and aliases and of the company rules.
   * Another digest is a configuration that moved, and the save is made again on the new one.
   */
  async #requireConfigurationCurrent(
    tx: ReturnType<typeof transactionOf>,
    hubId: string,
    config: HubConfiguration,
  ): Promise<void> {
    if (config.fingerprint === undefined) return;
    const now = (
      await tx.execute(
        sql`select melarc.hub_configuration_fingerprint(${hubId}::uuid, clock_timestamp()) as fingerprint`,
      )
    ).rows[0] as { fingerprint?: string } | undefined;
    if (now?.fingerprint !== config.fingerprint) throw new ConfigurationMoved();
  }

  /** The request's payer arrangement, held for share to the end of the transaction (the lock the freeze takes), after the intake's: what is calculated and compared below is of one arrangement. */
  async #holdPayer(tx: ReturnType<typeof transactionOf>, intakeId: string): Promise<void> {
    try {
      await tx.execute(sql`select melarc.hold_request_payer(${intakeId}::uuid)`);
    } catch (error) {
      throw this.#databaseRefusal(error) ?? error;
    }
  }

  /**
   * `previewOrder` (Stage 7; the external review of 19 November 2026, step 3 of the flow; `hub.intake.itemize`): **what confirming would give, calculated by the server and written nowhere**. It judges the body and
   * the states exactly as `itemizeOrder` does (so a preview that is answered is an order that would be made, and every refusal an officer would meet is met here first), and answers the price with each of its
   * components, the surcharge of a high-value parcel, the promise, **who pays each amount**, the state the commercial gate would take the order to, and when the order would be confirmed. Nothing is written but
   * the audit of a read of another hub; no `Idempotency-Key` and no `If-Match` are taken, since nothing changes. The browser never calculates any of this.
   */
  async preview(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    body: ItemizeBody,
  ): Promise<OrderPreviewView> {
    const { runner, audit, configuration } = this.#options;
    this.#requireStaff(authorized);
    const checked = this.#checked(body);
    const hubId = await runner.mutate(authorized, correlationId, (handle) =>
      this.#hubOf(handle, id),
    );
    const config = await configuration.forHub(hubId);
    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const found = await tx.execute(
        sql`select ${RECEIVING_INTAKE_COLUMNS} from pickup_intake where id = ${id}::uuid`,
      );
      const intake = found.rows[0] as unknown as ReceivingIntakeRow | undefined;
      if (intake === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      if (intake.responsible_hub_id.toLowerCase() !== hubId) {
        throw new Error('The hub of the intake changed while the order was previewed');
      }
      await noteHubCrossing(audit, handle, authorized, intake);
      const parcelId = body.parcel_id === undefined ? undefined : body.parcel_id.toLowerCase();
      const parcelState = await this.#judgeStates(tx, intake, id, parcelId);
      const source = await this.#sourceOf(tx, id);
      const priced = this.#pricedOf(
        config,
        body,
        checked,
        source.acknowledged_at_booking,
        new Date(source.custody_at),
      );
      // A preview takes no lock and writes nothing: it is of one moment, and the save is made of the same terms and judges them again.
      return this.#termsOf(tx, {
        intakeId: id,
        parcelId: parcelId ?? null,
        parcelState,
        priced,
        checked,
        waybill: body.carrier_waybill_evidence_id,
        order: null,
      });
    });
  }

  /**
   * `previewOrderAmendment` (the review of 20 November 2026, finding 3; `hub.intake.itemize`): **what an amendment would give, calculated by the server and written nowhere**, of an order that is not yet
   * confirmed. It judges the order and the patch exactly as `amendOrder` does (a confirmed order, an intake that is closed and a parcel that is missing or taken back are refused here first), and answers what
   * `previewOrder` answers of an order that is not made yet, with the quote the order holds now (`current`) beside it. No `Idempotency-Key`, no `If-Match` and no reason are taken: nothing changes.
   */
  async previewAmendment(
    authorized: AuthorizedRequest,
    correlationId: string,
    orderId: string,
    patch: AmendPreviewBody,
  ): Promise<OrderPreviewView> {
    const { runner, configuration } = this.#options;
    this.#requireStaff(authorized);
    const hubId = await runner.mutate(authorized, correlationId, (handle) =>
      this.#hubOfOrder(handle, orderId),
    );
    const config = await configuration.forHub(hubId);
    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const plan = await this.#planAmendment(handle, tx, authorized, hubId, config, orderId, patch);
      return plan.terms;
    });
  }

  async #payerPreview(
    tx: ReturnType<typeof transactionOf>,
    intakeId: string,
    totalMinor: number,
    override: Readonly<Record<string, unknown>> | null,
  ): Promise<PayerPreviewRow> {
    let found;
    try {
      found = await tx.execute(
        sql`select source, payer_intent, sender_minor, recipient_minor, commercial_state from melarc.payer_preview(${intakeId}::uuid, ${totalMinor}::integer, ${JSON.stringify(override)}::jsonb)`,
      );
    } catch (error) {
      throw this.#databaseRefusal(error) ?? error;
    }
    const row = found.rows[0] as unknown as PayerPreviewRow | undefined;
    if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
    return row;
  }

  /**
   * What confirming would give, calculated from the facts: **the one place the officer's review and the save are made of**. The evidence the order cites is judged by the database as the guard of the order will judge
   * it (a preview that is answered is an order that would not be refused for its evidence), the payer arrangement is calculated (a save has taken the request's lock before it gets here, `#holdPayer`: the freeze
   * reads the same arrangement under the same lock), and the digest of what is shown is the token the save is given back.
   */
  async #termsOf(
    tx: ReturnType<typeof transactionOf>,
    given: {
      readonly intakeId: string;
      readonly parcelId: string | null;
      readonly parcelState: string | undefined;
      readonly priced: PricedOrder;
      readonly checked: Checked;
      readonly waybill: string | undefined;
      /** The order an amendment is of, as it stands (an order that is not made yet has none). */
      readonly order: {
        readonly id: string;
        readonly version: number;
        readonly view: OrderView;
      } | null;
    },
  ): Promise<OrderPreviewView> {
    const { intakeId, parcelId, parcelState, priced, checked, order } = given;
    const cited = [
      ...checked.evidence,
      ...(given.waybill === undefined ? [] : [given.waybill.toLowerCase()]),
    ];
    const evidence = await this.#evidenceStatus(tx, intakeId, cited);
    const payer = await this.#payerPreview(
      tx,
      intakeId,
      priced.price.totalMinor,
      checked.payerOverride,
    );
    const money = (amountMinor: number): MoneyView => ({
      amount_minor: amountMinor,
      currency: 'GHS',
    });
    const surcharge = priced.snapshot.components.find(
      (component) => component.kind === 'HIGH_VALUE_SURCHARGE',
    );
    const terms: Omit<OrderPreviewView, 'terms_token' | 'current'> = {
      intake_id: intakeId,
      parcel_id: parcelId,
      order_id: order?.id ?? null,
      order_version: order?.version ?? null,
      status: 'CURRENT_PREVIEW',
      validation: { evidence },
      cited_evidence: {
        high_value: [...new Set(checked.evidence)].toSorted(),
        carrier_waybill: given.waybill === undefined ? null : given.waybill.toLowerCase(),
      },
      // An order for a parcel that has arrived (or for a blind count) is confirmed when it is made; one for a parcel not yet checked in, when the arrival can no longer be taken back. **An amendment confirms
      // nothing** (it leaves the quote an early quote, whatever the parcel's state): the order is final when the act that commits the arrival confirms it (the review of 21 November 2026, finding 3).
      will_confirm:
        order !== null || parcelState === 'EXPECTED'
          ? 'WHEN_ARRIVAL_IS_COMMITTED'
          : 'ON_CONFIRMATION',
      // The price an order for a parcel that waits is made at is kept until the officer amends the order, whatever the rates become meanwhile (the owner's reading, OB-S1-148).
      quote_policy: 'PROTECTED_UNTIL_AMENDED',
      price: {
        total: money(priced.snapshot.total_minor),
        components: priced.snapshot.components.map((component) => ({
          kind: component.kind,
          amount: money(component.amount_minor),
        })),
      },
      is_high_value: priced.isHighValue,
      high_value_surcharge: surcharge === undefined ? null : money(surcharge.amount_minor),
      destination_zone_snapshot: priced.destinationSnapshot as unknown as Record<string, unknown>,
      destination_zone_resolution: priced.destinationResolution,
      delivery: {
        default_date: priced.dates.defaultDate,
        requested_date: priced.dates.requestedDate ?? null,
        committed_date: priced.dates.committedDate,
        window_start: priced.window.start ?? null,
        window_end: priced.window.end ?? null,
      },
      payer: {
        source: payer.source,
        payer_intent: payer.payer_intent,
        sender: money(Number(payer.sender_minor)),
        recipient: money(Number(payer.recipient_minor)),
        commercial_state_after_confirmation: payer.commercial_state,
      },
    };
    const before = order?.view;
    return {
      ...terms,
      current:
        before === undefined
          ? null
          : {
              total: money(
                (before.price_components_snapshot as { total_minor?: number }).total_minor ?? 0,
              ),
              is_high_value: before.is_high_value,
              derived_delivery_date: before.derived_delivery_date,
              destination_zone_resolution: before.destination_zone_resolution,
              cited_evidence: {
                high_value: [...before.high_value_evidence_ids]
                  .map((each) => each.toLowerCase())
                  .toSorted(),
                carrier_waybill: before.carrier_waybill_evidence_id?.toLowerCase() ?? null,
              },
            },
      terms_token: termsTokenOf(terms),
    };
  }

  /** What the database says of the evidence an order cites, before the order is made: the answer is the guard's own, so a preview refuses what the save would refuse. */
  async #evidenceStatus(
    tx: ReturnType<typeof transactionOf>,
    intakeId: string,
    cited: readonly string[],
  ): Promise<'NONE_CITED' | 'VERIFIED'> {
    if (cited.length === 0) return 'NONE_CITED';
    try {
      await tx.execute(
        sql`select melarc.evidence_citable(${intakeId}::uuid, ARRAY(SELECT pg_catalog.jsonb_array_elements_text(${JSON.stringify(cited)}::jsonb))::uuid[])`,
      );
    } catch (error) {
      throw this.#databaseRefusal(error, '/evidence_ids') ?? error;
    }
    return 'VERIFIED';
  }

  /**
   * The officer reviewed these terms, or others: `STATE_CONFLICT`, rule `terms_changed`, with the terms as they are now (`current_terms`, the answer a preview gives), so that the officer reads the difference and
   * confirms again. A save that was given no token is refused by the schema before it gets here.
   */
  #requireReviewed(given: string | undefined, terms: OrderPreviewView): void {
    if (given === terms.terms_token) return;
    throw ApiException.of(
      ErrorCode.StateConflict,
      'What confirming gives is not what was reviewed: the terms are shown again',
      { rule: 'terms_changed', current_terms: terms },
    );
  }

  /** The hub of the order, in the caller's hubs (a miss is `NOT_FOUND`). */
  async #hubOfOrder(handle: TransactionHandle, orderId: string): Promise<string> {
    const found = await transactionOf(handle).execute(
      sql`select responsible_hub_id from "order" where id = ${orderId}::uuid`,
    );
    const hub = (found.rows[0] as { responsible_hub_id?: string } | undefined)?.responsible_hub_id;
    if (typeof hub !== 'string') throw ApiException.of(ErrorCode.NotFound, 'Not found');
    return hub.toLowerCase();
  }

  /** The order's price and promise from the facts, or the refusal: the one place `itemizeOrder`, `previewOrder` and `amendOrder` judge them. */
  #pricedOf(
    config: HubConfiguration,
    body: ItemizeBody,
    checked: Checked,
    acknowledgedAtBooking: boolean,
    custodyAt: Date,
  ): PricedOrder {
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
      acknowledgedAtBooking,
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
    return priced;
  }

  /**
   * `amendOrder` (Stage 7; the external review of 19 November 2026, findings B and C; `hub.intake.itemize`): **an order is prepared before it is confirmed**. While its price is not frozen, an officer corrects what
   * was transcribed (the recipient, the size, the declaration, the date, the destination, the payer arrangement of the order, the evidence), **on the version of the order that was read** (`If-Match`, the `ETag` of
   * `getOrder`), with a reason in words, and the server **recalculates the price, the promise and the zone from the corrected facts** (the amendment is the explicit refresh of a calculated price: a price that waits
   * for its parcel is otherwise kept as it was calculated, OB-S1-148). A member that is not named is kept; `null` clears one that may be empty.
   *
   * - **A confirmed order is never edited** (`STATE_CONFLICT`, rule `order_confirmed`: a payer change is then a correction and a mistaken arrival a reversal), nor one of a closed intake or of a parcel that is
   *   missing or taken back. The intake is locked first and the order second, and **the freeze and the amendment take the same row lock**, so they cannot disagree about which price or payer arrangement won.
   * - **Recorded**: the members that changed, each as it was and as it became, in `order_amendment`, which the guard of the order requires beside any change of what was transcribed; the event `order.amendment.recorded`
   *   (enhanced) names the members and the price before and after, and no value of a person.
   * - A retry under the same `Idempotency-Key` makes nothing twice.
   */
  async amend(
    authorized: AuthorizedRequest,
    correlationId: string,
    orderId: string,
    request: {
      readonly body: AmendBody;
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<AmendResult> {
    const { runner, audit, idempotency, clock } = this.#options;
    this.#requireStaff(authorized);
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
    // The reason and the reviewed terms are required of a save and not of its preview, which shares the body's schema: told here, by the member, as the schema would tell them.
    if ((request.body as { note?: string }).note === undefined) throw invalid('/note', 'required');
    const note = requiredNote(request.body.note, '/note');
    if (request.body.reviewed_terms === undefined) throw invalid('/reviewed_terms', 'required');
    const staff = authorized.session.principalId.toLowerCase();
    const hubId = await runner.mutate(authorized, correlationId, (handle) =>
      this.#hubOfOrder(handle, orderId),
    );
    return this.#whileConfigurationHolds(hubId, (config) =>
      runner.mutate(authorized, correlationId, async (handle) => {
        const tx = transactionOf(handle);
        const scope = {
          principalType: 'STAFF',
          principalId: staff,
          operationId: 'amendOrder',
          key: request.idempotencyKey,
        } as const;
        const begun = await idempotency.begin(handle, scope, request.fingerprint);
        if (begun.outcome === 'REPLAY') {
          return JSON.parse(Buffer.from(begun.response.body).toString('utf8')) as AmendResult;
        }
        if (begun.outcome === 'CONFLICT') {
          throw ApiException.of(
            ErrorCode.IdempotencyKeyConflict,
            'That Idempotency-Key was used with a different request',
          );
        }
        if (begun.outcome !== 'NEW')
          throw new Error('An idempotency record of this command is stranded');

        // The intake is held before anything of the order is read, as the save of an order holds it: the version, the states, the rates and the terms below are those of the moment the save holds its locks (the
        // review of 21 November 2026, finding 5), and an act that is ahead of this one has finished.
        const intakeId = await this.#holdIntakeOfOrder(tx, orderId);
        // And the request's payer next, as the save of an order does, before the rates are compared (the review of 22 November 2026, finding 5): a wait for the payer is a wait the rates may move in.
        await this.#holdPayer(tx, intakeId);
        await this.#requireConfigurationCurrent(tx, hubId, config);
        // The order, the patch and what they give, judged as the preview of the amendment judges them: the version the officer read first, then the states, then the price. The terms the officer reviewed
        // are compared with the terms as they are now before anything is written (the review of 20 November 2026, finding 3).
        const plan = await this.#planAmendment(
          handle,
          tx,
          authorized,
          hubId,
          config,
          orderId,
          request.body,
          {
            ifMatch: request.ifMatch,
          },
        );
        this.#requireReviewed(request.body.reviewed_terms, plan.terms);
        const { row, before, merged, checked, priced } = plan;
        const given = {
          recipient: {
            name: merged.recipient.name.trim(),
            phone: checked.phone,
            phone_as_entered: merged.recipient.phone,
            location: merged.recipient.location,
          },
          destination_zone_snapshot: priced.destinationSnapshot,
          destination_zone_resolution: priced.destinationResolution,
          declared_value_minor: merged.declared_value_minor ?? null,
          is_serialized_goods: merged.is_serialized_goods === true,
          serial_imei: checked.serial,
          requested_delivery_date: priced.dates.requestedDate ?? null,
          derived_delivery_date: priced.dates.defaultDate,
          size_class: merged.size_class ?? null,
          carrier_cost_minor: merged.carrier_cost?.amount_minor ?? null,
          carrier_waybill_evidence_id: merged.carrier_waybill_evidence_id?.toLowerCase() ?? null,
          is_high_value: priced.isHighValue,
          is_high_value_manual: merged.is_high_value === true,
          high_value_evidence_ids: checked.evidence,
          lane: checked.lane,
          commercial_mode: checked.mode ?? null,
          payer_override: checked.payerOverride,
          price_components_snapshot: priced.snapshot,
          commitment: {
            default_date: priced.dates.defaultDate,
            requested_date: priced.dates.requestedDate ?? null,
            committed_date: priced.dates.committedDate,
            window_start: priced.window.start ?? null,
            window_end: priced.window.end ?? null,
          },
        };
        const amendmentId = randomUUIDv7(clock);
        try {
          await tx.execute(
            sql`select new_version from melarc.amend_order(${orderId}::uuid, ${Number(row.version)}::integer, ${amendmentId}::uuid, ${note}::text, ${JSON.stringify(given)}::jsonb)`,
          );
        } catch (error) {
          throw this.#databaseRefusal(error, '/') ?? error;
        }
        const stored = await loadOrder(tx, orderId);
        if (stored === undefined) throw new Error('An order that was amended could not be read');
        const view = orderViewOf(stored);
        const recorded = (
          await tx.execute(
            sql`select before, after from order_amendment where id = ${amendmentId}::uuid`,
          )
        ).rows[0] as { before: unknown; after: unknown } | undefined;
        const afterOf = (value: unknown): Record<string, unknown> =>
          typeof value === 'string'
            ? (JSON.parse(value) as Record<string, unknown>)
            : ((value ?? {}) as Record<string, unknown>);
        const changed = Object.keys(afterOf(recorded?.after)).toSorted();
        const related = {
          pickup_intake_id: stored.pickup_intake_id,
          order_amendment_id: amendmentId,
          ...(stored.intake_parcel_id === null
            ? {}
            : { intake_parcel_id: stored.intake_parcel_id }),
        };
        const totalBefore =
          (before.price_components_snapshot as { total_minor?: number }).total_minor ?? 0;
        await audit.write(handle, {
          code: 'order.amendment.recorded',
          enhanced: true,
          outcome: 'SUCCEEDED',
          note,
          object: { type: 'Order', id: orderId },
          responsibleHubId: hubId,
          relatedIds: related,
          beforeAfter: { total_minor: { before: totalBefore, after: priced.snapshot.total_minor } },
          detail: {
            changed: changed.join(','),
            awaiting_arrival: stored.intake_parcel_state === 'EXPECTED',
          },
        });
        await audit.write(handle, {
          code: 'pricing.price.calculated',
          enhanced: false,
          outcome: 'SUCCEEDED',
          object: { type: 'Order', id: orderId },
          responsibleHubId: hubId,
          relatedIds: related,
          detail: {
            total_minor: priced.price.totalMinor,
            components: priced.price.components.map((component) => component.kind).join(','),
            destination_resolution: priced.destinationResolution,
            committed_date: priced.dates.committedDate,
            high_value: priced.isHighValue,
            recalculated: true,
          },
        });
        if (changed.includes('size_class')) {
          await audit.write(handle, {
            code: 'pricing.size_class.selected',
            enhanced: true,
            outcome: 'SUCCEEDED',
            object: { type: 'Order', id: orderId },
            responsibleHubId: hubId,
            relatedIds: related,
            beforeAfter: {
              size_class: { before: before.size_class, after: String(merged.size_class) },
              size_class_selected_by: { before: before.size_class_selected_by, after: staff },
            },
            detail: { size_class: String(merged.size_class) },
          });
        }
        const answer: AmendResult = {
          order: view,
          etag: orderEtagOf(view, Number(stored.version)),
        };
        await idempotency.complete(handle, scope, {
          status: 200,
          body: new TextEncoder().encode(JSON.stringify(answer)),
        });
        return answer;
      }),
    );
  }

  /**
   * `correctOrderRecipient` (Run F, D-S7-1; `hub.intake.itemize`): **the recipient's name and phone of a CONFIRMED order are corrected, with a reason in words**, on the version of the order that was read (`If-Match`,
   * the `ETag` of `getOrder`: `stale`), with an `Idempotency-Key`. The old and the new recipient are kept in the amendment record, as an amendment keeps its values; **the audit event names the fields that changed and
   * never their values**. An **address** is corrected the same way when the server finds that its zone and its price come out as they are (the address still resolves to the zone the order was priced for, for an order
   * delivered to the door and placed by the server); one that moves the zone or the price is a request decided by a checker, on the pattern of the payer correction, which is **not built**: it is refused
   * (`STATE_CONFLICT`, rule `address_changes_zone`) and nothing changes. Refused once an order is paid for, reserved or dispatched (`order_progressed`, `order_dispatched`: none of the three exists yet), for an order
   * whose arrival was taken back (`order_reversed`) and for one that is not confirmed, which is amended with the order (`order_not_confirmed`). The database repeats every rule for every writer (migration 0124).
   */
  async correctRecipient(
    authorized: AuthorizedRequest,
    correlationId: string,
    orderId: string,
    request: {
      readonly body: RecipientCorrectionBody;
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<AmendResult> {
    const { runner, audit, idempotency, clock } = this.#options;
    this.#requireStaff(authorized);
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
    if ((request.body as { note?: string }).note === undefined) throw invalid('/note', 'required');
    const note = requiredNote(request.body.note, '/note');
    const patch = request.body.recipient;
    if (patch.name === undefined && patch.phone === undefined && patch.location === undefined) {
      throw invalid('/recipient', 'required');
    }
    if (patch.name?.trim() === '') throw invalid('/recipient/name', 'required');
    if (patch.location?.address.trim() === '') {
      throw invalid('/recipient/location/address', 'required');
    }
    const phone = patch.phone === undefined ? undefined : normalisePhone(patch.phone);
    if (patch.phone !== undefined && phone === undefined)
      throw invalid('/recipient/phone', 'format');
    const staff = authorized.session.principalId.toLowerCase();
    const hubId = await runner.mutate(authorized, correlationId, (handle) =>
      this.#hubOfOrder(handle, orderId),
    );
    return this.#whileConfigurationHolds(hubId, (config) =>
      runner.mutate(authorized, correlationId, async (handle) => {
        const tx = transactionOf(handle);
        const scope = {
          principalType: 'STAFF',
          principalId: staff,
          operationId: 'correctOrderRecipient',
          key: request.idempotencyKey,
        } as const;
        const begun = await idempotency.begin(handle, scope, request.fingerprint);
        if (begun.outcome === 'REPLAY') {
          return JSON.parse(Buffer.from(begun.response.body).toString('utf8')) as AmendResult;
        }
        if (begun.outcome === 'CONFLICT') {
          throw ApiException.of(
            ErrorCode.IdempotencyKeyConflict,
            'That Idempotency-Key was used with a different request',
          );
        }
        if (begun.outcome !== 'NEW')
          throw new Error('An idempotency record of this command is stranded');

        // The intake first, as every act on an order holds it; the rates only matter to an address, and are compared once the lock is held.
        await this.#holdIntakeOfOrder(tx, orderId);
        const row = await loadOrder(tx, orderId);
        if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
        if (
          !orderEtagMatches(request.ifMatch, orderEtagOf(orderViewOf(row), Number(row.version)))
        ) {
          throw conflict('stale', 'The order has changed since it was read');
        }
        if (patch.location !== undefined) {
          await this.#requireConfigurationCurrent(tx, hubId, config);
          this.#requireSameZone(config, row, patch.location);
        }
        await noteHubCrossing(audit, handle, authorized, {
          id: row.pickup_intake_id,
          responsible_hub_id: row.responsible_hub_id,
        });
        const stored = row.recipient as unknown as {
          name: string;
          phone: string;
          phone_as_entered?: string;
          location: StoredLocation;
        };
        const corrected = {
          ...stored,
          ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
          ...(patch.phone === undefined || phone === undefined
            ? {}
            : { phone, phone_as_entered: patch.phone }),
          ...(patch.location === undefined
            ? {}
            : { location: this.#correctedLocation(stored.location, patch.location) }),
        };
        const record = randomUUIDv7(clock);
        let done: { version: number | string; changed: string[] } | undefined;
        try {
          const result = await tx.execute(
            sql`select version, changed from melarc.correct_order_recipient(${orderId}::uuid, ${Number(row.version)}::integer, ${record}::uuid, ${note}::text, ${JSON.stringify(corrected)}::jsonb)`,
          );
          done = result.rows[0] as unknown as
            { version: number | string; changed: string[] } | undefined;
        } catch (error) {
          throw receivingRefusalOf(error, '/note') ?? error;
        }
        if (done === undefined) throw new Error('A correction that was made left no version');
        const after = await loadOrder(tx, orderId);
        if (after === undefined) throw new Error('A corrected order is not there to be read');
        const view = orderViewOf(after);
        // The fields that changed are named; their values are in the record, never in the event.
        await audit.write(handle, {
          code: 'order.amendment.recorded',
          enhanced: true,
          outcome: 'SUCCEEDED',
          note,
          object: { type: 'Order', id: orderId },
          responsibleHubId: hubId,
          relatedIds: { pickup_intake_id: row.pickup_intake_id, order_amendment_id: record },
          // An enhanced event states a before and an after: for the details of a person it states that the field was corrected and where the old and the new are (the amendment record), never the values.
          beforeAfter: Object.fromEntries(
            done.changed.map((field) => [
              `recipient_${field}`,
              { before: 'on record', after: 'corrected, both kept in the amendment record' },
            ]),
          ),
          detail: {
            kind: 'RECIPIENT_CORRECTION',
            changed: done.changed.map((field) => `recipient.${field}`).join(','),
            after_confirmation: true,
          },
        });
        const answer: AmendResult = { order: view, etag: orderEtagOf(view, Number(after.version)) };
        await idempotency.complete(handle, scope, {
          status: 200,
          body: new TextEncoder().encode(JSON.stringify(answer)),
        });
        return answer;
      }),
    );
  }

  /** The location an order holds with its text corrected: the members that are not text (a map link, coordinates) stay as they are, and a landmark that is not given is taken away. */
  #correctedLocation(
    stored: StoredLocation,
    patch: { readonly address: string; readonly landmark?: string },
  ): StoredLocation {
    // The place the order holds: every member of the location but its text.
    const place = Object.fromEntries(
      Object.entries(stored).filter(([member]) => member !== 'address' && member !== 'landmark'),
    );
    return {
      ...place,
      address: patch.address,
      ...(patch.landmark === undefined ? {} : { landmark: patch.landmark }),
    };
  }

  /**
   * An address is corrected on a confirmed order only when the server finds that its zone and its price come out as they are: the order is delivered to the door, the server placed it in the first place, and the new
   * address still resolves to that very zone (the flat fee of a zone's service area does not depend on the address). Anything else moves the zone or the price, which a checker decides and which is not built.
   */
  #requireSameZone(
    config: HubConfiguration,
    row: OrderRow,
    location: { readonly address: string; readonly landmark?: string },
  ): void {
    const snapshot = row.destination_zone_snapshot as { zone_id?: string };
    const stored = (row.recipient as unknown as { location: StoredLocation }).location;
    // Only the text of an address can differ here (the body carries nothing else and the place the order holds is kept), so an address that reads as it did is no change of where the order goes.
    if (
      stored.address === location.address &&
      (stored.landmark ?? '') === (location.landmark ?? '')
    ) {
      return;
    }
    // An order that holds a place (a map link, coordinates) goes where that place says, and a new text does not move it: that is a change of where it goes, which a checker decides.
    const holdsAPlace =
      stored.map_link !== undefined ||
      stored.latitude !== undefined ||
      stored.longitude !== undefined;
    const placed = resolveZone(config, location);
    if (
      holdsAPlace ||
      row.lane !== 'DOORSTEP' ||
      row.destination_zone_resolution !== 'SERVER_RESOLVED' ||
      snapshot.zone_id === undefined ||
      placed.kind !== 'RESOLVED' ||
      placed.zone.id !== snapshot.zone_id
    ) {
      throw conflict(
        'address_changes_zone',
        'This address is not provably in the zone the order was priced for: a change that moves the zone or the price is decided by a checker',
      );
    }
  }

  /** The intake of an order, held for update: an order is changed and ordered one act after another, the intake being the lock they share. An order that is not in the caller's hubs is one that does not exist. */
  async #holdIntakeOfOrder(tx: ReturnType<typeof transactionOf>, orderId: string): Promise<string> {
    const held = await tx.execute(
      sql`select i.id from pickup_intake as i where i.id = (select o.pickup_intake_id from "order" as o where o.id = ${orderId}::uuid) for update`,
    );
    const intakeId = (held.rows[0] as { id?: string } | undefined)?.id;
    if (typeof intakeId !== 'string') throw ApiException.of(ErrorCode.NotFound, 'Not found');
    return intakeId.toLowerCase();
  }

  /**
   * What an amendment is made of, judged in the order `amendOrder` judges it and answered by its preview as well: the order and the version the officer read (for a save), the states the database repeats
   * (a confirmed order, an intake that is closed, a parcel that is missing or taken back), the patch laid over the order, the price and promise that come of it, and the terms the officer is shown.
   */
  async #planAmendment(
    handle: TransactionHandle,
    tx: ReturnType<typeof transactionOf>,
    authorized: AuthorizedRequest,
    hubId: string,
    config: HubConfiguration,
    orderId: string,
    patch: AmendPreviewBody,
    save?: { readonly ifMatch: string | undefined },
  ): Promise<{
    readonly row: OrderRow;
    readonly before: OrderView;
    readonly merged: ItemizeBody;
    readonly checked: Checked;
    readonly priced: PricedOrder;
    readonly terms: OrderPreviewView;
  }> {
    const row = await loadOrder(tx, orderId);
    if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
    if (row.responsible_hub_id.toLowerCase() !== hubId) {
      throw new Error('The hub of the order changed while it was being amended');
    }
    const before = orderViewOf(row);
    if (
      save !== undefined &&
      !orderEtagMatches(save.ifMatch, orderEtagOf(before, Number(row.version)))
    ) {
      throw conflict('stale', 'The order has changed since it was read');
    }
    if (row.locked_price_minor !== null) {
      throw conflict(
        'order_confirmed',
        'An order whose price is frozen is confirmed: its payer arrangement is a correction and a mistaken arrival a reversal',
      );
    }
    // The states the database repeats when it amends, told here as well so that a preview refuses what a save would.
    const intakeState = (
      (
        await tx.execute(
          sql`select state from pickup_intake where id = ${row.pickup_intake_id}::uuid`,
        )
      ).rows[0] as { state?: string } | undefined
    )?.state;
    if (intakeState === 'CLOSED') {
      throw conflict('intake_closed', 'An order of a closed intake is not amended');
    }
    if (row.intake_parcel_state === 'MISSING') {
      throw conflict('parcel_missing', 'A parcel that is missing is never priced or dispatched');
    }
    if (row.intake_parcel_state === 'VOID') {
      throw conflict('parcel_void', 'A parcel that was taken back has no order');
    }
    const merged = this.#mergedBody(config, before, patch);
    const checked = this.#checked(merged);
    await noteHubCrossing(this.#options.audit, handle, authorized, {
      id: row.pickup_intake_id,
      responsible_hub_id: row.responsible_hub_id,
    });
    const source = await this.#sourceOf(tx, row.pickup_intake_id);
    const priced = this.#pricedOf(
      config,
      merged,
      checked,
      source.acknowledged_at_booking,
      new Date(source.custody_at),
    );
    const terms = await this.#termsOf(tx, {
      intakeId: row.pickup_intake_id,
      parcelId: row.intake_parcel_id,
      parcelState: row.intake_parcel_state ?? undefined,
      priced,
      checked,
      waybill: merged.carrier_waybill_evidence_id,
      order: { id: orderId, version: Number(row.version), view: before },
    });
    return { row, before, merged, checked, priced, terms };
  }

  /**
   * The body an amendment restates: what the order has, with what the officer named laid over it (a member left out is kept; `null` clears one that may be empty). Two things are kept with the facts they
   * belong to (the review of 20 November 2026, finding 4):
   *
   * - **The officer's own high-value flag is a member of its own** (`is_high_value_manual`): the status the declared value gives is recomputed whenever the declaration changes, and the officer's flag is neither
   *   lost to a value that came and went nor made by one. An order made before the flag was kept apart that is high-value for no reason its declared value gives is read as the officer's own.
   * - **The choice of a zone belongs to the address it was made for.** A new address is resolved afresh and the officer is asked to choose again only if the server cannot place it; an address that the server
   *   now places itself needs no choice; and the choice is carried only for the same address that the server still cannot place.
   */
  #mergedBody(config: HubConfiguration, stored: OrderView, patch: AmendPreviewBody): ItemizeBody {
    const has = (member: keyof AmendBody): boolean => Object.hasOwn(patch, member);
    const declared = has('declared_value_minor')
      ? (patch.declared_value_minor ?? undefined)
      : (stored.declared_value_minor ?? undefined);
    let storedManual = stored.is_high_value_manual === true;
    if (stored.is_high_value_manual === null && stored.is_high_value) {
      // An order made before the officer's flag was kept apart (it is null, not false: it is not known): high-value for no reason its declared value gives is the officer's own. An order made since says
      // which it is, and a threshold that has moved since does not turn a flag the declaration gave into the officer's.
      const storedDeclared = stored.declared_value_minor ?? undefined;
      try {
        storedManual = !(storedDeclared !== undefined && isHighValue(config, storedDeclared));
      } catch (error) {
        throw this.#refusal(error) ?? error;
      }
    }
    const snapshot = stored.destination_zone_snapshot as {
      zone_id?: string;
      authorization_note?: string;
    };
    const carriedAuthorization =
      stored.destination_zone_resolution === 'EXPLICITLY_AUTHORIZED'
        ? { zone_id: snapshot.zone_id ?? '', note: snapshot.authorization_note ?? '' }
        : undefined;
    const location = (patch.recipient?.location ?? stored.recipient.location) as LocationText;
    const authorized =
      carriedAuthorization === undefined
        ? undefined
        : patch.recipient !== undefined &&
            canonical(patch.recipient.location) !== canonical(stored.recipient.location)
          ? // The choice was made for another address.
            undefined
          : resolveZone(config, location).kind === 'RESOLVED'
            ? // The server places this address itself now.
              undefined
            : carriedAuthorization;
    const carrierCost = has('carrier_cost')
      ? (patch.carrier_cost ?? undefined)
      : stored.carrier_cost;
    const mode = has('commercial_mode')
      ? (patch.commercial_mode ?? undefined)
      : ((stored.commercial_mode ?? undefined) as ItemizeBody['commercial_mode']);
    const override = has('payer_override')
      ? (patch.payer_override ?? undefined)
      : ((stored.payer_override as ItemizeBody['payer_override'] | null) ?? undefined);
    const requested = has('requested_delivery_date')
      ? (patch.requested_delivery_date ?? undefined)
      : (stored.requested_delivery_date ?? undefined);
    const serial = has('serial_imei')
      ? (patch.serial_imei ?? undefined)
      : (stored.serial_imei ?? undefined);
    const waybill = has('carrier_waybill_evidence_id')
      ? (patch.carrier_waybill_evidence_id ?? undefined)
      : (stored.carrier_waybill_evidence_id ?? undefined);
    const authorization = has('destination_zone_authorization')
      ? (patch.destination_zone_authorization ?? undefined)
      : authorized;
    return {
      recipient: patch.recipient ?? {
        name: stored.recipient.name,
        phone:
          (stored.recipient as { phone_as_entered?: string }).phone_as_entered ??
          stored.recipient.phone,
        location: stored.recipient.location as unknown as LocationText,
      },
      size_class: patch.size_class ?? (stored.size_class as ItemizeBody['size_class']),
      ...(carrierCost === undefined ? {} : { carrier_cost: carrierCost }),
      is_high_value: patch.is_high_value ?? storedManual,
      lane: patch.lane ?? (stored.lane as ItemizeBody['lane']),
      ...(mode === undefined ? {} : { commercial_mode: mode }),
      ...(override === undefined ? {} : { payer_override: override }),
      ...(declared === undefined ? {} : { declared_value_minor: declared }),
      is_serialized_goods: patch.is_serialized_goods ?? stored.is_serialized_goods,
      ...(serial === undefined ? {} : { serial_imei: serial }),
      ...(requested === undefined ? {} : { requested_delivery_date: requested }),
      ...(authorization === undefined ? {} : { destination_zone_authorization: authorization }),
      evidence_ids: patch.evidence_ids ?? [...stored.high_value_evidence_ids],
      ...(waybill === undefined ? {} : { carrier_waybill_evidence_id: waybill }),
    };
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
   * The `ETag` of the intake as it stands in this transaction, the token a read would answer: after an order is written it is the one the next order of the vendor is made on (`Intake-ETag`). The lock is not part
   * of it (`hub-intake-etag.ts`), so the renewal of the lock every minute moves nothing a save compares.
   */
  async #intakeEtag(
    handle: TransactionHandle,
    authorized: AuthorizedRequest,
    id: string,
  ): Promise<string> {
    const tx = transactionOf(handle);
    const found = await tx.execute(
      sql`select ${RECEIVING_INTAKE_COLUMNS} from pickup_intake where id = ${id}::uuid`,
    );
    const row = found.rows[0] as unknown as ReceivingIntakeRow | undefined;
    if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
    const loaded = await loadIntakes(tx, [row], authorized.session.principalId.toLowerCase());
    const etag = loaded.checkIns.get(row.id)?.etag ?? loaded.blind.get(row.id)?.etag;
    if (etag === undefined) throw new Error('An intake is loaded in one of its shapes');
    return etag;
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
  ): Promise<string | undefined> {
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
      // A blind count has no parcels to be one-to-one with, so the places are its count: an order for no more parcels than the hub received (the review of 21 November 2026, finding 1). The database holds
      // the same for every writer, and the intake is held here.
      if (intake.physical_count !== null) {
        const standing = await tx.execute(
          sql`select count(*)::int as n from "order" where pickup_intake_id = ${id}::uuid and commercial_state is distinct from 'REVERSED'`,
        );
        if (((standing.rows[0] as { n?: number } | undefined)?.n ?? 0) >= intake.physical_count) {
          throw conflict(
            'orders_exceed_received',
            'Every parcel the hub received has an order: there is no place left for another',
          );
        }
      }
      return undefined;
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
      sql`select 1 from "order" where intake_parcel_id = ${parcelId}::uuid and commercial_state is distinct from 'REVERSED' limit 1`,
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
    return parcel.state;
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
  #databaseRefusal(error: unknown, pointer = '/parcel_id'): ApiException | undefined {
    if (guardReasonIn(error) === 'COMMITMENT_SOURCE_UNRESOLVED') {
      return ApiException.of(
        ErrorCode.CommitmentSourceUnresolved,
        'The moment pickup custody passed cannot be read, so no delivery can be promised',
      );
    }
    return receivingRefusalOf(error, pointer);
  }
}
