import { Link as RouterLink } from 'react-router';

import { PageHeading } from '../../../components/PageHeading';
import { Alert } from '../../../components/ui/alert/Alert';
import { formatCount } from '../../../components/ui/count-badge/CountBadge';
import { Icon } from '../../../components/ui/icon/Icon';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { useHubScope } from '../../../platform/hub/active-hub';
import { hubsLine } from '../../../platform/hub/hubs-line';
import { inOrderOfUrgency } from '../../../platform/queue-summary/queue-summary-order';
import type { QueueSummaryView } from '../../../platform/queue-summary/queue-summary-shape';
import { useQueueSummary } from '../../../platform/queue-summary/use-queue-summary';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { QUEUE_WORDS, queueLink } from '../../navigation/queue-places';
import './my-work.css';

/**
 * What is waiting in the queues that have something in them (task C1; surfaces/ops-portal.md section 7): **one card for each queue the server
 * counted for this session that holds anything**, the one whose oldest record has waited longest first, each with its name (a link to the queue,
 * to the set that was counted where the queue's page takes the filter), its count, large, and since when its oldest record has waited. **A queue
 * the server counted and found empty is not a card**: they are one quiet line, "Also clear: …".
 *
 * "Since when" is **the moment the server gave, in the portal's time, and never a number of days** ("Oldest since 30 Oct, 08:00": no bucket,
 * target or threshold is defined, so none is invented; reporting-data-dictionary.md section 14).
 */
function Cards({
  summary,
  holds,
}: {
  readonly summary: QueueSummaryView;
  readonly holds: (permission: string) => boolean;
}) {
  const ordered = inOrderOfUrgency(summary.queues);
  const waiting = ordered.filter((queue) => queue.count > 0);
  const clear = ordered.filter((queue) => queue.count === 0);
  return (
    <>
      {waiting.length === 0 ? null : (
        <ul className="my-work__cards" aria-labelledby="my-work-waiting">
          {waiting.map((queue) => {
            const since = queue.oldestAt === null ? undefined : formatInstant(queue.oldestAt);
            return (
              <li key={queue.queue} className="my-work-card">
                {/* The card is one link, the name of the queue, stretched over the card: a whole-card link carries a chevron and no underline (the chevron is its other
                    cue, COMPONENT_PATTERNS section 5, task R5.2 M16); the figure's own phrase stays outside the link, so that the link is named by the queue alone. */}
                <RouterLink to={queueLink(queue.queue, holds)} className="my-work-card__link">
                  <span>{QUEUE_WORDS[queue.queue].title}</span>
                  <Icon name="next" size="sm" />
                </RouterLink>
                <p className="my-work-card__figure">
                  {/* The number is drawn and the whole phrase is read ("5 waiting for confirmation"), so that the number is not said twice. */}
                  <span aria-hidden="true">{formatCount(queue.count)}</span>
                  <span className="my-work-card__meaning">
                    {`${formatCount(queue.count)} ${QUEUE_WORDS[queue.queue].meaning}`}
                  </span>
                </p>
                {since === undefined ? null : (
                  <p className="my-work-card__since">Oldest since {since}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {clear.length === 0 ? null : (
        <p className="my-work__clear">
          Also clear: {clear.map((queue) => QUEUE_WORDS[queue.queue].title).join(', ')}.
        </p>
      )}
      {/* A queue this page has no words for (a server newer than the page): what is listed is true and not all that waits. */}
      {summary.incomplete ? <p>Some queues cannot be shown on this page.</p> : null}
    </>
  );
}

/** What the cards are while the summary is being read: the shapes of cards, and no figure. Decoration: the loading words are what is announced. */
function CardSkeletons() {
  return (
    <ul className="my-work__cards my-work__cards--loading" aria-hidden="true">
      {[0, 1, 2].map((each) => (
        <li key={each} className="my-work-card">
          <Skeleton lines={3} />
        </li>
      ))}
    </ul>
  );
}

/**
 * **It says only what the summary says** (`AC-QSUM-08`). Until the summary has been read nothing is claimed, and no figure is drawn (loading shows the
 * shapes of the cards and never a zero); a read that failed says so and offers *Try again*, and is never taken for an empty queue; *Nothing is
 * waiting* is said when the summary was read, was complete, and every count it returned is `0`; and a session the summary gave no queue to (it may
 * read none) is told nothing about waiting at all, which is neither "nothing is waiting" nor a heading over nothing. Which queues the session is
 * given is the server's decision: the page never works it out from the keys it holds.
 *
 * **When a hub is chosen the counts are that hub's, and the heading says so** (audit B9, 7 November 2026): "Waiting for you at Kumasi Hub", and "Nothing
 * is waiting at Kumasi Hub", so that a page of the figures of one hub is never read as the figures of every hub the session reaches.
 */
function WaitingForYou({ holds }: { readonly holds: (permission: string) => boolean }) {
  const summary = useQueueSummary();
  const { hub } = useHubScope();
  if (summary.isSuccess && summary.data.queues.length === 0 && !summary.data.incomplete)
    return null;
  return (
    <>
      <h2 id="my-work-waiting" className="my-work__heading">
        {hub === undefined ? 'Waiting for you' : `Waiting for you at ${hub.display_name}`}
      </h2>
      <ReadState<QueueSummaryView>
        query={summary}
        isEmpty={(data) => !data.incomplete && data.queues.every((queue) => queue.count === 0)}
        empty={
          <Alert variant="success">
            {hub === undefined
              ? 'Nothing is waiting.'
              : `Nothing is waiting at ${hub.display_name}.`}
          </Alert>
        }
        loadingLabel="Checking what is waiting…"
        skeleton={<CardSkeletons />}
        operation="getQueueSummary"
      >
        {(data) => <Cards summary={data} holds={holds} />}
      </ReadState>
    </>
  );
}

/**
 * My work, the signed-in landing (surfaces/ops-portal.md section 7, `/`; the Product Owner, 5 November 2026): who is signed in and where they act,
 * and what is waiting for them across every queue their session may read. Nothing waiting is a success message and not a blank. **It lists nothing
 * but what `getCurrentSession` and `getQueueSummary` said**: no list of the pages (the menus are that), no figure of its own. The sidebar, the top bar
 * and the sign-out control that every signed-in screen carries are the shell's, drawn around this page.
 */
export function MyWorkPage() {
  const me = useSignedInSession();
  // The route sits under the session guard, which renders this only for a signed-in session.
  if (me === undefined) return null;
  const { principal_display_name: name, authorized_hubs: hubs } = me.session;
  const where = hubsLine(hubs);

  return (
    <>
      <title>My work · Melarc Ops Portal</title>
      <PageHeading>My work</PageHeading>
      <p className="my-work__who">
        {name === null ? (
          'You are signed in.'
        ) : (
          <>
            Hello, <strong>{name}</strong>
          </>
        )}
        {where === null ? null : <span className="my-work__where"> · {where}</span>}
      </p>
      <WaitingForYou holds={me.holds} />
    </>
  );
}
