import { useLayoutEffect } from 'react';
import { useParams } from 'react-router';

import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { DataTable, type DataColumn } from '../../../components/ui/data-table/DataTable';
import { DescriptionList } from '../../../components/ui/description-list/DescriptionList';
import { ForbiddenPage } from '../../../components/ui/forbidden-state/ForbiddenState';
import { Link } from '../../../components/ui/link/Link';
import { PageHeader } from '../../../components/ui/page-header/PageHeader';
import { Panel } from '../../../components/ui/panel/Panel';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { RecordPage } from '../../../components/ui/templates/RecordPage';
import { cannotText } from '../../../platform/problem/capability-words';
import { copyFor, problemOf } from '../../../platform/problem/problem-copy';
import type { RiderDeviceView } from '../../../platform/rider/rider-shape';
import { useRider, type RiderRecord } from '../../../platform/rider/use-rider-queries';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { hubNameOf } from '../staff/staff-presentation';
import { UUID } from '../staff/WithProfile';
import {
  deviceSentence,
  mayBindDevice,
  pinSentence,
  readinessSentence,
  registeredBySentence,
  RIDER_DEVICE_STATUS_MAP,
  RIDER_STATUS_MAP,
  statusSentence,
} from './rider-presentation';
import './riders.css';

/**
 * The way back from the rider's page, in every state of it (loading, read, not found): the roster, as one link above the heading, which a person who has pressed it while the rider was on its
 * way does not lose to the page replacing it. A record page has this and no breadcrumb; the tasks on the rider (the device pages) have the breadcrumb of their parents and no such link.
 */
function BackToRiders() {
  return (
    <p className="rider-back">
      <Link to="/admin/riders">Back to riders</Link>
    </p>
  );
}

/** Focus to the heading when a page replaces the one that was loading in the same place (see `WithProfile`). */
function useFocusFallenToHeading(): void {
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body)
      document.querySelector<HTMLElement>('h1')?.focus();
  }, []);
}

export function RiderNotFound() {
  useFocusFallenToHeading();
  return (
    <>
      <title>Rider not found · Melarc Ops Portal</title>
      <PageHeader title="Rider not found" />
      <p>{copyFor({ operation: 'getRider', code: 'NOT_FOUND' })}</p>
      <BackToRiders />
    </>
  );
}

export function RiderOutsideHubs() {
  useFocusFallenToHeading();
  return <ForbiddenPage kind="outside-hubs" />;
}

export function RiderNoAccess() {
  useFocusFallenToHeading();
  return <ForbiddenPage kind="permission-missing" permission="dispatch.read" />;
}

/** One device of the rider as a card, for a room too narrow for the columns: its status, then the facts, each under its name. */
function DeviceCard({ device }: { readonly device: RiderDeviceView }) {
  return (
    <>
      <div className="rider-card__head">
        <StatusBadge status={device.status} map={RIDER_DEVICE_STATUS_MAP} />
      </div>
      <dl className="rider-card__facts">
        <div className="rider-card__fact">
          <dt>Registered</dt>
          <dd>{registeredAt(device)}</dd>
        </div>
        <div className="rider-card__fact">
          <dt>Registered by</dt>
          <dd>{registeredBySentence(device)}</dd>
        </div>
      </dl>
    </>
  );
}

const registeredAt = (device: RiderDeviceView): string =>
  device.registered_at === undefined
    ? 'Not recorded'
    : (formatInstant(device.registered_at) ?? 'Not recorded');

const DEVICE_COLUMNS: readonly DataColumn<RiderDeviceView>[] = [
  {
    id: 'status',
    header: 'Status',
    rowHeader: true,
    cell: (row) => <StatusBadge status={row.status} map={RIDER_DEVICE_STATUS_MAP} />,
  },
  { id: 'registered', header: 'Registered', cell: (row) => registeredAt(row) },
  { id: 'by', header: 'Registered by', cell: (row) => registeredBySentence(row) },
];

/** The rider that was read, and what the session may do with it. It is given the read itself and does not ask again. */
function Rider({ id, record }: { readonly id: string; readonly record: RiderRecord }) {
  const me = useSignedInSession();
  // The page draws its own heading once the rider is read (the one the wrapper drew while it loaded is gone): focus is put on it, as on any record page.
  useFocusFallenToHeading();
  if (me === undefined) return null;
  const { rider, devices } = record;
  const noDevice = devices.length === 0;
  const mayBind = mayBindDevice(rider.status);
  const holdsRegister = me.holds('staff.device.register');
  const holdsRevoke = me.holds('staff.device.revoke');

  // The acts follow the held keys and what the record says and decide nothing (the server checks every request): the first binding for a rider who has held no device, revoking or
  // replacing for one who has. What the session cannot do is told in one muted line in plain words, and the explanation of each act is on its own page.
  const note: string | undefined =
    noDevice && !mayBind
      ? 'A device cannot be registered while this rider’s access has ended.'
      : noDevice && !holdsRegister
        ? cannotText('staff.device.register')
        : !noDevice && !holdsRevoke
          ? cannotText('staff.device.revoke')
          : undefined;

  return (
    <RecordPage
      header={{
        code: rider.full_name,
        titleKind: 'name',
        status: <StatusBadge status={rider.status} map={RIDER_STATUS_MAP} />,
        sentence: statusSentence(rider.status),
      }}
      acts={{
        ...(noDevice && mayBind && holdsRegister
          ? {
              primary: (
                <ButtonLink to={`/admin/riders/${id}/device/register`}>
                  Register the first device
                </ButtonLink>
              ),
            }
          : {}),
        ...(!noDevice && holdsRevoke
          ? {
              secondary: (
                <ButtonLink to={`/admin/riders/${id}/device`} variant="secondary">
                  Revoke or replace the device
                </ButtonLink>
              ),
            }
          : {}),
        ...(note === undefined ? {} : { note }),
      }}
      main={
        <>
          <Panel title="The rider" headingLevel={2}>
            <div className="rider-facts-groups">
              <DescriptionList
                items={[
                  { label: 'Phone', value: rider.phone },
                  {
                    label: 'Hub',
                    value: hubNameOf(rider.primary_hub_id, me.session.authorized_hubs),
                  },
                ]}
              />
              <DescriptionList
                heading="Sign-in"
                headingLevel={3}
                items={[
                  { label: 'PIN', value: pinSentence(rider) },
                  { label: 'Device', value: deviceSentence(rider) },
                  { label: 'Readiness', value: readinessSentence(rider) },
                ]}
              />
            </div>
          </Panel>
          {noDevice ? (
            <Panel title="Devices" headingLevel={2}>
              <p>No device has been registered for this rider.</p>
            </Panel>
          ) : (
            <Panel title="Devices" headingLevel={2} padding="none">
              <DataTable<RiderDeviceView>
                label="Devices of the rider"
                columns={DEVICE_COLUMNS}
                rows={devices}
                rowId={(row) => row.id}
                card={(row) => <DeviceCard device={row} />}
                cardHeadingLevel={3}
              />
            </Panel>
          )}
        </>
      }
    />
  );
}

function Reading({ id }: { readonly id: string }) {
  const query = useRider(id);
  if (query.status === 'error') {
    const problem = problemOf(query.error, { operation: 'getRider' });
    if (problem.kind === 'not-found') return <RiderNotFound />;
    if (problem.kind === 'forbidden' && problem.forbidden === 'outside-hubs') {
      return <RiderOutsideHubs />;
    }
    if (problem.kind === 'forbidden' && problem.forbidden === 'permission-missing') {
      return <RiderNoAccess />;
    }
  }
  const title = query.data?.rider.full_name ?? 'Rider';
  return (
    <>
      <title>{`${title} · Melarc Ops Portal`}</title>
      <BackToRiders />
      {query.status === 'success' ? (
        <Rider id={id} record={query.data} />
      ) : (
        // Loading, or a failure that is not one of the pages above: the page still has its heading and its way back, and says what is happening.
        <>
          <PageHeader title="Rider" />
          <ReadState<RiderRecord>
            query={query}
            isEmpty={() => false}
            empty={null}
            loadingLabel="Loading the rider…"
            skeleton={<Skeleton lines={4} />}
            permission="dispatch.read"
            operation="getRider"
          >
            {() => null}
          </ReadState>
        </>
      )}
    </>
  );
}

/**
 * One rider (surfaces/ops-portal.md section 7, `/admin/riders/{id}`; S0.60a; redesign step R7b, the record template, as the pickup run's page is): the rider's name for its heading, the
 * administrative status in the header, whether a PIN is set and a device is active (readiness, told as facts and apart from the status), and the devices the rider has held. The two
 * device pages are entered from the header, and the page offers the one that fits the rider: the **first binding** for a rider who has held no device, and revoking or replacing for one
 * who has. **A PIN, a hash and a key are never shown**: no answer holds one and the page has no field for one. A rider in a hub the session does not act in and one that does not exist are
 * pages of their own. Only what can be done is offered, and a hint is not the authority: the server checks the key and the hub on every request.
 */
export function RiderDetailPage() {
  const { id = '' } = useParams();
  if (!UUID.test(id)) return <RiderNotFound />;
  return <Reading key={id} id={id} />;
}
