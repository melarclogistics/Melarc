import type { components } from '@melarc/api-client';

import { MANIFEST_ID, REQUEST_ONE_ID, STOP_ONE_ID } from './manifest-fixture';
import { PICKUP_HUB_ID } from './pickup-fixture';

/**
 * Real-shaped answers of the reads and acts of the screens of the door and the failure, for tests (S1.30). Every field the contract requires is present and each value is
 * synthetic: no code, no digest, no phone number and no address. The types are the contract's, so nothing here describes the wire a second time.
 */
type FailureBody = components['schemas']['PickupFailureQueueItem'];
type HandshakeBody = components['schemas']['OpsHandshake'];
type ShortfallBody = components['schemas']['CollectionShortfall'];
type DisputeBody = components['schemas']['CollectionDisputeListItem'];
type EvidenceItemBody = components['schemas']['StopEvidenceItem'];
type EvidenceListBody = components['schemas']['StopEvidenceList'];
type ExceptionBody = components['schemas']['ParcelPhotoException'];

export const WORK_HUB_ID = PICKUP_HUB_ID;
export const WORK_STOP_ID = STOP_ONE_ID;
export const WORK_MANIFEST_ID = MANIFEST_ID;
export const WORK_REQUEST_ID = REQUEST_ONE_ID;
export const WORK_VENDOR_ID = 'e46e7f8a-9b0c-4d1e-8f2a-3b4c5d6e7f8a';
export const WORK_OFFICER_ID = 'f57f8a9b-0c1d-4e2f-8a3b-4c5d6e7f8a9b';
export const WORK_RIDER_ID = '068a9b0c-1d2e-4f3a-8b4c-5d6e7f8a9b0c';
export const WORK_ROW_ID = '179b0c1d-2e3f-4a4b-8c5d-6e7f8a9b0c1d';
export const WORK_EXCEPTION_ID = '28ac1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e';
export const WORK_EVIDENCE_ID = '39bd2e3f-4a5b-4c6d-8e7f-8a9b0c1d2e3f';
export const WORK_OTHER_STOP_ID = '4ace3f4a-5b6c-4d7e-8f8a-9b0c1d2e3f4a';

/** The context every item states of the pickup it is about: the ids to open it from, and the words to find it by. */
const context = (stop: string, request: string) => ({
  pickup_stop_id: stop,
  pickup_manifest_id: WORK_MANIFEST_ID,
  pickup_request_id: request,
  responsible_hub_id: WORK_HUB_ID,
  request_code: 'ACC-PR-7KQ2MZ',
  sender_name: 'Demo Fabrics Ltd',
});

/** A failed pickup that still waits for the office, with nothing decided and nothing escalated. */
export function failureFixture(overrides: Partial<FailureBody> = {}): FailureBody {
  return {
    ...context(WORK_STOP_ID, WORK_REQUEST_ID),
    category: 'VENDOR_UNAVAILABLE',
    reason: {
      code: 'VENDOR_NOT_AT_PICKUP_POINT',
      label: 'The vendor was not at the pickup point',
      attribution: 'VENDOR',
    },
    note: 'Gate locked and nobody answered.',
    contact_attempts: [
      {
        method: 'PHONE_CALL',
        attempted_at: '2026-11-04T09:10:00Z',
        outcome: 'No answer',
      },
    ],
    failed_at: '2026-11-04T09:12:00Z',
    waiting_seconds: 7_200,
    request_state: 'CONFIRMED',
    decision: 'PENDING',
    attempt_number: 1,
    attempt_extended: false,
    escalated_at: null,
    escalation: null,
    decided_at: null,
    replacement_request_id: null,
    rider_id: WORK_RIDER_ID,
    photo_count: 0,
    ...overrides,
  };
}

/** A handshake whose code ran out: the vendor can no longer enter it, and it needs an officer. */
export function opsHandshakeFixture(overrides: Partial<HandshakeBody> = {}): HandshakeBody {
  return {
    ...context(WORK_STOP_ID, WORK_REQUEST_ID),
    id: WORK_ROW_ID,
    direction: 'VENDOR_ENTERED_RIDER_DISPLAYED',
    state: 'EXPIRED',
    stop_state: 'ARRIVED',
    routed_because: 'CODE_EXPIRED',
    expires_at: '2026-11-04T09:30:00Z',
    attempts: 0,
    attempt_limit: 5,
    fallback_sends: 0,
    fallback_limit: 3,
    channel: null,
    confirmed_at: null,
    authorised_by: null,
    created_at: '2026-11-04T09:15:00Z',
    ...overrides,
  };
}

export function shortfallFixture(overrides: Partial<ShortfallBody> = {}): ShortfallBody {
  return {
    ...context(WORK_STOP_ID, WORK_REQUEST_ID),
    id: WORK_ROW_ID,
    declared_count: 5,
    collected_count: 3,
    shortfall_count: 2,
    reason: {
      code: 'PARCELS_NOT_READY',
      label: 'Some parcels were not ready',
      attribution: 'VENDOR',
    },
    note: 'The rest were still being packed.',
    office_notified_at: '2026-11-04T09:40:00Z',
    recorded_at: '2026-11-04T09:40:00Z',
    recorded_by: WORK_RIDER_ID,
    stop_state: 'PARTIALLY_COLLECTED',
    run_state: 'IN_PROGRESS',
    ...overrides,
  };
}

export function disputeFixture(overrides: Partial<DisputeBody> = {}): DisputeBody {
  return {
    ...context(WORK_STOP_ID, WORK_REQUEST_ID),
    id: WORK_ROW_ID,
    vendor_organization_id: WORK_VENDOR_ID,
    state: 'OPEN',
    note: 'The rider took three parcels and I handed over five.',
    created_at: '2026-11-04T11:00:00Z',
    resolved_at: null,
    stop_state: 'PARTIALLY_COLLECTED',
    declared_count: 5,
    collected_count: 3,
    variance: 'SHORT',
    ...overrides,
  };
}

/** One photo of a stop: stored, clean, with the moment it was made and the moment its upload ended. */
export function evidenceItemFixture(overrides: Partial<EvidenceItemBody> = {}): EvidenceItemBody {
  return {
    id: WORK_EVIDENCE_ID,
    purpose: 'PARCEL_PHOTO',
    state: 'STORED',
    captured_at: '2026-11-04T09:30:00Z',
    uploaded_at: '2026-11-04T09:31:00Z',
    content_type: 'image/jpeg',
    scanned_clean: true,
    ...overrides,
  };
}

export function exceptionFixture(overrides: Partial<ExceptionBody> = {}): ExceptionBody {
  return {
    id: WORK_EXCEPTION_ID,
    pickup_stop_id: WORK_STOP_ID,
    authorised_by: WORK_OFFICER_ID,
    authorised_at: '2026-11-04T09:20:00Z',
    note: 'The rider’s camera failed.',
    ...overrides,
  };
}

/** A page of a stop's evidence, with the progress of its parcel photos counted for the whole stop. */
export function evidenceListFixture(overrides: Partial<EvidenceListBody> = {}): EvidenceListBody {
  return {
    items: [evidenceItemFixture()],
    next_page_token: null,
    parcel_photos: { declared: 1, stored: 1, pending: 0, expired: 0 },
    parcel_photo_exception: null,
    ...overrides,
  };
}

/** The handshake an act answers with. */
export function handshakeFixture(
  overrides: Partial<components['schemas']['Handshake']> = {},
): components['schemas']['Handshake'] {
  return {
    stop_id: WORK_STOP_ID,
    state: 'MANUALLY_RESOLVED',
    direction: 'VENDOR_ENTERED_RIDER_DISPLAYED',
    channel: 'OPS_OVERRIDE',
    ...overrides,
  };
}
