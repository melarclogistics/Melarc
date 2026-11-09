import { useEffect, useRef, type SubmitEvent } from 'react';
import { useParams, useNavigate } from 'react-router';

import { FormPage } from '../../../components/FormPage';
import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { Link } from '../../../components/ui/link/Link';
import { PageHeader } from '../../../components/ui/page-header/PageHeader';
import { CommandOutcomeNotice } from '../../../components/ui/reason-confirmation/command-outcome';
import { TaskForm, TaskFormSection } from '../../../components/ui/templates/TaskForm';
import { useApiClient } from '../../../platform/api/api-client';
import { copyFor } from '../../../platform/problem/problem-copy';
import { registerRiderDevice } from '../../../platform/rider/rider-commands';
import { useRider } from '../../../platform/rider/use-rider-queries';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { UUID } from '../staff/WithProfile';
import { CodeRecovery } from './CodeRecovery';
import { EnrolmentCode, LapsedCode, WithdrawnCode } from './EnrolmentCode';
import { RiderNotFound } from './RiderDetailPage';
import { mayBindDevice } from './rider-presentation';
import { useEnrolmentCode } from './use-enrolment-code';
import './riders.css';

/** The registration asks for nothing of the person: the rider is in the address, and the key is the command's. */
type Nothing = Readonly<Record<string, never>>;
const NOTHING: Nothing = {};

/** The way up from the page: the roster. The way to the rider is the link above the heading, which every state of the page keeps. */
const WAY_UP = [{ label: 'Riders', to: '/admin/riders' }] as const;

/** What the task is, in two short sentences under its title: it is done in person, and the officer never sees what the handset makes. */
const INTRO =
  'Do this in person, with the rider and the handset they will use. A code appears for the rider to scan, and you never see their PIN or key.';

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
  const actions = useRef<HTMLDivElement>(null);

  // The control the officer pressed can go while the request is under way or when its answer comes: the button of the lapsed screen with the
  // request, and the button that asked or the retry once the way out of an outcome nobody knows takes its place. The focus then falls to the
  // document, where a screen reader says nothing. It goes to the control for what comes next: the way out, the reload of a conflict, or the
  // button that asks. Only a focus that has fallen is put back: on the document, or on a region that merely holds the controls (an engine that
  // does not focus a button when it is clicked leaves the focus on the page's main region, and the frame itself treats that focus as waiting).
  // One the officer holds, or the notice of an earlier code (which takes it as the code goes), is left alone, and the code takes it when it arrives.
  useEffect(() => {
    if (command.phase === 'idle' || command.phase === 'done') return;
    const buttons = actions.current;
    if (buttons === null) return;
    const held = document.activeElement;
    if (held !== null && held !== document.body && !held.contains(buttons)) return;
    const next =
      buttons.querySelector<HTMLElement>('[data-recovery]') ??
      buttons.querySelector<HTMLElement>('button');
    next?.focus();
  }, [command.phase]);

  const known = rider.status === 'success' ? rider.data : undefined;
  const name = known?.rider.full_name;
  const held = known === undefined ? 0 : known.devices.length;
  const blockedByStatus = known !== undefined && !mayBindDevice(known.rider.status);
  const holdsRevoke = me?.holds('staff.device.revoke') === true;

  function finish(): void {
    code.clear();
    void navigate(`/admin/riders/${id}`);
  }
  function asking(): void {
    void command.submit(NOTHING);
  }

  const back = (
    <p className="rider-back">
      <Link to={`/admin/riders/${id}`}>Back to the rider</Link>
    </p>
  );
  const header = {
    title: 'Register a first device',
    ...(name === undefined ? {} : { description: `For ${name}.` }),
    breadcrumb: WAY_UP,
  };

  // What is under the heading: the code (while it is held), the screen of a code that has lapsed, or the form that asks for one.
  const showing = code.grant !== undefined;
  const lapsed = !showing && code.status === 'expired';
  const asks = !showing && !lapsed;

  // The task cannot be done for this rider as the record stands: the page says so in its own words, with no form (the pattern of the one-package exception).
  if (asks && held > 0) {
    return (
      <>
        <title>Register a first device · Melarc Ops Portal</title>
        {back}
        <PageHeader {...header} />
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
      </>
    );
  }
  if (asks && blockedByStatus) {
    return (
      <>
        <title>Register a first device · Melarc Ops Portal</title>
        {back}
        <PageHeader {...header} />
        <FormPage>
          <Alert variant="danger">
            <p>A device cannot be registered while this rider’s access has ended.</p>
          </Alert>
        </FormPage>
      </>
    );
  }

  return (
    <>
      <title>Register a first device · Melarc Ops Portal</title>
      {back}
      <TaskForm
        header={header}
        busy={command.phase === 'sending'}
        // A code is asked for by the button and by nothing else: no event of the form (an implicit submission, a stray Enter) makes a grant for a rider nobody is with.
        onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
          event.preventDefault();
        }}
        alerts={
          asks ? (
            <>
              {code.withdrawn ? <WithdrawnCode /> : null}
              <CommandOutcomeNotice
                command={command}
                unknownText={copyFor({
                  operation: 'registerRiderDevice',
                  context: 'unknown-outcome',
                })}
              />
            </>
          ) : null
        }
        actions={
          asks ? (
            <div className="rider-actions" ref={actions}>
              {/*
                Every button here is a button of type "button", and none is the form's submit: the button that asks, the reload of a conflict and the way out of an outcome nobody
                knows are one element in turn, so the focus stays on it when its words change (it is the button that asked, and it is still there), and a click on the reload cannot
                become a submission of the form.
              */}
              {command.phase === 'unknown' ? (
                <CodeRecovery command={command} />
              ) : command.phase === 'conflict' ? (
                <Button type="button" data-recovery onClick={command.checkRecord}>
                  Reload the rider
                </Button>
              ) : (
                <Button type="button" loading={command.phase === 'sending'} onClick={asking}>
                  Show the QR code
                </Button>
              )}
            </div>
          ) : null
        }
      >
        {/* The code, and the screen of a code that has lapsed, are sections of their own, each under its own heading: the section of the task is not drawn around them. */}
        {showing ? (
          <EnrolmentCode grant={code.grant} onFinish={finish} onNew={asking} />
        ) : lapsed ? (
          <LapsedCode onNew={asking} />
        ) : (
          <TaskFormSection title="The first device" description={INTRO}>
            {null}
          </TaskFormSection>
        )}
      </TaskForm>
    </>
  );
}

/**
 * The first binding of a rider's device (surfaces/ops-portal.md section 7, `/admin/riders/{id}/device/register`; S0.60b; redesign step R7b, the task form, as the one-package exception
 * is), in person. The officer presses a button, the API makes one single-use enrolment grant, and the page draws it as a QR code for the rider to scan. **The QR is the
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
