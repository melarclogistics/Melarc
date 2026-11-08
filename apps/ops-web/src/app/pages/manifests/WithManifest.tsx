import type { UseQueryResult } from '@tanstack/react-query';
import { useLayoutEffect, type ReactNode } from 'react';

import { PageHeader } from '../../../components/PageHeader';
import { PageHeading } from '../../../components/PageHeading';
import { ForbiddenPage } from '../../../components/ui/forbidden-state/ForbiddenState';
import { Link } from '../../../components/ui/link/Link';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import type { ManifestRecord } from '../../../platform/manifest/manifest-commands';
import { useManifest } from '../../../platform/manifest/use-manifest-queries';
import { useQueueContinuity } from '../../../platform/pickup/queue-continuity-context';
import { copyFor, problemOf } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { UUID } from '../staff/WithProfile';
import './manifests-pages.css';
import '../pickup/pickup-pages.css';

/** The key of the list's own route (`route-registry.tsx` holds the route to it; a test holds the two together). */
export const LIST_PERMISSION = 'pickup.read';

/**
 * The way back to the list, above a manifest's heading. Given the manifest it is on, it names the list the officer left for it (the filters in
 * the address) and says it is a return, so that the list brings them to the page they were on (`platform/pickup/queue-continuity.ts`); a
 * manifest reached any other way (the menu, a typed address, a new tab, a creation, a reload) has no place to go back to, and the link is the
 * plain list.
 */
export function BackToManifests({ manifestId }: { readonly manifestId?: string }) {
  const continuity = useQueueContinuity('manifests');
  const back = manifestId === undefined ? undefined : continuity.backTo(manifestId);
  return (
    <p className="pickup-back">
      <Link
        to={{ pathname: '/manifests', search: back?.search ?? '' }}
        {...(back === undefined ? {} : { state: back.state })}
      >
        Back to manifests
      </Link>
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
 * A manifest that does not exist (or an address that is not a manifest's): a page of its own, not a part of one. A manifest that was asked for by
 * its id and the server says is not there keeps that id for the way back, so that the page the officer left for it is still the page they come
 * back to; an address that is not an id has none to keep, and its way back is the plain list.
 */
export function ManifestNotFound({ manifestId }: { readonly manifestId?: string }) {
  useFocusFallenToHeading();
  return (
    <>
      <title>Manifest not found · Melarc Ops Portal</title>
      <PageHeading>Manifest not found</PageHeading>
      <p>{copyFor({ operation: 'getPickupManifest', code: 'NOT_FOUND' })}</p>
      <BackToManifests {...(manifestId === undefined ? {} : { manifestId })} />
    </>
  );
}

/** The way back to the list, for an officer who can read it: the link of every manifest's page. A session that cannot is given the refusal only. */
function WayBack({ manifestId }: { readonly manifestId: string }) {
  const me = useSignedInSession();
  return me?.holds(LIST_PERMISSION) === true ? <BackToManifests manifestId={manifestId} /> : null;
}

function OutsideHubs({ manifestId }: { readonly manifestId: string }) {
  useFocusFallenToHeading();
  return (
    <>
      <ForbiddenPage kind="outside-hubs" />
      <WayBack manifestId={manifestId} />
    </>
  );
}

function NoAccess({ manifestId }: { readonly manifestId: string }) {
  useFocusFallenToHeading();
  return (
    <>
      <ForbiddenPage kind="permission-missing" permission="pickup.read" />
      <WayBack manifestId={manifestId} />
    </>
  );
}

export interface WithManifestProps {
  /** The manifest asked for. An address that is not an id is a manifest that is not there, and nothing is asked of the server. */
  readonly id: string;
  /** The page's heading: the same element while the manifest is on its way and after, so that focus on it is not lost when it arrives. */
  readonly heading: (record: ManifestRecord | undefined) => {
    readonly title: string;
    readonly description?: string;
    readonly documentTitle: string;
  };
  /** The body of the page, drawn once the manifest has been read. It gets the read itself and does not ask again. */
  readonly children: (record: ManifestRecord, query: UseQueryResult<ManifestRecord>) => ReactNode;
}

function Reading({ id, heading, children }: WithManifestProps) {
  const query = useManifest(id);

  if (query.status === 'error') {
    const problem = problemOf(query.error, { operation: 'getPickupManifest' });
    if (problem.kind === 'not-found') return <ManifestNotFound manifestId={id} />;
    if (problem.kind === 'forbidden' && problem.forbidden === 'outside-hubs')
      return <OutsideHubs manifestId={id} />;
    if (problem.kind === 'forbidden' && problem.forbidden === 'permission-missing') {
      return <NoAccess manifestId={id} />;
    }
  }

  const { title, description, documentTitle } = heading(query.data);
  return (
    <>
      <title>{`${documentTitle} · Melarc Ops Portal`}</title>
      <BackToManifests manifestId={id} />
      <PageHeader title={title} {...(description === undefined ? {} : { description })} />
      {query.status === 'success' ? (
        children(query.data, query)
      ) : (
        <ReadState<ManifestRecord>
          query={query}
          isEmpty={() => false}
          empty={null}
          loadingLabel="Loading the manifest…"
          skeleton={<Skeleton lines={6} />}
          permission="pickup.read"
          operation="getPickupManifest"
        >
          {() => null}
        </ReadState>
      )}
    </>
  );
}

/**
 * A page about one manifest, which reads it first (`getPickupManifest`). The manifest is read once, with the version the page's acts take, and
 * the page is given that read and does not ask again: a version read twice is a version that changes under the person's hand. A manifest in a
 * hub the session does not act in, and one that is not there, are pages of their own (`HUB_SCOPE_VIOLATION`, `NOT_FOUND`).
 */
export function WithManifest(props: WithManifestProps) {
  if (!UUID.test(props.id)) return <ManifestNotFound />;
  // A new read for each manifest, so that nothing of the last one is carried over.
  return <Reading key={props.id} {...props} />;
}
