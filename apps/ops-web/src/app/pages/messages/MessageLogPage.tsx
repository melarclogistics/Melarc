import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';

import { Button } from '../../../components/ui/button/Button';
import { NoWrap, type DataColumn } from '../../../components/ui/data-table/DataTable';
import { EmptyStateV2 } from '../../../components/ui/empty-state/EmptyStateV2';
import { Field } from '../../../components/ui/field/Field';
import { Link } from '../../../components/ui/link/Link';
import { useQueuePaging } from '../../../components/ui/queue-table/use-queue-paging';
import { Select } from '../../../components/ui/select/Select';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { QueuePager } from '../../../components/ui/templates/QueuePager';
import {
  QueueWorkspace,
  type QueueEmptiness,
  type QueueResult,
  type QueueWorkspaceHandle,
} from '../../../components/ui/templates/QueueWorkspace';
import { useActiveHub, useHubScope } from '../../../platform/hub/active-hub';
import {
  audienceOf,
  channelOf,
  NOTIFICATION_AUDIENCES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATES,
  notificationStateOf,
  subjectIdOf,
  subjectTypeOf,
  type NotificationAudience,
  type NotificationChannel,
  type NotificationEntryView,
  type NotificationState,
  type SubjectType,
} from '../../../platform/notifications/notification-shape';
import { useNotifications } from '../../../platform/notifications/use-notification-queries';
import { cannotText } from '../../../platform/problem/capability-words';
import { problemOf, type Problem } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import {
  AUDIENCE_LABELS,
  CHANNEL_LABELS,
  messageKindLabel,
  NO_NUMBER,
  NOTHING_TO_REPORT,
  NOTIFICATION_STATE_MAP,
  providerWordText,
  stateMapFor,
  SUBJECT_HEADINGS,
  SUBJECT_LABELS,
  SUBJECT_PATHS,
  whatHappenedText,
  wordingVersionText,
} from './message-presentation';
import '../pickup/pickup-pages.css';
import './messages-page.css';

/** What the log is narrowed to. Every part is in the address, so that a view can be linked. */
interface Narrowing {
  readonly state?: NotificationState;
  readonly audience?: NotificationAudience;
  readonly channel?: NotificationChannel;
  /** The identifier of the record (a pickup request or a pickup run) the messages are about. */
  readonly subject?: string;
  /** What kind of record it is: in the address beside the identifier, and only for the words the page says of it. */
  readonly subjectType?: SubjectType;
}

/** The two views of the log: every message, or the Ops feed, which is the same list with its channel and its audience. */
const VIEW_EVERY = 'every';
const VIEW_OPS_FEED = 'ops-feed';

/**
 * A dash for the eye, and for assistive technology what it stands for. The words are placed against their own dash (`position: relative`), so
 * that the table, which scrolls sideways inside its region, takes them with it: hidden text positioned against the page would sit where the cell
 * is, off to the right, and make the page itself scroll sideways to reach it.
 */
function Dash({ means }: { readonly means: string }) {
  return (
    <span className="messages-dash">
      <span aria-hidden="true">—</span>
      <span className="messages-hidden">{means}</span>
    </span>
  );
}

/** What became of a message: why it was held back, or how it ended, and the provider's own word beneath it. */
function WhatHappened({ entry }: { readonly entry: NotificationEntryView }) {
  const words = whatHappenedText(entry);
  return (
    <span className="messages-lines">
      <span>{words ?? <Dash means={NOTHING_TO_REPORT} />}</span>
      {entry.provider_outcome_class === undefined ? null : (
        <span className="messages-support">{providerWordText(entry.provider_outcome_class)}</span>
      )}
    </span>
  );
}

/** The masked hint the server sent, and a dash with its meaning where there is none: the only number the page draws. */
function NumberHint({ entry }: { readonly entry: NotificationEntryView }) {
  return entry.destination_hint === undefined ? (
    <Dash means={NO_NUMBER} />
  ) : (
    <NoWrap>{entry.destination_hint}</NoWrap>
  );
}

/** The page of the record a message is about, by the kind of record it is; an identifier is an address and never text. */
function RecordLink({ entry }: { readonly entry: NotificationEntryView }) {
  return (
    <span className="messages-words">
      <Link to={SUBJECT_PATHS[entry.subject.type](entry.subject.id)}>
        {SUBJECT_LABELS[entry.subject.type]}
      </Link>
    </span>
  );
}

/** A message over the version of its wording, in a cell or in a card. */
function WhichMessage({ entry }: { readonly entry: NotificationEntryView }) {
  return (
    <span className="messages-lines">
      <span>{messageKindLabel(entry.message_kind)}</span>
      <span className="messages-support">{wordingVersionText(entry.template_version)}</span>
    </span>
  );
}

/**
 * The nine facts of a message, each a column: the log is a record to read across, so no column is lesser (the table scrolls sideways inside its region where the room is short, as
 * it always did) and under 40rem each message is a card with the same facts.
 */
const COLUMNS: readonly DataColumn<NotificationEntryView>[] = [
  {
    id: 'when',
    header: 'When',
    rowHeader: true,
    cell: (row) => <NoWrap>{formatInstant(row.created_at)}</NoWrap>,
  },
  { id: 'message', header: 'Message', cell: (row) => <WhichMessage entry={row} /> },
  {
    id: 'for',
    header: 'For',
    cell: (row) => <span className="messages-words">{AUDIENCE_LABELS[row.audience]}</span>,
  },
  {
    id: 'channel',
    header: 'Channel',
    cell: (row) => <span className="messages-words">{CHANNEL_LABELS[row.channel]}</span>,
  },
  {
    id: 'status',
    header: 'Status',
    cell: (row) => <StatusBadge status={row.state} map={stateMapFor(row.channel)} />,
  },
  { id: 'what', header: 'What happened', cell: (row) => <WhatHappened entry={row} /> },
  { id: 'number', header: 'Number', cell: (row) => <NumberHint entry={row} /> },
  {
    id: 'tries',
    header: 'Tries',
    align: 'end',
    cell: (row) => String(row.attempt_count),
  },
  { id: 'record', header: 'Record', cell: (row) => <RecordLink entry={row} /> },
];

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="pickup-card__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * A message as a card, for a room too narrow for the columns: its kind is the card's heading (outside the card), then the status, and every fact of the row under the name of its
 * column. The number is the masked hint the server sent, or a dash with its meaning, as in the row, and the record is its link, as in the row.
 */
function MessageCard({ entry }: { readonly entry: NotificationEntryView }) {
  return (
    <>
      <div className="pickup-card__head">
        <StatusBadge status={entry.state} map={stateMapFor(entry.channel)} />
      </div>
      <dl className="pickup-card__facts">
        <Fact label="When">
          <NoWrap>{formatInstant(entry.created_at)}</NoWrap>
        </Fact>
        <Fact label="Message">
          <WhichMessage entry={entry} />
        </Fact>
        <Fact label="For">
          <span className="messages-words">{AUDIENCE_LABELS[entry.audience]}</span>
        </Fact>
        <Fact label="Channel">
          <span className="messages-words">{CHANNEL_LABELS[entry.channel]}</span>
        </Fact>
        <Fact label="What happened">
          <WhatHappened entry={entry} />
        </Fact>
        <Fact label="Number">
          <NumberHint entry={entry} />
        </Fact>
        <Fact label="Tries">{String(entry.attempt_count)}</Fact>
        <Fact label="Record">
          <RecordLink entry={entry} />
        </Fact>
      </dl>
    </>
  );
}

/** A refusal in the words of the screen, never a permission key or a role (PRODUCT_DESIGN_DIRECTION section 6.5): what the account cannot do, or, for a hub it does not work in, that. */
function refusalWords(problem: Problem): string {
  return problem.forbidden === 'outside-hubs'
    ? 'These messages are at a hub your account does not work in.'
    : cannotText('notification.read');
}

/**
 * The message log (surfaces/ops-portal.md section 7, `/messages`; S1.12e; redesign step R7a): every message the platform raised about an act, newest first, and what
 * became of it, drawn by the queue workspace template. The views are every message and the Ops feed; the filter row holds the status, the audience and the channel, each a chip once chosen;
 * the log is narrowed to one pickup request from that request's page, or to one pickup run from a row of the log (what it says of the record, "one request" or "this pickup run", follows
 * the kind of record named in the address, in `message-presentation.ts`, and never the messages that come back, so it is the same in every state). The Ops feed is the same
 * list with `channel=FEED` and `audience=OPS_FEED`. **Empty tells "no messages" from "filtered to nothing"**, and the Ops feed with nothing in it
 * says so. Which messages the session may see is the server's decision (the hubs of its grant), narrowed to the hub the switcher chose since task
 * C3 (not when the log is asked for one record, which is that record's whatever hub is chosen: the exception of `AC-HUBF-09`, decided by the
 * Product Owner on 7 November 2026); the choices are in the address, and the page of results is not.
 *
 * **It never shows, asks for, copies or builds a number in clear, a message's text or a code.** An entry has none (the contract), the guard has
 * no place for one, and the only number on the screen is the masked hint the server sent. A message is named by what it is about and never by
 * its identifier.
 */
export function MessageLogPage() {
  const me = useSignedInSession();
  const [params, setParams] = useSearchParams();
  const state = notificationStateOf(params.get('state'));
  const audience = audienceOf(params.get('audience'));
  const channel = channelOf(params.get('channel'));
  const subject = subjectIdOf(params.get('subject'));
  // What the record is, from the address alone and never from what the server answers, so that the log says it in every state it can be in
  // (loading, empty, failed, loaded). An address with a record and no kind, or a kind that is not one, is a request's, as it always was.
  const subjectType: SubjectType | undefined =
    subject === undefined
      ? undefined
      : (subjectTypeOf(params.get('subject_type')) ?? 'PICKUP_REQUEST');
  // The hub the switcher chose narrows the log (task C3), except when the log is asked for one record (the links "Messages about this request" and
  // "Messages about this run"): a record's messages are that record's, and the switcher, left on another hub, must not hide them. It is then
  // no filter of the log, so it is part of neither the request nor the signature.
  const switcherHub = useActiveHub();
  const hubId = subject === undefined ? switcherHub : undefined;
  const { hub, showAllHubs } = useHubScope();
  const paging = useQueuePaging(
    `${state ?? ''}|${audience ?? ''}|${channel ?? ''}|${subject ?? ''}|${hubId ?? ''}`,
  );
  const list = useNotifications({
    ...(state === undefined ? {} : { state }),
    ...(audience === undefined ? {} : { audience }),
    ...(channel === undefined ? {} : { channel }),
    ...(subject === undefined ? {} : { subjectId: subject }),
    ...(hubId === undefined ? {} : { hubId }),
    ...(paging.pageToken === undefined ? {} : { pageToken: paging.pageToken }),
    enabled: me !== undefined,
  });
  const [interacted, setInteracted] = useState(false);
  const workspace = useRef<QueueWorkspaceHandle>(null);

  // A move to another page leaves the pager button it was made from gone (while the next page loads), and focus would fall to the top of the document: once the page has been
  // read, whatever it holds (rows, nothing, a failure), focus goes to the results, once.
  const settled = !list.isFetching && (list.isSuccess || list.isError);
  const { takeFocus } = paging;
  useEffect(() => {
    if (!settled || !takeFocus()) return;
    workspace.current?.focusResults();
  }, [settled, list.dataUpdatedAt, takeFocus]);

  if (me === undefined) return null;

  const current: Narrowing = { state, audience, channel, subject, subjectType };

  /** Narrows the log to exactly this: what it leaves out is no filter. */
  function narrowTo(next: Narrowing): void {
    setInteracted(true);
    const out = new URLSearchParams();
    if (next.state !== undefined) out.set('state', next.state);
    if (next.audience !== undefined) out.set('audience', next.audience);
    if (next.channel !== undefined) out.set('channel', next.channel);
    if (next.subject !== undefined) {
      out.set('subject', next.subject);
      if (next.subjectType !== undefined) out.set('subject_type', next.subjectType);
    }
    setParams(out, { replace: true });
  }

  const showEveryMessage = (
    <Button
      type="button"
      variant="secondary"
      onClick={() => {
        narrowTo({});
      }}
    >
      Show every message
    </Button>
  );

  const opsFeed = channel === 'FEED' && audience === 'OPS_FEED';
  const filtering =
    state !== undefined || audience !== undefined || channel !== undefined || subject !== undefined;
  // The Ops feed with nothing narrowing it further is a view of its own, and its emptiness is told as that. It is told in the neutral tone of a
  // view that shows nothing and not in the success tone of a queue worked to empty: no operation built so far writes to the feed, which is not
  // good news, and the way out (every message) is what a person who came for a message needs.
  const emptyOpsFeed = opsFeed && state === undefined && subject === undefined;
  // A chosen hub is a filter of the log too (audit B1), unless the log is asked for one record (`AC-HUBF-09`): then it is the record's, whatever hub is chosen.
  const hubFilters = hub !== undefined && subject === undefined;

  const result: QueueResult<NotificationEntryView> = (() => {
    if (list.status === 'pending') return { status: 'loading' };
    if (list.status === 'error') {
      const problem = problemOf(list.error, { operation: 'listNotifications' });
      // A session that has ended or an answer that is stale is the session boundary's, which has already taken the person away.
      if (problem.kind === 'session-ended' || problem.kind === 'stale') {
        return { status: 'loading' };
      }
      const retryable = problem.kind === 'unavailable' || problem.kind === 'rate-limited';
      return {
        status: 'error',
        message:
          problem.kind === 'forbidden'
            ? refusalWords(problem)
            : problem.reference === undefined
              ? problem.message
              : `${problem.message} Reference: ${problem.reference}`,
        ...(retryable
          ? {
              onRetry: () => {
                void list.refetch();
              },
            }
          : {}),
      };
    }
    return { status: 'ready', rows: list.data.items };
  })();

  const emptiness = {
    noun: 'messages',
    none: 'Messages appear here when the platform tells someone about an act, for example a confirmed pickup request.',
    announce: interacted,
    ...(hub !== undefined && subject === undefined
      ? { hub: { name: hub.display_name, onShowAllHubs: showAllHubs } }
      : {}),
  };
  const empty: QueueEmptiness = filtering
    ? {
        ...emptiness,
        filtered: true,
        onClearFilters: () => {
          narrowTo({});
        },
        clearLabel: 'Show every message',
        filteredText: 'Nothing fits these choices. Show every message to start again.',
      }
    : emptiness;

  const chips = [
    ...(state === undefined
      ? []
      : [{ id: 'state', label: `Status: ${NOTIFICATION_STATE_MAP[state].label}` }]),
    // The Ops feed is its audience and its channel, and the view says so: they are chips of their own only outside it.
    ...(audience === undefined || opsFeed
      ? []
      : [{ id: 'audience', label: `For: ${AUDIENCE_LABELS[audience]}` }]),
    ...(channel === undefined || opsFeed
      ? []
      : [{ id: 'channel', label: `Channel: ${CHANNEL_LABELS[channel]}` }]),
  ];

  return (
    <>
      <title>Messages · Melarc Ops Portal</title>
      <QueueWorkspace<NotificationEntryView>
        ref={workspace}
        header={{
          title: 'Messages',
          description:
            'The messages the platform sent or kept for people about an act, newest first, and what became of each. It shows what became of a message, not what it said.',
        }}
        views={{
          label: 'Views of the messages',
          value: opsFeed ? VIEW_OPS_FEED : VIEW_EVERY,
          onValueChange: (id) => {
            // The Ops feed is its channel and its audience, and a status chosen before is not carried into it; the way back takes
            // those two off and leaves the rest.
            narrowTo(
              id === VIEW_OPS_FEED
                ? { subject, subjectType, channel: 'FEED', audience: 'OPS_FEED' }
                : { state, subject, subjectType },
            );
          },
          tabs: [
            { id: VIEW_EVERY, label: 'Every message' },
            { id: VIEW_OPS_FEED, label: 'The Ops feed' },
          ],
        }}
        filters={{
          label: 'Filter the messages',
          chips,
          onRemove: (id) => {
            narrowTo({
              ...current,
              ...(id === 'state' ? { state: undefined } : {}),
              ...(id === 'audience' ? { audience: undefined } : {}),
              ...(id === 'channel' ? { channel: undefined } : {}),
            });
          },
          onClearAll: () => {
            narrowTo({ subject, subjectType });
          },
          sortLabel: 'Newest first, as the server lists them',
          filterPanel: (
            <>
              <Field label="Status">
                <Select
                  value={state ?? ''}
                  onChange={(event) => {
                    narrowTo({ ...current, state: notificationStateOf(event.target.value) });
                  }}
                >
                  <option value="">Every status</option>
                  {NOTIFICATION_STATES.map((key) => (
                    <option key={key} value={key}>
                      {NOTIFICATION_STATE_MAP[key].label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="For">
                <Select
                  value={audience ?? ''}
                  onChange={(event) => {
                    narrowTo({ ...current, audience: audienceOf(event.target.value) });
                  }}
                >
                  <option value="">Everyone</option>
                  {NOTIFICATION_AUDIENCES.map((key) => (
                    <option key={key} value={key}>
                      {AUDIENCE_LABELS[key]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Channel">
                <Select
                  value={channel ?? ''}
                  onChange={(event) => {
                    narrowTo({ ...current, channel: channelOf(event.target.value) });
                  }}
                >
                  <option value="">Every channel</option>
                  {NOTIFICATION_CHANNELS.map((key) => (
                    <option key={key} value={key}>
                      {CHANNEL_LABELS[key]}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          ),
        }}
        notice={
          subjectType === undefined ? undefined : (
            <div className="messages-subject">
              <p className="messages-subject__text">{SUBJECT_HEADINGS[subjectType]}</p>
              {showEveryMessage}
            </div>
          )
        }
        result={result}
        empty={empty}
        {...(emptyOpsFeed && !hubFilters
          ? {
              emptyState: (
                <EmptyStateV2
                  variant="filtered-empty"
                  title="Nothing in the Ops feed yet"
                  headingLevel={3}
                  announce={interacted}
                  action={showEveryMessage}
                >
                  Messages the platform writes for Ops itself appear here.
                </EmptyStateV2>
              ),
            }
          : {})}
        table={{
          label: 'Messages',
          columns: COLUMNS,
          rowId: (row) => row.id,
          density: 'two-line',
          card: (row) => <MessageCard entry={row} />,
          // The kind of message is the heading of each card, for heading navigation.
          cardTitle: (row) => messageKindLabel(row.message_kind),
          ...(result.status === 'ready' && list.isSuccess
            ? {
                footer: (
                  <QueuePager
                    label="Pages of messages"
                    noun={{ one: 'message', other: 'messages' }}
                    shown={list.data.items.length}
                    page={paging.page}
                    hasNext={list.data.nextPageToken !== null}
                    onNext={() => {
                      if (list.data.nextPageToken !== null) {
                        paging.toNextPage(list.data.nextPageToken);
                      }
                    }}
                    onPrevious={paging.toPreviousPage}
                  />
                ),
              }
            : {}),
        }}
      />
    </>
  );
}
