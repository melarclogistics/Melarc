import { cannotText } from './capability-words';
import type { CopyRule } from './problem-copy';

/**
 * The words of the receiving screens of a run (S1.35c; OB-S1-111), in the one table, keyed by operation, context and code like the rest of it. **All of them are drafts, proposed for the Product Owner to review with
 * the composed screens.** They speak the vocabulary of the floor, which is the owner's: *run, vendor, parcels, check in, missing, extra, damaged, decide*. **No wording on a receiving screen says** *intake*,
 * *adjudicate*, *itemise*, *reconciliation*, *advisory lock* or *the server*, nor explains how the system works in the voice of the people who built it (`receiving-copy.test.ts` reads every rule and fails on one);
 * the blind count keeps one line of its own. A refusal names the capability in plain words and never a key or a role (PRODUCT_DESIGN_DIRECTION section 6.5), says what happened to what the officer was doing, and says
 * what to do next, because a refusal shown as a dead end misrepresents the policy. A refusal that declares a `details.rule` is worded by it (`problemOf` reads the rule as the context when the page gave none;
 * the rules are the contract's: errors-and-enums.md section 5.3a).
 *
 * **Two of the operations the run page calls are shared with the blind-count screens** (`recordIntakeCondition`, and the evidence steps `createEvidence` and `completeEvidenceUpload`), whose words in `hub-intake-copy.ts`
 * speak of *an intake*. The floor says the same things in its own voice, so the run page words them under `floor:<operation>`: the name only keys the table, it is no operation, and the stage that reworks the
 * blind-count screens folds the two tables into one.
 */
const OTHER_HUB = 'This run was handed over at a hub your account does not work in.';
const RUN_NOT_FOUND = 'This run could not be found.';
const VENDOR_NOT_FOUND = 'This vendor could not be found.';
const PARCEL_NOT_FOUND = 'This parcel could not be found.';
const REFRESH = 'Refresh the page to see where it stands.';
const NOTE_REFUSED = 'Check the note marked below: it was not accepted as written.';
const LISTING_STARTED =
  'Listing the orders for this vendor has started, so its parcels can no longer be changed here.';
const STALE_LIST =
  'That page of the list could not be opened: its place in the list was not accepted. Go back to the first page to start again.';
const NO_PHOTOS =
  'This vendor has no photos to check against, so its parcels are counted and not checked in. Open the vendor to type the count.';
const FINISHED =
  'This vendor was finished already, so nothing was changed. If a missing parcel turns up, check it in from the missing list; a senior officer can correct anything else.';

/** What every act says when the vendor is no longer as the officer saw it. */
const changed = (what: string): string =>
  `This vendor is no longer as you saw it, so ${what} was not recorded. ${REFRESH}`;

export const RECEIVING_COPY: readonly CopyRule[] = [
  // The queue by run, the run's page and the missing list.
  { operation: 'listReceivingRuns', text: 'The runs could not be loaded.' },
  { operation: 'listReceivingRuns', code: 'PERMISSION_DENIED', text: cannotText('hub.read') },
  {
    operation: 'listReceivingRuns',
    code: 'VALIDATION_FAILED',
    text: 'That search or view was not accepted. Use at least 2 letters or digits, or choose another view.',
  },
  {
    operation: 'listReceivingRuns',
    context: 'cursor',
    code: 'VALIDATION_FAILED',
    text: STALE_LIST,
  },
  { operation: 'getReceivingRun', text: 'This run could not be loaded.' },
  { operation: 'getReceivingRun', code: 'PERMISSION_DENIED', text: cannotText('hub.read') },
  { operation: 'getReceivingRun', code: 'NOT_FOUND', text: RUN_NOT_FOUND },
  { operation: 'getReceivingRun', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  { operation: 'listMissingParcels', text: 'The missing parcels could not be loaded.' },
  { operation: 'listMissingParcels', code: 'PERMISSION_DENIED', text: cannotText('hub.read') },
  {
    operation: 'listMissingParcels',
    code: 'VALIDATION_FAILED',
    text: 'That view was not accepted. Choose one of the views of the list.',
  },
  {
    operation: 'listMissingParcels',
    context: 'cursor',
    code: 'VALIDATION_FAILED',
    text: STALE_LIST,
  },
  {
    operation: 'getEvidenceLimits',
    text: 'The limits on photos could not be loaded, so this photo could not be checked. Try again.',
  },

  // A tap on a parcel's photo.
  { operation: 'recordParcelArrival', text: 'The tap was not saved. Tap the photo again.' },
  {
    operation: 'recordParcelArrival',
    code: 'PERMISSION_DENIED',
    text: cannotText('hub.intake.count'),
  },
  { operation: 'recordParcelArrival', code: 'NOT_FOUND', text: PARCEL_NOT_FOUND },
  {
    operation: 'recordParcelArrival',
    code: 'HUB_SCOPE_VIOLATION',
    text: 'This parcel belongs to a hub your account does not work in.',
  },
  {
    operation: 'recordParcelArrival',
    code: 'VALIDATION_FAILED',
    text: 'That tap was not accepted. Tap the photo again.',
  },
  {
    operation: 'recordParcelArrival',
    context: 'check_in_finished',
    code: 'STATE_CONFLICT',
    text: FINISHED,
  },
  {
    operation: 'recordParcelArrival',
    context: 'blind_count_intake',
    code: 'STATE_CONFLICT',
    text: NO_PHOTOS,
  },
  {
    operation: 'recordParcelArrival',
    context: 'itemization_started',
    code: 'STATE_CONFLICT',
    text: LISTING_STARTED,
  },
  {
    operation: 'recordParcelArrival',
    code: 'STATE_CONFLICT',
    text: changed('the tap'),
  },

  // Finishing a vendor: "All N here", or as tapped.
  { operation: 'finishCheckIn', text: 'The vendor was not finished. You can try again.' },
  { operation: 'finishCheckIn', code: 'PERMISSION_DENIED', text: cannotText('hub.intake.count') },
  { operation: 'finishCheckIn', code: 'NOT_FOUND', text: VENDOR_NOT_FOUND },
  {
    operation: 'finishCheckIn',
    code: 'HUB_SCOPE_VIOLATION',
    text: 'This vendor belongs to a hub your account does not work in.',
  },
  {
    operation: 'finishCheckIn',
    code: 'VALIDATION_FAILED',
    text: 'That was not accepted. Say how many parcels you counted on the table, as a whole number above 0.',
  },
  {
    operation: 'finishCheckIn',
    context: 'count_changed',
    code: 'STATE_CONFLICT',
    text: 'The number of parcels expected from this vendor has changed since you opened this page, so nothing was recorded. Refresh the page, count again and confirm the new number.',
  },
  {
    operation: 'finishCheckIn',
    context: 'has_extra_parcels',
    code: 'STATE_CONFLICT',
    text: 'A parcel that is not on the list has been added for this vendor, so this is not “all here”. Finish this vendor as tapped instead.',
  },
  {
    operation: 'finishCheckIn',
    context: 'check_in_finished',
    code: 'STATE_CONFLICT',
    text: 'This vendor was finished already, so nothing was changed. Refresh the page to see how it was finished.',
  },
  {
    operation: 'finishCheckIn',
    context: 'blind_count_intake',
    code: 'STATE_CONFLICT',
    text: NO_PHOTOS,
  },
  {
    operation: 'finishCheckIn',
    context: 'itemization_started',
    code: 'STATE_CONFLICT',
    text: LISTING_STARTED,
  },
  {
    operation: 'finishCheckIn',
    context: 'stale',
    code: 'STATE_CONFLICT',
    text: `This vendor changed after you opened it, so nothing was recorded. ${REFRESH}`,
  },
  { operation: 'finishCheckIn', code: 'STATE_CONFLICT', text: changed('the finish') },

  // A parcel that is on the table and not on the list.
  { operation: 'addExtraParcel', text: 'The parcel was not added. You can try again.' },
  { operation: 'addExtraParcel', code: 'PERMISSION_DENIED', text: cannotText('hub.intake.count') },
  {
    operation: 'addExtraParcel',
    code: 'EVIDENCE_NOT_STORED',
    text: 'The photo of this parcel is not stored yet, or was used already. Take it again.',
  },
  { operation: 'addExtraParcel', code: 'NOT_FOUND', text: VENDOR_NOT_FOUND },
  {
    operation: 'addExtraParcel',
    code: 'HUB_SCOPE_VIOLATION',
    text: 'This vendor belongs to a hub your account does not work in.',
  },
  { operation: 'addExtraParcel', code: 'VALIDATION_FAILED', text: NOTE_REFUSED },
  {
    operation: 'addExtraParcel',
    context: 'check_in_finished',
    code: 'STATE_CONFLICT',
    text: 'This vendor’s case has been decided, so a parcel can no longer be added here. A senior officer can correct it.',
  },
  {
    operation: 'addExtraParcel',
    context: 'blind_count_intake',
    code: 'STATE_CONFLICT',
    text: NO_PHOTOS,
  },
  {
    operation: 'addExtraParcel',
    context: 'itemization_started',
    code: 'STATE_CONFLICT',
    text: LISTING_STARTED,
  },
  { operation: 'addExtraParcel', code: 'STATE_CONFLICT', text: changed('the parcel') },

  // Damage on a parcel's own photo: the condition of that parcel, once. (The same operation as the blind-count screens', in the floor's words.)
  {
    operation: 'floor:recordIntakeCondition',
    text: 'The damage was not recorded. You can try again.',
  },
  {
    operation: 'floor:recordIntakeCondition',
    code: 'PERMISSION_DENIED',
    text: cannotText('hub.intake.count'),
  },
  {
    operation: 'floor:recordIntakeCondition',
    code: 'REASON_REQUIRED',
    text: 'Damaged and tampered need a photo of the parcel. Add at least one.',
  },
  {
    operation: 'floor:recordIntakeCondition',
    code: 'EVIDENCE_NOT_STORED',
    text: 'A photo is not stored yet, or is not a photo of this vendor’s parcels. Take it again.',
  },
  {
    operation: 'floor:recordIntakeCondition',
    context: 'parcel_required',
    code: 'VALIDATION_FAILED',
    text: 'Choose the parcel that is damaged: damage is recorded on a parcel’s own photo.',
  },
  { operation: 'floor:recordIntakeCondition', code: 'VALIDATION_FAILED', text: NOTE_REFUSED },
  { operation: 'floor:recordIntakeCondition', code: 'NOT_FOUND', text: VENDOR_NOT_FOUND },
  {
    operation: 'floor:recordIntakeCondition',
    code: 'HUB_SCOPE_VIOLATION',
    text: 'This vendor belongs to a hub your account does not work in.',
  },
  {
    operation: 'floor:recordIntakeCondition',
    context: 'condition_already_recorded',
    code: 'STATE_CONFLICT',
    text: 'Damage has been recorded for this parcel already. It is recorded once; a senior officer can change it.',
  },
  {
    operation: 'floor:recordIntakeCondition',
    context: 'parcel_not_arrived',
    code: 'STATE_CONFLICT',
    text: 'This parcel has not been checked in. Check it in, then record the damage.',
  },
  {
    operation: 'floor:recordIntakeCondition',
    context: 'itemization_started',
    code: 'STATE_CONFLICT',
    text: LISTING_STARTED,
  },
  {
    operation: 'floor:recordIntakeCondition',
    context: 'stale',
    code: 'STATE_CONFLICT',
    text: `This vendor changed after you opened it, so the damage was not recorded. ${REFRESH}`,
  },
  {
    operation: 'floor:recordIntakeCondition',
    code: 'STATE_CONFLICT',
    text: changed('the damage'),
  },

  // A senior officer's correction of a count or a check-in.
  {
    operation: 'correctIntakeCount',
    text: 'The correction was not recorded. You can try again.',
  },
  {
    operation: 'correctIntakeCount',
    code: 'PERMISSION_DENIED',
    text: 'A senior officer makes corrections. Ask one to open this page.',
  },
  {
    operation: 'correctIntakeCount',
    code: 'REASON_REQUIRED',
    text: 'A reason is needed. Write why you are correcting this.',
  },
  { operation: 'correctIntakeCount', code: 'NOT_FOUND', text: VENDOR_NOT_FOUND },
  {
    operation: 'correctIntakeCount',
    code: 'HUB_SCOPE_VIOLATION',
    text: 'This vendor belongs to a hub your account does not work in.',
  },
  {
    operation: 'correctIntakeCount',
    context: 'mode_mismatch',
    code: 'VALIDATION_FAILED',
    text: 'That correction does not fit how this vendor is checked in: change parcels for a vendor with photos, or the count for one without.',
  },
  {
    operation: 'correctIntakeCount',
    code: 'VALIDATION_FAILED',
    text: 'That correction was not accepted. Check what is marked below.',
  },
  {
    operation: 'correctIntakeCount',
    context: 'itemization_started',
    code: 'STATE_CONFLICT',
    text: 'Listing the orders for this vendor has started, so its count can no longer be corrected here.',
  },
  {
    operation: 'correctIntakeCount',
    context: 'stale',
    code: 'STATE_CONFLICT',
    text: `This vendor changed after you opened it, so the correction was not recorded. ${REFRESH}`,
  },
  { operation: 'correctIntakeCount', code: 'STATE_CONFLICT', text: changed('the correction') },

  // A photo taken at the hub: its declaration, and its confirmation once the file is in the store (the floor's words of the evidence steps).
  {
    operation: 'floor:createEvidence',
    text: 'The photo could not be prepared for sending. Take it again.',
  },
  {
    operation: 'floor:createEvidence',
    code: 'PERMISSION_DENIED',
    text: cannotText('hub.intake.count'),
  },
  {
    operation: 'floor:createEvidence',
    code: 'VALIDATION_FAILED',
    text: 'This photo was not accepted: its type or its size is not one the platform takes. Take another.',
  },
  { operation: 'floor:createEvidence', code: 'NOT_FOUND', text: VENDOR_NOT_FOUND },
  {
    operation: 'floor:createEvidence',
    code: 'STATE_CONFLICT',
    text: `This vendor is no longer as you saw it, so the photo was not accepted. ${REFRESH}`,
  },
  {
    operation: 'floor:completeEvidenceUpload',
    text: 'The photo was sent but could not be confirmed. Take it again.',
  },
  {
    operation: 'floor:completeEvidenceUpload',
    code: 'VALIDATION_FAILED',
    text: 'The file in the store is not the photo that was taken. Take it again.',
  },
  {
    operation: 'floor:completeEvidenceUpload',
    code: 'EVIDENCE_UPLOAD_EXPIRED',
    text: 'The time to send this photo ran out. Take it again.',
  },
  {
    operation: 'floor:completeEvidenceUpload',
    code: 'NOT_FOUND',
    text: 'This photo could not be found. Take it again.',
  },
  {
    operation: 'floor:completeEvidenceUpload',
    code: 'STATE_CONFLICT',
    text: 'This photo is not in a state that can be confirmed. Take it again.',
  },
];

/**
 * The lock's words, in plain words and in one place: **one line**, who opened the check-in and when, and that it stops nobody; and what the page says when it cannot check. The page never says *You* for a lock
 * it could not confirm (the review of Stage 6: a refresh that failed left the page saying *Held by you*).
 */
export const LOCK_WORDS = {
  /** "Ama Owusu opened this check-in at 09:12. It stops nobody." */
  opened: (who: string, at: string): string =>
    `${who} opened this check-in at ${at}. It stops nobody.`,
  /** The officer's own lock. */
  openedByYou: (at: string): string => `You opened this check-in at ${at}. It stops nobody.`,
  /** Nobody has started on this vendor. */
  nobody: 'No one has started on this vendor yet.',
  cannotCheck:
    'The page cannot check who else is checking this in right now. You can carry on: nothing here is blocked by it.',
} as const;
