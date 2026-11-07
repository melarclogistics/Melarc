import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  QUEUE_CHANGING_ACTS,
  QUEUE_NEUTRAL_CALLS,
} from '../src/platform/queue-summary/queue-changing-acts';

/**
 * The table of acts that can change a queue (`src/platform/queue-summary/queue-changing-acts.ts`) is what keeps the menu's counts and My work from
 * lagging an act (the Product Owner's decision D11(b), 6 November 2026), and a table is only as good as its fit to what the portal does and to the
 * contract. Two things are held here: **every entry names a real operation at its real method and path**, and **every call of the API that the portal
 * makes and that can change something is in the table, as an act or as a call that changes no queue**. An act that a later task adds is then
 * decided on, in the table, before it can be merged: nobody has to remember to make the menu read again.
 */
const APP_SRC = resolve(import.meta.dirname, '../src');
const CONTRACT = resolve(import.meta.dirname, '../../../contracts/openapi.yaml');

interface Contract {
  readonly paths: Record<string, Record<string, { readonly operationId?: string } | undefined>>;
}

const contract = parse(readFileSync(CONTRACT, 'utf8')) as Contract;

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'test-support' ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * The calls of the generated client that can change something, as a source writes them: a method of the API client by any receiver (`client`, `api`,
 * `this.client`) and with the path in any quotation, which the table is keyed by. A call whose path is not a plain string (a constant, a template with
 * a hole) cannot be matched against the table, and is reported as such: it would otherwise slip past the guard unseen (review of 7 November 2026: the scan
 * read only a receiver named `client` and a path in single quotes).
 */
function mutatingCallsIn(text: string): {
  readonly written: readonly string[];
  readonly unreadable: readonly string[];
} {
  const written = [...text.matchAll(/\.(POST|PUT|PATCH|DELETE)\(\s*(['"`])([^'"`$\n]+)\2/g)].map(
    (match) => `${match[1] ?? ''} ${match[3] ?? ''}`,
  );
  const unreadable = [
    ...text.matchAll(/\.(POST|PUT|PATCH|DELETE)\(\s*(?!(['"`])[^'"`$\n]+\2)([^\n]{0,40})/g),
  ].map((match) => `${match[1] ?? ''}(${match[3] ?? ''}`);
  return { written, unreadable };
}

describe('the table of acts that can change a queue', () => {
  // Break caught: an entry that names an operation the contract does not have at that method and path (a renamed path, a wrong verb, a typo in
  // the operation): it would match nothing the client sends, and the act it stands for would go unread.
  it.each(
    [...QUEUE_CHANGING_ACTS, ...QUEUE_NEUTRAL_CALLS].map((each) => [each.operation, each] as const),
  )('has %s at the method and path the contract gives it', (_operation, each) => {
    const operation = contract.paths[each.path]?.[each.method.toLowerCase()];

    expect(operation?.operationId, `${each.method} ${each.path}`).toBe(each.operation);
  });

  // Break caught: a call of the API that can change something and is in neither table, which is exactly an act whose author did not think about
  // the queues: the menu would say what it said before the act.
  it('holds every call of the API that the portal makes and that can change something', () => {
    const decided = new Set(
      [...QUEUE_CHANGING_ACTS, ...QUEUE_NEUTRAL_CALLS].map((each) => `${each.method} ${each.path}`),
    );
    const found = sources(APP_SRC).map((file) => ({
      file: relative(APP_SRC, file),
      ...mutatingCallsIn(readFileSync(file, 'utf8')),
    }));
    const calls = found.flatMap(({ file, written }) => written.map((call) => ({ call, file })));

    expect(calls.length).toBeGreaterThan(30);
    const undecided = calls.filter(({ call }) => !decided.has(call));
    expect(undecided, 'a call of the API in neither table of queue-changing-acts.ts').toEqual([]);
    expect(
      found.flatMap(({ file, unreadable }) => unreadable.map((call) => `${file}: ${call}`)),
      'a call of the API whose path the scan cannot read: write the path as a plain string',
    ).toEqual([]);
  });

  // Break caught (review of 7 November 2026): the scan narrower than the way a call can be written: a later `api.POST('/x')`, a path in double quotes
  // or in a template, or a path held in a constant, went past it and into the portal with no decision about the queues.
  it('reads a call by any receiver and any quotation, and reports a call whose path it cannot read', () => {
    expect(
      mutatingCallsIn(
        [
          "await client.POST('/a', {});",
          'await api.PUT("/b/{id}", {});',
          'await this.client.DELETE(`/c`);',
          "await helper.client.PATCH(\n  '/d',\n);",
        ].join('\n'),
      ).written,
    ).toEqual(['POST /a', 'PUT /b/{id}', 'DELETE /c', 'PATCH /d']);

    const unreadable = mutatingCallsIn(
      ['await client.POST(PATH, {});', 'await api.PUT(`/x/${id}`, {});'].join('\n'),
    ).unreadable;
    expect(unreadable).toHaveLength(2);
    expect(mutatingCallsIn("await client.GET('/a');").written).toEqual([]);
  });

  // Break caught: the scan above passing because it found nothing (a changed way of calling the client): the acts the decision names are
  // among what it finds.
  it('finds the acts the decision names, as the source writes them', () => {
    const text = sources(APP_SRC)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');

    for (const act of [
      "client.POST('/pickup-requests/{id}/confirm'",
      "client.POST('/pickup-manifests'",
      "client.POST('/staff-identities/{id}/approve'",
    ]) {
      expect(text).toContain(act);
    }
  });
});
