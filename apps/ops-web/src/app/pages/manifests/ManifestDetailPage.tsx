import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useParams } from 'react-router';

import type { ActionMenuItem } from '../../../components/ui/action-menu/ActionMenu';
import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import {
  DescriptionList,
  type DescriptionItem,
} from '../../../components/ui/description-list/DescriptionList';
import { Link } from '../../../components/ui/link/Link';
import { Panel } from '../../../components/ui/panel/Panel';
import type { Stage } from '../../../components/ui/record-header/StageTracker';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { RecordPage } from '../../../components/ui/templates/RecordPage';
import { Timeline, type TimelineEntry } from '../../../components/ui/timeline/Timeline';
import { useApiClient } from '../../../platform/api/api-client';
import {
  assignRider,
  cancelPickupManifest,
  dispatchManifest,
  type ManifestRecord,
} from '../../../platform/manifest/manifest-commands';
import type { ManifestView } from '../../../platform/manifest/manifest-shape';
import { subjectLogPath } from '../../../platform/notifications/notification-shape';
import { lackedText } from '../../../platform/problem/capability-words';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { NoteActDialog } from '../pickup/PickupActDialogs';
import { serviceDateText } from '../pickup/pickup-presentation';
import { hubNameOf } from '../staff/staff-presentation';
import { CustodySection, RiderName } from './CustodySection';
import { AssignRiderDialog, DispatchDialog } from './ManifestActDialogs';
import { MANIFEST_STATE_MAP, MANIFEST_STATE_SENTENCES, stopsText } from './manifest-presentation';
import type { SkippedState } from './StopSkipPage';
import { StopsSection } from './StopsSection';
import { useFocusFallenToHeading, WithManifest } from './WithManifest';
import '../pickup/pickup-pages.css';
import './manifests-pages.css';

/** The acts that open their own question from the header's buttons (the cancellation is the menu's, and brings its own dialog). */
type Act = 'assign' | 'dispatch';

/** What a page that just made a pickup run tells the one it brings here (router state; a reload of the page is not a creation). */
export interface CreatedState {
  readonly created?: true;
}

/**
 * The one short line under the acts, only when it changes whether to act now (the Product Owner, 9 November 2026: a rule lives in the confirmation of the act, where the choice is made, and
 * not in paragraphs above the content). A draft says what has to come first (a rider, before the dispatch: the page decides nothing and keeps the act, the server refuses a dispatch with no
 * rider) or what the rider sees until it is sent out, and what the session cannot do; a run to which a rider is bound says how to give it to another; a run that has started says it cannot be
 * cancelled and where the way out is, the skip of a stop and the handover in the custody panel. A finished run says nothing: the header's sentence says where it stands. **The rule is said once**:
 * the header's sentence of a draft says where it stands and not what comes first (the Product Owner, 10 November 2026).
 */
const NEEDS_A_RIDER_NOTE = 'Assign a rider before you dispatch.';
const NEEDS_A_RIDER_FOR_ANOTHER_NOTE =
  'A rider has to be assigned before the pickup run is dispatched.';
const DISPATCH_NOTE = 'The rider sees nothing until you dispatch.';
const NOT_YET_NOTE = 'The rider sees nothing until the pickup run is dispatched.';
const NO_NEW_RIDER_NOTE =
  'A rider cannot be changed once the pickup run is dispatched: cancel it and plan its requests again.';
const STARTED_NOTE =
  'A run that has started cannot be cancelled. Skip a stop that cannot be worked, below. If the rider cannot go on, hand the parcels to another rider or to the hub, in the custody panel.';

/**
 * The way a pickup run goes, for the tracker (`contracts/state-machines.md` section 4): **one forward path**, draft, dispatched, in progress and completed, and one end, cancelled (from a
 * draft or a dispatched run), drawn as the end it is: the last stage, reached. A run that was cancelled after it was dispatched has been through the dispatch; one that was not has not.
 * Assigning a rider is a fact of a draft (`assigned_at`) and not a state, so it is not a stage; it is in the history.
 */
function stagesOf(manifest: ManifestView): {
  readonly label: string;
  readonly stages: readonly Stage[];
  readonly currentId: string;
} {
  const label = 'Progress of the pickup run';
  const stage = (id: string, state: ManifestView['state']): Stage => ({
    id,
    label: MANIFEST_STATE_MAP[state].label,
  });
  const draft = stage('draft', 'DRAFT');
  const dispatched = stage('dispatched', 'DISPATCHED');
  const inProgress = stage('in-progress', 'IN_PROGRESS');
  const completed = stage('completed', 'COMPLETED');
  const forward = [draft, dispatched, inProgress, completed];
  switch (manifest.state) {
    case 'DRAFT':
      return { label, stages: forward, currentId: 'draft' };
    case 'DISPATCHED':
      return { label, stages: forward, currentId: 'dispatched' };
    case 'IN_PROGRESS':
      return { label, stages: forward, currentId: 'in-progress' };
    case 'COMPLETED':
      return { label, stages: forward, currentId: 'completed' };
    case 'CANCELLED':
      return {
        label,
        stages: [
          draft,
          ...(manifest.dispatched_at === undefined ? [] : [dispatched]),
          stage('cancelled', 'CANCELLED'),
        ],
        currentId: 'cancelled',
      };
  }
}

/**
 * What the record itself says happened, with when: the run made (`created_at`, contract 5.100.0), a rider assigned, dispatched, started, completed. **Only the dated facts of the record,
 * and nothing invented**: the read carries no moment of the run's cancellation (a cancelled run says so in its state and its words; the moment is an open item of the manifests slice,
 * OB-S1-79), and a history that names who did each act would need a read of the run's audit trail, which the pickup API does not offer to an Ops session (a later contract task,
 * IMPLEMENTATION_PLAN section 3a). Oldest first, the latest marked.
 */
function historyOf(manifest: ManifestView): readonly TimelineEntry[] {
  const facts = [
    ['made', 'Made', manifest.created_at],
    ['assigned', 'Assigned', manifest.assigned_at],
    ['dispatched', 'Dispatched', manifest.dispatched_at],
    ['started', 'Started', manifest.started_at],
    ['completed', 'Completed', manifest.completed_at],
  ] as const;
  const dated = facts.flatMap(([key, title, at]) => (at === undefined ? [] : [{ key, title, at }]));
  const ordered = [...dated].sort((first, second) => Date.parse(first.at) - Date.parse(second.at));
  return ordered.map((entry, index) => ({
    key: entry.key,
    title: entry.title,
    details: <p>{formatInstant(entry.at) ?? ''}</p>,
    current: index === ordered.length - 1,
  }));
}

function Manifest({
  record,
  query,
}: {
  readonly record: ManifestRecord;
  readonly query: UseQueryResult<ManifestRecord>;
}) {
  const client = useApiClient();
  const me = useSignedInSession();
  const location = useLocation();
  const arrival = location.state as (CreatedState & SkippedState) | null;
  const [open, setOpen] = useState<Act | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(
    arrival?.created === true
      ? 'The pickup run is made. It is a draft: order its stops, give it a rider and dispatch it.'
      : arrival?.skipped === true
        ? 'The stop is skipped and the vendor is told. The pickup run is read again below: skipping the last stop to be worked of a run that collected nothing completes the run.'
        : undefined,
  );
  // The stops a refused dispatch named, until the pickup run is read again.
  const [flagged, setFlagged] = useState<ReadonlySet<string>>(new Set());
  const noticeBox = useRef<HTMLDivElement>(null);
  // Focus goes to the news of an act the person has just done, here; the news of an arrival (the run was just made, a stop was just
  // skipped) is read in its place, because the arrival has put focus on the heading of the page, where a person starts.
  const focusNotice = useRef(false);
  useFocusFallenToHeading();
  useEffect(() => {
    if (notice !== undefined && focusNotice.current) noticeBox.current?.focus();
  }, [notice]);
  if (me === undefined) return null;

  const { manifest, etag } = record;
  const id = manifest.id;
  const draft = manifest.state === 'DRAFT';
  const dispatched = manifest.state === 'DISPATCHED';
  const inProgress = manifest.state === 'IN_PROGRESS';
  const riderId = manifest.assigned_rider_id;
  const history = historyOf(manifest);

  function close(): void {
    setOpen(undefined);
  }
  /** The act was done: say what it came to and read the pickup run again for its new state and version. */
  function done(text: string): void {
    focusNotice.current = true;
    setOpen(undefined);
    setFlagged(new Set());
    setNotice(text);
    void query.refetch();
  }
  function reload(): Promise<unknown> {
    setOpen(undefined);
    setNotice(undefined);
    setFlagged(new Set());
    return query.refetch();
  }
  /** Stops by their place in the order, which is how an officer reads a run: "stops 2 and 4". */
  function stopsNamed(stopIds: readonly string[]): string {
    const places = manifest.stops
      .filter((stop) => stopIds.some((named) => named.toLowerCase() === stop.id.toLowerCase()))
      .map((stop) => String(stop.sequence));
    if (places.length === 0) return 'some stops';
    return `${places.length === 1 ? 'stop' : 'stops'} ${places.join(' and ')}`;
  }

  // The acts the session can take, and no other: hiding is presentation and never enforcement, and the server checks the key, the hub and the state. Assigning a rider and
  // dispatching are two acts with a button each, never one: the next of the two to make is the primary, and the other stays beside it.
  const holdsAssign = me.holds('pickup.manifest.assign');
  const holdsDispatch = me.holds('pickup.manifest.dispatch');
  const holdsCancel = me.holds('pickup.manifest.create');
  const actButton = (act: Act, primary: boolean): ReactNode => (
    <Button
      key={act}
      type="button"
      {...(primary ? {} : { variant: 'secondary' as const })}
      onClick={() => {
        setOpen(act);
      }}
    >
      {act === 'dispatch'
        ? 'Dispatch the pickup run'
        : riderId === undefined
          ? 'Assign a rider'
          : 'Choose another rider'}
    </Button>
  );
  const offered: readonly Act[] = draft
    ? [
        ...(holdsAssign ? (['assign'] as const) : []),
        ...(holdsDispatch ? (['dispatch'] as const) : []),
      ]
    : [];
  const next: Act = riderId === undefined ? 'assign' : 'dispatch';
  const primaryAct = offered.includes(next) ? next : offered[0];
  const secondaryAct = offered.find((act) => act !== primaryAct);
  const primary = primaryAct === undefined ? undefined : actButton(primaryAct, true);
  const secondary = secondaryAct === undefined ? undefined : actButton(secondaryAct, false);

  // The rarer and heavier act: the cancellation, last, always confirmed, with its own question and its own note.
  const menu: ActionMenuItem[] =
    (draft || dispatched) && holdsCancel
      ? [
          {
            id: 'cancel',
            label: 'Cancel the pickup run',
            destructive: true as const,
            dialog: ({ onClose }: { readonly onClose: () => void }) => (
              <NoteActDialog<ManifestRecord>
                open
                title="Cancel this pickup run?"
                consequence={
                  <p>
                    The stops still to be worked are skipped and every claim is released: the
                    requests that are still confirmed return to the pool, with their commitment to a
                    rider ended. A request cancelled in the meantime stays cancelled. The run has
                    not started, so nothing has been collected.
                  </p>
                }
                confirmLabel="Cancel the pickup run"
                confirmVariant="danger"
                noteLabel="Why it is cancelled"
                noteHelp="One line, kept with the cancellation. Leave out phone numbers and email addresses."
                operation="cancelPickupManifest"
                notePointer="/note"
                version={etag}
                retryable
                send={(note, version, key) => cancelPickupManifest(client, id, version, note, key)}
                onDone={() => {
                  onClose();
                  done(
                    'The pickup run is cancelled. Its requests that are still confirmed are back in the pool.',
                  );
                }}
                onCancel={onClose}
                onReload={() => {
                  onClose();
                  return reload();
                }}
              />
            ),
          },
        ]
      : [];

  // The one short line under the acts (see NEEDS_A_RIDER_NOTE): what changes whether to act now, and nothing a dialog says. What each act does and closes is said where the choice is made, in the
  // act's own question. A draft says what comes first, and, for a session that holds some of the acts of a draft and not others (or none), what it cannot do, **in one sentence naming every one it
  // lacks** (the table's words, `cannotAllText`); a run that is finished says nothing.
  const lacks = draft
    ? lackedText(me.holds, [
        'pickup.manifest.assign',
        'pickup.manifest.dispatch',
        'pickup.manifest.create',
      ])
    : undefined;
  const first = !draft
    ? undefined
    : holdsDispatch
      ? riderId === undefined
        ? holdsAssign
          ? NEEDS_A_RIDER_NOTE
          : NEEDS_A_RIDER_FOR_ANOTHER_NOTE
        : DISPATCH_NOTE
      : holdsAssign
        ? NOT_YET_NOTE
        : undefined;
  const note: string | undefined = draft
    ? [first, lacks].filter((line) => line !== undefined).join(' ')
    : dispatched
      ? holdsCancel
        ? NO_NEW_RIDER_NOTE
        : undefined
      : inProgress
        ? STARTED_NOTE
        : undefined;

  const facts: readonly DescriptionItem[] = [
    { label: 'Service date', value: serviceDateText(manifest.service_date) },
    { label: 'Hub', value: hubNameOf(manifest.responsible_hub_id, me.session.authorized_hubs) },
    {
      label: 'Rider',
      value: riderId === undefined ? 'No rider assigned yet' : <RiderName id={riderId} />,
    },
    { label: 'Stops', value: stopsText(manifest.stops.length) },
  ];

  return (
    <>
      <RecordPage
        header={{
          code: manifest.code,
          status: <StatusBadge status={manifest.state} map={MANIFEST_STATE_MAP} />,
          sentence: MANIFEST_STATE_SENTENCES[manifest.state],
          stages: stagesOf(manifest),
        }}
        acts={{
          ...(primary === undefined ? {} : { primary }),
          ...(secondary === undefined ? {} : { secondary }),
          menu: { label: `More actions for ${manifest.code}`, items: menu },
          ...(note === undefined ? {} : { note }),
        }}
        notice={
          notice === undefined ? undefined : (
            <div className="pickup-notice" ref={noticeBox} tabIndex={-1}>
              <Alert variant="success">
                <p>{notice}</p>
              </Alert>
            </div>
          )
        }
        main={
          <>
            <Panel title="The pickup run" headingLevel={2}>
              <DescriptionList items={facts} />
            </Panel>
            <StopsSection
              record={record}
              flagged={flagged}
              onSaved={() => {
                done('The order of the stops is saved.');
              }}
              onReload={reload}
            />
            {inProgress ? <CustodySection record={record} onDone={done} onReload={reload} /> : null}
          </>
        }
        // Beside the work where the page has room, after it where it has not: when each thing happened, and what is related.
        side={
          <>
            {history.length === 0 ? null : (
              <Panel title="History" headingLevel={2}>
                <Timeline label="History of this pickup run, oldest first" entries={history} />
              </Panel>
            )}
            {me.holds('notification.read') ? (
              <Panel title="Related" headingLevel={2}>
                {/* The message log narrowed to this run, for a session that lists the key of the log (the server checks it all the same). */}
                <p>
                  <Link to={subjectLogPath('PICKUP_MANIFEST', id)}>Messages about this run</Link>
                </p>
              </Panel>
            ) : null}
          </>
        }
      />

      <AssignRiderDialog<ManifestRecord>
        open={open === 'assign'}
        hubId={manifest.responsible_hub_id}
        version={etag}
        send={(riderId2, version) => assignRider(client, id, version, riderId2)}
        onDone={() => {
          done(
            'A rider is assigned. The pickup run is still a draft: dispatch it to show the stops to the rider.',
          );
        }}
        onCancel={close}
        onReload={reload}
      />
      <DispatchDialog<ManifestRecord>
        open={open === 'dispatch'}
        riderName={undefined}
        version={etag}
        send={(version) => dispatchManifest(client, id, version)}
        onDone={() => {
          done(
            'The pickup run is dispatched. The rider can see its stops; the run starts on its day.',
          );
        }}
        onCancel={close}
        onReload={reload}
        onStopsNamed={stopsNamed}
        onRefused={(problem) => {
          if (problem.rule === 'request_not_confirmed' && problem.stops !== undefined) {
            setFlagged(new Set(problem.stops));
          }
        }}
      />
    </>
  );
}

/**
 * One pickup run (surfaces/ops-portal.md section 7, `/manifests/{id}`; S1.25; redesign step R7a): the record page template. Its header says where the run stands (the tracker is the
 * contract's one forward path: draft, dispatched, in progress, completed; cancelled is the end it is) and what comes next, with the one primary act, the other beside it and the
 * cancellation in the menu; the work is the facts, the stops in their order and, while the run is in progress, the custody of the parcels; the history and the way to its messages are in the
 * side column. **Assigning a rider and dispatching are separate acts**, never one button; the order of the stops, the cancellation, the Ops skip of a stop and the custody handover are
 * each their own, with their own confirmation. Every act sends the version the page read (`If-Match`), so a concurrent edit is a `STATE_CONFLICT` that is explained and read again, never
 * a silent overwrite. What is offered is a hint and decides nothing: the server checks the key, the hub and the state. A pickup run outside the session's hubs and one that does not exist
 * are pages of their own (`HUB_SCOPE_VIOLATION`, `NOT_FOUND`).
 */
export function ManifestDetailPage() {
  const { id = '' } = useParams();
  return (
    <WithManifest
      id={id}
      ownsHeading
      heading={(record) => ({
        title: record?.manifest.code ?? 'Pickup run',
        description: 'Pickup run',
        documentTitle: record?.manifest.code ?? 'Pickup run',
      })}
    >
      {(record, query) => <Manifest record={record} query={query} />}
    </WithManifest>
  );
}
