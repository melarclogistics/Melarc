import { sql } from 'drizzle-orm';

import { requiredNote } from '../platform/audit/required-note.js';
import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { guardReasonIn, guardRuleIn } from '../platform/database/database-failures.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import { loadRequest, requireCurrent } from './pickup-request-loader.js';
import { exceptionAudienceOf, type PickupRequestView } from './pickup-request-view.js';

const OPERATION = 'amendPickupRequest';
const MAX_PESEWAS = 2_000_000_000;

/** The body of `amendPickupRequest` as the contract's schema has validated it. */
export interface AmendBody {
  readonly pickup_location?: unknown;
  readonly location_overrides?: unknown;
  readonly vendor_pickup_location_id?: string;
  readonly primary_phone?: string;
  readonly secondary_phone?: string;
  readonly payer?: {
    readonly payer_intent: 'RECIPIENT_PAYS' | 'SENDER_PAYS_FULL' | 'SPLIT';
    readonly split_basis?: 'FIXED_AMOUNT' | 'PERCENTAGE';
    readonly split_sender_amount?: { readonly amount_minor: number; readonly currency: 'GHS' };
    readonly split_sender_percentage?: number;
  };
  readonly note?: string;
}

export interface AmendmentOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly idempotency: IdempotencyStore;
}

export interface AmendedRequest {
  readonly request: PickupRequestView;
  readonly etag: string;
}

const invalid = (pointer: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
  });

/**
 * `amendPickupRequest` (S1.39; `pickup.request.create`; `AC-SLICE-001-55`; itemization.md section 5.1 step 6): the default payer arrangement of a request, edited **before the price freezes**. A vendor edits its own
 * `PENDING` request, Ops a `PENDING` or `CONFIRMED` one of its hubs whose run has not started; the edit applies to the parcels not yet itemized (each order resolves the arrangement as it stands when it is frozen),
 * and once any order of the request's intake is frozen the same edit is a correction (`requestPayerCorrection`): `STATE_CONFLICT`, rule `price_frozen`. The edit is the intent and its numbers, never a portion of a
 * price, and never rewrites a saved sender default (21.1).
 *
 * **What is not built, and is refused by name** (a stub is never a success): the origin of the request (its location, its overrides, the saved location it is booked from) and its phones. Re-resolving the origin once
 * for the request, after the rider has been given a destination, is the pickup domain's own design (OB-S1-145); a body that names one of them is `VALIDATION_FAILED`, rule `not_built`.
 */
export class PickupRequestAmendment {
  readonly #options: AmendmentOptions;

  constructor(options: AmendmentOptions) {
    this.#options = options;
  }

  async amend(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    request: {
      readonly body: AmendBody;
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<AmendedRequest> {
    const principalType = authorized.session.principalType;
    if (principalType !== 'STAFF' && principalType !== 'VENDOR') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw invalid('/', 'idempotency_key');
    }
    const { body } = request;
    for (const member of [
      'pickup_location',
      'location_overrides',
      'vendor_pickup_location_id',
      'primary_phone',
      'secondary_phone',
    ] as const) {
      if (body[member] !== undefined) throw invalid(`/${member}`, 'not_built');
    }
    if (body.payer === undefined) throw invalid('/payer', 'required');
    const payer = this.#payer(body.payer);
    const note = body.note === undefined ? undefined : requiredNote(body.note, '/note');
    const actor = authorized.session.principalId.toLowerCase();
    const { runner, audit, idempotency } = this.#options;

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
        return JSON.parse(Buffer.from(begun.response.body).toString('utf8')) as AmendedRequest;
      }
      if (begun.outcome === 'CONFLICT') {
        throw ApiException.of(
          ErrorCode.IdempotencyKeyConflict,
          'That Idempotency-Key was used with a different request',
        );
      }
      if (begun.outcome !== 'NEW')
        throw new Error('An idempotency record of this command is stranded');

      const audience = exceptionAudienceOf(principalType);
      const loaded = await loadRequest(handle, id, { audience });
      if (loaded === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      requireCurrent(request.ifMatch, loaded);
      const before = loaded.row;
      try {
        await tx.execute(
          sql`select melarc.amend_request_payer(${id}::uuid, ${JSON.stringify(payer)}::jsonb, ${before.version}::integer)`,
        );
      } catch (error) {
        throw this.#refusal(error) ?? error;
      }
      const after = await loadRequest(handle, id, { audience });
      if (after === undefined) throw new Error('A request that was amended could not be read');
      await audit.write(handle, {
        code: 'pickup.request.amended',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupRequest', id },
        responsibleHubId: before.responsible_hub_id,
        ...(before.vendor_organization_id === null
          ? {}
          : { vendorOrganizationId: before.vendor_organization_id }),
        ...(note === undefined ? {} : { note }),
        detail: {
          amended: 'payer',
          payer_intent_before: before.default_payer_intent,
          payer_intent_after: String(payer.payer_intent),
          amended_by_actor_type: principalType === 'VENDOR' ? 'VENDOR' : 'OPS',
        },
      });
      const answer: AmendedRequest = { request: after.view, etag: after.etag };
      await idempotency.complete(handle, scope, {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify(answer)),
      });
      return answer;
    });
  }

  /** The intent and its numbers as the database stores them: never a portion of a price. */
  #payer(given: NonNullable<AmendBody['payer']>): Readonly<Record<string, unknown>> {
    const { payer_intent: intent, split_basis: basis, split_sender_amount: amount } = given;
    const percentage = given.split_sender_percentage;
    if (intent !== 'SPLIT') {
      if (basis !== undefined || amount !== undefined || percentage !== undefined) {
        throw invalid('/payer', 'split_not_allowed');
      }
      return { payer_intent: intent };
    }
    if (basis === undefined) throw invalid('/payer/split_basis', 'required');
    if (basis === 'FIXED_AMOUNT') {
      if (percentage !== undefined) throw invalid('/payer/split_sender_percentage', 'not_allowed');
      if (
        amount === undefined ||
        !Number.isSafeInteger(amount.amount_minor) ||
        amount.amount_minor < 1 ||
        amount.amount_minor > MAX_PESEWAS
      ) {
        throw invalid('/payer/split_sender_amount', 'required');
      }
      return {
        payer_intent: intent,
        split_basis: basis,
        split_sender_amount_minor: amount.amount_minor,
      };
    }
    if (amount !== undefined) throw invalid('/payer/split_sender_amount', 'not_allowed');
    if (percentage === undefined) throw invalid('/payer/split_sender_percentage', 'required');
    return { payer_intent: intent, split_basis: basis, split_sender_percentage: percentage };
  }

  /** What the database refused, as the answer the contract names. */
  #refusal(error: unknown): ApiException | undefined {
    const rule = guardRuleIn(error);
    switch (guardReasonIn(error)) {
      case 'STATE_CONFLICT':
        return ApiException.of(
          ErrorCode.StateConflict,
          'The request can no longer be amended',
          rule === undefined ? undefined : { rule },
        );
      case 'PERMISSION_DENIED':
        return ApiException.of(
          ErrorCode.PermissionDenied,
          'A vendor amends only a pending request of its own',
        );
      default:
        return undefined;
    }
  }
}
