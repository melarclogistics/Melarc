import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

import { describe, expect, it } from 'vitest';

import { validEnv } from '../../test-support/config-env.js';
import { ENGINEERING_DEFAULTS } from './config-settings.js';
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
  it('calls the resource defaults provisional and configuration-validated, and keeps the first-consumer obligation', () => {
    const paragraph = document.slice(
      document.indexOf('**Provisional defaults, validated by configuration only.**'),
    );
    expect(paragraph.length, 'the paragraph is there').toBeLessThan(document.length);
    const text = paragraph.slice(0, paragraph.indexOf('\n\n'));

    expect(text).toMatch(/provisional default/);
    expect(text).toMatch(/No value has been measured/);
    expect(text).toMatch(/none is labelled development-qualified/);
    // The obligation is kept, with the tasks that own it.
    expect(text).toMatch(/development-qualified, not production-qualified/);
    expect(text).toMatch(/S0\.6 \(resource deadlines\)/);
    expect(text).toMatch(/S0\.20 \(transport admission\)/);
    expect(text).toMatch(/S0\.65 \(benchmark and capacity\)/);
    expect(document).not.toMatch(/\*\*Development-qualified engineering values\*\*/);
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
        /(_TIMEOUT_MS|_DELAY_MS|_CONCURRENCY|BODY_LIMIT_BYTES|POOL_MAX_WAITERS)$/.test(key),
      );

      expect(named.toSorted()).toEqual(bounds.toSorted());
    });

    it('says the receipt limits bound receipt, not a handler, and that no setting bounds a whole request', () => {
      const header = rows.find((cells) => (cells[2] ?? '').includes('`HTTP_HEADER_TIMEOUT_MS`'));
      const body = rows.find((cells) => (cells[2] ?? '').includes('`HTTP_BODY_TIMEOUT_MS`'));
      const whole = rows.find((cells) => (cells[2] ?? '').startsWith('none'));

      expect(header?.[4]).toMatch(/a handler's execution/);
      expect(body?.[4]).toMatch(/a handler's execution/);
      expect(header?.[3]).toMatch(/waits for a client to send/);
      expect(whole?.[2]).toMatch(/no setting exists/);
      expect(document).toMatch(
        /\*\*A receipt limit ends a slow sender; it does not stop a handler\.\*\*/,
      );
      expect(document).toMatch(/no setting bounds the whole of a handler's execution yet/);
    });

    // Break caught: two tasks claiming the same receipt limit, or the whole-request bound left without an owner (decision of
    // 9 October 2026, plan §11.8).
    it('gives the receipt limits to S0.20 alone and the execution budget to S0.6, integrated by S0.20', () => {
      const header = rows.find((cells) => (cells[2] ?? '').includes('`HTTP_HEADER_TIMEOUT_MS`'));
      const body = rows.find((cells) => (cells[2] ?? '').includes('`HTTP_BODY_TIMEOUT_MS`'));
      const whole = rows.find((cells) => (cells[2] ?? '').startsWith('none'));

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

    it('says that none of them is applied yet, except the shutdown budget', () => {
      for (const cells of rows) {
        const applied = cells[6] ?? '';
        const shutdown = (cells[2] ?? '').includes('SHUTDOWN_TIMEOUT_MS');
        expect(applied.startsWith(shutdown ? 'yes' : 'no'), cells[2]).toBe(true);
      }
      expect(document).toMatch(/\*\*validation is not enforcement\*\*/);
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
    expect(plan).toMatch(/^\| OB-37\| Execution budget\|[^\n]*\| D\| Not built\|$/m);
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
