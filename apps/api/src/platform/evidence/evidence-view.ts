import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { timestampOf } from '../database/timestamps.js';

/**
 * The evidence record as the contract names it (`Evidence`, openapi.yaml), copied from the row member by member so that nothing else the row holds can reach a representation:
 * **`storage_ref` is never in it** (a returned reference would let a client build its own address and walk round `access_rule`), nor the declared checksum, the lifetime
 * granted or the window's end (the upload instruction carries the end).
 */
export interface EvidenceView {
  readonly id: string;
  readonly owner_type: string;
  readonly owner_id: string;
  readonly purpose: string;
  readonly captured_at: string;
  readonly captured_by_actor: string;
  readonly responsible_hub_id: string | null;
  readonly vendor_organization_id: string | null;
  readonly device_context: Record<string, unknown> | null;
  readonly state: string;
  readonly access_rule: string;
  readonly retention_policy: string;
  readonly content_type: string;
  readonly byte_size: number;
  readonly uploaded_at: string | null;
}

/** The row as the services read it: the columns of the representation, and the ones only the services use. */
export interface EvidenceRow {
  readonly id: string;
  readonly owner_type: string;
  readonly owner_id: string;
  readonly purpose: string;
  readonly captured_at: string | Date;
  readonly captured_by_actor: string;
  readonly responsible_hub_id: string | null;
  readonly vendor_organization_id: string | null;
  readonly device_context: Record<string, unknown> | null;
  readonly state: string;
  readonly access_rule: string;
  readonly retention_policy: string;
  readonly content_type: string;
  readonly byte_size: number;
  readonly uploaded_at: string | Date | null;
  readonly version: number;
  readonly storage_ref: string;
  readonly checksum_sha256: string;
  readonly upload_ttl_seconds: number;
  readonly created_at: string | Date;
  readonly upload_expires_at: string | Date;
}

/** The columns of the table, as a statement lists them. */
export const EVIDENCE_COLUMNS = sql.raw(
  `id, owner_type, owner_id, purpose, captured_at, captured_by_actor, responsible_hub_id, vendor_organization_id, device_context, state, access_rule,
   retention_policy, content_type, byte_size, uploaded_at, version, storage_ref, checksum_sha256, upload_ttl_seconds, created_at, upload_expires_at`,
);

const iso = (value: string | Date): string => timestampOf(value).toISOString();

export function evidenceViewOf(row: EvidenceRow): EvidenceView {
  return {
    id: row.id,
    owner_type: row.owner_type,
    owner_id: row.owner_id,
    purpose: row.purpose,
    captured_at: iso(row.captured_at),
    captured_by_actor: row.captured_by_actor,
    responsible_hub_id: row.responsible_hub_id,
    vendor_organization_id: row.vendor_organization_id,
    device_context: row.device_context,
    state: row.state,
    access_rule: row.access_rule,
    retention_policy: row.retention_policy,
    content_type: row.content_type,
    byte_size: row.byte_size,
    uploaded_at: row.uploaded_at === null ? null : iso(row.uploaded_at),
  };
}

const DOMAIN = 'melarc.evidence-etag.v1';

/**
 * The ETag of an evidence record: an **opaque strong validator** of what the answer returned and of the durable version of the row (`version`, which the database moves on every
 * change), so it changes when the record is stored or expires and when anything else about the row changes. `completeEvidenceUpload` takes it as `If-Match` and compares it with
 * the token recomputed from the record under its lock. The digest names no version and no field.
 */
export function evidenceEtagOf(view: EvidenceView, version: number): string {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new RangeError('A record version is a non-negative safe integer');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([DOMAIN, version, view]), 'utf8')
    .digest('base64url');
  return `"${digest}"`;
}
