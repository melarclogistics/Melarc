import { describe, expect, it } from 'vitest';

import {
  WORK_EVIDENCE_ID,
  WORK_ROW_ID,
  WORK_STOP_ID,
  disputeFixture,
  evidenceItemFixture,
  evidenceListFixture,
  exceptionFixture,
  failureFixture,
  handshakeFixture,
  opsHandshakeFixture,
  shortfallFixture,
} from '../../test-support/pickup-work-fixture';
import {
  MAX_PAGE_ITEMS,
  parseDispute,
  parseDisputePage,
  parseHandshake,
  parseOpsHandshake,
  parseOpsHandshakePage,
  parseParcelPhotoException,
  parsePickupFailure,
  parsePickupFailurePage,
  parseRetrievalAuthorization,
  parseShortfall,
  parseShortfallPage,
  parseStopEvidenceItem,
  parseStopEvidencePage,
} from './pickup-work-shape';

const OTHER_ID = '5bdf4a5b-6c7d-4e8f-8a9b-0c1d2e3f4a5b';

/** A page's worth of failures, each of its own stop: a stop listed twice is refused for that reason, which is not what a page too long is refused for. */
const distinctFailures = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    failureFixture({
      pickup_stop_id: `0c1d2e3f-4a5b-4c6d-8e7f-${index.toString(16).padStart(12, '0')}`,
    }),
  );

describe('a failed pickup', () => {
  it('is read with the fields the screen draws, and the escalation of a person without a threshold or a wait', () => {
    const failure = parsePickupFailure(
      failureFixture({
        decision: 'ESCALATED',
        escalated_at: '2026-11-04T10:00:00Z',
        escalation: { by: 'PERSON', threshold_hours: null, waited_seconds: null },
      }),
    );

    expect(failure).toMatchObject({
      pickup_stop_id: WORK_STOP_ID,
      request_code: 'ACC-PR-7KQ2MZ',
      sender_name: 'Demo Fabrics Ltd',
      category: 'VENDOR_UNAVAILABLE',
      waiting_seconds: 7_200,
      decision: 'ESCALATED',
      escalation: { by: 'PERSON', threshold_hours: null, waited_seconds: null },
    });
    expect(failure?.contact_attempts).toHaveLength(1);
  });

  // Break caught: the backstop's threshold and wait dropped on the way to the screen (section 17.3 makes them mandatory beside the moment).
  it('keeps the threshold and the wait of the backstop', () => {
    const failure = parsePickupFailure(
      failureFixture({
        decision: 'ESCALATED',
        escalated_at: '2026-11-05T09:00:00Z',
        escalation: { by: 'BACKSTOP', threshold_hours: 24, waited_seconds: 90_000 },
      }),
    );

    expect(failure?.escalation).toEqual({
      by: 'BACKSTOP',
      threshold_hours: 24,
      waited_seconds: 90_000,
    });
  });

  it('keeps a note of a contact attempt and none where there was none', () => {
    const failure = parsePickupFailure(
      failureFixture({
        contact_attempts: [
          { method: 'SMS', attempted_at: '2026-11-04T09:05:00Z', outcome: 'Sent', note: 'Twice' },
          { method: 'IN_PERSON', attempted_at: '2026-11-04T09:08:00Z', outcome: 'Nobody there' },
        ],
      }),
    );

    expect(failure?.contact_attempts[0]).toMatchObject({ note: 'Twice' });
    expect(failure?.contact_attempts[1]).not.toHaveProperty('note');
  });

  // Break caught: a field the contract adds, such as a phone number, carried to a screen that has no use for it (the types are narrowed to what is drawn).
  it('keeps no member the screen does not read', () => {
    const failure = parsePickupFailure({
      ...failureFixture(),
      contact_phone: '+233209999999',
      object_key: 'evidence/secret',
    });

    expect(JSON.stringify(failure)).not.toContain('233209999999');
    expect(JSON.stringify(failure)).not.toContain('object_key');
  });

  // Break caught: an item that says one thing and shows the other, which is not one the API sends.
  it.each([
    [
      'an escalation that the request has no moment for',
      { escalation: { by: 'PERSON' as const, threshold_hours: null, waited_seconds: null } },
    ],
    [
      'the moment of an escalation with no escalation',
      { decision: 'ESCALATED' as const, escalated_at: '2026-11-04T10:00:00Z' },
    ],
    ['an escalated decision with no moment of one', { decision: 'ESCALATED' as const }],
    [
      'a waiting decision with the moment of an escalation',
      {
        escalated_at: '2026-11-04T10:00:00Z',
        escalation: { by: 'UNKNOWN' as const, threshold_hours: null, waited_seconds: null },
      },
    ],
    [
      'a person who escalated with a threshold',
      {
        decision: 'ESCALATED' as const,
        escalated_at: '2026-11-04T10:00:00Z',
        escalation: { by: 'PERSON' as const, threshold_hours: 24, waited_seconds: null },
      },
    ],
    [
      'an unknown actor with a wait',
      {
        decision: 'ESCALATED' as const,
        escalated_at: '2026-11-04T10:00:00Z',
        escalation: { by: 'UNKNOWN' as const, threshold_hours: null, waited_seconds: 30 },
      },
    ],
    [
      'an actor the contract does not have',
      {
        decision: 'ESCALATED' as const,
        escalated_at: '2026-11-04T10:00:00Z',
        escalation: { by: 'SYSTEM' as never, threshold_hours: null, waited_seconds: null },
      },
    ],
    [
      'a rescheduled decision with no replacement',
      { decision: 'RESCHEDULED' as const, request_state: 'CANCELLED' as const },
    ],
    ['a replacement with no reschedule', { replacement_request_id: OTHER_ID }],
    ['a cancelled decision of a request that is confirmed', { decision: 'CANCELLED' as const }],
    [
      'a confirmed decision of a request that is cancelled',
      { request_state: 'CANCELLED' as const },
    ],
    ['a category the contract does not have', { category: 'LOST' as never }],
    ['a negative wait', { waiting_seconds: -1 }],
    ['a wait that is not a whole number', { waiting_seconds: 1.5 }],
    ['an attempt number below one', { attempt_number: 0 }],
    ['a photo count that is negative', { photo_count: -1 }],
    ['a request code that is not a code', { request_code: '<b>' }],
    ['a sender name with a line break', { sender_name: 'Demo\nLtd' }],
    ['a stop that is not an identifier', { pickup_stop_id: 'nope' }],
    ['a failure moment that is not an instant', { failed_at: 'yesterday' }],
    ['a reason with no label', { reason: { code: 'X', label: '', attribution: 'VENDOR' } }],
    ['a note with a control character', { note: 'bad\u0007note' }],
    [
      'a contact method the contract does not have',
      {
        contact_attempts: [
          { method: 'FAX' as never, attempted_at: '2026-11-04T09:10:00Z', outcome: 'x' },
        ],
      },
    ],
  ])('is refused with %s', (_name, overrides) => {
    expect(parsePickupFailure(failureFixture(overrides))).toBeUndefined();
  });

  it('is refused when it is not an object', () => {
    for (const body of [null, undefined, 'x', 7, [], true]) {
      expect(parsePickupFailure(body)).toBeUndefined();
    }
  });

  it('keeps a note that has line breaks and a null where there is none', () => {
    expect(parsePickupFailure(failureFixture({ note: 'One.\nTwo.' }))?.note).toBe('One.\nTwo.');
    expect(parsePickupFailure(failureFixture({ note: null }))?.note).toBeNull();
  });
});

describe('a page of failed pickups', () => {
  it('is read with its items in the order sent and the position of the next page', () => {
    const page = parsePickupFailurePage({
      items: [failureFixture(), failureFixture({ pickup_stop_id: OTHER_ID })],
      next_page_token: 'abc',
    });

    expect(page?.items.map((item) => item.pickup_stop_id)).toEqual([WORK_STOP_ID, OTHER_ID]);
    expect(page?.nextPageToken).toBe('abc');
  });

  it('is read at the end of the list with no position', () => {
    expect(parsePickupFailurePage({ items: [], next_page_token: null })).toEqual({
      items: [],
      nextPageToken: null,
    });
  });

  // Break caught: a page that is partly believed. One entry that is not a failure makes the page unusable, and nothing of it is drawn.
  it.each([
    [
      'an entry that is not a failure',
      { items: [failureFixture(), { nope: true }], next_page_token: null },
    ],
    ['a stop listed twice', { items: [failureFixture(), failureFixture()], next_page_token: null }],
    [
      'the same stop in other letters',
      {
        items: [failureFixture(), failureFixture({ pickup_stop_id: WORK_STOP_ID.toUpperCase() })],
        next_page_token: null,
      },
    ],
    ['no position of a next page', { items: [] }],
    ['a position that is empty', { items: [], next_page_token: '' }],
    ['a position that is not text', { items: [], next_page_token: 4 }],
    ['a position that is too long', { items: [], next_page_token: 'x'.repeat(2049) }],
    ['items that are not a list', { items: {}, next_page_token: null }],
    [
      'more items than a page holds',
      {
        items: distinctFailures(MAX_PAGE_ITEMS + 1),
        next_page_token: null,
      },
    ],
  ])('is refused with %s', (_name, body) => {
    expect(parsePickupFailurePage(body)).toBeUndefined();
  });

  // Break caught: a limit on a page that refuses what the contract allows (the guard of the size must be the contract's, no less).
  it('believes a page of exactly as many items as the contract allows', () => {
    expect(
      parsePickupFailurePage({ items: distinctFailures(MAX_PAGE_ITEMS), next_page_token: null })
        ?.items,
    ).toHaveLength(MAX_PAGE_ITEMS);
  });
});

describe('a handshake that needs Ops', () => {
  it('is read with why it needs Ops, the limits as they stand and no code', () => {
    const handshake = parseOpsHandshake(opsHandshakeFixture());

    expect(handshake).toMatchObject({
      id: WORK_ROW_ID,
      state: 'EXPIRED',
      stop_state: 'ARRIVED',
      routed_because: 'CODE_EXPIRED',
      attempts: 0,
      attempt_limit: 5,
      fallback_sends: 0,
      fallback_limit: 3,
      channel: null,
      authorised_by: null,
    });
  });

  // Break caught: a code or a digest carried to a screen that must never draw one.
  it('keeps no code and no digest of the handshake', () => {
    const handshake = parseOpsHandshake({
      ...opsHandshakeFixture(),
      code: '483920',
      code_digest: 'sha256:abc',
      verification_note: 'Called the vendor on a number I know.',
    });

    expect(JSON.stringify(handshake)).not.toContain('483920');
    expect(JSON.stringify(handshake)).not.toContain('sha256');
    expect(JSON.stringify(handshake)).not.toContain('Called the vendor');
  });

  it('is read as one Ops settled, with who and how', () => {
    const handshake = parseOpsHandshake(
      opsHandshakeFixture({
        state: 'MANUALLY_RESOLVED',
        routed_because: null,
        channel: 'OPS_OVERRIDE',
        confirmed_at: '2026-11-04T10:00:00Z',
        authorised_by: OTHER_ID,
      }),
    );

    expect(handshake).toMatchObject({
      state: 'MANUALLY_RESOLVED',
      routed_because: null,
      channel: 'OPS_OVERRIDE',
      authorised_by: OTHER_ID,
    });
  });

  it('keeps a limit that the platform holds no usable value for as null, and never as a default', () => {
    const handshake = parseOpsHandshake(
      opsHandshakeFixture({ attempt_limit: null, fallback_limit: null }),
    );

    expect(handshake?.attempt_limit).toBeNull();
    expect(handshake?.fallback_limit).toBeNull();
  });

  it.each([
    ['a state the contract does not have', { state: 'LOST' as never }],
    ['a stop state the contract does not have', { stop_state: 'LOST' as never }],
    ['a direction the contract does not have', { direction: 'SIDEWAYS' as never }],
    [
      'a reason it was routed that the contract does not have',
      { routed_because: 'BORED' as never },
    ],
    ['a channel the contract does not have', { channel: 'CARRIER_PIGEON' as never }],
    ['an identifier that is not one', { id: 'nope' }],
    ['a negative number of attempts', { attempts: -1 }],
    ['a limit of zero', { attempt_limit: 0 }],
    ['an expiry that is not an instant', { expires_at: 'soon' }],
    ['a creation moment that is missing', { created_at: undefined as never }],
  ])('is refused with %s', (_name, overrides) => {
    expect(parseOpsHandshake(opsHandshakeFixture(overrides))).toBeUndefined();
  });

  it('reads a page and refuses one that lists a handshake twice', () => {
    expect(
      parseOpsHandshakePage({ items: [opsHandshakeFixture()], next_page_token: null })?.items,
    ).toHaveLength(1);
    expect(
      parseOpsHandshakePage({
        items: [opsHandshakeFixture(), opsHandshakeFixture()],
        next_page_token: null,
      }),
    ).toBeUndefined();
  });
});

describe('a short count', () => {
  it('is read with the three figures, the reason and the notice to the office', () => {
    expect(parseShortfall(shortfallFixture())).toMatchObject({
      declared_count: 5,
      collected_count: 3,
      shortfall_count: 2,
      reason: { code: 'PARCELS_NOT_READY', attribution: 'VENDOR' },
      stop_state: 'PARTIALLY_COLLECTED',
      run_state: 'IN_PROGRESS',
      office_notified_at: '2026-11-04T09:40:00Z',
    });
  });

  // Break caught: a shortfall that does not add up, shown with the figures as sent (the page works out none of it, and a sum that is not the API's is refused).
  it.each([
    ['a shortfall that is not the declared count less the counted one', { shortfall_count: 1 }],
    ['a declared count of zero', { declared_count: 0, collected_count: 0, shortfall_count: 0 }],
    ['a counted figure of zero', { collected_count: 0, shortfall_count: 5 }],
    ['a recorder that is not an identifier', { recorded_by: 'rider' }],
    ['a run state the contract does not have', { run_state: 'LOST' as never }],
    ['a notice moment that is not an instant', { office_notified_at: '9am' }],
  ])('is refused with %s', (_name, overrides) => {
    expect(parseShortfall(shortfallFixture(overrides))).toBeUndefined();
  });

  it('reads a page and refuses one that lists a short count twice', () => {
    expect(
      parseShortfallPage({ items: [shortfallFixture()], next_page_token: null })?.items,
    ).toHaveLength(1);
    expect(
      parseShortfallPage({
        items: [shortfallFixture(), shortfallFixture()],
        next_page_token: null,
      }),
    ).toBeUndefined();
  });
});

describe('a collection dispute', () => {
  it('is read with the vendor’s words, what was declared and what was counted', () => {
    expect(parseDispute(disputeFixture())).toMatchObject({
      state: 'OPEN',
      note: 'The rider took three parcels and I handed over five.',
      declared_count: 5,
      collected_count: 3,
      variance: 'SHORT',
      resolved_at: null,
    });
  });

  // Break caught: the vendor's words shown as markup: the guard keeps them as the text they are, so the page can draw them as text and no more.
  it('keeps the vendor’s note as text, whatever is in it', () => {
    const dispute = parseDispute(disputeFixture({ note: '<img src=x onerror=alert(1)>' }));

    expect(dispute?.note).toBe('<img src=x onerror=alert(1)>');
  });

  it.each([
    ['a resolved dispute with no moment of its resolution', { state: 'RESOLVED' as const }],
    ['a moment of resolution on an open dispute', { resolved_at: '2026-11-05T09:00:00Z' }],
    ['a short count that is not below the declared one', { collected_count: 5 }],
    ['a match that is below the declared count', { variance: 'MATCH' as const }],
    ['a note that is blank', { note: '   ' }],
    ['a note that is too long', { note: 'x'.repeat(1001) }],
    ['a vendor that is not an identifier', { vendor_organization_id: 'v' }],
    ['a state the contract does not have', { state: 'CLOSED' as never }],
  ])('is refused with %s', (_name, overrides) => {
    expect(parseDispute(disputeFixture(overrides))).toBeUndefined();
  });

  it('is read as resolved with its moment', () => {
    expect(
      parseDispute(disputeFixture({ state: 'RESOLVED', resolved_at: '2026-11-05T09:00:00Z' })),
    ).toMatchObject({ state: 'RESOLVED', resolved_at: '2026-11-05T09:00:00Z' });
  });

  it('reads a page and refuses one that lists a dispute twice', () => {
    expect(
      parseDisputePage({ items: [disputeFixture()], next_page_token: null })?.items,
    ).toHaveLength(1);
    expect(
      parseDisputePage({ items: [disputeFixture(), disputeFixture()], next_page_token: null }),
    ).toBeUndefined();
  });
});

describe('a piece of evidence', () => {
  it('is read with the facts the tile draws and nothing that would reach the image', () => {
    const item = parseStopEvidenceItem({
      ...evidenceItemFixture(),
      object_key: 'evidence/abc',
      url: 'https://bucket.example/abc?sig=1',
    });

    expect(item).toEqual({
      id: WORK_EVIDENCE_ID,
      purpose: 'PARCEL_PHOTO',
      state: 'STORED',
      captured_at: '2026-11-04T09:30:00Z',
      uploaded_at: '2026-11-04T09:31:00Z',
      content_type: 'image/jpeg',
      scanned_clean: true,
    });
  });

  it('reads one that is still waiting for its upload, with no moment of one', () => {
    expect(
      parseStopEvidenceItem(
        evidenceItemFixture({ state: 'PENDING_UPLOAD', uploaded_at: null, scanned_clean: false }),
      ),
    ).toMatchObject({ state: 'PENDING_UPLOAD', uploaded_at: null });
  });

  // Break caught: a record that says one thing and shows the other (stored with no upload, an upload of one that was not stored, a clean verdict on a file never stored).
  it.each([
    ['a stored record with no upload', { uploaded_at: null }],
    [
      'an upload on a record that is not stored',
      { state: 'PENDING_UPLOAD' as const, scanned_clean: false },
    ],
    ['a clean verdict on a file never stored', { state: 'EXPIRED' as const, uploaded_at: null }],
    ['a purpose the contract does not have', { purpose: 'SELFIE' as never }],
    ['a state the contract does not have', { state: 'DELETED' as never }],
    ['a content type that is not one', { content_type: 'image' }],
    ['a content type with a space', { content_type: 'image/j peg' }],
    ['a verdict that is not a boolean', { scanned_clean: 'yes' as never }],
    ['an identifier that is not one', { id: '123' }],
  ])('is refused with %s', (_name, overrides) => {
    expect(parseStopEvidenceItem(evidenceItemFixture(overrides))).toBeUndefined();
  });
});

describe('a page of a stop’s evidence', () => {
  it('is read with the progress of the whole stop and the exception, null where there is none', () => {
    const page = parseStopEvidencePage(
      evidenceListFixture({
        items: [evidenceItemFixture()],
        parcel_photos: { declared: 12, stored: 10, pending: 2, expired: 1 },
        next_page_token: 'next',
      }),
    );

    expect(page).toMatchObject({
      nextPageToken: 'next',
      parcel_photos: { declared: 12, stored: 10, pending: 2, expired: 1 },
      parcel_photo_exception: null,
    });
    expect(page?.items).toHaveLength(1);
  });

  it('is read with who, when and why of an exception', () => {
    const page = parseStopEvidencePage(
      evidenceListFixture({
        items: [],
        parcel_photos: { declared: 0, stored: 0, pending: 0, expired: 0 },
        parcel_photo_exception: exceptionFixture(),
      }),
    );

    expect(page?.parcel_photo_exception).toMatchObject({
      authorised_at: '2026-11-04T09:20:00Z',
      note: 'The rider’s camera failed.',
    });
  });

  // Break caught: the progress of an answer that does not add up: declared is stored and pending together, and the page works out none of it.
  it.each([
    [
      'a declared count that is not the stored and the pending',
      { parcel_photos: { declared: 5, stored: 1, pending: 1, expired: 0 } },
    ],
    ['a negative count', { parcel_photos: { declared: 0, stored: -1, pending: 1, expired: 0 } }],
    [
      'a progress with no expired count',
      { parcel_photos: { declared: 1, stored: 1, pending: 0 } as never },
    ],
    ['no progress', { parcel_photos: undefined as never }],
    ['an exception that is not one', { parcel_photo_exception: { id: 'x' } as never }],
    ['a photo listed twice', { items: [evidenceItemFixture(), evidenceItemFixture()] }],
    ['an item that is not evidence', { items: [{ id: WORK_EVIDENCE_ID }] as never }],
  ])('is refused with %s', (_name, overrides) => {
    expect(parseStopEvidencePage(evidenceListFixture(overrides))).toBeUndefined();
  });
});

describe('an exception that let a count through without photos', () => {
  it('is read with the officer as an identifier and the note as text', () => {
    const exception = parseParcelPhotoException(exceptionFixture());

    expect(exception?.authorised_by).toBe('f57f8a9b-0c1d-4e2f-8a3b-4c5d6e7f8a9b');
    expect(exception?.note).toBe('The rider’s camera failed.');
  });

  it.each([
    ['a note that is blank', { note: ' ' }],
    ['an officer that is not an identifier', { authorised_by: 'Kofi' }],
    ['a moment that is not an instant', { authorised_at: 'noon' }],
    ['a stop that is not an identifier', { pickup_stop_id: '1' }],
  ])('is refused with %s', (_name, overrides) => {
    expect(parseParcelPhotoException(exceptionFixture(overrides))).toBeUndefined();
  });
});

describe('the authorization to read one photo', () => {
  const authorization = {
    method: 'GET',
    url: 'https://store.example/evidence/abc?token=t',
    expires_at: '2026-11-04T09:36:00Z',
  };

  it('is read with the address and the moment it runs out', () => {
    expect(parseRetrievalAuthorization(authorization)).toEqual({
      url: authorization.url,
      expires_at: authorization.expires_at,
    });
    expect(parseRetrievalAuthorization({ ...authorization, headers: {} })).toBeDefined();
  });

  // Break caught: an authorization the `<img>` cannot use drawn as a photo that never loads, or an address carrying a space or a control character reaching the element.
  it.each([
    ['a method that is not GET', { method: 'PUT' }],
    ['a header that is asked for', { headers: { Authorization: 'x' } }],
    ['a header that is not an object', { headers: 'x' }],
    ['an address that is empty', { url: '' }],
    ['an address with a space', { url: 'https://store.example/a b' }],
    ['an address with a line break', { url: 'https://store.example/a\nb' }],
    ['an address that is too long', { url: `https://store.example/${'a'.repeat(4100)}` }],
    ['an address that is not text', { url: 7 }],
    ['an expiry that is not an instant', { expires_at: 'later' }],
  ])('is refused with %s', (_name, overrides) => {
    expect(parseRetrievalAuthorization({ ...authorization, ...overrides })).toBeUndefined();
  });
});

describe('the handshake an act answers with', () => {
  it('is read as the handshake of the stop, with its state and channel', () => {
    expect(parseHandshake(handshakeFixture())).toEqual({
      stop_id: WORK_STOP_ID,
      state: 'MANUALLY_RESOLVED',
      direction: 'VENDOR_ENTERED_RIDER_DISPLAYED',
      channel: 'OPS_OVERRIDE',
    });
  });

  it('is read with no channel where it has none', () => {
    expect(parseHandshake({ ...handshakeFixture(), channel: undefined })?.channel).toBeNull();
  });

  it.each([
    ['a state the contract does not have', { state: 'LOST' as never }],
    ['a direction the contract does not have', { direction: 'SIDEWAYS' as never }],
    ['a channel the contract does not have', { channel: 'PIGEON' as never }],
    ['a stop that is not an identifier', { stop_id: 'x' }],
  ])('is refused with %s', (_name, overrides) => {
    expect(parseHandshake(handshakeFixture(overrides))).toBeUndefined();
  });
});
