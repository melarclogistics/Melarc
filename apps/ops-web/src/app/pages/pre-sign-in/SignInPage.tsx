import { useState } from 'react';
import { useNavigate } from 'react-router';

import { FormPage } from '../../../components/FormPage';
import { PageHeading } from '../../../components/PageHeading';
import { Button } from '../../../components/ui/button/Button';
import { Field } from '../../../components/ui/field/Field';
import { emptyField, fieldText, useSubmission } from '../../../components/ui/form/use-submission';
import { Input } from '../../../components/ui/input/Input';
import { Link } from '../../../components/ui/link/Link';
import { PasswordInput } from '../../../components/ui/password-input/PasswordInput';
import { useApiClient } from '../../../platform/api/api-client';
import { answerOf, unexpectedResponse } from '../../../platform/api/api-response';
import { signInPasswordTooLong } from '../../../platform/auth/password-rule';
import { parseMfaChallenge } from '../../../platform/auth/pre-sign-in-shape';
import { copyFor, problemOf, type Problem } from '../../../platform/problem/problem-copy';
import { MAX_HOLD_MS } from '../../../platform/secrets/use-transient-secret';
import { useSessionStore } from '../../../platform/session/session-context';
import { LANDING_PATH, RECOVERY_PATH, SIGN_IN_MFA_PATH } from '../../../platform/session/paths';
import { parseCurrentSession } from '../../../platform/session/session-shape';
import { FormNotice, noticeOf, refusesField, type Notice } from './notice';
import { usePreSignInFlow } from './pre-sign-in-flow';

const OPERATION = 'staffSignIn';

const NOT_CORRECT =
  copyFor({ operation: OPERATION, code: 'INVALID_CREDENTIALS' }) ??
  'The email or password is not correct.';
const EMAIL_WORDS =
  copyFor({ operation: OPERATION, context: 'email', code: 'VALIDATION_FAILED' }) ??
  'Enter your work email address.';
const PASSWORD_TOO_LONG =
  copyFor({ operation: OPERATION, context: 'password', code: 'VALIDATION_FAILED' }) ??
  'A password has at most 128 characters.';
const PASSWORD_EMPTY = 'Enter your password.';

/**
 * What the password step says about a failure. It has one refusal: a wrong password, an unknown address, an ineligible identity and a lock are
 * the same answer to the API and to the person, and the page does not offer a state for any of them (ops-portal.md section 7: there is no
 * lockout state on this page). A failure that is not the person's to fix is worded as it is: a wait, a request that could not be verified, one
 * that did not get through, one the server refused for its form. Every other refusal, including one the contract does not give this
 * operation, reads as a wrong password, so that nothing the server might one day say about an address reaches this screen.
 */
function noticeFor(problem: Problem): Notice {
  const asTheyAre =
    problem.code === 'CSRF_VALIDATION_FAILED' ||
    problem.kind === 'unavailable' ||
    problem.kind === 'rate-limited' ||
    problem.kind === 'invalid';
  return asTheyAre ? noticeOf(problem, OPERATION) : { message: NOT_CORRECT };
}

/**
 * `/sign-in` (`staffSignIn`; AC-SLICE-000-01, -02, -04, -77, -81). The email and the password of a staff member. It is reached with no
 * session and asks the API for none.
 *
 * - **200**: an employee who needs no second factor, **or a privileged employee whose browser was remembered** (staff-authentication.md section 5.8:
 *   the server read a valid trusted-browser credential after the password and skipped the code). The page cannot tell which and does not need to:
 *   the session the API answered is the session the application knows, and the person goes to the landing, replacing this entry so the Back
 *   button does not return to the form.
 * - **202**: a privileged employee. The answer is a challenge and not a session: nothing is signed in, no cookie was set, and the page goes to
 *   the second step with the challenge held in memory.
 * - **A refusal** is one sentence, whatever its cause, and the password is emptied.
 */
export function SignInPage() {
  const client = useApiClient();
  const store = useSessionStore();
  const navigate = useNavigate();
  const { challenge } = usePreSignInFlow();
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [passwordError, setPasswordError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);

  const submission = useSubmission(async (form) => {
    const email = fieldText(form, 'email');
    const password = fieldText(form, 'password');
    const emailFault = email.trim() === '' ? EMAIL_WORDS : undefined;
    const passwordFault =
      password === ''
        ? PASSWORD_EMPTY
        : signInPasswordTooLong(password)
          ? PASSWORD_TOO_LONG
          : undefined;
    setEmailError(emailFault);
    setPasswordError(passwordFault);
    if (emailFault !== undefined || passwordFault !== undefined) {
      setNotice(undefined);
      return 'invalid';
    }
    setNotice(undefined);

    // A flow is begun before the request is sent and the challenge is held only if the flow is still current when the answer arrives.
    const flow = challenge.begin();
    try {
      const answer = answerOf(
        await client.POST('/auth/staff/sign-in', {
          body: { email, password },
          signal: flow.signal,
        }),
      );
      // The flow was called off while the request was on its way (the person left, the session ended or was replaced, another ask began): this
      // answer is for a screen that has gone, whatever it says, and so changes no state, navigates nowhere and shows nothing. The server may
      // have acted on it all the same; the next read of the session (`GET /auth/session`) is how the page learns what it holds, and no sign-out
      // is sent in its place, because that could end a session that is not this attempt's.
      if (!flow.current()) {
        emptyField(form, 'password');
        return 'failed';
      }

      if (answer.status === 200) {
        const session = parseCurrentSession(answer.data);
        if (session === undefined) throw unexpectedResponse(answer.status);
        emptyField(form, 'password');
        store.signedIn(session);
        void navigate(LANDING_PATH, { replace: true });
        return 'accepted';
      }

      if (answer.status === 202) {
        const next = parseMfaChallenge(answer.data);
        if (next === undefined) throw unexpectedResponse(answer.status);
        emptyField(form, 'password');
        if (!challenge.hold(flow, next, MAX_HOLD_MS)) return 'failed';
        void navigate(SIGN_IN_MFA_PATH);
        return 'accepted';
      }

      throw unexpectedResponse(answer.status);
    } catch (error) {
      // A failure of a flow that was called off is as little the screen's as its success (see above).
      if (!flow.current()) {
        emptyField(form, 'password');
        return 'failed';
      }
      const problem = problemOf(error, { operation: OPERATION });
      // An answer for a session that has gone, or one that ended it, is not this screen's to show.
      if (problem.kind === 'stale' || problem.kind === 'session-ended') return 'failed';

      const password = emptyField(form, 'password');
      if (problem.kind === 'invalid') {
        const email = refusesField(problem, '/email');
        const long = refusesField(problem, '/password');
        if (email || long) {
          setEmailError(email ? EMAIL_WORDS : undefined);
          setPasswordError(long ? PASSWORD_TOO_LONG : undefined);
          return 'invalid';
        }
      }
      setNotice(noticeFor(problem));
      password?.focus();
      return 'failed';
    }
  });

  return (
    <>
      <title>Sign in · Melarc Ops Portal</title>
      <PageHeading>Sign in</PageHeading>
      <FormPage>
        {notice === undefined ? null : <FormNotice notice={notice} />}
        <form {...submission.formProps}>
          <Field label="Work email" required error={emailError}>
            <Input
              name="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Password" required error={passwordError}>
            <PasswordInput name="password" autoComplete="current-password" />
          </Field>
          <div className="ui-form-page__actions">
            <Button type="submit" loading={submission.pending}>
              Sign in
            </Button>
          </div>
        </form>
        <p>
          <Link to={RECOVERY_PATH}>Forgot your password?</Link>
        </p>
      </FormPage>
    </>
  );
}
