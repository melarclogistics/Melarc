import { useState } from 'react';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { CardFacts } from '../../../components/ui/card-facts/CardFacts';
import {
  CellLines,
  NoWrap,
  RowTitle,
  type DataColumn,
} from '../../../components/ui/data-table/DataTable';
import { DescriptionList } from '../../../components/ui/description-list/DescriptionList';
import { Link } from '../../../components/ui/link/Link';
import { useApiClient } from '../../../platform/api/api-client';
import { recordParcelArrival } from '../../../platform/hub-receiving/receiving-commands';
import {
  MISSING_VIEWS,
  type MissingParcelView,
  type MissingView,
} from '../../../platform/hub-receiving/receiving-shape';
import { useMissingParcels } from '../../../platform/hub-receiving/use-receiving-queries';
import type { WorkListParams } from '../../../platform/pickup-work/use-pickup-work-queries';
import { refusalText } from '../../../platform/problem/capability-words';
import { problemOf, type Problem } from '../../../platform/problem/problem-copy';
import { RECEIVING_WORDS as WORDS } from '../../../platform/problem/receiving-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { waitedText } from '../../../platform/time/waited';
import { WorkList, type PanelTools, type WorkView } from '../pickup-work/WorkList';
import { MissingPicture } from './MissingPicture';
import { recordPath, runPath } from './receiving-presentation';
import './receiving-pages.css';

/** The list's views are the API's `view` filter, and the page filters nothing itself. */
const VIEWS: readonly [WorkView, ...WorkView[]] = [
  { id: 'searching', open: undefined, ...WORDS.missingList.views.searching },
  { id: 'vendor_to_tell', open: undefined, ...WORDS.missingList.views.vendor_to_tell },
];

const refusalWords = (problem: Problem): string =>
  refusalText(problem.forbidden, 'hub.read', { of: 'missing parcels' });

const isMissingView = (value: string | undefined): value is MissingView =>
  value !== undefined && (MISSING_VIEWS as readonly string[]).includes(value);

/** The list the page asks, from the view it is on and the hub the switcher chose: both are the API's filters. */
function useMissingQueue(params: WorkListParams) {
  return useMissingParcels({
    ...(isMissingView(params.view) ? { view: params.view } : {}),
    ...(params.hubId === undefined ? {} : { hubId: params.hubId }),
    ...(params.pageToken === undefined ? {} : { pageToken: params.pageToken }),
    ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
  });
}

/** How long the parcel has been missing, with the moment under it. */
function MissingFor({ item }: { readonly item: MissingParcelView }) {
  return (
    <CellLines
      first={<NoWrap>{waitedText(item.missing_since) ?? ''}</NoWrap>}
      second={<NoWrap>{formatInstant(item.missing_since) ?? ''}</NoWrap>}
    />
  );
}

function MissingCard({ item }: { readonly item: MissingParcelView }) {
  return (
    <CardFacts
      lead={<MissingPicture item={item} size="tile" />}
      facts={[
        { label: WORDS.missingList.columns.vendor, value: item.vendor_name },
        { label: WORDS.missingList.columns.run, value: item.run_code },
        {
          label: WORDS.missingList.columns.missingFor,
          value: waitedText(item.missing_since) ?? '',
        },
      ]}
    />
  );
}

/**
 * The parcel opened beside the list: its photo whole, where it went missing and for how long, and **one act, *Found: check it in***, to an officer who may check parcels in and while the search is open. The act
 * is the tap of the run's page (`recordParcelArrival`, no version and no key: it states the parcel's desired state, so it is idempotent), after which the list is read again and the officer is told which vendor's parcel
 * is checked in. A parcel that was written off is not found by this page: the search is over, and a senior officer records that the vendor was told on the vendor's page.
 */
function MissingPanel({
  item,
  mayCount,
  tools,
}: {
  readonly item: MissingParcelView;
  readonly mayCount: boolean;
  readonly tools: PanelTools;
}) {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Problem | undefined>(undefined);
  const writtenOff = item.written_off_at !== null;

  async function found(): Promise<void> {
    // A second press while the first is on its way is ignored, never a second request.
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await recordParcelArrival(client, item.parcel_id, true);
      tools.acted(<p>{WORDS.missingList.foundDone(item.vendor_name)}</p>);
    } catch (error: unknown) {
      const problem = problemOf(error, { operation: 'recordParcelArrival' });
      setFailure(problem);
      // The parcel changed under the officer (someone found it, or the search was closed): the list is read again, and the panel stays to say so.
      if (problem.kind === 'conflict') void tools.reload();
      setBusy(false);
    }
  }

  return (
    <>
      <MissingPicture item={item} size="full" />
      <DescriptionList
        items={[
          {
            label: WORDS.missingList.facts.vendor,
            value: <Link to={recordPath(item.intake_id)}>{item.vendor_name}</Link>,
          },
          {
            label: WORDS.missingList.facts.run,
            value: <Link to={runPath(item.run_id)}>{item.run_code}</Link>,
          },
          {
            label: WORDS.missingList.facts.missingSince,
            value: formatInstant(item.missing_since) ?? '',
          },
          {
            label: WORDS.missingList.facts.missingFor,
            value: waitedText(item.missing_since) ?? '',
          },
          ...(item.written_off_at === null
            ? []
            : [
                {
                  label: WORDS.missingList.facts.writtenOff,
                  value: formatInstant(item.written_off_at) ?? '',
                },
              ]),
        ]}
      />
      {writtenOff ? <p>{WORDS.missingList.writtenOffNote}</p> : null}
      {failure === undefined ? null : (
        <Alert variant="danger" announce>
          <p>{failure.message}</p>
        </Alert>
      )}
      {mayCount && !writtenOff ? (
        <Button
          type="button"
          size="lg"
          loading={busy}
          onClick={() => {
            void found();
          }}
        >
          {WORDS.missingList.found}
        </Button>
      ) : null}
    </>
  );
}

/**
 * *Missing — being searched for* (surfaces/ops-portal.md section 7, `/missing-parcels`; S1.35c; D-D4): the parcels that were not on the table when a vendor was checked in, from `listMissingParcels`, **oldest
 * first**, each with its photo, its vendor and run and how long it has been missing, in two views that are the API's `view` filter (*Being searched for*, and *Written off, vendor not told yet*). The hub the
 * switcher chose narrows it. **The page filters nothing and works nothing out**: how long a parcel has been missing is the moment it went missing set against now, in words. A row opens the parcel beside the list;
 * the one act is finding it. The system sends nobody anything: a parcel that is written off is told to the vendor by a person, and the record of it is the vendor's page.
 */
export function MissingParcelsPage() {
  const me = useSignedInSession();
  if (me === undefined) return null;
  const mayCount = me.holds('hub.intake.count');

  const columns: readonly DataColumn<MissingParcelView>[] = [
    {
      id: 'parcel',
      header: WORDS.missingList.columns.parcel,
      rowHeader: true,
      cell: (item) => <MissingPicture item={item} size="tile" />,
    },
    {
      id: 'vendor',
      header: WORDS.missingList.columns.vendor,
      cell: (item) => <RowTitle title={item.vendor_name} name={item.intake_code} />,
    },
    {
      id: 'run',
      header: WORDS.missingList.columns.run,
      priority: 2,
      cell: (item) => item.run_code,
    },
    {
      id: 'missingFor',
      header: WORDS.missingList.columns.missingFor,
      kind: 'date',
      cell: (item) => <MissingFor item={item} />,
    },
  ];

  return (
    <WorkList<MissingParcelView>
      name="missing-parcels"
      operation="listMissingParcels"
      title={WORDS.missingList.title}
      description={WORDS.missingList.description}
      viewsLabel={WORDS.missingList.viewsLabel}
      views={VIEWS}
      noun={{ plural: 'missing parcels', one: 'missing parcel', other: 'missing parcels' }}
      tableLabel={WORDS.missingList.tableLabel}
      refusal={refusalWords}
      useList={useMissingQueue}
      rowId={(item) => item.parcel_id}
      table={{
        columns,
        density: 'two-line',
        openLabel: (item) => WORDS.missingList.open(item.vendor_name),
        card: (item) => <MissingCard item={item} />,
        cardTitle: (item) => item.vendor_name,
      }}
      panel={(item, tools) => ({
        code: item.intake_code,
        body: <MissingPanel key={item.parcel_id} item={item} mayCount={mayCount} tools={tools} />,
      })}
    />
  );
}
