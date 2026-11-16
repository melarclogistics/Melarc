import { useApiClient } from '../../../platform/api/api-client';
import {
  finishCheckIn,
  type CheckInWithVersion,
  type FinishChoice,
} from '../../../platform/hub-receiving/receiving-commands';
import type { VendorView } from '../../../platform/hub-receiving/receiving-shape';
import { RECEIVING_WORDS as WORDS } from '../../../platform/problem/receiving-copy';
import { ActDialog } from '../manifests/ManifestActDialogs';
import { ParcelGrid } from './ParcelGrid';
import './receiving-pages.css';

/**
 * What finishing a vendor sends: the way it is finished and the version of the vendor the officer saw (`If-Match`, the vendor's `intake_etag`), held together so that a retry after a lost answer is the same
 * request under the same key.
 */
interface FinishCommand {
  readonly version: string;
  readonly finish: FinishChoice;
}

export interface FinishDialogProps {
  readonly vendor: VendorView;
  readonly onCancel: () => void;
  readonly onDone: (result: CheckInWithVersion) => void;
  /** The officer asks to see the vendor as it is now (after a conflict, or to find out whether an unknown outcome was done). */
  readonly onReload: () => unknown;
}

/**
 * "All N here" (D-D2): the officer says that they counted the vendor's pile on the table and that it has every parcel the door photos show. **The number is a statement, never a default**: the question and the
 * button say it, and the photos are beside it to count against. What is sent is `{ all_arrived: true, confirmed_count: N }` with N the number the officer was shown and confirmed; the API refuses it when the
 * number of photos changed since (`count_changed`), and the dialog is then drawn with the new number, so that it is confirmed again by someone who has seen it. Confirmed, every parcel not yet checked in is.
 */
export function AllHereDialog({ vendor, onCancel, onDone, onReload }: FinishDialogProps) {
  const client = useApiClient();
  const count = vendor.parcels_expected ?? 0;
  return (
    <ActDialog<FinishCommand, CheckInWithVersion>
      open
      title={WORDS.allHere.title(count, vendor.vendor_name)}
      consequence={<p>{WORDS.allHere.body(count)}</p>}
      confirmLabel={WORDS.allHere.confirm(count)}
      confirmVariant="primary"
      size="lg"
      operation="finishCheckIn"
      retryable
      build={() => ({
        version: vendor.intake_etag,
        finish: { allArrived: true, confirmedCount: count },
      })}
      send={(command, key) =>
        finishCheckIn(client, vendor.intake_id, command.finish, command.version, key)
      }
      onDone={onDone}
      onCancel={onCancel}
      onReload={onReload}
    >
      <ParcelGrid label={WORDS.vendor.gridLabel(vendor.vendor_name)} parcels={vendor.parcels} />
    </ActDialog>
  );
}

/**
 * "Finish this vendor" after the officer checked parcels in one by one (D-D2): the parcels they did not tap are marked missing, and the dialog says how many and, when a parcel that is not on the list was added
 * or a parcel is missing, that a senior officer decides next. What is sent is `{ all_arrived: false }` and nothing else. The number of parcels not tapped is counted from the parcels the page holds, to say
 * what is about to happen; what the API records is the API's.
 */
export function FinishVendorDialog({ vendor, onCancel, onDone, onReload }: FinishDialogProps) {
  const client = useApiClient();
  const untapped = vendor.parcels.filter((parcel) => parcel.state === 'EXPECTED').length;
  const hasExtras = vendor.extra_count > 0;
  return (
    <ActDialog<FinishCommand, CheckInWithVersion>
      open
      title={WORDS.finish.title(vendor.vendor_name)}
      consequence={
        <>
          <p>{WORDS.finish.untapped(untapped)}</p>
          {hasExtras ? <p>{WORDS.finish.extras}</p> : null}
          {untapped > 0 || hasExtras ? <p>{WORDS.finish.decision}</p> : null}
        </>
      }
      confirmLabel={WORDS.finish.confirm}
      confirmVariant="primary"
      size="lg"
      operation="finishCheckIn"
      retryable
      build={() => ({ version: vendor.intake_etag, finish: { allArrived: false } })}
      send={(command, key) =>
        finishCheckIn(client, vendor.intake_id, command.finish, command.version, key)
      }
      onDone={onDone}
      onCancel={onCancel}
      onReload={onReload}
    />
  );
}
