import { cannotText } from './capability-words';
import type { CopyRule } from './problem-copy';

/**
 * The words of the screens of the door and the failure (S1.30), keyed by operation, context and code like the rest of the table, and proposed for the Product Owner to review with the
 * composed screens. A refusal names the capability in plain words and never a key or a role (PRODUCT_DESIGN_DIRECTION section 6.5); a refusal that declares a `details.rule` is worded by it
 * (`problemOf` reads the rule as the context when the page gave none), and says what to do next, because a refusal shown as a dead end misrepresents the policy. **No wording draws a
 * code, a digest or a phone number, and none names the officer** (the answers carry an identifier and the portal reads no staff directory under these keys).
 */
const NOTE_NEEDED = 'Write a note saying why.';
/** A note the ledger would not keep: the field says what to change, and the words of the note are never repeated. */
const NOTE_REFUSED = 'Check the note marked below: it was not accepted as written.';
const OTHER_HUB_STOP = 'This stop belongs to a hub your account does not work in.';
const STALE_LIST =
  'That page of the list could not be opened: its place in the list was not accepted. Go back to the first page to start again.';

/**
 * The words of a picture that would not load, which no answer of the API says (the browser tells a page that an image failed, and nothing more): they are drawn where a photo is opened
 * (`EvidencePhotoDialog`), on the stop's pages and the receiving side's alike. **The two are told apart on purpose.** A picture that fails after a new link was asked for is a store that
 * did not answer or a connection that is down, and the officer is told to try again; a picture the browser's own policy blocked would fail the same way for ever, and said as a lost link it would
 * send the officer back to a button that cannot help, so it is told as blocked and as the portal's setting (a thing for whoever looks after the portal, and never the photo's or the connection's).
 */
export const PHOTO_UNREACHABLE =
  'The photo could not be shown, even with a new link. Check the connection and open it again in a moment.';
export const PHOTO_BLOCKED =
  'The browser blocked this photo. The portal’s settings do not allow it to show pictures from the photo store, so the photo itself is not at fault. Tell the person who looks after the portal.';

/**
 * What a **tile** of a grid says when its picture cannot be drawn (`PhotoPicture`, Run D, S1.35c-0): short, plain, and the same for every cause, so that a page of sixty tiles does not tell the same sentence sixty
 * times. The one distinction a tile keeps is the one above, because a picture the browser's own policy blocked is not a photo that is gone and is told as blocked; the cause of the rest is told in full where
 * the photo is opened.
 */
export const PHOTO_TILE_UNAVAILABLE = 'Photo not available';
export const PHOTO_TILE_BLOCKED = 'Photo blocked';

/** The four lists share a refusal of a filter or a place that the server would not take, which is a contract that moved and not something the person did. */
const LISTS = [
  [
    'listPickupFailures',
    'The failed pickups could not be loaded.',
    cannotText('pickup.failure.resolve'),
  ],
  [
    'listHandshakesForOps',
    'The handshakes could not be loaded.',
    cannotText('pickup.handshake.override'),
  ],
  [
    'listCollectionShortfalls',
    'The count differences could not be loaded.',
    cannotText('pickup.handshake.override'),
  ],
  [
    'listCollectionDisputes',
    'The collection disputes could not be loaded.',
    cannotText('pickup.read', 'see collection disputes'),
  ],
] as const;

export const PICKUP_WORK_COPY: readonly CopyRule[] = [
  ...LISTS.flatMap(([operation, text, cannot]): CopyRule[] => [
    { operation, text },
    { operation, code: 'PERMISSION_DENIED', text: cannot },
    {
      operation,
      code: 'VALIDATION_FAILED',
      text: 'That filter was not accepted. Choose one of the views of the list.',
    },
    { operation, context: 'cursor', code: 'VALIDATION_FAILED', text: STALE_LIST },
  ]),

  // The photos of a stop.
  { operation: 'listPickupStopEvidence', text: 'The photos of this stop could not be loaded.' },
  // The same read as the check of the exception form (whether the stop was let through already is on its evidence): the form is not shown on a check that failed, and says why in its own words.
  {
    operation: 'listPickupStopEvidence',
    context: 'exception',
    text: 'Whether this stop was let through already could not be checked, so the form is not shown yet.',
  },
  {
    operation: 'listPickupStopEvidence',
    code: 'PERMISSION_DENIED',
    text: cannotText('pickup.read', 'see pickup runs'),
  },
  { operation: 'listPickupStopEvidence', code: 'NOT_FOUND', text: 'This stop could not be found.' },
  { operation: 'listPickupStopEvidence', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB_STOP },
  {
    operation: 'createEvidenceRetrievalAuthorization',
    text: 'This photo could not be opened. Close it and try again.',
  },
  {
    operation: 'createEvidenceRetrievalAuthorization',
    code: 'PERMISSION_DENIED',
    text: cannotText('pickup.read', 'see pickup runs'),
  },
  {
    operation: 'createEvidenceRetrievalAuthorization',
    code: 'EVIDENCE_NOT_STORED',
    text: 'This photo is not stored yet, so it cannot be opened. It appears here once the rider’s upload is complete.',
  },
  {
    operation: 'createEvidenceRetrievalAuthorization',
    code: 'NOT_FOUND',
    text: 'This photo could not be found.',
  },
  {
    operation: 'createEvidenceRetrievalAuthorization',
    code: 'HUB_SCOPE_VIOLATION',
    text: OTHER_HUB_STOP,
  },

  // The override of a handshake, and its resolution by hand.
  ...(['authoriseHandshakeOverride', 'resolveHandshake'] as const).flatMap(
    (operation): CopyRule[] => [
      {
        operation,
        text:
          operation === 'authoriseHandshakeOverride'
            ? 'The handshake was not overridden.'
            : 'The handshake was not resolved.',
      },
      {
        operation,
        code: 'PERMISSION_DENIED',
        // Resolving by hand is a senior officer's to decide (surfaces/ops-portal.md section 7): its refusal says so, and then what the account cannot do.
        text:
          operation === 'authoriseHandshakeOverride'
            ? cannotText('pickup.handshake.override')
            : `A senior officer decides this. ${cannotText('pickup.handshake.resolve')}`,
      },
      { operation, code: 'REASON_REQUIRED', text: NOTE_NEEDED },
      { operation, code: 'VALIDATION_FAILED', text: NOTE_REFUSED },
      { operation, code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB_STOP },
      { operation, code: 'NOT_FOUND', text: 'This stop could not be found.' },
      {
        operation,
        code: 'COLLECTION_NOT_RECORDED',
        text: 'The rider has not recorded a count at this stop yet, so there is no collection to establish. It can be done once the count is recorded.',
      },
      {
        operation,
        context: 'stop_not_arrived',
        code: 'STATE_CONFLICT',
        text: 'The rider has not arrived at this stop, or the stop is already closed, so the handshake cannot be settled now.',
      },
      {
        operation,
        context: 'run_not_in_progress',
        code: 'STATE_CONFLICT',
        text: 'The pickup run is not in progress, so the handshake cannot be settled now.',
      },
      {
        operation,
        context: 'handshake_closed',
        code: 'STATE_CONFLICT',
        text: 'The handshake of this stop has already ended, so there is nothing left to settle.',
      },
      {
        operation,
        context: 'handshake_not_started',
        code: 'STATE_CONFLICT',
        text: 'No code has been asked for at this stop yet, so there is no handshake to resolve by hand. An override can still establish the collection.',
      },
      {
        operation,
        context: 'code_live',
        code: 'STATE_CONFLICT',
        text: 'The code of this handshake has not run out yet: the vendor can still enter it. Resolve it by hand once it has, or override it.',
      },
      {
        operation,
        context: 'handshake_changed',
        code: 'STATE_CONFLICT',
        text: 'The handshake changed since the list was read. The list is read again so that you can see where it stands.',
      },
      {
        operation,
        code: 'STATE_CONFLICT',
        text: 'This handshake changed after you opened it: someone else may have acted on it. Read the list again to see where it stands.',
      },
    ],
  ),

  // Letting a count through without parcel photos.
  {
    operation: 'authoriseParcelPhotoException',
    text: 'The count was not let through without photos.',
  },
  {
    operation: 'authoriseParcelPhotoException',
    code: 'PERMISSION_DENIED',
    text: cannotText('pickup.handshake.override'),
  },
  { operation: 'authoriseParcelPhotoException', code: 'REASON_REQUIRED', text: NOTE_NEEDED },
  { operation: 'authoriseParcelPhotoException', code: 'VALIDATION_FAILED', text: NOTE_REFUSED },
  { operation: 'authoriseParcelPhotoException', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB_STOP },
  {
    operation: 'authoriseParcelPhotoException',
    code: 'NOT_FOUND',
    text: 'This stop could not be found.',
  },
  {
    operation: 'authoriseParcelPhotoException',
    context: 'stop_not_arrived',
    code: 'STATE_CONFLICT',
    text: 'The rider has not arrived at this stop, or the stop is already closed, so its count cannot be let through without photos now.',
  },
  {
    operation: 'authoriseParcelPhotoException',
    context: 'collection_recorded',
    code: 'STATE_CONFLICT',
    text: 'The rider has already recorded the count at this stop, so it can no longer be let through without photos.',
  },
  {
    operation: 'authoriseParcelPhotoException',
    context: 'exception_exists',
    code: 'STATE_CONFLICT',
    text: 'This stop has already been let through without photos. It is on the stop’s page.',
  },
  {
    operation: 'authoriseParcelPhotoException',
    code: 'STATE_CONFLICT',
    text: 'This stop changed after you opened it. Read it again to see where it stands.',
  },
];
