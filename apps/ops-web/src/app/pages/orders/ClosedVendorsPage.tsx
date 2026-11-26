import { CardFacts } from '../../../components/ui/card-facts/CardFacts';
import {
  CellLines,
  NoWrap,
  RowTitle,
  type DataColumn,
} from '../../../components/ui/data-table/DataTable';
import { DescriptionList } from '../../../components/ui/description-list/DescriptionList';
import { HubFloor } from '../../../components/ui/hub-floor/HubFloor';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import type { ClosedExceptionView } from '../../../platform/hub-orders/orders-shape';
import { useClosedExceptions } from '../../../platform/hub-orders/use-orders-queries';
import type { WorkListParams } from '../../../platform/pickup-work/use-pickup-work-queries';
import { refusalText } from '../../../platform/problem/capability-words';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import type { Problem } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { waitedText } from '../../../platform/time/waited';
import { WorkList, type WorkView } from '../pickup-work/WorkList';
import { recordPath } from '../receiving/receiving-presentation';
import { summaryPath } from './orders-presentation';
import './orders-pages.css';

const K = WORDS.closedExceptions;

const VIEWS: readonly [WorkView, ...WorkView[]] = [{ id: 'all', open: undefined, ...K.views.all }];

const refusalWords = (problem: Problem): string =>
  refusalText(problem.forbidden, 'hub.intake.close_exception', { of: 'closed vendors' });

function useQueue(params: WorkListParams) {
  return useClosedExceptions({
    ...(params.pageToken === undefined ? {} : { pageToken: params.pageToken }),
    ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
  });
}

/**
 * Closed with parcels left (surfaces/ops-portal.md section 7, `/closed-vendors`; S1.40; `listClosedIntakeExceptions`, `hub.intake.close_exception`; OB-S1-151): **the work a close left behind is found
 * again**, by another officer, after a reload or on the next shift. Each row is a vendor that was closed with the approved exception and **still has received parcels without an order**, newest close first, with
 * what the hub received, how many orders stand, how many parcels are left and the reason that was given. A vendor with nothing left is not in the list. **Nothing here adds the missing orders**: a closed vendor
 * cannot take more, the reopening and the report of a parcel found after the close are scheduled and not built, and the page says so in words and draws no act it does not have.
 */
export function ClosedVendorsPage() {
  const me = useSignedInSession();
  if (me === undefined) return null;
  const columns: readonly DataColumn<ClosedExceptionView>[] = [
    {
      id: 'vendor',
      header: K.columns.vendor,
      rowHeader: true,
      cell: (item) => (
        <RowTitle
          title={item.vendor_name ?? item.intake_code}
          name={
            item.vendor_name === null
              ? K.modes[item.receiving_mode]
              : K.modeLine(item.intake_code, K.modes[item.receiving_mode])
          }
        />
      ),
    },
    {
      id: 'closed',
      header: K.columns.closed,
      kind: 'date',
      cell: (item) => (
        <CellLines
          first={<NoWrap>{waitedText(item.closed_at) ?? ''}</NoWrap>}
          second={<NoWrap>{formatInstant(item.closed_at) ?? ''}</NoWrap>}
        />
      ),
    },
    {
      id: 'still',
      header: K.columns.still,
      kind: 'count',
      cell: (item) => K.stillCount(item.outstanding_count),
    },
    {
      id: 'reason',
      header: K.columns.reason,
      priority: 2,
      cell: (item) => item.exception_note ?? K.noReason,
    },
  ];
  return (
    <HubFloor>
      <WorkList<ClosedExceptionView>
        name="closed-vendors"
        operation="listClosedIntakeExceptions"
        title={K.title}
        description={K.description}
        viewsLabel={K.viewsLabel}
        views={VIEWS}
        noun={K.noun}
        tableLabel={K.tableLabel}
        hubFilter={false}
        refusal={refusalWords}
        useList={useQueue}
        rowId={(item) => item.intake_id}
        note={K.notice}
        table={{
          columns,
          density: 'touch',
          openLabel: (item) => `${K.acts.openVendor}: ${item.vendor_name ?? item.intake_code}`,
          card: (item) => (
            <CardFacts
              facts={[
                { label: K.columns.still, value: K.stillCount(item.outstanding_count) },
                { label: K.columns.closed, value: waitedText(item.closed_at) ?? '' },
              ]}
            />
          ),
          cardTitle: (item) => item.vendor_name ?? item.intake_code,
        }}
        panel={(item) => ({
          code: item.intake_code,
          body: (
            <>
              <DescriptionList
                items={[
                  { label: K.facts.mode, value: K.modes[item.receiving_mode] },
                  { label: K.facts.closed, value: formatInstant(item.closed_at) ?? '' },
                  { label: K.facts.received, value: String(item.received) },
                  { label: K.facts.ordered, value: String(item.ordered) },
                  { label: K.facts.still, value: K.stillCount(item.outstanding_count) },
                  { label: K.facts.reason, value: item.exception_note ?? K.noReason },
                ]}
              />
              <p className="orders-note">{K.notice}</p>
              <div className="orders-saved__acts orders-saved__acts--after">
                <ButtonLink to={recordPath(item.intake_id)} size="lg">
                  {K.acts.openVendor}
                </ButtonLink>
                {me.holds('pickup.read') ? (
                  <ButtonLink to={summaryPath(item.intake_id)} variant="secondary" size="lg">
                    {K.acts.openSummary}
                  </ButtonLink>
                ) : null}
              </div>
            </>
          ),
        })}
      />
    </HubFloor>
  );
}
