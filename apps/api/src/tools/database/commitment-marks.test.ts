import { describe, expect, it } from 'vitest';

import {
  COMMITMENT_MARKS_USAGE,
  formatCommitmentReport,
  isConsistent,
  parseCommitmentMarkArguments,
  runCommitmentMarks,
  type CommitmentMarkReport,
} from './commitment-marks.js';
import type { SqlClient } from './provisioning.js';

/**
 * The upgrade check of migration 0064 (OB-S1-35): what the command takes and what it says. The check itself, against a database as migration
 * 0063 left it, is `test/database/commitment-upgrade.db.test.ts`.
 */
const clean: CommitmentMarkReport = {
  checkedAt: '2026-11-02 13:00:00',
  requestsTable: true,
  claimTables: true,
  confirmed: 12,
  stale: [],
  missing: [],
  keptMarked: 3,
};

describe('what the command takes', () => {
  // Break caught: a command that checks nothing until it is told which database, or that changes data without being asked.
  it('checks the development database and changes nothing when it is given no argument', () => {
    expect(parseCommitmentMarkArguments([])).toEqual({ database: 'melarc_dev', reconcile: false });
  });

  it('takes a database and the one flag that changes data, in either order', () => {
    expect(parseCommitmentMarkArguments(['melarc_test_ab12cd', '--reconcile'])).toEqual({
      database: 'melarc_test_ab12cd',
      reconcile: true,
    });
    expect(parseCommitmentMarkArguments(['--reconcile', 'melarc_dev'])).toEqual({
      database: 'melarc_dev',
      reconcile: true,
    });
  });

  // Break caught: a mistyped flag read as a database name, or a second database silently ignored, in a command that can change data.
  it.each([['--reconcil'], ['--drop'], ['melarc_dev', 'melarc_test_ab12cd'], ['--reconcile=yes']])(
    'refuses %j and says how to use it',
    (...argv) => {
      expect(() => parseCommitmentMarkArguments(argv)).toThrow(COMMITMENT_MARKS_USAGE);
    },
  );
});

describe('what the command says', () => {
  it('says a consistent database is consistent, and that cancelled requests keep what they were decided on', () => {
    const text = formatCommitmentReport('melarc_dev', clean);
    expect(isConsistent(clean)).toBe(true);
    expect(text).toContain('melarc_dev');
    expect(text).toContain('12 confirmed requests');
    expect(text).toContain('consistent');
    expect(text).toContain('3 requests that are not confirmed carry the mark');
    expect(text).toContain('never changed');
  });

  // Break caught: a report that names a count and not the requests, which the owner cannot reconcile or record.
  it('names the requests that disagree with their claims, by code and identifier, and how to put them right', () => {
    const report: CommitmentMarkReport = {
      ...clean,
      stale: [{ id: '11111111-1111-4111-8111-111111111111', code: 'ACC-PR-AAA111' }],
      missing: [{ id: '22222222-2222-4222-8222-222222222222', code: 'ACC-PR-BBB222' }],
    };
    const text = formatCommitmentReport('melarc_dev', report);
    expect(isConsistent(report)).toBe(false);
    expect(text).toContain('ACC-PR-AAA111');
    expect(text).toContain('11111111-1111-4111-8111-111111111111');
    expect(text).toContain('ACC-PR-BBB222');
    expect(text).toContain('--reconcile');
    expect(text).not.toContain('result: consistent');
  });

  it('says what it changed when it reconciled', () => {
    const report: CommitmentMarkReport = {
      ...clean,
      stale: [{ id: '11111111-1111-4111-8111-111111111111', code: 'ACC-PR-AAA111' }],
    };
    const text = formatCommitmentReport('melarc_dev', report, {
      lowered: [{ id: '11111111-1111-4111-8111-111111111111', code: 'ACC-PR-AAA111' }],
      raised: [],
    });
    expect(text).toContain('lowered 1');
    expect(text).toContain('raised 0');
    expect(text).toContain('ACC-PR-AAA111');
  });

  // Break caught: a database before the manifest tables read as inconsistent, or as consistent for a reason that is not true.
  it('says why a database with no manifest tables has nothing that can hold a request', () => {
    const text = formatCommitmentReport('melarc_dev', { ...clean, claimTables: false });
    expect(text).toContain('no manifest tables');
    expect(text).toContain('0058');
  });

  it('says there is nothing to check in a database with no pickup requests', () => {
    const text = formatCommitmentReport('melarc_dev', {
      ...clean,
      requestsTable: false,
      claimTables: false,
      confirmed: 0,
      keptMarked: 0,
    });
    expect(text).toContain('no pickup_request table');
  });
});

/** A connection that answers as a database with these confirmed requests would, and keeps every statement it was sent, in order. */
function scripted(options: { readonly afterReconcileStillWrong?: boolean } = {}) {
  const sent: string[] = [];
  let rows = [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      code: 'ACC-PR-AAA111',
      marked: true,
      committed: false,
    },
  ];
  const client: SqlClient = {
    query: (text) => {
      sent.push(text.trim().split(/\s+/).join(' '));
      if (text.includes('to_regclass')) {
        return Promise.resolve({
          rows: [{ requests: true, claims: true, at: '2026-11-02 13:00:00 UTC' }],
        });
      }
      if (text.includes("where r.state = 'CONFIRMED'")) return Promise.resolve({ rows });
      if (text.includes('count(*)::int')) return Promise.resolve({ rows: [{ n: 0 }] });
      if (text.startsWith('update public.pickup_request')) {
        const changed = rows.filter((row) => row.marked !== row.committed);
        if (options.afterReconcileStillWrong !== true) {
          rows = rows.map((row) => ({ ...row, marked: row.committed }));
        }
        return Promise.resolve({
          rows: changed.map((row) => ({ id: row.id, code: row.code, committed: row.committed })),
        });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return { client, sent };
}

describe('what the command does to the database', () => {
  // Break caught: a check that writes, so that looking at a database changes it.
  it('changes nothing when it is not asked to reconcile', async () => {
    const { client, sent } = scripted();
    const run = await runCommitmentMarks(client, { reconcile: false });

    expect(run.consistent).toBe(false);
    expect(run.reconciled).toBeUndefined();
    expect(sent.some((text) => /^(update|begin|lock|commit)/i.test(text))).toBe(false);
  });

  // Break caught: a repair made under no lock (it is judged on a snapshot and could meet a writer), outside a transaction, or committed unchecked.
  it('reconciles in one transaction that locks the three tables against writers first, and commits only after it has checked', async () => {
    const { client, sent } = scripted();
    const run = await runCommitmentMarks(client, { reconcile: true });

    expect(run.consistent).toBe(true);
    expect(run.reconciled?.lowered.map((each) => each.code)).toEqual(['ACC-PR-AAA111']);
    const order = [
      'begin',
      "set local lock_timeout = '10s'",
      'lock table',
      'update public.pickup_request',
      'commit',
    ];
    const at = order.map((start) => sent.findIndex((text) => text.startsWith(start)));
    expect(
      at.every((index) => index >= 0),
      JSON.stringify(sent),
    ).toBe(true);
    expect([...at].toSorted((a, b) => a - b)).toEqual(at);
    const lock = sent.find((text) => text.startsWith('lock table')) ?? '';
    for (const table of ['pickup_request', 'pickup_stop', 'pickup_manifest']) {
      expect(lock, table).toContain(`public.${table}`);
    }
    expect(lock).toContain('share row exclusive mode');
    // The result is looked at again, inside the transaction, before it is committed.
    const rereadAt = sent.findLastIndex((text) => text.includes("where r.state = 'CONFIRMED'"));
    expect(rereadAt).toBeGreaterThan(at[3] ?? Infinity);
    expect(rereadAt).toBeLessThan(at[4] ?? -1);
  });

  // Break caught: a reconciliation committed although the marks still disagree with the claims, which would be recorded as done.
  it('rolls everything back, and says so, when the marks are still wrong after it', async () => {
    const { client, sent } = scripted({ afterReconcileStillWrong: true });

    await expect(runCommitmentMarks(client, { reconcile: true })).rejects.toThrow(
      /nothing was changed/,
    );
    expect(sent.some((text) => text === 'rollback')).toBe(true);
    expect(sent.some((text) => text === 'commit')).toBe(false);
  });

  // Break caught: a database that agrees being locked and rewritten because the flag was given.
  it('does not begin anything for a database that already agrees', async () => {
    const { client, sent } = scripted();
    await runCommitmentMarks(client, { reconcile: true });
    sent.length = 0;
    const again = await runCommitmentMarks(client, { reconcile: true });

    expect(again.consistent).toBe(true);
    expect(again.reconciled).toBeUndefined();
    expect(sent.some((text) => /^(update|begin|lock|commit)/i.test(text))).toBe(false);
  });
});
