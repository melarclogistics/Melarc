import { useState } from 'react';

import { FormPage } from '../../../components/FormPage';
import { PageHeading } from '../../../components/PageHeading';
import { Button } from '../../../components/ui/button/Button';
import { Field } from '../../../components/ui/field/Field';
import { fieldText, useSubmission } from '../../../components/ui/form/use-submission';
import { Input } from '../../../components/ui/input/Input';
import { Link } from '../../../components/ui/link/Link';
import { useApiClient } from '../../../platform/api/api-client';
import { answerOf, unexpectedResponse } from '../../../platform/api/api-response';
import { copyFor, problemOf } from '../../../platform/problem/problem-copy';
import { SIGN_IN_PATH } from '../../../platform/session/paths';
import { NoReferrer } from './NoReferrer';
import { FocusedRegion, FormNotice, noticeOf, refusesField, type Notice } from './notice';

const OPERATION = 'requestCredentialRecovery';

const EMAIL_WORDS =
  copyFor({ operation: OPERATION, context: 'email', code: 'VALIDATION_FAILED' }) ??
  'Enter your work email address.';

/**
 * `/recovery` (`requestCredentialRecovery`; AC-SLICE-000-20, -21, -104; ops-portal.md section 7). A staff member who has forgotten their
 * password asks for a link to the work email the profile already holds. It is reached with no session and asks for none.
 *
 * - **There is no destination field.** The page asks for the work email only to say which account; the link goes to the address on the
 *   profile and nowhere else, and the request names no other.
 * - **The answer is the same whoever asks** (§37.7): every `202` is one success page, whether or not the address belongs to anyone, and it says
 *   so in words that are true either way. There is no *account not found* state, because that state is the disclosure.
 * - A too-fast request is the same plain wait as sign-in; a refused address is worded by its shape only; nothing the person typed is echoed.
 */
export function RecoveryRequestPage() {
  const client = useApiClient();
  const [sent, setSent] = useState(false);
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);

  const submission = useSubmission(async (form) => {
    const email = fieldText(form, 'email');
    setNotice(undefined);
    if (email.trim().length === 0) {
      setEmailError(EMAIL_WORDS);
      return 'invalid';
    }
    setEmailError(undefined);
    try {
      const answer = answerOf(
        await client.POST('/auth/recovery/request', {
          body: { principal_type: 'STAFF', identifier: email },
        }),
      );
      if (answer.status !== 202) throw unexpectedResponse(answer.status);
      setSent(true);
      return 'accepted';
    } catch (error) {
      const problem = problemOf(error, { operation: OPERATION });
      if (problem.kind === 'stale' || problem.kind === 'session-ended') return 'failed';
      if (problem.kind === 'invalid' && refusesField(problem, '/identifier')) {
        setEmailError(EMAIL_WORDS);
        return 'invalid';
      }
      setNotice(noticeOf(problem, OPERATION));
      return 'failed';
    }
  });

  if (sent) {
    return (
      <>
        <NoReferrer />
        <title>Check your email · Melarc Ops Portal</title>
        <FocusedRegion>
          <PageHeading>Check your email</PageHeading>
          <FormPage>
            <p>
              If that address belongs to a staff account that can be recovered, a link to set a new
              password is on its way to it.
            </p>
            <p>
              The link works once and for a limited time. Nothing has changed yet: your password
              stays as it is until you set a new one.
            </p>
            <p>
              <Link to={SIGN_IN_PATH}>Go to sign-in</Link>
            </p>
          </FormPage>
        </FocusedRegion>
      </>
    );
  }

  return (
    <>
      <NoReferrer />
      <title>Recover your password · Melarc Ops Portal</title>
      <PageHeading>Recover your password</PageHeading>
      <FormPage>
        <p>
          Enter the work email of your Melarc account. A link to set a new password is sent to the
          address on your profile.
        </p>
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
          <div className="ui-form-page__actions">
            <Button type="submit" loading={submission.pending}>
              Send recovery link
            </Button>
          </div>
        </form>
        <p>
          <Link to={SIGN_IN_PATH}>Back to sign-in</Link>
        </p>
      </FormPage>
    </>
  );
}
