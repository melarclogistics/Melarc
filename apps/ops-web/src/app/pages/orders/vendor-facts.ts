import type { IntakeState } from '../../../platform/hub-intake/hub-intake-shape';
import type { IntakeRecordView } from '../../../platform/hub-receiving/use-intake-record';
import type { VendorMode } from '../../../platform/hub-receiving/receiving-shape';

/**
 * What the order screens need of a vendor's record, whichever way it was received (a vendor checked in against its door photos, or one counted without photos): its code, its state, its mode, the hub it is
 * at and the version every act on it takes (`If-Match`, exactly as the API sent it). It is read from the record the page already holds, so nothing is asked twice, and it works out nothing.
 */
export interface VendorFacts {
  readonly id: string;
  readonly code: string;
  readonly state: IntakeState;
  readonly mode: VendorMode;
  readonly hubId: string;
  readonly etag: string;
  /** The vendor is cleared for the orders of the parcels that arrived: its check-in is final (or its count is committed and reconciled). */
  readonly cleared: boolean;
  readonly closed: boolean;
  /** What the hub received, where it is known: the parcels that arrived, or the count; null for a vendor not counted yet. */
  readonly received: number | null;
  readonly manifestId: string;
}

const CLEARED: readonly IntakeState[] = ['READY_FOR_ITEMIZATION', 'ITEMIZING'];

export function vendorFactsOf(record: IntakeRecordView): VendorFacts {
  if (record.kind === 'check-in') {
    const view = record.view;
    return {
      id: view.id,
      code: view.code,
      state: view.state,
      mode: 'PHOTO_CHECK_IN',
      hubId: view.hub_id,
      etag: record.etag,
      cleared: CLEARED.includes(view.state),
      closed: view.state === 'CLOSED',
      received: view.arrived_count,
      manifestId: view.pickup_manifest_id,
    };
  }
  const intake = record.intake;
  return {
    id: intake.id,
    code: intake.code,
    state: intake.state,
    mode: 'BLIND_COUNT',
    hubId: intake.hub_id,
    etag: record.etag,
    cleared: CLEARED.includes(intake.state),
    closed: intake.state === 'CLOSED',
    received: intake.count_phase === 'POST_COUNT' ? intake.physical_count : null,
    manifestId: intake.pickup_manifest_id,
  };
}
