import type { QueueName } from '../../platform/queue-summary/queue-summary-shape';

/**
 * What each queue of the summary is called and where it leads (task C1; surfaces/ops-portal.md sections 4 and 7). One place for the words and
 * the links, **typed over the whole closed list of queues**: a queue the contract adds is a compile error here until someone decides what to
 * call it and where it goes, and not a line with an identifier on the landing. Plain words: no permission key, no role, no identifier.
 */
export interface QueueWords {
  /** What the queue is called where it is listed (the landing's line). */
  readonly title: string;
  /**
   * What a number beside a menu entry means, said after the number to someone who hears it ("5 waiting for confirmation"). The number is not
   * the whole of the entry's name: a count of "in progress" beside *Manifests* is not a count of manifests.
   */
  readonly meaning: string;
}

export const QUEUE_WORDS: Readonly<Record<QueueName, QueueWords>> = {
  PICKUP_AWAITING_CONFIRMATION: {
    title: 'Pickup requests waiting for confirmation',
    meaning: 'waiting for confirmation',
  },
  PICKUP_CUTOFF_REVIEW: {
    title: 'Late bookings waiting for a cut-off decision',
    meaning: 'late bookings waiting for a decision',
  },
  PICKUP_EXCEPTION_APPROVAL: {
    title: 'One-package exceptions waiting for approval',
    meaning: 'waiting for approval',
  },
  PICKUP_UNMANIFESTED_POOL: {
    title: 'Confirmed pickups not yet on a run',
    meaning: 'confirmed and not yet on a run',
  },
  PICKUP_RUNS_IN_PROGRESS: {
    title: 'Pickup runs in progress',
    meaning: 'in progress',
  },
  STAFF_AWAITING_APPROVAL: {
    title: 'Staff profiles waiting for approval',
    meaning: 'waiting for approval',
  },
};

/**
 * Where the landing sends the person for a queue: **the set the count counted, where the queue's page takes the filter**, and the queue's
 * page where it does not. `holds` is whether the session's keys include one (a hint for what to offer; the page and the server check again,
 * and a link is never the enforcement): the pool leads to the manifest builder for a session that may build a manifest and to the confirmed
 * pickups for one that may not, so that no one is sent to a page that refuses them.
 *
 * - The pickup queue takes `state` (`PENDING` is the requests waiting for confirmation) and the cut-off decision, `cutoff` (`CONFIRMED` with
 *   `PENDING_OPS_REVIEW` is the late bookings, which the list has its own filter for since task C1.1, `AC-QSUM-11`).
 * - The approvals page and the staff page's *waiting* view are the approver's queues.
 * - The manifest list takes `state` (`IN_PROGRESS`).
 */
export function queueLink(queue: QueueName, holds: (permission: string) => boolean): string {
  switch (queue) {
    case 'PICKUP_AWAITING_CONFIRMATION':
      return '/pickup-requests?state=PENDING';
    case 'PICKUP_CUTOFF_REVIEW':
      return '/pickup-requests?state=CONFIRMED&cutoff=PENDING_OPS_REVIEW';
    case 'PICKUP_EXCEPTION_APPROVAL':
      return '/approvals';
    case 'PICKUP_UNMANIFESTED_POOL':
      return holds('pickup.manifest.create')
        ? '/manifests/new'
        : '/pickup-requests?state=CONFIRMED';
    case 'PICKUP_RUNS_IN_PROGRESS':
      return '/manifests?state=IN_PROGRESS';
    case 'STAFF_AWAITING_APPROVAL':
      return '/admin/staff?view=waiting';
  }
}
