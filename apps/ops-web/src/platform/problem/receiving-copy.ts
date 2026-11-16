import type { IntakeCondition, IntakeState } from '../hub-intake/hub-intake-shape';
import type { ParcelState } from '../hub-receiving/receiving-shape';
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
 * **One of the operations the run page calls is shared with the blind-count screens** (`recordIntakeCondition`), whose words in `hub-intake-copy.ts` speak of *an intake*
 * and of one condition for the whole of it. The floor says the same thing for a parcel in its own voice, so the run page words it under `floor:recordIntakeCondition`: the name only keys the table, it is no operation,
 * and the stage that reworks the blind-count screens folds the two into one. The evidence steps (`createEvidence`, `completeEvidenceUpload`) are worded in the floor's voice in `hub-intake-copy.ts` for every screen that
 * takes a photo.
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

/** "1 parcel", "12 parcels". */
const parcels = (count: number): string => `${String(count)} ${count === 1 ? 'parcel' : 'parcels'}`;
const vendorsOf = (count: number): string => (count === 1 ? 'vendor' : 'vendors');
/** The label of the button that says every parcel of a vendor is here. */
const allHere = (count: number): string =>
  count === 1 ? 'The parcel is here' : `All ${String(count)} here`;

/**
 * The words of what the screens of receiving by run **draw**, in the floor's voice and in one place (S1.35c; OB-S1-111): the labels, the sentences, the buttons and the dialogs of the queue and of the run's page.
 * (The words of a **refusal** are the table above, and the lock's are `LOCK_WORDS`.) **All of them are drafts for the Product Owner to review with the composed screens.** A button is a verb; a state is told in
 * words, with the tone supporting them and never carrying them; a sentence that holds a count is a function of it, so that **no number is ever typed into a sentence** and nothing here works one out; and nothing
 * here says *intake*, *adjudicate*, *itemise*, *reconciliation*, *advisory lock* or *the server*, nor tells an officer without the decision to ask an administrator for it (`receiving-copy.test.ts` reads every
 * string, and every function with sample figures, and fails on one).
 */
export const RECEIVING_WORDS = {
  parcels,
  vendors: vendorsOf,

  /** The queue by run (`/receiving`). */
  queue: {
    title: 'Receiving',
    description:
      'The runs handed over at your hubs, oldest first. Open a run to check its parcels in.',
    viewsLabel: 'Views of the runs',
    tableLabel: 'Runs',
    lookupLabel: 'Search by run code or vendor name',
    views: {
      waiting: {
        label: 'Waiting to be checked in',
        none: 'No run is waiting to be checked in. A run appears here when a rider hands it over at your hub.',
      },
      needs_decision: {
        label: 'Needs a decision',
        none: 'No run has parcels waiting for a senior officer’s decision.',
      },
      all: {
        label: 'All runs',
        none: 'A run appears here when a rider hands it over at your hubs.',
      },
    },
    columns: {
      run: 'Run',
      rider: 'Rider',
      vendors: 'Vendors',
      parcels: 'Parcels',
      toDo: 'To do',
      waiting: 'Waiting',
      checkingIn: 'Checking in now',
      hub: 'Hub',
    },
    countedWithoutPhotos: 'Counted without photos',
    noOne: 'No one',
    you: 'You',
    allCheckedIn: 'Everything is checked in',
    /** The vendors of a run, by name: the first two and how many more ("Kente Crafts, Shea Naturals +2 more"). */
    vendorNames: (first: string, more: number): string =>
      more > 0 ? `${first} +${String(more)} more` : first,
    stillToCheckIn: (waiting: number, total: number): string =>
      `${String(waiting)} of ${String(total)} ${vendorsOf(total)} still to check in`,
    needDecision: (count: number): string =>
      `${String(count)} ${count === 1 ? 'vendor needs' : 'vendors need'} a decision`,
    beingSearchedFor: (count: number): string => `${parcels(count)} being searched for`,
  },

  /** What a state is called: the API's state, said in the floor's words. Each is typed over its whole enumeration, so a value the contract adds is a compile error until someone decides how it reads. */
  states: {
    vendor: {
      AWAITING_COUNT: 'Waiting to be checked in',
      COUNTED: 'Checked in',
      RECONCILIATION_REQUIRED: 'Needs a decision',
      READY_FOR_ITEMIZATION: 'Checked in and cleared',
      ITEMIZING: 'Orders being listed',
      CLOSED: 'Closed',
    } satisfies Record<IntakeState, string>,
    parcel: {
      EXPECTED: 'Not checked in',
      ARRIVED: 'Checked in',
      MISSING: 'Missing',
      VOID: 'Taken back',
    } satisfies Record<ParcelState, string>,
    condition: {
      OK: 'Looks fine',
      DAMAGED: 'Damaged',
      TAMPERED: 'Tampered with',
      OTHER: 'Another problem',
    } satisfies Record<IntakeCondition, string>,
    /** **Not checked yet until someone has recorded one**: never "Good condition" from a default. */
    conditionUnchecked: 'Condition not checked yet',
  },

  /** What a vendor's counts are called, in a line ("11 checked in, 1 missing"): the counts are the API's and nothing here works one out. */
  counts: {
    checkedIn: (count: number): string => `${String(count)} checked in`,
    missing: (count: number): string => `${String(count)} missing`,
    extra: (count: number): string => `${String(count)} extra`,
    damaged: (count: number): string => `${String(count)} damaged`,
  },

  /** The run's page (`/receiving/{run}`). */
  run: {
    documentTitle: (code: string): string => `Run ${code}`,
    loadingTitle: 'Run',
    notFoundTitle: 'Run not found',
    receiving: 'Receiving',
    back: 'Back to receiving',
    loading: 'Loading the run…',
    handedOver: (rider: string, hub: string, at: string): string =>
      `${rider} handed this run over to ${hub} at ${at}.`,
    lookOnly: (cannot: string): string => `You can look at this run. ${cannot}`,
    next: (vendor: string): string => `Next: ${vendor}`,
    goTo: (vendor: string): string => `Go to ${vendor}`,
  },

  /** One vendor's section. */
  vendor: {
    photographed: (count: number): string => `${parcels(count)} photographed`,
    blindPhotographed: 'No photos at the door: counted, not checked in',
    gridLabel: (vendor: string): string => `Photos of ${vendor}’s parcels`,
    overviewHint: (count: number): string =>
      `Count this vendor’s parcels on the table. If ${count === 1 ? 'it is' : `all ${String(count)} are`} here, choose “${allHere(count)}”. If not, choose “The count is different” and tap each parcel that is here.`,
    noPhotosHint:
      'No parcel was photographed for this vendor. If there is a parcel on the table, add it below.',
    tappingHint:
      'Tap each parcel that is on the table. A parcel you do not tap is marked missing when you finish this vendor.',
    /** Where the check-in has got to: the API's counts, said. With an extra the arithmetic is not the page's to do, so the extras are said apart. */
    tally: (arrived: number, expected: number, extras: number): string =>
      extras === 0
        ? `${String(arrived)} of ${String(expected)} checked in`
        : `${String(arrived)} checked in, ${String(extras)} of them not on the list`,
    allHere,
    findHint: 'If a missing parcel turns up, tap its photo and choose “Found it”.',
    countDifferent: 'The count is different',
    finish: 'Finish this vendor',
    addExtra: 'Add a parcel not on the list',
    /** A sentence on a vendor that is finished, by where it stands. */
    standing: {
      COUNTED: 'This vendor is checked in.',
      READY_FOR_ITEMIZATION: 'This vendor is checked in. Nothing is missing.',
      RECONCILIATION_REQUIRED: 'A senior officer will decide about this vendor.',
      ITEMIZING: 'The orders of this vendor are being listed.',
      CLOSED: 'This vendor is closed.',
    },
    /** A vendor whose parcels are counted and not checked in, because Ops excused the door photos. */
    blind: {
      explain:
        'Count this vendor’s parcels on the table first. The rider’s number is shown only after you have typed yours.',
      countButton: 'Count the parcels',
      counted: (count: number): string => `You counted ${parcels(count)}.`,
      variance: {
        MATCH: 'That is the same as the rider’s number.',
        SHORT: 'That is fewer than the rider’s number.',
        OVER: 'That is more than the rider’s number.',
      },
    },
    /** What the page says once an act is done: where the officer is, and what comes next. */
    done: {
      finished: (vendor: string): string => `${vendor} is checked in.`,
      found: (parcel: string): string => `${parcel} is found and checked in.`,
      extraAdded: 'The parcel was added. A senior officer will decide about it.',
      damageRecorded: (parcel: string): string => `The damage to ${parcel} is recorded.`,
      takenBack: (parcel: string): string => `${parcel} was taken back.`,
    },
  },

  /** A parcel: its name, its tile and its dialog. */
  parcel: {
    label: (ordinal: number, extra: boolean): string =>
      extra ? `Extra parcel ${String(ordinal)}` : `Parcel ${String(ordinal)}`,
    tile: {
      checkedIn: 'Checked in',
      checkedInDamaged: 'Checked in, damaged',
      missing: 'Missing',
      damaged: 'Damaged',
      takenBack: 'Taken back',
    },
    from: (vendor: string): string => `From ${vendor}.`,
    checkedInBy: (who: string, at: string): string => `Checked in by ${who} at ${at}.`,
    checkedInAt: (at: string): string => `Checked in at ${at}.`,
    missingSince: (at: string): string => `Missing since ${at}.`,
    notCheckedIn: 'Not checked in yet.',
    takenBack: 'Taken back: this parcel is not counted.',
    conditionBy: (words: string, who: string, at: string): string =>
      `${words}. Recorded by ${who} at ${at}.`,
    note: (note: string): string => `Note: ${note}`,
    close: 'Close',
    damaged: 'Damaged',
    found: 'Found it',
    takeBack: 'Take this parcel back',
    checkInFirst: 'Check this parcel in before you record damage on it.',
  },

  /** The viewer of a vendor's photos, one at a time. */
  viewer: {
    note: 'A photo is read only while this window is open.',
    act: 'Open this parcel',
    lookAt: 'Look at the photos',
  },

  /** "All 12 here": the officer states the number they counted. */
  allHere: {
    title: (count: number, vendor: string): string => `Confirm ${parcels(count)} from ${vendor}?`,
    body: (count: number): string => `I counted ${parcels(count)} from this vendor on the table.`,
    confirm: (count: number): string =>
      count === 1 ? 'Yes, it is here' : `Yes, all ${String(count)} are here`,
  },

  /** Finishing a vendor as tapped: what happens to the parcels that were not tapped. */
  finish: {
    title: (vendor: string): string => `Finish ${vendor}?`,
    untapped: (count: number): string =>
      count === 0
        ? 'Every parcel was tapped, so none will be marked missing.'
        : `${parcels(count)} you did not tap will be marked missing.`,
    extras: 'A parcel that is not on the list was added.',
    decision: 'A senior officer will then decide what happens next.',
    confirm: 'Finish this vendor',
  },

  /** A parcel on the table that is not on the list. */
  extra: {
    title: 'Add a parcel that is not on the list',
    consequence:
      'Take a photo of the parcel. It is counted as an extra, and a senior officer will decide about it.',
    photoLabel: 'Photo of the parcel',
    photoHelp: 'Take a photo with the camera. It is sent as soon as you take it.',
    photoNeeded: 'Take a photo of the parcel.',
    onePhoto: 'One photo of the parcel is enough. Remove the others.',
    noteLabel: 'Note (optional)',
    noteHelp: 'What is it, and who is it from? Leave out phone numbers and email addresses.',
    confirm: 'Add this parcel',
  },

  /** Damage on one parcel, on its own photo. */
  damage: {
    title: (parcel: string): string => `Record damage on ${parcel}?`,
    consequence:
      'Take a photo of the damage and say what you see. Damage is recorded once for each parcel.',
    photoLabel: 'Photo of the damage',
    photoHelp: 'Take a photo with the camera. It is sent as soon as you take it.',
    photoNeeded: 'Take a photo of the damage.',
    noteLabel: 'What is damaged? (optional)',
    noteHelp:
      'A few words, for example a torn corner or a wet box. Leave out phone numbers and email addresses.',
    confirm: 'Record the damage',
  },

  /** The run when every vendor is finished: what came of it, and the next step. */
  summary: {
    title: 'Before the rider leaves',
    lead: 'Check the rider’s bag before they leave.',
    allIn: 'Everything the rider handed over is checked in.',
    missingLead: 'These parcels are not here. Show the rider their photos.',
    missingLabel: (vendor: string): string => `Photos of ${vendor}’s missing parcels`,
    decisionFor: (names: string): string => `A senior officer will decide about ${names}.`,
    vendorLine: (vendor: string, counts: string): string => `${vendor}: ${counts}`,
  },
} as const;
