import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { components } from '@melarc/api-client';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  DESTINATION_HINT,
  MAX_DESTINATION_HINT,
  MESSAGE_KIND,
  NOTIFICATION_AUDIENCES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_FIELDS,
  NOTIFICATION_STATES,
  OUTCOME_CLASSES,
  parseNotificationEntry,
  PROVIDER_OUTCOME_CLASS,
  SUBJECT_FIELDS,
  SUBJECT_TYPES,
  SUPPRESSION_REASONS,
} from '../src/platform/notifications/notification-shape';
import { notificationFixture, suppressedFixture } from '../src/test-support/notification-fixture';

/**
 * The guard that judges the answer of `listNotifications` (`src/platform/notifications/notification-shape.ts`) is a runtime check, not a second
 * description of the wire: the types are the generated ones. This test reads the contract and holds the guard to it, as `pickup-contract.test.ts`
 * does for the pickup screens: every field the guard reads is a field of its schema, every field the contract names is one the guard knows (a
 * field the contract adds has to be decided on, here, before any screen can draw it), every field the contract requires is one the guard
 * requires, and every value of an enumeration the guard recognises is one the contract has and the other way round. The generated client's own
 * types are held to the same lists at compile time.
 */
const CONTRACT = resolve(import.meta.dirname, '../../../contracts/openapi.yaml');

interface Schema {
  readonly type?: string | readonly string[];
  readonly format?: string;
  readonly enum?: readonly (string | null)[];
  readonly required?: readonly string[];
  readonly properties?: Record<string, Schema>;
  readonly items?: Schema;
  readonly $ref?: string;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maxLength?: number;
  readonly description?: string;
}

interface Operation {
  readonly operationId?: string;
  readonly 'x-permission'?: string;
  readonly security?: readonly Record<string, unknown>[];
  readonly parameters?: readonly (
    | {
        readonly $ref?: string;
        readonly name?: string;
        readonly in?: string;
        readonly required?: boolean;
        readonly schema?: Schema;
      }
    | undefined
  )[];
  readonly requestBody?: unknown;
  readonly responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
}

const document = parse(readFileSync(CONTRACT, 'utf8')) as {
  components: { schemas: Record<string, Schema>; parameters: Record<string, Schema> };
  paths: Record<string, Record<string, Operation>>;
};

const entry = document.components.schemas.NotificationLogEntry;
if (entry === undefined) throw new Error('The contract has no schema NotificationLogEntry.');
const properties = entry.properties ?? {};
const operation = document.paths['/notifications']?.get;
if (operation === undefined) throw new Error('The contract has no GET /notifications.');

const valuesOf = (schema: Schema | undefined): string[] =>
  (schema?.enum ?? []).filter((value): value is string => value !== null);

const parameter = (name: string) =>
  operation.parameters?.find((candidate) => candidate?.name === name);

/**
 * Whether two unions of words are the same, member for member: each is assignable to the other. (For a union of string literals that is
 * equality; it asks the compiler, and says nothing at run time.)
 */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Entry = components['schemas']['NotificationLogEntry'];

describe('the guard of NotificationLogEntry and the contract', () => {
  const fields = NOTIFICATION_FIELDS.NotificationLogEntry;

  // Break caught: a guard reading a field the contract does not have (a rename in the contract would leave it refusing every real answer).
  it('reads only fields that the schema has', () => {
    for (const field of [...fields.required, ...fields.optional]) {
      expect(Object.keys(properties), field).toContain(field);
    }
  });

  // Break caught: a field the contract adds, and the guard never decides about. Every field is read (and judged) or the test says so.
  it('knows every field that the schema has', () => {
    expect([...fields.required, ...fields.optional].toSorted()).toEqual(
      Object.keys(properties).toSorted(),
    );
  });

  // Break caught: the contract making a field mandatory that the guard treats as optional.
  it('requires every field that the contract requires of the answer', () => {
    for (const field of entry.required ?? []) {
      expect(fields.required, field).toContain(field);
    }
  });

  // Break caught: the guard requiring a field the contract says may be absent, which would refuse a real answer.
  it('requires only fields that the contract requires', () => {
    for (const field of fields.required) {
      expect(entry.required, field).toContain(field);
    }
  });

  // Break caught: a value the contract adds to an enumeration (or drops from it) that the guard does not know.
  it('recognises exactly the values of each enumeration the contract has', () => {
    const enums: Record<string, readonly string[]> = fields.enums;
    for (const [field, values] of Object.entries(enums)) {
      expect([...values].toSorted(), field).toEqual(valuesOf(properties[field]).toSorted());
    }
  });

  // Break caught: a field that may be null in the contract and is treated as always there (or the other way round): the guard takes null for
  // absent on exactly these.
  it('takes null for absent on exactly the fields the contract lets be null', () => {
    const nullable = Object.entries(properties)
      .filter(([, schema]) => Array.isArray(schema.type) && schema.type.includes('null'))
      .map(([name]) => name)
      .toSorted();

    expect(nullable).toEqual([...fields.optional].toSorted());
    for (const name of nullable) {
      expect(
        parseNotificationEntry({ ...notificationFixture(), [name]: null }),
        name,
      ).toBeDefined();
    }
  });
});

describe('the guard of the record a message is about and the contract', () => {
  const subject = properties.subject;

  it('has the fields and the types the guard reads', () => {
    expect([...(subject?.required ?? [])].toSorted()).toEqual(
      [...SUBJECT_FIELDS.required].toSorted(),
    );
    expect([...SUBJECT_TYPES].toSorted()).toEqual(valuesOf(subject?.properties?.type).toSorted());
    expect(subject?.properties?.id?.format).toBe('uuid');
  });
});

describe('the lists of the guard and the generated client', () => {
  // Break caught (at compile time): a value the generated client has and a list of the guard does not, or the other way round. `tsc` fails on
  // this file, and so on every mapping typed over the same unions (`message-presentation.ts`), until someone decides how it reads.
  it('are the same unions, member for member', () => {
    const same: [true, true, true, true, true] = [
      true satisfies Equal<(typeof NOTIFICATION_STATES)[number], Entry['state']>,
      true satisfies Equal<(typeof NOTIFICATION_AUDIENCES)[number], Entry['audience']>,
      true satisfies Equal<(typeof NOTIFICATION_CHANNELS)[number], Entry['channel']>,
      true satisfies Equal<
        (typeof SUPPRESSION_REASONS)[number],
        NonNullable<Entry['suppression_reason']>
      >,
      true satisfies Equal<(typeof OUTCOME_CLASSES)[number], NonNullable<Entry['outcome_class']>>,
    ];

    expect(same.every(Boolean)).toBe(true);
    expect(true satisfies Equal<(typeof SUBJECT_TYPES)[number], Entry['subject']['type']>).toBe(
      true,
    );
  });
});

describe('every value of the contract is known to the guard', () => {
  // Break caught: a value the contract has that the guard refuses, so that a real message makes the whole log unreadable.
  it.each(valuesOf(properties.state))('takes the state %s', (state) => {
    const body =
      state === 'SUPPRESSED'
        ? suppressedFixture('KILL_SWITCH')
        : notificationFixture({ state: state as Entry['state'] });

    expect(parseNotificationEntry(body)).toMatchObject({ state });
  });

  it.each(valuesOf(properties.audience))('takes the audience %s', (audience) => {
    expect(
      parseNotificationEntry(notificationFixture({ audience: audience as Entry['audience'] })),
    ).toMatchObject({ audience });
  });

  it.each(valuesOf(properties.channel))('takes the channel %s', (channel) => {
    expect(
      parseNotificationEntry(notificationFixture({ channel: channel as Entry['channel'] })),
    ).toMatchObject({ channel });
  });

  it.each(valuesOf(properties.suppression_reason))('takes the reason %s', (reason) => {
    expect(
      parseNotificationEntry(suppressedFixture(reason as NonNullable<Entry['suppression_reason']>)),
    ).toMatchObject({ suppression_reason: reason });
  });

  it.each(valuesOf(properties.outcome_class))('takes the outcome %s', (outcome) => {
    expect(
      parseNotificationEntry(
        notificationFixture({ outcome_class: outcome as NonNullable<Entry['outcome_class']> }),
      ),
    ).toMatchObject({ outcome_class: outcome });
  });

  // Break caught: a value the contract does not have, accepted, so that an answer of another version is drawn with words nobody chose.
  it.each(['state', 'audience', 'channel', 'suppression_reason', 'outcome_class'])(
    'refuses a %s that the contract does not have, and does not throw',
    (field) => {
      const body = { ...suppressedFixture('KILL_SWITCH'), [field]: 'A_VALUE_FROM_THE_FUTURE' };

      expect(() => parseNotificationEntry(body)).not.toThrow();
      expect(parseNotificationEntry(body)).toBeUndefined();
    },
  );
});

describe('the patterns and bounds the guard assumes', () => {
  it('has the pattern of a message’s kind and of the provider’s word, exactly as the contract has them', () => {
    expect(properties.message_kind?.pattern).toBe(MESSAGE_KIND.source);
    expect(properties.provider_outcome_class?.pattern).toBe(PROVIDER_OUTCOME_CLASS.source);
  });

  // Break caught: the hint allowed to be longer than the contract lets it be, which is how a number in clear would get in.
  it('has the length of the hint the contract has, and takes the hint the contract shows', () => {
    expect(properties.destination_hint?.maxLength).toBe(MAX_DESTINATION_HINT);
    const example = /`(\+\d+\*+\d+)`/.exec(properties.destination_hint?.description ?? '')?.[1];

    expect(example).toBeDefined();
    expect(example?.length ?? 99).toBeLessThanOrEqual(MAX_DESTINATION_HINT);
    expect(DESTINATION_HINT.test(example ?? '')).toBe(true);
    expect(
      parseNotificationEntry(notificationFixture({ destination_hint: example ?? null })),
    ).toBeDefined();
  });

  it('has the smallest version and count the guard takes', () => {
    expect(properties.template_version?.minimum).toBe(1);
    expect(properties.attempt_count?.minimum).toBe(0);
    expect(
      parseNotificationEntry(notificationFixture({ template_version: 1, attempt_count: 0 })),
    ).toBeDefined();
    expect(parseNotificationEntry(notificationFixture({ template_version: 0 }))).toBeUndefined();
    expect(parseNotificationEntry(notificationFixture({ attempt_count: -1 }))).toBeUndefined();
  });

  // Break caught: the premise of the guard's refusal of a reason on a message that was not held back, stated by the contract in words.
  it('says a reason is there exactly when the state is SUPPRESSED, which the guard holds to', () => {
    expect(properties.suppression_reason?.description).toMatch(
      /present exactly when the state is `SUPPRESSED`/,
    );
  });

  it('has the page size the guard assumes as its largest', () => {
    const pageSize = document.components.parameters.PageSize as unknown as {
      schema: { maximum: number };
    };

    expect(pageSize.schema.maximum).toBe(100);
  });
});

describe('the operation the screen calls', () => {
  it('is listNotifications, behind notification.read and the browser session alone', () => {
    expect(operation.operationId).toBe('listNotifications');
    expect(operation['x-permission']).toBe('notification.read');
    expect(operation.security).toEqual([{ browserSession: [] }]);
    expect(operation.requestBody).toBeUndefined();
  });

  // Break caught: the screen asking for a filter the list does not have, or sending a value it does not take; and a filter by number, which the
  // list does not have and the screen must not invent.
  //
  // The list is the screen's filters (the state, the audience, the channel, the subject) and `hub_id`, which task C3 (the Product Owner's decision
  // D12 of 6 November 2026) gave the message log beside the other lists the hub switcher narrows: the screen sends it from step R4, when the
  // switcher is built, and no screen does until then. Each of them is held here, and so is the absence of every other: a parameter the contract adds
  // has to be decided on in this list before a screen can send it.
  it('has the filters the screen sends or will send, and no other', () => {
    const named = (operation.parameters ?? []).flatMap((candidate) =>
      candidate?.name === undefined ? [candidate?.$ref?.split('/').at(-1) ?? ''] : [candidate.name],
    );

    expect(named.toSorted()).toEqual(
      ['PageSize', 'PageToken', 'audience', 'channel', 'hub_id', 'state', 'subject_id'].toSorted(),
    );
    expect(valuesOf(parameter('state')?.schema).toSorted()).toEqual(
      [...NOTIFICATION_STATES].toSorted(),
    );
    expect(valuesOf(parameter('audience')?.schema).toSorted()).toEqual(
      [...NOTIFICATION_AUDIENCES].toSorted(),
    );
    expect(valuesOf(parameter('channel')?.schema).toSorted()).toEqual(
      [...NOTIFICATION_CHANNELS].toSorted(),
    );
    expect(parameter('subject_id')?.schema?.format).toBe('uuid');
  });

  // Break caught: the hub of the message log declared as something other than the optional identifier that the lists which already take a hub
  // declare (a required parameter, a header or a path parameter, a pattern or an enumeration no other list has), or dropped while a screen is
  // built to send it (step R4): it is the same parameter and type as on the staff, rider and vendor lists (task C3, `AC-HUBF-03`).
  it('has an optional hub filter that is a uuid in the query, as the lists that already take a hub have', () => {
    const hub = parameter('hub_id');

    expect(hub).toMatchObject({
      name: 'hub_id',
      in: 'query',
      schema: { type: 'string', format: 'uuid' },
    });
    expect(hub?.required ?? false).toBe(false);
    expect(hub?.schema).toEqual({ type: 'string', format: 'uuid' });
    for (const operationId of ['listStaffIdentities', 'listRiders', 'listVendorAccounts']) {
      const other = Object.values(document.paths)
        .flatMap((item) => Object.values(item))
        .find((candidate) => candidate.operationId === operationId)
        ?.parameters?.find((candidate) => candidate?.name === 'hub_id');
      expect(other, operationId).toBeDefined();
      expect(hub?.schema, operationId).toEqual(other?.schema);
    }
  });

  it('answers with a list of entries and the token of the next page', () => {
    const ok = operation.responses?.['200']?.content?.['application/json']?.schema;

    expect(ok?.required).toEqual(['items', 'next_page_token']);
    expect(ok?.properties?.items?.items?.$ref).toBe('#/components/schemas/NotificationLogEntry');
  });
});

describe('no field named for a number, a text or a code is read', () => {
  /** What a number in clear, a message's words, a code and a credential are called on a wire. The masked hint is the one number there is. */
  const FORBIDDEN =
    /(^|_)(destination|phone|msisdn|number|digest|secret|password|credential|otp|text|body|content|code|ref|token|link|url)(_|$)/;

  it('among the fields the guard reads, but the hint', () => {
    const read = [
      ...NOTIFICATION_FIELDS.NotificationLogEntry.required,
      ...NOTIFICATION_FIELDS.NotificationLogEntry.optional,
      ...SUBJECT_FIELDS.required,
    ];
    const named = read.filter((name) => FORBIDDEN.test(name) && name !== 'destination_hint');

    expect(named).toEqual([]);
    expect(read).toContain('destination_hint');
  });

  // Break caught: the contract giving an entry a field for a number, a text or a code: the premise of the whole screen. It is decided on here.
  it('among the fields the contract has, but the hint', () => {
    const named = Object.keys(properties).filter(
      (name) => FORBIDDEN.test(name) && name !== 'destination_hint',
    );

    expect(named).toEqual([]);
  });

  it('can find one: the pattern is not empty', () => {
    expect(FORBIDDEN.test('destination')).toBe(true);
    expect(FORBIDDEN.test('recipient_phone')).toBe(true);
    expect(FORBIDDEN.test('handshake_code')).toBe(true);
    expect(FORBIDDEN.test('rendered_text')).toBe(true);
    expect(FORBIDDEN.test('provider_message_ref')).toBe(true);
    expect(FORBIDDEN.test('message_kind')).toBe(false);
    expect(FORBIDDEN.test('provider_outcome_class')).toBe(false);
  });
});
