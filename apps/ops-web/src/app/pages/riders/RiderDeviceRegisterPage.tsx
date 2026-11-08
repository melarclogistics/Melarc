import { useParams, useNavigate } from 'react-router';

import { FormPage } from '../../../components/FormPage';
import { PageHeader } from '../../../components/PageHeader';
import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { Link } from '../../../components/ui/link/Link';
import { CommandOutcomeNotice } from '../../../components/ui/reason-confirmation/command-outcome';
import { useApiClient } from '../../../platform/api/api-client';
import { copyFor } from '../../../platform/problem/problem-copy';
import { registerRiderDevice } from '../../../platform/rider/rider-commands';
import { useRider } from '../../../platform/rider/use-rider-queries';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { UUID } from '../staff/WithProfile';
import { CodeRecovery } from './CodeRecovery';
import { EnrolmentCode, LapsedCode } from './EnrolmentCode';
import { RiderNotFound } from './RiderDetailPage';
import { mayBindDevice } from './rider-presentation';
import { useEnrolmentCode } from './use-enrolment-code';
import '../staff/staff-pages.css';
import './riders.css';

/** The registration asks for nothing of the person: the rider is in the address, and the key is the command's. */
type Nothing = Readonly<Record<string, never>>;
const NOTHING: Nothing = {};

function Registering({ id }: { readonly id: string }) {
  const client = useApiClient();
  const navigate = useNavigate();
  const me = useSignedInSession();
  // The rider is read for what it can tell the officer, and the page does not wait for it or depend on it: a session whose scope reaches the
  // rider but whose roster does not (a Platform Admin granted the key at every hub) can still register, and the server decides.
  const rider = useRider(id);
  const code = useEnrolmentCode<Nothing>({
    operation: 'registerRiderDevice',
    retryable: true,
    request: (_command, key, signal) => registerRiderDevice(client, id, key, signal),
    onReload: () => rider.refetch(),
  });
  const { command } = code;

  const known = rider.status === 'success' ? rider.data : undefined;
  const name = known?.rider.full_name;
  const held = known === undefined ? 0 : known.devices.length;
  const blockedByStatus = known !== undefined && !mayBindDevice(known.rider.status);
  const holdsRevoke = me?.holds('staff.device.revoke') === true;

  function finish(): void {
    code.clear();
    void navigate(`/admin/riders/${id}`);
  }

  const back = (
    <p className="staff-back">
      <Link to={`/admin/riders/${id}`}>Back to the rider</Link>
    </p>
  );

  return (
    <>
      <title>Register a first device · Melarc Ops Portal</title>
      {back}
      <PageHeader
        title="Register a first device"
        {...(name === undefined ? {} : { description: `For ${name}.` })}
      />

      {code.grant !== undefined ? (
        <EnrolmentCode
          grant={code.grant}
          onFinish={finish}
          onNew={() => {
            void command.submit(NOTHING);
          }}
          renewing={command.phase === 'sending'}
        />
      ) : code.status === 'expired' ? (
        <LapsedCode
          onNew={() => {
            void command.submit(NOTHING);
          }}
          renewing={command.phase === 'sending'}
        />
      ) : held > 0 ? (
        <FormPage>
          <Alert variant="danger">
            <p>
              This rider already has a device, or has had one revoked, so a first device cannot be
              registered.{' '}
              {holdsRevoke ? (
                <Link to={`/admin/riders/${id}/device`}>Replace the device instead.</Link>
              ) : (
                'Replacing it is done from the device page, which your session cannot open.'
              )}
            </p>
          </Alert>
        </FormPage>
      ) : blockedByStatus ? (
        <FormPage>
          <Alert variant="danger">
            <p>A device cannot be registered while this rider’s access has ended.</p>
          </Alert>
        </FormPage>
      ) : (
        <FormPage>
          <p>
            Do this in person, with the rider and the handset they will use. A code appears here;
            the rider scans it with the Melarc Rider app, which makes the key on their handset and
            asks them to choose a PIN. You never see the PIN or the key.
          </p>
          <ol className="rider-steps">
            <li>Check that this is the rider, and that the handset is their own.</li>
            <li>Show the code, and let the rider scan it.</li>
            <li>The rider chooses their PIN on the handset. Then come back here.</li>
          </ol>
          <CommandOutcomeNotice
            command={command}
            unknownText={copyFor({ operation: 'registerRiderDevice', context: 'unknown-outcome' })}
          />
          <div className="staff-action__buttons">
            {command.phase === 'unknown' ? (
              <CodeRecovery command={command} />
            ) : command.phase === 'conflict' ? (
              <Button type="button" data-recovery onClick={command.checkRecord}>
                Reload the rider
              </Button>
            ) : (
              <Button
                type="button"
                loading={command.phase === 'sending'}
                onClick={() => {
                  void command.submit(NOTHING);
                }}
              >
                Show the QR code
              </Button>
            )}
          </div>
        </FormPage>
      )}
    </>
  );
}

/**
 * The first binding of a rider's device (surfaces/ops-portal.md section 7, `/admin/riders/{id}/device/register`; S0.60b), in person. The officer
 * presses a button, the API makes one single-use enrolment grant, and the page draws it as a QR code for the rider to scan. **The QR is the
 * credential**: it is held in memory only, drawn as modules and written nowhere (no text, no link, no copy button, no cache, no storage, no log),
 * and it is gone when the page is left, when the rider has scanned it, when the page is hidden, when the session ends and when its time is up;
 * a code that has lapsed is never left on screen. The officer never receives the rider's PIN or key.
 *
 * The request carries an `Idempotency-Key` and no version, so a lost answer is tried again under the same key and no second grant is made. A rider
 * who already has an `ACTIVE` device, or has had one revoked, is `STATE_CONFLICT`, explained and pointed at the replacement.
 */
export function RiderDeviceRegisterPage() {
  const { id = '' } = useParams();
  if (!UUID.test(id)) return <RiderNotFound />;
  return <Registering key={id} id={id} />;
}
