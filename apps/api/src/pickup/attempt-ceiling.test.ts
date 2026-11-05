import { describe, expect, it } from 'vitest';

import { SettingInvalidError, SettingMissingError } from '../platform/settings/settings-reader.js';
import type { HubConfiguration } from '../platform/settings/hub-configuration.js';
import type { DatabaseTransaction } from '../platform/database/database.service.js';
import {
  anomalyOf,
  attemptCapOf,
  attemptCeiling,
  hasExtensionOfItsOwn,
  extensionCeilingOf,
  permitsAnotherAttempt,
  permitsAttempt,
  refusalReleasedFor,
  refusedCollectionOf,
  type AttemptLimit,
} from './attempt-ceiling.js';

/**
 * The attempts a booking may make (`AC-SLICE-001-07`): the hub's cap, the ceiling an extension sets for the one request it is raised for,
 * and what each says about confirming a request and about making the next attempt of it.
 */
const SET = (cap: number, ceiling: number): AttemptLimit => ({ kind: 'SET', cap, ceiling });

describe('the ceiling of a request', () => {
  // Break caught: an extension that lowers the cap, or one that is ignored.
  it('is the cap, or the ceiling its extension set when that is higher', () => {
    expect(attemptCeiling(3, null)).toBe(3);
    expect(attemptCeiling(3, 4)).toBe(4);
    expect(attemptCeiling(3, 3)).toBe(3);
    // The cap raised since the extension was granted: the higher of the two stands.
    expect(attemptCeiling(5, 4)).toBe(5);
  });
});

describe('the attempts under a limit', () => {
  // Break caught: the boundary moved by one in either direction (a fourth attempt allowed at a cap of three, or a third refused).
  it('allows the next attempt of a request while it stays within the ceiling', () => {
    expect(permitsAnotherAttempt(SET(3, 3), 2)).toBe(true);
    expect(permitsAnotherAttempt(SET(3, 3), 3)).toBe(false);
    expect(permitsAnotherAttempt(SET(3, 4), 3)).toBe(true);
    expect(permitsAnotherAttempt(SET(3, 4), 4)).toBe(false);
  });

  it('confirms a request up to its ceiling and no further', () => {
    expect(permitsAttempt(SET(3, 3), 3)).toBe(true);
    expect(permitsAttempt(SET(3, 3), 4)).toBe(false);
    expect(permitsAttempt(SET(3, 4), 4)).toBe(true);
    expect(permitsAttempt(SET(3, 4), 5)).toBe(false);
  });

  // Break caught: a cap that is unset or invalid blocking an operational decision (it never does: the condition is recorded instead).
  it('blocks nothing where the cap cannot be read', () => {
    const none: AttemptLimit = { kind: 'UNAVAILABLE', anomaly: 'SETTING_MISSING' };
    expect(permitsAnotherAttempt(none, 99)).toBe(true);
    expect(permitsAttempt(none, 99)).toBe(true);
  });
});

describe('the ceiling an extension set', () => {
  /** A transaction that answers every statement with the rows given, and counts what it was asked. */
  const answering = (rows: readonly object[]) => {
    const asked: unknown[] = [];
    const tx = {
      execute: (statement: unknown) => {
        asked.push(statement);
        return Promise.resolve({ rows });
      },
    } as unknown as DatabaseTransaction;
    return { tx, asked };
  };

  it('is none for a request that names no extension, and asks nothing', async () => {
    const { tx, asked } = answering([{ ceiling_after: 9 }]);
    expect(await extensionCeilingOf(tx, { attempt_extension_id: null })).toBeNull();
    expect(asked).toEqual([]);
  });

  it('is the ceiling of the extension the request names', async () => {
    const { tx, asked } = answering([{ ceiling_after: 4 }]);
    expect(
      await extensionCeilingOf(tx, {
        attempt_extension_id: '0b0b0b0b-0000-4000-8000-000000000001',
      }),
    ).toBe(4);
    expect(asked).toHaveLength(1);
  });

  // Break caught: an extension the reader cannot read lifting the cap (a ceiling that cannot be shown is not one).
  it('is none for an extension the reader cannot read', async () => {
    const { tx } = answering([]);
    expect(
      await extensionCeilingOf(tx, {
        attempt_extension_id: '0b0b0b0b-0000-4000-8000-000000000001',
      }),
    ).toBeNull();
  });
});

describe('a refused collection (AC-SLICE-001-33)', () => {
  const answering = (rows: readonly object[]) =>
    ({ execute: () => Promise.resolve({ rows }) }) as unknown as DatabaseTransaction;
  const NAMES = '0b0b0b0b-0000-4000-8000-000000000001';

  // Break caught: a refusal read from a request with no failed refused stop, or missed for one that has it.
  it('is found through the failed stop of the request', async () => {
    expect(await refusedCollectionOf(answering([{ '?column?': 1 }]), NAMES)).toBe(true);
    expect(await refusedCollectionOf(answering([]), NAMES)).toBe(false);
  });

  // Break caught: a release read from any extension but the request's own (a clone carries its source's, which was raised for the source), from one that lifted a ceiling
  // and released nothing, or from no extension; and a row that is not read because the request names none.
  it('is released only by an extension raised for the request itself that says it released the restriction', async () => {
    const row = { id: NAMES, attempt_extension_id: '0c0c0c0c-0000-4000-8000-000000000002' };
    expect(await refusalReleasedFor(answering([{ '?column?': 1 }]), row)).toBe(true);
    // The extension is another request's (the clone's source), or it released nothing: the database finds no row for this request.
    expect(await refusalReleasedFor(answering([]), row)).toBe(false);
    // No extension named: nothing is asked.
    let asked = 0;
    const counting = {
      execute: () => {
        asked += 1;
        return Promise.resolve({ rows: [{ '?column?': 1 }] });
      },
    } as unknown as DatabaseTransaction;
    expect(await refusalReleasedFor(counting, { id: NAMES, attempt_extension_id: null })).toBe(
      false,
    );
    expect(asked).toBe(0);
  });

  // Break caught: an extension carried from the request this one replaces taken as this request's own, so that a second extension is attempted against the table's unique key.
  it('tells an extension of its own from one it carries', async () => {
    expect(await hasExtensionOfItsOwn(answering([{ '?column?': 1 }]), { id: NAMES })).toBe(true);
    expect(await hasExtensionOfItsOwn(answering([]), { id: NAMES })).toBe(false);
  });
});

describe('the cap of a hub', () => {
  const configuration = (read: () => { value: number }): HubConfiguration =>
    ({
      integer: (key: string, scope: string, minimum: number) => {
        expect([key, scope, minimum]).toEqual(['MELARC_MAX_PICKUP_ATTEMPTS', '', 1]);
        return read();
      },
    }) as unknown as HubConfiguration;

  it('is read from MELARC_MAX_PICKUP_ATTEMPTS, not below one', () => {
    expect(attemptCapOf(configuration(() => ({ value: 3 })))).toEqual({ kind: 'SET', cap: 3 });
  });

  // Break caught: the condition lost (the audit event could not say why the cap did not apply), or any failure swallowed as a missing setting.
  it('says why it is unavailable, and lets any other failure through', () => {
    expect(
      attemptCapOf(
        configuration(() => {
          throw new SettingMissingError('MELARC_MAX_PICKUP_ATTEMPTS');
        }),
      ),
    ).toEqual({ kind: 'UNAVAILABLE', anomaly: 'SETTING_MISSING' });
    expect(
      attemptCapOf(
        configuration(() => {
          throw new SettingInvalidError('MELARC_MAX_PICKUP_ATTEMPTS', 'not a whole number');
        }),
      ),
    ).toEqual({ kind: 'UNAVAILABLE', anomaly: 'SETTING_INVALID' });
    expect(() =>
      attemptCapOf(
        configuration(() => {
          throw new Error('the database went away');
        }),
      ),
    ).toThrow('the database went away');
  });

  it('names the two conditions of a setting and nothing else', () => {
    expect(anomalyOf(new SettingMissingError('x'))).toBe('SETTING_MISSING');
    expect(anomalyOf(new SettingInvalidError('x', 'y'))).toBe('SETTING_INVALID');
    expect(anomalyOf(new Error('x'))).toBeUndefined();
    expect(anomalyOf('x')).toBeUndefined();
  });
});
