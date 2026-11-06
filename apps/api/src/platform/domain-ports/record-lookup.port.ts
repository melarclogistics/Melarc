import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';

/**
 * The port through which the records a domain owns reach the one read that finds a record from anywhere in the Ops Portal, `lookupRecords`
 * (task C2; features/operations/global-lookup.md; SOLUTION_ARCHITECTURE.md section 5: `platform/` defines narrow ports, a domain implements the
 * ones it owns, and the composition root wires them).
 *
 * - **Owner:** the domain that owns a kind of record implements one source for it (`pickup/pickup-record-lookup.adapter.ts` for the requests and
 *   the runs, `vendor/vendor-record-lookup.adapter.ts`, `dispatch/rider-record-lookup.adapter.ts`, `staff/staff-record-lookup.adapter.ts`);
 *   `platform/lookup/` is the caller. The composition root binds them (`domain-ports.module.ts`).
 * - **A source finds what its kind's own list would show the same session, by the same rows.** The scope is not the source's to write: it is the
 *   row-level security of the transaction the caller opens, under the context of `readKey`, the key of the kind's own read.
 * - **Inputs:** the caller's transaction handle, always, the query the caller understood (`LookupQuery`) and the most it may return. The handle
 *   is opened by the caller under the context of `readKey`; the source reads on it, opens no transaction, takes no connection of its own, sets no
 *   context and writes nothing.
 * - **A source asks one question of a query, and no other:** a code looks for the record that carries it (a kind with no code answers none), a phone
 *   typed in full looks for the records that carry that number (a kind with no phone searched answers none), and anything else is a word-prefix
 *   search of the names. A source that has no way to answer a query returns no hit.
 * - **Failure:** a source that cannot answer throws, and the whole read fails (`500`): the platform never answers with the kinds it has and without
 *   the one it has not.
 */

/** The kinds of record a lookup can return, **in the order an answer lists them**: a closed list, the contract's `RecordLookupKind`. */
export const RECORD_LOOKUP_KINDS = [
  'PICKUP_REQUEST',
  'PICKUP_MANIFEST',
  'VENDOR_ACCOUNT',
  'RIDER',
  'STAFF_IDENTITY',
] as const;

export type RecordLookupKind = (typeof RECORD_LOOKUP_KINDS)[number];

/** What the text of a lookup is, as the platform understood it (`platform/lookup/lookup-query.ts`). */
export interface LookupQuery {
  /** The text, trimmed, with each run of white space made one space; 2 to 64 characters. */
  readonly text: string;
  /** The operational code the text is, in upper case (`HUB-TT-XXXXXX`), when it has that shape. */
  readonly code?: string;
  /** The record type of `code` (`PR`, `MF`, ...). */
  readonly codeType?: string;
  /** The E.164 form of the phone number the text is, when it is a whole number. */
  readonly phone?: string;
  /** The account identifier of a vendor the text is (eight characters), when it has that shape; it is matched besides the name. */
  readonly accountIdentifier?: string;
}

/**
 * One record a source found: the facts the platform needs to draw a result and to judge whether a hub was crossed. **Facts, not wording**
 * (the Product Owner's decision D1, 6 November 2026): a source states what the record is and where it stands, and writes no sentence and names
 * no page; the Ops Portal words the line and chooses the route.
 */
export interface LookupHit {
  readonly id: string;
  /** The operational code of a pickup request or a run, or a vendor account's identifier; none for a rider and a staff member. */
  readonly code?: string;
  readonly title: string;
  /**
   * The record's own state **as the value of its own enumeration, unchanged**: the `state` of a pickup request or a run, the `status` of a
   * vendor account, a rider or a staff profile. Absent only for a kind with none.
   */
  readonly state?: string;
  /** The hub the record belongs to, or `null` for a record that has none (a staff member without a primary hub). The platform reads its name. */
  readonly hubId: string | null;
  /** The day a pickup request was promised or a pickup run is to be worked (`YYYY-MM-DD`); none for every other kind. */
  readonly serviceDate?: string;
  /**
   * A pickup request's sender name exactly as the request's own read shows it (the Product Owner's decision of 6 November 2026), so that a request
   * found by a code, a number or a name says whose it is. **A pickup request only**: no other kind has one, and nothing else of a request rides along.
   */
  readonly senderName?: string;
  /** The phone (E.164) the person searched by, when it was a phone that found the record: the platform masks it. Never any other number. */
  readonly matchedPhone?: string;
}

export interface RecordLookupSource {
  readonly kind: RecordLookupKind;
  /**
   * The permission key of the kind's own read. It decides whether the session is searched for this kind at all (a session whose bundle holds no
   * grant of it is not) and the scope the search is made in: **the grant of this key**, never the widest grant the session holds.
   */
  readonly readKey: string;
  /**
   * Whether this kind can answer the query at all (a vendor has no code and no phone to find it by, a staff profile is found by name alone). The
   * platform opens a transaction for a key only when one of its kinds can, and asks a kind only a question it can answer. Pure: no database.
   */
  answers(query: LookupQuery): boolean;
  /** At most `limit` hits, in the kind's order (a request newest first, the others by name then id). */
  search(
    handle: TransactionHandle,
    query: LookupQuery,
    limit: number,
  ): Promise<readonly LookupHit[]>;
}

/** The injection token of the sources of every kind, bound once, by the composition root. */
export const RECORD_LOOKUP_SOURCES = Symbol('RECORD_LOOKUP_SOURCES');
