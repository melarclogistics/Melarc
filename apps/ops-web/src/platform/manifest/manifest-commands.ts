import type { components } from '@melarc/api-client';

import type { ApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import {
  parseHandover,
  parseManifest,
  parseStop,
  type HandoverView,
  type ManifestView,
  type StopView,
} from './manifest-shape';

/**
 * The acts of the manifest screens (S1.25). Each sends one request and answers with what the API answered, judged (`manifest-shape.ts`): a
 * success status with a body that is not the record asked about, or not in the state the act makes, is an answer that is not the API's
 * (`unexpected-response`), which a confirmed command reads as an outcome that is not known, because the act may have been done.
 *
 * The headers are the contract's, operation by operation, and no other (`test/manifest-contract.test.ts` holds this file's account of them to
 * it): the version an act takes (`If-Match`) is the `ETag` of the read, passed exactly as it was kept; an `Idempotency-Key` goes only where the
 * operation declares one (`createPickupManifest`, `setManifestStopOrder`, `cancelPickupManifest`, `skipPickupStop`,
 * `acceptRunCustodyHandover`, `failRunCustodyHandover`). `assignRider`, `dispatchManifest` and `initiateRunCustodyHandover` take a version
 * and no key. No act sends a state, a sequence number it worked out, a count of the hub's or a hub of its own: the server decides, and the
 * only count sent is what a receiver says they took.
 */
export type NewManifest = components['schemas']['PickupManifestCreate'];

/** A manifest with its stops, and the version the next act on it takes: the `ETag` of the answer, exactly as the server sent it. */
export interface ManifestRecord {
  readonly manifest: ManifestView & { readonly stops: readonly StopView[] };
  readonly etag: string;
}

/** A stop and the version the next act on it takes. */
export interface StopRecord {
  readonly stop: StopView;
  readonly etag: string;
}

/** A custody handover and the version the next act on it takes. */
export interface HandoverRecord {
  readonly handover: HandoverView;
  readonly etag: string;
}

/**
 * The manifest a read or an act answered with, if it is the one asked about, with its stops and its version. A record without either cannot be
 * acted on, and another manifest than the one asked about is not the answer.
 */
export function manifestRecordOf(
  data: unknown,
  etag: string | undefined,
  status: number,
  id?: string,
): ManifestRecord {
  const manifest = parseManifest(data, 'required');
  if (
    manifest?.stops === undefined ||
    etag === undefined ||
    (id !== undefined && manifest.id.toLowerCase() !== id.toLowerCase())
  ) {
    throw unexpectedResponse(status);
  }
  return { manifest: { ...manifest, stops: manifest.stops }, etag };
}

/** `createPickupManifest`: a draft of the requests chosen, in the order they are listed, with the reason of each carried over. */
export async function createPickupManifest(
  client: ApiClient,
  body: NewManifest,
  idempotencyKey: string,
): Promise<ManifestRecord> {
  const answer = answerOf(
    await client.POST('/pickup-manifests', {
      params: { header: { 'Idempotency-Key': idempotencyKey } },
      body,
    }),
  );
  const record = manifestRecordOf(answer.data, answer.etag, answer.status);
  // A manifest is made a draft with one stop for each request listed, and nothing else is the answer to making one.
  if (
    record.manifest.state !== 'DRAFT' ||
    record.manifest.stops.length !== body.pickup_request_ids.length
  ) {
    throw unexpectedResponse(answer.status);
  }
  return record;
}

/** `setManifestStopOrder`: the complete sequence of a draft, every stop once. The answer's stops are in the order that was sent. */
export async function setManifestStopOrder(
  client: ApiClient,
  id: string,
  version: string,
  orderedStopIds: readonly string[],
  idempotencyKey: string,
): Promise<ManifestRecord> {
  const answer = answerOf(
    await client.PUT('/pickup-manifests/{id}/stops', {
      params: { path: { id }, header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version } },
      body: { ordered_stop_ids: [...orderedStopIds] },
    }),
  );
  const record = manifestRecordOf(answer.data, answer.etag, answer.status, id);
  const placed = record.manifest.stops.map((stop) => stop.id.toLowerCase());
  if (
    placed.length !== orderedStopIds.length ||
    placed.some((stopId, index) => stopId !== orderedStopIds[index]?.toLowerCase())
  ) {
    throw unexpectedResponse(answer.status);
  }
  return record;
}

/** `assignRider`: the rider named on a draft. The answer names that rider. */
export async function assignRider(
  client: ApiClient,
  id: string,
  version: string,
  riderId: string,
): Promise<ManifestRecord> {
  const answer = answerOf(
    await client.POST('/pickup-manifests/{id}/assign-rider', {
      params: { path: { id }, header: { 'If-Match': version } },
      body: { rider_id: riderId },
    }),
  );
  const record = manifestRecordOf(answer.data, answer.etag, answer.status, id);
  if (record.manifest.assigned_rider_id?.toLowerCase() !== riderId.toLowerCase()) {
    throw unexpectedResponse(answer.status);
  }
  return record;
}

/** `dispatchManifest`: `DRAFT` to `DISPATCHED`. It sends no body, and it does not start the run. */
export async function dispatchManifest(
  client: ApiClient,
  id: string,
  version: string,
): Promise<ManifestRecord> {
  const answer = answerOf(
    await client.POST('/pickup-manifests/{id}/dispatch', {
      params: { path: { id }, header: { 'If-Match': version } },
    }),
  );
  const record = manifestRecordOf(answer.data, answer.etag, answer.status, id);
  if (record.manifest.state !== 'DISPATCHED') throw unexpectedResponse(answer.status);
  return record;
}

/** `cancelPickupManifest`: a draft or a dispatched manifest, with the note the contract makes mandatory. */
export async function cancelPickupManifest(
  client: ApiClient,
  id: string,
  version: string,
  note: string,
  idempotencyKey: string,
): Promise<ManifestRecord> {
  const answer = answerOf(
    await client.POST('/pickup-manifests/{id}/cancel', {
      params: { path: { id }, header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version } },
      body: { note },
    }),
  );
  const record = manifestRecordOf(answer.data, answer.etag, answer.status, id);
  if (record.manifest.state !== 'CANCELLED') throw unexpectedResponse(answer.status);
  return record;
}

/** What a skip takes of the officer: a code of the `PICKUP_STOP_SKIP` catalogue and, where the reason asks for one, a note. */
export interface SkipFields {
  readonly reasonCode: string;
  /** As typed; left out when blank. */
  readonly note?: string;
}

/** `skipPickupStop`: an Ops act on the version of the stop read. The answer is the stop, skipped with the code that was sent. */
export async function skipPickupStop(
  client: ApiClient,
  id: string,
  version: string,
  fields: SkipFields,
  idempotencyKey: string,
): Promise<StopView> {
  const answer = answerOf(
    await client.POST('/pickup-stops/{id}/skip', {
      params: { path: { id }, header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version } },
      body: {
        reason_code: fields.reasonCode,
        ...(fields.note === undefined ? {} : { note: fields.note }),
      },
    }),
  );
  const stop = parseStop(answer.data);
  if (
    stop?.id.toLowerCase() !== id.toLowerCase() ||
    stop.state !== 'SKIPPED' ||
    stop.skipped?.reason_code !== fields.reasonCode
  ) {
    throw unexpectedResponse(answer.status);
  }
  return stop;
}

/** Where custody is to go: to another rider, or to the hub (exactly one, as the schema has it). */
export type HandoverDestination =
  | { readonly riderId: string; readonly hubId?: never }
  | { readonly hubId: string; readonly riderId?: never };

/** `initiateRunCustodyHandover`: opens a handover on a started run. It moves nothing; custody stays where it is until the receiver accepts. */
export async function initiateRunCustodyHandover(
  client: ApiClient,
  manifestId: string,
  version: string,
  destination: HandoverDestination,
  note: string,
): Promise<HandoverRecord> {
  const answer = answerOf(
    await client.POST('/pickup-manifests/{id}/custody-handover', {
      params: { path: { id: manifestId }, header: { 'If-Match': version } },
      body: {
        note,
        ...(destination.riderId === undefined ? {} : { to_rider_id: destination.riderId }),
        ...(destination.hubId === undefined ? {} : { to_hub_id: destination.hubId }),
      },
    }),
  );
  const handover = parseHandover(answer.data);
  const goesWhereAsked =
    destination.riderId === undefined
      ? handover?.to_hub_id?.toLowerCase() === destination.hubId.toLowerCase()
      : handover?.to_rider_id?.toLowerCase() === destination.riderId.toLowerCase();
  if (
    handover?.manifest_id.toLowerCase() !== manifestId.toLowerCase() ||
    handover.state !== 'PENDING' ||
    !goesWhereAsked ||
    answer.etag === undefined
  ) {
    throw unexpectedResponse(answer.status);
  }
  return { handover, etag: answer.etag };
}

/**
 * `acceptRunCustodyHandover`, as Ops where the destination is the hub: the run's one pending handover, with what was taken. **The number is a
 * custody record**: it is sent as that and never as a count the hub is given to match (the contract: the hub's blind count runs independently).
 */
export async function acceptRunCustodyHandover(
  client: ApiClient,
  manifestId: string,
  version: string,
  parcelCountTaken: number,
  idempotencyKey: string,
): Promise<HandoverView> {
  const answer = answerOf(
    await client.POST('/pickup-manifests/{id}/custody-handover/accept', {
      params: {
        path: { id: manifestId },
        header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version },
      },
      body: { parcel_count_taken: parcelCountTaken },
    }),
  );
  const handover = parseHandover(answer.data);
  if (
    handover?.manifest_id.toLowerCase() !== manifestId.toLowerCase() ||
    handover.state !== 'COMPLETED' ||
    handover.parcel_count_taken !== parcelCountTaken
  ) {
    throw unexpectedResponse(answer.status);
  }
  return handover;
}

/** `failRunCustodyHandover`: the run's pending handover did not happen; custody is where it was, and the note says why. */
export async function failRunCustodyHandover(
  client: ApiClient,
  manifestId: string,
  version: string,
  note: string,
  idempotencyKey: string,
): Promise<HandoverView> {
  const answer = answerOf(
    await client.POST('/pickup-manifests/{id}/custody-handover/fail', {
      params: {
        path: { id: manifestId },
        header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version },
      },
      body: { note },
    }),
  );
  const handover = parseHandover(answer.data);
  if (
    handover?.manifest_id.toLowerCase() !== manifestId.toLowerCase() ||
    handover.state !== 'FAILED'
  ) {
    throw unexpectedResponse(answer.status);
  }
  return handover;
}
