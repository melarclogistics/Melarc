import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';

import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { CardFacts } from '../../../components/ui/card-facts/CardFacts';
import {
  CellLines,
  NoWrap,
  RowTitle,
  type DataColumn,
} from '../../../components/ui/data-table/DataTable';
import { DescriptionList } from '../../../components/ui/description-list/DescriptionList';
import { Link } from '../../../components/ui/link/Link';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import type { IntakeRecordView } from '../../../platform/hub-receiving/use-intake-record';
import {
  workItemKey,
  type ProgressView,
  type WorkItemView,
  type WorklistViewId,
} from '../../../platform/hub-orders/orders-shape';
import { useWorklist } from '../../../platform/hub-orders/use-orders-queries';
import type { WorkListParams } from '../../../platform/pickup-work/use-pickup-work-queries';
import { refusalText } from '../../../platform/problem/capability-words';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import type { Problem } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { WorkList, type WorkView } from '../pickup-work/WorkList';
import { recordPath, runPath } from '../receiving/receiving-presentation';
import { WithRecord } from '../receiving/WithRecord';
import { OrderPhoto } from './OrderPhoto';
import {
  areaText,
  CLOSED_VENDORS_PATH,
  closePath,
  isWorklistView,
  newOrderPath,
  orderPath,
  summaryPath,
  TO_MAKE_CRUMB,
  WORK_STATE_MAP,
} from './orders-presentation';
import { vendorFactsOf, type VendorFacts } from './vendor-facts';
import './orders-pages.css';

/** The order the views are offered in: the work that is left first, then the rest. The first is the one a visit starts at. */
const VIEW_ORDER: readonly Exclude<WorklistViewId, 'all'>[] = [
  'needs_order',
  'waiting_for_vendor',
  'awaiting_arrival',
  'prepared',
  'itemized',
  'payment_required',
  'missing',
];

/** The count the server stated for a view, from the counts of the whole vendor: a count it did not give is no count, and is never drawn as nothing. */
function countOf(
  view: WorklistViewId,
  progress: ProgressView | undefined,
  mode: 'PHOTO_CHECK_IN' | 'BLIND_COUNT',
): number | null {
  if (progress === undefined) return null;
  switch (view) {
    case 'all':
      // What the view lists: the orders of a vendor counted without photos, the parcels (here, not here yet and missing) of a vendor with door photos. Never the orders of the second, which is "All 0" over three parcels.
      return mode === 'BLIND_COUNT'
        ? progress.orders
        : progress.received === null
          ? null
          : progress.received + progress.awaiting_arrival + progress.missing;
    case 'needs_order':
      return progress.needs_order;
    case 'awaiting_arrival':
      return progress.awaiting_arrival;
    case 'prepared':
      return progress.prepared;
    case 'itemized':
      return progress.itemized;
    case 'payment_required':
      return progress.payment_required;
    case 'missing':
      return progress.missing;
    case 'waiting_for_vendor':
      // The parcels the officer is waiting on the vendor's details for: the server's count, or none where it did not give one (never zero).
      return progress.waiting_for_vendor;
  }
}

/** The views of a vendor with door photos: every one of them is a list of parcels. A vendor counted without photos has orders and no parcels to wait for or to miss, so its views are the orders. */
function viewsOf(
  facts: VendorFacts,
  progress: ProgressView | undefined,
): readonly [WorkView, ...WorkView[]] {
  // A vendor whose check-in is still open opens on the parcels that are not here yet (D-D6): they are the only ones an officer can make an order for, and the views of the parcels that are here have nothing to do yet.
  const photoViews: readonly Exclude<WorklistViewId, 'all'>[] = facts.checkingIn
    ? ['awaiting_arrival', ...VIEW_ORDER.filter((view) => view !== 'awaiting_arrival')]
    : VIEW_ORDER;
  const wanted: readonly WorklistViewId[] =
    facts.mode === 'PHOTO_CHECK_IN'
      ? [...photoViews, 'all']
      : ['prepared', 'itemized', 'payment_required', 'all'];
  const [first, ...rest] = wanted.map((view): WorkView => {
    const words = WORDS.workspace.views[view];
    return {
      id: view,
      open: undefined,
      label: words.label,
      none: words.none,
      count: countOf(view, progress, facts.mode),
    };
  });
  if (first === undefined) throw new Error('A vendor has views');
  return [first, ...rest];
}

const refusalWords = (problem: Problem): string =>
  refusalText(problem.forbidden, 'hub.read', { of: 'this vendor' });

/** What the parcel's row says of the order made for it, or that none is. */
function OrderLine({ item }: { readonly item: WorkItemView }) {
  if (item.order === null) {
    return item.reversed_order === null ? (
      <span className="orders-quiet">—</span>
    ) : (
      <span className="orders-quiet">{WORDS.workspace.reversed(item.reversed_order.code)}</span>
    );
  }
  return (
    <CellLines
      first={<NoWrap>{item.order.code}</NoWrap>}
      second={item.order.recipient_name ?? ''}
    />
  );
}

/** Where the row stands, with the facts beside it that the state does not say: that payment is due, and that the officer is waiting on the vendor's details for the parcel, with what was asked and how. */
function Standing({ item }: { readonly item: WorkItemView }) {
  const waiting = item.parcel?.waiting_for_vendor ?? null;
  return (
    <span className="orders-standing">
      <StatusBadge status={item.work_state} map={WORK_STATE_MAP} />
      {item.order?.payment_required === true ? (
        <span className="orders-quiet">{WORDS.workspace.paymentDue}</span>
      ) : null}
      {waiting === null ? null : (
        <span className="orders-quiet">{WORDS.workspace.waiting.label}</span>
      )}
      {waiting?.note == null ? null : <span className="orders-quiet">{waiting.note}</span>}
    </span>
  );
}

/** The heading of a row: the parcel by its place in the vendor's list, or, for a vendor counted without photos, the order. */
const rowTitle = (item: WorkItemView): string =>
  item.parcel === null
    ? (item.order?.code ?? '')
    : item.parcel.origin === 'HUB_EXTRA'
      ? WORDS.common.extraParcel(item.parcel.ordinal)
      : WORDS.common.parcel(item.parcel.ordinal);

/** The act a row offers, by where it stands and by what the session may do. It decides nothing: the server judges every order again. */
function rowAct(
  item: WorkItemView,
  facts: VendorFacts,
  mayItemize: boolean,
): { readonly label: string; readonly to: string } | undefined {
  if (facts.closed) return undefined;
  switch (item.work_state) {
    case 'NEEDS_ORDER':
      return mayItemize && facts.cleared && item.parcel !== null
        ? { label: WORDS.workspace.acts.makeOrder, to: newOrderPath(facts.id, item.parcel.id) }
        : undefined;
    case 'AWAITING_ARRIVAL':
      return mayItemize && item.parcel !== null
        ? { label: WORDS.workspace.acts.makeOrder, to: newOrderPath(facts.id, item.parcel.id) }
        : undefined;
    case 'PREPARED':
    case 'ITEMIZED':
      return item.order === null
        ? undefined
        : { label: WORDS.workspace.acts.openOrder, to: orderPath(item.order.id) };
    case 'MISSING':
      return item.order === null
        ? undefined
        : { label: WORDS.workspace.acts.openOrder, to: orderPath(item.order.id) };
  }
}

/** The parcel opened beside the list: its photo whole, where it stands and the one act that is next for it. */
function ParcelPanel({
  item,
  facts,
  mayItemize,
}: {
  readonly item: WorkItemView;
  readonly facts: VendorFacts;
  readonly mayItemize: boolean;
}) {
  const act = rowAct(item, facts, mayItemize);
  const title = rowTitle(item);
  return (
    <>
      {item.parcel === null ? null : (
        <OrderPhoto
          parcel={item.parcel}
          size="full"
          alt={`${WORDS.workspace.panel.photo}: ${title}`}
        />
      )}
      <DescriptionList
        items={[
          { label: WORDS.workspace.panel.facts.parcel, value: title },
          ...(item.order === null
            ? []
            : [
                { label: WORDS.workspace.panel.facts.order, value: item.order.code },
                ...(item.order.recipient_name === null
                  ? []
                  : [
                      {
                        label: WORDS.workspace.panel.facts.recipient,
                        value: item.order.recipient_name,
                      },
                    ]),
                ...(item.order.service_area === null
                  ? []
                  : [
                      {
                        label: WORDS.workspace.panel.facts.area,
                        value: areaText(item.order.service_area),
                      },
                    ]),
                {
                  label: WORDS.workspace.panel.facts.size,
                  value: WORDS.form.sizes[item.order.size_class],
                },
              ]),
          {
            label: WORDS.workspace.panel.facts.standing,
            value: <Standing item={item} />,
          },
        ]}
      />
      {item.work_state === 'AWAITING_ARRIVAL' ? <p>{WORDS.workspace.panel.notYet}</p> : null}
      {item.work_state === 'MISSING' ? (
        <p>
          {item.order === null
            ? WORDS.workspace.panel.missing
            : facts.writtenOff
              ? WORDS.workspace.panel.notReceived
              : WORDS.workspace.panel.missingOrder}
        </p>
      ) : null}
      {item.work_state === 'NEEDS_ORDER' && !facts.cleared && !facts.closed ? (
        <p>
          {WORDS.workspace.notes.notCleared}{' '}
          <Link to={runPath(facts.manifestId)}>{WORDS.workspace.acts.openVendor}</Link>
        </p>
      ) : null}
      {act === undefined ? null : (
        <ButtonLink to={act.to} size="lg">
          {act.label}
        </ButtonLink>
      )}
    </>
  );
}

/** What a vendor counted blind says of its orders: how many more are needed, or that the count is awaited. A figure the server did not give is never said as nothing. */
function BlindLine({
  facts,
  progress,
}: {
  readonly facts: VendorFacts;
  readonly progress: ProgressView | undefined;
}) {
  if (progress === undefined) return null;
  if (progress.received === null || progress.needs_order === null) {
    return <p className="orders-note">{WORDS.workspace.blind.awaitingCount}</p>;
  }
  return (
    <p className="orders-note">
      {progress.needs_order > 0
        ? WORDS.workspace.blind.remaining(progress.needs_order)
        : WORDS.workspace.blind.complete(progress.received)}{' '}
      {facts.closed ? WORDS.workspace.notes.closed : ''}
    </p>
  );
}

/** Where the vendor stands, in counts of the whole vendor (never of a page), each said with what it counts. */
function ProgressFacts({
  progress,
  mode,
}: {
  readonly progress: ProgressView;
  readonly mode: VendorFacts['mode'];
}) {
  const items: { label: string; value: string }[] = [];
  const known = (value: number | null): string =>
    value === null ? WORDS.workspace.progress.awaitingCount : String(value);
  items.push({ label: WORDS.workspace.progress.arrived, value: known(progress.received) });
  if (mode === 'PHOTO_CHECK_IN') {
    items.push({ label: WORDS.workspace.progress.needsOrder, value: known(progress.needs_order) });
  }
  items.push({ label: WORDS.workspace.progress.made, value: String(progress.orders) });
  if (progress.prepared > 0) {
    items.push({ label: WORDS.workspace.progress.notConfirmed, value: String(progress.prepared) });
  }
  if (progress.payment_required > 0) {
    items.push({
      label: WORDS.workspace.progress.paymentDue,
      value: String(progress.payment_required),
    });
  }
  if (progress.awaiting_arrival > 0) {
    items.push({
      label: WORDS.workspace.progress.waiting,
      value: String(progress.awaiting_arrival),
    });
  }
  if (progress.missing > 0) {
    items.push({ label: WORDS.workspace.progress.missing, value: String(progress.missing) });
  }
  return <DescriptionList items={items} />;
}

function Workspace({
  facts,
  name,
}: {
  readonly facts: VendorFacts;
  readonly name: string | undefined;
}) {
  const me = useSignedInSession();
  const [progress, setProgress] = useState<ProgressView | undefined>(undefined);
  if (me === undefined) return null;
  const mayItemize = me.holds('hub.intake.itemize');
  const mayClose = me.holds('hub.intake.close');
  const blind = facts.mode === 'BLIND_COUNT';

  /** The worklist of this vendor, in the view the page is on. The counts of the whole vendor come with every page, and the page keeps the latest for the figures above the list. */
  function useList(params: WorkListParams) {
    const view = isWorklistView(params.view ?? null) ? (params.view as WorklistViewId) : undefined;
    const query = useWorklist(facts.id, {
      ...(view === undefined ? {} : { view }),
      ...(params.pageToken === undefined ? {} : { pageToken: params.pageToken }),
      ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
    });
    const latest = query.data?.progress;
    useEffect(() => {
      if (latest !== undefined) setProgress(latest);
    }, [latest]);
    return query;
  }

  const stillToOrder = progress?.needs_order ?? null;
  const everyParcelHasAnOrder = stillToOrder === 0;
  // An order for a parcel that arrived is taken once the vendor is cleared, never while its check-in is open (the server would refuse it as `check_in_open`), for either kind of vendor.
  const canMakeOrders = mayItemize && !facts.closed && facts.cleared;
  // While the check-in is open the next order is for a parcel that is not here yet (D-D6): offered while the server counts one, and the form finds which.
  const canOrderEarly =
    mayItemize && !facts.closed && facts.checkingIn && (progress?.awaiting_arrival ?? 0) > 0;
  const primary: ReactNode = facts.closed ? (
    <ButtonLink to={summaryPath(facts.id)}>{WORDS.workspace.acts.summary}</ButtonLink>
  ) : canMakeOrders && stillToOrder !== 0 && (blind ? stillToOrder !== null : true) ? (
    <ButtonLink to={newOrderPath(facts.id)}>
      {blind ? WORDS.workspace.acts.makeBlind : WORDS.workspace.acts.makeNext}
    </ButtonLink>
  ) : canOrderEarly ? (
    <ButtonLink to={newOrderPath(facts.id)}>{WORDS.workspace.acts.makeNext}</ButtonLink>
  ) : mayClose && facts.cleared && everyParcelHasAnOrder ? (
    <ButtonLink to={closePath(facts.id)}>{WORDS.workspace.acts.close}</ButtonLink>
  ) : undefined;
  const secondary: ReactNode =
    !facts.closed &&
    mayClose &&
    facts.cleared &&
    primary !== undefined &&
    !everyParcelHasAnOrder ? (
      <ButtonLink to={closePath(facts.id)} variant="secondary">
        {WORDS.workspace.acts.close}
      </ButtonLink>
    ) : null;
  const actions =
    primary === undefined && secondary === null ? undefined : (
      <>
        {primary}
        {secondary}
      </>
    );

  const columns: readonly DataColumn<WorkItemView>[] = [
    {
      id: 'parcel',
      header: WORDS.workspace.columns.parcel,
      rowHeader: true,
      cell: (item) => (
        <span className="orders-parcel">
          <OrderPhoto parcel={item.parcel} size="tile" alt={rowTitle(item)} />
          <RowTitle
            title={rowTitle(item)}
            name={item.parcel === null ? '' : (item.order?.code ?? '')}
          />
        </span>
      ),
    },
    {
      id: 'order',
      header: WORDS.workspace.columns.order,
      priority: 2,
      cell: (item) => <OrderLine item={item} />,
    },
    {
      id: 'size',
      header: WORDS.workspace.columns.size,
      priority: 3,
      cell: (item) => (item.order === null ? '' : WORDS.form.sizes[item.order.size_class]),
    },
    {
      id: 'standing',
      header: WORDS.workspace.columns.standing,
      cell: (item) => <Standing item={item} />,
    },
    {
      id: 'act',
      header: '',
      cell: (item) => {
        const act = rowAct(item, facts, mayItemize);
        return act === undefined ? null : (
          <Link to={act.to} aria-label={`${act.label}: ${rowTitle(item)}`}>
            {act.label}
          </Link>
        );
      },
    },
  ];

  const breadcrumb = [
    TO_MAKE_CRUMB,
    { label: name ?? facts.code, to: recordPath(facts.id) },
  ] as const;

  const note = (
    <div className="orders-summary">
      {progress === undefined ? null : blind ? (
        <BlindLine facts={facts} progress={progress} />
      ) : null}
      {progress === undefined ? null : <ProgressFacts progress={progress} mode={facts.mode} />}
      {facts.closed ? <p className="orders-note">{WORDS.workspace.notes.closed}</p> : null}
      {!facts.closed && !facts.cleared && !blind ? (
        <p className="orders-note">
          {facts.state === 'RECONCILIATION_REQUIRED'
            ? WORDS.workspace.notes.inReview
            : WORDS.workspace.notes.checkInOpen}
        </p>
      ) : null}
      {!facts.closed && !blind && everyParcelHasAnOrder ? (
        <p className="orders-note">{WORDS.workspace.notes.allDone}</p>
      ) : null}
      {!facts.closed && !blind && (progress?.awaiting_arrival ?? 0) > 0 ? (
        <p className="orders-note">{WORDS.workspace.notes.early}</p>
      ) : null}
      {facts.closed && me.holds('hub.intake.close_exception') ? (
        <p className="orders-note">
          <Link to={CLOSED_VENDORS_PATH}>{WORDS.workspace.acts.closedExceptions}</Link>
        </p>
      ) : null}
    </div>
  );

  return (
    <WorkList<WorkItemView>
      name={`orders-${facts.id}`}
      operation="listIntakeOrders"
      title={WORDS.workspace.title(name)}
      description={blind ? WORDS.workspace.blind.note : WORDS.workspace.description}
      breadcrumb={breadcrumb}
      {...(actions === undefined ? {} : { actions })}
      viewsLabel={WORDS.workspace.viewsLabel}
      views={viewsOf(facts, progress)}
      noun={WORDS.workspace.noun}
      tableLabel={WORDS.workspace.tableLabel}
      hubFilter={false}
      refusal={refusalWords}
      useList={useList}
      rowId={workItemKey}
      note={note}
      table={{
        columns,
        density: 'touch',
        openLabel: (item) => rowTitle(item),
        card: (item) => (
          <CardFacts
            lead={<OrderPhoto parcel={item.parcel} size="tile" alt={rowTitle(item)} />}
            facts={[
              { label: WORDS.workspace.columns.order, value: item.order?.code ?? '—' },
              { label: WORDS.workspace.columns.standing, value: <Standing item={item} /> },
            ]}
          />
        ),
        cardTitle: (item) => rowTitle(item),
      }}
      panel={(item: WorkItemView) => ({
        code: rowTitle(item),
        status: <StatusBadge status={item.work_state} map={WORK_STATE_MAP} />,
        body: (
          <ParcelPanel key={workItemKey(item)} item={item} facts={facts} mayItemize={mayItemize} />
        ),
      })}
    />
  );
}

/**
 * A vendor's orders (surfaces/ops-portal.md section 7, `/intakes/{id}/orders`; S1.40; `listIntakeOrders`, `hub.read`): **the work that is really left**, rebuilt from the server whenever the page is opened, after a
 * reload, on another tablet or after an interruption, because nothing is remembered in the browser. A vendor checked in against its door photos is a list of its parcels, each with its photo and where it stands
 * (needs an order, not here yet, order made and not confirmed, confirmed, missing), in views that are the server's filter with the server's counts of the whole vendor beside them; a vendor counted without photos
 * is a list of its orders, with how many more are needed ("2 more orders needed") or that the count is still awaited. A row opens the parcel beside the list with the one act that is next for it. **The page works
 * out nothing**: what a parcel needs and what a count is are the server's; an act is offered by the key the session holds and the state the row says, and the server judges every order again.
 */
export function OrdersWorkspacePage() {
  const { id = '' } = useParams();
  return (
    <WithRecord
      id={id}
      ownsHeading
      named
      heading={(record: IntakeRecordView | undefined, vendor: string | undefined) => ({
        title: WORDS.workspace.title(
          vendor ?? (record === undefined ? undefined : vendorFactsOf(record).code),
        ),
        documentTitle: WORDS.workspace.title(vendor),
      })}
      breadcrumb={() => [TO_MAKE_CRUMB]}
    >
      {(record) => <NamedWorkspace record={record} />}
    </WithRecord>
  );
}

/** The workspace for a record: the vendor's name is the record's own, for a vendor checked in against its photos and for one counted without them (Run G1, Part 2, item 9). */
function NamedWorkspace({ record }: { readonly record: IntakeRecordView }) {
  const facts = vendorFactsOf(record);
  return <Workspace facts={facts} name={facts.name ?? undefined} />;
}
