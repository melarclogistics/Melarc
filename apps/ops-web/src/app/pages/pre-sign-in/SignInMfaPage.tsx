import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';

import { FormPage } from '../../../components/FormPage';
import { PageHeading } from '../../../components/PageHeading';
import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { Checkbox } from '../../../components/ui/checkbox/Checkbox';
import { CodeInput } from '../../../components/ui/code-input/CodeInput';
import { Field } from '../../../components/ui/field/Field';
import {
  emptyField,
  fieldChecked,
  fieldText,
  useSubmission,
} from '../../../components/ui/form/use-submission';
import { Link } from '../../../components/ui/link/Link';
import { useApiClient } from '../../../platform/api/api-client';
import { answerOf, unexpectedResponse } from '../../../platform/api/api-response';
import { copyFor, problemOf } from '../../../platform/problem/problem-copy';
import { useSessionStore } from '../../../platform/session/session-context';
import { LANDING_PATH, SIGN_IN_PATH } from '../../../platform/session/paths';
import { parseCurrentSession } from '../../../platform/session/session-shape';
import { FocusedRegion, FormNotice, noticeOf, type Notice } from './notice';
import { usePreSignInFlow } from './pre-sign-in-flow';

const OPERATION = 'completeStaffMfaSignIn';

/**
 * How an attempt ends at the second step. These are the refusals that finish it, each its own state with its own words (ops-portal.md section 7:
 * four refusals, four states, not merged). A wrong code is not among them: it leaves the attempt open.
 */
type Ending = 'finished' | 'expired' | 'locked' | 'enrolment-required';

/** The code of the table whose words each ending uses. */
const ENDING_WORDS: Readonly<Record<Ending, string>> = {
  finished: 'CHALLENGE_UNUSABLE',
  expired: 'CHALLENGE_EXPIRED',
  locked: 'CREDENTIAL_LOCKED',
  'enrolment-required': 'MFA_ENROLMENT_REQUIRED',
};

function endingOf(code: string | undefined): Ending | undefined {
  switch (code) {
    case 'CHALLENGE_UNUSABLE':
    case 'INVALID_CREDENTIALS':
      // The second one is the identity stopping being eligible between the steps: the attempt is finished, and the person is not told why.
      return 'finished';
    case 'CHALLENGE_EXPIRED':
      return 'expired';
    case 'CREDENTIAL_LOCKED':
      return 'locked';
    case 'MFA_ENROLMENT_REQUIRED':
      return 'enrolment-required';
    default:
      return undefined;
  }
}

const SIX_DIGITS = /^[0-9]{6}$/;
const SIX_DIGITS_WORDS =
  copyFor({ operation: OPERATION, context: 'code', code: 'VALIDATION_FAILED' }) ??
  'Enter the six digits shown in your authenticator app.';

/**
 * `/sign-in/mfa` (`completeStaffMfaSignIn`; AC-SLICE-000-02, -03, -79, -80, -123, -126). The second factor of a privileged sign-in. The person
 * holds a challenge, not a session: **this page must not look like the application**, and it draws no navigation, no user menu and no data. It is
 * inside the neutral frame, and it asks the API for no session.
 *
 * **The one choice the page offers** (staff-authentication.md section 5.8, AC-SLICE-000-138): *Remember this browser for N days*, off unless the
 * person turns it on. N is the number the challenge carries (`trusted_browser_days`), never one of the page's own. It is sent as `trust_browser`
 * with the code, and a refused code, a finished attempt and a lock remember nothing; the page never sees the credential it asks for (the cookie is
 * `HttpOnly` and set by the server), and says nothing different when the browser is not remembered.
 *
 * The challenge came from the first step and lives in memory only; a visit with none (a direct visit, a reload) goes back to the first step.
 * A wrong code leaves the attempt open and says so without saying how many are left; a finished attempt, a slow one, a lock and a missing
 * authenticator each end it in a state of their own, and the challenge is forgotten with it. A lock is told here and nowhere earlier, because the
 * person has proved the password.
 */
export function SignInMfaPage() {
  const client = useApiClient();
  const store = useSessionStore();
  const navigate = useNavigate();
  const { challenge } = usePreSignInFlow();
  const [ending, setEnding] = useState<Ending | undefined>(undefined);
  const [codeError, setCodeError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  // The person is on their way to the landing. Signing in clears the challenge, and a page that finds none would send them back.
  const [leaving, setLeaving] = useState(false);

  const submission = useSubmission(async (form) => {
    const held = challenge.value;
    if (held === undefined) return 'failed';
    const code = fieldText(form, 'code');
    // Read now, at submit time, and not kept: it is the person's choice for this attempt alone.
    const remember = fieldChecked(form, 'trust_browser');
    setNotice(undefined);
    if (!SIX_DIGITS.test(code)) {
      setCodeError(SIX_DIGITS_WORDS);
      return 'invalid';
    }
    setCodeError(undefined);

    const flow = challenge.begin();
    try {
      const answer = answerOf(
        await client.POST('/auth/staff/sign-in/mfa', {
          body: {
            challenge_id: held.challenge_id,
            code,
            // Sent only when the person chose it: absent is the contract's `false`.
            ...(remember ? { trust_browser: true } : {}),
          },
          signal: flow.signal,
        }),
      );
      // The flow was called off while the request was on its way (the person left, the session ended or was replaced, another ask began): this
      // answer is for a screen that has gone, whatever it says, and so changes no state, navigates nowhere and shows nothing. The server may
      // have acted on it all the same; the next read of the session (`GET /auth/session`) is how the page learns what it holds, and no sign-out
      // is sent in its place, because that could end a session that is not this attempt's.
      if (!flow.current()) {
        emptyField(form, 'code');
        return 'failed';
      }
      const session = parseCurrentSession(answer.data);
      if (answer.status !== 200 || session === undefined) throw unexpectedResponse(answer.status);
      setLeaving(true);
      store.signedIn(session);
      void navigate(LANDING_PATH, { replace: true });
      return 'accepted';
    } catch (error) {
      // A failure of a flow that was called off is as little the screen's as its success (see above): it does not end the attempt of a
      // challenge that another flow now holds, and it shows no word about a request that nobody is waiting for.
      if (!flow.current()) {
        emptyField(form, 'code');
        return 'failed';
      }
      const problem = problemOf(error, { operation: OPERATION });
      if (problem.kind === 'stale' || problem.kind === 'session-ended') return 'failed';

      const field = emptyField(form, 'code');

      const finishedBy = endingOf(problem.code);
      if (finishedBy !== undefined) {
        challenge.clear();
        setEnding(finishedBy);
        return 'failed';
      }
      if (problem.code === 'MFA_PROOF_INVALID') {
        setCodeError(problem.message);
        return 'invalid';
      }
      if (problem.kind === 'invalid') {
        setCodeError(SIX_DIGITS_WORDS);
        return 'invalid';
      }
      setNotice(noticeOf(problem, OPERATION));
      field?.focus();
      return 'failed';
    }
  });

  if (leaving) return null;
  // The router has moved on and the challenge went with it (the review of f6cf02b): the page is on its way out and draws nothing, and does not send the person back to the first step over the
  // navigation they made.
  if (challenge.moved) return null;
  // The number of days is the server's, held with the challenge; a page that has none has no challenge to offer it for.
  const days = challenge.value?.trusted_browser_days ?? 0;

  // A challenge held longer than a page holds a secret is one that took too long; the server would say so, and the person need not wait for it.
  const shown = ending ?? (challenge.status === 'expired' ? 'expired' : undefined);
  if (shown === undefined && challenge.status === 'none') {
    return <Navigate to={SIGN_IN_PATH} replace />;
  }

  return (
    <>
      <title>Enter your code · Melarc Ops Portal</title>
      <PageHeading>Enter your code</PageHeading>
      <FormPage>
        {shown === undefined ? (
          <>
            {notice === undefined ? null : <FormNotice notice={notice} />}
            <form {...submission.formProps}>
              <Field
                label="Authenticator code"
                required
                help="The six digits shown in your authenticator app."
                error={codeError}
              >
                <CodeInput name="code" />
              </Field>
              <Checkbox
                name="trust_browser"
                label={`Remember this browser for ${String(days)} ${days === 1 ? 'day' : 'days'}`}
                help="You will not be asked for a code here until then. Your password is still asked every time. Leave this off on a shared computer."
              />
              <div className="ui-form-page__actions">
                <Button type="submit" loading={submission.pending}>
                  Verify and sign in
                </Button>
              </div>
            </form>
          </>
        ) : (
          <FocusedRegion>
            <Alert variant="danger" announce>
              <p>{copyFor({ operation: OPERATION, code: ENDING_WORDS[shown] })}</p>
            </Alert>
            <p>
              <Link to={SIGN_IN_PATH}>
                {shown === 'finished' || shown === 'expired' ? 'Sign in again' : 'Back to sign-in'}
              </Link>
            </p>
          </FocusedRegion>
        )}
      </FormPage>
    </>
  );
}
