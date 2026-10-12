import { describe, expect, it } from 'vitest';

import {
  changeFixedPolicy,
  changeRoleBundle,
  PolicyChangeError,
  type PolicyChangeConnection,
} from './policy-change.js';

const BUNDLE = '5eed0001-0000-4000-8000-000000000001';

interface Sent {
  readonly text: string;
  readonly values: unknown[] | undefined;
}

/** A connection that records what it is sent and answers the policy-change call with a result, or fails the statement it is told to. */
class FakeConnection implements PolicyChangeConnection {
  readonly sent: Sent[] = [];
  constructor(
    private readonly options: {
      readonly result?: unknown;
      readonly fail?: { readonly on: RegExp; readonly error: Error };
    } = {},
  ) {}

  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.sent.push({ text, values });
    if (this.options.fail?.on.test(text) === true) return Promise.reject(this.options.fail.error);
    if (text.startsWith('select melarc.change_')) {
      return Promise.resolve({
        rows: [
          {
            result:
              'result' in this.options
                ? this.options.result
                : {
                    kind: 'REDUCTION',
                    revision: 2,
                    reduction_floor: 2,
                    minimum_revision: 2,
                    ended: ['b', 'a'],
                  },
          },
        ],
      });
    }
    return Promise.resolve({ rows: [{}] });
  }

  get texts(): string[] {
    return this.sent.map((each) => each.text);
  }
}

const databaseError = (code: string, detail?: string) =>
  Object.assign(new Error('refused by the database'), {
    code,
    ...(detail === undefined ? {} : { detail }),
  });

describe('changeRoleBundle: one change, one transaction, at read committed', () => {
  // Break caught: the change sent outside a transaction of its own, so that its timeouts leak to the next statement of a reused
  // connection, or the lock is held past the change; or the timeouts set for the session and not the transaction.
  it('opens a transaction at read committed, sets its timeouts locally, calls the function once and commits', async () => {
    const connection = new FakeConnection();

    await changeRoleBundle(connection, {
      bundleId: BUNDLE,
      correlationId: 'release-1',
      name: 'Renamed',
    });

    expect(connection.texts).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      `select set_config('lock_timeout', $1::text, true), set_config('statement_timeout', $2::text, true)`,
      'select melarc.change_role_bundle($1::uuid, $2::text, $3::jsonb, $4::text) as result',
      'COMMIT',
    ]);
    expect(connection.sent[1]?.values).toEqual(['10000ms', '30000ms']);
  });

  // Break caught: a caller's value becoming part of a statement. Every statement is fixed text, and the caller's values are parameters.
  it('sends the bundle, the name, the grants and the correlation as parameters, and the grants in the function’s own names', async () => {
    const connection = new FakeConnection();

    await changeRoleBundle(connection, {
      bundleId: BUNDLE.toUpperCase(),
      name: `x'; drop table role_bundle; --`,
      correlationId: 'release-1',
      grants: [
        { permissionKey: 'staff.read', hubScope: 'own', ownershipScope: 'any', tier: 'A' },
        { permissionKey: 'vendor.read', hubScope: 'none', ownershipScope: 'assigned', tier: null },
      ],
    });

    const call = connection.sent[2];
    expect(call?.text).not.toContain('drop table');
    const [bundle, name, grants, correlation] = call?.values ?? [];
    expect(bundle).toBe(BUNDLE);
    expect(name).toBe(`x'; drop table role_bundle; --`);
    expect(JSON.parse(String(grants))).toEqual([
      { permission_key: 'staff.read', hub_scope: 'own', ownership_scope: 'any', tier: 'A' },
      { permission_key: 'vendor.read', hub_scope: 'none', ownership_scope: 'assigned', tier: null },
    ]);
    expect(correlation).toBe('release-1');
  });

  // Break caught: a change of the name alone sending an empty set of grants, which would remove every grant of the bundle.
  it('sends no grants at all (null, which leaves them alone) when the change names none, and an empty set when it says so', async () => {
    const none = new FakeConnection();
    const empty = new FakeConnection();

    await changeRoleBundle(none, { bundleId: BUNDLE, correlationId: 'c', name: 'N' });
    await changeRoleBundle(empty, { bundleId: BUNDLE, correlationId: 'c', grants: [] });

    expect(none.sent[2]?.values?.[2]).toBeNull();
    expect(none.sent[2]?.values?.[1]).toBe('N');
    expect(empty.sent[2]?.values?.[2]).toBe('[]');
    expect(empty.sent[2]?.values?.[1]).toBeNull();
  });

  it('sets the timeouts it is given, in milliseconds', async () => {
    const connection = new FakeConnection();

    await changeRoleBundle(
      connection,
      { bundleId: BUNDLE, correlationId: 'c', grants: [] },
      { lockTimeoutMs: 250, statementTimeoutMs: 4_000 },
    );

    expect(connection.sent[1]?.values).toEqual(['250ms', '4000ms']);
  });

  // Break caught: a malformed request that reaches the database, or one that leaves a transaction open. Each is refused before any
  // statement is sent.
  it.each([
    ['a bundle that is not an id', { bundleId: 'not-an-id', correlationId: 'c' }, {}],
    ['a bundle id with something appended', { bundleId: `${BUNDLE}'`, correlationId: 'c' }, {}],
    ['an empty correlation id', { bundleId: BUNDLE, correlationId: '' }, {}],
    [
      'a correlation id of 129 characters',
      { bundleId: BUNDLE, correlationId: 'x'.repeat(129) },
      {},
    ],
    // The ledger takes this text as it is. The grammar is a check of shape, not a screen for personal data: the caller passes a
    // generated identifier or the label of a release step, never text a user supplied.
    ['a correlation id with a space', { bundleId: BUNDLE, correlationId: 'release step' }, {}],
    [
      'a correlation id that is an address',
      { bundleId: BUNDLE, correlationId: 'ama@example.test' },
      {},
    ],
    [
      'a correlation id with a line break',
      { bundleId: BUNDLE, correlationId: 'release\nstep' },
      {},
    ],
    [
      'a correlation id that starts with a symbol',
      { bundleId: BUNDLE, correlationId: '-release' },
      {},
    ],
    ['a zero lock timeout', { bundleId: BUNDLE, correlationId: 'c' }, { lockTimeoutMs: 0 }],
    ['a fractional timeout', { bundleId: BUNDLE, correlationId: 'c' }, { statementTimeoutMs: 1.5 }],
    ['a timeout of a day', { bundleId: BUNDLE, correlationId: 'c' }, { lockTimeoutMs: 86_400_000 }],
  ])('refuses %s before any statement is sent', async (_label, change, options) => {
    const connection = new FakeConnection();

    await expect(changeRoleBundle(connection, change, options)).rejects.toBeInstanceOf(RangeError);

    expect(connection.sent).toEqual([]);
  });

  it('returns the kind, the revision, the floor and the ended sessions, frozen', async () => {
    const connection = new FakeConnection({
      result: { kind: 'ADDITION', revision: 3, reduction_floor: 1, ended: [] },
    });

    const result = await changeRoleBundle(connection, { bundleId: BUNDLE, correlationId: 'c' });

    expect(result).toEqual({ kind: 'ADDITION', revision: 3, floor: 1, endedSessionIds: [] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.endedSessionIds)).toBe(true);
  });
});

describe('changeFixedPolicy', () => {
  it('calls the function with the audience, whether the release reduced the rules and the correlation, and reads the minimum revision as the floor', async () => {
    const connection = new FakeConnection({
      result: { kind: 'REDUCTION', revision: 4, minimum_revision: 4, ended: ['x'] },
    });

    const result = await changeFixedPolicy(connection, {
      principalType: 'RIDER',
      reduction: true,
      correlationId: 'release-9',
    });

    expect(connection.texts[2]).toBe(
      'select melarc.change_fixed_policy($1::text, $2::boolean, $3::text) as result',
    );
    expect(connection.sent[2]?.values).toEqual(['RIDER', true, 'release-9']);
    expect(result).toEqual({ kind: 'REDUCTION', revision: 4, floor: 4, endedSessionIds: ['x'] });
    expect(connection.texts.at(-1)).toBe('COMMIT');
  });

  it.each(['STAFF', 'vendor', '', undefined, 'VENDOR OR TRUE'])(
    'refuses an audience that has no fixed policy (%s), before any statement is sent',
    async (principalType) => {
      const connection = new FakeConnection();

      await expect(
        changeFixedPolicy(connection, {
          principalType: principalType as never,
          reduction: false,
          correlationId: 'c',
        }),
      ).rejects.toBeInstanceOf(RangeError);

      expect(connection.sent).toEqual([]);
    },
  );

  it.each([undefined, null, 'true', 1])(
    'refuses a reduction flag that is not a boolean (%s), before any statement is sent',
    async (reduction) => {
      const connection = new FakeConnection();

      await expect(
        changeFixedPolicy(connection, {
          principalType: 'VENDOR',
          reduction: reduction as never,
          correlationId: 'c',
        }),
      ).rejects.toBeInstanceOf(RangeError);

      expect(connection.sent).toEqual([]);
    },
  );
});

describe('what the database refuses is named, and nothing is kept', () => {
  // Break caught: a refusal read as another, or an unknown failure swallowed: the lock timeout is the one a release step retries.
  it.each([
    ['55P03', undefined, 'LOCK_TIMEOUT'],
    ['57014', undefined, 'DEADLINE'],
    ['22023', undefined, 'INVALID'],
    ['P0002', undefined, 'NOT_FOUND'],
    ['25000', undefined, 'WRONG_ISOLATION'],
    ['55000', 'lock_order', 'LOCK_PROTOCOL'],
    ['55000', 'lock_upgrade', 'LOCK_PROTOCOL'],
  ])('maps SQLSTATE %s %s to %s, and rolls back', async (code, detail, failure) => {
    const connection = new FakeConnection({
      fail: { on: /^select melarc\.change_/, error: databaseError(code, detail) },
    });

    const error = await changeRoleBundle(connection, {
      bundleId: BUNDLE,
      correlationId: 'c',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PolicyChangeError);
    expect(error).toMatchObject({ failure, sqlState: code });
    expect(connection.texts.at(-1)).toBe('ROLLBACK');
    expect(connection.texts).not.toContain('COMMIT');
  });

  it.each([
    ['a constraint', databaseError('23505')],
    ['a missing permission', databaseError('23503')],
    ['the seed refusal code without a lock detail', databaseError('55000')],
    ['a connection that is gone', new Error('Connection terminated')],
  ])('passes %s on unchanged, and rolls back', async (_label, error) => {
    const connection = new FakeConnection({ fail: { on: /^select melarc\.change_/, error } });

    const caught = await changeRoleBundle(connection, {
      bundleId: BUNDLE,
      correlationId: 'c',
    }).catch((thrown: unknown) => thrown);

    expect(caught).toBe(error);
    expect(connection.texts.at(-1)).toBe('ROLLBACK');
  });

  // Break caught: a commit that fails leaving the transaction open on a connection that is reused, or reported as a success.
  it('rolls back, and fails, when the commit fails', async () => {
    const connection = new FakeConnection({
      fail: { on: /^COMMIT$/, error: databaseError('40001') },
    });

    await expect(
      changeRoleBundle(connection, { bundleId: BUNDLE, correlationId: 'c' }),
    ).rejects.toMatchObject({ code: '40001' });

    expect(connection.texts.at(-1)).toBe('ROLLBACK');
  });

  it('fails, and rolls back, when the function returns nothing', async () => {
    const connection = new FakeConnection({ result: null });

    await expect(
      changeRoleBundle(connection, { bundleId: BUNDLE, correlationId: 'c' }),
    ).rejects.toThrow(/returned no result/);

    expect(connection.texts.at(-1)).toBe('ROLLBACK');
  });

  // Break caught: an error message that repeats what was sent (a name, a permission, an id), which would reach a log.
  it('says nothing of the change in the message of a refusal', async () => {
    const connection = new FakeConnection({
      fail: { on: /^select melarc\.change_/, error: databaseError('22023') },
    });

    const error = (await changeRoleBundle(connection, {
      bundleId: BUNDLE,
      name: 'A Secret Bundle Name',
      correlationId: 'release-secret',
    }).catch((caught: unknown) => caught)) as PolicyChangeError;

    expect(error.message).not.toContain('A Secret Bundle Name');
    expect(error.message).not.toContain(BUNDLE);
    expect(error.message).not.toContain('release-secret');
  });
});
