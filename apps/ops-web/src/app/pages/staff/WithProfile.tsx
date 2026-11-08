import type { UseQueryResult } from '@tanstack/react-query';
import { useLayoutEffect, type ReactNode } from 'react';

// eslint-disable-next-line no-restricted-imports -- the older PageHeader: this screen moves to the kit's when it is rebuilt (task R5.2, M12)
import { PageHeader } from '../../../components/PageHeader';
import { PageHeading } from '../../../components/PageHeading';
import { ForbiddenPage } from '../../../components/ui/forbidden-state/ForbiddenState';
import { Link } from '../../../components/ui/link/Link';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { copyFor, problemOf } from '../../../platform/problem/problem-copy';
import type { StaffIdentityView } from '../../../platform/staff/staff-shape';
import { useStaffIdentity, type StaffRecord } from '../../../platform/staff/use-staff-queries';
import './staff-pages.css';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function BackToStaff() {
  return (
    <p className="staff-back">
      <Link to="/admin/staff">Back to staff</Link>
    </p>
  );
}

/**
 * Moves focus to the page's heading when one page replaces another in the same place (a profile that turns out not to be there, in the place
 * of the page that was loading it). The frame moves focus to a heading when the address changes; when what is drawn changes and the address
 * does not, the heading that had focus is gone, and focus would fall to the top of the document. It is moved only if it has fallen, so that a
 * person who has already gone elsewhere is not taken back.
 */
function useFocusFallenToHeading(): void {
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      document.querySelector<HTMLElement>('h1')?.focus();
    }
  }, []);
}

/** A profile that does not exist (or an address that is not a profile's): a page of its own, not a part of one. */
export function ProfileNotFound() {
  useFocusFallenToHeading();
  return (
    <>
      <title>Profile not found · Melarc Ops Portal</title>
      <PageHeading>Profile not found</PageHeading>
      <p>{copyFor({ operation: 'getStaffIdentity', code: 'NOT_FOUND' })}</p>
      <BackToStaff />
    </>
  );
}

function OutsideHubs() {
  useFocusFallenToHeading();
  return <ForbiddenPage kind="outside-hubs" />;
}

function NoAccess() {
  useFocusFallenToHeading();
  return <ForbiddenPage kind="permission-missing" permission="staff.read" />;
}

/** What a page says at its top, before its profile is read and once it has been. */
export interface ProfileHeading {
  readonly title: string;
  readonly description?: string;
  /** The title of the document (the tab), without the product's name. */
  readonly documentTitle: string;
}

export interface WithProfileProps {
  /** The profile asked for. An address that is not an id is a profile that is not there, and nothing is asked of the server. */
  readonly id: string;
  /** The page's heading. It is the same heading while the profile is on its way and after, so that focus on it is not lost when the profile arrives. */
  readonly heading: (identity: StaffIdentityView | undefined) => ProfileHeading;
  /** The way back, above the heading. */
  readonly back?: ReactNode;
  /** The body of the page, drawn once the profile has been read. It gets the read itself and does not ask again. */
  readonly children: (record: StaffRecord, query: UseQueryResult<StaffRecord>) => ReactNode;
}

function Reading({ id, heading, back, children }: WithProfileProps) {
  const query = useStaffIdentity(id);

  if (query.status === 'error') {
    const problem = problemOf(query.error, { operation: 'getStaffIdentity' });
    if (problem.kind === 'not-found') return <ProfileNotFound />;
    if (problem.kind === 'forbidden' && problem.forbidden === 'outside-hubs') {
      return <OutsideHubs />;
    }
    if (problem.kind === 'forbidden' && problem.forbidden === 'permission-missing') {
      return <NoAccess />;
    }
  }

  const { title, description, documentTitle } = heading(query.data?.identity);
  return (
    <>
      <title>{`${documentTitle} · Melarc Ops Portal`}</title>
      {back === undefined ? <BackToStaff /> : back}
      <PageHeader title={title} {...(description === undefined ? {} : { description })} />
      {query.status === 'success' ? (
        children(query.data, query)
      ) : (
        // Loading, or a failure that is not one of the pages above: the page still has its heading, and says what is happening.
        <ReadState<StaffRecord>
          query={query}
          isEmpty={() => false}
          empty={null}
          loadingLabel="Loading the profile…"
          skeleton={<Skeleton lines={4} />}
          permission="staff.read"
          operation="getStaffIdentity"
        >
          {() => null}
        </ReadState>
      )}
    </>
  );
}

/**
 * A page about one staff profile, which reads it first. The profile is read once, with the version the page's acts take, and the page is
 * given that read and does not ask again: a second observer of a query that is stale the moment it is read would read the profile once
 * more on mount, and a version read twice is a version that changes under the person's hand.
 *
 * The heading, the title and the way back are the same elements while the profile is on its way and after it has come, so the focus the
 * frame put on the heading stays on it. A profile in a hub the session does not act in, and one that is not there, are pages of their own
 * (surfaces/ops-portal.md section 7) and take the focus the heading had.
 */
export function WithProfile(props: WithProfileProps) {
  if (!UUID.test(props.id)) return <ProfileNotFound />;
  // A new read for each profile, so that nothing of the last one is carried over.
  return <Reading key={props.id} {...props} />;
}
