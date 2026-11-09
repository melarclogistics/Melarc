import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { ConfirmationDialog } from '../../../components/ui/confirmation/ConfirmationDialog';
import { ReasonConfirmationDialog } from '../../../components/ui/reason-confirmation/ReasonConfirmationDialog';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { useApiClient } from '../../../platform/api/api-client';
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
import { WithProfile } from './WithProfile';
import { cannotText } from '../../../platform/problem/capability-words';
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
  const hasActions = waiting || mayReissue || mayRecover || mayReset || maySeeSessions;

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

  return (
    <>
      {notice === undefined ? null : (
        <div className="staff-notice" ref={noticeBox} tabIndex={-1}>
          <Alert variant="success">
            <p>{notice}</p>
          </Alert>
        </div>
      )}

      <p className="staff-status">
        <StatusBadge status={identity.status} map={STAFF_STATUS_MAP} />{' '}
        <span>{statusSentence(identity)}</span>
      </p>

      <dl className="staff-facts">
        <dt>Work email</dt>
        <dd>{identity.work_email}</dd>
        <dt>Phone</dt>
        <dd>{identity.phone ?? 'Not given'}</dd>
        {role === undefined ? null : (
          <>
            <dt>Role</dt>
            <dd>{role}</dd>
          </>
        )}
        <dt>Hub</dt>
        <dd>{hubNameOf(identity.primary_hub_id, me.session.authorized_hubs)}</dd>
        {shows ? (
          <>
            <dt>Authenticator</dt>
            <dd>
              {identity.mfa_reset_state === 'ENROLMENT_UNFINISHED'
                ? 'Set-up not finished'
                : 'Set up'}
            </dd>
          </>
        ) : null}
      </dl>

      {hasActions ? (
        <section className="staff-actions" aria-labelledby="staff-actions">
          <h2 id="staff-actions">What you can do</h2>

          {waiting ? (
            <div>
              {!canApprove ? (
                <p className="staff-note">{cannotText('staff.identity.approve')}</p>
              ) : (
                <>
                  <p className="staff-action__text">
                    Check the role and the hub, then approve or reject the profile.
                  </p>
                  {/* The session lists permission keys and no tiers, so the page cannot tell a Platform Admin (who decides what they
                      made) from another maker (who needs a different person): it says who may, and the server decides. */}
                  {mine ? (
                    <p className="staff-note">
                      You created this profile. A Platform Admin can approve or reject a profile
                      they made; anyone else needs a different person to.
                    </p>
                  ) : null}
                  {needsAdmin ? (
                    <p className="staff-note">This role needs a Platform Admin to decide.</p>
                  ) : null}
                  <div className="staff-action__buttons">
                    <Button
                      type="button"
                      loading={refreshing}
                      onClick={() => {
                        setAct('approve');
                      }}
                    >
                      Approve profile
                    </Button>
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
                  </div>
                </>
              )}
            </div>
          ) : null}

          {mayReissue ? (
            <div>
              <p className="staff-action__text">
                If {name}’s first setup link expired or never arrived, send a new one to their work
                email.
              </p>
              <div className="staff-action__buttons">
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
              </div>
            </div>
          ) : null}

          {mayRecover ? (
            <div>
              <p className="staff-action__text">
                If {name} has forgotten their password, send a recovery link to their work email.
                They set the new password themselves; nobody else sees it.
              </p>
              <div className="staff-action__buttons">
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
              </div>
            </div>
          ) : null}

          {mayReset ? (
            <div>
              <p className="staff-action__text">
                If {name} has lost their authenticator app, reset it. Their sessions end, and a link
                to set up a new one is sent to their work email.
              </p>
              <div className="staff-action__buttons">
                <ButtonLink variant="secondary" to={`/admin/staff/${identity.id}/mfa/reset`}>
                  Reset authenticator
                </ButtonLink>
              </div>
            </div>
          ) : null}

          {maySeeSessions ? (
            <div>
              <p className="staff-action__text">
                See where {name} is signed in, and end a session.
              </p>
              <div className="staff-action__buttons">
                <ButtonLink
                  variant="secondary"
                  to={`/admin/sessions?principal_type=STAFF&principal_id=${identity.id}`}
                >
                  See sessions
                </ButtonLink>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {maySeeTrustedBrowsers ? <TrustedBrowsersSection id={identity.id} name={name} /> : null}

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
 * One staff profile (surfaces/ops-portal.md section 7, `/admin/staff/{id}`): who the person is, where the profile stands, and what the
 * session may do with it: approve or reject it (the checker's half of the maker-checker rule), send a new first setup link, go on to reset an
 * authenticator, go on to the person's sessions, and see and remove the browsers they chose to be remembered at (staff-authentication.md
 * section 5.8).
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
      heading={(identity) => {
        const title = identity?.full_name ?? 'Staff profile';
        return { title, documentTitle: title };
      }}
    >
      {(record, query) => <Profile id={id} record={record} query={query} />}
    </WithProfile>
  );
}
