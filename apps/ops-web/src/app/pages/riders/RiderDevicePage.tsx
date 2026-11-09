import type { UseQueryResult } from '@tanstack/react-query';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type SubmitEvent,
} from 'react';
import { useNavigate, useParams } from 'react-router';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { Field } from '../../../components/ui/field/Field';
import { focusFirstInvalid } from '../../../components/ui/form/use-submission';
import { Link } from '../../../components/ui/link/Link';
import { PageHeader, type PageHeaderProps } from '../../../components/ui/page-header/PageHeader';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { CommandOutcomeNotice } from '../../../components/ui/reason-confirmation/command-outcome';
import { ReasonConfirmationDialog } from '../../../components/ui/reason-confirmation/ReasonConfirmationDialog';
import { ReasonSelect } from '../../../components/ui/reason-select/ReasonSelect';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { TaskForm, TaskFormSection, TaskFormWide } from '../../../components/ui/templates/TaskForm';
import { Textarea } from '../../../components/ui/textarea/Textarea';
import { useApiClient } from '../../../platform/api/api-client';
import { cannotText } from '../../../platform/problem/capability-words';
import { copyFor, problemOf, type Problem } from '../../../platform/problem/problem-copy';
import { useReasonDefinitions } from '../../../platform/reasons/reason-definitions';
import { reregisterRiderDevice, revokeRiderDevice } from '../../../platform/rider/rider-commands';
import { useRider, type RiderRecord } from '../../../platform/rider/use-rider-queries';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { UUID } from '../staff/WithProfile';
import { CodeRecovery } from './CodeRecovery';
import { EnrolmentCode, LapsedCode, WithdrawnCode } from './EnrolmentCode';
import { RiderNoAccess, RiderNotFound, RiderOutsideHubs } from './RiderDetailPage';
import { deviceSentence, mayBindDevice, RIDER_STATUS_MAP } from './rider-presentation';
import { useEnrolmentCode } from './use-enrolment-code';
import './riders.css';

/** The longest the verification note may be: the audit's own bound for a note, which the server checks. */
const NOTE_LIMIT = 1000;

/** The way up from the page: the roster. The way to the rider is the link above the heading, which every state of the page keeps. */
const WAY_UP = [{ label: 'Riders', to: '/admin/riders' }] as const;

/** What the replacement is, in two short sentences under its title: it is done in person, and a code comes of it. */
const REPLACE_INTRO =
  'Do this in person, once you have verified who the rider is. A code appears for the rider to scan with the new handset.';

/** Focus to the heading when a page replaces the one that was loading in the same place (see `WithProfile`). */
function useFocusFallenToHeading(): void {
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body)
      document.querySelector<HTMLElement>('h1')?.focus();
  }, []);
}

interface Replacement {
  readonly reasonCode: string;
  readonly verificationNote: string;
}

interface FieldErrors {
  readonly reason?: string;
  readonly note?: string;
}

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

/** The fields a refusal is about, in the words of the field, from where the API said it was refused and from its code. */
function serverFieldErrors(problem: Problem | undefined): FieldErrors {
  if (problem === undefined) return {};
  const places = new Set(problem.violations?.map((violation) => violation.pointer));
  const reason =
    places.has('/reason_code') || problem.code === 'REASON_NOT_ACTIVE'
      ? copyFor({
          context: 'reason',
          code: problem.code === 'REASON_NOT_ACTIVE' ? 'REASON_NOT_ACTIVE' : 'VALIDATION_FAILED',
        })
      : undefined;
  const note =
    places.has('/verification_note') || problem.code === 'REASON_REQUIRED'
      ? copyFor({
          operation: 'reregisterRiderDevice',
          context: 'verification-note',
          code: problem.code === 'REASON_REQUIRED' ? 'REASON_REQUIRED' : 'VALIDATION_FAILED',
        })
      : undefined;
  return { ...(reason === undefined ? {} : { reason }), ...(note === undefined ? {} : { note }) };
}

/**
 * The replacement of a handset, which is the form of the page: a reason, how the rider was verified in person, and the code the new handset scans. The report of a loss is the form's
 * first section (it is `revoke`, drawn by the page) and has its own dialog outside the form.
 */
function ReplaceDevice({
  id,
  record,
  query,
  header,
  alerts,
  revoke,
}: {
  readonly id: string;
  readonly record: RiderRecord;
  readonly query: UseQueryResult<RiderRecord>;
  readonly header: PageHeaderProps;
  readonly alerts: ReactNode;
  readonly revoke: ReactNode;
}) {
  const client = useApiClient();
  const navigate = useNavigate();
  const reasons = useReasonDefinitions('reregisterRiderDevice');
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [invalid, setInvalid] = useState<FieldErrors>({});
  const [invalidAttempts, setInvalidAttempts] = useState(0);
  const form = useRef<HTMLFormElement>(null);

  const code = useEnrolmentCode<Replacement>({
    operation: 'reregisterRiderDevice',
    // A replacement takes no `Idempotency-Key`: sent again after an unknown outcome it could make a second grant, so the person looks first.
    retryable: false,
    request: (command, _key, signal) =>
      reregisterRiderDevice(client, id, record.etag, command, signal),
    onReload: () => query.refetch(),
  });
  const { command } = code;

  const loaded = reasons.status === 'success' && reasons.data.length > 0;
  // A reason the catalogue no longer offers is no choice.
  const chosen = reasons.data?.find((reason) => reason.code === reasonCode);
  const choice = chosen === undefined ? '' : reasonCode;
  const fromServer = command.phase === 'refused' ? serverFieldErrors(command.problem) : {};
  const reasonError = invalid.reason ?? fromServer.reason;
  const noteError = invalid.note ?? fromServer.note;

  // After the errors are on the screen, focus goes to the first field that says it is invalid, which reads its error.
  useEffect(() => {
    if (invalidAttempts > 0) focusFirstInvalid(form.current);
  }, [invalidAttempts]);
  useEffect(() => {
    if (command.phase === 'refused') focusFirstInvalid(form.current);
    if (command.phase === 'unknown' || command.phase === 'conflict') {
      form.current?.querySelector<HTMLElement>('[data-recovery]')?.focus();
    }
  }, [command.phase]);
  // The catalogue may have changed under the person: read it again, and let the reason be chosen from what it now says.
  const refetchReasons = reasons.refetch;
  const refusedReason =
    command.phase === 'refused' && command.problem?.code === 'REASON_NOT_ACTIVE';
  useEffect(() => {
    if (refusedReason) void refetchReasons();
  }, [refusedReason, refetchReasons]);

  function validate(): FieldErrors {
    const found: { reason?: string; note?: string } = {};
    if (choice === '') found.reason = 'Choose a reason.';
    if (note.trim() === '') found.note = 'Say how you verified the rider’s identity in person.';
    else if (hasControlCharacter(note))
      found.note = 'The note must be one line. Remove the line breaks.';
    else if (note.length > NOTE_LIMIT) {
      found.note = `The note is too long. Use at most ${String(NOTE_LIMIT)} characters.`;
    }
    return found;
  }

  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (command.locked || !loaded) return;
    const found = validate();
    setInvalid(found);
    if (found.reason !== undefined || found.note !== undefined) {
      setInvalidAttempts((count) => count + 1);
      return;
    }
    void command.submit({ reasonCode: choice, verificationNote: note.trim() });
  }

  function asked(): void {
    // The same reason and note again, as a new command: the new code ends the earlier one.
    void command.submit({ reasonCode: choice, verificationNote: note.trim() });
  }

  const showing = code.grant !== undefined;
  const lapsed = !showing && code.status === 'expired';
  const asks = !showing && !lapsed;

  return (
    <TaskForm
      header={header}
      formRef={form}
      busy={command.phase === 'sending'}
      onSubmit={submit}
      alerts={
        <>
          {alerts}
          {asks && code.withdrawn ? <WithdrawnCode /> : null}
          {asks ? (
            <CommandOutcomeNotice
              command={command}
              unknownText={copyFor({
                operation: 'reregisterRiderDevice',
                context: 'unknown-outcome',
              })}
            />
          ) : null}
        </>
      }
      actions={
        asks ? (
          <>
            {/*
              Each branch has a key of its own. Without one, React reuses the button it has for the next branch and changes its type: a click on
              "Reload the rider" would turn that very button into the form's submit button before the browser acts on the click, and the browser
              would submit the form, asking for a code nobody asked for. A key makes the old button go and a new one come.
            */}
            {command.phase === 'unknown' ? (
              <CodeRecovery key="recovery" command={command} />
            ) : command.phase === 'conflict' ? (
              <Button key="reload" type="button" data-recovery onClick={command.checkRecord}>
                Reload the rider
              </Button>
            ) : (
              <Button
                key="submit"
                type="submit"
                disabled={!loaded}
                loading={command.phase === 'sending'}
              >
                Show the QR code
              </Button>
            )}
            <p className="rider-note rider-actions-note">
              Nothing changes for the old device until the new handset is registered.
            </p>
          </>
        ) : null
      }
    >
      {revoke}
      <TaskFormSection
        title="Replace the handset"
        {...(asks ? { description: REPLACE_INTRO } : {})}
      >
        {showing ? (
          <TaskFormWide>
            <EnrolmentCode
              grant={code.grant}
              onFinish={() => {
                code.clear();
                void navigate(`/admin/riders/${id}`);
              }}
              onNew={asked}
            />
          </TaskFormWide>
        ) : lapsed ? (
          <TaskFormWide>
            <LapsedCode onNew={asked} />
          </TaskFormWide>
        ) : (
          <>
            <TaskFormWide>
              <ReasonSelect
                query={reasons}
                value={choice}
                disabled={command.locked}
                {...(reasonError === undefined ? {} : { error: reasonError })}
                onChange={(next) => {
                  setReasonCode(next);
                  setInvalid((current) => ({ ...current, reason: undefined }));
                  command.dismiss();
                }}
              />
            </TaskFormWide>
            {loaded ? (
              <TaskFormWide>
                <Field
                  label="How you verified the rider in person"
                  required
                  help="One line, up to 1000 characters. Leave out email addresses and telephone numbers."
                  {...(noteError === undefined ? {} : { error: noteError })}
                >
                  <Textarea
                    name="verification-note"
                    value={note}
                    maxLength={NOTE_LIMIT}
                    autoComplete="off"
                    readOnly={command.locked}
                    onChange={(event) => {
                      setNote(event.target.value);
                      setInvalid((current) => ({ ...current, note: undefined }));
                      command.dismiss();
                    }}
                  />
                </Field>
              </TaskFormWide>
            ) : null}
          </>
        )}
      </TaskFormSection>
    </TaskForm>
  );
}

/**
 * The rider that was read: the report of a loss, and the replacement of a handset, as the two sections of one task form. It is given the read itself and does not ask again. What the
 * session cannot do is said in the section of the act, in plain words, and the dialog of the report of a loss stands outside the form, so that its own submission never reaches the
 * replacement's.
 */
function Device({
  id,
  record,
  query,
}: {
  readonly id: string;
  readonly record: RiderRecord;
  readonly query: UseQueryResult<RiderRecord>;
}) {
  const client = useApiClient();
  const me = useSignedInSession();
  const [revoking, setRevoking] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const noticeBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (notice !== undefined) noticeBox.current?.focus();
  }, [notice]);
  // The page draws its own heading once the rider is read (the one the wrapper drew while it loaded is gone): focus is put on it, as on a record page.
  useFocusFallenToHeading();
  if (me === undefined) return null;
  const { rider, devices } = record;
  const holdsReregister = me.holds('staff.device.reregister');
  const holdsRegister = me.holds('staff.device.register');

  function reload(): Promise<unknown> {
    setRevoking(false);
    return query.refetch();
  }

  const header: PageHeaderProps = {
    title: 'Revoke or replace a device',
    description: `For ${rider.full_name}.`,
    breadcrumb: WAY_UP,
  };
  const news =
    notice === undefined ? null : (
      <div className="rider-notice" ref={noticeBox} tabIndex={-1}>
        <Alert variant="success">
          <p>{notice}</p>
        </Alert>
      </div>
    );
  const revoke = (
    <TaskFormSection title="Report a lost or stolen device">
      <TaskFormWide>
        <p className="rider-status-line">
          <StatusBadge status={rider.status} map={RIDER_STATUS_MAP} />{' '}
          <span>{deviceSentence(rider)}.</span>
        </p>
      </TaskFormWide>
      <TaskFormWide>
        {rider.has_active_device ? (
          <div>
            <Button
              type="button"
              variant="danger"
              loading={query.isFetching}
              onClick={() => {
                setRevoking(true);
              }}
            >
              Revoke the device
            </Button>
          </div>
        ) : (
          <p className="rider-note">This rider has no active device to revoke.</p>
        )}
      </TaskFormWide>
    </TaskFormSection>
  );

  // The replacement is a form only for a session that may replace, for a rider whose access has not ended and who has held a device: the server checks it all the same.
  const replaces = holdsReregister && mayBindDevice(rider.status) && devices.length > 0;

  return (
    <>
      {replaces ? (
        <ReplaceDevice
          id={id}
          record={record}
          query={query}
          header={header}
          alerts={news}
          revoke={revoke}
        />
      ) : (
        <TaskForm
          header={header}
          alerts={news}
          actions={null}
          onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
            event.preventDefault();
          }}
        >
          {revoke}
          <TaskFormSection title="Replace the handset">
            <TaskFormWide>
              {!holdsReregister ? (
                <p className="rider-note">{cannotText('staff.device.reregister')}</p>
              ) : !mayBindDevice(rider.status) ? (
                <p className="rider-note">
                  A replacement handset cannot be registered while this rider’s access has ended.
                </p>
              ) : (
                <p className="rider-note">
                  This rider has held no device, so there is nothing to replace.{' '}
                  {holdsRegister ? (
                    <Link to={`/admin/riders/${id}/device/register`}>Register a first device.</Link>
                  ) : null}
                </p>
              )}
            </TaskFormWide>
          </TaskFormSection>
        </TaskForm>
      )}

      <ReasonConfirmationDialog
        open={revoking}
        title="Revoke this device?"
        consequence={
          <p>
            The rider’s device is revoked now and their session ends. The handset cannot sign in
            again, and a new one has to be registered in person.
          </p>
        }
        confirmLabel="Revoke the device"
        operation="revokeRiderDevice"
        withNote={false}
        retryable
        send={(command) => revokeRiderDevice(client, id, command.reasonCode)}
        onDone={() => {
          setRevoking(false);
          setNotice('The device is revoked and the rider’s session has ended.');
          void query.refetch();
        }}
        onCancel={() => {
          setRevoking(false);
        }}
        onReload={reload}
      />
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
  const title = 'Revoke or replace a device';
  return (
    <>
      <title>{`${title} · Melarc Ops Portal`}</title>
      <p className="rider-back">
        <Link to={`/admin/riders/${id}`}>Back to the rider</Link>
      </p>
      {query.status === 'success' ? (
        <Device id={id} record={query.data} query={query} />
      ) : (
        // Loading, or a failure that is not one of the pages above: the page still has its heading and its way up, and says what is happening.
        <>
          <PageHeader title={title} breadcrumb={WAY_UP} />
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
 * The device of a rider (surfaces/ops-portal.md section 7, `/admin/riders/{id}/device`; S0.60b; redesign step R7b, the task form): **two actions, two keys**, and the page
 * names the capability each needs in plain words and never a permission key or a role. **Revoke** is the report of a lost or stolen handset: a reason and a confirmation, no
 * version and no verification, and it ends the rider's live session. **Replace the handset** takes a reason, a mandatory note on how the
 * rider's identity was verified in person (a `Textarea`) and the version the roster read (`If-Match`), and shows the same QR handoff as the first
 * registration, with the same rule for the code: in memory only, gone on navigation, completion, expiry. The page opens for a holder of
 * `staff.device.revoke`; the replacement is offered inside it to one who also holds `staff.device.reregister`.
 */
export function RiderDevicePage() {
  const { id = '' } = useParams();
  if (!UUID.test(id)) return <RiderNotFound />;
  return <Reading key={id} id={id} />;
}
