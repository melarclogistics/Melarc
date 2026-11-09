import type { UseQueryResult } from '@tanstack/react-query';
import { useLayoutEffect, type ReactNode } from 'react';

import { PageHeading } from '../../../components/PageHeading';
import { ForbiddenPage } from '../../../components/ui/forbidden-state/ForbiddenState';
import { Link } from '../../../components/ui/link/Link';
import { PageHeader } from '../../../components/ui/page-header/PageHeader';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import type { PickupRequestView } from '../../../platform/pickup/pickup-shape';
import { useQueueContinuity } from '../../../platform/pickup/queue-continuity-context';
import { usePickupRequest, type PickupRecord } from '../../../platform/pickup/use-pickup-queries';
import { copyFor, problemOf } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { UUID } from '../staff/WithProfile';
import './pickup-pages.css';

/**
 * The way back to the queue, above a request's heading. Given the request it is on, it names the queue the officer left for it (the filters in
 * the address) and says it is a return, so that the queue brings them to the page they were on (`platform/pickup/queue-continuity.ts`); a
 * request reached any other way (a typed address, a new tab, a reload) has no place to go back to, and the link is the plain queue.
 */
export function BackToRequests({ requestId }: { readonly requestId?: string }) {
  const continuity = useQueueContinuity();
  const back = requestId === undefined ? undefined : continuity.backTo(requestId);
  return (
    <p className="pickup-back">
      <Link
        to={{ pathname: '/pickup-requests', search: back?.search ?? '' }}
        {...(back === undefined ? {} : { state: back.state })}
      >
        Back to pickup requests
      </Link>
    </p>
  );
}

/**
 * The way back to one request, above the heading of a page about it that is not the request's own (the exception): the same element in every state of the page, while the request is
 * read, after a read that failed, beside the form and in place of it (the review of 499399c).
 */
export function BackToTheRequest({ id }: { readonly id: string }) {
  return (
    <p className="pickup-back">
      <Link to={`/pickup-requests/${id}`}>Back to the request</Link>
    </p>
  );
}

/** Focus to the heading when a page replaces the one that was loading in the same place (see `WithProfile`). */
export function useFocusFallenToHeading(): void {
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      document.querySelector<HTMLElement>('h1')?.focus();
    }
  }, []);
}

/**
 * A request that does not exist (or an address that is not a request's): a page of its own, not a part of one. A request that was asked for by
 * its id and the server says is not there keeps that id for the way back, so that the page the officer left for it is still the page they come
 * back to; an address that is not an id has none to keep, and its way back is the plain queue.
 */
export function RequestNotFound({ requestId }: { readonly requestId?: string }) {
  useFocusFallenToHeading();
  return (
    <>
      <title>Pickup request not found · Melarc Ops Portal</title>
      <PageHeading>Pickup request not found</PageHeading>
      <p>{copyFor({ operation: 'getPickupRequest', code: 'NOT_FOUND' })}</p>
      <BackToRequests {...(requestId === undefined ? {} : { requestId })} />
    </>
  );
}

/** The key of the queue's own route (`route-registry.tsx` holds the route to it; a test holds the two together). */
export const QUEUE_PERMISSION = 'pickup.read';

/**
 * The way back to the queue on a page that refuses the officer the request (they may not read it, or it is in a hub they do not act in), for an
 * officer who can read the queue: the link of every request's page, so that it names the queue they left (`BackToRequests`). It is offered by the
 * same hints the menu and the route's guard go by, and the queue is read again under its own permission when they arrive, so it grants nothing and
 * says nothing of the request. A session that cannot read the queue is given the refusal as every forbidden page is, with no link that leads to
 * another refusal: the menu is the way on.
 */
function WayBack({ requestId }: { readonly requestId: string }) {
  const me = useSignedInSession();
  return me?.holds(QUEUE_PERMISSION) === true ? <BackToRequests requestId={requestId} /> : null;
}

function OutsideHubs({ requestId }: { readonly requestId: string }) {
  useFocusFallenToHeading();
  return (
    <>
      <ForbiddenPage kind="outside-hubs" />
      <WayBack requestId={requestId} />
    </>
  );
}

function NoAccess({ requestId }: { readonly requestId: string }) {
  useFocusFallenToHeading();
  return (
    <>
      <ForbiddenPage kind="permission-missing" permission="pickup.read" />
      <WayBack requestId={requestId} />
    </>
  );
}

/** What a page says at its top, before its request is read and once it has been. */
export interface RequestHeading {
  readonly title: string;
  readonly description?: string;
  /** The title of the document (the tab), without the product's name. */
  readonly documentTitle: string;
}

export interface WithPickupRequestProps {
  /** The request asked for. An address that is not an id is a request that is not there, and nothing is asked of the server. */
  readonly id: string;
  /** The page's heading: the same element while the request is on its way and after, so that focus on it is not lost when it arrives. */
  readonly heading: (request: PickupRequestView | undefined) => RequestHeading;
  /** The way back, above the heading. */
  readonly back?: ReactNode;
  /**
   * The page draws its own heading and way back once the request is read (a record page: its header is the request's code, the page's one level-one heading). Until then, and for a failure, this
   * wrapper's heading stands, so that the page has one.
   */
  readonly ownsHeading?: boolean;
  /** The body of the page, drawn once the request has been read. It gets the read itself and does not ask again. */
  readonly children: (record: PickupRecord, query: UseQueryResult<PickupRecord>) => ReactNode;
}

function Reading({ id, heading, back, ownsHeading = false, children }: WithPickupRequestProps) {
  const query = usePickupRequest(id);

  if (query.status === 'error') {
    const problem = problemOf(query.error, { operation: 'getPickupRequest' });
    if (problem.kind === 'not-found') return <RequestNotFound requestId={id} />;
    if (problem.kind === 'forbidden' && problem.forbidden === 'outside-hubs')
      return <OutsideHubs requestId={id} />;
    if (problem.kind === 'forbidden' && problem.forbidden === 'permission-missing') {
      return <NoAccess requestId={id} />;
    }
  }

  const { title, description, documentTitle } = heading(query.data?.request);
  // The way back is the same element in every state (loading, loaded, failed), so that a press on it while the request is on its way is not lost to the page replacing it.
  const loaded = ownsHeading && query.status === 'success';
  return (
    <>
      <title>{`${documentTitle} · Melarc Ops Portal`}</title>
      {back === undefined ? <BackToRequests requestId={id} /> : back}
      {loaded ? null : (
        <PageHeader title={title} {...(description === undefined ? {} : { description })} />
      )}
      {query.status === 'success' ? (
        children(query.data, query)
      ) : (
        // Loading, or a failure that is not one of the pages above: the page still has its heading, and says what is happening.
        <ReadState<PickupRecord>
          query={query}
          isEmpty={() => false}
          empty={null}
          loadingLabel="Loading the pickup request…"
          skeleton={<Skeleton lines={6} />}
          permission="pickup.read"
          operation="getPickupRequest"
        >
          {() => null}
        </ReadState>
      )}
    </>
  );
}

/**
 * A page about one pickup request, which reads it first (`getPickupRequest`). The request is read once, with the version the page's acts take,
 * and the page is given that read and does not ask again: a version read twice is a version that changes under the person's hand. A request
 * in a hub the session does not act in, and one that is not there, are pages of their own (AC-SLICE-001-79: `HUB_SCOPE_VIOLATION`, `NOT_FOUND`).
 */
export function WithPickupRequest(props: WithPickupRequestProps) {
  if (!UUID.test(props.id)) return <RequestNotFound />;
  // A new read for each request, so that nothing of the last one is carried over.
  return <Reading key={props.id} {...props} />;
}
