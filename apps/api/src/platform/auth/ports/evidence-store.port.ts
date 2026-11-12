import type { PortDescriptor } from './port-descriptor.js';

/**
 * The object store the evidence records point at (S1.11; SECURITY_DESIGN.md sections 14.10 and 14.18; the owner's decision of 29 October 2026: Cloudflare R2 behind this port, with an
 * in-process stand-in for development and CI). The platform never serves a byte of an object: it makes **a short-lived capability for one object** and the client (a rider's
 * handset, an officer's browser) redeems it against the store directly. Private means authorization-private, not network-unreachable: the store has no anonymous read or write, no
 * listing and no permanent address, and a signed address grants exactly one operation on exactly one object until it expires.
 *
 * - **The key is the platform's** and carries no personal data (`ev/` and 32 hex digits). The port never sees a name, a number or an address.
 * - **Time is given, never read**: the instant a capability is made is the caller's (the database's clock), so that a capability made again for a retry is identical to the first.
 * - **A capability is a bearer credential**: it is returned to the caller for the one answer that carries it, and is never logged, counted, put in an event or kept (the stand-in
 *   and the R2 adapter keep none and log none).
 * - **What arrived is judged by the platform, not by the client's word**: `inspect` reads what the store holds at a key (its size, its checksum and the first bytes), and the platform
 *   compares those with what was declared and with the signature of the declared type before a record is `STORED`.
 */
export interface UploadCapabilityRequest {
  /** The object's key, as the platform made it. */
  readonly key: string;
  /** The declared type; the upload must send it as its `Content-Type`. */
  readonly contentType: string;
  /** The declared size in bytes; the upload must send exactly this many. */
  readonly byteSize: number;
  /** The declared SHA-256 of the object, 64 lower-case hex digits; the store refuses an upload whose bytes hash otherwise. */
  readonly checksumSha256: string;
  /** The instant the capability is made at, and the seconds it lives from it. */
  readonly issuedAt: Date;
  readonly ttlSeconds: number;
}

export interface RetrievalCapabilityRequest {
  readonly key: string;
  readonly issuedAt: Date;
  readonly ttlSeconds: number;
}

/** What a client does with a capability: the method, the (opaque) address, and the non-secret headers it must send. */
export interface ObjectCapability {
  readonly method: 'PUT' | 'GET';
  /** A bearer capability: never logged, never kept, never in an audit payload. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

/** What the store holds at a key. */
export interface StoredObjectFacts {
  readonly byteSize: number;
  /** SHA-256 of the object as the store recorded it at upload, 64 lower-case hex digits; absent where the store did not record one. */
  readonly checksumSha256: string | undefined;
  /** The type the object was sent with. */
  readonly contentType: string | undefined;
  /** The first bytes of the object, up to the number asked for. */
  readonly head: Uint8Array;
}

export interface EvidenceStore {
  /** The capability to upload one object. Pure computation: no I/O. */
  presignUpload(request: UploadCapabilityRequest): ObjectCapability;
  /** The capability to read one object. Pure computation: no I/O. */
  presignRetrieval(request: RetrievalCapabilityRequest): ObjectCapability;
  /** What arrived at the key, or nothing when nothing did. Calls the store: never inside a transaction. */
  inspect(key: string, headBytes: number): Promise<StoredObjectFacts | undefined>;
}

export const EVIDENCE_STORE = Symbol('EVIDENCE_STORE');

export const EVIDENCE_STORE_DESCRIPTOR: PortDescriptor<EvidenceStore> = {
  port: 'EvidenceStore',
  owner: { kind: 'platform', area: 'evidence' },
  operations: {
    presignUpload: {
      inputs:
        'the object key, the declared content type, size and SHA-256, the instant to make the capability at and how many seconds it lives',
      outputs:
        'the method, the opaque single-object address, the non-secret headers the client must send, and when it expires',
      outcomes: 'none',
      raises: ['STORE_NOT_CONFIGURED'],
      transaction: 'independent',
    },
    presignRetrieval: {
      inputs: 'the object key, the instant to make the capability at and how many seconds it lives',
      outputs:
        'the method, the opaque single-object address, the non-secret headers and when it expires',
      outcomes: 'none',
      raises: ['STORE_NOT_CONFIGURED'],
      transaction: 'independent',
    },
    inspect: {
      inputs: 'the object key and how many leading bytes to read',
      outputs:
        'the size, the SHA-256 the store recorded, the content type and the leading bytes of what is at the key',
      outcomes: ['OBJECT_ABSENT'],
      raises: ['STORE_UNAVAILABLE', 'STORE_NOT_CONFIGURED'],
      transaction: 'outside-any-transaction',
    },
  },
};
