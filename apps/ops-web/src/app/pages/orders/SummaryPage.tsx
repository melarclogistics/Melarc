import { useParams } from 'react-router';

import { DataTable, RowTitle, type DataColumn } from '../../../components/ui/data-table/DataTable';
import { formatMinor } from '../../../components/ui/money/money-value';
import { Link } from '../../../components/ui/link/Link';
import { Panel } from '../../../components/ui/panel/Panel';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { PageHeader } from '../../../components/ui/page-header/PageHeader';
import { DescriptionList } from '../../../components/ui/description-list/DescriptionList';
import type { SummaryOrderView, SummaryView } from '../../../platform/hub-orders/orders-shape';
import { useSummary } from '../../../platform/hub-orders/use-orders-queries';
import { useNotifications } from '../../../platform/notifications/use-notification-queries';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import {
  AUDIENCE_LABELS,
  messageKindLabel,
  stateMapFor,
  whatHappenedText,
} from '../messages/message-presentation';
import { recordPath } from '../receiving/receiving-presentation';
import { WithRecord } from '../receiving/WithRecord';
import { Cedis } from './Cedis';
import { SummaryOrderCard } from './SummaryOrderCard';
import {
  areaText,
  commercialText,
  messageLogPath,
  orderPath,
  ordersPath,
  RECEIVING_PATH,
} from './orders-presentation';
import { vendorFactsOf } from './vendor-facts';
import './orders-pages.css';

const S = WORDS.summary;

/** The message the hub's close raised, and what became of it: the status the worker recorded, a held-back message saying so and why. Nothing is said that the log does not hold. */
function WhatWasSaid({ requestId }: { readonly requestId: string }) {
  const messages = useNotifications({ subjectId: requestId });
  return (
    <Panel title={S.said.title} headingLevel={2} region>
      <ReadState
        query={messages}
        isEmpty={(page) =>
          !page.items.some((entry) => entry.message_kind.startsWith('INTAKE_COMPLETED'))
        }
        empty={<p>{S.said.none}</p>}
        loadingLabel={S.loading}
        skeleton={<Skeleton lines={2} />}
        permission="notification.read"
        operation="listNotifications"
      >
        {(page) => (
          <>
            <ul className="orders-said">
              {page.items
                .filter((entry) => entry.message_kind.startsWith('INTAKE_COMPLETED'))
                .map((entry) => (
                  <li key={entry.id} className="orders-said__entry">
                    <span>
                      {messageKindLabel(entry.message_kind)} · {AUDIENCE_LABELS[entry.audience]}
                    </span>
                    <StatusBadge status={entry.state} map={stateMapFor(entry.channel)} />
                    {whatHappenedText(entry) === undefined ? null : (
                      <span className="orders-quiet">{whatHappenedText(entry)}</span>
                    )}
                  </li>
                ))}
            </ul>
            <p className="orders-note">
              {S.said.help} <Link to={messageLogPath(requestId)}>{S.said.open}</Link>
            </p>
          </>
        )}
      </ReadState>
    </Panel>
  );
}

function SummaryBody({
  summary,
  name,
  code,
}: {
  readonly summary: SummaryView;
  readonly name: string | undefined;
  readonly code: string;
}) {
  const me = useSignedInSession();
  const showsPrices = summary.orders.some((order) => order.locked_price !== null);
  // An order opens only for an account that may read it (the key that reads a price): a link it could not follow would lead to a refusal.
  const mayOpen = me?.holds('pricing.read') === true;
  // No column is marked lesser: the rows open nothing of the table's own, so a column taken away would leave its fact on no screen (it is cards where the columns cannot fit).
  const columns: readonly DataColumn<SummaryOrderView>[] = [
    {
      id: 'order',
      header: S.columns.order,
      rowHeader: true,
      cell: (order) =>
        mayOpen ? (
          <RowTitle code={order.code} to={orderPath(order.id)} />
        ) : (
          <RowTitle code={order.code} />
        ),
    },
    { id: 'recipient', header: S.columns.recipient, cell: (order) => order.recipient_name },
    { id: 'area', header: S.columns.area, cell: (order) => areaText(order.service_area) },
    {
      id: 'size',
      header: S.columns.size,
      cell: (order) => (order.size_class === null ? '' : WORDS.form.sizes[order.size_class]),
    },
    ...(showsPrices
      ? [
          {
            id: 'price',
            header: S.columns.price,
            kind: 'count' as const,
            cell: (order: SummaryOrderView) =>
              order.locked_price === null ? '' : <Cedis money={order.locked_price} />,
          },
        ]
      : []),
    ...(showsPrices
      ? [
          {
            id: 'whoPays',
            header: S.columns.whoPays,
            cell: (order: SummaryOrderView) =>
              order.payer_allocation === null
                ? ''
                : S.whoPays(
                    formatMinor(order.payer_allocation.sender_minor, 'GHS'),
                    formatMinor(order.payer_allocation.recipient_minor, 'GHS'),
                  ),
          },
        ]
      : []),
    {
      id: 'standing',
      header: S.columns.standing,
      cell: (order) => commercialText(order.commercial_state) ?? order.commercial_state,
    },
  ];
  return (
    <>
      <PageHeader
        title={S.title(name)}
        description={S.description}
        breadcrumb={[
          { label: WORDS.common.receiving, to: RECEIVING_PATH },
          { label: name ?? code, to: recordPath(summary.intake_id) },
          { label: WORDS.form.breadcrumbOrders, to: ordersPath(summary.intake_id) },
        ]}
      />
      <Panel title={WORDS.form.breadcrumbOrders} headingLevel={2} region>
        <DescriptionList
          items={[
            { label: S.closedAt, value: formatInstant(summary.closed_at) ?? '' },
            { label: WORDS.common.orders(summary.orders.length), value: '' },
          ]}
        />
        {summary.orders.length === 0 ? (
          <p>{S.empty}</p>
        ) : (
          <DataTable<SummaryOrderView>
            label={S.columns.order}
            columns={columns}
            rows={summary.orders}
            rowId={(order) => order.id}
            density="single"
            layout="auto"
            // Where the columns do not fit the facts are a card, and a card keeps every fact the table says.
            card={(order) => <SummaryOrderCard order={order} showsPrices={showsPrices} />}
            cardTitle={(order) => order.code}
          />
        )}
        {showsPrices || summary.orders.length === 0 ? null : (
          <p className="orders-note">{S.noPrices}</p>
        )}
      </Panel>
      {me?.holds('notification.read') === true ? (
        <WhatWasSaid requestId={summary.pickup_request_id} />
      ) : null}
    </>
  );
}

function Summarizing({
  id,
  name,
  code,
}: {
  readonly id: string;
  readonly name: string | undefined;
  readonly code: string;
}) {
  const summary = useSummary(id);
  return (
    <ReadState<SummaryView>
      query={summary}
      isEmpty={() => false}
      empty={null}
      loadingLabel={S.loading}
      skeleton={<Skeleton lines={4} />}
      permission="pickup.read"
      operation="getIntakeSummary"
    >
      {(view) => <SummaryBody summary={view} name={name} code={code} />}
    </ReadState>
  );
}

/**
 * The summary of a closed vendor, as the hub has it (surfaces/ops-portal.md section 7, `/intakes/{id}/summary`; S1.40; `getIntakeSummary`, `pickup.read`; AC-SLICE-001-46): the orders the hub made for the vendor
 * and where each stands, **and nothing of the receiving side**. **A price is drawn only where the server gave one**, which for staff is only where their own pricing grant reaches the hub (OB-S1-155): an absent
 * price is said to be one this account does not see, and is never drawn as nothing. Beside it, **what was said about the close, as the worker recorded it** (the text to the sender, the entry for the vendor): a
 * message that was held back says so and why. A vendor that is not closed has no summary, and the page says so.
 */
export function SummaryPage() {
  const { id = '' } = useParams();
  return (
    <WithRecord
      id={id}
      ownsHeading
      named
      heading={(_record, vendor) => ({ title: S.title(vendor), documentTitle: S.documentTitle })}
      breadcrumb={() => [{ label: WORDS.common.receiving, to: RECEIVING_PATH }]}
    >
      {(record) => (
        <Summarizing
          id={vendorFactsOf(record).id}
          name={record.kind === 'check-in' ? record.view.vendor_name : undefined}
          code={vendorFactsOf(record).code}
        />
      )}
    </WithRecord>
  );
}
