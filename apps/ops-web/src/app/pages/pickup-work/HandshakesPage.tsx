import { useState } from 'react';

import { Button } from '../../../components/ui/button/Button';
import { CardFacts } from '../../../components/ui/card-facts/CardFacts';
import { OperationalCode } from '../../../components/ui/code/OperationalCode';
import { CellLines, RowTitle, type DataColumn } from '../../../components/ui/data-table/DataTable';
import { DescriptionList } from '../../../components/ui/description-list/DescriptionList';
import { Link } from '../../../components/ui/link/Link';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { useApiClient } from '../../../platform/api/api-client';
import {
  authoriseHandshakeOverride,
  resolveHandshake,
} from '../../../platform/pickup-work/pickup-work-commands';
import type {
  HandshakeView,
  OpsHandshakeView,
} from '../../../platform/pickup-work/pickup-work-shape';
import { useHandshakesForOps } from '../../../platform/pickup-work/use-pickup-work-queries';
import { refusalText } from '../../../platform/problem/capability-words';
import type { Problem } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { STOP_STATUS_MAP } from '../manifests/manifest-presentation';
import { NoteActDialog } from '../pickup/PickupActDialogs';
import { hubNameOf } from '../staff/staff-presentation';
import {
  CHANNEL_WORDS,
  HANDSHAKE_STATE_MAP,
  ROUTED_WORDS,
  counterText,
  countOfText,
  isSettledByOps,
  settledText,
} from './pickup-work-presentation';
import { WorkList, type PanelTools, type WorkView } from './WorkList';
import './pickup-work-pages.css';

const VIEWS: readonly [WorkView, ...WorkView[]] = [
  {
    id: 'needs-ops',
    label: 'Needs Ops',
    open: true,
    none: 'Nothing needs Ops. A handshake appears here when its code runs out, its attempts are used up, or the text-message fallback has sent all it may.',
  },
  {
    id: 'settled',
    label: 'Settled by Ops',
    open: false,
    none: 'A handshake that an officer overrode or resolved by hand appears here.',
  },
  {
    id: 'all',
    label: 'All',
    open: undefined,
    none: 'A handshake appears here when a code is made for a pickup at your hubs.',
  },
];

/**
 * The two acts of the office on a handshake take no version (`authoriseHandshakeOverride` and `resolveHandshake` declare none), and the note dialog holds a version beside its command; here it is
 * empty, and the acts send none.
 */
const UNVERSIONED = '';

const refusalWords = (problem: Problem): string =>
  refusalText(problem.forbidden, 'pickup.handshake.override', { of: 'handshakes' });

type Hubs = readonly { readonly id: string; readonly display_name: string }[];

/** What a row says of why the office is asked: the policy's reason, or how Ops settled it. */
function whyOf(handshake: OpsHandshakeView, principalId: string | undefined): string {
  const settled = settledText(handshake, principalId);
  if (settled !== undefined) return settled;
  return handshake.routed_because === null
    ? 'It is not routed to Ops.'
    : ROUTED_WORDS[handshake.routed_because];
}

function HandshakeCard({
  handshake,
  hubs,
  principalId,
}: {
  readonly handshake: OpsHandshakeView;
  readonly hubs: Hubs;
  readonly principalId: string | undefined;
}) {
  return (
    <CardFacts
      head={<StatusBadge status={handshake.state} map={HANDSHAKE_STATE_MAP} />}
      lead={handshake.sender_name}
      facts={[
        { label: 'Why', value: whyOf(handshake, principalId) },
        {
          label: 'Attempts',
          value: countOfText(handshake.attempts, handshake.attempt_limit),
        },
        {
          label: 'Text messages sent',
          value: countOfText(handshake.fallback_sends, handshake.fallback_limit),
        },
        {
          label: 'Stop',
          value: <StatusBadge status={handshake.stop_state} map={STOP_STATUS_MAP} />,
        },
        { label: 'Hub', value: hubNameOf(handshake.responsible_hub_id, hubs) },
      ]}
    />
  );
}

/** The handshake as the panel tells it: no code, no digest and not the note of an override, which the page is never given. */
function Facts({
  handshake,
  principalId,
}: {
  readonly handshake: OpsHandshakeView;
  readonly principalId: string | undefined;
}) {
  const settled = settledText(handshake, principalId);
  return (
    <DescriptionList
      heading="The handshake"
      headingLevel={3}
      items={[
        { label: 'Sender', value: handshake.sender_name },
        {
          label: 'State',
          value: <StatusBadge status={handshake.state} map={HANDSHAKE_STATE_MAP} />,
        },
        { label: 'Why it needs Ops', value: whyOf(handshake, principalId) },
        {
          label: 'Attempts',
          value: countOfText(handshake.attempts, handshake.attempt_limit),
        },
        {
          label: 'Text messages sent',
          value: countOfText(handshake.fallback_sends, handshake.fallback_limit),
        },
        ...(handshake.expires_at === null
          ? []
          : [{ label: 'Code ran out', value: formatInstant(handshake.expires_at) }]),
        {
          label: 'The stop',
          value: (
            <>
              <StatusBadge status={handshake.stop_state} map={STOP_STATUS_MAP} />{' '}
              <Link
                to={`/manifests/${handshake.pickup_manifest_id}/stops/${handshake.pickup_stop_id}`}
              >
                Open the stop
              </Link>
            </>
          ),
        },
        ...(settled === undefined
          ? []
          : [
              { label: 'Settled', value: settled },
              ...(handshake.channel === null
                ? []
                : [{ label: 'How', value: CHANNEL_WORDS[handshake.channel] }]),
            ]),
      ]}
    />
  );
}

type Act = 'override' | 'resolve';

/** The two acts of the office on a handshake, over a stop that is still at the door: each under its own key, each with a note that says why, and neither with a code or a figure. */
function Acts({
  handshake,
  tools,
}: {
  readonly handshake: OpsHandshakeView;
  readonly tools: PanelTools;
}) {
  const client = useApiClient();
  const me = useSignedInSession();
  const [open, setOpen] = useState<Act | undefined>(undefined);
  if (me === undefined) return null;
  const code = handshake.request_code;

  if (isSettledByOps(handshake)) return null;
  if (handshake.stop_state !== 'ARRIVED') {
    return (
      <p className="work-panel__support">
        The stop is no longer at the door, so there is nothing left to settle here.
      </p>
    );
  }
  const mayOverride = me.holds('pickup.handshake.override');
  const mayResolve = me.holds('pickup.handshake.resolve');
  // An expired or exhausted handshake is the one that is resolved by hand; a code that is still live is refused by the server, which says so.
  const resolvable = handshake.state === 'EXPIRED' || handshake.state === 'EXHAUSTED';

  const close = (): void => {
    setOpen(undefined);
  };
  const reload = (): Promise<unknown> => {
    close();
    return tools.reload();
  };

  return (
    <section className="work-panel__section work-panel__section--acts" aria-label="Acts">
      <h3 className="work-panel__heading">What to do</h3>
      <div className="work-panel__acts">
        {mayOverride ? (
          <Button
            type="button"
            onClick={() => {
              setOpen('override');
            }}
          >
            Override
          </Button>
        ) : null}
        {mayResolve && resolvable ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setOpen('resolve');
            }}
          >
            Resolve by hand
          </Button>
        ) : null}
      </div>
      {mayResolve ? null : (
        <p className="work-panel__support">
          A senior officer decides whether it is resolved by hand.
        </p>
      )}

      <NoteActDialog<HandshakeView>
        open={open === 'override'}
        title="Override this handshake?"
        consequence={
          <p>
            Ops establishes the collection from the count the rider recorded, as an exception, and
            the vendor is not asked for a code. It is recorded with your note and the stop closes as
            the count says. It is not taken back.
          </p>
        }
        confirmLabel="Override the handshake"
        noteLabel="How you verified the vendor"
        noteHelp="One line: how Ops verified the vendor by other means. Leave out phone numbers and codes."
        operation="authoriseHandshakeOverride"
        notePointer="/verification_note"
        version={UNVERSIONED}
        retryable
        send={(note, _version, key) =>
          authoriseHandshakeOverride(client, handshake.pickup_stop_id, note, key)
        }
        onDone={() => {
          close();
          tools.acted(
            <p>{`The handshake of ${code} is overridden: Ops established the collection as an exception.`}</p>,
          );
        }}
        onCancel={close}
        onReload={reload}
      />
      <NoteActDialog<HandshakeView>
        open={open === 'resolve'}
        title="Resolve this handshake by hand?"
        consequence={
          <p>
            The handshake is settled without the vendor’s code, and the stop closes as the count the
            rider recorded says. It is recorded with your note and is not taken back.
          </p>
        }
        confirmLabel="Resolve the handshake"
        noteLabel="How the collection was established"
        noteHelp="One line: what was checked, and with whom. Leave out phone numbers and codes."
        operation="resolveHandshake"
        notePointer="/note"
        version={UNVERSIONED}
        retryable
        send={(note, _version, key) =>
          resolveHandshake(client, handshake.pickup_stop_id, note, key)
        }
        onDone={() => {
          close();
          tools.acted(
            <p>{`The handshake of ${code} is resolved by hand: the stop is closed as the count says.`}</p>,
          );
        }}
        onCancel={close}
        onReload={reload}
      />
    </section>
  );
}

/**
 * Handshakes that need Ops (surfaces/ops-portal.md section 7, `/handshakes`; S1.30), in the Today group beside Decisions: what waits on a decision the session may give. From `listHandshakesForOps`,
 * oldest first, in three views (*Needs Ops*, the ones Ops settled, *All*). A row says **why it needs Ops** (`routed_because`: the code ran out, the attempts are used up, or the text-message
 * fallback has sent all it may), the counters **beside the limits the platform holds** (a limit it has no usable value for is said to be unknown and never filled in with a default) and, for one Ops
 * settled, that an officer did and when. **No code and no digest is ever on the page, and neither is the note of an override.** Two acts: *Override* (the collection is established from the count, as
 * an exception) and *Resolve by hand* (for an expired or exhausted handshake, a holder of its own key), each with a mandatory note; a refusal is told in plain words and the list is read again.
 */
export function HandshakesPage() {
  const me = useSignedInSession();
  if (me === undefined) return null;
  const hubs = me.session.authorized_hubs;
  const principalId = me.session.principal_id;

  const columns: readonly DataColumn<OpsHandshakeView>[] = [
    {
      id: 'pickup',
      header: 'Pickup / sender',
      rowHeader: true,
      cell: (handshake) => <RowTitle code={handshake.request_code} name={handshake.sender_name} />,
    },
    {
      id: 'state',
      header: 'Handshake',
      kind: 'prose',
      cell: (handshake) => (
        <CellLines
          first={<StatusBadge status={handshake.state} map={HANDSHAKE_STATE_MAP} />}
          second={whyOf(handshake, principalId)}
        />
      ),
    },
    {
      id: 'counters',
      header: 'Attempts',
      kind: 'prose',
      priority: 2,
      cell: (handshake) => (
        <CellLines
          first={counterText(handshake.attempts, handshake.attempt_limit, 'Attempts')}
          second={counterText(handshake.fallback_sends, handshake.fallback_limit, 'Text messages')}
        />
      ),
    },
    {
      id: 'stop',
      header: 'Stop',
      kind: 'badge',
      priority: 3,
      cell: (handshake) => <StatusBadge status={handshake.stop_state} map={STOP_STATUS_MAP} />,
    },
    {
      id: 'hub',
      header: 'Hub',
      priority: 3,
      cell: (handshake) => hubNameOf(handshake.responsible_hub_id, hubs),
    },
  ];

  return (
    <WorkList<OpsHandshakeView>
      name="handshakes"
      operation="listHandshakesForOps"
      title="Handshakes that need Ops"
      description="Collections where the vendor’s code could not settle the handshake, oldest first, for the office to override or resolve."
      viewsLabel="Views of the handshakes"
      views={VIEWS}
      noun={{ plural: 'handshakes', one: 'handshake', other: 'handshakes' }}
      tableLabel="Handshakes that need Ops"
      refusal={refusalWords}
      useList={useHandshakesForOps}
      rowId={(handshake) => handshake.id}
      table={{
        columns,
        density: 'two-line',
        openLabel: (handshake) => `Open ${handshake.request_code}, ${handshake.sender_name}`,
        card: (handshake) => (
          <HandshakeCard handshake={handshake} hubs={hubs} principalId={principalId} />
        ),
        cardTitle: (handshake) => <OperationalCode>{handshake.request_code}</OperationalCode>,
      }}
      panel={(handshake, tools) => ({
        code: handshake.request_code,
        status: <StatusBadge status={handshake.state} map={HANDSHAKE_STATE_MAP} />,
        fullPage: { to: `/pickup-requests/${handshake.pickup_request_id}` },
        body: (
          <div className="work-panel">
            <Facts handshake={handshake} principalId={principalId} />
            <Acts key={handshake.id} handshake={handshake} tools={tools} />
          </div>
        ),
      })}
    />
  );
}
