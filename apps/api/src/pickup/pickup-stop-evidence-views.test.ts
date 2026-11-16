import { describe, expect, it } from 'vitest';

import { fileContractSource } from '../platform/contract/contract-source.js';
import {
  parcelPhotoExceptionViewOf,
  parcelPhotoProgressViewOf,
  stopEvidenceItemViewOf,
  type ParcelPhotoExceptionRow,
  type StopEvidenceRow,
} from './pickup-stop-evidence-views.js';

/**
 * `listPickupStopEvidence` is a closed projection (S1.30; D-A10, `OB-S1-80`): an item carries the members the contract names and no other, whatever else a record holds (the object
 * key above all, which would let a client build its own retrieval), the progress is the sum the database's counts make and an expired record is never part of what was declared, and
 * the exception is the table's, member for member. The closed list of fields is held to the contract's own, so that a member cannot grow in silently on either side.
 */
const contract = fileContractSource.load() as {
  components: {
    schemas: Record<string, { required: string[]; properties: Record<string, unknown> }>;
  };
};
const members = (value: object): string[] => Object.keys(value).toSorted();

const ID = (n: number): string => `0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e${String(n).padStart(2, '0')}`;

/** What a record holds beside what the item carries: the object key, the checksum, the capturing actor, the device and the owner. None may reach the wire. */
const LEAK = {
  storage_ref: 'ev/0123456789abcdef0123456789abcdef',
  checksum_sha256: 'a'.repeat(64),
  captured_by_actor: ID(9),
  device_context: { model: 'Tecno Spark' },
  owner_type: 'PICKUP_STOP',
  owner_id: ID(8),
  responsible_hub_id: ID(7),
  scanner: 'clamav',
};

const ROW = {
  ...LEAK,
  id: ID(1),
  purpose: 'PARCEL_PHOTO',
  state: 'STORED',
  captured_at: new Date('2026-11-13T10:00:00.000Z'),
  uploaded_at: new Date('2026-11-13T10:00:05.250Z'),
  content_type: 'image/jpeg',
  scanned_clean: true,
  position_text: '2026-11-13 10:00:05.250123+00',
  position_id: ID(1),
} as unknown as StopEvidenceRow;

describe('an item of the evidence of a stop', () => {
  // Break caught: a member the contract does not name reaching the wire (the object key and the checksum above all), a member of the contract that is missing, the position of a
  // page left in an item, or a moment printed in the form the database gave it.
  it('carries the contract’s members and no other, with its moments in one form', () => {
    const item = stopEvidenceItemViewOf(ROW);
    expect(members(item)).toEqual(
      members(contract.components.schemas.StopEvidenceItem?.properties ?? {}),
    );
    expect(members(item)).toEqual([
      'captured_at',
      'content_type',
      'id',
      'purpose',
      'scanned_clean',
      'state',
      'uploaded_at',
    ]);
    expect(item).toEqual({
      id: ID(1),
      purpose: 'PARCEL_PHOTO',
      state: 'STORED',
      captured_at: '2026-11-13T10:00:00.000Z',
      uploaded_at: '2026-11-13T10:00:05.250Z',
      content_type: 'image/jpeg',
      scanned_clean: true,
    });
    const written = JSON.stringify(item);
    for (const secret of ['ev/', 'checksum', 'clamav', 'Tecno', ID(7), ID(8), ID(9), 'position']) {
      expect(written).not.toContain(secret);
    }
  });

  // Break caught: a record that is not stored shown as uploaded, an upload time made up for one that is waiting, or a verdict shown for a file nobody scanned.
  it('shows a record that waits as having no upload time and no verdict', () => {
    const item = stopEvidenceItemViewOf({
      ...ROW,
      state: 'PENDING_UPLOAD',
      uploaded_at: null,
      scanned_clean: false,
    });
    expect(item.uploaded_at).toBeNull();
    expect(item.scanned_clean).toBe(false);
    expect(item.state).toBe('PENDING_UPLOAD');
  });

  it('reads a moment the database printed as text into the same form', () => {
    const item = stopEvidenceItemViewOf({
      ...ROW,
      captured_at: '2026-11-13 10:00:00+00',
      uploaded_at: '2026-11-13 10:00:05.5+00',
    });
    expect(item.captured_at).toBe('2026-11-13T10:00:00.000Z');
    expect(item.uploaded_at).toBe('2026-11-13T10:00:05.500Z');
  });
});

describe('the progress of a stop’s parcel photos', () => {
  // Break caught: the declared number counting what expired (a photo that never arrived shown as one that did), left out of the total the officer reads as "12 of 12", or any
  // member of the contract's list missing.
  it('declares what is stored and what waits, and tells an expired record apart', () => {
    const progress = parcelPhotoProgressViewOf({ stored: 9, pending: 3, expired: 2 });
    expect(progress).toEqual({ declared: 12, stored: 9, pending: 3, expired: 2 });
    expect(parcelPhotoProgressViewOf({ stored: 0, pending: 0, expired: 4 }).declared).toBe(0);
    expect(members(progress)).toEqual(
      members(
        (
          contract.components.schemas.StopEvidenceList?.properties.parcel_photos as {
            properties: object;
          }
        ).properties,
      ),
    );
  });
});

describe('the exception that let a stop’s count through without photos', () => {
  const ROW_OF: ParcelPhotoExceptionRow = {
    id: ID(2),
    pickup_stop_id: ID(8),
    authorised_by: ID(5),
    authorised_at: new Date('2026-11-13T09:00:00.000Z'),
    note: 'The camera does not work',
  };

  // Break caught: a member the contract's `ParcelPhotoException` does not name, or the officer's moment printed in the form the database gave it.
  it('is the table’s, member for member, with its moment in one form', () => {
    const view = parcelPhotoExceptionViewOf({ ...ROW_OF, hub: ID(7), extra: 'x' } as never);
    expect(view).toEqual({
      id: ID(2),
      pickup_stop_id: ID(8),
      authorised_by: ID(5),
      authorised_at: '2026-11-13T09:00:00.000Z',
      note: 'The camera does not work',
    });
    expect(members(view)).toEqual(
      members(contract.components.schemas.ParcelPhotoException?.properties ?? {}),
    );
  });
});
