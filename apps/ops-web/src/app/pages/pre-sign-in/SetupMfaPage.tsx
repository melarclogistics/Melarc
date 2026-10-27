import { useState } from 'react';
import { useNavigate } from 'react-router';

import { FormPage } from '../../../components/FormPage';
import { PageHeading } from '../../../components/PageHeading';
import { Button } from '../../../components/ui/button/Button';
import { CodeInput } from '../../../components/ui/code-input/CodeInput';
import { Field } from '../../../components/ui/field/Field';
import { emptyField, fieldText, useSubmission } from '../../../components/ui/form/use-submission';
import { OneTimeSecret } from '../../../components/ui/one-time-secret/OneTimeSecret';
import { QrCode } from '../../../components/ui/qr-code/QrCode';
import { useApiClient } from '../../../platform/api/api-client';
import { answerOf, unexpectedResponse } from '../../../platform/api/api-response';
import {
  parseMfaEnrolmentResult,
  parseMfaReenrolmentBegun,
} from '../../../platform/auth/pre-sign-in-shape';
import { useGrantToken } from '../../../platform/auth/use-grant-token';
import { copyFor, problemOf } from '../../../platform/problem/problem-copy';
import { manualKeyOf } from '../../../platform/secrets/otpauth';
import { MAX_HOLD_MS } from '../../../platform/secrets/use-transient-secret';
import { SETUP_MFA_COMPLETE_PATH } from '../../../platform/session/paths';
import { GrantProblem } from './GrantProblem';
import { NoReferrer } from './NoReferrer';
import { FormNotice, noticeOf, type Notice } from './notice';
import { ENROLLED_STATE, usePreSignInFlow } from './pre-sign-in-flow';

const BEGIN_OPERATION = 'beginMfaReenrolment';
const ENROL_OPERATION = 'completeMfaEnrolment';

const SIX_DIGITS = /^[0-9]{6}$/;
const SIX_DIGITS_WORDS =
  copyFor({ operation: ENROL_OPERATION, context: 'code', code: 'VALIDATION_FAILED' }) ??
  'Enter the six digits shown in your authenticator app.';

/**
 * `/setup/mfa` (`beginMfaReenrolment`, `completeMfaEnrolment`; AC-SLICE-000-92, -94, -126). A privileged employee enrols an authenticator and
 * proves a code. Two ways in, one screen:
 *
 * - **from the first password** (`/setup/credential`): the material of the authenticator and the continuation grant were handed over in memory;
 * - **from a re-enrolment link** (after a reset): the grant is in the fragment, **opening the page redeems nothing**, and the person presses
 *   "Begin set-up" to exchange it for the material and the continuation grant.
 *
 * The QR code and the key to type by hand are shown together, once; the key is the accessible alternative to the picture. Both are
 * transient credentials (OB-23): in memory only, never a link, never a copy button, and gone when the screen is left, finished, hidden or
 * timed out. A wrong code leaves the authenticator not set up, and says so; only a proven code makes it one. No session is issued here.
 */
export function SetupMfaPage() {
  const client = useApiClient();
  const navigate = useNavigate();
  const grant = useGrantToken();
  const { enrolment } = usePreSignInFlow();
  const [refused, setRefused] = useState(false);
  const [codeError, setCodeError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  // On the way to the confirmation. Proving the code empties the material, and a page that finds none would call the link bad.
  const [leaving, setLeaving] = useState(false);

  const material = enrolment.value;
  const key = material === undefined ? undefined : manualKeyOf(material.otpauthUri);

  const beginning = useSubmission(async () => {
    const token = grant.token;
    if (token === undefined) return 'failed';
    setNotice(undefined);

    // A flow is begun before the request is sent: the material is held only if the flow is still current when the answer arrives.
    const flow = enrolment.begin();
    try {
      const answer = answerOf(
        await client.POST('/auth/staff/setup/mfa/begin', {
          body: { setup_token: token },
          signal: flow.signal,
        }),
      );
      // The flow was called off while the request was on its way (the person left, the session ended or was replaced, another ask began): this
      // answer is for a screen that has gone, whatever it says, and so changes no state, navigates nowhere and shows nothing. The server may
      // have acted on it all the same; the next read of the session (`GET /auth/session`) is how the page learns what it holds, and no sign-out
      // is sent in its place, because that could end a session that is not this attempt's.
      if (!flow.current()) return 'failed';
      const next = parseMfaReenrolmentBegun(answer.data);
      if (next === undefined) throw unexpectedResponse(answer.status);
      if (!enrolment.hold(flow, next, MAX_HOLD_MS)) return 'failed';
      grant.clear();
      return 'accepted';
    } catch (error) {
      if (!flow.current()) return 'failed';
      const problem = problemOf(error, { operation: BEGIN_OPERATION });
      if (problem.kind === 'stale' || problem.kind === 'session-ended') return 'failed';
      if (problem.code === 'SETUP_GRANT_INVALID') {
        grant.clear();
        setRefused(true);
        return 'failed';
      }
      setNotice(noticeOf(problem, BEGIN_OPERATION));
      return 'failed';
    }
  });

  const proving = useSubmission(async (form) => {
    const held = enrolment.value;
    if (held === undefined) return 'failed';
    const code = fieldText(form, 'code');
    setNotice(undefined);
    if (!SIX_DIGITS.test(code)) {
      setCodeError(SIX_DIGITS_WORDS);
      return 'invalid';
    }
    setCodeError(undefined);

    const flow = enrolment.begin();
    try {
      const answer = answerOf(
        await client.POST('/auth/staff/setup/mfa', {
          body: { setup_token: held.setupToken, totp_code: code },
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
      if (!parseMfaEnrolmentResult(answer.data)) throw unexpectedResponse(answer.status);
      setLeaving(true);
      enrolment.clear();
      void navigate(SETUP_MFA_COMPLETE_PATH, { replace: true, state: ENROLLED_STATE });
      return 'accepted';
    } catch (error) {
      if (!flow.current()) {
        emptyField(form, 'code');
        return 'failed';
      }
      const problem = problemOf(error, { operation: ENROL_OPERATION });
      if (problem.kind === 'stale' || problem.kind === 'session-ended') return 'failed';

      const field = emptyField(form, 'code');
      if (problem.code === 'SETUP_GRANT_INVALID') {
        enrolment.clear();
        setRefused(true);
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
      setNotice(noticeOf(problem, ENROL_OPERATION));
      field?.focus();
      return 'failed';
    }
  });

  if (leaving) return null;
  if (grant.reading) return <NoReferrer />;

  if (refused) {
    return (
      <>
        <NoReferrer />
        <GrantProblem focus />
      </>
    );
  }

  if (material !== undefined && key !== undefined) {
    return (
      <>
        <NoReferrer />
        <title>Set up your authenticator · Melarc Ops Portal</title>
        <PageHeading>Set up your authenticator</PageHeading>
        <FormPage>
          {notice === undefined ? null : <FormNotice notice={notice} />}
          <section aria-label="Authenticator set-up">
            <p>
              Scan this code with your authenticator app, or type the setup key into it by hand.
              Either sets up the same authenticator.
            </p>
            <p>
              The code and the key are shown once, and are not kept. Your authenticator is not set
              up until you enter a code from it.
            </p>
            <QrCode payload={material.otpauthUri} label="QR code for your authenticator app" />
            <OneTimeSecret
              label="Setup key"
              secret={key}
              help="Type this key into your authenticator app if you cannot scan the code."
            />
            <form {...proving.formProps}>
              <Field
                label="Authenticator code"
                required
                help="The six digits your authenticator app shows after you add it."
                error={codeError}
              >
                <CodeInput name="code" />
              </Field>
              <div className="ui-form-page__actions">
                <Button type="submit" loading={proving.pending}>
                  Finish set-up
                </Button>
              </div>
            </form>
          </section>
        </FormPage>
      </>
    );
  }

  if (grant.status === 'held') {
    return (
      <>
        <NoReferrer />
        <title>Set up your authenticator · Melarc Ops Portal</title>
        <PageHeading>Set up your authenticator</PageHeading>
        <FormPage>
          {notice === undefined ? null : <FormNotice notice={notice} />}
          <p>
            You have been asked to set up a new authenticator. Nothing starts until you press the
            button.
          </p>
          <form {...beginning.formProps}>
            <div className="ui-form-page__actions">
              <Button type="submit" loading={beginning.pending}>
                Begin set-up
              </Button>
            </div>
          </form>
        </FormPage>
      </>
    );
  }

  return (
    <>
      <NoReferrer />
      <GrantProblem focus={false} />
    </>
  );
}
