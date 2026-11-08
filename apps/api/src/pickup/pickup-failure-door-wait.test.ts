import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { SettingMissingError } from '../platform/settings/settings-reader.js';
import { serverError } from '../test-support/fake-pg.js';
import {
  doorWaitOf,
  doorWaitRefusal,
  failTheStop,
  refusalOfFailedWrite,
  type DoorWait,
} from './pickup-failure.service.js';

/** A check violation as the server sends it, with the DETAIL a guard trigger gave it. */
function refusal(detail: string): pg.DatabaseError {
  const error = serverError('23514', 'the stop’s guard refused the report');
  error.detail = detail;
  return error;
}

const AVAILABLE = new Date('2026-11-05T10:10:00.000Z');
const WAITING: DoorWait = { minutes: 10, availableAt: AVAILABLE, remaining: 120.25 };
const BOUNDARY: DoorWait = { minutes: 10, availableAt: AVAILABLE, remaining: -0.0004 };

/** The stop and the transaction of the act, as much of them as the helper touches. */
const STOP = {
  id: '11111111-1111-4111-8111-111111111111',
  responsible_hub_id: '22222222-2222-4222-8222-222222222222',
};
function transactionAnswering(rows: unknown[] | Error) {
  const statements: unknown[] = [];
  return {
    statements,
    tx: {
      execute: (statement: unknown) => {
        statements.push(statement);
        return rows instanceof Error ? Promise.reject(rows) : Promise.resolve({ rows });
      },
    },
  };
}

describe('the refusal of a report made before the door wait has passed', () => {
  // Break caught: the details of the refusal lost or mis-stated, so that a rider is told to wait and not for how long.
  it('is the contract’s 422 with the wait, the moment the report is allowed and the seconds to it, rounded up', () => {
    const answer = doorWaitRefusal(WAITING);

    expect(answer).toBeInstanceOf(ApiException);
    expect(answer.getStatus()).toBe(422);
    expect(answer.code).toBe(ErrorCode.PickupDoorWaitNotElapsed);
    expect(answer.details).toEqual({
      door_wait_minutes: 10,
      available_at: '2026-11-05T10:10:00.000Z',
      retry_after_seconds: 121,
    });
  });

  // Break caught: a refusal at the boundary that tells a rider to retry at once, or in the past, so that it retries into the same refusal.
  it('tells at least the floor it is given, and moves the moment with it', () => {
    const answer = doorWaitRefusal(BOUNDARY, 1);

    expect(answer.details).toMatchObject({ retry_after_seconds: 1 });
    // A second after the moment the check read (which was 0.4 ms short of the allowed one); a moment is told to the millisecond.
    expect(new Date((answer.details as { available_at: string }).available_at).getTime()).toBe(
      AVAILABLE.getTime() + 1000,
    );
  });
});

describe('what a statement the stop’s guard refused is told as', () => {
  // Break caught (the defect of the second review): the refusal of the door wait made by asking the database, in a transaction the server has aborted, so that the rider
  // met a server error (25P02) where it should have met the wait. Here nothing at all can be asked: there is no transaction.
  it('is the door wait from what the check read, with no statement sent', () => {
    const answer = refusalOfFailedWrite(refusal('reason=PICKUP_DOOR_WAIT_NOT_ELAPSED'), BOUNDARY);

    expect(answer).toBeInstanceOf(ApiException);
    expect((answer as ApiException).code).toBe(ErrorCode.PickupDoorWaitNotElapsed);
    expect((answer as ApiException).details).toMatchObject({
      door_wait_minutes: 10,
      retry_after_seconds: 1,
    });
  });

  // Break caught: a refusal of the door wait with no check before it answered as a server error.
  it('is still the contract’s error when the check did not run, with no details', () => {
    const answer = refusalOfFailedWrite(refusal('reason=PICKUP_DOOR_WAIT_NOT_ELAPSED'), undefined);

    expect(answer).toBeInstanceOf(ApiException);
    expect((answer as ApiException).code).toBe(ErrorCode.PickupDoorWaitNotElapsed);
  });

  // Break caught: the other reasons of the guard no longer answered as the reasons they are, or an error that is not a refusal swallowed.
  it('leaves the other refusals of the guard to their own answer, and any other failure as it is', () => {
    const reason = refusalOfFailedWrite(refusal('reason=REASON_NOT_ACTIVE'), WAITING);
    expect(reason).toBeInstanceOf(ApiException);
    expect((reason as ApiException).code).toBe(ErrorCode.ReasonNotActive);

    const other = new Error('the connection was lost');
    expect(refusalOfFailedWrite(other, WAITING)).toBe(other);
  });
});

describe('the wait of a stop', () => {
  // Break caught: a statement sent for a category that carries no wait, or a wait invented for it.
  it('is read for a category that carries one, and for no other', async () => {
    const none = transactionAnswering([]);
    expect(await doorWaitOf(none.tx as never, STOP as never, 'ACCESS_DENIED')).toBeUndefined();
    expect(none.statements).toHaveLength(0);

    const some = transactionAnswering([
      { minutes: 10, remaining: '-3.5', available_at: '2026-11-05T10:10:00.000Z' },
    ]);
    const wait = await doorWaitOf(some.tx as never, STOP as never, 'VENDOR_UNAVAILABLE');
    expect(wait).toEqual({ minutes: 10, availableAt: AVAILABLE, remaining: -3.5 });
    expect(some.statements).toHaveLength(1);
  });

  // Break caught: an arrival that was not recorded read as a wait that has passed (the guard refuses it, and the rider meets a server error after the check let it through).
  it('is an operational failure, not a passed wait, for a stop that holds no arrival', async () => {
    const unrecorded = transactionAnswering([{ minutes: 10, remaining: null, available_at: null }]);

    await expect(
      doorWaitOf(unrecorded.tx as never, STOP as never, 'VENDOR_UNAVAILABLE'),
    ).rejects.toThrow(/no moment of arrival/);
  });

  // Break caught: a hub with no usable value answered with a wait made up, instead of the operational failure of a setting the platform does not hold.
  it('is the operational failure of a missing setting, with no wait made up', async () => {
    const missing = transactionAnswering(refusal('reason=SETTING_MISSING'));

    await expect(
      doorWaitOf(missing.tx as never, STOP as never, 'VENDOR_UNAVAILABLE'),
    ).rejects.toBeInstanceOf(SettingMissingError);
  });
});

describe('the write of the failure', () => {
  /** A transaction whose first statement fails as the stop's guard refuses it, and which answers any other statement as the server does once it has aborted a transaction. */
  function abortingAfterTheGuard(detail: string) {
    const statements: unknown[] = [];
    return {
      statements,
      tx: {
        execute: (statement: unknown) => {
          statements.push(statement);
          return statements.length === 1
            ? Promise.reject(refusal(detail))
            : Promise.reject(
                serverError(
                  '25P02',
                  'current transaction is aborted, commands ignored until end of transaction block',
                ),
              );
        },
      },
    };
  }

  // Break caught (the defect of the second review, at the level of the act): a statement sent after the guard's refusal, in a transaction the server has aborted, so that the rider met
  // `25P02` (a server error) where it should have met the wait. Here the first statement is the write, the guard refuses it, and any statement after it fails as the server's would.
  it('is told as the door wait when the guard refuses it, and sends no statement after the refused one', async () => {
    const { tx, statements } = abortingAfterTheGuard('reason=PICKUP_DOOR_WAIT_NOT_ELAPSED');

    const outcome = await failTheStop(
      tx as never,
      STOP,
      'VENDOR_UNAVAILABLE',
      { reason_code: 'VENDOR_NOT_AT_LOCATION' },
      BOUNDARY,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(ApiException);
    expect((outcome as ApiException).code).toBe(ErrorCode.PickupDoorWaitNotElapsed);
    expect(statements).toHaveLength(1);
  });

  // Break caught: the other refusals of the guard answered as server errors, or a failure that is not the guard's swallowed.
  it('is told as the reason it is when the guard refuses the reason, and is not changed when the failure is not the guard’s', async () => {
    const reason = abortingAfterTheGuard('reason=REASON_NOT_ACTIVE');
    const refused = await failTheStop(
      reason.tx as never,
      STOP,
      'ACCESS_DENIED',
      {},
      undefined,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((refused as ApiException).code).toBe(ErrorCode.ReasonNotActive);

    const lost = new Error('the connection was lost');
    const failing = {
      execute: () => Promise.reject(lost),
    };
    await expect(failTheStop(failing as never, STOP, 'ACCESS_DENIED', {}, undefined)).rejects.toBe(
      lost,
    );
  });
});
