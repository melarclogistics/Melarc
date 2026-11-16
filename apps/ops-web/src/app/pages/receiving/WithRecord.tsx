import type { UseQueryResult } from '@tanstack/react-query';
import { useLayoutEffect, type ReactNode } from 'react';

import { PageHeading } from '../../../components/PageHeading';
import { ForbiddenPage } from '../../../components/ui/forbidden-state/ForbiddenState';
import { Link } from '../../../components/ui/link/Link';
import { PageHeader, type BreadcrumbEntry } from '../../../components/ui/page-header/PageHeader';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import {
  useIntakeRecord,
  type IntakeRecordView,
} from '../../../platform/hub-receiving/use-intake-record';
import { copyFor, problemOf } from '../../../platform/problem/problem-copy';
import { RECEIVING_WORDS as WORDS } from '../../../platform/problem/receiving-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { UUID } from '../staff/WithProfile';
import { RECEIVING_QUEUE_PATH, recordPath } from './receiving-presentation';
import './receiving-pages.css';

/** Focus to the heading when a page replaces the one that was loading in the same place (the heading is a new element, and the focus it had fell to the page). */
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
    <p className="receiving-back">
      <Link to={RECEIVING_QUEUE_PATH}>{WORDS.record.back}</Link>
    </p>
  ) : null;
}

/** A vendor that does not exist (or an address that is not a vendor's): a page of its own, not a part of one. */
export function VendorNotFound() {
  useFocusFallenToHeading();
  return (
    <>
      <title>{`${WORDS.record.notFoundTitle} · Melarc Ops Portal`}</title>
      <PageHeading>{WORDS.record.notFoundTitle}</PageHeading>
      <p>{copyFor({ operation: 'getHubIntake', code: 'NOT_FOUND' })}</p>
      <BackToReceiving />
    </>
  );
}

/** The code of the vendor of a record, whichever way it was received. */
export const codeOfRecord = (record: IntakeRecordView): string =>
  record.kind === 'check-in' ? record.view.code : record.intake.code;

export interface RecordHeading {
  /** What the page is called: the page's one level-one heading while the vendor is on its way and when it fails. */
  readonly title: string;
  readonly description?: string;
  readonly documentTitle: string;
}

export interface WithRecordProps {
  /** The vendor asked for. An address that is not an id is a vendor that is not there, and nothing is asked of the API. */
  readonly id: string;
  /** What the page is called, from the vendor once it is read: the same element while the vendor is on its way and after, so that focus on it is not lost when it arrives. */
  readonly heading: (record: IntakeRecordView | undefined) => RecordHeading;
  /** The pages above this one, once the vendor is read: the queue, then the vendor's own code (a page of an act on the vendor). */
  readonly breadcrumb?: (record: IntakeRecordView | undefined) => readonly BreadcrumbEntry[];
  /** The page draws its own header once the vendor is read (a record page: the code is the page's heading). */
  readonly ownsHeading?: boolean;
  /** The body of the page, drawn once the vendor has been read. It gets the read itself and does not ask again. */
  readonly children: (
    record: IntakeRecordView,
    query: UseQueryResult<IntakeRecordView>,
  ) => ReactNode;
}

function Reading({ id, heading, breadcrumb, ownsHeading = false, children }: WithRecordProps) {
  const query = useIntakeRecord(id);

  if (query.status === 'error') {
    const problem = problemOf(query.error, { operation: 'getHubIntake' });
    if (problem.kind === 'not-found') return <VendorNotFound />;
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
      <ReadState<IntakeRecordView>
        query={query}
        isEmpty={() => false}
        empty={null}
        loadingLabel={WORDS.record.loading}
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
 * A page about one vendor: it reads the vendor once (as a check-in or as a vendor counted without photos, by what the API says it is), tells a page that is not there, a vendor at a hub the account does not
 * work in and an account without the read in plain words, and draws its body with the read it made. The page acts on the version it read (`If-Match` exactly as sent) and does not read it again, because a
 * version read twice changes under the person's hand.
 */
export function WithRecord(props: WithRecordProps) {
  if (!UUID.test(props.id)) return <VendorNotFound />;
  return <Reading key={props.id} {...props} />;
}

/** The breadcrumb of a page of an act on a vendor: the queue, then the vendor itself. */
export function actBreadcrumb(
  record: IntakeRecordView | undefined,
  id: string,
): readonly BreadcrumbEntry[] {
  return [
    { label: WORDS.record.receiving, to: RECEIVING_QUEUE_PATH },
    {
      label: record === undefined ? WORDS.record.loadingTitle : codeOfRecord(record),
      to: recordPath(id),
    },
  ];
}
