import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';

import { type CapabilityWords } from '../../../platform/problem/capability-words';
import {
  problemOf,
  REFRESH_FAILED,
  type Problem,
  type ProblemPlace,
} from '../../../platform/problem/problem-copy';
import { Alert } from '../alert/Alert';
import { Button } from '../button/Button';
import { ForbiddenState } from '../forbidden-state/ForbiddenState';
import { LoadingIndicator } from '../loading/LoadingIndicator';
import { UNCLAIMED_FOCUS_ATTRIBUTE } from './unclaimed-focus';
import './read-state.css';

/** What `ReadState` needs of a query: its result, and the way to ask again. A TanStack `useQuery` result is one. */
export interface ReadQuery<Data> {
  readonly status: 'pending' | 'error' | 'success';
  readonly data: Data | undefined;
  readonly error: unknown;
  readonly refetch: () => Promise<unknown>;
  readonly isFetching: boolean;
}

export interface ReadStateProps<Data> {
  readonly query: ReadQuery<Data>;
  /** Whether what was read is nothing. The screen decides; a list is empty when it has no items, a record never is. */
  readonly isEmpty: (data: Data) => boolean;
  /** What to show for nothing: the screen's `EmptyState`, which says whether nothing exists or the filter hides it. */
  readonly empty: ReactNode;
  /** The content, drawn from the data. It is called only with data that was read. */
  readonly children: (data: Data) => ReactNode;
  /** What is being loaded, in words, for the loading indicator. */
  readonly loadingLabel?: string;
  /** A placeholder for the shape of the content, shown beside the loading indicator. Decoration only. */
  readonly skeleton?: ReactNode;
  /** The permission key the read needs. A refusal says what it lets a person do, in plain words (`capability-words.ts`), and never the key. */
  readonly permission?: string;
  /** What the page reads with that key where it is not what the table says ("see pickup runs" for the key that also reads requests): words of the table, never free text. */
  readonly capability?: CapabilityWords;
  /** The `operationId` of the read, so that its failures are worded for it. */
  readonly operation?: string;
  readonly context?: string;
  /**
   * A way out of a failure that a retry is not (asking again for the same thing would fail the same way), offered under the message: the
   * screen's own control, such as the first page of a queue whose saved page the server will not open. Shown for a failure only.
   */
  readonly recovery?: ReactNode;
  /**
   * The page tells a failed refresh itself (the freshness line of its header, a connection banner): the page is kept all the same, and this draws no line of its own, so that one lost read is not told three times.
   * Left out, the line is drawn.
   */
  readonly ownsRefreshFailure?: boolean;
  /**
   * Whether a read that was drawn and failed when asked for again keeps its page (`keepsPage`). Left out, it does. **False for a read whose earlier answer is no use once a new one could not be had**: the link to
   * a photo that was asked for again because the picture it gave would not load. Its failure is told in its own words and replaces the page, as it always did.
   */
  readonly keepOnFailure?: boolean;
}

/** What the rule about a kept page reads of a query. */
type KeptRead<Data> = Pick<ReadQuery<Data>, 'status' | 'data' | 'error'>;

/**
 * Whether a failed read **keeps the page it drew** (Run G2, OB-S1-169 item 10; the Product Owner's decision of 24 November 2026): the read has data, it was asked for again, and it failed in a way that asking
 * once more could mend (no answer, a fault, a rate limit). A record that is gone and a refusal of authority are not that: the page they replace is a page of something the person can no longer have, and says so.
 * A read with no data yet is the error, as it always was.
 */
export function keepsPage<Data>(query: KeptRead<Data>, place: ProblemPlace = {}): boolean {
  if (query.status !== 'error' || query.data === undefined) return false;
  const { kind } = problemOf(query.error, place);
  return kind === 'unavailable' || kind === 'rate-limited';
}

/**
 * What a page is drawn from: what was read, or what was read before a read that failed again and whose page is kept (`keepsPage`). Undefined while there is nothing to draw (on its way, failed, or refused). A page
 * that draws part of itself around a `ReadState`, a heading that is there until the page's own takes its place, asks this and not `status === 'success'`, or it draws that part twice for a page that is kept.
 */
export function drawnData<Data>(query: KeptRead<Data>, place?: ProblemPlace): Data | undefined {
  return query.status === 'success' || keepsPage(query, place) ? query.data : undefined;
}

/** When the line goes while a control in it has the focus (the person pressed Try again and it mended), focus goes to the place the line was in, never to the top of the document. */
function useFocusHomeWhenGone(line: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const node = line.current;
    // React runs this before it takes the node out: focus is still where the person left it.
    return () => {
      if (node === null) return;
      const active = node.ownerDocument.activeElement;
      if (active === null || !node.contains(active)) return;
      const home =
        node.closest<HTMLElement>('.ui-read-state') ??
        node.ownerDocument.querySelector<HTMLElement>('h1');
      home?.focus();
    };
  }, [line]);
}

function KeptLine<Data>({
  query,
  place,
}: {
  readonly query: ReadQuery<Data>;
  readonly place: ProblemPlace;
}) {
  const line = useRef<HTMLDivElement>(null);
  useFocusHomeWhenGone(line);
  const problem = problemOf(query.error, place);
  return (
    <div className="ui-read-state__kept" ref={line}>
      <Alert variant="danger" announce>
        <p>{problem.kind === 'rate-limited' ? problem.message : REFRESH_FAILED.headline}</p>
        <p>{REFRESH_FAILED.note}</p>
        {problem.reference === undefined ? null : <p>Reference: {problem.reference}</p>}
      </Alert>
      {/* The page is still there, so the button stays while it asks (the query keeps its failure until it mends): no focus has to be parked. */}
      <p className="ui-read-state__retry">
        <Button
          type="button"
          variant="secondary"
          loading={query.isFetching}
          onClick={() => {
            void query.refetch();
          }}
        >
          Try again
        </Button>
      </p>
    </div>
  );
}

/**
 * The line of a page that is kept when its read failed again (`keepsPage`): the failure in words, and *Try again* beside it. It draws nothing for a read that did not fail that way, so a page may put it where it
 * likes whatever the read is. `ReadState` draws it itself; a page that draws its content outside a `ReadState` draws it with the page.
 */
export function RefreshFailed<Data>({
  query,
  operation,
  context,
}: {
  readonly query: ReadQuery<Data>;
  readonly operation?: string;
  readonly context?: string;
}): ReactNode {
  const place: ProblemPlace = {
    ...(operation === undefined ? {} : { operation }),
    ...(context === undefined ? {} : { context }),
  };
  return keepsPage(query, place) ? <KeptLine query={query} place={place} /> : null;
}

function RefusalOrFailure({
  problem,
  permission,
  capability,
  onRetry,
  retrying,
  recovery,
}: {
  readonly problem: Problem;
  readonly permission: string | undefined;
  readonly capability: CapabilityWords | undefined;
  readonly onRetry: () => void;
  readonly retrying: boolean;
  readonly recovery: ReactNode;
}): ReactNode {
  if (problem.kind === 'session-ended' || problem.kind === 'stale') return null;

  if (problem.kind === 'forbidden' && problem.forbidden !== undefined) {
    const kind = problem.forbidden;
    // A refusal for want of a permission tells what the account cannot do, in the words of the key; with no key to go by, it is told in the generic words, as any other.
    if (kind !== 'permission-missing') {
      return (
        <ForbiddenState
          kind={kind}
          announce
          {...(permission === undefined ? {} : { permission })}
        />
      );
    }
    if (permission !== undefined) {
      return (
        <ForbiddenState
          kind={kind}
          permission={permission}
          announce
          {...(capability === undefined ? {} : { capability })}
        />
      );
    }
    return (
      <Alert variant="danger" announce>
        <p>{problem.message}</p>
      </Alert>
    );
  }

  // Asking again changes nothing for a record that is not there or a request that was refused: a retry is offered for what could work.
  // It is a control beside the error, not part of it (COMPONENT_PATTERNS section 33.1), so the alert is read as the error and the button
  // is found as a button.
  const retryable = problem.kind === 'unavailable' || problem.kind === 'rate-limited';
  return (
    <>
      <Alert variant="danger" announce>
        <p>{problem.message}</p>
        {problem.reference === undefined ? null : <p>Reference: {problem.reference}</p>}
      </Alert>
      {retryable ? (
        <p className="ui-read-state__retry">
          <Button type="button" variant="secondary" loading={retrying} onClick={onRetry}>
            Try again
          </Button>
        </p>
      ) : null}
      {recovery === undefined ? null : <p className="ui-read-state__retry">{recovery}</p>}
    </>
  );
}

/**
 * A read of the API, in every state the screen owes (COMPONENT_PATTERNS section 33.1): loading (a loading indicator and, if the screen
 * wants one, a skeleton), the error in approved words with a retry that is a control beside the error and not part of it, the refusals of
 * authority (told in plain words, never by the key), nothing at all, and the content. It shows nothing for a session that has ended or a stale answer,
 * because the session boundary has already taken the person away. It never shows the diagnostic `message`.
 *
 * **A read that was drawn and is asked for again, and fails in a way a retry could mend, keeps the page and whatever was typed into it** (`keepsPage`; Run G2, OB-S1-169 item 10), and says so in one line above it
 * with *Try again*; the children stay where they are in the tree, so a form is not drawn again, which would empty it. A record that is gone and a refusal replace the page, as they always did.
 *
 * A retry that has no page to keep takes its button with it when the query goes back to loading, so focus is parked on the region first, and a keyboard user is not dropped at the top of the document.
 */
export function ReadState<Data>({
  query,
  isEmpty,
  empty,
  children,
  loadingLabel,
  skeleton,
  permission,
  capability,
  operation,
  context,
  recovery,
  ownsRefreshFailure = false,
  keepOnFailure = true,
}: ReadStateProps<Data>) {
  const region = useRef<HTMLDivElement>(null);
  const place = {
    ...(operation === undefined ? {} : { operation }),
    ...(context === undefined ? {} : { context }),
  };
  const kept = keepOnFailure && keepsPage(query, place);

  let content: ReactNode;
  if (query.status === 'pending') {
    content = (
      <>
        <LoadingIndicator {...(loadingLabel === undefined ? {} : { label: loadingLabel })} />
        {skeleton}
      </>
    );
  } else if (query.status === 'error' && !kept) {
    content = (
      <RefusalOrFailure
        problem={problemOf(query.error, place)}
        permission={permission}
        capability={capability}
        retrying={query.isFetching}
        recovery={recovery}
        onRetry={() => {
          region.current?.focus();
          void query.refetch();
        }}
      />
    );
  } else if (query.data === undefined || isEmpty(query.data)) {
    // A read that succeeded with nothing to show is nothing, however the query reports it.
    content = empty;
  } else {
    content = children(query.data);
  }

  return (
    <div
      className="ui-read-state"
      ref={region}
      tabIndex={-1}
      {...{ [UNCLAIMED_FOCUS_ATTRIBUTE]: '' }}
    >
      {/* The line and the content are two places of their own, always: the content is at the same place in the tree whether the line is there or not, so a page that is kept is the same page and keeps its fields. */}
      {ownsRefreshFailure || !kept ? null : (
        <RefreshFailed
          query={query}
          {...(operation === undefined ? {} : { operation })}
          {...(context === undefined ? {} : { context })}
        />
      )}
      {content}
    </div>
  );
}
