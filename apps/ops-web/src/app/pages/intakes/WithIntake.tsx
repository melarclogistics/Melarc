import type { UseQueryResult } from '@tanstack/react-query';
import { useLayoutEffect, type ReactNode } from 'react';

import { PageHeading } from '../../../components/PageHeading';
import { ForbiddenPage } from '../../../components/ui/forbidden-state/ForbiddenState';
import { Link } from '../../../components/ui/link/Link';
import { PageHeader, type BreadcrumbEntry } from '../../../components/ui/page-header/PageHeader';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import {
  useHubIntake,
  type IntakeRecord,
} from '../../../platform/hub-intake/use-hub-intake-queries';
import { copyFor, problemOf } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { UUID } from '../staff/WithProfile';
import { intakePath } from './intake-presentation';
import '../pickup/pickup-pages.css';

/** Focus to the heading when a page replaces the one that was loading in the same place (see `WithProfile`). */
export function useFocusFallenToHeading(): void {
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      document.querySelector<HTMLElement>('h1')?.focus();
    }
  }, []);
}

/** The way back to the queue, for an officer who can read it. */
export function BackToReceiving() {
  const me = useSignedInSession();
  return me?.holds('hub.read') === true ? (
    <p className="pickup-back">
      <Link to="/intakes">Back to receiving</Link>
    </p>
  ) : null;
}

/** An intake that does not exist (or an address that is not an intake's): a page of its own, not a part of one. */
export function IntakeNotFound() {
  useFocusFallenToHeading();
  return (
    <>
      <title>Intake not found · Melarc Ops Portal</title>
      <PageHeading>Intake not found</PageHeading>
      <p>{copyFor({ operation: 'getHubIntake', code: 'NOT_FOUND' })}</p>
      <BackToReceiving />
    </>
  );
}

export interface IntakeHeading {
  /** What the page is called: the page's one level-one heading while the intake is on its way and when it fails. */
  readonly title: string;
  readonly description?: string;
  readonly documentTitle: string;
}

export interface WithIntakeProps {
  /** The intake asked for. An address that is not an id is an intake that is not there, and nothing is asked of the server. */
  readonly id: string;
  /** What the page is called, from the intake once it is read: the same element while the intake is on its way and after, so that focus on it is not lost when it arrives. */
  readonly heading: (record: IntakeRecord | undefined) => IntakeHeading;
  /** The pages above this one, once the intake is read: the queue, then the intake's own code (a page of an act on the intake). */
  readonly breadcrumb?: (record: IntakeRecord | undefined) => readonly BreadcrumbEntry[];
  /** The page draws its own header once the intake is read (a record page: the code is the page's heading). */
  readonly ownsHeading?: boolean;
  /** The body of the page, drawn once the intake has been read. It gets the read itself and does not ask again. */
  readonly children: (record: IntakeRecord, query: UseQueryResult<IntakeRecord>) => ReactNode;
}

function Reading({ id, heading, breadcrumb, ownsHeading = false, children }: WithIntakeProps) {
  const query = useHubIntake(id);

  if (query.status === 'error') {
    const problem = problemOf(query.error, { operation: 'getHubIntake' });
    if (problem.kind === 'not-found') return <IntakeNotFound />;
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

  const loaded = ownsHeading && query.status === 'success';
  const named = heading(query.data);
  const trail = breadcrumb?.(query.data);
  return (
    <>
      <title>{`${named.documentTitle} · Melarc Ops Portal`}</title>
      {loaded ? null : (
        <PageHeader
          title={named.title}
          {...(named.description === undefined ? {} : { description: named.description })}
          {...(trail === undefined ? {} : { breadcrumb: trail })}
        />
      )}
      <ReadState<IntakeRecord>
        query={query}
        isEmpty={() => false}
        empty={null}
        loadingLabel="Loading the intake…"
        skeleton={<Skeleton lines={4} />}
        permission="hub.read"
        operation="getHubIntake"
      >
        {(record) => children(record, query)}
      </ReadState>
    </>
  );
}

/**
 * A page about one intake: it reads the intake once, tells a page that is not there, an intake at a hub the account does not work in and an account without the key in plain words, and draws its body
 * with the read it made. The page acts on the version it read (`If-Match` exactly as sent) and does not read it again, because a version read twice changes under the person's hand.
 */
export function WithIntake(props: WithIntakeProps) {
  if (!UUID.test(props.id)) return <IntakeNotFound />;
  return <Reading key={props.id} {...props} />;
}

/** The breadcrumb of a page of an act on an intake: the queue, then the intake itself. */
export function actBreadcrumb(
  record: IntakeRecord | undefined,
  id: string,
): readonly BreadcrumbEntry[] {
  return [
    { label: 'Receiving', to: '/intakes' },
    { label: record === undefined ? 'The intake' : record.intake.code, to: intakePath(id) },
  ];
}
