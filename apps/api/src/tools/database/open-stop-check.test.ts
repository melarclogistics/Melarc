import { describe, expect, it } from 'vitest';

import { CliUsageError } from './cli.js';
import {
  checkOpenStops,
  formatOpenStopReport,
  isClear,
  parseOpenStopArguments,
  type OpenStopReport,
} from './open-stop-check.js';
import type { SqlClient } from './provisioning.js';

/**
 * The upgrade check of migration 0065 (S1.22; the Product Owner's decision of 2 November 2026: run it with sufficient visibility, and stop the
 * migration if it finds a violation): does a cancelled pickup request still hold a stop that is to be worked? The command reads and writes
 * nothing; what it reads and how it says so is what these tests hold, against a scripted connection. The database tests run it against real
 * databases, built before the migration.
 */
function scripted(
  probe: Record<string, unknown>,
  found: readonly Record<string, unknown>[] = [],
): { readonly client: SqlClient; readonly calls: string[] } {
  const calls: string[] = [];
  const client = {
    query: (text: string) => {
      calls.push(text);
      if (text.includes('to_regclass')) return Promise.resolve({ rows: [probe], rowCount: 1 });
      return Promise.resolve({ rows: [...found], rowCount: found.length });
    },
  } as unknown as SqlClient;
  return { client, calls };
}

const AT = '2026-11-03 09:00:00 UTC';

describe('the arguments of the open-stop check', () => {
  it('defaults to the development database and takes one name', () => {
    expect(parseOpenStopArguments([])).toEqual({ database: 'melarc_dev' });
    expect(parseOpenStopArguments(['melarc_test_ab12'])).toEqual({ database: 'melarc_test_ab12' });
  });

  // Break caught: a flag that would let the command write (this one has none), a second database, or an argument taken as a name.
  it.each([['--reconcile'], ['--fix'], ['-x']])('refuses the option %s', (option) => {
    expect(() => parseOpenStopArguments([option])).toThrow(CliUsageError);
  });

  it('refuses two databases at once', () => {
    expect(() => parseOpenStopArguments(['melarc_dev', 'melarc_other'])).toThrow(CliUsageError);
  });
});

describe('looking for a cancelled request that still holds a stop to be worked', () => {
  // Break caught: a check that writes, or one that asks for nothing when the tables are not there.
  it('says there is nothing to check before the pickup tables exist, and reads nothing else', async () => {
    const { client, calls } = scripted({ tables: false, at: AT });
    const report = await checkOpenStops(client);
    expect(report).toEqual({ checkedAt: AT, tables: false, open: [] });
    expect(calls).toHaveLength(1);
    expect(isClear(report)).toBe(true);
  });

  // Break caught: a statement that is not a plain read, or that asks about the wrong rows: a stop already released, a stop already resolved,
  // or a request that is not cancelled.
  it('reads only: one statement for cancelled requests, stops that hold them and are still to be worked', async () => {
    const { client, calls } = scripted({ tables: true, at: AT });
    await checkOpenStops(client);
    expect(calls).toHaveLength(2);
    for (const text of calls)
      expect(text).not.toMatch(/\b(insert|update|delete|truncate|alter|drop|lock)\b/i);
    const read = calls[1] ?? '';
    expect(read).toMatch(/r\.state = 'CANCELLED'/);
    expect(read).toMatch(/s\.released_at is null/);
    expect(read).toMatch(/s\.state in \('PENDING', 'ARRIVED'\)/);
  });

  it('reports each request with its stop and its run, in the order the statement gives', async () => {
    const { client } = scripted({ tables: true, at: AT }, [
      {
        request_id: 'r1',
        request_code: 'ACC-PR-AAAAAA',
        stop_id: 's1',
        stop_state: 'PENDING',
        manifest_id: 'm1',
        manifest_code: 'ACC-MF-BBBBBB',
      },
      {
        request_id: 'r2',
        request_code: 'ACC-PR-CCCCCC',
        stop_id: 's2',
        stop_state: 'ARRIVED',
        manifest_id: 'm2',
        manifest_code: 'ACC-MF-DDDDDD',
      },
    ]);
    const report = await checkOpenStops(client);
    expect(report.open).toEqual([
      {
        requestId: 'r1',
        requestCode: 'ACC-PR-AAAAAA',
        stopId: 's1',
        stopState: 'PENDING',
        manifestId: 'm1',
        manifestCode: 'ACC-MF-BBBBBB',
      },
      {
        requestId: 'r2',
        requestCode: 'ACC-PR-CCCCCC',
        stopId: 's2',
        stopState: 'ARRIVED',
        manifestId: 'm2',
        manifestCode: 'ACC-MF-DDDDDD',
      },
    ]);
    expect(isClear(report)).toBe(false);
  });
});

describe('what the command prints', () => {
  const clear: OpenStopReport = { checkedAt: AT, tables: true, open: [] };
  const found: OpenStopReport = {
    checkedAt: AT,
    tables: true,
    open: [
      {
        requestId: 'r1',
        requestCode: 'ACC-PR-AAAAAA',
        stopId: 's1',
        stopState: 'ARRIVED',
        manifestId: 'm1',
        manifestCode: 'ACC-MF-BBBBBB',
      },
    ],
  };

  // Break caught: a clean database reported in words that could be read as a finding, or a finding reported as clean: the owner reads the
  // last line and the exit code.
  it('ends a clear database with a result line that says it can be migrated', () => {
    const text = formatOpenStopReport('melarc_dev', clear);
    expect(text).toContain('melarc_dev');
    expect(text).toContain(AT);
    expect(text).toContain('cancelled requests that still hold a stop to be worked: 0');
    expect(text.trimEnd().split('\n').at(-1)).toBe('result: clear');
  });

  it('names each request, its stop and its run, and tells the owner to stop the migration', () => {
    const text = formatOpenStopReport('melarc_dev', found);
    expect(text).toContain('cancelled requests that still hold a stop to be worked: 1');
    expect(text).toContain('ACC-PR-AAAAAA');
    expect(text).toContain('ARRIVED');
    expect(text).toContain('ACC-MF-BBBBBB');
    expect(text).toContain('s1');
    const last = text.trimEnd().split('\n').at(-1) ?? '';
    expect(last).toMatch(/^result: NOT clear\./);
    expect(last).toMatch(/do not apply migration 0065/i);
    expect(last).toMatch(/nothing was changed/i);
  });

  it('says plainly that the tables are not there yet', () => {
    const text = formatOpenStopReport('melarc_dev', { checkedAt: AT, tables: false, open: [] });
    expect(text).toContain('no manifest tables yet');
    expect(text.trimEnd().split('\n').at(-1)).toBe('result: clear');
  });
});
