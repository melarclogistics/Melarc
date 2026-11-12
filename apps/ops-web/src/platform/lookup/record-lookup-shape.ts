import type { components } from '@melarc/api-client';

import { DESTINATION_HINT, MAX_DESTINATION_HINT } from '../notifications/notification-shape';
import { calendarDateOf } from '../pickup/pickup-shape';
import { isOneOf, isRecord, uuidOf } from '../staff/staff-shape';

/**
 * The runtime judgement of the answer of `lookupRecords` (task C2; `AC-LOOKUP-10`; the same discipline as `queue-summary-shape.ts`). A type is a
 * promise nobody checked at run time: a proxy's `{}` would be drawn as "nothing found", and a result is something the person opens, so an id
 * that is not an identifier is never one (the page it opens is the Portal's own, `record-route.ts`). The guard is not a second description of
 * the wire: the types stay the contract's, and `test/record-lookup-contract.test.ts` reads the contract and holds the lists below to its schemas.
 *
 * **The answer carries facts and no wording** (the Product Owner's decision D1, 6 November 2026): the record's own state, its hub by name, a
 * service date, and a phone only as a masked hint. The words of the line and the page a result opens are this application's.
 *
 * **What the parser returns is what it judged and nothing else**: a property the contract adds and this does not read is not carried into a
 * screen. **A result of a kind this build does not know is left out and the rest kept**: the contract's list of kinds is closed, and a server
 * newer than the page may name one the page has no icon for. (Every other disagreement with the contract refuses the whole answer, as
 * everywhere else.) **A phone hint that is not a masked number is refused**, with the page it came in: a number in clear is never drawn.
 */
export const RECORD_LOOKUP_KINDS = [
  'PICKUP_REQUEST',
  'PICKUP_MANIFEST',
  'VENDOR_ACCOUNT',
  'RIDER',
  'STAFF_IDENTITY',
] as const;

export const RECORD_LOOKUP_FIELDS = {
  RecordLookupPage: { required: ['items'], optional: [], enums: {} },
  RecordLookupResult: {
    required: ['kind', 'id', 'title'],
    optional: ['code', 'state', 'hub', 'service_date', 'sender_name', 'phone_hint'],
    enums: { kind: RECORD_LOOKUP_KINDS },
  },
  /** The hub of a result: its id and display name, as `authorized_hubs` of the session names one. */
  RecordLookupHub: { required: ['id', 'display_name'], optional: [], enums: {} },
} as const;

export type LookupKindName = components['schemas']['RecordLookupKind'];

/** The hub a record belongs to, by name for the line a result is drawn on. */
export interface RecordLookupHubView {
  readonly id: string;
  readonly name: string;
}

/** One record found: a pointer to it and the facts that say where it stands, as the server gave them. */
export interface RecordLookupResultView {
  readonly kind: LookupKindName;
  readonly id: string;
  /** None for a rider and a staff member. */
  readonly code: string | null;
  readonly title: string;
  /** The record's own state, the value of its own enumeration, not reworded: this application words it. */
  readonly state: string | null;
  /** None for a staff profile with no primary hub. */
  readonly hub: RecordLookupHubView | null;
  /** A pickup request's or a run's service date (`YYYY-MM-DD`); none for every other kind. */
  readonly serviceDate: string | null;
  /** A pickup request's sender as the request's own read shows it (a label, never an identifier); none for every other kind. */
  readonly senderName: string | null;
  /** The number the person searched by, masked (`+233******222`), on a record that number found; never a number in clear. */
  readonly phoneHint: string | null;
}

export interface RecordLookupView {
  readonly items: readonly RecordLookupResultView[];
}

/** The contract allows 20 results (`RecordLookupPage.items.maxItems`, which `test/record-lookup-contract.test.ts` holds this to); an answer with more is not the API's. */
export const RECORD_LOOKUP_MAX_ITEMS = 20;
/** A line of a result is a name or a code; one longer than this is not one the API gave. */
const MAX_LINE = 500;
/** A value of a record's own enumeration: upper-case words joined by underscores (`IN_PROGRESS`). Anything else is not one the API gave. */
const STATE_WORD = /^[A-Z][A-Z0-9_]{0,63}$/;

const lineOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= MAX_LINE ? value : undefined;

const hintOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= MAX_DESTINATION_HINT && DESTINATION_HINT.test(value)
    ? value
    : undefined;

function hubOf(value: unknown): RecordLookupHubView | undefined {
  if (!isRecord(value)) return undefined;
  const id = uuidOf(value.id);
  const name = lineOf(value.display_name);
  return id === undefined || name === undefined || name.trim() === '' ? undefined : { id, name };
}

function resultOf(body: unknown): RecordLookupResultView | 'unknown-kind' | undefined {
  if (!isRecord(body)) return undefined;
  const {
    kind,
    code,
    state,
    hub,
    service_date: serviceDate,
    sender_name: senderName,
    phone_hint: phoneHint,
  } = body;
  if (typeof kind !== 'string') return undefined;
  const id = uuidOf(body.id);
  const title = lineOf(body.title);
  if (id === undefined || title === undefined) return undefined;
  if (code !== undefined && lineOf(code) === undefined) return undefined;
  if (state !== undefined && !(typeof state === 'string' && STATE_WORD.test(state)))
    return undefined;
  const hubView = hub === undefined ? null : hubOf(hub);
  if (hubView === undefined) return undefined;
  const date = serviceDate === undefined ? null : calendarDateOf(serviceDate);
  if (date === undefined) return undefined;
  const sender = senderName === undefined ? null : lineOf(senderName);
  if (sender === undefined) return undefined;
  const maskedPhone = phoneHint === undefined ? null : hintOf(phoneHint);
  if (maskedPhone === undefined) return undefined;
  // A kind of a newer server is no result here (see above); anything that is not a word at all is not a result of the API's.
  if (!isOneOf(RECORD_LOOKUP_KINDS, kind)) return 'unknown-kind';
  return {
    kind,
    id,
    code: code === undefined ? null : (code as string),
    title,
    state: state ?? null,
    hub: hubView,
    serviceDate: date,
    senderName: sender,
    phoneHint: maskedPhone,
  };
}

/** The page of results the answer describes, or nothing when it is not one the screens may draw. */
export function parseRecordLookup(body: unknown): RecordLookupView | undefined {
  if (!isRecord(body)) return undefined;
  const { items } = body;
  if (!Array.isArray(items) || items.length > RECORD_LOOKUP_MAX_ITEMS) return undefined;
  const kept: RecordLookupResultView[] = [];
  for (const each of items as unknown[]) {
    const result = resultOf(each);
    if (result === undefined) return undefined;
    if (result === 'unknown-kind') continue;
    kept.push(result);
  }
  return { items: kept };
}
