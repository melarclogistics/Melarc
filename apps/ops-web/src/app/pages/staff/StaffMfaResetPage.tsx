import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useParams } from 'react-router';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { ForbiddenState } from '../../../components/ui/forbidden-state/ForbiddenState';
import { Link } from '../../../components/ui/link/Link';
import {
  PageHeader,
  type BreadcrumbEntry,
  type PageHeaderProps,
} from '../../../components/ui/page-header/PageHeader';
import { ReasonConfirmationDialog } from '../../../components/ui/reason-confirmation/ReasonConfirmationDialog';
import { TaskForm, TaskFormSection, TaskFormWide } from '../../../components/ui/templates/TaskForm';
import { useApiClient } from '../../../platform/api/api-client';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { resetStaffMfa } from '../../../platform/staff/staff-commands';
import type { MfaResetOutcome, StaffIdentityView } from '../../../platform/staff/staff-shape';
import type { StaffRecord } from '../../../platform/staff/use-staff-queries';
import { formatInstant } from '../../../platform/time/format-time';
import { useFocusFallenToHeading, WithProfile } from './WithProfile';
import './staff-pages.css';

const NOT_ELIGIBLE =
  'An authenticator can be reset only for a profile that has one, or whose set-up was started and not finished.';

/**
 * The pages above the reset: the staff list, then the person, which is the way back to the profile and so the only way back this page draws. The person is named once the profile is read;
 * until then the entry says "The profile" and goes to the same page.
 */
function wayUp(id: string, name: string | undefined): readonly BreadcrumbEntry[] {
  return [
    { label: 'Staff', to: '/admin/staff' },
    { label: name ?? 'The profile', to: `/admin/staff/${id}` },
  ];
}

function sessionsText(count: number): string {
  if (count === 0) return 'No session was open.';
  return count === 1 ? '1 session was ended.' : `${String(count)} sessions were ended.`;
}

/** What the reset came to, in words. There is nothing in it that opens an account: the link goes to the person it is for. */
function Done({
  identity,
  outcome,
}: {
  readonly identity: StaffIdentityView;
  readonly outcome: MfaResetOutcome;
}) {
  const box = useRef<HTMLDivElement>(null);
  // The button that was here is gone: a keyboard user lands on what replaced it.
  useEffect(() => {
    box.current?.focus();
  }, []);
  const until = outcome.grantExpiresAt === null ? undefined : formatInstant(outcome.grantExpiresAt);
  const where = identity.work_email;
  const link = outcome.coalesced
    ? `Nothing new was sent. A link to set up a new authenticator was already on its way to ${where}.`
    : outcome.grantIssued
      ? `A link to set up a new authenticator is on its way to ${where}.`
      : undefined;
  return (
    <div className="staff-created" ref={box} tabIndex={-1}>
      <div className="staff-created__alert">
        <Alert variant="success">
          <h2 className="staff-created__heading">Authenticator reset</h2>
          <p>{sessionsText(outcome.sessionsTerminated)}</p>
          {link === undefined ? null : (
            <p>{`${link}${until === undefined ? '' : ` It works until ${until}.`}`}</p>
          )}
        </Alert>
      </div>
      <p className="staff-action__text">
        {identity.full_name} sets up the new authenticator themselves and then signs in as usual.
        You will not see the link.
      </p>
      <div className="staff-action__buttons">
        <ButtonLink to={`/admin/staff/${identity.id}`}>Back to profile</ButtonLink>
      </div>
    </div>
  );
}

/** The page's header: what the form is and for whom, with the way up (the task form draws it; every other state of the page draws it itself). */
type Header = Pick<PageHeaderProps, 'title' | 'description' | 'breadcrumb'>;

function Reset({
  record,
  query,
  outcome,
  onDone,
}: {
  readonly record: StaffRecord;
  readonly query: UseQueryResult<StaffRecord>;
  readonly outcome: MfaResetOutcome | undefined;
  readonly onDone: (outcome: MfaResetOutcome) => void;
}) {
  const client = useApiClient();
  const me = useSignedInSession();
  const [asking, setAsking] = useState(false);
  // The page draws its own heading once the profile is read (the one the wrapper drew while it loaded is gone): focus is put on it if the old one's has fallen.
  useFocusFallenToHeading();
  const { identity, etag } = record;
  const name = identity.full_name;

  if (me === undefined) return null;
  const branch = identity.mfa_reset_state;
  const mine = identity.id.toLowerCase() === me.session.principal_id?.toLowerCase();
  const header: Header = {
    title: 'Reset authenticator',
    description: name,
    breadcrumb: wayUp(identity.id, name),
  };

  if (outcome !== undefined) {
    return (
      <>
        <PageHeader {...header} />
        <Done identity={identity} outcome={outcome} />
      </>
    );
  }
  if (branch === 'NOT_ELIGIBLE') {
    return (
      <>
        <PageHeader {...header} />
        <ForbiddenState kind="unavailable-here" />
        <p className="staff-action__text">{NOT_ELIGIBLE}</p>
      </>
    );
  }
  if (mine) {
    return (
      <>
        <PageHeader {...header} />
        <p className="staff-note">
          You cannot reset your own authenticator. Another Platform Admin has to do it.
        </p>
      </>
    );
  }

  function ask(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    setAsking(true);
  }

  return (
    <>
      <TaskForm
        header={header}
        onSubmit={ask}
        // The only thing entered on this page is in the question of the act (its reason and note, in its dialog): while the question is open, leaving asks first.
        dirty={asking}
        actions={
          <>
            <Button type="submit" variant="danger">
              Reset authenticator
            </Button>
            <Link to={`/admin/staff/${identity.id}`}>Cancel</Link>
          </>
        }
      >
        <TaskFormSection title="What happens">
          <TaskFormWide>
            <p className="staff-action__text">
              {branch === 'FACTOR_ACTIVE'
                ? `${name}’s authenticator stops working, every session of theirs ends, and a link to set up a new one is sent to ${identity.work_email}. You will not see the link: ${name} sets it up themselves.`
                : `${name} started setting up an authenticator and did not finish. The unfinished set-up is cancelled, any session of theirs ends, and a new link is sent to ${identity.work_email}. You will not see the link.`}
            </p>
          </TaskFormWide>
        </TaskFormSection>
      </TaskForm>

      <ReasonConfirmationDialog<MfaResetOutcome>
        open={asking}
        title={`Reset the authenticator of ${name}?`}
        consequence={
          <p>
            Every session of {name} ends. This cannot be undone. A link to set up a new
            authenticator is sent to {identity.work_email}.
          </p>
        }
        confirmLabel="Reset authenticator"
        operation="resetStaffMfa"
        branch={branch}
        version={etag}
        send={(command) =>
          resetStaffMfa(client, identity.id, command.version ?? etag, {
            reasonCode: command.reasonCode,
            ...(command.note === undefined ? {} : { note: command.note }),
          })
        }
        onDone={(result) => {
          setAsking(false);
          onDone(result);
        }}
        onCancel={() => {
          setAsking(false);
        }}
        onReload={() => {
          setAsking(false);
          return query.refetch();
        }}
      />
    </>
  );
}

/**
 * Reset a person's authenticator (surfaces/ops-portal.md section 7, `/admin/staff/{id}/mfa/reset`; redesign step R7b): the act of a Platform Admin when a person
 * has lost the app that proves them. It is drawn by the task form template (COMPONENT_PATTERNS, *TaskForm*): what happens in a section of its own, and the act, with
 * a way out, as the form's actions; the reason is asked in the act's own dialog, which stands beside the form and not in it. The reason is mandatory and comes from the
 * catalogue of the branch the record names (`mfa_reset_state`, never `mfa_enrolled`); the action is not offered for a profile that cannot have one reset, or for one's own.
 *
 * **The page has no field that could show the re-enrolment grant**, and nothing it reads carries one: the grant goes to the work email of
 * the person it is for, and the administrator who resets the factor must not be able to enrol one on another person's account. What the
 * page can say is how many sessions ended and when the link that was sent lapses.
 */
export function StaffMfaResetPage() {
  const { id = '' } = useParams();
  const [outcome, setOutcome] = useState<MfaResetOutcome | undefined>(undefined);
  return (
    <WithProfile
      id={id}
      ownsHeading
      heading={(identity) => ({
        title: 'Reset authenticator',
        documentTitle: 'Reset authenticator',
        breadcrumb: wayUp(id, identity?.full_name),
        ...(identity === undefined ? {} : { description: identity.full_name }),
      })}
      // The breadcrumb of the page's parents is its way back, in every state; there is no link of its own above it. Once the reset is done the news has its own button to the profile.
      back={null}
    >
      {(record, query) => (
        <Reset record={record} query={query} outcome={outcome} onDone={setOutcome} />
      )}
    </WithProfile>
  );
}
