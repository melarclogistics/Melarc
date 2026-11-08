import { useRef, type ReactNode } from 'react';

import { problemOf, type Problem } from '../../../platform/problem/problem-copy';
import { Alert } from '../alert/Alert';
import { Button } from '../button/Button';
import { ForbiddenState } from '../forbidden-state/ForbiddenState';
import { LoadingIndicator } from '../loading/LoadingIndicator';
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
  /** The permission key the read needs. A refusal names it. */
  readonly permission?: string;
  /** The `operationId` of the read, so that its failures are worded for it. */
  readonly operation?: string;
  readonly context?: string;
  /**
   * A way out of a failure that a retry is not (asking again for the same thing would fail the same way), offered under the message: the
   * screen's own control, such as the first page of a queue whose saved page the server will not open. Shown for a failure only.
   */
  readonly recovery?: ReactNode;
}

function RefusalOrFailure({
  problem,
  permission,
  onRetry,
  retrying,
  recovery,
}: {
  readonly problem: Problem;
  readonly permission: string | undefined;
  readonly onRetry: () => void;
  readonly retrying: boolean;
  readonly recovery: ReactNode;
}): ReactNode {
  if (problem.kind === 'session-ended' || problem.kind === 'stale') return null;

  if (problem.kind === 'forbidden' && problem.forbidden !== undefined) {
    const kind = problem.forbidden;
    // A refusal for want of a permission names it; with no key to name, the refusal is told in the generic words, as any other.
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
      return <ForbiddenState kind={kind} permission={permission} announce />;
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
 * authority (naming the permission), nothing at all, and the content. It shows nothing for a session that has ended or a stale answer,
 * because the session boundary has already taken the person away. It never shows the diagnostic `message`, and it never shows data from an
 * earlier answer beside a failed refresh: the person is told it failed, and may try again.
 *
 * A retry takes its button with it when the query goes back to loading, so focus is parked on the region first, and a keyboard user is
 * not dropped at the top of the document.
 */
export function ReadState<Data>({
  query,
  isEmpty,
  empty,
  children,
  loadingLabel,
  skeleton,
  permission,
  operation,
  context,
  recovery,
}: ReadStateProps<Data>) {
  const region = useRef<HTMLDivElement>(null);
  const place = {
    ...(operation === undefined ? {} : { operation }),
    ...(context === undefined ? {} : { context }),
  };

  let content: ReactNode;
  if (query.status === 'pending') {
    content = (
      <>
        <LoadingIndicator {...(loadingLabel === undefined ? {} : { label: loadingLabel })} />
        {skeleton}
      </>
    );
  } else if (query.status === 'error') {
    content = (
      <RefusalOrFailure
        problem={problemOf(query.error, place)}
        permission={permission}
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
    <div className="ui-read-state" ref={region} tabIndex={-1}>
      {content}
    </div>
  );
}
