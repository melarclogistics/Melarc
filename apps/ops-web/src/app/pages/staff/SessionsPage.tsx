import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { CardFacts } from '../../../components/ui/card-facts/CardFacts';
import type { DataColumn } from '../../../components/ui/data-table/DataTable';
import { EmptyStateV2 } from '../../../components/ui/empty-state/EmptyStateV2';
import { Link } from '../../../components/ui/link/Link';
import { PageHeader } from '../../../components/ui/page-header/PageHeader';
import { ReasonConfirmationDialog } from '../../../components/ui/reason-confirmation/ReasonConfirmationDialog';
import { QueueWorkspace, type QueueResult } from '../../../components/ui/templates/QueueWorkspace';
import { useApiClient } from '../../../platform/api/api-client';
import { isNotFound } from '../../../platform/api/api-response';
import { cannotText, refusalText } from '../../../platform/problem/capability-words';
import { problemOf } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { revokeSession } from '../../../platform/staff/staff-commands';
import {
  PRINCIPAL_TYPES,
  type PrincipalType,
  type SessionRecordView,
} from '../../../platform/staff/staff-shape';
import { useSessionRecords, useStaffIdentity } from '../../../platform/staff/use-staff-queries';
import { formatInstant } from '../../../platform/time/format-time';
import { UUID } from './WithProfile';
import './staff-pages.css';

/** What a person is called in the words of this page when only their kind is known. */
const KIND: Readonly<Record<PrincipalType, string>> = {
  STAFF: 'this staff member',
  RIDER: 'this rider',
  VENDOR: 'this vendor',
};

function Time({ instant }: { readonly instant: string | undefined }) {
  const text = instant === undefined ? undefined : formatInstant(instant);
  if (instant === undefined || text === undefined) return <>Not recorded</>;
  return <time dateTime={instant}>{text}</time>;
}

/** What ending a session looks like to the page: the session that ended, or the news that it had already gone. */
type Ended = SessionRecordView | 'already-ended';

function ChooseAPerson() {
  return (
    <>
      <h2>Choose a person first</h2>
      <p className="staff-action__text">
        Sessions are shown for one person at a time. Open a profile and choose “See sessions”.
      </p>
      <ButtonLink to="/admin/staff">Go to staff</ButtonLink>
    </>
  );
}

function Sessions({
  type,
  principalId,
}: {
  readonly type: PrincipalType;
  readonly principalId: string;
}) {
  const client = useApiClient();
  const me = useSignedInSession();
  const sessions = useSessionRecords(type, principalId);
  // The person's name, if it can be had. A page that cannot name them still shows their sessions.
  const person = useStaffIdentity(
    principalId,
    type === 'STAFF' && me?.holds('staff.read') === true,
  );
  const [target, setTarget] = useState<SessionRecordView | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const noticeBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (notice !== undefined) noticeBox.current?.focus();
  }, [notice]);

  if (me === undefined) return null;
  const name = person.data?.identity.full_name;
  const who = name ?? KIND[type];
  const canRevoke = me.holds('staff.session.revoke');
  const mine = target?.id === me.session.id;
  const updatedAt =
    sessions.dataUpdatedAt > 0
      ? formatInstant(new Date(sessions.dataUpdatedAt).toISOString())
      : undefined;

  function refresh(): Promise<unknown> {
    return sessions.refetch();
  }

  /** The act on a session, which names the session it ends (by when it started), so that each is told from the others by a person who hears only the button. */
  function endButton(row: SessionRecordView): ReactNode {
    const started = row.issued_at === undefined ? undefined : formatInstant(row.issued_at);
    return (
      <Button
        type="button"
        variant="danger"
        {...(started === undefined ? {} : { 'aria-label': `End session started ${started}` })}
        onClick={() => {
          setTarget(row);
        }}
      >
        End session
      </Button>
    );
  }

  const columns: DataColumn<SessionRecordView>[] = [
    {
      id: 'started',
      header: 'Started',
      rowHeader: true,
      cell: (row) => (
        <>
          <Time instant={row.issued_at} />
          {row.id === me.session.id ? (
            <span className="staff-session__mine">This is your session</span>
          ) : null}
        </>
      ),
    },
    // When it was last active matters beside when it started; when it expires is the first to go where the box is short (the table takes the lesser columns away, the most lesser first,
    // only as far as it takes for it not to scroll sideways, and a card shows every fact).
    {
      id: 'active',
      header: 'Last active',
      kind: 'date',
      cell: (row) => <Time instant={row.last_activity_at} />,
    },
    {
      id: 'expires',
      header: 'Expires',
      kind: 'date',
      cell: (row) => <Time instant={row.expires_at} />,
    },
    ...(canRevoke
      ? [{ id: 'action', header: 'Action', cell: (row: SessionRecordView) => endButton(row) }]
      : []),
  ];

  const result: QueueResult<SessionRecordView> = (() => {
    if (sessions.status === 'pending') return { status: 'loading' };
    if (sessions.status === 'error') {
      const problem = problemOf(sessions.error, { operation: 'listSessions' });
      // A session that has ended or an answer that is stale is the session boundary's, which has already taken the person away.
      if (problem.kind === 'session-ended' || problem.kind === 'stale') {
        return { status: 'loading' };
      }
      const message =
        problem.kind === 'forbidden'
          ? problem.forbidden === 'insufficient-authority'
            ? // The words of this act (staff-copy): they say whose sessions a session of this tier may see, which the table's general sentence does not.
              problem.message
            : refusalText(problem.forbidden, 'staff.read', { of: 'this person' })
          : problem.reference === undefined
            ? problem.message
            : `${problem.message} Reference: ${problem.reference}`;
      const retryable = problem.kind === 'unavailable' || problem.kind === 'rate-limited';
      return {
        status: 'error',
        message,
        ...(retryable
          ? {
              onRetry: () => {
                void sessions.refetch();
              },
            }
          : {}),
      };
    }
    // The list is read again after an act (an ended session) and its rows stay where they are while it is.
    return { status: 'ready', rows: sessions.data, refreshing: sessions.isFetching };
  })();

  return (
    <>
      <title>Sessions · Melarc Ops Portal</title>
      {type === 'STAFF' ? (
        <p className="staff-back">
          <Link to={`/admin/staff/${principalId}`}>Back to profile</Link>
        </p>
      ) : null}
      <QueueWorkspace<SessionRecordView>
        header={{
          title: 'Sessions',
          description: `Open sessions of ${who}.`,
          freshness: {
            state: sessions.isFetching ? 'refreshing' : sessions.isError ? 'failed' : 'idle',
            ...(updatedAt === undefined ? {} : { updatedAt }),
            onRefresh: () => {
              void sessions.refetch({ cancelRefetch: false });
            },
          },
        }}
        notice={
          notice === undefined && canRevoke ? undefined : (
            <>
              {notice === undefined ? null : (
                <div className="staff-notice" ref={noticeBox} tabIndex={-1}>
                  <Alert variant="success">
                    <p>{notice}</p>
                  </Alert>
                </div>
              )}
              {canRevoke ? null : (
                <p className="staff-note">{cannotText('staff.session.revoke')}</p>
              )}
            </>
          )
        }
        result={result}
        empty={{ noun: 'sessions', none: `${name ?? 'This person'} is not signed in anywhere.` }}
        emptyState={
          <EmptyStateV2 variant="all-clear" title="No open sessions" headingLevel={3}>
            {name ?? 'This person'} is not signed in anywhere.
          </EmptyStateV2>
        }
        table={{
          label: 'Open sessions',
          columns,
          rowId: (row) => row.id,
          density: 'two-line',
          // The session is the card's heading, by when it started, for heading navigation.
          cardTitle: (row) => (
            <>
              Started <Time instant={row.issued_at} />
            </>
          ),
          // A row of this table opens nothing, so its card may hold the act of the row (the table's rule: a card holds no control except where its row opens nothing).
          card: (row) => (
            <>
              <CardFacts
                {...(row.id === me.session.id
                  ? { head: <span className="staff-session__mine">This is your session</span> }
                  : {})}
                facts={[
                  { label: 'Last active', value: <Time instant={row.last_activity_at} /> },
                  { label: 'Expires', value: <Time instant={row.expires_at} /> },
                ]}
              />
              {canRevoke ? endButton(row) : null}
            </>
          ),
        }}
      />

      <ReasonConfirmationDialog<Ended>
        open={target !== undefined}
        title="End this session?"
        consequence={
          <p>
            {mine
              ? 'This is the session you are using. Ending it signs you out.'
              : `${name ?? 'The person'} is signed out of this session at once. They can sign in again.`}
          </p>
        }
        confirmLabel="End session"
        operation="revokeSession"
        retryable
        send={async (command) => {
          try {
            return await revokeSession(client, target?.id ?? '', {
              reasonCode: command.reasonCode,
              ...(command.note === undefined ? {} : { note: command.note }),
            });
          } catch (error) {
            // A session that is already gone is what was asked for: ending an ended session reads as done, not as a failure.
            if (isNotFound(error)) {
              return 'already-ended';
            }
            throw error;
          }
        }}
        onDone={(result) => {
          setTarget(undefined);
          setNotice(
            result === 'already-ended'
              ? 'That session had already ended.'
              : 'The session has ended.',
          );
          void refresh();
        }}
        onCancel={() => {
          setTarget(undefined);
          // A session may have ended while the question was open.
          void refresh();
        }}
        onReload={() => {
          setTarget(undefined);
          return refresh();
        }}
      />
    </>
  );
}

/**
 * The live sessions of one person (surfaces/ops-portal.md section 7, `/admin/sessions`; redesign step R7b), and the means to end one. The person is named by the
 * address (`principal_type`, `principal_id`) because the list is only ever asked for one principal; the page is reached from a profile, and
 * asks for a person first when it is opened without one. It is drawn by the queue workspace template: the sessions are its rows, a table that is cards in a narrow room,
 * and each session has its act where it is read. The list is not paged, filtered or counted, so the template shows no views, filters or pager.
 *
 * What the session may see and end is the server's decision by tier: a staff or vendor session is a Platform Admin's, a rider's a Senior
 * Ops user's at the rider's hub. A refusal of the tier is told plainly. Ending a session needs a reason; one that had already ended reads as
 * done, because that is what was asked for, and the list is read again so what is shown is what is open.
 */
export function SessionsPage() {
  const [params] = useSearchParams();
  const rawType = params.get('principal_type');
  const rawId = params.get('principal_id');
  const type = PRINCIPAL_TYPES.find((candidate) => candidate === rawType);
  if (type === undefined || rawId === null || !UUID.test(rawId)) {
    return (
      <>
        <title>Sessions · Melarc Ops Portal</title>
        <PageHeader title="Sessions" description="The sessions that are open now." />
        <ChooseAPerson />
      </>
    );
  }
  return <Sessions key={`${type}:${rawId}`} type={type} principalId={rawId} />;
}
