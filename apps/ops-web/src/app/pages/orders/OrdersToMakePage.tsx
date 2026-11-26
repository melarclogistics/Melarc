import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';

import { CardFacts } from '../../../components/ui/card-facts/CardFacts';
import {
  CellLines,
  NoWrap,
  RowTitle,
  type DataColumn,
} from '../../../components/ui/data-table/DataTable';
import { HubFloor } from '../../../components/ui/hub-floor/HubFloor';
import { Link } from '../../../components/ui/link/Link';
import type { ItemizableIntakeView } from '../../../platform/hub-orders/intake-list-shape';
import { useItemizableIntakes } from '../../../platform/hub-orders/use-orders-queries';
import type { WorkListParams } from '../../../platform/pickup-work/use-pickup-work-queries';
import { refusalText } from '../../../platform/problem/capability-words';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import type { Problem } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { waitedText } from '../../../platform/time/waited';
import { WorkList, type WorkView } from '../pickup-work/WorkList';
import { decisionPath } from '../receiving/receiving-presentation';
import { ordersPath } from './orders-presentation';
import './orders-pages.css';

const K = WORDS.toMake;

/**
 * The views are the server's `state` filter: the vendors cleared and waiting for their first order, the ones whose orders are being made, the ones that wait for a senior, and **the vendors whose check-in is open**
 * (D-D6, Run G2, Part 2, item 1): the way in to the early orders, from the photos, before the parcels are checked in for good.
 */
const VIEWS: readonly [WorkView, ...WorkView[]] = [
  { id: 'READY_FOR_ITEMIZATION', open: undefined, ...K.views.READY_FOR_ITEMIZATION },
  { id: 'ITEMIZING', open: undefined, ...K.views.ITEMIZING },
  { id: 'NEEDS_SENIOR', open: undefined, ...K.views.NEEDS_SENIOR },
  { id: 'AWAITING_COUNT', open: undefined, ...K.views.AWAITING_COUNT },
];

const refusalWords = (problem: Problem): string =>
  refusalText(problem.forbidden, 'hub.read', { of: 'vendors' });

function useQueue(params: WorkListParams) {
  return useItemizableIntakes({
    ...(params.view === 'NEEDS_SENIOR'
      ? { view: 'needs_senior' as const }
      : {
          state:
            params.view === 'ITEMIZING'
              ? ('ITEMIZING' as const)
              : params.view === 'AWAITING_COUNT'
                ? ('AWAITING_COUNT' as const)
                : ('READY_FOR_ITEMIZATION' as const),
        }),
    ...(params.pageToken === undefined ? {} : { pageToken: params.pageToken }),
    ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
  });
}

const nameOf = (item: ItemizableIntakeView): string => item.vendor_name ?? item.code;

/**
 * Orders to make (surfaces/ops-portal.md section 7, `/orders-to-make`; S1.40; `listHubIntakes`, `hub.read`): **the vendors a hub has cleared for their orders**, oldest handover first, in the server's views (ready
 * to start, being worked, needs a senior), so that an officer finds the work without remembering which vendors finished checking in. **A row opens the vendor's orders directly** (the vendor's name is the link:
 * there is no panel that holds less than the page it leads to, the review of 23 November 2026). A row says how many orders are made and how many parcels are still to order as the list gives them (the database's
 * own count of the whole vendor: D-S7-6), and draws no figure it was not given. The third view lists the vendors that wait for a senior officer (D-S7-7), says why, and offers the act of that reason only to the
 * senior who holds its key; an officer is told who decides.
 */
export function OrdersToMakePage() {
  const me = useSignedInSession();
  const [params] = useSearchParams();
  // The reason a senior is needed, and the act of it, are of the one view that lists what a senior decides (D-S7-11): the other two have no such column, empty or not.
  const seniorView = params.get('view') === 'NEEDS_SENIOR';
  // The vendors whose check-in is open are listed to begin their orders from the photos (D-D6): the act is for an officer who may make orders, and a reader has the vendor's name as the way in.
  const checkingView = params.get('view') === 'AWAITING_COUNT';
  if (me === undefined) return null;
  const mayItemize = me.holds('hub.intake.itemize');
  const startAct = (item: ItemizableIntakeView): ReactNode =>
    mayItemize && item.state === 'AWAITING_COUNT' ? (
      <Link
        to={ordersPath(item.id)}
        aria-label={`${WORDS.workspace.acts.earlyOrders}: ${nameOf(item)}`}
      >
        {WORDS.workspace.acts.earlyOrders}
      </Link>
    ) : null;
  const seniorAct = (item: ItemizableIntakeView): ReactNode => {
    if (item.senior_needed === 'ARRIVAL_TAKEN_BACK') {
      return me.holds('hub.osd.adjudicate') ? (
        <Link to={decisionPath(item.id)} aria-label={`${K.senior.review}: ${nameOf(item)}`}>
          {K.senior.review}
        </Link>
      ) : (
        K.senior.decides
      );
    }
    return null;
  };
  const columns: readonly DataColumn<ItemizableIntakeView>[] = [
    {
      id: 'vendor',
      header: K.columns.vendor,
      rowHeader: true,
      cell: (item) => (
        <RowTitle
          title={nameOf(item)}
          name={
            item.mode === 'BLIND_COUNT'
              ? item.vendor_name === null
                ? K.blind
                : K.blindLine(item.code)
              : item.code
          }
          to={ordersPath(item.id)}
        />
      ),
    },
    { id: 'run', header: K.columns.run, priority: 3, cell: (item) => item.run_code ?? '' },
    {
      id: 'received',
      header: K.columns.received,
      kind: 'count',
      cell: (item) => (
        <CellLines
          first={
            <NoWrap>
              {item.state === 'AWAITING_COUNT' && item.received !== null && item.expected !== null
                ? K.here(item.received, item.expected)
                : K.received(item.received)}
            </NoWrap>
          }
          second={item.missing === null || item.missing === 0 ? '' : K.missing(item.missing)}
        />
      ),
    },
    {
      id: 'orders',
      header: K.columns.orders,
      kind: 'count',
      cell: (item) =>
        item.orders_made === null ? (
          ''
        ) : (
          <NoWrap>{K.ordersLine(item.orders_made, item.parcels_needing_order)}</NoWrap>
        ),
    },
    ...(checkingView
      ? [{ id: 'start', header: '', cell: (item: ItemizableIntakeView) => startAct(item) }]
      : []),
    ...(seniorView
      ? [
          {
            id: 'why',
            header: K.columns.why,
            cell: (item: ItemizableIntakeView) =>
              item.senior_needed === null ? '' : K.senior[item.senior_needed],
          },
          { id: 'act', header: '', cell: (item: ItemizableIntakeView) => seniorAct(item) },
        ]
      : []),
    {
      id: 'handedOver',
      header: K.columns.handedOver,
      kind: 'date',
      priority: 2,
      cell: (item) => <NoWrap>{waitedText(item.handed_over_at) ?? ''}</NoWrap>,
    },
  ];
  return (
    <HubFloor>
      <WorkList<ItemizableIntakeView>
        name="orders-to-make"
        operation="listHubIntakes"
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
          opens: 'record',
          card: (item) => (
            <CardFacts
              facts={[
                { label: K.columns.received, value: K.received(item.received) },
                ...(item.orders_made === null
                  ? []
                  : [
                      {
                        label: K.columns.orders,
                        value: K.ordersLine(item.orders_made, item.parcels_needing_order),
                      },
                    ]),
                // The table has a column for the reason and one for its act; a card holds both in the one fact, so that a senior who sees why a vendor waits is given what to do about it, and an officer is told who decides.
                ...(item.senior_needed === null
                  ? []
                  : [
                      {
                        label: K.columns.why,
                        value: (
                          <span className="orders-senior">
                            <span>{K.senior[item.senior_needed]}</span>
                            {seniorAct(item)}
                          </span>
                        ),
                      },
                    ]),
                { label: K.columns.handedOver, value: waitedText(item.handed_over_at) ?? '' },
                ...(checkingView && startAct(item) !== null
                  ? [{ label: K.columns.start, value: startAct(item) }]
                  : []),
              ]}
            />
          ),
          cardTitle: (item) => <Link to={ordersPath(item.id)}>{nameOf(item)}</Link>,
        }}
      />
    </HubFloor>
  );
}
