import { useEffect, useRef, useState, type SubmitEvent } from 'react';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { EmptyState } from '../../../components/ui/empty-state/EmptyState';
import { Field } from '../../../components/ui/field/Field';
import { ForbiddenState } from '../../../components/ui/forbidden-state/ForbiddenState';
import { focusFirstInvalid } from '../../../components/ui/form/use-submission';
import { Input } from '../../../components/ui/input/Input';
import { Link } from '../../../components/ui/link/Link';
import { PageHeader, type PageHeaderProps } from '../../../components/ui/page-header/PageHeader';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Select } from '../../../components/ui/select/Select';
import { TaskForm, TaskFormSection } from '../../../components/ui/templates/TaskForm';
import { useApiClient } from '../../../platform/api/api-client';
import { useConfirmedCommand } from '../../../platform/api/use-confirmed-command';
import { useActiveHub } from '../../../platform/hub/active-hub';
import { copyFor, type Problem } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { createStaffIdentity, type NewStaffProfile } from '../../../platform/staff/staff-commands';
import type { AssignableBundleView, StaffIdentityView } from '../../../platform/staff/staff-shape';
import { useAssignableBundles } from '../../../platform/staff/use-staff-queries';
import { useFocusFallenToHeading } from './WithProfile';
import './staff-pages.css';

const OPERATION = 'createStaffIdentity';
const BUNDLE_READ = 'permission.assignable_bundle.read';

/** The longest an email address can be (RFC 5321), and the longest a phone number can be written with the spaces people put in it. */
const EMAIL_LIMIT = 320;
const PHONE_LIMIT = 32;

type FieldKey = 'full_name' | 'work_email' | 'phone' | 'role_bundle_id' | 'primary_hub_id';

type FieldErrors = Partial<Record<FieldKey, string>>;

const POINTERS: Readonly<Record<string, FieldKey>> = {
  '/full_name': 'full_name',
  '/work_email': 'work_email',
  '/phone': 'phone',
  '/role_bundle_id': 'role_bundle_id',
  '/primary_hub_id': 'primary_hub_id',
};

const wordsFor = (context: FieldKey, code = 'VALIDATION_FAILED'): string =>
  copyFor({ operation: OPERATION, context, code }) ?? '';

/** E.164 as a person writes it: spaces, hyphens and brackets are allowed on the way in and not on the wire. */
const E164 = /^\+[1-9]\d{6,14}$/;
const phoneOf = (typed: string): string => typed.replace(/[\s\-().]/g, '');

interface Values {
  readonly fullName: string;
  readonly email: string;
  readonly phone: string;
  readonly roleId: string;
  readonly hubId: string;
}

/** What is wrong with the form before anything is sent. Only what the server would refuse for certain, in the words of the field. */
function problemsWith(values: Values): FieldErrors {
  const found: FieldErrors = {};
  if (values.fullName.trim() === '') found.full_name = wordsFor('full_name');
  if (!values.email.trim().includes('@')) found.work_email = wordsFor('work_email');
  if (values.phone.trim() !== '' && !E164.test(phoneOf(values.phone))) {
    found.phone = wordsFor('phone');
  }
  if (values.roleId === '') found.role_bundle_id = wordsFor('role_bundle_id');
  return found;
}

/** The fields a refusal is about, in the words of each field, from where the API said it was refused and from its code. */
function refusedFields(problem: Problem | undefined): FieldErrors {
  if (problem === undefined) return {};
  const found: FieldErrors = {};
  if (problem.code === 'WORK_EMAIL_IN_USE') {
    found.work_email = copyFor({ operation: OPERATION, code: 'WORK_EMAIL_IN_USE' }) ?? '';
  }
  if (problem.code === 'HUB_SCOPE_VIOLATION') {
    found.primary_hub_id = wordsFor('primary_hub_id', 'HUB_SCOPE_VIOLATION');
  }
  for (const violation of problem.violations ?? []) {
    const field = POINTERS[violation.pointer];
    if (field !== undefined && found[field] === undefined) found[field] = wordsFor(field);
  }
  return found;
}

/** The page's header: what the form is, with the way up to the staff list for a session that can read it (the task form draws it; every other state of the page draws it itself). */
type Header = Pick<PageHeaderProps, 'title' | 'description' | 'breadcrumb'>;

function CreateForm({
  header,
  bundles,
  onCreated,
}: {
  readonly header: Header;
  readonly bundles: readonly AssignableBundleView[];
  readonly onCreated: (identity: StaffIdentityView) => void;
}) {
  const client = useApiClient();
  const me = useSignedInSession();
  const hubs = me?.session.authorized_hubs ?? [];
  const activeHub = useActiveHub();
  // The page that waited for the roles drew a heading of its own; this one replaces it, and focus is put on the new one if the old one's has fallen.
  useFocusFallenToHeading();
  const [values, setValues] = useState<Values>({
    fullName: '',
    email: '',
    phone: '',
    roleId: '',
    // A person who acts in one hub places a profile in it; anyone else starts with the hub they chose in the switcher of the top bar, and chooses when
    // they chose All hubs.
    hubId: hubs.length === 1 ? (hubs[0]?.id ?? '') : (activeHub ?? ''),
  });
  const [invalid, setInvalid] = useState<FieldErrors>({});
  const [attempts, setAttempts] = useState(0);
  const form = useRef<HTMLFormElement>(null);

  const command = useConfirmedCommand<NewStaffProfile, StaffIdentityView>({
    send: (body, key) => createStaffIdentity(client, body, key),
    onDone: onCreated,
    // Nothing to read again: the profile is not one the maker may be able to look up. Starting again just frees the form.
    retryable: true,
    operation: OPERATION,
  });

  const fromServer = command.phase === 'refused' ? refusedFields(command.problem) : {};
  const errorOf = (field: FieldKey): string | undefined => invalid[field] ?? fromServer[field];
  const belongsToAField = Object.keys(fromServer).length > 0;

  useEffect(() => {
    if (attempts > 0) focusFirstInvalid(form.current);
  }, [attempts]);
  useEffect(() => {
    if (command.phase === 'refused') focusFirstInvalid(form.current);
    if (command.phase === 'unknown') {
      form.current?.querySelector<HTMLElement>('[data-recovery]')?.focus();
    }
  }, [command.phase]);

  const chosen = bundles.find((bundle) => bundle.id === values.roleId);
  const locked = command.locked;

  function change(patch: Partial<Values>, field: FieldKey): void {
    setValues((current) => ({ ...current, ...patch }));
    setInvalid((current) => ({ ...current, [field]: undefined }));
    command.dismiss();
  }

  function send(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (locked) return;
    const found = problemsWith(values);
    setInvalid(found);
    if (Object.keys(found).length > 0) {
      setAttempts((count) => count + 1);
      return;
    }
    const phone = phoneOf(values.phone);
    void command.submit({
      work_email: values.email.trim(),
      full_name: values.fullName.trim(),
      ...(phone === '' ? {} : { phone }),
      role_bundle_id: values.roleId,
      ...(values.hubId === '' ? {} : { primary_hub_id: values.hubId }),
    });
  }

  const reason = (field: FieldKey) => {
    const text = errorOf(field);
    return text === undefined ? {} : { error: text };
  };

  return (
    <TaskForm
      header={header}
      formRef={form}
      onSubmit={send}
      busy={command.phase === 'sending'}
      alerts={
        <>
          {command.phase === 'unknown' ? (
            <Alert variant="danger" announce>
              <p>{copyFor({ operation: OPERATION, context: 'unknown-outcome' })}</p>
              <p>
                Starting again sends the profile as a new request: if the first one went through,
                the address will be reported as already used.
              </p>
            </Alert>
          ) : null}
          {command.phase === 'refused' && command.problem !== undefined && !belongsToAField ? (
            <Alert variant="danger" announce>
              <p>{command.problem.message}</p>
              {command.problem.reference === undefined ? null : (
                <p>Reference: {command.problem.reference}</p>
              )}
            </Alert>
          ) : null}
        </>
      }
      actions={
        command.phase === 'unknown' ? (
          <>
            {command.canRetry ? (
              <Button
                key="retry"
                type="button"
                data-recovery
                onClick={() => {
                  void command.retry();
                }}
              >
                Try again
              </Button>
            ) : null}
            <Button key="again" type="button" variant="secondary" onClick={command.checkRecord}>
              Start again
            </Button>
          </>
        ) : (
          <>
            <Button key="submit" type="submit" loading={command.phase === 'sending'}>
              Create profile
            </Button>
            <Link to={me?.holds('staff.read') === true ? '/admin/staff' : '/'}>Cancel</Link>
          </>
        )
      }
    >
      <TaskFormSection title="The person">
        <Field label="Full name" required {...reason('full_name')}>
          <Input
            name="full_name"
            value={values.fullName}
            autoComplete="off"
            readOnly={locked}
            onChange={(event) => {
              change({ fullName: event.target.value }, 'full_name');
            }}
          />
        </Field>
        <Field
          label="Work email"
          required
          help="The setup link is sent to this address once the profile is approved."
          {...reason('work_email')}
        >
          <Input
            name="work_email"
            value={values.email}
            maxLength={EMAIL_LIMIT}
            inputMode="email"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            readOnly={locked}
            onChange={(event) => {
              change({ email: event.target.value }, 'work_email');
            }}
          />
        </Field>
        <Field
          label="Phone"
          help="Optional. Include the country code, for example +233 24 000 0000."
          {...reason('phone')}
        >
          <Input
            name="phone"
            value={values.phone}
            maxLength={PHONE_LIMIT}
            inputMode="tel"
            autoComplete="off"
            readOnly={locked}
            onChange={(event) => {
              change({ phone: event.target.value }, 'phone');
            }}
          />
        </Field>
      </TaskFormSection>

      <TaskFormSection title="Role and hub">
        <Field
          label="Role"
          required
          {...(chosen?.requires_platform_admin_approval === true
            ? { help: 'A Platform Admin has to approve a profile with this role.' }
            : {})}
          {...reason('role_bundle_id')}
        >
          <Select
            name="role_bundle_id"
            value={values.roleId}
            disabled={locked}
            onChange={(event) => {
              change({ roleId: event.target.value }, 'role_bundle_id');
            }}
          >
            <option value="">Choose a role</option>
            {bundles.map((bundle) => (
              <option key={bundle.id} value={bundle.id}>
                {bundle.requires_platform_admin_approval
                  ? `${bundle.name} (needs a Platform Admin to approve)`
                  : bundle.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Primary hub"
          help={
            hubs.length === 0
              ? 'Your session lists no hub to choose from, so this profile is created without one.'
              : 'Optional. Where this person works from.'
          }
          {...reason('primary_hub_id')}
        >
          <Select
            name="primary_hub_id"
            value={values.hubId}
            disabled={locked || hubs.length === 0}
            onChange={(event) => {
              change({ hubId: event.target.value }, 'primary_hub_id');
            }}
          >
            <option value="">No primary hub</option>
            {hubs.map((hub) => (
              <option key={hub.id} value={hub.id}>
                {hub.display_name}
              </option>
            ))}
          </Select>
        </Field>
      </TaskFormSection>
    </TaskForm>
  );
}

function Created({
  identity,
  onAnother,
}: {
  readonly identity: StaffIdentityView;
  readonly onAnother: () => void;
}) {
  const me = useSignedInSession();
  const box = useRef<HTMLDivElement>(null);
  // The form that was here is gone: a keyboard user lands on what replaced it.
  useEffect(() => {
    box.current?.focus();
  }, []);
  const name = identity.full_name;
  return (
    <div className="staff-created" ref={box} tabIndex={-1}>
      <div className="staff-created__alert">
        <Alert variant="success">
          <h2 className="staff-created__heading">Profile created</h2>
          <p>{name} is waiting for approval.</p>
        </Alert>
      </div>
      <p className="staff-action__text">
        {name} cannot sign in until the profile is approved. A different approver is needed, unless
        you are a Platform Admin.
      </p>
      <div className="staff-action__buttons">
        {me?.holds('staff.read') === true ? (
          <ButtonLink to={`/admin/staff/${identity.id}`}>View the profile</ButtonLink>
        ) : (
          <ButtonLink to="/">Go to the overview</ButtonLink>
        )}
        <Button type="button" variant="secondary" onClick={onAnother}>
          Add another
        </Button>
      </div>
    </div>
  );
}

/**
 * Add a staff profile (surfaces/ops-portal.md section 7, `/admin/staff/new`; redesign step R7b): the maker's half of the maker-checker rule. It is drawn by the task form
 * template (COMPONENT_PATTERNS, *TaskForm*): the person, then the role and the hub, in two sections; the send and the way out are the form's actions. The role is chosen
 * from `listAssignableStaffRoleBundles` by name and the page carries no list of its own; a form that cannot name a role is not shown, because
 * it could not be sent. There is no password, no status and no creator: the person sets their own password from a link once the profile
 * is approved (by a different person, or by the maker when the maker is a Platform Admin), and the server records the caller as the maker.
 *
 * Creating takes an `Idempotency-Key`, so a lost answer is tried again under the same key and cannot make a second profile.
 */
export function StaffCreatePage() {
  const me = useSignedInSession();
  const canReadRoles = me?.holds(BUNDLE_READ) === true;
  const bundles = useAssignableBundles(canReadRoles);
  // The form is gone once a profile is created, so "Add another" draws a new one: its own state, and its own key.
  const [created, setCreated] = useState<StaffIdentityView | undefined>(undefined);

  if (me === undefined) return null;

  const header: Header = {
    title: 'Add a staff profile',
    description: 'The profile has to be approved before it can be used.',
    // The way up is offered to a session that can read the list it leads to.
    ...(me.holds('staff.read') ? { breadcrumb: [{ label: 'Staff', to: '/admin/staff' }] } : {}),
  };

  if (created !== undefined) {
    return (
      <>
        <title>Add a staff profile · Melarc Ops Portal</title>
        <PageHeader {...header} />
        <Created
          identity={created}
          onAnother={() => {
            setCreated(undefined);
          }}
        />
      </>
    );
  }

  // The form is drawn once the roles are in, and it draws the heading itself; until then, and when they cannot be had, the heading stands with the reason.
  if (canReadRoles && bundles.status === 'success' && bundles.data.length > 0) {
    return (
      <>
        <title>Add a staff profile · Melarc Ops Portal</title>
        <CreateForm header={header} bundles={bundles.data} onCreated={setCreated} />
      </>
    );
  }

  return (
    <>
      <title>Add a staff profile · Melarc Ops Portal</title>
      <PageHeader {...header} />
      {canReadRoles ? (
        <ReadState<AssignableBundleView[]>
          query={bundles}
          isEmpty={(data) => data.length === 0}
          empty={
            <EmptyState kind="none" heading="There are no roles to choose from">
              A profile needs a role, and none can be chosen right now. Ask an administrator.
            </EmptyState>
          }
          loadingLabel="Loading the roles…"
          permission={BUNDLE_READ}
          operation="listAssignableStaffRoleBundles"
        >
          {() => null}
        </ReadState>
      ) : (
        <ForbiddenState kind="permission-missing" permission={BUNDLE_READ} />
      )}
    </>
  );
}
