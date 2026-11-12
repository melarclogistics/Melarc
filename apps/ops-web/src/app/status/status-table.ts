import {
  pairOf,
  type StatusMap,
  type StatusPair,
} from '../../components/ui/status-badge/StatusBadge';
import {
  HANDOVER_STATE_MAP,
  MANIFEST_STATE_MAP,
  STOP_STATUS_MAP,
} from '../pages/manifests/manifest-presentation';
import { FEED_STATE_MAP, NOTIFICATION_STATE_MAP } from '../pages/messages/message-presentation';
import { PICKUP_STATE_MAP } from '../pages/pickup/pickup-presentation';
import { RIDER_DEVICE_STATUS_MAP, RIDER_STATUS_MAP } from '../pages/riders/rider-presentation';
import { STAFF_STATUS_MAP } from '../pages/staff/staff-presentation';
import { DEVICE_STATUS_MAP, VENDOR_STATUS_MAP } from '../pages/vendors/vendor-presentation';

/**
 * **The one table of statuses** (COMPONENT_PATTERNS, *StatusBadge v2*): every state that a screen of the portal shows as a badge, by the domain it belongs to, with the
 * pair it is drawn in and the words it is called. It gathers the mappings that the screens already use (each is typed over the whole enumeration of its domain, so a state
 * the contract adds is a compile error where the mapping is written), and it is the one place that says what the portal calls a state: the search of records takes its
 * words from the same mappings (`app/shell/record-line.ts`), so a state is called the same thing in the palette and on its page. A test holds this table to the one in the
 * document (`test/status-table-docs.test.ts`).
 */
export const STATUS_TABLE = {
  PICKUP_REQUEST: PICKUP_STATE_MAP,
  PICKUP_MANIFEST: MANIFEST_STATE_MAP,
  PICKUP_STOP: STOP_STATUS_MAP,
  CUSTODY_HANDOVER: HANDOVER_STATE_MAP,
  NOTIFICATION_ATTEMPT: NOTIFICATION_STATE_MAP,
  NOTIFICATION_FEED: FEED_STATE_MAP,
  RIDER: RIDER_STATUS_MAP,
  RIDER_DEVICE: RIDER_DEVICE_STATUS_MAP,
  STAFF_IDENTITY: STAFF_STATUS_MAP,
  VENDOR_ACCOUNT: VENDOR_STATUS_MAP,
  VENDOR_DEVICE: DEVICE_STATUS_MAP,
} as const satisfies Readonly<Record<string, StatusMap<string>>>;

export type StatusDomain = keyof typeof STATUS_TABLE;

/** The domains that the search of records returns a state of (`RecordLookupResultView.state`): the table above holds every state it can return. */
export const LOOKUP_DOMAINS = [
  'PICKUP_REQUEST',
  'PICKUP_MANIFEST',
  'VENDOR_ACCOUNT',
  'RIDER',
  'STAFF_IDENTITY',
] as const satisfies readonly StatusDomain[];

/** One row of the table: a state, the pair it is drawn in and its words. */
export interface StatusRow {
  readonly domain: StatusDomain;
  readonly state: string;
  readonly pair: StatusPair;
  readonly label: string;
}

/** Every row of the table, in the order of the domains and of each mapping. */
export const STATUS_ROWS: readonly StatusRow[] = (
  Object.entries(STATUS_TABLE) as [StatusDomain, StatusMap<string>][]
).flatMap(([domain, map]) =>
  Object.entries(map).map(([state, presentation]) => ({
    domain,
    state,
    pair: pairOf(presentation.tone),
    label: presentation.label,
  })),
);

/** The table as the document holds it: a Markdown table with one row for each state. */
export function statusTableMarkdown(): string {
  return [
    '| Domain | State | Pair | Words |',
    '|---|---|---|---|',
    ...STATUS_ROWS.map(
      (row) => `| \`${row.domain}\` | \`${row.state}\` | ${row.pair} | ${row.label} |`,
    ),
  ].join('\n');
}
