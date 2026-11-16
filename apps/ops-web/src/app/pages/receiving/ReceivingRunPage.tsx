import type { UseQueryResult } from '@tanstack/react-query';
import { useLayoutEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';

import { PageHeading } from '../../../components/PageHeading';
import { ForbiddenPage } from '../../../components/ui/forbidden-state/ForbiddenState';
import { Link } from '../../../components/ui/link/Link';
import { PageHeader } from '../../../components/ui/page-header/PageHeader';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import type { RunPageView, VendorView } from '../../../platform/hub-receiving/receiving-shape';
import { useReceivingRun } from '../../../platform/hub-receiving/use-receiving-queries';
import { cannotText } from '../../../platform/problem/capability-words';
import { copyFor, problemOf } from '../../../platform/problem/problem-copy';
import { RECEIVING_WORDS as WORDS } from '../../../platform/problem/receiving-copy';
import { useRefreshWhenVisible } from '../../../platform/query/use-refresh-when-visible';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatClock } from '../../../platform/time/format-time';
import { UUID } from '../staff/WithProfile';
import { RECEIVING_QUEUE_PATH } from './receiving-presentation';
import { RunSummary } from './RunSummary';
import { useRunActs } from './use-run-acts';
import { VendorSection, vendorHeadingId } from './VendorSection';
import './receiving-pages.css';

/** Focus to the heading when a page replaces the one that was loading in the same place (the heading is a new element, and the focus it had fell to the page). */
function useFocusFallenToHeading(): void {
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      document.querySelector<HTMLElement>('h1')?.focus();
    }
  }, []);
}

/** The way back to the queue, for an officer who can read it. */
function BackToReceiving() {
  const me = useSignedInSession();
  return me?.holds('hub.read') === true ? (
    <p className="receiving-back">
      <Link to={RECEIVING_QUEUE_PATH}>{WORDS.run.back}</Link>
    </p>
  ) : null;
}

/** A run that does not exist (or an address that is not a run's): a page of its own, in the words of the table. */
function RunNotFound() {
  useFocusFallenToHeading();
  return (
    <>
      <title>{`${WORDS.run.notFoundTitle} · Melarc Ops Portal`}</title>
      <PageHeading>{WORDS.run.notFoundTitle}</PageHeading>
      <p>{copyFor({ operation: 'getReceivingRun', code: 'NOT_FOUND' })}</p>
      <BackToReceiving />
    </>
  );
}

/** The vendor to check in after this one: the next that waits, going round to the first when none after it does. */
function nextWaiting(vendors: readonly VendorView[], current: VendorView): VendorView | undefined {
  const at = vendors.findIndex((vendor) => vendor.intake_id === current.intake_id);
  return [...vendors.slice(at + 1), ...vendors.slice(0, Math.max(at, 0))].find(
    (vendor) => vendor.state === 'AWAITING_COUNT',
  );
}

/** Sends the officer to a vendor's section: focus comes to its heading, so that a keyboard or a screen reader starts there, and the section is brought into view. */
function goTo(vendor: VendorView): void {
  const heading = document.getElementById(vendorHeadingId(vendor));
  if (heading === null) return;
  heading.focus();
  // A test document has no scrolling: the method is there in a browser, and is asked for only where it is.
  if (typeof (heading as Partial<HTMLElement>).scrollIntoView === 'function') {
    heading.scrollIntoView({ block: 'start' });
  }
}

function Run({
  page,
  query,
}: {
  readonly page: RunPageView;
  readonly query: UseQueryResult<RunPageView>;
}) {
  const me = useSignedInSession();
  const mayCount = me?.holds('hub.intake.count') === true;
  const acts = useRunActs(page.run.id, query.refetch);
  const [notices, setNotices] = useState<Readonly<Record<string, string>>>({});
  useFocusFallenToHeading();
  // The page is read again when it is shown again (the tablet was picked up): what it shows is as old as the moment it was put down. It is an automatic read, so it asks the hold first.
  useRefreshWhenVisible('receiving-run', () => {
    void query.refetch();
  });

  const waiting = page.vendors.some((vendor) => vendor.state === 'AWAITING_COUNT');
  // Whether a vendor has waited on this page: the summary that appears after that is one the officer has just earned, and is read first. (State kept from what the page is given, set while it is drawn.)
  const [sawWaiting, setSawWaiting] = useState(waiting);
  if (waiting && !sawWaiting) setSawWaiting(true);

  const updatedAt =
    query.dataUpdatedAt > 0 ? formatClock(new Date(query.dataUpdatedAt).toISOString()) : undefined;
  const at = formatClock(page.handed_over_at) ?? '';

  return (
    <>
      <title>{`${WORDS.run.documentTitle(page.run.code)} · Melarc Ops Portal`}</title>
      <PageHeader
        title={page.run.code}
        description={WORDS.run.handedOver(page.rider_name, page.run.hub_name, at)}
        breadcrumb={[{ label: WORDS.run.receiving, to: RECEIVING_QUEUE_PATH }]}
        freshness={{
          state: query.isFetching ? 'refreshing' : query.isError ? 'failed' : 'idle',
          ...(updatedAt === undefined ? {} : { updatedAt }),
          onRefresh: () => {
            void query.refetch();
          },
        }}
      />
      {mayCount ? null : (
        <p className="receiving-note">{WORDS.run.lookOnly(cannotText('hub.intake.count'))}</p>
      )}
      {!waiting && page.vendors.length > 0 ? (
        <RunSummary vendors={page.vendors} focusOnAppear={sawWaiting} />
      ) : null}
      {page.vendors.map((vendor) => (
        <VendorSection
          key={vendor.intake_id}
          vendor={vendor}
          mayCount={mayCount}
          acts={acts}
          next={nextWaiting(page.vendors, vendor)}
          notice={notices[vendor.intake_id]}
          onNotice={(text) => {
            setNotices((all) => ({ ...all, [vendor.intake_id]: text }));
          }}
          onGoTo={goTo}
          readAgain={query.refetch}
        />
      ))}
    </>
  );
}

function Reading({
  id,
  children,
}: {
  readonly id: string;
  readonly children: (page: RunPageView, query: UseQueryResult<RunPageView>) => ReactNode;
}) {
  const query = useReceivingRun(id);

  if (query.status === 'error') {
    const problem = problemOf(query.error, { operation: 'getReceivingRun' });
    if (problem.kind === 'not-found') return <RunNotFound />;
    if (problem.kind === 'forbidden' && problem.forbidden === 'outside-hubs') {
      return (
        <>
          <ForbiddenPage kind="outside-hubs" />
          <BackToReceiving />
        </>
      );
    }
    if (problem.kind === 'forbidden' && problem.forbidden === 'permission-missing') {
      return (
        <>
          <ForbiddenPage kind="permission-missing" permission="hub.read" />
          <BackToReceiving />
        </>
      );
    }
  }

  const loaded = query.status === 'success';
  return (
    <>
      {loaded ? null : (
        <>
          <title>{`${WORDS.run.loadingTitle} · Melarc Ops Portal`}</title>
          <PageHeader title={WORDS.run.loadingTitle} />
        </>
      )}
      <ReadState<RunPageView>
        query={query}
        isEmpty={() => false}
        empty={null}
        loadingLabel={WORDS.run.loading}
        skeleton={<Skeleton lines={4} />}
        permission="hub.read"
        operation="getReceivingRun"
      >
        {(page) => children(page, query)}
      </ReadState>
    </>
  );
}

/**
 * The run's page (surfaces/ops-portal.md section 7, `/receiving/{run}`; S1.35c; D-D1, D-D2): **a section for each vendor of one run**, where the officer checks the parcels in against the photos the rider took at
 * the door. It reads the run once and keeps it as the acts change it (a tap is taken into the page from the API's answer; finishing a vendor, and what changes more than a parcel, read the run again), reads it again
 * when it is shown again and on *Refresh*, and tells a run that is not there, a run at a hub the account does not work in and an account without the read in plain words. **The lock is taken on the first act on a
 * vendor, never by opening the page.** Acts are offered by the key of the count and decided by the API; an officer without it can look at the run and is told so. When every vendor is finished the page says
 * what came of the run and what to do next: check the rider's bag.
 */
export function ReceivingRunPage() {
  const { manifestId = '' } = useParams();
  if (!UUID.test(manifestId)) return <RunNotFound />;
  return (
    <Reading key={manifestId} id={manifestId}>
      {(page, query) => <Run page={page} query={query} />}
    </Reading>
  );
}
