import { Link } from '../../../components/ui/link/Link';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { Timeline, type TimelineEntry } from '../../../components/ui/timeline/Timeline';
import type { PickupRequestView } from '../../../platform/pickup/pickup-shape';
import { useAttemptChain, type AttemptLink } from '../../../platform/pickup/use-pickup-queries';
import { PICKUP_STATE_MAP, serviceDateText } from './pickup-presentation';

function entryOf(link: AttemptLink, current: PickupRequestView): TimelineEntry {
  if (link.kind === 'unreadable') {
    return {
      key: link.id,
      title: 'An attempt this session cannot read',
      details: <p>It belongs to a hub your session does not act in, or it is no longer there.</p>,
    };
  }
  const { request } = link;
  const isCurrent = request.id.toLowerCase() === current.id.toLowerCase();
  return {
    key: request.id,
    title: isCurrent ? (
      `Attempt ${String(request.attempt_number)}: ${request.code}`
    ) : (
      <Link to={`/pickup-requests/${request.id}`}>
        {`Attempt ${String(request.attempt_number)}: ${request.code}`}
      </Link>
    ),
    details: (
      <p>
        <StatusBadge status={request.state} map={PICKUP_STATE_MAP} />{' '}
        {`for ${serviceDateText(request.scheduled_service_date)}`}
      </p>
    ),
    current: isCurrent,
  };
}

/**
 * The attempt chain of a request (§21.6, AC-SLICE-001-06): every attempt, oldest first, each a request of its own linked to the one it replaced.
 * A reschedule is never an edit, so the chain is the record of what was tried. Each other attempt links to its own page; one the session may not
 * read is said to be there and not shown. The chain is read once, for the request the page read.
 */
export function AttemptChain({ request }: { readonly request: PickupRequestView }) {
  const chain = useAttemptChain(request);
  return (
    <ReadState<readonly AttemptLink[]>
      query={chain}
      isEmpty={() => false}
      empty={null}
      loadingLabel="Loading the attempts…"
      permission="pickup.read"
      operation="getPickupRequest"
      context="chain"
    >
      {(links) =>
        links.length === 1 ? (
          <p>
            No other attempt is linked to this request: it replaced none, and none has replaced it.
          </p>
        ) : (
          <Timeline
            label="Attempts of this pickup, oldest first"
            entries={links.map((link) => entryOf(link, request))}
            currentLabel="(this request)"
          />
        )
      }
    </ReadState>
  );
}
