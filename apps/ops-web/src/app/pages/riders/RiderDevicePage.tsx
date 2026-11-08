import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useNavigate, useParams } from 'react-router';

import { FormPage } from '../../../components/FormPage';
import { PageHeader } from '../../../components/PageHeader';
import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { Field } from '../../../components/ui/field/Field';
import { focusFirstInvalid } from '../../../components/ui/form/use-submission';
import { Link } from '../../../components/ui/link/Link';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { CommandOutcomeNotice } from '../../../components/ui/reason-confirmation/command-outcome';
import { ReasonConfirmationDialog } from '../../../components/ui/reason-confirmation/ReasonConfirmationDialog';
import { ReasonSelect } from '../../../components/ui/reason-select/ReasonSelect';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { Textarea } from '../../../components/ui/textarea/Textarea';
import { useApiClient } from '../../../platform/api/api-client';
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
import '../staff/staff-pages.css';
import './riders.css';

/** The longest the verification note may be: the audit's own bound for a note, which the server checks. */
const NOTE_LIMIT = 1000;

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

/** The replacement of a handset: a reason, how the rider was verified in person, and the code the new handset scans. */
function ReplaceDevice({
  id,
  record,
  query,
}: {
  readonly id: string;
  readonly record: RiderRecord;
  readonly query: UseQueryResult<RiderRecord>;
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

  if (code.grant !== undefined) {
    return (
      <EnrolmentCode
        grant={code.grant}
        onFinish={() => {
          code.clear();
          void navigate(`/admin/riders/${id}`);
        }}
        onNew={asked}
      />
    );
  }
  if (code.status === 'expired') return <LapsedCode onNew={asked} />;

  return (
    <form
      ref={form}
      noValidate
      className="rider-form"
      aria-busy={command.phase === 'sending' ? true : undefined}
      onSubmit={submit}
    >
      {code.withdrawn ? <WithdrawnCode /> : null}
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
      {loaded ? (
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
      ) : null}

      <CommandOutcomeNotice
        command={command}
        unknownText={copyFor({ operation: 'reregisterRiderDevice', context: 'unknown-outcome' })}
      />

      <div className="staff-action__buttons">
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
      </div>
    </form>
  );
}

/** The rider that was read: the report of a loss, and the replacement of a handset. It is given the read itself and does not ask again. */
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
  if (me === undefined) return null;
  const { rider, devices } = record;
  const holdsReregister = me.holds('staff.device.reregister');
  const holdsRegister = me.holds('staff.device.register');

  function reload(): Promise<unknown> {
    setRevoking(false);
    return query.refetch();
  }

  return (
    <>
      {notice === undefined ? null : (
        <div className="staff-notice" ref={noticeBox} tabIndex={-1}>
          <Alert variant="success">
            <p>{notice}</p>
          </Alert>
        </div>
      )}

      <p className="staff-status">
        <StatusBadge status={rider.status} map={RIDER_STATUS_MAP} />{' '}
        <span>{deviceSentence(rider)}.</span>
      </p>

      <section className="staff-actions" aria-labelledby="rider-revoke">
        <h2 id="rider-revoke">Report a lost or stolen device</h2>
        {rider.has_active_device ? (
          <div>
            <p className="staff-action__text">
              Revoke the device at once. The rider’s session ends with it, and the handset can no
              longer sign in. No check of who is asking is made, so that a loss is never reported
              late. A new handset is registered afterwards, in person.
            </p>
            <div className="staff-action__buttons">
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
          </div>
        ) : (
          <p className="staff-action__text">This rider has no active device to revoke.</p>
        )}
      </section>

      <section className="staff-actions" aria-labelledby="rider-replace">
        <h2 id="rider-replace">Replace the handset</h2>
        {!holdsReregister ? (
          <p className="staff-action__text">
            Registering a replacement handset needs the permission staff.device.reregister, which
            your session does not hold.
          </p>
        ) : !mayBindDevice(rider.status) ? (
          <p className="staff-action__text">
            A replacement handset cannot be registered while this rider’s access has ended.
          </p>
        ) : devices.length === 0 ? (
          <p className="staff-action__text">
            This rider has held no device, so there is nothing to replace.{' '}
            {holdsRegister ? (
              <Link to={`/admin/riders/${id}/device/register`}>Register a first device.</Link>
            ) : null}
          </p>
        ) : (
          <FormPage>
            <p className="staff-action__text">
              Do this in person, once you have verified who the rider is. A code appears here; the
              rider scans it with the Melarc Rider app on the new handset, which makes its own key
              and asks for a new PIN. The old device then stops working. Nothing about the old
              device changes until the new handset is registered.
            </p>
            <ReplaceDevice id={id} record={record} query={query} />
          </FormPage>
        )}
      </section>

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
      <p className="staff-back">
        <Link to={`/admin/riders/${id}`}>Back to the rider</Link>
      </p>
      <PageHeader
        title={title}
        {...(query.data === undefined ? {} : { description: `For ${query.data.rider.full_name}.` })}
      />
      {query.status === 'success' ? (
        <Device id={id} record={query.data} query={query} />
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
 * The device of a rider (surfaces/ops-portal.md section 7, `/admin/riders/{id}/device`; S0.60b): **two actions, two keys**, and the page
 * names the permission each needs and never a role. **Revoke** is the report of a lost or stolen handset: a reason and a confirmation, no
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
