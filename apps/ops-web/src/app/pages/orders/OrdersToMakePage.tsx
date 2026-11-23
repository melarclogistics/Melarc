import { CardFacts } from '../../../components/ui/card-facts/CardFacts';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import {
  CellLines,
  NoWrap,
  RowTitle,
  type DataColumn,
} from '../../../components/ui/data-table/DataTable';
import { DescriptionList } from '../../../components/ui/description-list/DescriptionList';
import { HubFloor } from '../../../components/ui/hub-floor/HubFloor';
import { Link } from '../../../components/ui/link/Link';
import type { ItemizableIntakeView } from '../../../platform/hub-orders/intake-list-shape';
import { useItemizableIntakes } from '../../../platform/hub-orders/use-orders-queries';
import type { WorkListParams } from '../../../platform/pickup-work/use-pickup-work-queries';
import { refusalText } from '../../../platform/problem/capability-words';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import type { Problem } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { waitedText } from '../../../platform/time/waited';
import { WorkList, type WorkView } from '../pickup-work/WorkList';
import { recordPath, runPath } from '../receiving/receiving-presentation';
import { ordersPath } from './orders-presentation';
import './orders-pages.css';

const K = WORDS.toMake;

/** The views are the server's `state` filter: the vendors cleared and waiting for their first order, and the ones whose orders are being made. */
const VIEWS: readonly [WorkView, ...WorkView[]] = [
  { id: 'READY_FOR_ITEMIZATION', open: undefined, ...K.views.READY_FOR_ITEMIZATION },
  { id: 'ITEMIZING', open: undefined, ...K.views.ITEMIZING },
];

const refusalWords = (problem: Problem): string =>
  refusalText(problem.forbidden, 'hub.read', { of: 'vendors' });

function useQueue(params: WorkListParams) {
  return useItemizableIntakes({
    state: params.view === 'ITEMIZING' ? 'ITEMIZING' : 'READY_FOR_ITEMIZATION',
    ...(params.pageToken === undefined ? {} : { pageToken: params.pageToken }),
    ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
  });
}

const nameOf = (item: ItemizableIntakeView): string => item.vendor_name ?? item.code;

/**
 * Orders to make (surfaces/ops-portal.md section 7, `/orders-to-make`; S1.40; `listHubIntakes`, `hub.read`): **the vendors a hub has cleared for their orders**, oldest handover first, in the server's views (ready
 * to start, being worked), so that an officer finds the work without remembering which vendors finished checking in. A row opens the vendor beside the list with the one act that is next, *Make orders*, which goes
 * to the vendor's orders, where the work that is really left is counted. **How many orders are made is not on a row**: the list does not state it, and the page draws no figure it was not given.
 */
export function OrdersToMakePage() {
  const me = useSignedInSession();
  if (me === undefined) return null;
  const columns: readonly DataColumn<ItemizableIntakeView>[] = [
    {
      id: 'vendor',
      header: K.columns.vendor,
      rowHeader: true,
      cell: (item) => (
        <RowTitle title={nameOf(item)} name={item.vendor_name === null ? K.blind : item.code} />
      ),
    },
    { id: 'run', header: K.columns.run, priority: 3, cell: (item) => item.run_code ?? '' },
    {
      id: 'received',
      header: K.columns.received,
      kind: 'count',
      cell: (item) => (
        <CellLines
          first={<NoWrap>{K.received(item.received)}</NoWrap>}
          second={item.missing === null || item.missing === 0 ? '' : K.missing(item.missing)}
        />
      ),
    },
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
        note={K.note}
        table={{
          columns,
          density: 'touch',
          openLabel: (item) => K.acts.openFor(nameOf(item)),
          card: (item) => (
            <CardFacts
              facts={[
                { label: K.columns.received, value: K.received(item.received) },
                { label: K.columns.handedOver, value: waitedText(item.handed_over_at) ?? '' },
              ]}
            />
          ),
          cardTitle: (item) => nameOf(item),
        }}
        panel={(item) => ({
          code: item.code,
          body: (
            <>
              <DescriptionList
                items={[
                  {
                    label: K.columns.vendor,
                    value: <Link to={recordPath(item.id)}>{nameOf(item)}</Link>,
                  },
                  ...(item.run_code === null
                    ? []
                    : [
                        {
                          label: K.columns.run,
                          value: <Link to={runPath(item.pickup_manifest_id)}>{item.run_code}</Link>,
                        },
                      ]),
                  { label: K.columns.received, value: K.received(item.received) },
                  ...(item.missing === null || item.missing === 0
                    ? []
                    : [{ label: WORDS.workspace.progress.missing, value: String(item.missing) }]),
                  { label: K.columns.handedOver, value: formatInstant(item.handed_over_at) ?? '' },
                ]}
              />
              <p className="orders-note">{K.note}</p>
              {me.holds('hub.intake.itemize') || me.holds('hub.read') ? (
                <ButtonLink to={ordersPath(item.id)} size="lg">
                  {K.acts.open}
                </ButtonLink>
              ) : null}
            </>
          ),
        })}
      />
    </HubFloor>
  );
}
