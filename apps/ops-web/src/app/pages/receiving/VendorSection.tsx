import { useEffect, useRef, useState } from 'react';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import type { ParcelView, VendorView } from '../../../platform/hub-receiving/receiving-shape';
import type { LockStatus } from '../../../platform/hub-receiving/use-receiving-locks';
import type { Problem } from '../../../platform/problem/problem-copy';
import { LOCK_WORDS, RECEIVING_WORDS as WORDS } from '../../../platform/problem/receiving-copy';
import { formatClock } from '../../../platform/time/format-time';
import { countPath } from '../intakes/intake-presentation';
import { ParcelDialog } from './ParcelDialog';
import { ParcelGrid } from './ParcelGrid';
import { ParcelViewer } from './ParcelViewer';
import { countsText, photographedText, VENDOR_STATE_MAP } from './receiving-presentation';
import type { RunActs } from './use-run-acts';
import {
  AllHereDialog,
  DamageDialog,
  ExtraParcelDialog,
  FinishVendorDialog,
} from './VendorDialogs';
import './receiving-pages.css';

/** The heading of a vendor's section: its element is what the page moves focus to when it sends the officer to the next vendor. */
export const vendorHeadingId = (vendor: Pick<VendorView, 'intake_id'>): string =>
  `vendor-${vendor.intake_id}`;

export interface VendorSectionProps {
  readonly vendor: VendorView;
  /** The officer holds the key that checks parcels in: without it the section shows the vendor and offers no act. */
  readonly mayCount: boolean;
  readonly acts: RunActs;
  /** The vendor to check in after this one, or nothing when none waits. */
  readonly next: VendorView | undefined;
  /** What the page says of the last act done on this vendor, and the way to send the officer on. */
  readonly notice: string | undefined;
  readonly onNotice: (text: string) => void;
  readonly onGoTo: (vendor: VendorView) => void;
  /** Reads the run again: after an act that changes more than a parcel, and when the officer asks to see the vendor as it is now. */
  readonly readAgain: () => unknown;
}

/**
 * The lock, as **one plain line**: who opened this check-in and when, or that the page cannot check right now. The line is the API's read of the vendor (`lock`) unless the page could not confirm its own lock, in which
 * case it says it cannot check, and never says *You* for a lock it could not confirm. A vendor nobody has started on says nothing: there is nothing to know.
 */
function LockLine({
  vendor,
  status,
}: {
  readonly vendor: VendorView;
  readonly status: LockStatus | undefined;
}) {
  if (status === 'cannot-check') return <p className="receiving-lock">{LOCK_WORDS.cannotCheck}</p>;
  const lock = vendor.lock;
  if (lock === null) return null;
  const at = formatClock(lock.opened_at) ?? '';
  return (
    <p className="receiving-lock">
      {lock.held_by_you ? LOCK_WORDS.openedByYou(at) : LOCK_WORDS.opened(lock.holder_name, at)}
    </p>
  );
}

/** What was done on the vendor, said where the officer is looking, with the way on: focus comes to it, so that a keyboard or a screen reader is told what happened and what is next. */
function Notice({
  text,
  next,
  onGoTo,
}: {
  readonly text: string | undefined;
  readonly next: VendorView | undefined;
  readonly onGoTo: (vendor: VendorView) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (text !== undefined) box.current?.focus();
  }, [text]);
  if (text === undefined) return null;
  return (
    <div className="receiving-notice" ref={box} tabIndex={-1}>
      <Alert
        variant="success"
        announce
        {...(next === undefined
          ? {}
          : {
              action: (
                <Button
                  type="button"
                  size="lg"
                  variant="secondary"
                  onClick={() => {
                    onGoTo(next);
                  }}
                >
                  {WORDS.run.goTo(next.vendor_name)}
                </Button>
              ),
            })}
      >
        <p>{text}</p>
        {next === undefined ? null : <p>{WORDS.run.next(next.vendor_name)}</p>}
      </Alert>
    </div>
  );
}

/** A vendor whose parcels are counted and not checked in (Ops excused the door photos): one line says how, and the count is typed before the rider's number is shown. Nothing of that number is here. */
function BlindVendor({
  vendor,
  mayCount,
}: {
  readonly vendor: VendorView;
  readonly mayCount: boolean;
}) {
  if (vendor.state === 'AWAITING_COUNT') {
    return (
      <>
        <p>{WORDS.vendor.blind.explain}</p>
        {mayCount ? (
          <div className="receiving-actions">
            <ButtonLink to={countPath(vendor.intake_id)} size="lg">
              {WORDS.vendor.blind.countButton}
            </ButtonLink>
          </div>
        ) : null}
      </>
    );
  }
  return (
    <>
      {vendor.received_count === null ? null : (
        <p>{WORDS.vendor.blind.counted(vendor.received_count)}</p>
      )}
      {vendor.count_variance === null ? null : (
        <p>{WORDS.vendor.blind.variance[vendor.count_variance]}</p>
      )}
      <p>{WORDS.vendor.standing[vendor.state]}</p>
    </>
  );
}

/**
 * A vendor with door photos: the photos as a grid and the acts of checking it in (D-D1, D-D2). **Two ways, chosen by the officer**: *All N here* (one confirmation: "I counted N parcels on the table") when the
 * pile matches the photos, and *The count is different*, where each tile is a toggle that checks a parcel in or takes it back and the vendor is finished as tapped (a parcel not tapped is marked missing). A
 * vendor that is already being tapped (a parcel is checked in) stays in that way when the page is opened again. A parcel opens on its own (its photo, its state and the acts that can still be made on it), and a
 * finished vendor says where it stands and what is left for a senior officer.
 */
function PhotoVendor({
  vendor,
  mayCount,
  acts,
  onNotice,
  readAgain,
}: Pick<VendorSectionProps, 'vendor' | 'mayCount' | 'acts' | 'onNotice' | 'readAgain'>) {
  const [chosen, setChosen] = useState(false);
  const [dialog, setDialog] = useState<'all' | 'finish' | 'extra' | undefined>(undefined);
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  /** The photo looked at in the viewer, by the parcel it is of: pressing a tile outside a check-in opens it, and so does *Look at the photos*. */
  const [viewId, setViewId] = useState<string | undefined>(undefined);
  const [damagedId, setDamagedId] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  /** The parcels whose tap is on its way: a second press on one is ignored (a disabled tile would lose the focus). */
  const sending = useRef(new Set<string>());

  const waiting = vendor.state === 'AWAITING_COUNT';
  const expected = vendor.parcels_expected ?? 0;
  const hasExtras = vendor.extra_count > 0;
  const tapping =
    waiting && mayCount && (chosen || vendor.parcels.some((parcel) => parcel.state !== 'EXPECTED'));
  const opened =
    openId === undefined ? undefined : vendor.parcels.find((parcel) => parcel.id === openId);
  const damaged =
    damagedId === undefined ? undefined : vendor.parcels.find((parcel) => parcel.id === damagedId);
  // A parcel that is not on the list can be added while the vendor is open and while its case is open (not once it is decided, and not once the orders are being listed).
  const mayAddExtra = mayCount && (waiting || vendor.state === 'RECONCILIATION_REQUIRED');
  const gridLabel = WORDS.vendor.gridLabel(vendor.vendor_name);

  async function press(parcel: ParcelView): Promise<void> {
    // An extra is never toggled by a press: taking it back is a decision of its own, made in its dialog, which the viewer leads to.
    if (!tapping || parcel.origin === 'HUB_EXTRA') {
      setViewId(parcel.id);
      return;
    }
    if (sending.current.has(parcel.id)) return;
    sending.current.add(parcel.id);
    // Once the officer taps they are checking parcels in, and stay in that way even if they take back the only parcel they tapped.
    setChosen(true);
    setProblem(undefined);
    const result = await acts.tap(vendor.intake_id, parcel.id, parcel.state !== 'ARRIVED');
    sending.current.delete(parcel.id);
    if (result.problem !== undefined) setProblem(result.problem);
  }

  return (
    <>
      {waiting ? (
        <>
          <p>
            {tapping
              ? WORDS.vendor.tappingHint
              : expected === 0
                ? WORDS.vendor.noPhotosHint
                : WORDS.vendor.overviewHint(expected)}
          </p>
          {tapping ? (
            <p className="receiving-tally" role="status">
              {WORDS.vendor.tally(vendor.arrived_count ?? 0, expected, vendor.extra_count)}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p>{WORDS.vendor.standing[vendor.state]}</p>
          <p>{countsText(vendor)}</p>
          {mayCount && vendor.state === 'RECONCILIATION_REQUIRED' && vendor.missing_count > 0 ? (
            <p>{WORDS.vendor.findHint}</p>
          ) : null}
        </>
      )}
      {problem === undefined ? null : (
        <Alert variant="danger" announce>
          <p>{problem.message}</p>
        </Alert>
      )}
      <ParcelGrid
        label={gridLabel}
        parcels={vendor.parcels}
        tapping={tapping}
        onPress={(parcel) => {
          void press(parcel);
        }}
      />
      {tapping && vendor.parcels.length > 0 ? (
        <div className="receiving-actions">
          <Button
            type="button"
            size="lg"
            variant="secondary"
            onClick={() => {
              setViewId(vendor.parcels[0]?.id);
            }}
          >
            {WORDS.viewer.lookAt}
          </Button>
        </div>
      ) : null}
      {mayAddExtra ? (
        <div className="receiving-actions">
          {waiting && tapping ? (
            <Button
              type="button"
              size="lg"
              onClick={() => {
                setDialog('finish');
              }}
            >
              {WORDS.vendor.finish}
            </Button>
          ) : null}
          {waiting && !hasExtras && expected > 0 ? (
            <Button
              type="button"
              size="lg"
              variant={tapping ? 'secondary' : 'primary'}
              onClick={() => {
                setDialog('all');
              }}
            >
              {WORDS.vendor.allHere(expected)}
            </Button>
          ) : null}
          {waiting && !tapping ? (
            <Button
              type="button"
              size="lg"
              variant="secondary"
              onClick={() => {
                setChosen(true);
              }}
            >
              {WORDS.vendor.countDifferent}
            </Button>
          ) : null}
          <Button
            type="button"
            size="lg"
            variant="secondary"
            onClick={() => {
              setDialog('extra');
            }}
          >
            {WORDS.vendor.addExtra}
          </Button>
        </div>
      ) : null}

      {dialog === 'all' ? (
        <AllHereDialog
          ensureLock={acts.ensureLock}
          vendor={vendor}
          onCancel={() => {
            setDialog(undefined);
          }}
          onDone={() => {
            setDialog(undefined);
            onNotice(WORDS.vendor.done.finished(vendor.vendor_name));
            void readAgain();
          }}
          onReload={readAgain}
        />
      ) : null}
      {dialog === 'finish' ? (
        <FinishVendorDialog
          ensureLock={acts.ensureLock}
          vendor={vendor}
          onCancel={() => {
            setDialog(undefined);
          }}
          onDone={() => {
            setDialog(undefined);
            onNotice(WORDS.vendor.done.finished(vendor.vendor_name));
            void readAgain();
          }}
          onReload={readAgain}
        />
      ) : null}
      {dialog === 'extra' ? (
        <ExtraParcelDialog
          ensureLock={acts.ensureLock}
          vendor={vendor}
          onCancel={() => {
            setDialog(undefined);
          }}
          onDone={(answer) => {
            setDialog(undefined);
            void acts.takeAnswer(vendor.intake_id, answer);
            onNotice(WORDS.vendor.done.extraAdded);
          }}
          onReload={readAgain}
        />
      ) : null}
      {damaged === undefined ? null : (
        <DamageDialog
          ensureLock={acts.ensureLock}
          vendor={vendor}
          parcel={damaged}
          onCancel={() => {
            setDamagedId(undefined);
          }}
          onDone={() => {
            setDamagedId(undefined);
            onNotice(
              WORDS.vendor.done.damageRecorded(
                WORDS.parcel.label(damaged.ordinal, damaged.origin === 'HUB_EXTRA'),
              ),
            );
            void readAgain();
          }}
          onReload={readAgain}
        />
      )}
      {viewId === undefined ? null : (
        <ParcelViewer
          parcels={vendor.parcels}
          startId={viewId}
          onClose={() => {
            setViewId(undefined);
          }}
          {...(mayCount
            ? {
                onAct: (parcel: ParcelView) => {
                  setViewId(undefined);
                  setOpenId(parcel.id);
                },
              }
            : {})}
        />
      )}
      {opened === undefined ? null : (
        <ParcelDialog
          parcel={opened}
          vendor={vendor}
          mayCount={mayCount}
          acts={acts}
          onClose={() => {
            setOpenId(undefined);
          }}
          onDamaged={(parcel) => {
            setOpenId(undefined);
            setDamagedId(parcel.id);
          }}
          onDone={(text) => {
            setOpenId(undefined);
            onNotice(text);
          }}
        />
      )}
    </>
  );
}

/**
 * One vendor's section of the run's page (D-D2): its name and where it stands, what the door photographed, the lock as one line, what was just done and what comes next, and the way of checking it in by its
 * mode. A vendor is a section with its own heading, so that the page is read, and moved through, a vendor at a time.
 */
export function VendorSection({
  vendor,
  mayCount,
  acts,
  next,
  notice,
  onNotice,
  onGoTo,
  readAgain,
}: VendorSectionProps) {
  const headingId = vendorHeadingId(vendor);
  return (
    <section className="receiving-vendor" aria-labelledby={headingId}>
      <div className="receiving-vendor__head">
        <h2 id={headingId} tabIndex={-1}>
          {vendor.vendor_name}
        </h2>
        <StatusBadge status={vendor.state} map={VENDOR_STATE_MAP} />
      </div>
      <p>{photographedText(vendor)}</p>
      <LockLine vendor={vendor} status={acts.lockStatus(vendor.intake_id)} />
      <Notice text={notice} next={next} onGoTo={onGoTo} />
      {vendor.receiving_mode === 'BLIND_COUNT' ? (
        <BlindVendor vendor={vendor} mayCount={mayCount} />
      ) : (
        <PhotoVendor
          vendor={vendor}
          mayCount={mayCount}
          acts={acts}
          onNotice={onNotice}
          readAgain={readAgain}
        />
      )}
    </section>
  );
}
