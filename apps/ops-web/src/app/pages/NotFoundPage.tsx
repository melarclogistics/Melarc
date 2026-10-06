import { PageHeading } from '../../components/PageHeading';
import { Link } from '../../components/ui/link/Link';

export function NotFoundPage() {
  return (
    <>
      <title>Page not found · Melarc Ops Portal</title>
      <PageHeading>Page not found</PageHeading>
      <p>The page you asked for does not exist.</p>
      <p>
        <Link to="/">Go to the start page</Link>
      </p>
    </>
  );
}
