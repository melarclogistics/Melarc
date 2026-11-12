import { useState } from 'react';
import { useNavigate } from 'react-router';

import { FormPage } from '../../../components/FormPage';
import { PageHeading } from '../../../components/PageHeading';
import { Button } from '../../../components/ui/button/Button';
import { Field } from '../../../components/ui/field/Field';
import { emptyField, fieldText, useSubmission } from '../../../components/ui/form/use-submission';
import { Link } from '../../../components/ui/link/Link';
import { PasswordInput } from '../../../components/ui/password-input/PasswordInput';
import { useApiClient } from '../../../platform/api/api-client';
import { answerOf, unexpectedResponse } from '../../../platform/api/api-response';
import { passwordFault } from '../../../platform/auth/password-rule';
import { parseCredentialSetupResult } from '../../../platform/auth/pre-sign-in-shape';
import { useGrantToken } from '../../../platform/auth/use-grant-token';
import { copyFor, problemOf } from '../../../platform/problem/problem-copy';
import { MAX_HOLD_MS } from '../../../platform/secrets/use-transient-secret';
import { SETUP_MFA_PATH, SIGN_IN_PATH } from '../../../platform/session/paths';
import { GrantProblem } from './GrantProblem';
import { NoReferrer } from './NoReferrer';
import { FocusedRegion, FormNotice, noticeOf, refusesField, type Notice } from './notice';
import { ENROLLING_STATE, usePreSignInFlow } from './pre-sign-in-flow';

const OPERATION = 'completeStaffCredentialSetup';

const RULE_HELP = '12 to 128 characters. Spaces are allowed. Nothing else is required.';
const RULE_ERROR =
  copyFor({ operation: OPERATION, context: 'password', code: 'VALIDATION_FAILED' }) ??
  'Use 12 to 128 characters. Spaces are allowed, and nothing else is required.';

type Outcome = 'open' | 'refused' | 'done';

/**
 * `/setup/credential` (`completeStaffCredentialSetup`; AC-SLICE-000-33, -87, -88, -92). An employee sets their own first password from the grant
 * a message carries in the fragment of its link. **A grant is not a session**: the page is in the neutral frame, draws no shell, and asks for no
 * session.
 *
 * - **Opening the page redeems nothing.** The grant is read from the fragment once, the fragment is removed from the address, and nothing is sent
 *   until the person submits (`useGrantToken`).
 * - **One error** for a link that carries no grant and for a grant that cannot be used, whichever way (`GrantProblem`); it does not re-open the form.
 * - **The rule is shown before it is broken**, in the field's help, and checked the way the contract counts (`passwordFault`); the server decides.
 *   The password is read from the form when it is sent, is never trimmed, and is not left in the field once the server has answered.
 * - **An ordinary employee** is told the next step is to sign in. **A privileged one** is taken on to set up an authenticator, with the material
 *   and the continuation grant handed over in memory; the password alone does not make them able to sign in.
 */
export function SetupCredentialPage() {
  const client = useApiClient();
  const navigate = useNavigate();
  const grant = useGrantToken();
  const { enrolment } = usePreSignInFlow();
  const [outcome, setOutcome] = useState<Outcome>('open');
  const [passwordError, setPasswordError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  // On the way to the authenticator step. Using the grant up empties it, and a page that finds none would call the link bad.
  const [leaving, setLeaving] = useState(false);

  const submission = useSubmission(async (form) => {
    const token = grant.token;
    if (token === undefined) return 'failed';
    const password = fieldText(form, 'password');
    setNotice(undefined);
    if (passwordFault(password) !== undefined) {
      setPasswordError(RULE_ERROR);
      return 'invalid';
    }
    setPasswordError(undefined);

    // A flow is begun before the request is sent: the material of an authenticator is held only if the flow is still current when it arrives.
    const flow = enrolment.begin();
    try {
      const answer = answerOf(
        await client.POST('/auth/staff/setup/credential', {
          body: { setup_token: token, password },
          signal: flow.signal,
        }),
      );
      // A password that was set is a fact even when the flow that set it was called off, and it carries no session and no navigation: the
      // answer is read, and the material of an authenticator it may carry is refused by `hold` below if its flow is gone.
      const result = parseCredentialSetupResult(answer.data);
      if (result === undefined) throw unexpectedResponse(answer.status);
      emptyField(form, 'password');

      if (result.kind === 'ready') {
        grant.clear();
        setOutcome('done');
        return 'accepted';
      }
      const held = enrolment.hold(
        flow,
        { otpauthUri: result.otpauthUri, setupToken: result.setupToken },
        MAX_HOLD_MS,
      );
      if (!held) return 'failed';
      setLeaving(true);
      grant.clear();
      void navigate(SETUP_MFA_PATH, { replace: true, state: ENROLLING_STATE });
      return 'accepted';
    } catch (error) {
      // A failure of a flow that was called off is as little the screen's as its success (see above).
      if (!flow.current()) {
        emptyField(form, 'password');
        return 'failed';
      }
      const problem = problemOf(error, { operation: OPERATION });
      if (problem.kind === 'stale' || problem.kind === 'session-ended') return 'failed';

      const field = emptyField(form, 'password');
      if (problem.code === 'SETUP_GRANT_INVALID') {
        grant.clear();
        setOutcome('refused');
        return 'failed';
      }
      if (problem.kind === 'invalid' && refusesField(problem, '/password')) {
        setPasswordError(RULE_ERROR);
        return 'invalid';
      }
      setNotice(noticeOf(problem, OPERATION));
      field?.focus();
      return 'failed';
    }
  });

  if (leaving) return null;

  if (outcome === 'done') {
    return (
      <>
        <NoReferrer />
        <title>Password set · Melarc Ops Portal</title>
        <FocusedRegion>
          <PageHeading>Your password is set</PageHeading>
          <FormPage>
            <p>The next step is to sign in.</p>
            <p>
              <Link to={SIGN_IN_PATH}>Go to sign-in</Link>
            </p>
          </FormPage>
        </FocusedRegion>
      </>
    );
  }

  // The fragment is still in the address: it is being read, and the page has nothing to say yet.
  if (grant.reading) return <NoReferrer />;

  if (outcome === 'refused' || grant.status !== 'held') {
    return (
      <>
        <NoReferrer />
        <GrantProblem focus={outcome === 'refused'} />
      </>
    );
  }

  return (
    <>
      <NoReferrer />
      <title>Set your password · Melarc Ops Portal</title>
      <PageHeading>Set your password</PageHeading>
      <FormPage>
        {notice === undefined ? null : <FormNotice notice={notice} />}
        <form {...submission.formProps}>
          <Field label="New password" required help={RULE_HELP} error={passwordError}>
            <PasswordInput name="password" autoComplete="new-password" />
          </Field>
          <div className="ui-form-page__actions">
            <Button type="submit" loading={submission.pending}>
              Set password
            </Button>
          </div>
        </form>
      </FormPage>
    </>
  );
}
