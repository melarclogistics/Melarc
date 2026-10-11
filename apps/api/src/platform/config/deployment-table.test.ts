import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

import { describe, expect, it } from 'vitest';

import { randomKey, validEnv } from '../../test-support/config-env.js';
import { POLICY_MAX_ATTEMPTS } from '../database/policy-lock/coordinate.js';
import { ADVISORY_CLASSES } from '../database/policy-lock/lock-keys.js';
import {
  CAPTURE_CALL_TIMEOUT_MS,
  CLAIM_BUDGET_MS,
  LEASE_BASE_MS,
  LEASE_MARGIN_MS,
  MAX_BACKOFF_MS,
  RETENTION_RUN_BUDGET_MS,
  RECORD_BUDGET_MS,
  RELINQUISH_RESERVE_MS,
  RETENTION_BATCH_SIZE,
  RETENTION_INTERVAL_MS,
} from '../delivery/delivery-parameters.js';
import { MAX_RETENTION_ROUNDS } from '../delivery/retention/retention-task.js';
import {
  WORKER_DEFAULTS,
  WORKER_ONLY_KEYS,
  WORKER_SHARED_KEYS,
  loadWorkerConfig,
} from '../delivery/worker/worker-config.js';
import { DISPOSAL_BOUND_MS } from '../execution/execution-parameters.js';
import {
  CLEANUP_BATCH,
  MAX_BUCKET_LIMIT,
  MAX_KEY_BYTES,
  MAX_TOTAL_ROWS,
  WINDOW_SECONDS,
} from '../limiter/limiter-parameters.js';
import { DEFAULT_RESERVED_THREADS } from '../limiter/bounded.hash-admission.adapter.js';
import { ENGINEERING_DEFAULTS, HASH_ADMISSION_DEFAULTS } from './config-settings.js';
import { CONFIG_KEYS, loadConfig } from './load-config.js';

const ROOT = resolve(import.meta.dirname, '../../../../..');
const document = readFileSync(
  resolve(ROOT, 'architecture/DEPLOYMENT_AND_ENVIRONMENTS.md'),
  'utf8',
).replaceAll('\r', '');
const example = parseEnv(readFileSync(resolve(ROOT, 'apps/api/.env.example'), 'utf8'));

interface Row {
  readonly required: string;
  readonly default: string;
}

/** The rows of the API's configuration table in DEPLOYMENT_AND_ENVIRONMENTS.md §12.5, by variable. */
function tableRows(): { rows: Map<string, Row>; names: string[] } {
  const lines = document.split('\n');
  const start = lines.findIndex((line) =>
    line.startsWith('| Variable| Required| Default| Bounds|'),
  );
  expect(start, 'the configuration table is there').toBeGreaterThan(0);
  const rows = new Map<string, Row>();
  const names: string[] = [];
  for (const line of lines.slice(start + 2)) {
    const cells = line.split('|').map((cell) => cell.trim());
    const name = /^`([A-Z][A-Z0-9_]*)`$/.exec(cells[1] ?? '')?.[1];
    if (!line.startsWith('|') || name === undefined) break;
    names.push(name);
    rows.set(name, { required: cells[2] ?? '', default: (cells[3] ?? '').replaceAll('`', '') });
  }
  return { rows, names };
}

describe('the configuration table of DEPLOYMENT_AND_ENVIRONMENTS.md §12.5', () => {
  const { rows, names } = tableRows();

  // Break caught: a setting added to the code and never listed for the people who deploy it, or one left in the table after
  // the code stopped reading it.
  it('lists every setting the configuration reads, once, and no other', () => {
    expect(names.toSorted()).toEqual([...CONFIG_KEYS].toSorted());
    expect(new Set(names).size).toBe(names.length);
  });

  // Break caught: the table saying a setting may be left out when the API refuses to start without it, or the reverse.
  it.each([...CONFIG_KEYS])(
    'says %s is required exactly when the API refuses to start without it',
    (key) => {
      const result = loadConfig(validEnv({ [key]: undefined }));
      const refused =
        !result.ok &&
        result.problems.some((problem) => problem.key === key && problem.problem === 'missing');

      expect(rows.get(key)?.required, key).toBe(refused ? 'yes' : 'no');
    },
  );

  // Break caught: a default in the table that is not the one the code applies, or a development-qualified value that drifted
  // from the constant it is defined by.
  it.each([...CONFIG_KEYS])('gives %s the default the example and the code give it', (key) => {
    const documented = rows.get(key)?.default;
    const engineering = (ENGINEERING_DEFAULTS as Readonly<Record<string, string>>)[key];

    if (engineering !== undefined) {
      expect(documented, key).toBe(engineering);
      expect(example[key], key).toBe(engineering);
    } else if (documented === 'none') {
      // No default: the API refuses to start without it, or it is an optional setting the example leaves commented out.
      expect(rows.get(key)?.required === 'yes' || !(key in example), key).toBe(true);
    } else {
      expect(example[key], key).toBe(documented);
    }
  });

  // Break caught: the numbers called qualified, or measured, when only the loader has looked at them; or the first consumer's
  // obligation to qualify them dropped from the document that owns the values.
  it('calls the HTTP and provider defaults provisional and configuration-validated, and keeps the first-consumer obligation', () => {
    const paragraph = document.slice(
      document.indexOf('**Provisional defaults, validated by configuration only.**'),
    );
    expect(paragraph.length, 'the paragraph is there').toBeLessThan(document.length);
    const text = paragraph.slice(0, paragraph.indexOf('\n\n'));

    expect(text).toMatch(/provisional default/);
    expect(text).toMatch(/No HTTP value has been measured/);
    expect(text).toMatch(/none is labelled development-qualified/);
    // The obligation is kept, with the tasks that own it. S0.6 has met it for the database deadlines (the next test).
    expect(text).toMatch(/development-qualified, not production-qualified/);
    expect(text).toMatch(/S0\.20 \(transport admission\)/);
    expect(text).toMatch(/S0\.18 \(delivery worker process\)/);
    expect(text).toMatch(/S0\.6 \(resource deadlines\) has done so/);
    expect(text).toMatch(/S0\.65 \(benchmark and capacity\)/);
    expect(document).not.toMatch(/\*\*Development-qualified engineering values\*\*/);
  });

  // Break caught (S0.7): the restart bound or a lock class changed in the code and not in the record, or the record naming a test
  // that does not exist.
  describe('what S0.7 applied and where it was exercised', () => {
    const heading =
      '**What S0.7 applied and where it was exercised (development-qualified, not production-qualified).**';
    const start = document.indexOf(heading);
    const section = document.slice(start, document.indexOf('**The credential-hashing profile.**'));

    it('is there, and says the figures are not production-qualified', () => {
      expect(start, 'the section is there').toBeGreaterThan(0);
      expect(section).toMatch(/none is production-qualified/);
      expect(section).toMatch(/S0\.65 \(benchmark and capacity\)/);
    });

    it('quotes the restart bound the code uses, and the two lock classes', () => {
      expect(section).toMatch(new RegExp(`\\| \`${String(POLICY_MAX_ATTEMPTS)}\` attempts\\|`));
      expect(section).toContain(
        `\`AUTH_POLICY_BUNDLE\` ${String(ADVISORY_CLASSES.AUTH_POLICY_BUNDLE)}`,
      );
      expect(section).toContain(
        `\`AUTH_POLICY_FIXED\` ${String(ADVISORY_CLASSES.AUTH_POLICY_FIXED)}`,
      );
    });

    it('names only test files that exist, and says the deadline is shared by every attempt', () => {
      const names = [...section.matchAll(/`([a-z-]+(?:\.db)?\.test\.ts)`/g)].map(
        (match) => match[1] ?? '',
      );
      expect(names.length).toBeGreaterThan(1);
      const found = (name: string): boolean =>
        [resolve(ROOT, 'apps/api/src'), resolve(ROOT, 'apps/api/test')].some((directory) =>
          readdirSync(directory, { withFileTypes: true, recursive: true }).some(
            (entry) => entry.isFile() && entry.name === name,
          ),
        );
      for (const name of new Set(names)) expect(found(name), name).toBe(true);
      expect(section).toMatch(/a restart never grants a fresh deadline/);
    });
  });

  // Break caught (S0.6): a figure called development-qualified that is not the one the code applies, a test named as the
  // exercise that does not exist, or the environment of the measurement dropped.
  describe('what S0.6 applied and where it was exercised', () => {
    const heading =
      '**What S0.6 applied and where it was exercised (development-qualified, not production-qualified).**';
    const start = document.indexOf(heading);
    const section = document.slice(start, document.indexOf('**What S0.6 does not do.**'));
    const tableLines = section
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith('| Value'));
    const cells = tableLines.map((line) => line.split('|').map((cell) => cell.trim()));

    it('is there, and says the figures are not production-qualified', () => {
      expect(start, 'the section is there').toBeGreaterThan(0);
      expect(section).toMatch(/\*\*not production-qualified\*\*/);
      expect(section).toMatch(/S0\.65 \(benchmark and capacity\)/);
    });

    // Break caught: a default changed in the code and not in the record of what was exercised.
    it('quotes, for every setting S0.6 applied, the default the code gives it', () => {
      const keys = [
        'DATABASE_ACQUIRE_TIMEOUT_MS',
        'DATABASE_POOL_MAX_WAITERS',
        'DATABASE_LOCK_TIMEOUT_MS',
        'DATABASE_STATEMENT_TIMEOUT_MS',
        'DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS',
        'DATABASE_TRANSACTION_TIMEOUT_MS',
        'REQUEST_EXECUTION_BUDGET_MS',
      ] as const;
      for (const key of keys) {
        const row = cells.find((each) => each[1] === `\`${key}\``);
        expect(row, key).toBeDefined();
        expect(row?.[2], key).toBe(`\`${ENGINEERING_DEFAULTS[key]}\``);
      }
    });

    it('quotes the disposal bound the code uses', () => {
      const row = cells.find((each) => (each[1] ?? '').includes('DISPOSAL_BOUND_MS'));
      expect(row?.[2]).toBe(`\`${String(DISPOSAL_BOUND_MS)}\` ms`);
    });

    // Break caught: a test cited as the exercise of a figure that does not exist (or was renamed).
    it('names only test files that exist', () => {
      const names = [...section.matchAll(/`([a-z-]+(?:\.db)?\.test\.ts)`/g)].map(
        (match) => match[1] ?? '',
      );
      expect(names.length).toBeGreaterThan(3);
      const found = (name: string): boolean => {
        const where = (directory: string): boolean =>
          readdirSync(directory, { withFileTypes: true, recursive: true }).some(
            (entry) => entry.isFile() && entry.name === name,
          );
        return where(resolve(ROOT, 'apps/api/src')) || where(resolve(ROOT, 'apps/api/test'));
      };
      for (const name of new Set(names)) expect(found(name), name).toBe(true);
    });

    it('records the environment the figures were exercised in', () => {
      expect(section).toMatch(/\*\*Environment \(10 October 2026\)\.\*\*/);
      expect(section).toMatch(/Windows 11/);
      expect(section).toMatch(/Node 24\.21\.0/);
      expect(section).toMatch(/PostgreSQL 18\.6/);
      expect(section).toMatch(/as the runtime login/);
    });
  });

  // Break caught: a deadline described as bounding more than it does, so a reader trusts a slow-sender limit to stop a handler.
  describe('the deadlines map', () => {
    const lines = document.split('\n');
    const start = lines.findIndex((line) => line.startsWith('| Retained requirement| Setting|'));
    const rows = lines
      .slice(start + 2)
      .filter((line, index, rest) => rest.slice(0, index + 1).every((seen) => seen.startsWith('|')))
      .map((line) => line.split('|').map((cell) => cell.trim()));
    const named = rows.flatMap((cells) =>
      [...(cells[2] ?? '').matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((match) => match[1] ?? ''),
    );

    it('is there, and names only settings the configuration reads', () => {
      expect(start, 'the map is there').toBeGreaterThan(0);
      expect(rows.length).toBeGreaterThan(5);
      for (const name of named) expect(CONFIG_KEYS, name).toContain(name);
    });

    // Break caught: a deadline, limit or timeout added to the configuration without saying what it bounds and who enforces it.
    it('lists every deadline, timeout and limit the configuration reads, once', () => {
      const bounds = CONFIG_KEYS.filter((key) =>
        /(_TIMEOUT_MS|_DELAY_MS|_CONCURRENCY|_BUDGET_MS|BODY_LIMIT_BYTES|POOL_MAX_WAITERS)$/.test(
          key,
        ),
      );

      expect(named.toSorted()).toEqual(bounds.toSorted());
    });

    it('says the receipt limits bound receipt, not a handler, and that no request has a budget until S0.20', () => {
      const header = rows.find((cells) => (cells[2] ?? '').includes('`HTTP_HEADER_TIMEOUT_MS`'));
      const body = rows.find((cells) => (cells[2] ?? '').includes('`HTTP_BODY_TIMEOUT_MS`'));
      const whole = rows.find((cells) =>
        (cells[2] ?? '').includes('`REQUEST_EXECUTION_BUDGET_MS`'),
      );

      expect(header?.[4]).toMatch(/a handler's execution/);
      expect(body?.[4]).toMatch(/a handler's execution/);
      expect(header?.[3]).toMatch(/waits for a client to send/);
      expect(whole?.[3]).toMatch(
        /the request's whole execution once it has been received and admitted/,
      );
      expect(whole?.[4]).toMatch(/the receipt limits/);
      expect(whole?.[6]).toMatch(/no request has a budget until S0\.20/);
      expect(document).toMatch(
        /\*\*A receipt limit ends a slow sender; it does not stop a handler\.\*\*/,
      );
      expect(document).toMatch(/\*\*until S0\.20 no request has a budget\*\*/);
    });

    // Break caught: two tasks claiming the same receipt limit, or the whole-request bound left without an owner (decision of
    // 9 October 2026, plan §11.8).
    it('gives the receipt limits to S0.20 alone and the execution budget to S0.6, integrated by S0.20', () => {
      const header = rows.find((cells) => (cells[2] ?? '').includes('`HTTP_HEADER_TIMEOUT_MS`'));
      const body = rows.find((cells) => (cells[2] ?? '').includes('`HTTP_BODY_TIMEOUT_MS`'));
      const whole = rows.find((cells) =>
        (cells[2] ?? '').includes('`REQUEST_EXECUTION_BUDGET_MS`'),
      );

      expect(header?.[5]).toBe('S0.20 (transport admission)');
      expect(body?.[5]).toBe('S0.20 (transport admission)');
      expect(whole?.[5]).toMatch(
        /S0\.6 \(resource deadlines\) builds the shared execution-budget mechanism/,
      );
      expect(whole?.[5]).toMatch(
        /S0\.20 \(transport admission\) integrates it into the request pipeline/,
      );
      expect(document).toMatch(/\*\*The database timeouts alone do not bound a whole request\*\*/);
      expect(document).toMatch(/more than racing a response against a timer/);
      expect(document).toMatch(/roll back the open transaction/);
      expect(document).toMatch(/late side effect/);
      expect(document).toMatch(/obligation OB-37/);
    });

    // Break caught: a limit described as applied that nothing reads, or an applied one still described as validation only.
    it('says which are applied: the shutdown budget (B0.2) and the database deadlines and pool bound (S0.6), and no other', () => {
      const applied = (setting: string): boolean =>
        setting.includes('SHUTDOWN_TIMEOUT_MS') || setting.includes('DATABASE_');
      for (const cells of rows) {
        const cell = cells[6] ?? '';
        expect(cell.startsWith(applied(cells[2] ?? '') ? 'yes' : 'no'), cells[2]).toBe(true);
      }
      expect(document).toMatch(/\*\*validation is not enforcement\*\*/);
      expect(document).toMatch(
        /\*\*S0\.6 \(resource deadlines\) has since applied the database deadlines/,
      );
    });
  });

  // Break caught (the S0.2 review): a task number that is not the task it names, which sends a reader to the wrong work. The
  // plan renumbers; the document's references are checked against its headings.
  it('names tasks of the plan by the number and the title the plan gives them', () => {
    const plan = readFileSync(
      resolve(ROOT, 'delivery/planning/SLICE-000-IMPLEMENTATION-PLAN.md'),
      'utf8',
    ).replaceAll('\r', '');
    const titles = new Map(
      [...plan.matchAll(/^#### S0\.(\d+) — (.+)$/gm)].map((match) => [
        match[1] ?? '',
        (match[2] ?? '').replaceAll('`', '').toLowerCase(),
      ]),
    );
    const section = document.slice(
      document.indexOf('**What the settings added by the identity slice (S0.2)'),
      document.indexOf('**Shutdown has one budget.**'),
    );
    const references = [...section.matchAll(/S0\.(\d+) \(([^)]+)\)/g)];

    expect(references.length).toBeGreaterThan(10);
    for (const [, number = '', words = ''] of references) {
      const title = titles.get(number);
      expect(title, `S0.${number} is a task of the plan`).toBeDefined();
      expect(title, `S0.${number} is "${words}"`).toContain(
        words.replaceAll('`', '').toLowerCase(),
      );
    }
    // The two the review found wrong.
    expect(titles.get('20')).toBe('transport admission');
    expect(titles.get('65')).toBe('benchmark and capacity');
    expect(section).not.toMatch(/S0\.19/);
    expect(section).not.toMatch(/S0\.61/);
  });

  // Break caught: the decision recorded in the document and not in the plan that sequences the work, or the other way round.
  it('records the deadline ownership and the execution budget in the plan, with the dependency it implies', () => {
    const plan = readFileSync(
      resolve(ROOT, 'delivery/planning/SLICE-000-IMPLEMENTATION-PLAN.md'),
      'utf8',
    ).replaceAll('\r', '');
    const block = (id: string): string => {
      const start = plan.indexOf(`#### ${id} — `);
      return plan.slice(start, plan.indexOf('\n#### ', start + 1));
    };
    const needs = (id: string): string =>
      /\| \*\*Needs\*\*\| ([^|]*)\|/.exec(block(id))?.[1]?.trim() ?? '';
    const decision = plan.slice(
      plan.indexOf('### 11.8 Deadline ownership and the execution budget'),
    );

    // S0.20 integrates S0.6's mechanism, so it needs it (the index row and the block agree).
    expect(needs('S0.20').split(', ')).toContain('S0.6');
    expect(plan).toMatch(/\| S0\.2, S0\.6, S0\.14, S0\.16\| B D\|/);
    expect(block('S0.6')).toMatch(/\*\*shared execution-budget mechanism\*\*/);
    expect(block('S0.6')).toMatch(/racing a response against a timer is not enforcement/);
    expect(block('S0.6')).toMatch(/mid-work/);
    expect(block('S0.6')).toMatch(
      /Does not\.\*\* Choose production values; set an HTTP receipt or admission limit/,
    );
    expect(block('S0.20')).toMatch(
      /integrates S0\.6's execution-budget mechanism into the request pipeline/,
    );
    expect(block('S0.65')).toMatch(/provisional, configuration-validated defaults/);
    // The decision section, the obligation and the two owner-resolution rows.
    expect(decision).toMatch(
      /S0\.20 owns the HTTP header and body receipt limits and HTTP admission/,
    );
    expect(decision).toMatch(
      /S0\.6 owns the database and resource deadlines and the shared execution-budget mechanism/,
    );
    expect(decision).toMatch(/Database timeouts alone do not bound a whole request/);
    expect(decision).toMatch(
      /Enforcing an execution budget is not racing a response against a timer/,
    );
    expect(decision).toMatch(/calibrated in S0\.65/);
    expect(plan).toMatch(
      /^\| OB-37\| Execution budget\|[^\n]*\| D\| Mechanism and database half done \(S0\.6\); pipeline half not built\|$/m,
    );
    expect(plan).toMatch(
      /^\| 15\| Deadline ownership and the execution budget[^\n]*\*\*Decided\*\*/m,
    );
    expect(plan).toMatch(/^\| 16\| S0\.2's provisional-default wording[^\n]*\*\*Accepted\*\*/m);
  });

  // Break caught: production accepting no custody, but the way out left undone and unowned.
  it('records managed key custody as a prerequisite of G3 in the document and the plan', () => {
    const plan = readFileSync(
      resolve(ROOT, 'delivery/planning/SLICE-000-IMPLEMENTATION-PLAN.md'),
      'utf8',
    ).replaceAll('\r', '');
    const g3 = plan.split('\n').find((line) => line.startsWith('| **G3**|')) ?? '';
    const register = plan.split('\n').find((line) => line.startsWith('| OB-36|')) ?? '';

    expect(document).toMatch(/prerequisite of release gate G3\*\* \(obligation OB-36/);
    expect(document).toMatch(/S0\.2 does not implement it and does not weaken the refusal/);
    expect(g3).toMatch(/Prerequisite \(OB-36\): managed key custody/);
    expect(g3).toMatch(/rotation proof and a recovery proof/);
    expect(register).toMatch(/rotation proof/);
    expect(register).toMatch(/recovery proof/);
    expect(register).toMatch(/refuses a production start/);
  });

  // Break caught: staging's permissions read as evidence of a real provider, a real secret or a release.
  it('says staging’s local custody, capture adapter and substitute are for fixture acceptance only', () => {
    expect(document).toMatch(/\*\*controlled fixture acceptance and nothing more\*\*/);
    expect(document).toMatch(/not real-provider evidence/);
    expect(document).toMatch(/not real-secret evidence/);
    expect(document).toMatch(/not release evidence/);
    expect(document).toMatch(/extends no waiver and defers nothing/);
  });

  // Break caught: the document's refusal table drifting from what the configuration refuses, in either direction.
  it('states what each environment refuses, as the configuration does', () => {
    const section = document.slice(document.indexOf('**What each environment refuses at start.**'));
    const fixture = 'allowed, for controlled fixture acceptance';
    expect(section).toMatch(
      new RegExp(`\`KEY_CUSTODY=local\`[^\\n]*\\| allowed\\| ${fixture}\\| \\*\\*refused\\*\\*`),
    );
    expect(section).toMatch(
      new RegExp(
        `\`DELIVERY_\\*_ADAPTER=capture\`[^\\n]*\\| allowed\\| ${fixture}\\| \\*\\*refused\\*\\*`,
      ),
    );
    expect(section).toMatch(
      new RegExp(
        `\`ATTESTATION_VERIFIER=substitute\`[^\\n]*\\| allowed\\| ${fixture}\\| \\*\\*refused\\*\\*`,
      ),
    );
    expect(section).toMatch(
      /`RATE_LIMITER=memory`[^\n]*\| allowed\| \*\*refused\*\*\| \*\*refused\*\*/,
    );
    expect(section).toMatch(
      /the describe composition[^\n]*\| allowed\| \*\*refused\*\*\| \*\*refused\*\*/,
    );
  });
});

// Break caught (S0.14, S0.16): a figure changed in the code and not in the record of what was exercised, or the record naming a test
// that does not exist, or claiming a figure is more than development-qualified.
describe('what S0.14 and S0.16 applied and where they were exercised', () => {
  const s014Heading =
    '**What S0.14 applied and where it was exercised (development-qualified, not production-qualified).**';
  const s016Heading =
    '**What S0.16 applied and where it was exercised (development-qualified, not production-qualified).**';
  const end = document.indexOf('**What each environment refuses at start.**');
  const s014 = document.slice(document.indexOf(s014Heading), document.indexOf(s016Heading));
  const s016 = document.slice(document.indexOf(s016Heading), end);

  const rowsOf = (text: string): string[][] =>
    text
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('| ') && !line.startsWith('| Value') && !line.startsWith('| Hashes'),
      )
      .map((line) => line.split('|').map((cell) => cell.trim()));
  const figure = (text: string, name: string): string | undefined =>
    rowsOf(text).find((cells) => (cells[1] ?? '').includes(`\`${name}\``))?.[2];

  it('are there, and say the figures are not production-qualified and S0.65 calibrates them', () => {
    expect(document.indexOf(s014Heading), 'S0.14').toBeGreaterThan(0);
    expect(document.indexOf(s016Heading), 'S0.16').toBeGreaterThan(document.indexOf(s014Heading));
    for (const section of [s014, s016]) {
      expect(section).toMatch(/\*\*development-qualified and not production-qualified\*\*/);
      expect(section).toMatch(/S0\.65 \(benchmark and capacity\)/);
      expect(section).toMatch(/\*\*Environment \(10 October 2026\)\.\*\*/);
      expect(section).toMatch(/Node 24\.21\.0/);
    }
    expect(s014).toMatch(/PostgreSQL 18\.6/);
    expect(s016).toMatch(/OpenSSL 3\.5\.8/);
  });

  it('quote, for every constant the limiter has, the figure the code gives it', () => {
    expect(figure(s014, 'WINDOW_SECONDS')).toBe(`\`${String(WINDOW_SECONDS)}\` s`);
    expect(figure(s014, 'MAX_KEY_BYTES')).toBe(`\`${String(MAX_KEY_BYTES)}\` bytes`);
    expect(figure(s014, 'MAX_BUCKET_LIMIT')).toBe(`\`${String(MAX_BUCKET_LIMIT)}\``);
    expect(figure(s014, 'MAX_TOTAL_ROWS')).toBe(
      `\`${String(MAX_TOTAL_ROWS)}\` rows, live or expired`,
    );
    expect(figure(s014, 'CLEANUP_BATCH')).toBe(`\`${String(CLEANUP_BATCH)}\` rows`);
  });

  it('quote the figures of hash admission: the two defaults and the reserved thread', () => {
    expect(figure(s016, 'HASH_ADMISSION_SLOTS')).toBe(
      `\`${HASH_ADMISSION_DEFAULTS.HASH_ADMISSION_SLOTS}\``,
    );
    expect(figure(s016, 'HASH_ADMISSION_MEMORY_BUDGET_MIB')).toBe(
      `\`${HASH_ADMISSION_DEFAULTS.HASH_ADMISSION_MEMORY_BUDGET_MIB}\``,
    );
    expect(figure(s016, 'DEFAULT_RESERVED_THREADS')).toBe(
      `\`${String(DEFAULT_RESERVED_THREADS)}\` thread`,
    );
  });

  // Break caught: the memory column of the measurement not being the slots times the memory of a hash, which the budget assumes.
  it('record a memory increase of 64 MiB for each hash until the pool of four is taken', () => {
    const measured = s016
      .split('\n')
      .filter((line) => /^\| \d/.test(line))
      .map((line) => line.split('|').map((cell) => cell.trim()));

    expect(measured.length).toBeGreaterThanOrEqual(6);
    for (const cells of measured.filter((row) => Number.parseInt(row[1] ?? '', 10) <= 4)) {
      expect(cells[5], cells[1]).toBe(`${String(64 * Number.parseInt(cells[1] ?? '0', 10))} MiB`);
    }
  });

  it('name only test files that exist', () => {
    const names = [...(s014 + s016).matchAll(/`([a-z0-9.-]+\.test\.ts)`/g)].map(
      (match) => match[1] ?? '',
    );
    expect(names.length).toBeGreaterThan(5);
    const found = (name: string): boolean => {
      const where = (directory: string): boolean =>
        readdirSync(directory, { withFileTypes: true, recursive: true }).some(
          (entry) => entry.isFile() && entry.name === name,
        );
      return where(resolve(ROOT, 'apps/api/src')) || where(resolve(ROOT, 'apps/api/test'));
    };
    for (const name of new Set(names)) expect(found(name), name).toBe(true);
  });
});

// Break caught (S0.18): a worker setting added to the code and never listed for the people who deploy it, a figure changed in the code
// and not in the record of what was exercised, or the record naming a test that does not exist or claiming more than was run.
describe('the delivery worker in the deployment document (S0.18)', () => {
  const configHeading = "**The delivery worker's configuration (S0.18).**";
  const appliedHeading =
    '**What S0.18 applied and where it was exercised (development-qualified, not production-qualified).**';
  const limitsHeading = '**What S0.18 does not do.**';
  const section = document.slice(
    document.indexOf(configHeading),
    document.indexOf('**Metrics** (decided 8 October 2026'),
  );
  const applied = section.slice(section.indexOf(appliedHeading), section.indexOf(limitsHeading));

  const rowsAfter = (header: string, text: string): string[][] => {
    const lines = text.split('\n');
    const start = lines.findIndex((line) => line.startsWith(header));
    const rows: string[][] = [];
    for (const line of lines.slice(start + 2)) {
      if (!line.startsWith('|')) break;
      rows.push(line.split('|').map((cell) => cell.trim()));
    }
    return rows;
  };
  const workerRows = rowsAfter('| Worker variable|', section);
  const figureRows = rowsAfter('| Value|', applied);
  const workerRow = (key: string): string[] | undefined =>
    workerRows.find((cells) => cells[1] === `\`${key}\``);
  const figure = (name: string): string | undefined =>
    figureRows.find((cells) => (cells[1] ?? '').includes(`\`${name}\``))?.[2];

  it('is there, with its configuration, its figures and its limits', () => {
    expect(section.length, 'the section is there').toBeGreaterThan(0);
    expect(applied.length).toBeGreaterThan(0);
    expect(applied).toMatch(/none is production-qualified/);
    expect(applied).toMatch(/S0\.65 \(benchmark and capacity\)/);
  });

  // Break caught: a setting only the worker reads missing from its table, listed twice, or left in it after the code stopped reading it.
  it('lists the worker’s own settings, once each, and no other', () => {
    const names = workerRows.map((cells) => (cells[1] ?? '').replaceAll('`', ''));

    expect(names.toSorted()).toEqual([...WORKER_ONLY_KEYS].toSorted());
    for (const key of WORKER_ONLY_KEYS) expect(CONFIG_KEYS, key).not.toContain(key);
  });

  // Break caught: a setting the worker shares with the API that the API's table does not list (it would be undocumented twice over),
  // or one the worker reads and the section never says.
  it('names the settings it shares with the API, each of which the API’s table lists', () => {
    const { names } = tableRows();
    for (const key of WORKER_SHARED_KEYS) {
      expect(names, key).toContain(key);
      const said =
        section.includes(`\`${key}\``) ||
        (key.startsWith('DELIVERY_EMAIL_') && section.includes('`DELIVERY_EMAIL_*`')) ||
        (key.startsWith('DELIVERY_SMS_') && section.includes('`DELIVERY_SMS_*`'));
      expect(said, key).toBe(true);
    }
  });

  // Break caught: a default in the table that is not the one the code and the example give.
  it('gives the worker’s defaults the values the code and the example give', () => {
    for (const [key, value] of Object.entries(WORKER_DEFAULTS)) {
      expect(workerRow(key)?.[3], key).toBe(`\`${value}\``);
      expect(example[key], key).toBe(value);
    }
    for (const key of ['DATABASE_WORKER_URL', 'DELIVERY_CAPTURE_DIRECTORY']) {
      expect(workerRow(key)?.[3], key).toBe('none');
      expect(key in example, key).toBe(false);
    }
  });

  // Break caught: the table saying a setting may be left out when the worker refuses to start without it, or the reverse.
  it('says when each of the worker’s settings is required, as its loader does', () => {
    const local = (over: Record<string, string | undefined>) => {
      const result = loadWorkerConfig({
        NODE_ENV: 'development',
        APP_ENV: 'local',
        DATABASE_WORKER_URL: 'postgres://melarc_worker_runtime:x@127.0.0.1:5432/melarc_dev',
        KEY_CUSTODY: 'local',
        KEY_CREDENTIAL_DELIVERY_MATERIAL: `1:${randomKey()}`,
        KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION: '1',
        DELIVERY_CAPTURE_DIRECTORY: join(tmpdir(), 'melarc-capture'),
        ...over,
      });
      return result.ok ? [] : result.problems;
    };
    const refusedWithout = (key: string, over: Record<string, string | undefined> = {}) =>
      local({ ...over, [key]: undefined }).some(
        (problem) => problem.key === key && problem.problem === 'missing',
      );

    expect(workerRow('DATABASE_WORKER_URL')?.[2]).toBe('yes');
    expect(refusedWithout('DATABASE_WORKER_URL')).toBe(true);
    for (const key of ['DELIVERY_WORKER_CONCURRENCY', 'DELIVERY_WORKER_POLL_INTERVAL_MS']) {
      expect(workerRow(key)?.[2], key).toBe('no');
      expect(refusedWithout(key), key).toBe(false);
    }
    expect(workerRow('DELIVERY_CAPTURE_DIRECTORY')?.[2]).toBe('with capture');
    expect(refusedWithout('DELIVERY_CAPTURE_DIRECTORY')).toBe(true);
    for (const key of ['DELIVERY_PROVIDER_APPROVAL_REF', 'DELIVERY_PROVIDER_ALLOWLIST']) {
      expect(workerRow(key)?.[2], key).toBe('in Staging with a real provider');
    }
  });

  // Break caught: a constant changed in the code and not in the record of what was exercised.
  it('quotes, for every constant the worker has, the figure the code gives it', () => {
    expect(figure('LEASE_BASE_MS')).toBe(`\`${String(LEASE_BASE_MS)}\` ms`);
    expect(figure('LEASE_MARGIN_MS')).toBe(`\`${String(LEASE_MARGIN_MS)}\` ms`);
    expect(figure('CLAIM_BUDGET_MS')).toBe(
      `\`${String(CLAIM_BUDGET_MS)}\` ms and \`${String(RECORD_BUDGET_MS)}\` ms`,
    );
    expect(figure('CAPTURE_CALL_TIMEOUT_MS')).toBe(`\`${String(CAPTURE_CALL_TIMEOUT_MS)}\` ms`);
    expect(figure('RELINQUISH_RESERVE_MS')).toBe(`\`${String(RELINQUISH_RESERVE_MS)}\` ms`);
    expect(figure('MAX_BACKOFF_MS')).toBe(`\`${String(MAX_BACKOFF_MS)}\` ms`);
    expect(figure('DELIVERY_WORKER_CONCURRENCY')).toBe(
      `\`${WORKER_DEFAULTS.DELIVERY_WORKER_CONCURRENCY}\``,
    );
    expect(figure('DELIVERY_WORKER_POLL_INTERVAL_MS')).toBe(
      `\`${WORKER_DEFAULTS.DELIVERY_WORKER_POLL_INTERVAL_MS}\``,
    );
    // The provider timeouts are said not to be qualified, and the reason is given.
    expect(figure('DELIVERY_EMAIL_TIMEOUT_MS')).toBe('none');
    expect(applied).toMatch(/\*\*not qualified\*\*/);
  });

  // Break caught: a test cited as the exercise of a figure that does not exist (or was renamed).
  it('names only test files that exist', () => {
    const names = [...applied.matchAll(/`([a-z0-9.-]+\.test\.ts)`/g)].map(
      (match) => match[1] ?? '',
    );
    const found = (name: string): boolean =>
      [resolve(ROOT, 'apps/api/src'), resolve(ROOT, 'apps/api/test')].some((directory) =>
        readdirSync(directory, { withFileTypes: true, recursive: true }).some(
          (entry) => entry.isFile() && entry.name === name,
        ),
      );

    expect(names.length).toBeGreaterThan(5);
    for (const name of new Set(names)) expect(found(name), name).toBe(true);
  });

  // Break caught: the environment of the measurement dropped, or the limits of what was run overstated: no real provider, no record
  // reader, and the real-SIGTERM evidence still owed.
  it('records the environment, and says what was not done and what is still owed', () => {
    expect(applied).toMatch(/\*\*Environment \(10 October 2026\)\.\*\*/);
    expect(applied).toMatch(/Windows 11/);
    expect(applied).toMatch(/Node 24\.21\.0/);
    expect(applied).toMatch(/PostgreSQL 18\.6/);
    expect(applied).toMatch(/as `melarc_worker_runtime`/);
    expect(applied).toMatch(/Indicative figures, not a benchmark/);
    const limits = section.slice(section.indexOf(limitsHeading));
    expect(limits).toMatch(/no real provider/);
    expect(limits).toMatch(/S0\.29 and S0\.50/);
    expect(limits).toMatch(/Windows/);
    expect(limits).toMatch(/required before Gate 2 passes/);
    expect(limits).toMatch(/OB-24/);
  });

  // Break caught: the refusals the document states drifting from the loader: Staging and the window, a deployed worker's separate
  // credentials, and the API's own refusal of the worker's login.
  it('states the refusals the loader makes', () => {
    expect(section).toMatch(/Staging refuses a real provider unless/);
    expect(section).toMatch(
      /refuses an environment that carries the API's connection \(`DATABASE_URL`\)/,
    );
    expect(document).toMatch(
      /`DATABASE_WORKER_URL` are \*\*forbidden\*\* in the API's environment/,
    );
    expect(
      loadConfig(validEnv({ DATABASE_WORKER_URL: 'postgres://melarc_worker_runtime:x@h/d' })).ok,
    ).toBe(false);
  });
});

// Break caught (S0.19): a figure changed in the code and not in the record of what was exercised, a test named that does not exist, or
// the cleanup described as doing what no identity may: deleting a row, or settling a question that is the Product Owner's.
describe('the retention cleanup in the deployment document (S0.19)', () => {
  const heading =
    '**What S0.19 applied and where it was exercised (development-qualified, not production-qualified).**';
  const limitsHeading = '**What S0.19 does not do.**';
  const start = document.indexOf(heading);
  const section = document.slice(start, document.indexOf('**Metrics** (decided 8 October 2026'));
  const applied = section.slice(0, section.indexOf(limitsHeading));
  const limits = section.slice(section.indexOf(limitsHeading));
  const rows = applied
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Value'))
    .map((line) => line.split('|').map((cell) => cell.trim()));
  const figure = (name: string): string | undefined =>
    rows.find((cells) => (cells[1] ?? '').includes(`\`${name}\``))?.[2];

  it('is there, and says the figures are not production-qualified and S0.65 calibrates them', () => {
    expect(start, 'the section is there').toBeGreaterThan(0);
    expect(applied).toMatch(/none is production-qualified/);
    expect(applied).toMatch(/S0\.65 \(benchmark and capacity\)/);
    expect(applied).toMatch(/erase_expired_credential_material/);
  });

  it('quotes, for every constant the cleanup has, the figure the code gives it', () => {
    expect(figure('RETENTION_BATCH_SIZE')).toBe(`\`${String(RETENTION_BATCH_SIZE)}\` rows`);
    expect(figure('RETENTION_INTERVAL_MS')).toBe(`\`${String(RETENTION_INTERVAL_MS)}\` ms`);
    expect(figure('MAX_RETENTION_ROUNDS')).toBe(`\`${String(MAX_RETENTION_ROUNDS)}\``);
    expect(figure('RETENTION_RUN_BUDGET_MS')).toBe(`\`${String(RETENTION_RUN_BUDGET_MS)}\` ms`);
  });

  it('names only test files that exist', () => {
    const names = [...applied.matchAll(/`([a-z0-9.-]+\.test\.ts)`/g)].map(
      (match) => match[1] ?? '',
    );
    const found = (name: string): boolean =>
      [resolve(ROOT, 'apps/api/src'), resolve(ROOT, 'apps/api/test')].some((directory) =>
        readdirSync(directory, { withFileTypes: true, recursive: true }).some(
          (entry) => entry.isFile() && entry.name === name,
        ),
      );

    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const name of new Set(names)) expect(found(name), name).toBe(true);
  });

  it('says it deletes nothing, leaves both questions to the Product Owner and does not pass Gate 2', () => {
    expect(limits).toMatch(/It deletes no row of any table/);
    expect(limits).toMatch(/`idempotency_record_ttl_hours`/);
    expect(limits).toMatch(/OQ-028/);
    expect(limits).toMatch(/Gate 2 is not passed by it/);
    expect(applied).toMatch(/\*\*It deletes nothing\*\*/);
  });
});
