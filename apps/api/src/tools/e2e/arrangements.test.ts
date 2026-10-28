import { describe, expect, it } from 'vitest';

import {
  ARRANGEMENTS,
  OBSERVATIONS,
  arrange,
  observe,
  type ArrangementClient,
} from './arrangements.js';

/** A connection that records what it was asked and answers from a list, so the statements can be read without a database. */
function fakeClient(answers: readonly { rows?: unknown[]; rowCount?: number }[] = []) {
  const asked: { text: string; values: readonly unknown[] }[] = [];
  let at = 0;
  const client: ArrangementClient = {
    query: (text, values = []) => {
      asked.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      const answer = answers[at] ?? { rows: [], rowCount: 0 };
      at += 1;
      return Promise.resolve({ rows: answer.rows ?? [], rowCount: answer.rowCount ?? 0 });
    },
  };
  return { client, asked };
}

describe('the arrangements of the integrated harness', () => {
  // Break caught: an arrangement the list does not name being run, which would make the tool a way to write any statement.
  it('refuses a name the list does not hold, before any statement is sent', async () => {
    const { client, asked } = fakeClient();
    await expect(arrange(client, 'drop-everything', ['a@b.example'])).rejects.toThrow(
      /not an arrangement/,
    );
    expect(asked).toEqual([]);
  });

  // Break caught: a statement built from the caller's text, which would let an argument change what the statement is.
  it('sends every value as a parameter and never in the text of a statement', async () => {
    for (const [name, arrangement] of Object.entries(ARRANGEMENTS)) {
      const { client, asked } = fakeClient([{ rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }]);
      const args = arrangement.sample;
      await arrange(client, name, args);
      expect(asked.length, name).toBeGreaterThan(0);
      for (const statement of asked) {
        for (const value of args) expect(statement.text, name).not.toContain(value);
      }
    }
  });

  // Break caught: an arrangement that reaches no row and says it worked, which would let a journey pass for a lapse that never happened.
  it('fails when it changed nothing', async () => {
    for (const [name, arrangement] of Object.entries(ARRANGEMENTS)) {
      const { client } = fakeClient([{ rowCount: 0 }, { rowCount: 0 }, { rowCount: 0 }]);
      await expect(arrange(client, name, arrangement.sample), name).rejects.toThrow(
        /changed no row/,
      );
    }
  });

  // Break caught: the wrong number of arguments being read as the right ones.
  it('refuses the wrong number of arguments', async () => {
    const { client, asked } = fakeClient();
    await expect(arrange(client, 'expire-setup-grant', ['a@b.example'])).rejects.toThrow(
      /takes 2 arguments/,
    );
    expect(asked).toEqual([]);
  });

  // Break caught: a purpose that is not one of the grants' purposes being sent on to the database.
  it('refuses a grant purpose the table does not hold', async () => {
    const { client, asked } = fakeClient();
    await expect(
      arrange(client, 'expire-setup-grant', ['a@b.example', 'ANYTHING']),
    ).rejects.toThrow(/purpose/);
    expect(asked).toEqual([]);
  });

  // Break caught: a lapse that ages another bucket (the staff sign-in's, which a journey is meant to meet), or that takes a key and so can be
  // pointed at a person; or that ages by less than the minute of the rolling window.
  it('lets the minute of the rider challenge limit pass for that bucket only, and takes no argument', async () => {
    const { client, asked } = fakeClient([{ rowCount: 3 }]);
    await expect(arrange(client, 'lapse-rider-challenge-window', [])).resolves.toBe(3);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.text).toBe(
      "update rate_limit_admission set admitted_at = admitted_at - interval '61 seconds' where bucket = 'rate_limit_rider_challenge'",
    );
    await expect(arrange(client, 'lapse-rider-challenge-window', ['x'])).rejects.toThrow(
      /takes 0 arguments/,
    );
  });

  // Break caught: the guard that stops the application from back-dating a session being left off for the update, or left off afterwards.
  it('turns the session guard off for the one update and on again whatever happened', async () => {
    const answers = [{ rowCount: 0 }, { rowCount: 1 }, { rowCount: 0 }];
    const { client, asked } = fakeClient(answers);
    await arrange(client, 'idle-session', ['a@b.example', '31']);
    expect(asked.map((statement) => statement.text.split(' ').slice(0, 5).join(' '))).toEqual([
      'alter table session disable trigger',
      'update session set issued_at =',
      'alter table session enable trigger',
    ]);

    const failing: ArrangementClient = {
      query: (text) =>
        text.startsWith('update')
          ? Promise.reject(new Error('refused'))
          : Promise.resolve({ rows: [], rowCount: 0 }),
    };
    const enabled: string[] = [];
    const watched: ArrangementClient = {
      query: (text, values) => {
        enabled.push(text.replace(/\s+/g, ' ').trim());
        return failing.query(text, values);
      },
    };
    await expect(arrange(watched, 'idle-session', ['a@b.example', '31'])).rejects.toThrow(
      'refused',
    );
    expect(enabled.at(-1)).toMatch(/enable trigger session_guard/);
  });

  // Break caught: a table's guard left off after the arrangement, which would let the application back-date a grant, a challenge or a
  // session for the rest of the run. Each guarded table is switched off, written once, and switched on again, and the guard is on again
  // when the write is refused.
  it.each([
    ['expire-setup-grant', ['a@b.example', 'STAFF_CREDENTIAL_SETUP'], 'setup_grant'],
    ['expire-mfa-challenge', ['a@b.example'], 'mfa_challenge'],
    ['idle-session', ['a@b.example', '31'], 'session'],
  ] as const)(
    '%s writes only with the guard of %s off, and leaves it on',
    async (name, args, table) => {
      const statements: string[] = [];
      const client: ArrangementClient = {
        query: (text) => {
          statements.push(text.replace(/\s+/g, ' ').trim());
          return text.trim().startsWith('update')
            ? Promise.reject(new Error('refused'))
            : Promise.resolve({ rows: [], rowCount: 1 });
        },
      };

      await expect(arrange(client, name, args)).rejects.toThrow('refused');

      expect(statements[0]).toMatch(new RegExp(`^alter table ${table} disable trigger `));
      expect(statements[1]).toMatch(/^update /);
      expect(statements.at(-1)).toMatch(new RegExp(`^alter table ${table} enable trigger `));
      expect(statements).toHaveLength(3);
    },
  );

  // Break caught: a period that is not a plain number of minutes being sent as one.
  it('takes minutes as a whole number from 1 to 100000', async () => {
    const { client, asked } = fakeClient();
    for (const bad of ['0', '-1', '1.5', 'x', '100001', '']) {
      await expect(arrange(client, 'idle-session', ['a@b.example', bad]), bad).rejects.toThrow(
        /minutes/,
      );
    }
    expect(asked).toEqual([]);
  });
});

describe('the observations of the integrated harness', () => {
  // Break caught: an observation the list does not name being run.
  it('refuses a name the list does not hold', async () => {
    const { client, asked } = fakeClient();
    await expect(observe(client, 'secrets', ['a@b.example'])).rejects.toThrow(/not an observation/);
    expect(asked).toEqual([]);
  });

  // Break caught: an observation that reads a column that holds a secret, which the harness would then carry into a log.
  it('reads no column that holds a secret', () => {
    for (const [name, observation] of Object.entries(OBSERVATIONS)) {
      expect(observation.text, name).not.toMatch(
        /hash|secret|ciphertext|nonce|seed|private|csrf_token|payload|bundle_snapshot/i,
      );
    }
  });

  it('answers with the rows the database gave', async () => {
    const { client } = fakeClient([{ rows: [{ status: 'REVOKED' }, { status: 'ACTIVE' }] }]);
    expect(await observe(client, 'factors', ['a@b.example'])).toEqual([
      { status: 'REVOKED' },
      { status: 'ACTIVE' },
    ]);
  });
});

describe('the vendor and rider entries of the lists (S0.62)', () => {
  // Break caught: a vendor or rider entry that takes any text as its key, so that a journey could reach a row it does not name.
  it('names a vendor by its identifier and a rider by its phone, and refuses anything else before a statement is sent', async () => {
    const { client, asked } = fakeClient([
      { rows: [] },
      { rows: [] },
      { rowCount: 0 },
      { rowCount: 0 },
    ]);
    await observe(client, 'vendor-sessions', ['ABCDEFGH']);
    await observe(client, 'rider-lock', ['+233200000001']);
    expect(asked.map((statement) => statement.values)).toEqual([['ABCDEFGH'], ['+233200000001']]);
    for (const [name, key] of [
      ['vendor-sessions', 'a@b.example'],
      ['vendor-lock', 'abcdefgh'],
      ['rider-sessions', 'ABCDEFGH'],
      ['rider-lock', '0200000001'],
    ] as const) {
      await expect(observe(client, name, [key]), name).rejects.toThrow();
    }
    await expect(arrange(client, 'expire-vendor-setup-grant', ['a@b.example'])).rejects.toThrow(
      /account identifier/,
    );
    expect(asked).toHaveLength(2);
    expect(ARRANGEMENTS['expire-vendor-setup-grant']?.arguments).toEqual(['account identifier']);
  });
});
