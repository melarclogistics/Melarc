import { describe, expect, it } from 'vitest';

import { CliUsageError } from './cli.js';
import {
  checkOrderSurplus,
  formatOrderSurplusReport,
  isClear,
  parseOrderSurplusArguments,
} from './order-surplus-check.js';
import type { SqlClient } from './provisioning.js';

/**
 * The inventory of OB-S1-161 (the Product Owner's decision of 22 November 2026): which intake counted blind holds more orders than the parcels it received. The command reads and writes nothing; what it
 * reads and how it says so is what these tests hold, against a scripted connection. The database test of the tool runs it against a real database in which a surplus was made as the application cannot make it.
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

const AT = '2026-11-22 09:00:00 UTC';

describe('the arguments of the surplus inventory', () => {
  it('defaults to the development database and takes one name', () => {
    expect(parseOrderSurplusArguments([])).toEqual({ database: 'melarc_dev' });
    expect(parseOrderSurplusArguments(['melarc_test_ab12'])).toEqual({
      database: 'melarc_test_ab12',
    });
  });

  // Break caught: a flag that would let the command write (this one has none), or a second database.
  it.each([['--fix'], ['--correct'], ['-x']])('refuses the option %s', (option) => {
    expect(() => parseOrderSurplusArguments([option])).toThrow(CliUsageError);
  });

  it('refuses two databases at once', () => {
    expect(() => parseOrderSurplusArguments(['melarc_dev', 'melarc_other'])).toThrow(CliUsageError);
  });
});

describe('looking for orders beyond the parcels received', () => {
  // Break caught: a check that asks for nothing when the tables are not there, or one that writes.
  it('says there is nothing to check before the tables exist, and reads nothing else', async () => {
    const { client, calls } = scripted({ tables: false, at: AT });
    const report = await checkOrderSurplus(client);
    expect(report).toEqual({ checkedAt: AT, tables: false, looked: 0, surpluses: [] });
    expect(calls).toHaveLength(1);
    expect(isClear(report)).toBe(true);
  });

  // Break caught: a statement that is not a plain read, that leaves closed intakes out (the queue of shortages did), that counts an order whose arrival was reversed, or that looks at a photo intake.
  it('reads only, over open and closed blind intakes, and counts the orders that stand', async () => {
    const { client, calls } = scripted({ tables: true, at: AT });
    await checkOrderSurplus(client);
    expect(calls).toHaveLength(2);
    for (const text of calls) {
      expect(text).not.toMatch(/\b(insert|update|delete|truncate|alter|drop|lock)\b/i);
    }
    const read = calls[1] ?? '';
    expect(read).toMatch(/receiving_mode = 'BLIND_COUNT'/);
    expect(read).toMatch(/physical_count is not null/);
    expect(read).toMatch(/commercial_state is distinct from 'REVERSED'/);
    expect(read).not.toMatch(/state\s*=\s*'CLOSED'|state in/i);
  });

  it('reports only the intakes whose orders exceed what was received, with the surplus', async () => {
    const { client } = scripted({ tables: true, at: AT }, [
      {
        intake_id: 'i1',
        intake_code: 'ACC-IN-1',
        state: 'ITEMIZING',
        received: 2,
        standing: 3,
        closed_at: null,
      },
      {
        intake_id: 'i2',
        intake_code: 'ACC-IN-2',
        state: 'CLOSED',
        received: 3,
        standing: 3,
        closed_at: AT,
      },
      {
        intake_id: 'i3',
        intake_code: 'ACC-IN-3',
        state: 'CLOSED',
        received: 2,
        standing: 5,
        closed_at: AT,
      },
      {
        intake_id: 'i4',
        intake_code: 'ACC-IN-4',
        state: 'ITEMIZING',
        received: 4,
        standing: 1,
        closed_at: null,
      },
    ]);
    const report = await checkOrderSurplus(client);
    expect(report.looked).toBe(4);
    expect(report.surpluses.map((each) => [each.intakeCode, each.surplus])).toEqual([
      ['ACC-IN-1', 1],
      ['ACC-IN-3', 3],
    ]);
    expect(isClear(report)).toBe(false);
    const printed = formatOrderSurplusReport('melarc_dev', report);
    expect(printed).toContain('intakes with more orders than parcels received: 2');
    expect(printed).toContain('ACC-IN-3');
    expect(printed).toContain('NOT clear');
    expect(printed).toContain('never a raised count');
  });

  it('says clear, and what it looked at, when nothing is beyond the count', async () => {
    const { client } = scripted({ tables: true, at: AT }, [
      {
        intake_id: 'i2',
        intake_code: 'ACC-IN-2',
        state: 'CLOSED',
        received: 3,
        standing: 3,
        closed_at: AT,
      },
    ]);
    const report = await checkOrderSurplus(client);
    expect(isClear(report)).toBe(true);
    expect(formatOrderSurplusReport('melarc_dev', report)).toContain('result: clear');
  });
});
