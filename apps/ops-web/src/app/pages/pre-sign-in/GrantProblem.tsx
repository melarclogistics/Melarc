import { FormPage } from '../../../components/FormPage';
import { PageHeading } from '../../../components/PageHeading';
import { Link } from '../../../components/ui/link/Link';
import { GRANT_CANNOT_BE_USED } from '../../../platform/problem/problem-copy';
import { SIGN_IN_PATH } from '../../../platform/session/paths';
import { FocusedRegion } from './notice';

/**
 * The one error of a link page (ops-portal.md section 7): **one** page for an unknown, expired, consumed or superseded grant, a link that
 * carried none, and one the page has held for too long. It does not say which, it does not re-open the form, and it offers the two things a
 * person can do: sign in, if they had already finished, or ask for a new link.
 *
 * `focus` is for the page a person is taken to by what they just did (the form was replaced by this): focus moves to it. A link that never
 * had a grant shows this at once, with focus where the browser put it.
 */
export function GrantProblem({ focus }: { readonly focus: boolean }) {
  const content = (
    <>
      <PageHeading>This link cannot be used</PageHeading>
      <FormPage>
        <p>{GRANT_CANNOT_BE_USED}</p>
        <p>
          If you have already set your password, sign in. Otherwise open the link from your message
          again, or ask for a new one.
        </p>
        <p>
          <Link to={SIGN_IN_PATH}>Go to sign-in</Link>
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
