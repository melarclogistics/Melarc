import { cannotText } from './capability-words';
import type { CopyRule } from './problem-copy';

/**
 * The words of the receiving screens (S1.35), keyed by operation, context and code like the rest of the table, and proposed for the Product Owner to review with the composed screens. A refusal
 * names the capability in plain words and never a key or a role (PRODUCT_DESIGN_DIRECTION section 6.5); a refusal that declares a `details.rule` is worded by it (`problemOf` reads the rule as the
 * context when the page gave none), and says what to do next, because a refusal shown as a dead end misrepresents the policy. **Two conflicts are told at length because the lock is advisory** (surfaces/ops-portal.md
 * section 9): the receiver who counted second is told that the other receiver counted first, what that means for their count and where to look, and never given a bare failure. **No wording draws the
 * rider's declared number, and none names an officer** (the answers carry an identifier and the portal reads no staff directory).
 */
const OTHER_HUB_INTAKE = 'This intake belongs to a hub your account does not work in.';
const INTAKE_NOT_FOUND = 'This intake could not be found.';
const STALE_LIST =
  'That page of the list could not be opened: its place in the list was not accepted. Go back to the first page to start again.';
const NOTE_REFUSED = 'Check the note marked below: it was not accepted as written.';

export const HUB_INTAKE_COPY: readonly CopyRule[] = [
  // The queue and the record.
  { operation: 'listHubIntakes', text: 'The intakes could not be loaded.' },
  { operation: 'listHubIntakes', code: 'PERMISSION_DENIED', text: cannotText('hub.read') },
  {
    operation: 'listHubIntakes',
    code: 'VALIDATION_FAILED',
    text: 'That filter was not accepted. Choose one of the views of the list.',
  },
  { operation: 'listHubIntakes', context: 'cursor', code: 'VALIDATION_FAILED', text: STALE_LIST },
  { operation: 'getHubIntake', text: 'This intake could not be loaded.' },
  { operation: 'getHubIntake', code: 'PERMISSION_DENIED', text: cannotText('hub.read') },
  { operation: 'getHubIntake', code: 'NOT_FOUND', text: INTAKE_NOT_FOUND },
  { operation: 'getHubIntake', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB_INTAKE },

  // The advisory lock: it is kept by the page, and a failure of it stops nobody from counting.
  {
    operation: 'acquireIntakeLock',
    text: 'The page could not tell whether another receiver is counting this intake. You can still count it: if another receiver counts first, only their count is kept.',
  },
  {
    operation: 'acquireIntakeLock',
    code: 'PERMISSION_DENIED',
    text: cannotText('hub.intake.count'),
  },
  { operation: 'acquireIntakeLock', code: 'NOT_FOUND', text: INTAKE_NOT_FOUND },
  { operation: 'acquireIntakeLock', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB_INTAKE },

  // The blind count.
  { operation: 'submitBlindCount', text: 'The count was not recorded. You can try again.' },
  {
    operation: 'submitBlindCount',
    code: 'PERMISSION_DENIED',
    text: cannotText('hub.intake.count'),
  },
  {
    operation: 'submitBlindCount',
    code: 'VALIDATION_FAILED',
    text: 'That count was not accepted. Enter the number of parcels you counted, as a whole number from 0.',
  },
  { operation: 'submitBlindCount', code: 'NOT_FOUND', text: INTAKE_NOT_FOUND },
  { operation: 'submitBlindCount', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB_INTAKE },
  {
    operation: 'submitBlindCount',
    context: 'already_counted',
    code: 'STATE_CONFLICT',
    text: 'Another receiver counted this intake first, so your count was not kept and nothing was changed. The count that was recorded is on the intake: open it to see it. A lock only shows who is working; it never stops a second count, and the first one is kept.',
  },
  {
    operation: 'submitBlindCount',
    context: 'stale',
    code: 'STATE_CONFLICT',
    text: 'This intake changed after you opened it, so your count was not recorded. Reload it to see where it stands, then count again if it is still waiting.',
  },
  {
    operation: 'submitBlindCount',
    code: 'STATE_CONFLICT',
    text: 'This intake is no longer as you saw it, so your count was not recorded. Reload it to see where it stands.',
  },

  // The condition.
  {
    operation: 'recordIntakeCondition',
    text: 'The condition was not recorded. You can try again.',
  },
  {
    operation: 'recordIntakeCondition',
    code: 'PERMISSION_DENIED',
    text: cannotText('hub.intake.count'),
  },
  {
    operation: 'recordIntakeCondition',
    code: 'REASON_REQUIRED',
    text: 'Damaged and tampered need a photo of what you found. Add at least one photo.',
  },
  {
    operation: 'recordIntakeCondition',
    code: 'EVIDENCE_NOT_STORED',
    text: 'One of the photos is not stored yet, or is not a photo of this intake. Add it again.',
  },
  { operation: 'recordIntakeCondition', code: 'VALIDATION_FAILED', text: NOTE_REFUSED },
  { operation: 'recordIntakeCondition', code: 'NOT_FOUND', text: INTAKE_NOT_FOUND },
  { operation: 'recordIntakeCondition', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB_INTAKE },
  {
    operation: 'recordIntakeCondition',
    context: 'intake_not_counted',
    code: 'STATE_CONFLICT',
    text: 'This intake has not been counted yet. A condition is recorded after the count.',
  },
  {
    operation: 'recordIntakeCondition',
    context: 'itemization_started',
    code: 'STATE_CONFLICT',
    text: 'Itemising this intake has begun, so its condition can no longer be recorded here.',
  },
  {
    operation: 'recordIntakeCondition',
    context: 'condition_already_recorded',
    code: 'STATE_CONFLICT',
    text: 'A condition has already been recorded for this intake. It is recorded once.',
  },
  {
    operation: 'recordIntakeCondition',
    context: 'stale',
    code: 'STATE_CONFLICT',
    text: 'This intake changed after you opened it, so the condition was not recorded. Reload it to see where it stands.',
  },
  {
    operation: 'recordIntakeCondition',
    code: 'STATE_CONFLICT',
    text: 'This intake is no longer as you saw it, so the condition was not recorded. Reload it to see where it stands.',
  },

  // The adjudication: a senior officer's.
  { operation: 'adjudicateDiscrepancy', text: 'The decision was not recorded. You can try again.' },
  {
    operation: 'adjudicateDiscrepancy',
    code: 'PERMISSION_DENIED',
    text: `A senior officer decides this. ${cannotText('hub.osd.adjudicate')}`,
  },
  {
    operation: 'adjudicateDiscrepancy',
    code: 'REASON_REQUIRED',
    text: 'A reason is needed. Write why you decided this, and for damaged or tampered goods add a photo.',
  },
  {
    operation: 'adjudicateDiscrepancy',
    code: 'EVIDENCE_NOT_STORED',
    text: 'One of the photos is not stored yet, or is not a photo of this intake. Add it again.',
  },
  { operation: 'adjudicateDiscrepancy', code: 'VALIDATION_FAILED', text: NOTE_REFUSED },
  { operation: 'adjudicateDiscrepancy', code: 'NOT_FOUND', text: INTAKE_NOT_FOUND },
  { operation: 'adjudicateDiscrepancy', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB_INTAKE },
  {
    operation: 'adjudicateDiscrepancy',
    context: 'not_awaiting_resolution',
    code: 'STATE_CONFLICT',
    text: 'This intake is not waiting for a decision: it may have been resolved already. Reload it to see where it stands.',
  },
  {
    operation: 'adjudicateDiscrepancy',
    context: 'stale',
    code: 'STATE_CONFLICT',
    text: 'This intake changed after you opened it, so the decision was not recorded. Reload it to see where it stands.',
  },
  {
    operation: 'adjudicateDiscrepancy',
    code: 'STATE_CONFLICT',
    text: 'This intake is no longer as you saw it, so the decision was not recorded. Reload it to see where it stands.',
  },

  // A photo of what was found: its declaration, and its confirmation once the file is in the store.
  {
    operation: 'createEvidence',
    text: 'The photo could not be prepared for sending. Take it again.',
  },
  {
    operation: 'createEvidence',
    code: 'PERMISSION_DENIED',
    text: cannotText('hub.intake.count'),
  },
  // A photo made for a senior's decision is refused in the decision's own capability (the platform asks for the key of the act the photo belongs to), never the receiver's: the page that draws the
  // upload says which use it is (`use: 'decision'`).
  {
    operation: 'createEvidence',
    context: 'decision',
    code: 'PERMISSION_DENIED',
    text: cannotText('hub.osd.adjudicate'),
  },
  {
    operation: 'createEvidence',
    code: 'VALIDATION_FAILED',
    text: 'This photo was not accepted: its type or its size is not one the platform takes. Take another.',
  },
  { operation: 'createEvidence', code: 'NOT_FOUND', text: 'This vendor could not be found.' },
  {
    operation: 'createEvidence',
    context: 'intake_not_counted',
    code: 'STATE_CONFLICT',
    text: 'This vendor has not been counted yet, so this photo cannot be added. Count it first.',
  },
  {
    operation: 'createEvidence',
    code: 'STATE_CONFLICT',
    text: 'This vendor is no longer as you saw it, so the photo was not accepted. Refresh the page to see where it stands.',
  },
  {
    operation: 'completeEvidenceUpload',
    text: 'The photo was sent but could not be confirmed. Take it again.',
  },
  {
    operation: 'completeEvidenceUpload',
    code: 'VALIDATION_FAILED',
    text: 'The file in the store is not the photo that was taken. Take it again.',
  },
  {
    operation: 'completeEvidenceUpload',
    code: 'EVIDENCE_UPLOAD_EXPIRED',
    text: 'The time to send this photo ran out. Take it again.',
  },
  {
    operation: 'completeEvidenceUpload',
    code: 'NOT_FOUND',
    text: 'This photo could not be found. Take it again.',
  },
  {
    operation: 'completeEvidenceUpload',
    code: 'STATE_CONFLICT',
    text: 'This photo is not in a state that can be confirmed. Take it again.',
  },

  // The photos of an intake are opened one at a time, under the key that reads the intake (the stop's photos have their own words).
  {
    operation: 'createEvidenceRetrievalAuthorization',
    context: 'intake',
    text: 'This photo could not be opened. Close it and try again.',
  },
  {
    operation: 'createEvidenceRetrievalAuthorization',
    context: 'intake',
    code: 'PERMISSION_DENIED',
    text: cannotText('hub.read'),
  },
  {
    operation: 'createEvidenceRetrievalAuthorization',
    context: 'intake',
    code: 'EVIDENCE_NOT_STORED',
    text: 'This photo is not stored yet, so it cannot be opened.',
  },
  {
    operation: 'createEvidenceRetrievalAuthorization',
    context: 'intake',
    code: 'NOT_FOUND',
    text: 'This photo could not be found.',
  },
  {
    operation: 'createEvidenceRetrievalAuthorization',
    context: 'intake',
    code: 'HUB_SCOPE_VIOLATION',
    text: 'This photo belongs to a hub your account does not work in.',
  },
];

/**
 * The words of the failures of a file's trip that are not the API's: the store that could not be reached or declined the file, **the store the browser's own policy blocked** (told apart from a lost connection:
 * a policy does not allow the bucket, and a retry can never help), a step that ran out of time, an upload address that ran out twice, a file the platform's limits refuse before it is read, and a browser that
 * cannot compute a file's checksum. Drafts for the Product Owner to review; none draws an address, a key or a status.
 */
export const STORE_UNREACHABLE =
  'The photo could not be sent to the store. Check the connection and try again.';
export const STORE_DECLINED =
  'The store declined this photo. Choose it again, or try another file.';
export const STORE_BLOCKED =
  'The browser blocked sending this photo. The portal’s settings do not allow it to send photos to the photo store, so the photo itself is not at fault. Tell the person who looks after the portal.';
export const UPLOAD_TIMED_OUT =
  'Sending the photo took too long, so it was stopped. Check the connection and try again.';
export const UPLOAD_ADDRESS_RAN_OUT = 'The time to send this photo ran out twice. Try again.';
export const FILE_TYPE_NOT_TAKEN =
  'This kind of file is not one the platform takes. Take a photo with the camera, or choose one from the gallery.';
export const CHECKSUM_UNAVAILABLE =
  'This browser cannot check a file before sending it, so the photo was not sent. Open the portal in a current browser.';
export const FILE_EMPTY = 'This file is empty. Choose another.';

/** The words of a file above the platform's limit: the limit in megabytes, with one decimal only where it is not whole (the officer reads "10 MB", never a number of bytes). */
export function fileTooLarge(limitBytes: number): string {
  const megabytes = Number((limitBytes / (1024 * 1024)).toFixed(1));
  return `This photo is larger than the platform takes (up to ${String(megabytes)} MB). Take it again, or choose a smaller one.`;
}
