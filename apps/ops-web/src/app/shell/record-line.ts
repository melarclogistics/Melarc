import type { StatusPresentation } from '../../components/ui/status-badge/StatusBadge';
import type { IconName } from '../../components/ui/icon/icons';
import type {
  LookupKindName,
  RecordLookupResultView,
} from '../../platform/lookup/record-lookup-shape';
import { MANIFEST_STATE_MAP } from '../pages/manifests/manifest-presentation';
import { PICKUP_STATE_MAP, serviceDateText } from '../pages/pickup/pickup-presentation';
import { RIDER_STATUS_MAP } from '../pages/riders/rider-presentation';
import { STAFF_STATUS_MAP } from '../pages/staff/staff-presentation';
import { VENDOR_STATUS_MAP } from '../pages/vendors/vendor-presentation';

/**
 * The words of the line under a result of the search (the Product Owner's decision D1, 6 November 2026: the server gives facts and the portal
 * writes the line, so that the words on the screen have one owner). Each part is in the portal's own words, taken from the mapping that draws the same
 * state elsewhere in the portal (`StatusBadge`'s), so a state is called the same thing in the palette as on its page:
 *
 * - a **pickup request**: the sender's name, then its state, then the hub and the service date;
 * - a **pickup run**: its state, the hub and the service date;
 * - a vendor account, a rider, a staff profile: its state and its hub;
 * - and, last, **a masked phone only as the server returned it**, on a record that number found: never a number in clear.
 *
 * A part the result does not have is left out, and so is a state this build has no words for: **the raw value is never drawn**.
 */
const STATE_WORDS: Readonly<Record<LookupKindName, Readonly<Record<string, StatusPresentation>>>> =
  {
    PICKUP_REQUEST: PICKUP_STATE_MAP,
    PICKUP_MANIFEST: MANIFEST_STATE_MAP,
    VENDOR_ACCOUNT: VENDOR_STATUS_MAP,
    RIDER: RIDER_STATUS_MAP,
    STAFF_IDENTITY: STAFF_STATUS_MAP,
  };

/** The state of a record in plain words, or nothing when the kind has no words for the value the server gave. */
export function stateWords(kind: LookupKindName, state: string | null): string | undefined {
  if (state === null) return undefined;
  const words = STATE_WORDS[kind];
  return Object.hasOwn(words, state) ? words[state]?.label : undefined;
}

/** The line under a result, from its facts. Nothing in it is the server's wording: the facts are its own. */
export function recordLine(result: RecordLookupResultView): string {
  const parts: (string | undefined)[] = [
    result.kind === 'PICKUP_REQUEST' ? (result.senderName ?? undefined) : undefined,
    stateWords(result.kind, result.state),
    result.hub?.name,
    result.serviceDate === null ? undefined : serviceDateText(result.serviceDate),
    result.phoneHint ?? undefined,
  ];
  return parts.filter((part): part is string => part !== undefined && part !== '').join(' · ');
}

/** The picture of each kind: the one its page has in the menu, so that one meaning keeps one picture. */
export const RECORD_ICONS: Readonly<Record<LookupKindName, IconName>> = {
  PICKUP_REQUEST: 'pickup-requests',
  PICKUP_MANIFEST: 'manifests',
  VENDOR_ACCOUNT: 'vendors',
  RIDER: 'riders',
  STAFF_IDENTITY: 'staff',
};
