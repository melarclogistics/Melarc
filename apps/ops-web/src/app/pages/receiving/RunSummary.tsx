import { useEffect, useRef, useState } from 'react';

import { Panel } from '../../../components/ui/panel/Panel';
import type { VendorView } from '../../../platform/hub-receiving/receiving-shape';
import { RECEIVING_WORDS as WORDS } from '../../../platform/problem/receiving-copy';
import { ParcelGrid } from './ParcelGrid';
import { ParcelViewer } from './ParcelViewer';
import { countsText } from './receiving-presentation';
import './receiving-pages.css';

export interface RunSummaryProps {
  readonly vendors: readonly VendorView[];
  /** The summary has just appeared because the last vendor was finished: focus comes to it, so that the next step is the first thing the officer reads. */
  readonly focusOnAppear: boolean;
}

/** The parcels of a vendor that are missing, as photos the rider can be shown: a tile opens the photo in the viewer, among the others that are missing. */
function MissingPhotos({ vendor }: { readonly vendor: VendorView }) {
  const [viewId, setViewId] = useState<string | undefined>(undefined);
  const missing = vendor.parcels.filter((parcel) => parcel.state === 'MISSING');
  if (missing.length === 0) return null;
  return (
    <>
      <p>{WORDS.summary.missingLead}</p>
      <ParcelGrid
        label={WORDS.summary.missingLabel(vendor.vendor_name)}
        parcels={missing}
        onPress={(parcel) => {
          setViewId(parcel.id);
        }}
      />
      {viewId === undefined ? null : (
        <ParcelViewer
          parcels={missing}
          startId={viewId}
          onClose={() => {
            setViewId(undefined);
          }}
        />
      )}
    </>
  );
}

/**
 * The run when every vendor is finished (D-D2): **what came of it, and the next step.** *Check the rider's bag before they leave* leads, because a missing parcel may be in it; each vendor says what it came to
 * (checked in, missing, extra, damaged, which are the API's counts), the pictures of the parcels that are missing are shown **so that the rider can be shown them** (each opens in the viewer), and a vendor
 * that needs a decision says that a senior officer will decide. The page adds nothing up: a count is told for each vendor, as the API gave it.
 */
export function RunSummary({ vendors, focusOnAppear }: RunSummaryProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnAppear) heading.current?.focus();
  }, [focusOnAppear]);
  const clean = vendors.every(
    (vendor) =>
      vendor.missing_count === 0 && vendor.extra_count === 0 && vendor.damaged_count === 0,
  );
  const deciding = vendors.filter((vendor) => vendor.state === 'RECONCILIATION_REQUIRED');
  return (
    <Panel title={WORDS.summary.title} headingLevel={2} region headingRef={heading}>
      <div className="receiving-summary__body">
        <p className="receiving-summary__lead">{WORDS.summary.lead}</p>
        {clean ? <p>{WORDS.summary.allIn}</p> : null}
        <ul className="receiving-summary__vendors">
          {vendors.map((vendor) => (
            <li key={vendor.intake_id}>
              <p>{WORDS.summary.vendorLine(vendor.vendor_name, countsText(vendor))}</p>
              <MissingPhotos vendor={vendor} />
            </li>
          ))}
        </ul>
        {deciding.length === 0 ? null : (
          <p>
            {WORDS.summary.decisionFor(deciding.map((vendor) => vendor.vendor_name).join(', '))}
          </p>
        )}
      </div>
    </Panel>
  );
}
