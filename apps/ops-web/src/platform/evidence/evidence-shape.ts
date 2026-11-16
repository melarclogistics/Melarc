import { instantOf, isOneOf, isRecord, uuidOf } from '../staff/staff-shape';

/**
 * What the upload of a file of evidence believes of the two answers it takes (`createEvidence`, `completeEvidenceUpload`), judged before anything is sent anywhere. **The upload instruction is a
 * bearer capability to write one object**: it is read into a value that lives for the length of one upload, never drawn, logged, cached or kept, and an instruction the portal cannot follow as it
 * is (a method other than `PUT`, a form to fill in, an address that is neither an `https` address nor a path of the page's own origin) is refused whole and the file is not sent. The record
 * is told by its identifier and its state and nothing else: the answer carries no object key and the guard has no place for one.
 */
export const EVIDENCE_STATES = ['PENDING_UPLOAD', 'STORED', 'EXPIRED'] as const;
export type EvidenceRecordState = (typeof EVIDENCE_STATES)[number];

const MAX_URL = 4096;
const MAX_HEADERS = 16;
const MAX_HEADER_VALUE = 1024;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

/** The fields each guard reads, held to the contract by `test/hub-intake-contract.test.ts`. */
export const EVIDENCE_FIELDS = {
  Evidence: {
    // The portal reads four members of the record and no more (it is told by its identifier, its owner, its purpose and its state): the rest of what the contract requires goes nowhere.
    required: ['id', 'owner_id', 'purpose', 'state'],
    optional: ['uploaded_at'],
    enums: { state: EVIDENCE_STATES },
  },
  EvidenceUploadInstruction: {
    required: ['method', 'url', 'expires_at'],
    optional: ['headers', 'form_fields'],
    enums: {},
  },
  // `getEvidenceLimits` (OB-S1-110): the platform's limits on a file, read by `evidence-limits.ts`.
  EvidenceLimits: {
    required: ['allowed_content_types', 'max_byte_size'],
    optional: [],
    enums: {},
  },
} as const;

/** What an upload follows: one `PUT` of the file's bytes to the address, with these headers and no others. It is held by the upload only, and is not a value any screen is given. */
export interface UploadInstruction {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expires_at: string;
}

export interface EvidenceTicket {
  readonly evidenceId: string;
  readonly state: EvidenceRecordState;
  readonly upload: UploadInstruction;
}

/** An address the page may send bytes to: an `https` address, or a path of the page's own origin (never a protocol-relative one). */
function addressOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || value.length > MAX_URL) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x20 || unit === 0x7f) return undefined;
  }
  if (value.startsWith('/')) return value.startsWith('//') ? undefined : value;
  return value.startsWith('https://') && URL.canParse(value) ? value : undefined;
}

function headersOf(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_HEADERS) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, text] of entries) {
    if (
      !HEADER_NAME.test(name) ||
      typeof text !== 'string' ||
      text.length > MAX_HEADER_VALUE ||
      /[\r\n]/.test(text)
    ) {
      return undefined;
    }
    headers[name] = text;
  }
  return headers;
}

/** The instruction of a ticket, or nothing when it is one the portal cannot follow as it is. */
function parseUploadInstruction(body: unknown): UploadInstruction | undefined {
  if (!isRecord(body)) return undefined;
  const url = addressOf(body.url);
  const headers = headersOf(body.headers);
  const expires = instantOf(body.expires_at);
  // A form to fill in is another way to upload: the portal follows a `PUT` of the bytes and nothing else.
  if (
    body.method !== 'PUT' ||
    url === undefined ||
    headers === undefined ||
    expires === undefined ||
    (body.form_fields !== undefined && body.form_fields !== null)
  ) {
    return undefined;
  }
  return { url, headers, expires_at: expires };
}

/** The record `createEvidence` made: it must be `PENDING_UPLOAD` and the one asked for (the owner and the purpose are the request's own). */
export function parseEvidenceTicket(
  body: unknown,
  expected: { readonly owner_id: string; readonly purpose: string },
): EvidenceTicket | undefined {
  if (!isRecord(body) || !isRecord(body.evidence)) return undefined;
  const record = body.evidence;
  const id = uuidOf(record.id);
  const owner = uuidOf(record.owner_id);
  const upload = parseUploadInstruction(body.upload);
  if (
    id === undefined ||
    owner === undefined ||
    upload === undefined ||
    record.state !== 'PENDING_UPLOAD' ||
    owner.toLowerCase() !== expected.owner_id.toLowerCase() ||
    record.purpose !== expected.purpose
  ) {
    return undefined;
  }
  return { evidenceId: id, state: 'PENDING_UPLOAD', upload };
}

/**
 * What `createEvidence` answered, in whatever state the record is in. The first answer is a record that waits for its bytes (a ticket). **A retry under the key it already answered is told the same record
 * as it is now** (the contract), so a file whose completion was done while its answer was lost comes back `STORED`: that is the file's success and there is nothing to send. A record that ran out of time
 * comes back `EXPIRED`: its address is of no use and a new record is asked for. Whatever the state, the record is the one declared (its owner and its purpose are the request's own): another's is refused whole.
 */
export type EvidenceDeclarationAnswer =
  | { readonly state: 'PENDING_UPLOAD'; readonly ticket: EvidenceTicket }
  | { readonly state: 'STORED'; readonly evidenceId: string }
  | { readonly state: 'EXPIRED'; readonly evidenceId: string };

export function parseEvidenceDeclaration(
  body: unknown,
  expected: { readonly owner_id: string; readonly purpose: string },
): EvidenceDeclarationAnswer | undefined {
  if (!isRecord(body) || !isRecord(body.evidence)) return undefined;
  const record = body.evidence;
  const id = uuidOf(record.id);
  const owner = uuidOf(record.owner_id);
  if (
    id === undefined ||
    owner?.toLowerCase() !== expected.owner_id.toLowerCase() ||
    record.purpose !== expected.purpose
  ) {
    return undefined;
  }
  // A stored or an expired record needs no instruction: whatever one it still carries is not followed, and not judged.
  if (record.state === 'STORED') return { state: 'STORED', evidenceId: id };
  if (record.state === 'EXPIRED') return { state: 'EXPIRED', evidenceId: id };
  if (record.state !== 'PENDING_UPLOAD') return undefined;
  const ticket = parseEvidenceTicket(body, expected);
  return ticket === undefined ? undefined : { state: 'PENDING_UPLOAD', ticket };
}

/** The record `completeEvidenceUpload` made referenceable: it must be `STORED` and the one completed. */
export function parseStoredEvidence(body: unknown, expectedId: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  if (id?.toLowerCase() !== expectedId.toLowerCase() || !isOneOf(['STORED'], body.state)) {
    return undefined;
  }
  return id;
}
