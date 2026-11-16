import { describe, expect, it } from 'vitest';

import { isPermissionKey } from '../routes/access-declaration.js';
import { OWNER_ACTS, ownerActOf, ownerActsOf, ownerKeysOf } from './evidence-owners.js';

describe('the acts of the evidence owners', () => {
  // Break caught: a key that is no key of the catalogue's shape in a row of the registry (the guard would ask for a key no session holds, and every caller would be refused).
  it('name keys of the catalogue’s shape, and a retention category the table lists', () => {
    for (const act of OWNER_ACTS) {
      expect(isPermissionKey(act.write.key), act.write.key).toBe(true);
      expect(isPermissionKey(act.read.key), act.read.key).toBe(true);
    }
  });

  // Break caught: the keys the guard asks of a session (before the body is read) drifting from the registry the use case decides by: a key of an act missing from the list is a caller refused
  // for an act it may do, and a key that is no act's is a caller let through to a refusal of the use case.
  it('state, for each side, the keys of every act by kind of principal, each once', () => {
    expect(ownerKeysOf('write')).toEqual({
      RIDER: ['pickup.failure.report', 'pickup.collection.confirm'],
      STAFF: ['hub.intake.count', 'hub.osd.adjudicate'],
    });
    expect(ownerKeysOf('read')).toEqual({ STAFF: ['pickup.read', 'hub.read'] });
    expect(Object.isFrozen(ownerKeysOf('write'))).toBe(true);
  });

  // Break caught: the two acts of an intake's evidence told apart by something other than the purpose (the receiver's photos of a condition declared under Senior Ops's key, or the reverse).
  it('pair each purpose of an intake with its own key', () => {
    expect(ownerActOf('PICKUP_INTAKE', 'CONDITION')?.write).toEqual({
      principal: 'STAFF',
      key: 'hub.intake.count',
    });
    expect(ownerActOf('PICKUP_INTAKE', 'OSD')?.write).toEqual({
      principal: 'STAFF',
      key: 'hub.osd.adjudicate',
    });
    expect(ownerActOf('PICKUP_INTAKE', 'CONDITION')?.read).toEqual({
      principal: 'STAFF',
      key: 'hub.read',
    });
    expect(ownerActOf('PICKUP_INTAKE', 'CONDITION')?.retentionPolicy).toBe(
      'PICKUP_INTAKE_EVIDENCE',
    );
    // An owner with no act is none, never defaulted.
    expect(ownerActOf('ORDER', 'DELIVERY_PROOF')).toBeUndefined();
  });

  // Break caught: the photo of an extra parcel declared only under the adjudication's key (a receiver could then never add an extra with a photo), the second act the purpose has made the first one's answer, or an act for
  // another intake than a photo intake's: the intake's OSD purpose has the adjudication's evidence first and the extra's photo second, which is for a photo intake alone.
  it('give the intake’s OSD purpose two acts, the second the photo of an extra parcel for a photo intake alone', () => {
    expect(ownerActsOf('PICKUP_INTAKE', 'OSD').map((act) => [act.write.key, act.photoIntakeOnly === true])).toEqual([
      ['hub.osd.adjudicate', false],
      ['hub.intake.count', true],
    ]);
    expect(ownerActsOf('PICKUP_INTAKE', 'CONDITION')).toHaveLength(1);
    // A purpose the owner has no act for is answered by the owner's first act alone, so that the caller's permission is still asked of first.
    expect(ownerActsOf('PICKUP_INTAKE', 'COLLECTION_PROOF').map((act) => act.write.key)).toEqual(['hub.intake.count']);
    expect(ownerActsOf('ORDER', 'DELIVERY_PROOF')).toEqual([]);
    // The first act of a purpose is still the one `ownerActOf` answers.
    expect(ownerActOf('PICKUP_INTAKE', 'OSD')?.write.key).toBe('hub.osd.adjudicate');
  });
});
