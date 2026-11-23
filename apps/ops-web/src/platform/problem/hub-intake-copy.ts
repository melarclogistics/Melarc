import { cannotText } from './capability-words';
import type { CopyRule } from './problem-copy';
import { SENIOR_DECIDES } from './receiving-copy';

/**
 * What is left of the first words of the receiving screens (S1.35) after Run D reworked them in the voice of the floor: **the steps of a photo** (its declaration, its
 * confirmation once the file is in the store, and its opening), which every receiving screen shares. The words of the record, the count, the damage and the decision of a vendor are in
 * `receiving-copy.ts`, in the one voice: *run, vendor, parcels, check in, missing, decide*. A refusal here names the capability in plain words and never a key or a role (PRODUCT_DESIGN_DIRECTION
 * section 6.5), and says what to do next, because a refusal shown as a dead end misrepresents the policy.
 */
export const HUB_INTAKE_COPY: readonly CopyRule[] = [
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
  // upload says which use it is (`use: 'decision'`). It is told as the decision is: a senior officer decides, and the way out is to ask one.
  {
    operation: 'createEvidence',
    context: 'decision',
    code: 'PERMISSION_DENIED',
    text: SENIOR_DECIDES,
  },
  // A photo an order cites (a high-value parcel's, a carrier's waybill) is made under the key that makes orders.
  {
    operation: 'createEvidence',
    context: 'itemize',
    code: 'PERMISSION_DENIED',
    text: cannotText('hub.intake.itemize'),
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
