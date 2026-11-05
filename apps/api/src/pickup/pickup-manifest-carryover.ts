import { noteRefusal } from '../platform/audit/audit-record.js';
import type { ValidatedReason } from '../platform/settings/reason-validator.js';
import type { BodyViolation } from './pickup-manifest-eligibility.js';

/**
 * The reason a manifest gives for each overdue request it carries over (S1.20 closeout; the Product Owner's decision of 2 November 2026, on the reviewer's recommendation;
 * features/pickup/pickup-manifest.md section 4; domain-model.md sections 3.9 and 6.4). A pure judgement of the `carryover` entries of a
 * creation against the requests the manifest carries over, so that its rules and their order are tested without a database; the
 * catalogue's judgement of each reason (`REASON_REQUIRED`, `REASON_NOT_ACTIVE`) is the validator's and follows it.
 *
 * - **A request is carried over when it was promised for an earlier day than the manifest's** (`pickup-manifest-eligibility.ts`), and it
 *   then needs a reason of the `PICKUP_CARRYOVER` domain. Old work is never refused for its age; it is only never carried over silently.
 * - **One entry says why one request is carried over.** A reason covers several requests only because it is given, expressly, for each
 *   of them: a reason that is true of every request of a batch is repeated for them, and one that is not is not. An entry for a request
 *   that is not on the manifest (`not_listed`) or is on its own day (`not_carried_over`) is refused, because a recorded carry-over that
 *   never happened would be false evidence, and a request given two entries (`duplicate`) has no single reason.
 * - **A note is screened as the ledger screens one** (`noteRefusal`), so that what is kept is what any record of the act could keep. A
 *   blank note is no note.
 *
 * Every violation of the body names the place of the offending entry (`/carryover/<position>/<member>`) and a rule, never a value, and
 * they are reported together, in the order of the entries. Only when the entries are well formed are the requests that lack an entry told:
 * those are `missing`, and the use case answers them `REASON_REQUIRED` once the structure is right.
 */
export interface CarryoverEntry {
  readonly pickup_request_id: string;
  readonly reason_code: string;
  readonly note?: string;
}

export type CarryoverRule = 'duplicate' | 'not_listed' | 'not_carried_over';

/** An entry that is to be validated against the catalogue, with its place in `carryover` (for the pointer of a refusal). */
export interface PlacedEntry {
  readonly position: number;
  readonly entry: CarryoverEntry;
}

export interface CarryoverJudgement {
  readonly violations: readonly BodyViolation[];
  /** The places, in `pickup_request_ids`, of the carried-over requests that have no entry; none where a violation was found. */
  readonly missing: readonly number[];
  /** The entry of each carried-over request, by lower-case id, in the order of the manifest; none where a violation was found. */
  readonly entries: ReadonlyMap<string, PlacedEntry>;
}

const entryAt = (position: number, member: string): string =>
  `/carryover/${String(position)}/${member}`;

/** A note that says something (a blank one is none): `undefined` for none, otherwise as given, because the operation does not trim a person's words. */
export function noteOf(entry: Pick<CarryoverEntry, 'note'>): string | undefined {
  return entry.note === undefined || entry.note.trim() === '' ? undefined : entry.note;
}

export function judgeCarryover(input: {
  /** The ids of the manifest in the order submitted, lower case; each is listed once (a repeated id was refused before this). */
  readonly ids: readonly string[];
  /** The lower-case ids of the requests the manifest carries over (`assessRequests`). */
  readonly carriedOver: readonly string[];
  readonly entries: readonly CarryoverEntry[] | undefined;
}): CarryoverJudgement {
  const listed = new Set(input.ids);
  const carried = new Set(input.carriedOver);
  const violations: BodyViolation[] = [];
  const entries = new Map<string, PlacedEntry>();

  (input.entries ?? []).forEach((entry, position) => {
    const id = entry.pickup_request_id.toLowerCase();
    const rule: CarryoverRule | undefined = entries.has(id)
      ? 'duplicate'
      : !listed.has(id)
        ? 'not_listed'
        : !carried.has(id)
          ? 'not_carried_over'
          : undefined;
    if (rule !== undefined) {
      violations.push({ in: 'body', pointer: entryAt(position, 'pickup_request_id'), rule });
    } else {
      entries.set(id, { position, entry });
    }
    const note = noteOf(entry);
    const noteRule = note === undefined ? undefined : noteRefusal(note);
    if (noteRule !== undefined) {
      violations.push({ in: 'body', pointer: entryAt(position, 'note'), rule: noteRule });
    }
  });

  if (violations.length > 0) return { violations, missing: [], entries: new Map() };
  const missing = input.ids.flatMap((id, position) =>
    carried.has(id) && !entries.has(id) ? [position] : [],
  );
  return { violations, missing, entries };
}

/**
 * What the stop keeps of its carry-over: the reason as the actor saw it (the code and the label of the catalogue at that moment, so a
 * later change of the wording does not rewrite what was agreed) and the note, if any. Never changed once the stop is made.
 */
export interface CarryoverSnapshot {
  readonly reason_code: string;
  readonly label: string;
  readonly note: string | null;
}

export function carryoverSnapshotOf(
  reason: Pick<ValidatedReason, 'code' | 'label'>,
  note: string | undefined,
): CarryoverSnapshot {
  return { reason_code: reason.code, label: reason.label, note: note ?? null };
}
