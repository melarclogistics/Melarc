import { useState } from 'react';

import { PICKUP_STATE_MAP, serviceDateText } from '../../app/pages/pickup/pickup-presentation';
import { ActionMenu, type ActionMenuItem } from '../../components/ui/action-menu/ActionMenu';
import { Button } from '../../components/ui/button/Button';
import { DescriptionList } from '../../components/ui/description-list/DescriptionList';
import { Panel } from '../../components/ui/panel/Panel';
import { RecordHeader } from '../../components/ui/record-header/RecordHeader';
import { SidePanel } from '../../components/ui/side-panel/SidePanel';
import { StatTile } from '../../components/ui/stat-tile/StatTile';
import { StatusBadge } from '../../components/ui/status-badge/StatusBadge';
import { showToast } from '../../components/ui/toast/Toast';
import { SAMPLE_SENDER_PHONE, sampleRequests, type SampleRequest } from './sample-data';
import { KitSection, Specimen } from './Section';

export const REQUEST_STAGES = [
  { id: 'received', label: 'Received' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'dispatched', label: 'Dispatched' },
  { id: 'collected', label: 'Collected' },
] as const;

/** The acts of the menu of a request, in the words of the portal. One act is not available, and says why; one is destructive, and is confirmed. */
export function requestMenuItems(code: string): readonly ActionMenuItem[] {
  return [
    { id: 'hub', label: 'Change the hub', icon: 'pickup-requests', onSelect: () => undefined },
    {
      id: 'escalate',
      label: 'Escalate',
      disabled: { reason: 'An approver decides this.' },
      onSelect: () => undefined,
    },
    {
      id: 'cancel',
      label: 'Cancel request',
      destructive: true,
      confirm: {
        title: `Cancel request ${code}?`,
        description: 'The vendor is told. A cancellation charge may apply.',
        confirmLabel: 'Cancel the request',
      },
      onSelect: () => undefined,
    },
  ];
}

/** The menu of the rarer acts of a request (see `requestMenuItems`). */
export function RequestMenu({ code }: { readonly code: string }) {
  return <ActionMenu label={`More actions for ${code}`} items={requestMenuItems(code)} />;
}

/**
 * What the panel holds for a sample request: its facts and, for a request that is waiting, **the record's primary action** (task R5.2, M16: the panel carries the act the row
 * carries, so a person who opened the record to decide can decide there). A request that is already confirmed has none.
 */
export function RequestPanelContent({
  request,
  loading = false,
}: {
  readonly request: SampleRequest;
  readonly loading?: boolean;
}) {
  return (
    <div className="showcase-kit-stack">
      <RequestFacts request={request} loading={loading} />
      {loading || request.state !== 'PENDING' ? null : (
        <Button
          type="button"
          onClick={() => {
            showToast({ tone: 'success', message: `${request.code} confirmed.` });
          }}
        >
          Confirm pickup
        </Button>
      )}
    </div>
  );
}

/** The facts of a sample request as a record shows them: a code, the state and the hub, and what the server did not state. */
export function RequestFacts({
  request,
  loading = false,
}: {
  readonly request: SampleRequest;
  readonly loading?: boolean;
}) {
  return (
    <DescriptionList
      loading={loading}
      items={[
        { label: 'Request', value: request.code, code: true },
        { label: 'State', value: <StatusBadge status={request.state} map={PICKUP_STATE_MAP} /> },
        { label: 'Sender', value: request.sender_name },
        { label: 'Service date', value: serviceDateText(request.scheduled_service_date) },
        { label: 'Hub', value: 'Accra Central' },
        { label: 'Packages', value: String(request.declared_package_count) },
        { label: 'Landmark' },
      ]}
    />
  );
}

function SidePanelSpecimen() {
  const rows = sampleRequests(4);
  const [opened, setOpened] = useState<SampleRequest | undefined>();
  const [content, setContent] = useState<'summary' | 'loading' | 'failed'>('summary');
  return (
    <KitSection
      title="SidePanel"
      note="A record beside its list, 360 to 420px wide. Focus moves into it when it opens and back to the row when it closes; Escape closes it. At 768px and below it is a full-screen sheet. Open a sample request, then press Escape."
    >
      <Specimen label="Beside a list of sample requests">
        <div className="showcase-kit-split">
          <div className="showcase-kit-stack">
            <div className="showcase-kit-row">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setContent('summary');
                }}
              >
                Show the summary
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setContent('loading');
                }}
              >
                Show it loading
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setContent('failed');
                }}
              >
                Show a failure
              </Button>
            </div>
            <ul className="showcase-kit-stack" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {rows.map((request) => (
                <li key={request.id}>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setOpened(request);
                    }}
                  >
                    {`Open ${request.code}`}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
          <SidePanel
            open={opened !== undefined}
            onClose={() => {
              setOpened(undefined);
            }}
            code={opened?.code ?? ''}
            status={
              opened === undefined ? undefined : (
                <StatusBadge status={opened.state} map={PICKUP_STATE_MAP} />
              )
            }
            fullPage={{ to: '/__showcase/kit/example-record' }}
          >
            {opened === undefined ? null : content === 'failed' ? (
              <p role="alert">This request could not be read. Try again.</p>
            ) : (
              <RequestPanelContent request={opened} loading={content === 'loading'} />
            )}
          </SidePanel>
        </div>
      </Specimen>
    </KitSection>
  );
}

function RecordHeaderSpecimens() {
  const request = sampleRequests(1)[0];
  if (request === undefined) return null;
  return (
    <KitSection
      title="RecordHeader and StageTracker"
      note="The record's code, its status, one plain-words sentence, where it stands on its way, one Ink action and a menu. The stage is the server's fact, passed as given."
    >
      <Specimen label="At the second stage, with a primary action, another action and the menu">
        <RecordHeader
          code={request.code}
          level={2}
          status={<StatusBadge status="CONFIRMED" map={PICKUP_STATE_MAP} />}
          sentence="The hub confirmed this pickup for Mon 9 Nov 2026. A rider is not assigned yet."
          stages={{
            label: 'Progress of the pickup request',
            stages: REQUEST_STAGES,
            currentId: 'confirmed',
          }}
          secondaryActions={
            <Button type="button" variant="secondary">
              Edit the note
            </Button>
          }
          primaryAction={<Button type="button">Assign a rider</Button>}
          menu={<RequestMenu code={request.code} />}
        />
      </Specimen>
      <Specimen label="First stage, the sentence says what stands in the way">
        <RecordHeader
          code="ACC-PR-4HT9WD"
          level={2}
          status={<StatusBadge status="PENDING" map={PICKUP_STATE_MAP} />}
          sentence="Booked after the hub's cut-off: it waits for an Ops decision before it can be confirmed."
          stages={{
            label: 'Progress of the pickup request',
            stages: REQUEST_STAGES,
            currentId: 'received',
          }}
          primaryAction={<Button type="button">Decide the late booking</Button>}
        />
      </Specimen>
      <Specimen label="Last stage">
        <RecordHeader
          code="ACC-PR-2MX8RC"
          level={2}
          status={<StatusBadge status="CONFIRMED" map={PICKUP_STATE_MAP} />}
          sentence="Collected from the sender on Fri 6 Nov 2026."
          stages={{
            label: 'Progress of the pickup request',
            stages: REQUEST_STAGES,
            currentId: 'collected',
          }}
        />
      </Specimen>
      <Specimen label="No tracker: a record that has no such way">
        <RecordHeader
          code="ACC-PR-3NP6VB"
          level={2}
          status={<StatusBadge status="CANCELLED" map={PICKUP_STATE_MAP} />}
          sentence="Cancelled by the vendor on Thu 5 Nov 2026. No charge was applied."
        />
      </Specimen>
      <Specimen label="In a narrow room: the stages stack, the actions wrap" width="22rem">
        <RecordHeader
          code={request.code}
          level={2}
          status={<StatusBadge status="CONFIRMED" map={PICKUP_STATE_MAP} />}
          sentence="The hub confirmed this pickup for Mon 9 Nov 2026."
          stages={{
            label: 'Progress of the pickup request',
            stages: REQUEST_STAGES,
            currentId: 'confirmed',
          }}
          primaryAction={<Button type="button">Assign a rider</Button>}
          menu={<RequestMenu code={request.code} />}
        />
      </Specimen>
    </KitSection>
  );
}

function DescriptionListSpecimens() {
  const request = sampleRequests(1)[0];
  if (request === undefined) return null;
  return (
    <KitSection
      title="DescriptionList"
      note="The facts of a record: a label column of 110px, muted labels, values that may be codes. A fact the server did not state says so in words."
    >
      <div className="showcase-kit-grid">
        <Specimen label="With a code, a badge and a fact not stated (sample data)">
          <RequestFacts request={request} />
        </Specimen>
        <Specimen label="Loading: the labels stay, no value is drawn">
          <RequestFacts request={request} loading />
        </Specimen>
        <Specimen label="Grouped, under a section label">
          <div className="showcase-kit-stack">
            <DescriptionList
              heading="Pickup"
              items={[
                { label: 'Service date', value: serviceDateText(request.scheduled_service_date) },
                { label: 'Hub', value: 'Accra Central' },
              ]}
            />
            <DescriptionList
              heading="Sender"
              items={[
                { label: 'Name', value: request.sender_name },
                { label: 'Phone', value: SAMPLE_SENDER_PHONE },
                { label: 'Landmark' },
              ]}
            />
          </div>
        </Specimen>
      </div>
    </KitSection>
  );
}

function PanelSpecimens() {
  return (
    <KitSection
      title="Panel and Card"
      note="The surfaces of the record and queue templates: 12px corners and the subtle border for a panel, 16px for the page's own card, no shadow."
    >
      <div className="showcase-kit-grid">
        <Specimen label="A panel with no header">
          <Panel>
            <p style={{ margin: 0 }}>The hub confirmed this pickup. A rider is not assigned yet.</p>
          </Panel>
        </Specimen>
        <Specimen label="A panel with a title and an action">
          <Panel
            title="Pickup"
            action={
              <Button type="button" variant="secondary">
                Edit
              </Button>
            }
          >
            <DescriptionList
              items={[
                { label: 'Service date', value: 'Mon 9 Nov 2026' },
                { label: 'Hub', value: 'Accra Central' },
              ]}
            />
          </Panel>
        </Specimen>
        <Specimen label="The page card (16px), with a header">
          <Panel variant="page" title="Pickup requests" headingLevel={3}>
            <p style={{ margin: 0 }}>The queue's filters and table sit in the page card.</p>
          </Panel>
        </Specimen>
      </div>
    </KitSection>
  );
}

function StatTileSpecimens() {
  const [again, setAgain] = useState(0);
  return (
    <KitSection
      title="StatTile"
      note="A figure the server states. A figure that was not stated is never a 0, and a figure still being read is a bar. The count-up plays once, and not at all under reduced motion."
    >
      <div className="showcase-kit-grid">
        <Specimen label="A figure with a caption (sample data)">
          <StatTile label="Waiting for confirmation" value={12} caption="Oldest: 3 hours" />
        </Specimen>
        <Specimen label="A large figure, grouped">
          <StatTile label="Pickup requests this month" value={12480} />
        </Specimen>
        <Specimen label="Counts up once (press the button to mount it again)">
          <div className="showcase-kit-stack" key={again}>
            <StatTile label="Dispatched today" value={248} caption="Sample figure" countUp />
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setAgain((count) => count + 1);
              }}
            >
              Count up again
            </Button>
          </div>
        </Specimen>
        <Specimen label="A 0 that the server stated">
          <StatTile label="Late bookings" value={0} caption="Nothing is waiting" />
        </Specimen>
        <Specimen label="Loading: a bar, never a number">
          <StatTile label="Waiting for confirmation" loading />
        </Specimen>
        <Specimen label="Not available: a dash, never a 0">
          <StatTile label="Waiting for confirmation" caption="The count could not be read" />
        </Specimen>
        <Specimen label="Text it is given (an amount the page formatted)">
          <StatTile label="Estimate" value="GH₵25.50" caption="Indicative, not a price" />
        </Specimen>
      </div>
    </KitSection>
  );
}

export function PanelsGroup() {
  return (
    <>
      <SidePanelSpecimen />
      <RecordHeaderSpecimens />
      <DescriptionListSpecimens />
      <PanelSpecimens />
      <StatTileSpecimens />
    </>
  );
}
