import { useState } from 'react';

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
import { useGrantToken } from '../../../platform/auth/use-grant-token';
import {
  copyFor,
  problemOf,
  RECOVERY_LINK_CANNOT_BE_USED,
} from '../../../platform/problem/problem-copy';
import { RECOVERY_PATH, SIGN_IN_PATH } from '../../../platform/session/paths';
import { NoReferrer } from './NoReferrer';
import { FocusedRegion, FormNotice, noticeOf, refusesField, type Notice } from './notice';

const OPERATION = 'completeCredentialRecovery';

const RULE_HELP = '12 to 128 characters. Spaces are allowed. Nothing else is required.';
const RULE_ERROR =
  copyFor({ operation: OPERATION, context: 'password', code: 'VALIDATION_FAILED' }) ??
  'Use 12 to 128 characters. Spaces are allowed, and nothing else is required.';

type Outcome = 'open' | 'refused' | 'done';

/** The one error of a recovery link: it does not say which way, does not re-open the form, and offers sign-in and a new link. */
function RecoveryLinkProblem({ focus }: { readonly focus: boolean }) {
  const content = (
    <>
      <PageHeading>This link cannot be used</PageHeading>
      <FormPage>
        <p>{RECOVERY_LINK_CANNOT_BE_USED}</p>
        <p>
          If you have already set a new password, sign in with it. Otherwise ask for a new link.
        </p>
        <p>
          <Link to={SIGN_IN_PATH}>Go to sign-in</Link>
        </p>
        <p>
          <Link to={RECOVERY_PATH}>Ask for a new link</Link>
        </p>
      </FormPage>
    </>
  );
  return (
    <>
      <title>Link cannot be used · Melarc Ops Portal</title>
      {focus ? <FocusedRegion>{content}</FocusedRegion> : content}
    </>
  );
}

/**
 * `/recovery/complete` (`completeCredentialRecovery`; AC-SLICE-000-22, -36, -87, -103, -106; ops-portal.md section 7). A staff member sets a new
 * password from the recovery link a message carries in its fragment. **A link is not a session**: no shell, no session asked for, and the
 * answer issues none.
 *
 * - **Opening the page redeems nothing.** The token is read from the fragment once, removed from the address, and sent in the body of the one
 *   request the person makes (`useGrantToken`).
 * - **One error** for a malformed, expired, reused or superseded link (`RECOVERY_TOKEN_INVALID`), and for a link that carried none: it never
 *   says which and does not re-open the form.
 * - **The rule is stated before it is broken**, checked as the contract counts (`passwordFault`), and never echoed; the server decides.
 * - **Success says what happened to the account**: the password is replaced, every session that was signed in with it has ended (this
 *   browser's included), the authenticator is unchanged, and the next step is to sign in.
 */
export function RecoveryCompletePage() {
  const client = useApiClient();
  const grant = useGrantToken();
  const [outcome, setOutcome] = useState<Outcome>('open');
  const [passwordError, setPasswordError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);

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
    try {
      const answer = answerOf(
        await client.POST('/auth/recovery/complete', { body: { token, new_credential: password } }),
      );
      if (answer.status !== 204) throw unexpectedResponse(answer.status);
      emptyField(form, 'password');
      grant.clear();
      setOutcome('done');
      return 'accepted';
    } catch (error) {
      const problem = problemOf(error, { operation: OPERATION });
      if (problem.kind === 'stale' || problem.kind === 'session-ended') return 'failed';
      const field = emptyField(form, 'password');
      if (problem.code === 'RECOVERY_TOKEN_INVALID') {
        grant.clear();
        setOutcome('refused');
        return 'failed';
      }
      if (problem.kind === 'invalid' && refusesField(problem, '/new_credential')) {
        setPasswordError(RULE_ERROR);
        return 'invalid';
      }
      setNotice(noticeOf(problem, OPERATION));
      field?.focus();
      return 'failed';
    }
  });

  if (outcome === 'done') {
    return (
      <>
        <NoReferrer />
        <title>Password changed · Melarc Ops Portal</title>
        <FocusedRegion>
          <PageHeading>Your password is changed</PageHeading>
          <FormPage>
            <p>
              Every session that was signed in with your account has ended, on this browser and on
              any other.
            </p>
            <p>
              Your authenticator is unchanged. The next step is to sign in with your new password.
            </p>
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
        <RecoveryLinkProblem focus={outcome === 'refused'} />
      </>
    );
  }

  return (
    <>
      <NoReferrer />
      <title>Set a new password · Melarc Ops Portal</title>
      <PageHeading>Set a new password</PageHeading>
      <FormPage>
        <p>
          Setting a new password ends every session signed in with your account, including any on
          this browser.
        </p>
        {notice === undefined ? null : <FormNotice notice={notice} />}
        <form {...submission.formProps}>
          <Field label="New password" required help={RULE_HELP} error={passwordError}>
            <PasswordInput name="password" autoComplete="new-password" />
          </Field>
          <div className="ui-form-page__actions">
            <Button type="submit" loading={submission.pending}>
              Set new password
            </Button>
          </div>
        </form>
      </FormPage>
    </>
  );
}
