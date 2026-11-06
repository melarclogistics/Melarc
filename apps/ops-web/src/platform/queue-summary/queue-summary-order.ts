import type { QueueCountView } from './queue-summary-shape';

/**
 * The queues in the order a person should look at them (task C1; surfaces/ops-portal.md section 7, `/`): **the one whose oldest record has
 * waited longest first**. A queue with work comes before one with none; among those with work the earlier `oldest_at` comes first, and a queue
 * the server gave no moment for (which it does not do for a queue that holds records, but the page does not assume it) comes after the ones
 * that have one. Queues the server counted equally keep the order it gave them (a stable sort), which is the order of the contract's list.
 *
 * It orders what the server said and invents nothing: no weight, no target and no threshold (reporting-data-dictionary.md section 14), and a
 * queue that is empty is neither hidden nor made to look urgent.
 */
export function inOrderOfUrgency(queues: readonly QueueCountView[]): QueueCountView[] {
  const moment = (queue: QueueCountView): number =>
    queue.oldestAt === null ? Number.POSITIVE_INFINITY : Date.parse(queue.oldestAt);
  return queues.toSorted((a, b) => {
    if (a.count > 0 !== b.count > 0) return a.count > 0 ? -1 : 1;
    if (a.count === 0) return 0;
    const [first, second] = [moment(a), moment(b)];
    // `Infinity - Infinity` is not a number, so the two without a moment are equal by saying so.
    if (first === second) return 0;
    return first < second ? -1 : 1;
  });
}
