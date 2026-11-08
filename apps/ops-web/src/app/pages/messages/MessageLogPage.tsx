import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';

import { PageHeader } from '../../../components/PageHeader';
import { Button } from '../../../components/ui/button/Button';
import { EmptyState } from '../../../components/ui/empty-state/EmptyState';
import { Field } from '../../../components/ui/field/Field';
import { Link } from '../../../components/ui/link/Link';
import { QueueFilters, QueueTable } from '../../../components/ui/queue-table/QueueTable';
import { useQueuePaging } from '../../../components/ui/queue-table/use-queue-paging';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Select } from '../../../components/ui/select/Select';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import type { TableColumn } from '../../../components/ui/table/Table';
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
  type NotificationPageView,
  type NotificationState,
  type SubjectType,
} from '../../../platform/notifications/notification-shape';
import { useNotifications } from '../../../platform/notifications/use-notification-queries';
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

/** The two views of the "Show" choice: every message, or the Ops feed, which is the same list with its channel and its audience. */
const SHOW_EVERY = '';
const SHOW_OPS_FEED = 'ops-feed';

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

const columns: TableColumn<NotificationEntryView>[] = [
  {
    key: 'when',
    header: 'When',
    rowHeader: true,
    cell: (row) => <span className="messages-nowrap">{formatInstant(row.created_at)}</span>,
  },
  {
    key: 'message',
    header: 'Message',
    cell: (row) => (
      <span className="messages-lines">
        <span>{messageKindLabel(row.message_kind)}</span>
        <span className="messages-support">{wordingVersionText(row.template_version)}</span>
      </span>
    ),
  },
  {
    key: 'for',
    header: 'For',
    cell: (row) => <span className="messages-words">{AUDIENCE_LABELS[row.audience]}</span>,
  },
  {
    key: 'channel',
    header: 'Channel',
    cell: (row) => <span className="messages-words">{CHANNEL_LABELS[row.channel]}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => <StatusBadge status={row.state} map={stateMapFor(row.channel)} />,
  },
  { key: 'what', header: 'What happened', cell: (row) => <WhatHappened entry={row} /> },
  {
    key: 'number',
    header: 'Number',
    cell: (row) =>
      row.destination_hint === undefined ? (
        <Dash means={NO_NUMBER} />
      ) : (
        <span className="messages-nowrap">{row.destination_hint}</span>
      ),
  },
  { key: 'tries', header: 'Tries', numeric: true, cell: (row) => String(row.attempt_count) },
  {
    key: 'record',
    header: 'Record',
    // The page of the record a message is about, by the kind of record it is; an identifier is an address and never text.
    cell: (row) => (
      <span className="messages-words">
        <Link to={SUBJECT_PATHS[row.subject.type](row.subject.id)}>
          {SUBJECT_LABELS[row.subject.type]}
        </Link>
      </span>
    ),
  },
];

/**
 * The message log (surfaces/ops-portal.md section 7, `/messages`; S1.12e): every message the platform raised about an act, newest first, and what
 * became of it, filtered by status, audience and channel, and narrowed to one pickup request from that request's page, or to one pickup run from a
 * row of the log (what it says of the record, "one request" or "this pickup run", follows the kind of record named in the address, in
 * `message-presentation.ts`, and never the messages that come back, so it is the same in every state). The Ops feed is the same
 * list with `channel=FEED` and `audience=OPS_FEED`. **Empty tells "no messages" from "filtered to nothing"**, and the Ops feed with nothing in it
 * says so. Which messages the session may see is the server's decision (the hubs of its grant); the choices are in the address, and the page of
 * results is not.
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
  const paging = useQueuePaging(
    `${state ?? ''}|${audience ?? ''}|${channel ?? ''}|${subject ?? ''}`,
  );
  const list = useNotifications({
    ...(state === undefined ? {} : { state }),
    ...(audience === undefined ? {} : { audience }),
    ...(channel === undefined ? {} : { channel }),
    ...(subject === undefined ? {} : { subjectId: subject }),
    ...(paging.pageToken === undefined ? {} : { pageToken: paging.pageToken }),
    enabled: me !== undefined,
  });
  const [interacted, setInteracted] = useState(false);

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

  let empty: ReactNode;
  if (emptyOpsFeed) {
    empty = (
      <EmptyState
        kind="filtered"
        heading="Nothing in the Ops feed yet"
        announce={interacted}
        action={showEveryMessage}
      >
        Messages the platform writes for Ops itself appear here.
      </EmptyState>
    );
  } else if (filtering) {
    empty = (
      <EmptyState
        kind="filtered"
        heading="No messages match"
        announce={interacted}
        action={showEveryMessage}
      >
        Nothing fits these choices. Show every message to start again.
      </EmptyState>
    );
  } else {
    empty = (
      <EmptyState kind="none" heading="No messages yet" announce={interacted}>
        Messages appear here when the platform tells someone about an act, for example a confirmed
        pickup request.
      </EmptyState>
    );
  }

  return (
    <>
      <title>Messages · Melarc Ops Portal</title>
      <PageHeader
        title="Messages"
        description="The messages the platform sent or kept for people about an act, newest first, and what became of each. It shows what became of a message, not what it said."
      />
      {subjectType === undefined ? null : (
        <div className="messages-subject">
          <p className="messages-subject__text">{SUBJECT_HEADINGS[subjectType]}</p>
          {showEveryMessage}
        </div>
      )}
      <QueueFilters label="Filter the messages">
        <Field label="Show">
          <Select
            value={opsFeed ? SHOW_OPS_FEED : SHOW_EVERY}
            onChange={(event) => {
              // The Ops feed is its channel and its audience, and a status chosen before is not carried into it; the way back takes
              // those two off and leaves the rest.
              narrowTo(
                event.target.value === SHOW_OPS_FEED
                  ? { subject, subjectType, channel: 'FEED', audience: 'OPS_FEED' }
                  : { state, subject, subjectType },
              );
            }}
          >
            <option value={SHOW_EVERY}>Every message</option>
            <option value={SHOW_OPS_FEED}>The Ops feed</option>
          </Select>
        </Field>
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
      </QueueFilters>

      <ReadState<NotificationPageView>
        query={list}
        isEmpty={(data) => data.items.length === 0}
        empty={empty}
        loadingLabel="Loading the messages…"
        skeleton={<Skeleton lines={5} />}
        permission="notification.read"
        operation="listNotifications"
      >
        {(data) => (
          <QueueTable
            caption="Messages"
            columns={columns}
            rows={data.items}
            rowKey={(row) => row.id}
            noun={{ one: 'message', other: 'messages' }}
            paging={paging}
            nextPageToken={data.nextPageToken}
          />
        )}
      </ReadState>
    </>
  );
}
