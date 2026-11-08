import type { StatusMap } from '../../../components/ui/status-badge/StatusBadge';
import type { AssignableBundleView, StaffStatus } from '../../../platform/staff/staff-shape';

/**
 * How the staff screens say things: what a status is called and drawn as, which views of the list there are, and what a role or a hub is
 * called when only its id is known. The words belong to the screens and not to the server; the mapping is typed over the whole enum, so a
 * status the contract adds is a compile error here until someone decides how it reads.
 */
export const STAFF_STATUS_MAP: StatusMap<StaffStatus> = {
  PENDING_APPROVAL: { tone: 'warning', label: 'Waiting for approval' },
  ACTIVE: { tone: 'success', label: 'Active' },
  REJECTED: { tone: 'danger', label: 'Rejected' },
  SUSPENDED: { tone: 'warning', label: 'Suspended' },
  OFFBOARDED: { tone: 'neutral', label: 'Offboarded' },
};

export const STAFF_VIEWS = {
  waiting: { label: 'Waiting for approval', status: 'PENDING_APPROVAL' },
  active: { label: 'Active', status: 'ACTIVE' },
  rejected: { label: 'Rejected', status: 'REJECTED' },
  suspended: { label: 'Suspended', status: 'SUSPENDED' },
  offboarded: { label: 'Offboarded', status: 'OFFBOARDED' },
  all: { label: 'Everyone', status: undefined },
} as const satisfies Record<string, { label: string; status: StaffStatus | undefined }>;

export type StaffView = keyof typeof STAFF_VIEWS;

/** The status a view asks the server for, or none for everyone. */
export function statusOfView(view: StaffView): StaffStatus | undefined {
  return STAFF_VIEWS[view].status;
}

/** A view out of the address, or nothing when the text is not one (a made-up view is not sent to the server as a made-up filter). */
export function viewOf(text: string | null): StaffView | undefined {
  return text !== null && Object.hasOwn(STAFF_VIEWS, text) ? (text as StaffView) : undefined;
}

/** The queue for a person who can work it, everyone for a person who cannot: the queue is empty to someone who may not decide. */
export function defaultViewFor(canApprove: boolean): StaffView {
  return canApprove ? 'waiting' : 'all';
}

/** What a role is called: the name the server gave in the list of assignable roles, or "Another role" (an id is no use to a person). */
export function roleNameOf(
  bundleId: string,
  bundles: readonly AssignableBundleView[] | undefined,
): string {
  return (
    bundles?.find((bundle) => bundle.id.toLowerCase() === bundleId.toLowerCase())?.name ??
    'Another role'
  );
}

/** What a hub is called: the name the session gives for the hubs it acts in, "No hub" for none, and "Another hub" for one it does not know. */
export function hubNameOf(
  hubId: string | null | undefined,
  hubs: readonly { readonly id: string; readonly display_name: string }[],
): string {
  if (hubId === null || hubId === undefined) return 'No hub';
  return (
    hubs.find((hub) => hub.id.toLowerCase() === hubId.toLowerCase())?.display_name ?? 'Another hub'
  );
}
