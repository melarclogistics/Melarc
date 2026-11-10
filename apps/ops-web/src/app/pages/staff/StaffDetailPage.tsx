import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { ConfirmationDialog } from '../../../components/ui/confirmation/ConfirmationDialog';
import {
  DescriptionList,
  type DescriptionItem,
} from '../../../components/ui/description-list/DescriptionList';
import { Panel } from '../../../components/ui/panel/Panel';
import { ReasonConfirmationDialog } from '../../../components/ui/reason-confirmation/ReasonConfirmationDialog';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { RecordPage } from '../../../components/ui/templates/RecordPage';
import { useApiClient } from '../../../platform/api/api-client';
import { cannotText } from '../../../platform/problem/capability-words';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import {
  decideStaffIdentity,
  recoverStaffCredential,
  reissueSetupLink,
} from '../../../platform/staff/staff-commands';
import type { StaffIdentityView } from '../../../platform/staff/staff-shape';
import { useAssignableBundles, type StaffRecord } from '../../../platform/staff/use-staff-queries';
import { formatInstant } from '../../../platform/time/format-time';
import { hubNameOf, roleNameOf, STAFF_STATUS_MAP } from './staff-presentation';
import { TrustedBrowsersSection } from './TrustedBrowsersSection';
import { useFocusFallenToHeading, WithProfile } from './WithProfile';
import './staff-pages.css';

const BUNDLE_READ = 'permission.assignable_bundle.read';

/** What each status means for the person, in a sentence. */
function statusSentence(identity: StaffIdentityView): string {
  switch (identity.status) {
    case 'PENDING_APPROVAL':
      return `${identity.full_name} cannot sign in until this profile is approved.`;
    case 'ACTIVE':
      return 'This profile is approved and in use.';
    case 'REJECTED':
      return 'This profile cannot be used, and its email address can be used for a new profile.';
    case 'SUSPENDED':
      return `${identity.full_name} cannot sign in until the suspension is lifted.`;
    case 'OFFBOARDED':
      return 'This profile is closed and cannot be used.';
  }
}

type Act = 'approve' | 'reject' | 'reissue' | 'recover';

/**
 * The profile that was read. It is given the read itself and does not ask again: a second observer of a query that is stale the moment it is
 * read would read the profile once more on mount, and a version read twice is a version that changes under the person's hand.
 */
function Profile({
  id,
  record,
  query,
}: {
  readonly id: string;
  readonly record: StaffRecord;
  readonly query: UseQueryResult<StaffRecord>;
}) {
  const client = useApiClient();
  const me = useSignedInSession();
  const bundles = useAssignableBundles(me?.holds(BUNDLE_READ) === true);
  const [act, setAct] = useState<Act | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const noticeBox = useRef<HTMLDivElement>(null);
  // The record page draws the person's name as the heading (the one the wrapper drew while the profile loaded is gone): focus is put on it if the old one's has fallen.
  useFocusFallenToHeading();

  // The news replaces what the person was looking at, so a keyboard user lands on it.
  useEffect(() => {
    if (notice !== undefined) noticeBox.current?.focus();
  }, [notice]);

  if (me === undefined) return null;
  const { identity, etag } = record;
  const name = identity.full_name;
  const roles = bundles.data;
  const role = roles === undefined ? undefined : roleNameOf(identity.role_bundle_id, roles);
  const needsAdmin =
    roles?.find((bundle) => bundle.id.toLowerCase() === identity.role_bundle_id.toLowerCase())
      ?.requires_platform_admin_approval === true;
  const mine = identity.created_by.toLowerCase() === me.session.principal_id?.toLowerCase();
  const canApprove = me.holds('staff.identity.approve');
  const refreshing = query.isFetching;

  const waiting = identity.status === 'PENDING_APPROVAL';
  // A first setup link is for a profile that has no password (STATE_CONFLICT otherwise), and an authenticator that exists or is being
  // set up belongs to a person who has one: the record says no more than that, so the server decides the rest.
  const mayReissue =
    identity.status === 'ACTIVE' && canApprove && identity.mfa_reset_state === 'NOT_ELIGIBLE';
  const mayReset = identity.mfa_reset_state !== 'NOT_ELIGIBLE' && me.holds('staff.mfa.reset');
  // Recovery repairs a password that exists, for a profile that keeps one (a suspension is no bar); the record does not say whether a password is
  // set, so the server answers a profile that has none (STATE_CONFLICT: a setup link reaches it).
  const mayRecover =
    (identity.status === 'ACTIVE' || identity.status === 'SUSPENDED') &&
    me.holds('staff.credential.recover');
  const maySeeSessions = identity.status === 'ACTIVE' && me.holds('staff.session.revoke');
  // Only a person with an authenticator can have asked to be remembered, and ending standing access is the key that ends their sessions.
  const maySeeTrustedBrowsers = maySeeSessions && identity.mfa_enrolled;

  function finish(message: string): void {
    setAct(undefined);
    setNotice(message);
    void query.refetch();
  }
  function reload(): Promise<unknown> {
    setAct(undefined);
    return query.refetch();
  }

  const shows = identity.mfa_enrolled || identity.mfa_reset_state !== 'NOT_ELIGIBLE';
  const facts: DescriptionItem[] = [
    { label: 'Work email', value: identity.work_email },
    { label: 'Phone', value: identity.phone ?? 'Not given' },
    ...(role === undefined ? [] : [{ label: 'Role', value: role }]),
    { label: 'Hub', value: hubNameOf(identity.primary_hub_id, me.session.authorized_hubs) },
    ...(shows
      ? [
          {
            label: 'Authenticator',
            value:
              identity.mfa_reset_state === 'ENROLMENT_UNFINISHED'
                ? 'Set-up not finished'
                : 'Set up',
          },
        ]
      : []),
  ];

  // The decision is the header's: the checker's half of the maker-checker rule, the one thing a waiting profile is for. The session lists permission keys and no tiers, so the page
  // cannot tell a Platform Admin (who decides what they made) from another maker (who needs a different person): it offers the acts to a holder of the key, says in one line who
  // may use them, and the server decides.
  const decision =
    waiting && canApprove
      ? {
          primary: (
            <Button
              type="button"
              loading={refreshing}
              onClick={() => {
                setAct('approve');
              }}
            >
              Approve profile
            </Button>
          ),
          secondary: (
            <Button
              type="button"
              variant="danger"
              loading={refreshing}
              onClick={() => {
                setAct('reject');
              }}
            >
              Reject profile
            </Button>
          ),
        }
      : undefined;

  // What changes whether to act now, in one short muted line under the acts (the Product Owner, 9 November 2026: a rule is in the act's own question, and a paragraph of rules is not
  // drawn above the content): why the session may not decide, that the maker's own profile needs a different person, and that the role needs a Platform Admin. Said in one line.
  const lines = [
    ...(waiting && !canApprove ? [cannotText('staff.identity.approve')] : []),
    ...(waiting && canApprove && mine
      ? [
          'You created this profile. A Platform Admin can approve or reject a profile they made; anyone else needs a different person to.',
        ]
      : []),
    ...(waiting && canApprove && needsAdmin ? ['This role needs a Platform Admin to decide.'] : []),
  ];

  return (
    <>
      <RecordPage
        header={{
          code: name,
          titleKind: 'name',
          status: <StatusBadge status={identity.status} map={STAFF_STATUS_MAP} />,
          sentence: statusSentence(identity),
        }}
        {...(decision === undefined && lines.length === 0
          ? {}
          : { acts: { ...decision, ...(lines.length === 0 ? {} : { note: lines.join(' ') }) } })}
        {...(notice === undefined
          ? {}
          : {
              notice: (
                <div className="staff-notice" ref={noticeBox} tabIndex={-1}>
                  <Alert variant="success">
                    <p>{notice}</p>
                  </Alert>
                </div>
              ),
            })}
        main={
          <>
            <Panel title="Profile">
              <DescriptionList items={facts} />
            </Panel>

            {mayReissue || mayRecover || mayReset ? (
              <Panel title="Credentials">
                <div className="staff-action__buttons">
                  {mayReissue ? (
                    <Button
                      type="button"
                      variant="secondary"
                      loading={refreshing}
                      onClick={() => {
                        setAct('reissue');
                      }}
                    >
                      Send a new setup link
                    </Button>
                  ) : null}
                  {mayRecover ? (
                    <Button
                      type="button"
                      variant="secondary"
                      loading={refreshing}
                      onClick={() => {
                        setAct('recover');
                      }}
                    >
                      Start password recovery
                    </Button>
                  ) : null}
                  {mayReset ? (
                    <ButtonLink variant="secondary" to={`/admin/staff/${identity.id}/mfa/reset`}>
                      Reset authenticator
                    </ButtonLink>
                  ) : null}
                </div>
              </Panel>
            ) : null}

            {maySeeSessions ? (
              <Panel title="Sessions">
                <div className="staff-action__buttons">
                  <ButtonLink
                    variant="secondary"
                    to={`/admin/sessions?principal_type=STAFF&principal_id=${identity.id}`}
                  >
                    See sessions
                  </ButtonLink>
                </div>
              </Panel>
            ) : null}

            {maySeeTrustedBrowsers ? <TrustedBrowsersSection id={identity.id} name={name} /> : null}
          </>
        }
      />

      <ConfirmationDialog<StaffIdentityView>
        open={act === 'approve'}
        title={`Approve ${name}?`}
        consequence={
          <p>
            {name} will be able to set a password and sign in
            {role === undefined ? '' : ` as ${role}`}. A setup link is sent to {identity.work_email}
            .
          </p>
        }
        confirmLabel="Approve profile"
        operation="approveStaffIdentity"
        version={etag}
        send={(command) =>
          decideStaffIdentity(client, id, command.version ?? etag, { approved: true })
        }
        onDone={() => {
          finish(`${name} is approved. A setup link is on its way to ${identity.work_email}.`);
        }}
        onCancel={() => {
          setAct(undefined);
        }}
        onReload={reload}
      />

      <ReasonConfirmationDialog<StaffIdentityView>
        open={act === 'reject'}
        title={`Reject ${name}?`}
        consequence={
          <p>
            Rejecting is final. {name} cannot use this profile, and the email address can be used
            for a new one.
          </p>
        }
        confirmLabel="Reject profile"
        operation="approveStaffIdentity"
        branch="APPROVAL_REJECTED"
        version={etag}
        send={(command) =>
          decideStaffIdentity(client, id, command.version ?? etag, {
            approved: false,
            reasonCode: command.reasonCode,
            ...(command.note === undefined ? {} : { note: command.note }),
          })
        }
        onDone={() => {
          finish(`The profile of ${name} is rejected.`);
        }}
        onCancel={() => {
          setAct(undefined);
        }}
        onReload={reload}
      />

      <ReasonConfirmationDialog
        open={act === 'reissue'}
        title="Send a new setup link?"
        consequence={
          <p>
            A new link is sent to {identity.work_email}. Any earlier link stops working. {name}{' '}
            still sets their own password.
          </p>
        }
        confirmLabel="Send new link"
        confirmVariant="primary"
        operation="reissueStaffCredentialSetup"
        version={etag}
        send={(command) =>
          reissueSetupLink(client, id, command.version ?? etag, {
            reasonCode: command.reasonCode,
            ...(command.note === undefined ? {} : { note: command.note }),
          })
        }
        onDone={(grant) => {
          const until = grant.expiresAt === null ? undefined : formatInstant(grant.expiresAt);
          finish(
            `A new setup link is on its way to ${identity.work_email}.${until === undefined ? '' : ` It works until ${until}.`}`,
          );
        }}
        onCancel={() => {
          setAct(undefined);
        }}
        onReload={reload}
      />

      <ReasonConfirmationDialog
        open={act === 'recover'}
        title="Start password recovery?"
        consequence={
          <p>
            A link to set a new password is sent to {identity.work_email}. {name}’s password and
            authenticator stay as they are until they use it; then every session they hold ends.
          </p>
        }
        confirmLabel="Send recovery link"
        confirmVariant="primary"
        operation="recoverStaffCredential"
        version={etag}
        send={(command) =>
          recoverStaffCredential(client, id, command.version ?? etag, {
            reasonCode: command.reasonCode,
            ...(command.note === undefined ? {} : { note: command.note }),
          })
        }
        onDone={(outcome) => {
          const until = formatInstant(outcome.expiresAt);
          finish(
            outcome.coalesced
              ? `A recovery link sent to ${identity.work_email} a moment ago can still be used, so no new one was sent.`
              : `A recovery link is on its way to ${identity.work_email}.${until === undefined ? '' : ` It works until ${until}.`}`,
          );
        }}
        onCancel={() => {
          setAct(undefined);
        }}
        onReload={reload}
      />
    </>
  );
}

/**
 * One staff profile (surfaces/ops-portal.md section 7, `/admin/staff/{id}`; redesign step R7b): who the person is, where the profile stands, and what the
 * session may do with it, on the record page template (COMPONENT_PATTERNS, *RecordPage*). The header carries the name, the status and the sentence of what it means, and, for a profile that
 * waits, the decision (approve or reject it: the checker's half of the maker-checker rule). The body holds the facts, the acts that change the person's credentials (a new first
 * setup link, a recovery of the password, and the reset of an authenticator, which is a page of its own), the sessions (a page of their own) and the browsers they chose to be
 * remembered at (staff-authentication.md section 5.8), each in a panel, so that acts are grouped by what they change.
 *
 * Every act sends the version the page read (`If-Match`, the `ETag` exactly as the server gave it), so a record that moved is a conflict that
 * is explained and read again, never a silent overwrite. The page can show nothing that opens an account: no credential, no link and no
 * grant is in any answer it reads, and it has no field to put one in. A profile in a hub the session does not act in, and one that is not
 * there, are pages of their own. What the page hides decides nothing: the server refuses every act it should refuse.
 */
export function StaffDetailPage() {
  const { id = '' } = useParams();
  return (
    <WithProfile
      id={id}
      ownsHeading
      heading={(identity) => {
        const title = identity?.full_name ?? 'Staff profile';
        return { title, documentTitle: title };
      }}
    >
      {(record, query) => <Profile id={id} record={record} query={query} />}
    </WithProfile>
  );
}
