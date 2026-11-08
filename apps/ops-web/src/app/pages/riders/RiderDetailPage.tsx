import { useLayoutEffect } from 'react';
import { useParams } from 'react-router';

// eslint-disable-next-line no-restricted-imports -- the older PageHeader: this screen moves to the kit's when it is rebuilt (task R5.2, M12)
import { PageHeader } from '../../../components/PageHeader';
import { PageHeading } from '../../../components/PageHeading';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { ForbiddenPage } from '../../../components/ui/forbidden-state/ForbiddenState';
import { Link } from '../../../components/ui/link/Link';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { Table, type TableColumn } from '../../../components/ui/table/Table';
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
import '../staff/staff-pages.css';

function BackToRiders() {
  return (
    <p className="staff-back">
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
      <PageHeading>Rider not found</PageHeading>
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

/** The rider that was read, and what the session may do with it. It is given the read itself and does not ask again. */
function Rider({ id, record }: { readonly id: string; readonly record: RiderRecord }) {
  const me = useSignedInSession();
  if (me === undefined) return null;
  const { rider, devices } = record;
  const mayBind = mayBindDevice(rider.status);
  const holdsRegister = me.holds('staff.device.register');
  const holdsRevoke = me.holds('staff.device.revoke');

  const columns: TableColumn<RiderDeviceView>[] = [
    {
      key: 'status',
      header: 'Status',
      rowHeader: true,
      cell: (row) => <StatusBadge status={row.status} map={RIDER_DEVICE_STATUS_MAP} />,
    },
    {
      key: 'registered',
      header: 'Registered',
      cell: (row) =>
        row.registered_at === undefined ? 'Not recorded' : formatInstant(row.registered_at),
    },
    { key: 'by', header: 'Registered by', cell: (row) => registeredBySentence(row) },
  ];

  return (
    <>
      <p className="staff-status">
        <StatusBadge status={rider.status} map={RIDER_STATUS_MAP} />{' '}
        <span>{statusSentence(rider.status)}</span>
      </p>

      <dl className="staff-facts">
        <dt>Phone</dt>
        <dd>{rider.phone}</dd>
        <dt>Hub</dt>
        <dd>{hubNameOf(rider.primary_hub_id, me.session.authorized_hubs)}</dd>
        <dt>PIN</dt>
        <dd>{pinSentence(rider)}</dd>
        <dt>Device</dt>
        <dd>{deviceSentence(rider)}</dd>
        <dt>Readiness</dt>
        <dd>{readinessSentence(rider)}</dd>
      </dl>

      <section className="staff-actions" aria-labelledby="rider-actions">
        <h2 id="rider-actions">What you can do</h2>
        {devices.length === 0 ? (
          <div>
            {!mayBind ? (
              <p className="staff-action__text">
                A device cannot be registered while this rider’s access has ended.
              </p>
            ) : holdsRegister ? (
              <>
                <p className="staff-action__text">
                  This rider has no device yet. Register their first one in person: they scan a code
                  with the Melarc Rider app on the handset they will use, and set their own PIN.
                </p>
                <div className="staff-action__buttons">
                  <ButtonLink to={`/admin/riders/${id}/device/register`} variant="secondary">
                    Register the first device
                  </ButtonLink>
                </div>
              </>
            ) : (
              <p className="staff-action__text">
                Registering a rider’s first device needs the permission staff.device.register, which
                your session does not hold.
              </p>
            )}
          </div>
        ) : (
          <div>
            {holdsRevoke ? (
              <>
                <p className="staff-action__text">
                  If the handset is lost or stolen, revoke it at once: the rider’s session ends with
                  it. To give the rider a new handset, replace it in person once you have verified
                  who they are.
                </p>
                <div className="staff-action__buttons">
                  <ButtonLink to={`/admin/riders/${id}/device`} variant="secondary">
                    Revoke or replace the device
                  </ButtonLink>
                </div>
              </>
            ) : (
              <p className="staff-action__text">
                Revoking or replacing a rider’s device needs the permission staff.device.revoke,
                which your session does not hold.
              </p>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="rider-devices">
        <h2 id="rider-devices">Devices</h2>
        {devices.length === 0 ? (
          <p>No device has been registered for this rider.</p>
        ) : (
          <Table
            caption="Devices of the rider"
            hideCaption
            columns={columns}
            rows={devices}
            rowKey={(row) => row.id}
          />
        )}
      </section>
    </>
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
      <PageHeader
        title={title}
        {...(query.data === undefined ? {} : { description: query.data.rider.phone })}
      />
      {query.status === 'success' ? (
        <Rider id={id} record={query.data} />
      ) : (
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
      )}
    </>
  );
}

/**
 * One rider (surfaces/ops-portal.md section 7, `/admin/riders/{id}`; S0.60a): the rider's status, whether a PIN is set and a device is active, and
 * the devices the rider has held. The two device pages are entered from here, and the page offers the one that fits the rider: the **first
 * binding** for a rider who has held no device, and revoking or replacing for one who has. **A PIN, a hash and a key are never shown**: no answer
 * holds one and the page has no field for one. A rider in a hub the session does not act in and one that does not exist are pages of their own.
 * Only what can be done is offered, and a hint is not the authority: the server checks the key and the hub on every request.
 */
export function RiderDetailPage() {
  const { id = '' } = useParams();
  if (!UUID.test(id)) return <RiderNotFound />;
  return <Reading key={id} id={id} />;
}
