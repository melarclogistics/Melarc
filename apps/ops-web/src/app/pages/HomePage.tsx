import { PageHeading } from '../../components/PageHeading';

/**
 * The landing page of this build. The specification makes `/` the signed-in landing once the identity
 * slice exists; until then it says what this build is, and shows no data, no workflow and no identity.
 */
export function HomePage() {
  return (
    <>
      <title>Melarc Ops Portal</title>
      <PageHeading>Melarc Ops Portal</PageHeading>
      <p>This build contains the application shell only. No workflows are available yet.</p>
    </>
  );
}
