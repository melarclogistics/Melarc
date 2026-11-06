import { PageHeading } from '../../components/PageHeading';
import { Alert } from '../../components/ui/alert/Alert';
import { CountBadge } from '../../components/ui/count-badge/CountBadge';
import { Icon } from '../../components/ui/icon/Icon';
import { Link } from '../../components/ui/link/Link';
import { ReadState } from '../../components/ui/read-state/ReadState';
import { inOrderOfUrgency } from '../../platform/queue-summary/queue-summary-order';
import type { QueueSummaryView } from '../../platform/queue-summary/queue-summary-shape';
import { useQueueSummary } from '../../platform/queue-summary/use-queue-summary';
import { useSignedInSession } from '../../platform/session/use-permissions';
import { formatInstant } from '../../platform/time/format-time';
import { QUEUE_WORDS, queueLink } from '../navigation/queue-places';
import { destinationsFor } from '../navigation/route-registry';
import './LandingPage.css';

/**
 * What is waiting for the person (task C1; surfaces/ops-portal.md section 7, `/`; `AC-QSUM-08`): each queue the server counted for this session,
 * with its count, a link to the queue (to the set that was counted where the queue's page takes the filter) and since when its oldest record
 * has waited, the one that has waited longest first.
 *
 * **It says only what the summary says.** Until the summary has been read nothing is claimed ("nothing is waiting" before the answer would
 * send an approver away from their queue); a read that failed says so and offers *Try again*, and is never taken for an empty queue; *nothing
 * is waiting* is said when the summary was read and every count it returned is `0`; and a session the summary gave no queue to (it may read
 * none) is told nothing about waiting at all, which is neither "nothing is waiting" nor a heading over an empty list. Which queues the session
 * is given is the server's decision (the key of each queue's list, and for an approver's queue its decision key): the page never works it out
 * from the keys it holds.
 */
function QueueList({
  summary,
  holds,
}: {
  readonly summary: QueueSummaryView;
  readonly holds: (permission: string) => boolean;
}) {
  return (
    <>
      {summary.queues.length === 0 ? null : (
        <ul className="landing-queues" aria-labelledby="landing-waiting">
          {inOrderOfUrgency(summary.queues).map((queue) => {
            const since = queue.oldestAt === null ? undefined : formatInstant(queue.oldestAt);
            return (
              <li
                key={queue.queue}
                className="landing-queues__item"
                {...(queue.count === 0 ? { 'data-empty': 'true' } : {})}
              >
                <Link to={queueLink(queue.queue, holds)}>{QUEUE_WORDS[queue.queue].title}</Link>
                <CountBadge count={queue.count} />
                {since === undefined ? null : (
                  <span className="landing-queues__since">Oldest since {since}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {/* A queue this page has no words for (a server newer than the page): what is listed is true and not all that waits. */}
      {summary.incomplete ? <p>Some queues cannot be shown on this page.</p> : null}
    </>
  );
}

function WaitingForYou({ holds }: { readonly holds: (permission: string) => boolean }) {
  const summary = useQueueSummary();
  // A session the summary gave no queue to has nothing to be told about waiting: not that nothing is, and not a heading with nothing under it.
  // (A summary that named only queues this page cannot show is not that: it says so.)
  if (summary.isSuccess && summary.data.queues.length === 0 && !summary.data.incomplete) {
    return null;
  }
  return (
    <>
      <h2 id="landing-waiting">Waiting for you</h2>
      <ReadState<QueueSummaryView>
        query={summary}
        isEmpty={(data) => !data.incomplete && data.queues.every((queue) => queue.count === 0)}
        empty={<Alert variant="success">Nothing is waiting.</Alert>}
        loadingLabel="Checking what is waiting…"
        operation="getQueueSummary"
      >
        {(data) => <QueueList summary={data} holds={holds} />}
      </ReadState>
    </>
  );
}

/**
 * The signed-in landing (surfaces/ops-portal.md section 7, `/`): who is signed in, what is waiting for them, the hubs the session acts in,
 * and the places it may go. Nothing waiting is a success message and not a blank. It shows only what `getCurrentSession` and
 * `getQueueSummary` said and what the session's keys allow; later slices fill the landing, they do not replace it. The navigation and the
 * sign-out control that every signed-in screen carries are the authenticated Ops shell's, drawn around this page (`AuthenticatedOpsShell`).
 */
export function LandingPage() {
  const me = useSignedInSession();
  // The route sits under the session guard, which renders this only for a signed-in session.
  if (me === undefined) return null;
  const { principal_display_name: name, authorized_hubs: hubs, permissions } = me.session;
  const destinations = destinationsFor(permissions);

  return (
    <>
      <title>Melarc Ops Portal</title>
      <PageHeading>Melarc Ops Portal</PageHeading>
      <p>
        {name === null ? (
          'You are signed in.'
        ) : (
          <>
            Signed in as <strong>{name}</strong>.
          </>
        )}
      </p>

      <WaitingForYou holds={me.holds} />

      <h2 id="landing-hubs">Your hubs</h2>
      {hubs.length === 0 ? (
        <p>No hub is listed for your session.</p>
      ) : (
        <ul aria-labelledby="landing-hubs">
          {hubs.map((hub) => (
            <li key={hub.id}>{hub.display_name}</li>
          ))}
        </ul>
      )}

      {destinations.length === 0 ? null : (
        <>
          <h2 id="landing-places">Where to go</h2>
          <ul className="landing-places" aria-labelledby="landing-places">
            {destinations.map((place) => (
              <li key={place.to}>
                <Link to={place.to}>
                  {/* The picture the menu gives the same place: one meaning, one icon (DESIGN_SYSTEM section 24). */}
                  <Icon name={place.icon} size="sm" className="landing-places__icon" />
                  {place.label}
                </Link>
                {place.description === undefined ? null : (
                  <span className="landing-places__description"> {place.description}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
