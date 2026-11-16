import { describe, expect, it } from 'vitest';

import {
  parseEvidenceDeclaration,
  parseEvidenceTicket,
  parseStoredEvidence,
} from './evidence-shape';

/**
 * What the upload of a file believes of the two answers it takes. **The instruction to send the bytes is a bearer capability**, so an instruction the portal cannot follow as it is (another method, a form to
 * fill in, an address that is neither `https` nor a path of the page's own origin) is refused whole, and the file is not sent.
 */
const OWNER = '1b4d6c0e-3a5f-4b7c-8d9e-0f1a2b3c4d5e';
const RECORD = '93c5e486-b2d7-43f4-a576-8192a3b4c5d6';
const EXPECTED = { owner_id: OWNER, purpose: 'CONDITION' } as const;

const ticket = (overrides: { evidence?: object; upload?: object } = {}) => ({
  evidence: {
    id: RECORD,
    owner_type: 'PICKUP_INTAKE',
    owner_id: OWNER,
    purpose: 'CONDITION',
    captured_at: '2026-11-14T09:00:00Z',
    captured_by_actor: OWNER,
    state: 'PENDING_UPLOAD',
    access_rule: 'x',
    retention_policy: 'y',
    ...overrides.evidence,
  },
  upload: {
    method: 'PUT',
    url: 'https://bucket.example/evidence/object-1?sig=abc',
    headers: { 'Content-Type': 'image/jpeg', 'x-amz-checksum-sha256': 'abc=' },
    expires_at: '2026-11-14T09:15:00Z',
    ...overrides.upload,
  },
});

describe('the ticket createEvidence answers with', () => {
  it('is the record and the instruction to send its bytes', () => {
    expect(parseEvidenceTicket(ticket(), EXPECTED)).toEqual({
      evidenceId: RECORD,
      state: 'PENDING_UPLOAD',
      upload: {
        url: 'https://bucket.example/evidence/object-1?sig=abc',
        headers: { 'Content-Type': 'image/jpeg', 'x-amz-checksum-sha256': 'abc=' },
        expires_at: '2026-11-14T09:15:00Z',
      },
    });
  });

  it('takes a path of the page’s own origin as an address, and a ticket with no headers', () => {
    const parsed = parseEvidenceTicket(
      ticket({ upload: { headers: undefined, url: '/test-evidence-store/object-1' } }),
      EXPECTED,
    );
    expect(parsed?.upload.url).toBe('/test-evidence-store/object-1');
    expect(parsed?.upload.headers).toEqual({});
  });

  // Break caught: the portal following an instruction it cannot follow as it is: bytes sent by another method, a form half-filled, or to an address that is not the store's.
  it.each([
    ['a POST', { method: 'POST' }],
    ['a form to fill in', { form_fields: { key: 'x' } }],
    ['a plain http address', { url: 'http://bucket.example/x' }],
    ['a protocol-relative address', { url: '//bucket.example/x' }],
    ['a javascript address', { url: 'javascript:alert(1)' }],
    ['a data address', { url: 'data:text/plain,hello' }],
    ['an address with a blank in it', { url: 'https://bucket.example/a b' }],
    ['no address', { url: undefined }],
    ['an address that is not a text', { url: 7 }],
    ['an address longer than any', { url: `https://bucket.example/${'a'.repeat(5000)}` }],
    ['a header with a line break', { headers: { 'X-Test': 'a\r\nb' } }],
    ['a header name that is not one', { headers: { 'X Test': 'a' } }],
    ['a header that is not a text', { headers: { 'X-Test': 3 } }],
    [
      'too many headers',
      {
        headers: Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [`X-${String(index)}`, 'a']),
        ),
      },
    ],
    ['an expiry that is not a moment', { expires_at: 'soon' }],
  ])('is refused whole with %s', (_name, upload) => {
    expect(parseEvidenceTicket(ticket({ upload }), EXPECTED)).toBeUndefined();
  });

  // Break caught: a ticket for a record that is not the one declared: another owner's, another purpose, or one that is already stored (its bytes would be sent for nothing).
  it.each([
    ['another owner', { owner_id: '2c5e7d1f-4b60-4c8d-9e0f-1a2b3c4d5e6f' }],
    ['another purpose', { purpose: 'OSD' }],
    ['a record that is stored already', { state: 'STORED' }],
    ['a record with no identifier', { id: 'record-1' }],
  ])('is refused whole when the record is %s', (_name, evidence) => {
    expect(parseEvidenceTicket(ticket({ evidence }), EXPECTED)).toBeUndefined();
  });

  it('is refused whole when it is not a ticket', () => {
    for (const body of [
      null,
      'x',
      [],
      {},
      { evidence: ticket().evidence },
      { upload: ticket().upload },
    ]) {
      expect(parseEvidenceTicket(body, EXPECTED)).toBeUndefined();
    }
  });
});

/**
 * What `createEvidence` answers for **a retry under the key it already answered** (the contract: "a retry with the same `Idempotency-Key` is told the same record and the same capability, made again from
 * the record"): the record in whatever state it has reached by now. A record that was completed while its answer was lost is `STORED`, and that is a success of the file, not a ticket to send bytes for.
 */
describe('the declaration createEvidence answers with, whatever state the record is in', () => {
  it('is a ticket for a record still waiting for its bytes', () => {
    expect(parseEvidenceDeclaration(ticket(), EXPECTED)).toEqual({
      state: 'PENDING_UPLOAD',
      ticket: parseEvidenceTicket(ticket(), EXPECTED),
    });
  });

  // Break caught: a lost answer taken for a refusal for ever: the retry is told the record is stored, and the portal calls the answer "not the API's" and offers "Try again" again.
  it('is the record, stored, whatever instruction it still carries', () => {
    expect(parseEvidenceDeclaration(ticket({ evidence: { state: 'STORED' } }), EXPECTED)).toEqual({
      state: 'STORED',
      evidenceId: RECORD,
    });
    // A stored record needs no instruction: one that cannot be followed, or none at all, changes nothing.
    expect(
      parseEvidenceDeclaration(
        { evidence: ticket({ evidence: { state: 'STORED' } }).evidence },
        EXPECTED,
      ),
    ).toEqual({ state: 'STORED', evidenceId: RECORD });
    expect(
      parseEvidenceDeclaration(
        ticket({ evidence: { state: 'STORED' }, upload: { method: 'POST' } }),
        EXPECTED,
      ),
    ).toEqual({ state: 'STORED', evidenceId: RECORD });
  });

  it('is the record, expired, whatever instruction it still carries', () => {
    expect(parseEvidenceDeclaration(ticket({ evidence: { state: 'EXPIRED' } }), EXPECTED)).toEqual({
      state: 'EXPIRED',
      evidenceId: RECORD,
    });
  });

  // Break caught: the record that is not the one declared, taken as success in a state that needs no instruction (another owner's file counted as this one's).
  it.each([
    ['another owner', { owner_id: '2c5e7d1f-4b60-4c8d-9e0f-1a2b3c4d5e6f' }],
    ['another purpose', { purpose: 'OSD' }],
    ['no identifier', { id: 'record-1' }],
  ])('is refused whole when the record is of %s, in every state', (_name, evidence) => {
    for (const state of ['PENDING_UPLOAD', 'STORED', 'EXPIRED']) {
      expect(
        parseEvidenceDeclaration(ticket({ evidence: { ...evidence, state } }), EXPECTED),
      ).toBeUndefined();
    }
  });

  // Break caught: a record still waiting for bytes that the portal sends nowhere safe: its instruction is judged as before, and a record in another state the portal does not know is refused.
  it('refuses a record that waits for its bytes with an instruction it cannot follow, and a state it does not know', () => {
    expect(
      parseEvidenceDeclaration(ticket({ upload: { method: 'POST' } }), EXPECTED),
    ).toBeUndefined();
    expect(parseEvidenceDeclaration({ evidence: ticket().evidence }, EXPECTED)).toBeUndefined();
    expect(
      parseEvidenceDeclaration(ticket({ evidence: { state: 'ARCHIVED' } }), EXPECTED),
    ).toBeUndefined();
    expect(parseEvidenceDeclaration(null, EXPECTED)).toBeUndefined();
  });
});

describe('the record completeEvidenceUpload answers with', () => {
  it('is the record that was asked about, stored', () => {
    expect(parseStoredEvidence({ id: RECORD, state: 'STORED' }, RECORD)).toBe(RECORD);
    expect(parseStoredEvidence({ id: RECORD.toUpperCase(), state: 'STORED' }, RECORD)).toBe(
      RECORD.toUpperCase(),
    );
  });

  // Break caught: a file taken as stored when it is another record, or still waiting: a finding would cite evidence with no bytes behind it.
  it.each([
    ['another record', { id: OWNER, state: 'STORED' }],
    ['a record still waiting', { id: RECORD, state: 'PENDING_UPLOAD' }],
    ['a record that never came', { id: RECORD, state: 'EXPIRED' }],
    ['no state', { id: RECORD }],
    ['nothing', null],
  ])('is not a stored record when it is %s', (_name, body) => {
    expect(parseStoredEvidence(body, RECORD)).toBeUndefined();
  });
});
