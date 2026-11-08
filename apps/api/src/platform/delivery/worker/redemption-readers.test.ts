import { describe, expect, it } from 'vitest';

import {
  UNBUILT_REDEMPTION_READER,
  redemptionReaderOver,
  type RedemptionRecordReader,
  type RedemptionStanding,
} from './redemption-record-reader.js';

const answering = (standing: RedemptionStanding): RedemptionRecordReader & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    standing: (record) => {
      asked.push(`${record.type}:${record.id}`);
      return Promise.resolve(standing);
    },
  };
};

describe('the reader of redemption records, by the kind of record (S0.29, S0.50)', () => {
  // Break caught: a grant's standing read from the reader of another kind of record, so a recovery request's answer decides a grant.
  it('asks the reader of the record’s own type, and no other', async () => {
    const grants = answering('PENDING');
    const recoveries = answering('CLOSED');
    const reader = redemptionReaderOver({ SETUP_GRANT: grants, RECOVERY_REQUEST: recoveries });

    expect(await reader.standing({ type: 'SETUP_GRANT', id: 'g1' })).toBe('PENDING');
    expect(await reader.standing({ type: 'RECOVERY_REQUEST', id: 'r1' })).toBe('CLOSED');

    expect(grants.asked).toEqual(['SETUP_GRANT:g1']);
    expect(recoveries.asked).toEqual(['RECOVERY_REQUEST:r1']);
  });

  // Break caught (SECURITY_DESIGN.md §13.9a: "fails closed"): a record whose reader is not built being read as pending, so that a
  // message is sent for a credential nobody looked at. `RecoveryRequest` has no reader until S0.50.
  it('confirms nothing for a type with no reader, and for a type it does not know', async () => {
    const reader = redemptionReaderOver({ SETUP_GRANT: answering('PENDING') });

    expect(await reader.standing({ type: 'RECOVERY_REQUEST', id: 'r1' })).toBe('UNCONFIRMED');
    expect(await reader.standing({ type: 'SOMETHING_ELSE', id: 'x' })).toBe('UNCONFIRMED');
    expect(await reader.standing({ type: '__proto__', id: 'x' })).toBe('UNCONFIRMED');
    expect(await reader.standing({ type: 'toString', id: 'x' })).toBe('UNCONFIRMED');
  });

  // Break caught: a reader's failure turned into an answer. The worker takes a throw for UNCONFIRMED and logs it; a router that
  // swallowed it would hide a database fault behind the same word.
  it('lets a reader’s failure through to the worker', async () => {
    const failing: RedemptionRecordReader = {
      standing: () => Promise.reject(new Error('the read failed')),
    };
    const reader = redemptionReaderOver({ SETUP_GRANT: failing });

    await expect(reader.standing({ type: 'SETUP_GRANT', id: 'g1' })).rejects.toThrow(
      'the read failed',
    );
  });

  // Break caught: the worker started with readers it was never given: a router over no reader at all is not a reader that confirms.
  it('is not the unbuilt reader, and says whether it can confirm anything', () => {
    const none = redemptionReaderOver({});
    const some = redemptionReaderOver({ SETUP_GRANT: answering('PENDING') });

    expect(none).not.toBe(UNBUILT_REDEMPTION_READER);
    expect(some).not.toBe(UNBUILT_REDEMPTION_READER);
  });
});
