import { useState, type ReactNode } from 'react';

import type { ParcelView } from '../../../platform/hub-receiving/receiving-shape';
import { RECEIVING_WORDS as WORDS } from '../../../platform/problem/receiving-copy';
import { IntakePhotos } from '../intakes/IntakePhotos';
import { isFlagged, ParcelGrid } from './ParcelGrid';
import { ParcelViewer } from './ParcelViewer';
import type { FindingLine } from './receiving-presentation';
import './receiving-pages.css';

/** The parcels of a vendor that need someone, by what is wrong with them: the API's state and condition of each, and nothing worked out. A parcel that is both extra and damaged is in both. */
function needsSomeone(parcels: readonly ParcelView[]): readonly {
  readonly id: 'missing' | 'extra' | 'damaged';
  readonly title: string;
  readonly parcels: readonly ParcelView[];
}[] {
  return [
    {
      id: 'missing' as const,
      title: WORDS.record.needsSomeone.missing,
      parcels: parcels.filter((parcel) => parcel.state === 'MISSING'),
    },
    {
      id: 'extra' as const,
      title: WORDS.record.needsSomeone.extra,
      parcels: parcels.filter((parcel) => parcel.origin === 'HUB_EXTRA' && parcel.state !== 'VOID'),
    },
    {
      id: 'damaged' as const,
      title: WORDS.record.needsSomeone.damaged,
      parcels: parcels.filter(isFlagged),
    },
  ].filter((group) => group.parcels.length > 0);
}

/**
 * The parcels of a vendor that are missing, extra or damaged, each group as the photos of its parcels (D-D2): a tile opens the photo among the group's, with where the parcel stands under it. **It acts on
 * nothing**: what is done about a parcel is the check-in's and the senior officer's, on the run's page and the decision's.
 */
export function ParcelsThatNeedSomeone({
  vendorName,
  parcels,
}: {
  readonly vendorName: string;
  readonly parcels: readonly ParcelView[];
}) {
  const [looking, setLooking] = useState<
    { readonly group: string; readonly parcelId: string } | undefined
  >(undefined);
  const groups = needsSomeone(parcels);
  if (groups.length === 0) return <p>{WORDS.record.needsSomeone.none}</p>;
  const open = groups.find((group) => group.id === looking?.group);
  return (
    <>
      {groups.map((group) => (
        <section key={group.id} className="receiving-record__group">
          <h3 className="receiving-record__group-title">{group.title}</h3>
          <ParcelGrid
            label={WORDS.record.needsSomeone.gridLabel(group.title, vendorName)}
            parcels={group.parcels}
            onPress={(parcel) => {
              setLooking({ group: group.id, parcelId: parcel.id });
            }}
          />
        </section>
      ))}
      {open === undefined || looking === undefined ? null : (
        <ParcelViewer
          parcels={open.parcels}
          startId={looking.parcelId}
          onClose={() => {
            setLooking(undefined);
          }}
        />
      )}
    </>
  );
}

/** The door photos of a vendor, all of them, as the grid of its parcels: what the rider photographed, each opened among the others. */
export function DoorPhotos({
  vendorName,
  parcels,
}: {
  readonly vendorName: string;
  readonly parcels: readonly ParcelView[];
}) {
  const [startId, setStartId] = useState<string | undefined>(undefined);
  const door = parcels.filter((parcel) => parcel.origin === 'DOOR_PHOTO');
  if (door.length === 0) return <p>{WORDS.record.photos.none}</p>;
  return (
    <>
      <ParcelGrid
        label={WORDS.record.photos.label(vendorName)}
        parcels={door}
        onPress={(parcel) => {
          setStartId(parcel.id);
        }}
      />
      {startId === undefined ? null : (
        <ParcelViewer
          parcels={door}
          startId={startId}
          onClose={() => {
            setStartId(undefined);
          }}
        />
      )}
    </>
  );
}

/** The photos taken at the door of a vendor that was counted and not checked in, as buttons that each open one photo at a time (the identifiers are the API's, and are never drawn). */
export function CountedDoorPhotos({ ids }: { readonly ids: readonly string[] }): ReactNode {
  if (ids.length === 0) return <p>{WORDS.record.photos.none}</p>;
  return (
    <>
      <p>{WORDS.record.photos.blindNote}</p>
      <IntakePhotos ids={ids} noun={WORDS.record.photos.noun} label={WORDS.record.photos.title} />
    </>
  );
}

/** What was found at receiving, in the order it was made, each with its note, its photos (opened one at a time) and who made it and when. */
export function FindingsList({
  findings,
}: {
  readonly findings: readonly FindingLine[];
}): ReactNode {
  if (findings.length === 0) return <p>{WORDS.record.found.none}</p>;
  return (
    <ol className="receiving-findings" aria-label={WORDS.record.found.list}>
      {findings.map((finding) => (
        <li key={finding.id} className="receiving-finding">
          <p className="receiving-finding__title">{finding.title}</p>
          {finding.facts === undefined ? null : (
            <p className="receiving-finding__facts">{finding.facts}</p>
          )}
          {finding.note === null ? null : <p className="receiving-finding__note">{finding.note}</p>}
          {finding.evidenceIds.length === 0 ? null : (
            <IntakePhotos
              ids={finding.evidenceIds}
              noun={WORDS.record.found.photoNoun}
              label={WORDS.record.found.photos}
            />
          )}
          <p className="receiving-finding__by">{finding.byline}</p>
        </li>
      ))}
    </ol>
  );
}
