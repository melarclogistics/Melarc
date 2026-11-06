import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { components } from '@melarc/api-client';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  parseQueueSummary,
  QUEUE_IDS,
  QUEUE_SUMMARY_FIELDS,
} from '../src/platform/queue-summary/queue-summary-shape';
import { QUEUE_WORDS, queueLink } from '../src/app/navigation/queue-places';

/**
 * The guard that judges the answer of `getQueueSummary` (`src/platform/queue-summary/queue-summary-shape.ts`) is a runtime check, not a second
 * description of the wire: the types are the generated ones. This test reads the contract and holds the guard to it, as the other contract
 * tests do for their screens: every field the guard reads is a field of its schema, every field the contract names is one the guard knows,
 * every field the contract requires is one the guard requires, and every queue the guard recognises is one the contract names and the other way
 * round, so that a queue the contract adds has to be decided on, here and in `queue-places.ts`, before a screen can draw it.
 */
const CONTRACT = resolve(import.meta.dirname, '../../../contracts/openapi.yaml');

interface Schema {
  readonly type?: string | readonly string[];
  readonly format?: string;
  readonly enum?: readonly string[];
  readonly required?: readonly string[];
  readonly properties?: Record<string, Schema>;
  readonly items?: Schema;
  readonly additionalProperties?: boolean;
  readonly minimum?: number;
  readonly $ref?: string;
}

interface Operation {
  readonly operationId?: string;
  readonly 'x-permission'?: string;
  readonly security?: readonly Record<string, unknown>[];
}

const document = parse(readFileSync(CONTRACT, 'utf8')) as {
  components: { schemas: Record<string, Schema> };
  paths: Record<string, Record<string, Operation>>;
};

const summary = document.components.schemas.QueueSummary;
const entry = document.components.schemas.QueueSummaryEntry;
const queueId = document.components.schemas.QueueId;
if (summary === undefined || entry === undefined || queueId === undefined) {
  throw new Error('The contract lacks QueueSummary, QueueSummaryEntry or QueueId.');
}

/** Whether two unions of words are the same, member for member. For a union of string literals that is equality; it asks the compiler. */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('the guard of QueueSummary and the contract', () => {
  const fields = QUEUE_SUMMARY_FIELDS;

  // Break caught: a guard reading a field the contract does not have.
  it('reads only fields that the schemas have', () => {
    expect(Object.keys(summary.properties ?? {})).toEqual([...fields.QueueSummary.required]);
    for (const field of [
      ...fields.QueueSummaryEntry.required,
      ...fields.QueueSummaryEntry.optional,
    ]) {
      expect(Object.keys(entry.properties ?? {}), field).toContain(field);
    }
  });

  // Break caught: a field the contract adds that the guard never decides about.
  it('knows every field that the schemas have', () => {
    expect(
      [...fields.QueueSummaryEntry.required, ...fields.QueueSummaryEntry.optional].toSorted(),
    ).toEqual(Object.keys(entry.properties ?? {}).toSorted());
  });

  // Break caught: the contract making a field mandatory that the guard treats as optional, or the guard requiring what may be absent.
  it('requires exactly the fields the contract requires', () => {
    expect([...(entry.required ?? [])].toSorted()).toEqual(
      [...fields.QueueSummaryEntry.required].toSorted(),
    );
    expect([...(summary.required ?? [])].toSorted()).toEqual(
      [...fields.QueueSummary.required].toSorted(),
    );
  });

  // Break caught: an entry that may carry something more than the queue, the count and the moment (the contract is closed on purpose).
  it('is closed against any other property, as the contract is', () => {
    expect(entry.additionalProperties).toBe(false);
    expect(summary.additionalProperties).toBe(false);
  });

  // Break caught: a count that may be a fraction or negative in the contract and not in the guard, or the other way round.
  it('judges the count and the moment as the contract describes them', () => {
    expect(entry.properties?.count).toMatchObject({ type: 'integer', minimum: 0 });
    expect(entry.properties?.oldest_at).toMatchObject({ type: 'string', format: 'date-time' });
  });

  // Break caught: a queue the contract names and the guard does not know (or the other way round), and one with no words or no link.
  it('recognises exactly the queues the contract names, in its order, each with words and a link', () => {
    expect([...QUEUE_IDS]).toEqual([...(queueId.enum ?? [])]);
    expect(Object.keys(QUEUE_WORDS).toSorted()).toEqual([...QUEUE_IDS].toSorted());
    for (const queue of QUEUE_IDS) {
      expect(
        queueLink(queue, () => true),
        queue,
      ).toMatch(/^\//);
      expect(
        queueLink(queue, () => false),
        queue,
      ).toMatch(/^\//);
    }
  });

  // Break caught (at compile time): the list of the guard and the generated client's union drifting apart. `tsc` fails on this file.
  it('has the same union as the generated client, member for member', () => {
    const same: true = true satisfies Equal<
      (typeof QUEUE_IDS)[number],
      components['schemas']['QueueId']
    >;
    expect(same).toBe(true);
  });
});

describe('the operation', () => {
  const operation = document.paths['/ops/queue-summary']?.get;

  // Break caught: the read being given a key of its own, or being open to the Vendor and Rider apps: it is a `self` operation of the browser surface.
  it('is a self read of the browser session, with no key of its own', () => {
    expect(operation?.operationId).toBe('getQueueSummary');
    expect(operation?.['x-permission']).toBe('self');
    expect(operation?.security).toEqual([{ browserSession: [] }]);
  });
});

describe('every queue of the contract is known to the guard', () => {
  it.each((queueId.enum ?? []).map((queue) => [queue] as const))('takes the queue %s', (queue) => {
    expect(parseQueueSummary({ queues: [{ queue, count: 0 }] })).toEqual({
      queues: [{ queue, count: 0, oldestAt: null }],
      incomplete: false,
    });
  });
});
