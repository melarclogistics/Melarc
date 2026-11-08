import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useParams } from 'react-router';

import { FormPage } from '../../../components/FormPage';
import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { Field } from '../../../components/ui/field/Field';
import { focusFirstInvalid } from '../../../components/ui/form/use-submission';
import { Input } from '../../../components/ui/input/Input';
import { Link } from '../../../components/ui/link/Link';
import { useApiClient } from '../../../platform/api/api-client';
import { useConfirmedCommand } from '../../../platform/api/use-confirmed-command';
import {
  requestOnePackageException,
  type OnePackageExceptionFields,
} from '../../../platform/pickup/pickup-commands';
import type { ApprovalView, PickupRequestView } from '../../../platform/pickup/pickup-shape';
import type { PickupRecord } from '../../../platform/pickup/use-pickup-queries';
import { copyFor, type Problem } from '../../../platform/problem/problem-copy';
import { formatInstant } from '../../../platform/time/format-time';
import {
  hasApprovedException,
  isSinglePackage,
  packagesText,
  PICKUP_STATE_MAP,
} from './pickup-presentation';
import { WithPickupRequest } from './WithPickupRequest';
import './pickup-pages.css';

const OPERATION = 'requestOnePackageException';

type FieldKey = 'note' | 'name' | 'phone' | 'address' | 'landmark';
type FieldErrors = Partial<Record<FieldKey, string>>;

/** The places the API names when it refuses the exception, and the field each is. */
const POINTERS: Readonly<Record<string, FieldKey>> = {
  '/note': 'note',
  '/recipient/name': 'name',
  '/recipient/phone': 'phone',
  '/recipient/location': 'address',
  '/recipient/location/address': 'address',
  '/recipient/location/landmark': 'landmark',
};

const WORDS: Readonly<Record<FieldKey, string>> = {
  note: 'Write a note saying why this single package should be collected.',
  name: 'Enter the recipient’s name.',
  phone: 'Enter the recipient’s phone number, with the country code.',
  address: 'Enter the delivery address.',
  landmark: 'The landmark was not accepted. Keep it to one line.',
};

interface Values {
  readonly note: string;
  readonly name: string;
  readonly phone: string;
  readonly address: string;
  readonly landmark: string;
}

const EMPTY: Values = { note: '', name: '', phone: '', address: '', landmark: '' };

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

/** What is wrong before anything is sent: the mandatory fields (§21.1) and lines that are not one line. */
function problemsWith(values: Values): FieldErrors {
  const found: FieldErrors = {};
  for (const key of ['note', 'name', 'phone', 'address'] as const) {
    if (values[key].trim() === '') found[key] = WORDS[key];
  }
  for (const key of ['note', 'name', 'phone', 'address', 'landmark'] as const) {
    if (found[key] === undefined && hasControlCharacter(values[key])) {
      found[key] = 'Keep it to one line.';
    }
  }
  return found;
}

/** The fields a refusal is about, from the places the API named and from its code. */
function refusedFields(problem: Problem | undefined): FieldErrors {
  if (problem === undefined) return {};
  const found: FieldErrors = {};
  if (problem.code === 'REASON_REQUIRED') found.note = WORDS.note;
  for (const violation of problem.violations ?? []) {
    const key = POINTERS[violation.pointer];
    if (key !== undefined && found[key] === undefined) found[key] = WORDS[key];
  }
  return found;
}

function Requested({ id }: { readonly id: string }) {
  const box = useRef<HTMLDivElement>(null);
  // The form that was here is gone: a keyboard user lands on what replaced it.
  useEffect(() => {
    box.current?.focus();
  }, []);
  return (
    <div className="pickup-booked" ref={box} tabIndex={-1}>
      <Alert variant="success">
        <h2 className="pickup-booked__heading">The exception is requested</h2>
        <p>
          It waits for a holder of <code>pickup.exception.approve</code> to decide it. The request
          stays pending until then, and is confirmed once the exception is approved.
        </p>
      </Alert>
      <div className="pickup-act__buttons">
        <ButtonLink to={`/pickup-requests/${id}`}>Back to the request</ButtonLink>
      </div>
    </div>
  );
}

function ExceptionForm({
  request,
  query,
  onRequested,
}: {
  readonly request: PickupRequestView;
  readonly query: UseQueryResult<PickupRecord>;
  readonly onRequested: () => void;
}) {
  const client = useApiClient();
  const [values, setValues] = useState<Values>(EMPTY);
  const [invalid, setInvalid] = useState<FieldErrors>({});
  const [attempts, setAttempts] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const command = useConfirmedCommand<OnePackageExceptionFields, ApprovalView>({
    send: (body) => requestOnePackageException(client, request.id, body),
    onDone: onRequested,
    // The operation takes no Idempotency-Key: sent again after a lost answer it could be a second request, so the way on is to read the request
    // again, which shows an exception that reached the server (`one_package_exception`).
    retryable: false,
    onReload: () => query.refetch(),
    operation: OPERATION,
  });
  const fromServer = command.phase === 'refused' ? refusedFields(command.problem) : {};
  const errorOf = (key: FieldKey) => {
    const text = invalid[key] ?? fromServer[key];
    return text === undefined ? {} : { error: text };
  };
  const belongsToAField = Object.keys(fromServer).length > 0;

  useEffect(() => {
    if (attempts > 0) focusFirstInvalid(form.current);
  }, [attempts]);
  useEffect(() => {
    if (command.phase === 'refused') focusFirstInvalid(form.current);
    if (command.phase === 'unknown' || command.phase === 'conflict') {
      form.current?.querySelector<HTMLElement>('[data-recovery]')?.focus();
    }
  }, [command.phase]);
  const recovering = command.phase === 'unknown' || command.phase === 'conflict';

  function change(patch: Partial<Values>, key: FieldKey): void {
    setValues((current) => ({ ...current, ...patch }));
    setInvalid((current) => ({ ...current, [key]: undefined }));
    command.dismiss();
  }

  function send(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (command.locked) return;
    const found = problemsWith(values);
    setInvalid(found);
    if (Object.keys(found).length > 0) {
      setAttempts((count) => count + 1);
      return;
    }
    const landmark = values.landmark.trim();
    void command.submit({
      note: values.note.trim(),
      recipient: {
        name: values.name.trim(),
        phone: values.phone.trim(),
        location: {
          address: values.address.trim(),
          ...(landmark === '' ? {} : { landmark }),
        },
      },
    });
  }

  const locked = command.locked;
  return (
    <form
      ref={form}
      noValidate
      aria-busy={command.phase === 'sending' ? true : undefined}
      onSubmit={send}
    >
      <p className="pickup-form-note">
        A single package is collected only by exception. The recipient’s details travel with it, and
        the delivery address makes the estimate exact. A holder of{' '}
        <code>pickup.exception.approve</code> decides it. Whoever asks for an exception cannot also
        approve it, unless they approve at the platform’s highest tier: the server checks this. The
        single-package pickup fee becomes due once the exception is approved.
      </p>
      {request.one_package_exception?.state === 'REJECTED' ? (
        <p className="pickup-form-note">
          An earlier exception for this request was refused. You can ask again.
        </p>
      ) : null}

      {command.phase === 'unknown' ? (
        <Alert variant="danger" announce>
          <p>{copyFor({ operation: OPERATION, context: 'unknown-outcome' })}</p>
        </Alert>
      ) : null}
      {(command.phase === 'refused' || command.phase === 'conflict') &&
      command.problem !== undefined &&
      !belongsToAField ? (
        <Alert variant="danger" announce>
          <p>{command.problem.message}</p>
          {command.problem.reference === undefined ? null : (
            <p>Reference: {command.problem.reference}</p>
          )}
        </Alert>
      ) : null}

      <Field
        label="Why this single package should be collected"
        required
        help="One line, kept with the exception."
        {...errorOf('note')}
      >
        <Input
          name="note"
          value={values.note}
          autoComplete="off"
          readOnly={locked}
          onChange={(event) => {
            change({ note: event.target.value }, 'note');
          }}
        />
      </Field>

      <section className="pickup-form-section" aria-labelledby="exception-recipient">
        <h2 id="exception-recipient">The recipient</h2>
        <Field label="Recipient’s name" required {...errorOf('name')}>
          <Input
            name="recipient-name"
            value={values.name}
            autoComplete="off"
            readOnly={locked}
            onChange={(event) => {
              change({ name: event.target.value }, 'name');
            }}
          />
        </Field>
        <Field
          label="Recipient’s phone"
          required
          help="Include the country code, for example +233 24 000 0000."
          {...errorOf('phone')}
        >
          <Input
            name="recipient-phone"
            value={values.phone}
            inputMode="tel"
            autoComplete="off"
            readOnly={locked}
            onChange={(event) => {
              change({ phone: event.target.value }, 'phone');
            }}
          />
        </Field>
        <Field label="Delivery address" required {...errorOf('address')}>
          <Input
            name="recipient-address"
            value={values.address}
            autoComplete="off"
            readOnly={locked}
            onChange={(event) => {
              change({ address: event.target.value }, 'address');
            }}
          />
        </Field>
        <Field
          label="Landmark"
          help="Optional. What people find the address by."
          {...errorOf('landmark')}
        >
          <Input
            name="recipient-landmark"
            value={values.landmark}
            autoComplete="off"
            readOnly={locked}
            onChange={(event) => {
              change({ landmark: event.target.value }, 'landmark');
            }}
          />
        </Field>
      </section>

      <div className="ui-form-page__actions">
        {recovering ? (
          <Button key="check" type="button" data-recovery onClick={command.checkRecord}>
            Check the request
          </Button>
        ) : (
          <>
            <Button key="submit" type="submit" loading={command.phase === 'sending'}>
              Request the exception
            </Button>
            <Link to={`/pickup-requests/${request.id}`}>Cancel</Link>
          </>
        )}
      </div>
    </form>
  );
}

/** Why the exception cannot be asked for this request as it stands, read from the record, or nothing when it can. */
function notAvailable(request: PickupRequestView): string | undefined {
  if (request.state !== 'PENDING') {
    return `A one-package exception is for a request that waits for confirmation. This request is ${PICKUP_STATE_MAP[
      request.state
    ].label.toLowerCase()}.`;
  }
  if (!isSinglePackage(request)) {
    return `A one-package exception is for a request of a single package. This one has ${packagesText(
      request,
    ).toLowerCase()}.`;
  }
  if (hasApprovedException(request)) {
    return 'The one-package exception of this request is already approved. It can be confirmed from its page.';
  }
  const exception = request.one_package_exception;
  if (exception?.state === 'REQUESTED') {
    return `The one-package exception of this request was requested on ${
      formatInstant(exception.requested_at) ?? 'an earlier day'
    }, and waits for a holder of pickup.exception.approve to approve it.`;
  }
  return undefined;
}

function Exception({
  record,
  query,
}: {
  readonly record: PickupRecord;
  readonly query: UseQueryResult<PickupRecord>;
}) {
  const [requested, setRequested] = useState(false);
  const { request } = record;
  if (requested) return <Requested id={request.id} />;
  const reason = notAvailable(request);
  if (reason !== undefined) {
    return (
      <>
        <p className="pickup-act__text">{reason}</p>
        <p>
          <Link to={`/pickup-requests/${request.id}`}>Back to the request</Link>
        </p>
      </>
    );
  }
  return (
    <FormPage>
      <ExceptionForm
        request={request}
        query={query}
        onRequested={() => {
          setRequested(true);
        }}
      />
    </FormPage>
  );
}

/**
 * Request a one-package exception (surfaces/ops-portal.md section 7, `/pickup-requests/{id}/exception`; S1.19): the maker's half of the exception
 * (`requestOnePackageException`), with the note and **the recipient's name, phone and delivery address, which become mandatory** (§21.1). It is
 * offered for a pending request of one package with no exception waiting or approved, and says why otherwise. The page names the permission
 * that decides it, `pickup.exception.approve`, and no role; the approval itself is made on `/approvals`. The act takes no `Idempotency-Key` and
 * no version, so a lost answer is resolved by reading the request again, which shows an exception that reached the server.
 */
export function PickupExceptionPage() {
  const { id = '' } = useParams();
  return (
    <WithPickupRequest
      id={id}
      heading={(request) => ({
        title: 'Request a one-package exception',
        ...(request === undefined ? {} : { description: `For ${request.code}.` }),
        documentTitle: 'Request a one-package exception',
      })}
      back={
        <p className="pickup-back">
          <Link to={`/pickup-requests/${id}`}>Back to the request</Link>
        </p>
      }
    >
      {(record, query) => <Exception record={record} query={query} />}
    </WithPickupRequest>
  );
}
