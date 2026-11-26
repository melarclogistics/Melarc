import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';

import { PageHeading } from '../../../components/PageHeading';
import { Alert } from '../../../components/ui/alert/Alert';
import { CardFacts } from '../../../components/ui/card-facts/CardFacts';
import {
  CellLines,
  NoWrap,
  RowTitle,
  type DataColumn,
} from '../../../components/ui/data-table/DataTable';
import { HubFloor } from '../../../components/ui/hub-floor/HubFloor';
import { PageHeader } from '../../../components/ui/page-header/PageHeader';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { formatMinor } from '../../../components/ui/money/money-value';
import type { CorrectionFilter, CorrectionView } from '../../../platform/hub-orders/orders-shape';
import { CORRECTION_VIEWS } from '../../../platform/hub-orders/orders-shape';
import { usePayerCorrections } from '../../../platform/hub-orders/use-orders-queries';
import type { WorkListParams } from '../../../platform/pickup-work/use-pickup-work-queries';
import { refusalText } from '../../../platform/problem/capability-words';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import { copyFor, type Problem } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { UUID } from '../staff/WithProfile';
import { WorkList, type PanelTools, type WorkView } from '../pickup-work/WorkList';
import { CorrectionDetail } from './CorrectionDetail';
import { CORRECTION_STATE_MAP, CORRECTIONS_PATH, correctionPath } from './orders-presentation';
import './orders-pages.css';

const K = WORDS.corrections;

/** The views are the server's `state` filter, and the page filters nothing itself. The first is the one a visit starts at: what waits for a decision. */
const VIEWS: readonly [WorkView, ...WorkView[]] = [
  { id: 'REQUESTED', open: undefined, ...K.views.REQUESTED },
  { id: 'APPROVED', open: undefined, ...K.views.APPROVED },
  { id: 'REJECTED', open: undefined, ...K.views.REJECTED },
  { id: 'all', open: undefined, ...K.views.all },
];

const isFilter = (value: string | undefined): value is CorrectionFilter =>
  value !== undefined && (CORRECTION_VIEWS as readonly string[]).includes(value);

const refusalWords = (problem: Problem): string =>
  refusalText(problem.forbidden, 'pricing.correction.create', { of: 'changes of who pays' });

function useQueue(params: WorkListParams) {
  return usePayerCorrections({
    ...(isFilter(params.view) ? { state: params.view } : {}),
    ...(params.pageToken === undefined ? {} : { pageToken: params.pageToken }),
    ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
  });
}

/** What was asked for, as the server's amounts: the sender's share and the recipient's. */
const askedText = (item: CorrectionView): string =>
  item.proposed_allocation === null
    ? WORDS.form.payers[item.proposed.payer_intent].label
    : K.amounts(
        formatMinor(item.proposed_allocation.sender_minor, 'GHS'),
        formatMinor(item.proposed_allocation.recipient_minor, 'GHS'),
      );

/**
 * The changes of who pays (surfaces/ops-portal.md section 7, `/payer-corrections`; S1.40; `listPayerCorrections`, `pricing.correction.create`): **the checker's queue**, in the server's views (waiting, approved,
 * rejected, all), each row with its order, who asked and when, and what was asked for in actual amounts. A row opens the change beside the list, **where a senior officer decides it** (`pricing.correction.approve`):
 * the price never changes, only how it is shared, and the hub checks again whether payment is due. A change is found again after a reload or on another device, because the queue is read from the server.
 */
export function CorrectionsPage() {
  const me = useSignedInSession();
  if (me === undefined) return null;
  const mayDecide = me.holds('pricing.correction.approve');
  const columns: readonly DataColumn<CorrectionView>[] = [
    {
      id: 'order',
      header: K.columns.order,
      rowHeader: true,
      cell: (item) => (
        <RowTitle title={item.order_code ?? K.facts.order} name={item.requested_by_name ?? ''} />
      ),
    },
    {
      id: 'asked',
      header: K.columns.asked,
      kind: 'date',
      priority: 2,
      cell: (item) => (
        <CellLines
          first={<NoWrap>{formatInstant(item.created_at ?? '') ?? ''}</NoWrap>}
          second={item.requested_by_name ?? ''}
        />
      ),
    },
    { id: 'proposed', header: K.columns.proposed, cell: (item) => askedText(item) },
    {
      id: 'standing',
      header: K.columns.standing,
      kind: 'badge',
      cell: (item) => <StatusBadge status={item.state} map={CORRECTION_STATE_MAP} />,
    },
  ];
  return (
    <HubFloor>
      <WorkList<CorrectionView>
        name="payer-corrections"
        operation="listPayerCorrections"
        title={K.title}
        description={K.description}
        viewsLabel={K.viewsLabel}
        views={VIEWS}
        noun={K.noun}
        tableLabel={K.tableLabel}
        hubFilter={false}
        refusal={refusalWords}
        useList={useQueue}
        rowId={(item) => item.id}
        table={{
          columns,
          density: 'touch',
          openLabel: (item) => `${K.acts.openFull}: ${item.order_code ?? ''}`,
          card: (item) => (
            <CardFacts
              facts={[
                { label: K.columns.proposed, value: askedText(item) },
                {
                  label: K.columns.standing,
                  value: <StatusBadge status={item.state} map={CORRECTION_STATE_MAP} />,
                },
              ]}
            />
          ),
          cardTitle: (item) => item.order_code ?? K.facts.order,
        }}
        panel={(
          item: CorrectionView,
          tools: PanelTools,
        ): { code: string; status: ReactNode; fullPage: { to: string }; body: ReactNode } => ({
          code: item.order_code ?? K.facts.order,
          status: <StatusBadge status={item.state} map={CORRECTION_STATE_MAP} />,
          fullPage: { to: correctionPath(item.id) },
          body: (
            <CorrectionDetail
              key={item.id}
              correctionId={item.id}
              mayDecide={mayDecide}
              onDecided={(_done, decision) => {
                tools.acted(<p>{K.decide.done[decision]}</p>);
              }}
              onReloadList={tools.reload}
            />
          ),
        })}
      />
    </HubFloor>
  );
}

/** One change of who pays, as a page of its own (`/payer-corrections/{id}`): the same detail the queue opens beside the list, for a link that is followed from an order or opened on another device. */
export function CorrectionPage() {
  const { id = '' } = useParams();
  const me = useSignedInSession();
  // What the decision came to, said where the officer is, and the change read again as it now stands: a decision that changed nothing on the page would leave the officer unsure it was made, and with a decision still offered.
  const [decided, setDecided] = useState<
    { readonly text: string; readonly round: number } | undefined
  >(undefined);
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (decided !== undefined) notice.current?.focus();
  }, [decided]);
  if (me === undefined) return null;
  if (!UUID.test(id)) {
    return (
      <>
        <title>{`${K.notFound} · Melarc Ops Portal`}</title>
        <PageHeading>{K.notFound}</PageHeading>
        <p>{copyFor({ operation: 'getPayerCorrection', code: 'NOT_FOUND' }) ?? K.notFound}</p>
      </>
    );
  }
  return (
    <HubFloor>
      <title>{`${K.title} · Melarc Ops Portal`}</title>
      <PageHeader
        title={K.title}
        description={K.description}
        breadcrumb={[{ label: K.title, to: CORRECTIONS_PATH }]}
      />
      {decided === undefined ? null : (
        <div className="orders-notice" ref={notice} tabIndex={-1}>
          <Alert variant="success">
            <p>{decided.text}</p>
          </Alert>
        </div>
      )}
      <CorrectionDetail
        key={decided?.round ?? 0}
        correctionId={id}
        mayDecide={me.holds('pricing.correction.approve')}
        onDecided={(_done, decision) => {
          setDecided((current) => ({
            text: K.decide.done[decision],
            round: (current?.round ?? 0) + 1,
          }));
        }}
      />
    </HubFloor>
  );
}
