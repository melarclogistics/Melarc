import { sql } from 'drizzle-orm';

import { randomUUIDv7 } from '../platform/auth/crypto/uuid-v7.js';
import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { Clock } from '../platform/auth/ports/clock.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { scopeIncludesHub } from '../platform/authorization/effective-scope.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import type { ConfigurationReader } from '../platform/settings/configuration-reader.js';
import { declarationOf, payerOf, requireMinimum, requireServiceDay } from './booking-rules.js';
import { hubCodeOf, operationalCode } from './operational-code.js';
import { estimateOf } from './estimate-view.js';
import { normalisePhone } from './phone.js';
import { walkInHubChoice } from './walk-in-hub.js';
import { pickupRequestEtagOf } from './pickup-request-etag.js';
import {
  REQUEST_COLUMNS,
  viewOf,
  type LocationView,
  type PickupRequestRow,
  type PickupRequestView,
} from './pickup-request-view.js';

const OPERATION = 'createPickupRequest';
const CODE_ATTEMPTS = 8;

/** The body of `createPickupRequest` as the contract's schema has validated it (the interceptor ran before this). */
export interface CreatePickupBody {
  readonly pickup_intent: 'OWN_PACKAGES' | 'COLLECT_FOR_VENDOR' | 'ADHOC_SENDER';
  /** The hub a walk-in is made in; required when the grant reaches more than one (`walk-in-hub.ts`, `AC-SLICE-001-82`). */
  readonly hub_id?: string;
  readonly vendor_organization_id?: string;
  readonly ad_hoc_sender_id?: string;
  readonly new_ad_hoc_sender?: {
    readonly name: string;
    readonly phone: string;
    readonly business_name?: string | null;
    readonly pickup_contact_name?: string | null;
    readonly pickup_location?: LocationView;
  };
  readonly collection_point?: {
    readonly contact_name: string;
    readonly phone: string;
    readonly location: LocationView;
    readonly landmark?: string | null;
  };
  readonly collection_reference?: unknown;
  readonly collection_item?: unknown;
  readonly destination_location_id?: string | null;
  readonly use_vendor_default_destination?: boolean;
  readonly pickup_location?: LocationView;
  readonly current_item_description?: string;
  readonly location_overrides?: LocationView;
  readonly scheduled_service_date: string;
  readonly declared_package_count: number;
  readonly default_payer_intent: 'RECIPIENT_PAYS' | 'SENDER_PAYS_FULL' | 'SPLIT';
  readonly split_basis?: 'FIXED_AMOUNT' | 'PERCENTAGE';
  readonly split_sender_amount?: { readonly amount_minor: number; readonly currency: string };
  readonly split_sender_percentage?: number;
  readonly declared_value_minor?: number;
  readonly liability_cap_acknowledged?: boolean;
  readonly vendor_pickup_location_id?: string;
  readonly primary_phone?: string;
  readonly secondary_phone?: string;
}

export interface PickupRequestCreationOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly idempotency: IdempotencyStore;
  readonly clock: Clock;
  readonly configuration: Pick<ConfigurationReader, 'forHub'>;
}

export interface CreatedRequest {
  readonly request: PickupRequestView;
  readonly etag: string;
}

const violation = (pointer: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
  });

interface OrganisationRow {
  readonly id: string;
  readonly responsible_hub_id: string;
  readonly operational_status: string;
  readonly display_name: string;
  readonly contact_phone: string | null;
}
interface SavedLocationRow {
  readonly id: string;
  readonly location: LocationView;
}
interface SenderRow {
  readonly id: string;
  readonly name: string;
  readonly phone: string;
  readonly state: 'PROVISIONAL' | 'REUSABLE';
  readonly pickup_location: LocationView | null;
}

const json = (value: unknown): string | null =>
  value === undefined || value === null ? null : JSON.stringify(value);

/**
 * `createPickupRequest` (S1.14; `pickup.request.create`; `AC-SLICE-001-02`, `-08`, `-09`, `-69` to `-72`, `-81`; pickup-request.md
 * sections 4 and 5; domain-model.md section 6.2): the booking, by Ops or by a vendor for itself, entering `PENDING`.
 *
 * - **The order of refusal is the contract's.** The guard has answered the key, the surface and the CSRF token, and the interceptor the
 *   schema (the intents' required members, the one identity source of an ad-hoc sender). Before the transaction, from the request alone:
 *   the idempotency key's form, the calendar (Monday to Saturday), the minimum of two packages (a vendor's; Ops may book one and ask for
 *   its exception), the payer arrangement. Then the transaction: **the idempotency of the command**, the sender (a vendor sees only its
 *   own organisation, and another's is answered as no sender; **a staff member is told `HUB_SCOPE_VIOLATION` for an organisation of a hub
 *   outside their grant as soon as the organisation is found, before anything else of it is judged**; a suspended one is `SENDER_SUSPENDED`),
 *   the places, the declaration, the estimate, the insert.
 * - **The server derives everything that is not the client's to say**: the code, the hub (the vendor organisation's; or, for a walk-in, the
 *   hub the Ops member names when their grant reaches more than one, else their own: `hub_id`, task P1), the state (`PENDING`), the place the rider is sent (`resolved_pickup_location`, from the intent, never supplied), the sender's name, the
 *   estimate, the snapshot of the liability cap. The client sends an address and never a price.
 * - **A saved location is an input, never the origin.** The request keeps the place it resolved to; the override of a booking (`AC-09`)
 *   is kept on the request and rewrites no saved default. A location of another vendor is answered as one that does not exist.
 * - **The estimate is computed, its inputs kept, and it is never a price** (`MSC-DEC-211`): a standard request has one (base fee times
 *   the packages); a one-package request has none until its exception names a destination.
 * - **The ad-hoc sender and the request are one idempotent act** (`AC-71`): the same key and body replay the original answer and the
 *   sender is minted once; a first-time sender whose phone already identifies a reusable sender is `SENDER_IDENTITY_AMBIGUOUS` (the
 *   returning sender is found by phone and named by id), and one whose phone identifies a provisional sender reuses it.
 * - **The company-wide rules are read as the `configuration` capability reads them**, before the work that uses them, so that a vendor
 *   session reads no table it is denied. A rule that is unset is a defect of the deployment and fails loudly.
 */
export class PickupRequestCreation {
  readonly #options: PickupRequestCreationOptions;

  constructor(options: PickupRequestCreationOptions) {
    this.#options = options;
  }

  async create(
    authorized: AuthorizedRequest,
    correlationId: string,
    request: {
      readonly body: CreatePickupBody;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<CreatedRequest> {
    const { runner, audit, idempotency, clock, configuration } = this.#options;
    const { body } = request;
    const principalType = authorized.session.principalType;
    if (principalType !== 'STAFF' && principalType !== 'VENDOR') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    const actor = authorized.session.principalId;
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
    // A vendor books for itself and as a registered vendor: a walk-in sender is the office's.
    if (principalType === 'VENDOR' && body.pickup_intent === 'ADHOC_SENDER') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'A vendor books for its own organisation');
    }

    requireServiceDay(body.scheduled_service_date);
    requireMinimum(principalType, body.declared_package_count);
    const payer = payerOf(body);
    const secondary = this.#phone(body.secondary_phone, '/secondary_phone');
    const given = this.#phone(body.primary_phone, '/primary_phone');

    // The hub decides which configuration the booking is evaluated against, and the platform allows one connection to a request: the
    // hub is found in a short transaction of its own (through the runner, so under the same locks and context), the configuration is read
    // next as the `configuration` capability reads it, and the booking's transaction runs last and re-checks that the hub is the same.
    const hubFound = await runner.mutate(authorized, correlationId, (handle) =>
      this.#hubOf(handle, authorized, body),
    );
    const config = hubFound === undefined ? undefined : await configuration.forHub(hubFound);

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType,
        principalId: actor,
        operationId: OPERATION,
        key: request.idempotencyKey,
      } as const;
      const begun = await idempotency.begin(handle, scope, request.fingerprint);
      if (begun.outcome === 'REPLAY') {
        const stored = JSON.parse(
          Buffer.from(begun.response.body).toString('utf8'),
        ) as PickupRequestView;
        // A new request has version one; the representation is the stored answer, and so is its ETag.
        return { request: stored, etag: pickupRequestEtagOf(stored, 1) };
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

      // 1. Whose request it is, and in which hub. A registered vendor's organisation has been judged against the grant the moment it was found
      // (`#sender`); the check below is the one a walk-in's own hub (the primary hub of the member's record) meets, and it holds for both.
      const sender = await this.#sender(handle, authorized, body);
      const hubId = sender.hubId;
      this.#requireHubInScope(authorized, hubId);
      if (config?.hubId.toLowerCase() !== hubId.toLowerCase()) {
        // The sender moved to another hub between the two transactions (a reassignment of its organisation): nothing was written, and the
        // booking is sent again against the hub it now belongs to.
        throw new Error('The hub of the sender changed while the booking was being made');
      }
      const configurationAt = config;

      // 2. The places.
      const places = await this.#places(handle, body, sender);

      // 3. The phone the rider and Ops ring.
      const primaryPhone =
        given ??
        sender.phone ??
        this.#phone(body.collection_point?.phone, '/collection_point/phone');
      if (primaryPhone === undefined) throw violation('/primary_phone', 'required');

      // 4. The declaration of value and the cap the customer acknowledged.
      const declared = declarationOf(
        body.declared_value_minor,
        body.liability_cap_acknowledged,
        configurationAt.companyMoney('value_declaration_threshold'),
      );
      const cap = declared.acknowledged
        ? {
            amount_minor: configurationAt.companyMoney('liability_cap_amount'),
            setting_key: 'liability_cap_amount',
            // A company-wide rule has no version yet (its changes arrive with the settings administration): the snapshot carries the
            // amount the customer agreed to, which is what it exists to keep, and says that no version names it.
            effective_version: 'UNVERSIONED',
          }
        : null;

      // 5. The estimate of a standard request; none until a one-package request names a destination.
      const estimate = estimateOf(configurationAt, {
        packageCount: body.declared_package_count,
        serviceDate: body.scheduled_service_date,
      });

      // 6. The request.
      const id = randomUUIDv7(clock);
      const hubCode = hubCodeOf(configurationAt.hubName ?? '');
      let row: PickupRequestRow | undefined;
      for (let attempt = 0; attempt < CODE_ATTEMPTS && row === undefined; attempt += 1) {
        const code = operationalCode(hubCode, 'PR');
        const inserted = await tx.execute(sql`
          insert into pickup_request (
            id, code, vendor_organization_id, ad_hoc_sender_id, sender_name, responsible_hub_id, pickup_intent, declared_package_count,
            pickup_location, resolved_pickup_location, collection_point, collection_reference, collection_item, destination_location_id,
            vendor_pickup_location_id, primary_phone, secondary_phone, current_item_description, scheduled_service_date,
            location_overrides, default_payer_intent, split_basis, split_sender_amount_minor, split_sender_percentage, declared_value_minor,
            liability_cap_acknowledged_at, liability_cap_snapshot, estimate_snapshot, created_by)
          values (
            ${id}::uuid, ${code}, ${sender.organisationId}::uuid, ${sender.adHocSenderId}::uuid, ${sender.name}, ${hubId}::uuid,
            ${body.pickup_intent}, ${body.declared_package_count}, ${json(places.pickupLocation)}::jsonb,
            ${json(places.resolved)}::jsonb, ${json(body.collection_point)}::jsonb, ${json(body.collection_reference)}::jsonb,
            ${json(body.collection_item)}::jsonb, ${places.destinationId}::uuid, ${places.selectedLocationId}::uuid, ${primaryPhone},
            ${secondary ?? null}, ${body.current_item_description ?? null}, ${body.scheduled_service_date}::date,
            ${json(body.location_overrides)}::jsonb, ${payer.default_payer_intent}, ${payer.split_basis},
            ${payer.split_sender_amount_minor}, ${payer.split_sender_percentage}, ${body.declared_value_minor ?? null},
            ${cap === null ? null : sql`now()`}, ${json(cap)}::jsonb, ${json(estimate)}::jsonb, ${actor}::uuid)
          on conflict (code) do nothing
          returning ${REQUEST_COLUMNS}`);
        row = inserted.rows[0] as unknown as PickupRequestRow | undefined;
      }
      if (row === undefined) throw new Error('No unused operational code could be drawn');

      const view = viewOf(row, { estimate });
      if (sender.created && sender.adHocSenderId !== null) {
        await audit.write(handle, {
          code: 'pickup.sender.saved',
          enhanced: false,
          outcome: 'SUCCEEDED',
          object: { type: 'AdHocSender', id: sender.adHocSenderId },
          responsibleHubId: hubId,
          resultingState: 'PROVISIONAL',
        });
      }
      await audit.write(handle, {
        code: 'pickup.request.created',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupRequest', id },
        responsibleHubId: hubId,
        ...(sender.organisationId === null ? {} : { vendorOrganizationId: sender.organisationId }),
        resultingState: 'PENDING',
        relatedIds: sender.adHocSenderId === null ? {} : { ad_hoc_sender_id: sender.adHocSenderId },
        detail: {
          pickup_intent: body.pickup_intent,
          declared_package_count: row.declared_package_count,
        },
      });
      await idempotency.complete(handle, scope, {
        status: 201,
        body: new TextEncoder().encode(JSON.stringify(view)),
      });
      return { request: view, etag: pickupRequestEtagOf(view, row.version) };
    });
  }

  /**
   * The hub a booking belongs to, found without refusing anything (the transaction that books refuses, in the contract's order): the
   * organisation's for a registered vendor's intents, the Ops member's own for a walk-in's. Absent where it cannot be found, **and for a staff
   * caller whose grant does not reach it**: the configuration of a hub is read for a booking that can be made there and for no other.
   */
  async #hubOf(
    handle: TransactionHandle,
    authorized: AuthorizedRequest,
    body: CreatePickupBody,
  ): Promise<string | undefined> {
    const tx = transactionOf(handle);
    if (body.pickup_intent !== 'ADHOC_SENDER') {
      if (body.vendor_organization_id === undefined) return undefined;
      const found = await tx.execute(
        sql`select responsible_hub_id from vendor_organization where id = ${body.vendor_organization_id}::uuid`,
      );
      const organisationHub = (found.rows[0] as { responsible_hub_id: string } | undefined)
        ?.responsible_hub_id;
      // A staff caller whose grant does not reach the organisation's hub finds nothing here, as for a walk-in below: no configuration is read for a hub
      // that is never going to be booked, and the transaction that books answers `HUB_SCOPE_VIOLATION`, first (`#sender`).
      return organisationHub !== undefined && this.#hubInScope(authorized, organisationHub)
        ? organisationHub
        : undefined;
    }
    // A walk-in's hub is the one the member names, when it exists and the grant reaches it; else their own, when the grant reaches one hub. A
    // grant of more than one hub with none named, an unknown hub and a hub outside the grant find nothing here: the transaction that books
    // refuses each in its own words (`VALIDATION_FAILED`, `VALIDATION_FAILED`, `HUB_SCOPE_VIOLATION`), and no configuration is read for a hub
    // that was never going to be booked.
    const choice = walkInHubChoice(authorized.scope, body.hub_id);
    if (choice.kind === 'must-name') return undefined;
    if (choice.kind === 'named') {
      if (!this.#hubInScope(authorized, choice.hubId)) return undefined;
      const named = await tx.execute(sql`select id from hub where id = ${choice.hubId}::uuid`);
      return named.rows.length === 1 ? choice.hubId : undefined;
    }
    const own = await tx.execute(
      sql`select primary_hub_id from staff_identity where id = ${authorized.session.principalId}::uuid`,
    );
    return (
      (own.rows[0] as { primary_hub_id: string | null } | undefined)?.primary_hub_id ?? undefined
    );
  }

  /** A phone number as given (or absent), in its normal form; one this function cannot place is a validation failure naming the field. */
  #phone(entered: string | undefined, pointer: string): string | undefined {
    if (entered === undefined) return undefined;
    const normal = normalisePhone(entered);
    if (normal === undefined) throw violation(pointer, 'format');
    return normal;
  }

  /** Whether a staff caller's grant reaches the hub; a vendor's hub is its organisation's and is not a scope it holds. */
  #hubInScope(authorized: AuthorizedRequest, hubId: string): boolean {
    if (authorized.session.principalType !== 'STAFF') return true;
    return scopeIncludesHub(authorized.scope, hubId);
  }

  /** A staff caller books only in a hub of its grant. */
  #requireHubInScope(authorized: AuthorizedRequest, hubId: string): void {
    if (!this.#hubInScope(authorized, hubId)) {
      throw ApiException.of(ErrorCode.HubScopeViolation, 'The booking is outside your hubs');
    }
  }

  /**
   * Whose request it is: the registered vendor (its organisation, its name, its hub, its phone) or the ad-hoc sender (found, or minted
   * here), and the hub the request belongs to.
   */
  async #sender(
    handle: TransactionHandle,
    authorized: AuthorizedRequest,
    body: CreatePickupBody,
  ): Promise<{
    organisationId: string | null;
    adHocSenderId: string | null;
    name: string;
    hubId: string;
    phone: string | undefined;
    storedLocation: LocationView | null;
    created: boolean;
  }> {
    const tx = transactionOf(handle);
    if (body.pickup_intent !== 'ADHOC_SENDER') {
      const id = body.vendor_organization_id;
      if (id === undefined) throw violation('/vendor_organization_id', 'required');
      const found = await tx.execute(sql`
        select id, responsible_hub_id, operational_status, coalesce(trading_name, legal_name) as display_name, contact_phone
          from vendor_organization where id = ${id}::uuid`);
      const org = found.rows[0] as unknown as OrganisationRow | undefined;
      if (org === undefined) {
        // A vendor is told nothing about an organisation that is not its own; the office is told it is not a vendor it can book for.
        if (authorized.session.principalType === 'VENDOR') {
          throw ApiException.of(
            ErrorCode.PermissionDenied,
            'A vendor books for its own organisation',
          );
        }
        throw violation('/vendor_organization_id', 'enum');
      }
      // **The scope is judged before anything else of the organisation** (the audit of 7 November 2026, A2). A staff context reads every organisation
      // under a `pickup` key (`vendor_organization_pickup_read` has no hub in it), so the grant is judged here, on the hub the row states, and what an
      // officer is told of an organisation of a hub outside their grant is the one answer whatever it is: neither its status (suspended, or not
      // active) nor whether the hub the body names is its hub is judged, or told, before it. A vendor holds no hub scope: its organisation's is its own.
      this.#requireHubInScope(authorized, org.responsible_hub_id);
      if (org.operational_status === 'SUSPENDED') {
        throw ApiException.of(ErrorCode.SenderSuspended, 'The sender is suspended');
      }
      if (org.operational_status !== 'ACTIVE') throw violation('/vendor_organization_id', 'enum');
      // A registered vendor's booking is in its organisation's hub, whoever makes it: a hub named for another is not a booking the server can make.
      if (
        body.hub_id !== undefined &&
        body.hub_id.toLowerCase() !== org.responsible_hub_id.toLowerCase()
      ) {
        throw violation('/hub_id', 'enum');
      }
      return {
        organisationId: org.id,
        adHocSenderId: null,
        name: org.display_name,
        hubId: org.responsible_hub_id,
        phone: org.contact_phone === null ? undefined : normalisePhone(org.contact_phone),
        storedLocation: null,
        created: false,
      };
    }

    // A walk-in sender: the office's booking, in the hub the Ops member names (a grant that reaches more than one hub must) or, when the grant
    // reaches one, their own. **The scope is judged before anything of the hub or of the sender is read**, as `createStaffIdentity` judges it
    // (the review of P1): a hub outside the grant is HUB_SCOPE_VIOLATION whether or not it exists, so that a caller learns nothing of the hubs
    // they cannot reach, and nothing is written.
    const choice = walkInHubChoice(authorized.scope, body.hub_id);
    if (choice.kind === 'must-name') throw violation('/hub_id', 'required');
    let hubId: string | null | undefined;
    if (choice.kind === 'named') {
      this.#requireHubInScope(authorized, choice.hubId);
      const named = await tx.execute(sql`select id from hub where id = ${choice.hubId}::uuid`);
      if (named.rows.length !== 1) throw violation('/hub_id', 'enum');
      hubId = choice.hubId;
    } else {
      const own = await tx.execute(
        sql`select primary_hub_id from staff_identity where id = ${authorized.session.principalId}::uuid`,
      );
      hubId = (own.rows[0] as { primary_hub_id: string | null } | undefined)?.primary_hub_id;
    }
    if (hubId === null || hubId === undefined) {
      throw ApiException.of(
        ErrorCode.HubScopeViolation,
        'A walk-in booking is made in your own hub',
      );
    }
    if (body.ad_hoc_sender_id !== undefined) {
      const found = await tx.execute(sql`
        select id, name, phone, state, pickup_location from ad_hoc_sender where id = ${body.ad_hoc_sender_id}::uuid`);
      const sender = found.rows[0] as unknown as SenderRow | undefined;
      if (sender === undefined) throw violation('/ad_hoc_sender_id', 'enum');
      return {
        organisationId: null,
        adHocSenderId: sender.id,
        name: sender.name,
        hubId,
        phone: sender.phone,
        storedLocation: sender.pickup_location,
        created: false,
      };
    }
    const fresh = body.new_ad_hoc_sender;
    if (fresh === undefined) throw violation('/new_ad_hoc_sender', 'required');
    const phone = normalisePhone(fresh.phone);
    if (phone === undefined) throw violation('/new_ad_hoc_sender/phone', 'format');
    if (fresh.name.trim() === '') throw violation('/new_ad_hoc_sender/name', 'required');
    const id = randomUUIDv7(this.#options.clock);
    const inserted = await tx.execute(sql`
      insert into ad_hoc_sender (id, name, phone, phone_as_entered, business_name, pickup_contact_name, pickup_location, created_by)
      values (${id}::uuid, ${fresh.name.trim()}, ${phone}, ${fresh.phone}, ${fresh.business_name ?? null},
              ${fresh.pickup_contact_name ?? null}, ${json(fresh.pickup_location ?? body.pickup_location)}::jsonb,
              ${authorized.session.principalId}::uuid)
      on conflict (phone) do nothing
      returning id`);
    if (inserted.rows.length === 1) {
      return {
        organisationId: null,
        adHocSenderId: id,
        name: fresh.name.trim(),
        hubId,
        phone,
        storedLocation: fresh.pickup_location ?? null,
        created: true,
      };
    }
    // The phone already identifies a sender. A reusable one is found by phone and named by id, never recreated; a provisional one (its
    // first pickup has not completed, so it is not searchable) is the same walk-in coming back, and is reused as it is.
    const existing = await tx.execute(sql`
      select id, name, phone, state, pickup_location from ad_hoc_sender where phone = ${phone}`);
    const sender = existing.rows[0] as unknown as SenderRow | undefined;
    if (sender === undefined)
      throw new Error('A sender conflicted on its phone and could not be read');
    if (sender.state === 'REUSABLE') {
      throw ApiException.of(
        ErrorCode.SenderIdentityAmbiguous,
        'That phone already identifies a sender: find it by phone and book for it by its id',
      );
    }
    return {
      organisationId: null,
      adHocSenderId: sender.id,
      name: sender.name,
      hubId,
      phone: sender.phone,
      storedLocation: sender.pickup_location,
      created: false,
    };
  }

  /** The places of the request, from the intent: where the rider goes, where the sender is, the saved location chosen, the destination. */
  async #places(
    handle: TransactionHandle,
    body: CreatePickupBody,
    sender: { organisationId: string | null; storedLocation: LocationView | null },
  ): Promise<{
    resolved: LocationView;
    pickupLocation: LocationView | null;
    selectedLocationId: string | null;
    destinationId: string | null;
  }> {
    const tx = transactionOf(handle);
    const saved = async (
      id: string | undefined,
      organisationId: string,
    ): Promise<SavedLocationRow | undefined> => {
      const found = await tx.execute(
        id === undefined
          ? sql`select id, location from vendor_pickup_location
                 where vendor_organization_id = ${organisationId}::uuid and is_default and active`
          : sql`select id, location from vendor_pickup_location
                 where id = ${id}::uuid and vendor_organization_id = ${organisationId}::uuid and active`,
      );
      return found.rows[0] as unknown as SavedLocationRow | undefined;
    };

    if (body.pickup_intent === 'COLLECT_FOR_VENDOR') {
      const organisationId = sender.organisationId;
      if (organisationId === null || body.collection_point === undefined) {
        throw violation('/collection_point', 'required');
      }
      // A destination is mandatory; another vendor's location, one that is retired and a vendor with no default are all "no destination".
      const destination = await saved(body.destination_location_id ?? undefined, organisationId);
      if (
        destination === undefined ||
        (body.destination_location_id === undefined && body.use_vendor_default_destination !== true)
      ) {
        throw ApiException.of(
          ErrorCode.DestinationUnresolved,
          'The collection has nowhere to be taken: name a destination or use the vendor’s default location',
        );
      }
      return {
        resolved: body.location_overrides ?? body.collection_point.location,
        pickupLocation: null,
        selectedLocationId: null,
        destinationId: destination.id,
      };
    }

    if (body.pickup_intent === 'OWN_PACKAGES') {
      const organisationId = sender.organisationId;
      if (organisationId === null) throw violation('/vendor_organization_id', 'required');
      const chosen = await saved(body.vendor_pickup_location_id, organisationId);
      if (body.vendor_pickup_location_id !== undefined && chosen === undefined) {
        // A location of another vendor, and one that does not exist, are answered the same.
        throw violation('/vendor_pickup_location_id', 'enum');
      }
      const resolved = body.location_overrides ?? body.pickup_location ?? chosen?.location;
      if (resolved === undefined) throw violation('/pickup_location', 'required');
      return {
        resolved,
        pickupLocation: body.pickup_location ?? chosen?.location ?? null,
        selectedLocationId:
          body.vendor_pickup_location_id === undefined ? null : (chosen?.id ?? null),
        destinationId: null,
      };
    }

    const own =
      body.pickup_location ??
      body.new_ad_hoc_sender?.pickup_location ??
      sender.storedLocation ??
      undefined;
    const resolved = body.location_overrides ?? own;
    if (resolved === undefined) throw violation('/pickup_location', 'required');
    return { resolved, pickupLocation: own ?? null, selectedLocationId: null, destinationId: null };
  }
}
