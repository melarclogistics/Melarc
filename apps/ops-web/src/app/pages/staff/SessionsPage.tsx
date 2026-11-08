import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import { PageHeader } from '../../../components/PageHeader';
import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { EmptyState } from '../../../components/ui/empty-state/EmptyState';
import { Link } from '../../../components/ui/link/Link';
import { ReasonConfirmationDialog } from '../../../components/ui/reason-confirmation/ReasonConfirmationDialog';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { Table, type TableColumn } from '../../../components/ui/table/Table';
import { useApiClient } from '../../../platform/api/api-client';
import { isNotFound } from '../../../platform/api/api-response';
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
  const problem =
    sessions.status === 'error'
      ? problemOf(sessions.error, { operation: 'listSessions' })
      : undefined;

  function refresh(): Promise<unknown> {
    return sessions.refetch();
  }

  const columns: TableColumn<SessionRecordView>[] = [
    {
      key: 'started',
      header: 'Started',
      cell: (row) => (
        <>
          <Time instant={row.issued_at} />
          {row.id === me.session.id ? (
            <span className="staff-session__mine">This is your session</span>
          ) : null}
        </>
      ),
    },
    {
      key: 'active',
      header: 'Last active',
      cell: (row) => <Time instant={row.last_activity_at} />,
    },
    { key: 'expires', header: 'Expires', cell: (row) => <Time instant={row.expires_at} /> },
    ...(canRevoke
      ? [
          {
            key: 'action',
            header: 'Action',
            cell: (row: SessionRecordView) => {
              const started =
                row.issued_at === undefined ? undefined : formatInstant(row.issued_at);
              return (
                <Button
                  type="button"
                  variant="danger"
                  {...(started === undefined
                    ? {}
                    : { 'aria-label': `End session started ${started}` })}
                  onClick={() => {
                    setTarget(row);
                  }}
                >
                  End session
                </Button>
              );
            },
          },
        ]
      : []),
  ];

  return (
    <>
      <title>Sessions · Melarc Ops Portal</title>
      {type === 'STAFF' ? (
        <p className="staff-back">
          <Link to={`/admin/staff/${principalId}`}>Back to profile</Link>
        </p>
      ) : null}
      <PageHeader title="Sessions" description={`Open sessions of ${who}.`} />

      {notice === undefined ? null : (
        <div className="staff-notice" ref={noticeBox} tabIndex={-1}>
          <Alert variant="success">
            <p>{notice}</p>
          </Alert>
        </div>
      )}

      {problem?.forbidden === 'insufficient-authority' ? (
        <Alert variant="danger" title="A higher authority is needed" announce>
          <p>{problem.message}</p>
        </Alert>
      ) : (
        <ReadState<SessionRecordView[]>
          query={sessions}
          isEmpty={(data) => data.length === 0}
          empty={
            <EmptyState kind="none" heading="No open sessions">
              {name ?? 'This person'} is not signed in anywhere.
            </EmptyState>
          }
          loadingLabel="Loading the sessions…"
          skeleton={<Skeleton lines={3} />}
          permission="staff.read"
          operation="listSessions"
        >
          {(data) => (
            <>
              <Table
                caption="Open sessions"
                hideCaption
                columns={columns}
                rows={data}
                rowKey={(row) => row.id}
              />
              {canRevoke ? null : (
                <p className="staff-note">
                  Ending a session needs the permission <code>staff.session.revoke</code>, which
                  your session does not hold.
                </p>
              )}
            </>
          )}
        </ReadState>
      )}

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
 * The live sessions of one person (surfaces/ops-portal.md section 7, `/admin/sessions`), and the means to end one. The person is named by the
 * address (`principal_type`, `principal_id`) because the list is only ever asked for one principal; the page is reached from a profile, and
 * asks for a person first when it is opened without one.
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
