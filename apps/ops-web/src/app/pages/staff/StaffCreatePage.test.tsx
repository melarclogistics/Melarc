import { act, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { renderApp } from '../../../test-support/render-app';
import {
  bundlesAnswer,
  KEYS,
  refusal,
  sessionWith,
  staffApi,
} from '../../../test-support/staff-api';
import {
  BUNDLE_ID,
  HUB_ID,
  PRIVILEGED_BUNDLE_ID,
  STAFF_ID,
  staffIdentityFixture,
} from '../../../test-support/staff-fixture';
import { wcagViolations } from '../../../test-support/wcag';

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const BUNDLES = 'GET /staff-role-bundles/assignable';
const CREATE = 'POST /staff-identities';
const DIAGNOSTIC = /Diagnostic text that must never reach a screen/;
const SECOND_HUB = '6c7d8e9f-0a12-4b3c-9d4e-5f6a7b8c9d0e';

const created = staffIdentityFixture();

function open(
  keys: readonly string[] = KEYS.approver,
  handlers: Record<string, () => Response | Promise<Response>> = {},
  hubs = [{ id: HUB_ID, display_name: 'Accra Central' }],
) {
  api = installFakeApi(
    staffApi(sessionWith(keys, { authorized_hubs: hubs }), {
      [BUNDLES]: bundlesAnswer,
      [CREATE]: () => json(200, created, { ETag: '"v1"' }),
      ...handlers,
    }),
  );
  return renderApp('/admin/staff/new');
}

const field = (name: string | RegExp) => screen.findByRole('textbox', { name });
const role = () => screen.findByRole('combobox', { name: /Role/ });
const submit = () => screen.getByRole('button', { name: 'Create profile' });
const creates = () => api.requests.filter((request) => request.method === 'POST');

/** Fills the form the way a maker would, and leaves the submit to the test. */
async function fill(view: { user: UserEvent }, overrides: Record<string, string> = {}) {
  const values = {
    name: 'Kofi Boateng',
    email: 'kofi.boateng@example.test',
    phone: '',
    role: BUNDLE_ID,
    ...overrides,
  };
  await view.user.type(await field(/Full name/), values.name);
  await view.user.type(await field(/Work email/), values.email);
  if (values.phone !== '') await view.user.type(await field(/Phone/), values.phone);
  if (values.role !== '') await view.user.selectOptions(await role(), values.role);
}

describe('the staff creation form: what it asks for', () => {
  it('names the page and says what it is for', async () => {
    open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Add a staff profile' }),
    ).toBeVisible();
    expect(document.title).toBe('Add a staff profile · Melarc Ops Portal');
    expect(screen.getByText('The profile has to be approved before it can be used.')).toBeVisible();
  });

  // Break caught (ops-portal.md section 7): a form with a password or an authenticator field, which the schema would refuse and the
  // maker must never set. The person sets their own.
  it('asks for a name, an email address, a phone number, a role and a hub, and for nothing about a credential', async () => {
    open();
    await field(/Full name/);

    expect(screen.getByRole('textbox', { name: /Work email/ })).toBeVisible();
    expect(screen.getByRole('textbox', { name: /Phone/ })).toBeVisible();
    expect(screen.getByRole('combobox', { name: /Role/ })).toBeVisible();
    expect(screen.getByRole('combobox', { name: /Primary hub/ })).toBeVisible();
    expect(screen.queryByLabelText(/password|authenticator|secret|status/i)).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('marks what is needed as required and what is not as optional by leaving it unmarked', async () => {
    open();

    expect(await screen.findByRole('textbox', { name: 'Full name (required)' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Work email (required)' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Role (required)' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Phone' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Primary hub' })).toBeVisible();
  });

  it('does not let the browser guess what an email address or a name is', async () => {
    open();

    expect(await field(/Work email/)).toHaveAttribute('autocomplete', 'off');
    expect(screen.getByRole('textbox', { name: /Full name/ })).toHaveAttribute(
      'autocomplete',
      'off',
    );
  });
});

describe('the staff creation form: the roles', () => {
  // Break caught: a role list of the page's own (ops-portal.md section 7: "it carries no bundle list of its own").
  it('offers exactly the roles the server returns, by name', async () => {
    open();

    const select = await role();
    const options = within(select).getAllByRole('option');

    expect(options.map((option) => option.textContent)).toEqual([
      'Choose a role',
      'Ops Staff',
      'Senior Ops (needs a Platform Admin to approve)',
    ]);
    expect(
      api.requests.some((request) => request.url.endsWith('/staff-role-bundles/assignable')),
    ).toBe(true);
  });

  it('says again, under the field, when the chosen role needs a Platform Admin', async () => {
    const view = open();
    const select = await role();

    expect(
      screen.queryByText('A Platform Admin has to approve a profile with this role.'),
    ).toBeNull();
    await view.user.selectOptions(select, PRIVILEGED_BUNDLE_ID);

    expect(
      screen.getByText('A Platform Admin has to approve a profile with this role.'),
    ).toBeVisible();
    await view.user.selectOptions(select, BUNDLE_ID);
    expect(
      screen.queryByText('A Platform Admin has to approve a profile with this role.'),
    ).toBeNull();
  });

  // Break caught: a role shown with the permissions behind it. The read returns none, and the screen invents none.
  it('shows no permission, count or holder of a role', async () => {
    open();
    await role();

    expect(document.body.textContent).not.toMatch(/permission|holders?\b/i);
  });

  // Break caught: a form that can be sent with no role because the read failed.
  it('asks nothing of the server and shows no form for a session that does not list the key to read roles', async () => {
    open(['staff.identity.create']);

    expect(await screen.findByText('permission.assignable_bundle.read')).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(api.requests).toHaveLength(1);
  });

  it('names the key and shows no form when the server refuses the read', async () => {
    open(KEYS.approver, { [BUNDLES]: () => refusal(403, 'PERMISSION_DENIED') });

    expect(await screen.findByText('permission.assignable_bundle.read')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create profile' })).toBeNull();
  });

  it('says the roles could not be loaded, offers a retry and shows no form', async () => {
    let answers = 0;
    const view = open(KEYS.approver, {
      [BUNDLES]: () => {
        answers += 1;
        return answers === 1 ? refusal(500, 'INTERNAL_ERROR') : bundlesAnswer();
      },
    });

    expect(
      await screen.findByText('The roles could not be loaded, so a profile cannot be created now.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create profile' })).toBeNull();
    await view.user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('button', { name: 'Create profile' })).toBeVisible();
  });

  it('says there is nothing to choose when the list is empty, and shows no form', async () => {
    open(KEYS.approver, { [BUNDLES]: () => json(200, { items: [] }) });

    expect(
      await screen.findByRole('heading', { name: 'There are no roles to choose from' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create profile' })).toBeNull();
  });
});

describe('the staff creation form: the hub', () => {
  it('chooses the hub for a person who acts in one', async () => {
    open();

    const select = await screen.findByRole('combobox', { name: 'Primary hub' });

    expect(select).toHaveValue(HUB_ID);
    expect(within(select).getByRole('option', { name: 'Accra Central' })).toBeVisible();
  });

  it('asks a person who acts in several to choose, and leaves "No primary hub" available', async () => {
    open(KEYS.approver, {}, [
      { id: HUB_ID, display_name: 'Accra Central' },
      { id: SECOND_HUB, display_name: 'Tema' },
    ]);

    const select = await screen.findByRole('combobox', { name: 'Primary hub' });

    expect(select).toHaveValue('');
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['No primary hub', 'Accra Central', 'Tema']);
  });

  // Break caught: a choice that cannot be made drawn as if it could. A Platform Admin's session lists no hub (the reach that covers every
  // hub is held by grant, not listed), so the field has nothing to offer: it says so and the profile is made without a hub.
  it('says why the hub cannot be chosen when the session lists none, and still makes the profile', async () => {
    open(KEYS.approver, {}, []);

    const select = await screen.findByRole('combobox', { name: 'Primary hub' });

    expect(select).toBeDisabled();
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['No primary hub']);
    expect(
      screen.getByText(
        'Your session lists no hub to choose from, so this profile is created without one.',
      ),
    ).toBeVisible();
    expect(screen.queryByText('Optional. Where this person works from.')).toBeNull();
  });

  it('keeps the usual help when a hub can be chosen', async () => {
    open();

    await screen.findByRole('combobox', { name: 'Primary hub' });

    expect(screen.getByText('Optional. Where this person works from.')).toBeVisible();
  });

  // Break caught: an id shown where a name was owed.
  it('never shows a hub’s id', async () => {
    open();
    await screen.findByRole('combobox', { name: 'Primary hub' });

    expect(document.body.textContent).not.toContain(HUB_ID);
  });
});

describe('the staff creation form: what is checked before anything is sent', () => {
  it('asks for what is missing, names each field’s problem, moves focus to the first, and sends nothing', async () => {
    const view = open();
    await field(/Full name/);

    await view.user.click(submit());

    const name = screen.getByRole('textbox', { name: /Full name/ });
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription('Enter the person’s full name.');
    expect(name).toHaveFocus();
    expect(screen.getByRole('textbox', { name: /Work email/ })).toHaveAccessibleDescription(
      /Enter an email address, for example name@example\.com\./,
    );
    expect(screen.getByRole('combobox', { name: /Role/ })).toHaveAccessibleDescription(
      'Choose a role from the list.',
    );
    expect(creates()).toHaveLength(0);
  });

  it('does not take spaces for a name', async () => {
    const view = open();
    await view.user.type(await field(/Full name/), '    ');

    await view.user.click(submit());

    expect(screen.getByRole('textbox', { name: /Full name/ })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  // Break caught: an email address with no "@" sent, which the server would refuse after the round trip.
  it('asks for an email address that has an @', async () => {
    const view = open();
    await fill(view, { email: 'kofi.boateng.example.test' });

    await view.user.click(submit());

    expect(screen.getByRole('textbox', { name: /Work email/ })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(creates()).toHaveLength(0);
  });

  it.each([
    ['letters', 'abc'],
    ['no country code', '0240000000'],
    ['too few digits', '+23324'],
    ['too many digits', '+2332400000000000'],
    ['a plus in the middle', '+233+240000000'],
  ])('refuses a phone number with %s', async (_label, phone) => {
    const view = open();
    await fill(view, { phone });

    await view.user.click(submit());

    expect(screen.getByRole('textbox', { name: /Phone/ })).toHaveAccessibleDescription(
      /Enter the number with its country code, for example \+233 24 000 0000\./,
    );
    expect(creates()).toHaveLength(0);
  });

  // Break caught: the message repeating what was typed.
  it('does not repeat a value in a message', async () => {
    const view = open();
    await fill(view, { phone: 'not-a-number-123' });

    await view.user.click(submit());

    expect(screen.getByRole('textbox', { name: /Phone/ })).toHaveAccessibleDescription(
      expect.not.stringContaining('not-a-number'),
    );
  });

  it('takes a problem off a field when the person starts to put it right', async () => {
    const view = open();
    await field(/Full name/);
    await view.user.click(submit());

    await view.user.type(screen.getByRole('textbox', { name: /Full name/ }), 'K');

    expect(screen.getByRole('textbox', { name: /Full name/ })).not.toHaveAttribute('aria-invalid');
  });

  it('limits what can be typed to what the server accepts', async () => {
    open();

    expect(await field(/Work email/)).toHaveAttribute('maxlength', '320');
    expect(screen.getByRole('textbox', { name: /Phone/ })).toHaveAttribute('maxlength', '32');
  });
});

describe('the staff creation form: what is sent', () => {
  it('sends the profile with a key, and nothing the schema does not have', async () => {
    const view = open();
    await fill(view, { phone: '+233 24 000 0000' });
    await view.user.selectOptions(await role(), BUNDLE_ID);

    await view.user.click(submit());

    await screen.findByRole('heading', { name: 'Profile created' });
    const [request] = creates();
    expect(new URL(request?.url ?? 'http://x').pathname).toBe('/api/v1/staff-identities');
    expect(request?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(request?.headers.has('If-Match')).toBe(false);
    const body: unknown = await request?.json();
    expect(body).toEqual({
      work_email: 'kofi.boateng@example.test',
      full_name: 'Kofi Boateng',
      phone: '+233240000000',
      role_bundle_id: BUNDLE_ID,
      primary_hub_id: HUB_ID,
    });
  });

  // Break caught: a status or a creator set by the page: the schema has neither, and the maker is the caller.
  it('never sends a status, a creator or a credential', async () => {
    const view = open();
    await fill(view);

    await view.user.click(submit());
    await screen.findByRole('heading', { name: 'Profile created' });

    const body = (await creates()[0]?.json()) as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual([
      'full_name',
      'primary_hub_id',
      'role_bundle_id',
      'work_email',
    ]);
  });

  it('sends no phone and no hub when the maker left them out', async () => {
    const view = open(KEYS.approver, {}, [
      { id: HUB_ID, display_name: 'Accra Central' },
      { id: SECOND_HUB, display_name: 'Tema' },
    ]);
    await fill(view);

    await view.user.click(submit());
    await screen.findByRole('heading', { name: 'Profile created' });

    const body = (await creates()[0]?.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('phone');
    expect(body).not.toHaveProperty('primary_hub_id');
  });

  // Break caught: spaces around a name or an address sent as part of it.
  it('sends the name and the address without the spaces around them', async () => {
    const view = open();
    await fill(view, { name: '  Kofi Boateng  ', email: '  kofi.boateng@example.test  ' });

    await view.user.click(submit());
    await screen.findByRole('heading', { name: 'Profile created' });

    expect(await creates()[0]?.json()).toMatchObject({
      full_name: 'Kofi Boateng',
      work_email: 'kofi.boateng@example.test',
    });
  });

  // Break caught: a second profile made by a second click.
  it('sends once however many times the button is pressed while it is under way', async () => {
    let finish: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const view = open(KEYS.approver, {
      [CREATE]: async () => {
        await held;
        return json(200, created, { ETag: '"v1"' });
      },
    });
    await fill(view);

    await view.user.click(submit());
    await waitFor(() => {
      expect(submit()).toHaveAttribute('aria-busy', 'true');
    });
    await view.user.click(submit());
    await view.user.keyboard('{Enter}');
    expect(creates()).toHaveLength(1);
    expect(screen.getByRole('textbox', { name: /Full name/ })).toHaveAttribute('readonly');

    await act(async () => {
      finish();
      await held;
    });
    await screen.findByRole('heading', { name: 'Profile created' });
  });
});

describe('the staff creation form: when the profile is created', () => {
  // The page cannot tell a Platform Admin (who approves what they made) from another maker (who needs a different approver), so it says both.
  it('says the profile is waiting for approval, and that a different approver is needed unless the maker is a Platform Admin', async () => {
    const view = open();
    await fill(view);

    await view.user.click(submit());

    expect(await screen.findByRole('heading', { name: 'Profile created' })).toBeVisible();
    expect(screen.getByText(/Kofi Boateng is waiting for approval\./)).toBeVisible();
    expect(
      screen.getByText(
        'Kofi Boateng cannot sign in until the profile is approved. A different approver is needed, unless you are a Platform Admin.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create profile' })).toBeNull();
  });

  // Break caught: the form still on the page after a success, where a second press would make a second profile.
  it('replaces the form, and moves focus to the success so a keyboard user lands on it', async () => {
    const view = open();
    await fill(view);

    await view.user.click(submit());

    const done = await screen.findByRole('heading', { name: 'Profile created' });
    expect(screen.queryByRole('textbox')).toBeNull();
    await waitFor(() => {
      expect(done.closest('[tabindex="-1"]')).toHaveFocus();
    });
  });

  it('shows the name the server recorded and not the one that was typed', async () => {
    const view = open(KEYS.approver, {
      [CREATE]: () =>
        json(200, staffIdentityFixture({ full_name: 'Kofi A. Boateng' }), { ETag: '"v1"' }),
    });
    await fill(view);

    await view.user.click(submit());

    expect(await screen.findByText(/Kofi A\. Boateng is waiting for approval\./)).toBeVisible();
  });

  it('offers the profile to a person who can read staff, and the overview to one who cannot', async () => {
    const reader = open();
    await fill(reader);
    await reader.user.click(submit());
    expect(await screen.findByRole('link', { name: 'View the profile' })).toHaveAttribute(
      'href',
      `/admin/staff/${STAFF_ID}`,
    );
    reader.unmount();
    api.restore();

    const maker = open(KEYS.maker);
    await fill(maker);
    await maker.user.click(submit());
    await screen.findByRole('heading', { name: 'Profile created' });
    expect(screen.queryByRole('link', { name: 'View the profile' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Go to the overview' })).toHaveAttribute('href', '/');
  });

  it('starts a new profile from "Add another", with an empty form and a key of its own', async () => {
    const view = open();
    await fill(view);
    await view.user.click(submit());
    await view.user.click(await screen.findByRole('button', { name: 'Add another' }));

    expect(await screen.findByRole('textbox', { name: /Full name/ })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: /Work email/ })).toHaveValue('');
    await fill(view, { email: 'ama.mensah@example.test', name: 'Ama Mensah' });
    await view.user.click(submit());

    await screen.findByRole('heading', { name: 'Profile created' });
    expect(creates()).toHaveLength(2);
    expect(creates()[1]?.headers.get('Idempotency-Key')).not.toBe(
      creates()[0]?.headers.get('Idempotency-Key'),
    );
  });
});

describe('the staff creation form: a refusal', () => {
  // Break caught (ops-portal.md section 7): a duplicate address told in the server's words, or in a banner far from the field.
  it('puts a duplicate address on the address, keeps what was typed and moves focus there', async () => {
    const view = open(KEYS.approver, { [CREATE]: () => refusal(409, 'WORK_EMAIL_IN_USE') });
    await fill(view, { phone: '+233240000000' });

    await view.user.click(submit());

    const email = await screen.findByRole('textbox', { name: /Work email/ });
    await waitFor(() => {
      expect(email).toHaveAttribute('aria-invalid', 'true');
    });
    expect(email).toHaveAccessibleDescription(/A profile with this email address already exists\./);
    expect(email).toHaveFocus();
    expect(email).toHaveValue('kofi.boateng@example.test');
    expect(screen.getByRole('textbox', { name: /Full name/ })).toHaveValue('Kofi Boateng');
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  it('puts a hub the maker may not use on the hub, in the words of the specification', async () => {
    const view = open(KEYS.approver, { [CREATE]: () => refusal(403, 'HUB_SCOPE_VIOLATION') });
    await fill(view);

    await view.user.click(submit());

    const hub = await screen.findByRole('combobox', { name: 'Primary hub' });
    await waitFor(() => {
      expect(hub).toHaveAttribute('aria-invalid', 'true');
    });
    expect(hub).toHaveAccessibleDescription(
      /You cannot place a profile in that hub\. Choose one of your hubs\./,
    );
  });

  it('puts each field the server refused on that field, by where it says it was refused', async () => {
    const view = open(KEYS.approver, {
      [CREATE]: () =>
        refusal(400, 'VALIDATION_FAILED', {
          violations: [
            { in: 'body', pointer: '/work_email', rule: 'format' },
            { in: 'body', pointer: '/phone', rule: 'pattern' },
          ],
        }),
    });
    await fill(view, { phone: '+233240000000' });

    await view.user.click(submit());

    const email = await screen.findByRole('textbox', { name: /Work email/ });
    await waitFor(() => {
      expect(email).toHaveAttribute('aria-invalid', 'true');
    });
    expect(screen.getByRole('textbox', { name: /Phone/ })).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveFocus();
  });

  it('says what happened above the form when the refusal belongs to no field, and sends a new command next time', async () => {
    let attempts = 0;
    const view = open(KEYS.approver, {
      [CREATE]: () => {
        attempts += 1;
        return attempts === 1
          ? refusal(403, 'PERMISSION_DENIED')
          : json(200, created, { ETag: '"v1"' });
      },
    });
    await fill(view);

    await view.user.click(submit());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your session does not hold the permission to create profiles (staff.identity.create).',
    );
    expect(screen.getByText(/Reference: req-test-1/)).toBeVisible();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    await view.user.click(submit());
    await screen.findByRole('heading', { name: 'Profile created' });
    expect(creates()[1]?.headers.get('Idempotency-Key')).not.toBe(
      creates()[0]?.headers.get('Idempotency-Key'),
    );
  });

  // Break caught: an answer that is not a profile taken for one, which would tell a maker a profile exists when it may not.
  it('treats an answer that is not a profile as an outcome nobody knows', async () => {
    const view = open(KEYS.approver, { [CREATE]: () => json(200, { surprise: true }) });
    await fill(view);

    await view.user.click(submit());

    expect(
      await screen.findByText(/could not confirm whether the profile was created/),
    ).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Profile created' })).toBeNull();
  });
});

describe('the staff creation form: an outcome nobody knows', () => {
  const lost = () => Promise.reject(new TypeError('Failed to fetch'));

  // Break caught: the heart of the workflow. The answer was lost, so the profile may exist. The form says so, keeps everything and does not
  // claim either result.
  it('says the profile may have been created, locks the form and offers to try again', async () => {
    const view = open(KEYS.approver, { [CREATE]: lost });
    await fill(view);

    await view.user.click(submit());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not confirm whether the profile was created. You can try again: if it was already created, it is not created twice.',
    );
    expect(screen.getByRole('textbox', { name: /Full name/ })).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Profile created' })).toBeNull();
    expect(document.body.textContent).not.toContain('Failed to fetch');
  });

  it('tries again with the same profile and the same key, and shows the success when it is replayed', async () => {
    let attempts = 0;
    const view = open(KEYS.approver, {
      [CREATE]: () => {
        attempts += 1;
        return attempts === 1 ? lost() : json(200, created, { ETag: '"v1"' });
      },
    });
    await fill(view);
    await view.user.click(submit());

    await view.user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { name: 'Profile created' })).toBeVisible();
    expect(creates()).toHaveLength(2);
    expect(creates()[1]?.headers.get('Idempotency-Key')).toBe(
      creates()[0]?.headers.get('Idempotency-Key'),
    );
    expect(await creates()[1]?.json()).toEqual(await creates()[0]?.json());
  });

  it('says what starting again means, and lets the person do it with what they typed and a key of its own', async () => {
    let attempts = 0;
    const view = open(KEYS.approver, {
      [CREATE]: () => {
        attempts += 1;
        return attempts === 1 ? lost() : refusal(409, 'WORK_EMAIL_IN_USE');
      },
    });
    await fill(view);
    await view.user.click(submit());
    expect(
      await screen.findByText(
        /Starting again sends the profile as a new request: if the first one went through, the address will be reported as already used\./,
      ),
    ).toBeVisible();

    await view.user.click(screen.getByRole('button', { name: 'Start again' }));

    expect(screen.getByRole('textbox', { name: /Full name/ })).not.toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: /Full name/ })).toHaveValue('Kofi Boateng');
    await view.user.click(submit());
    await waitFor(() => {
      expect(creates()).toHaveLength(2);
    });
    expect(creates()[1]?.headers.get('Idempotency-Key')).not.toBe(
      creates()[0]?.headers.get('Idempotency-Key'),
    );
  });
});

describe('the staff creation form: the session', () => {
  // Break caught: a profile reported as created for a person who has gone.
  it('shows nothing when the session ended while the profile was being created', async () => {
    let finish: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    api = installFakeApi(
      staffApi(sessionWith(KEYS.approver), {
        [BUNDLES]: bundlesAnswer,
        [CREATE]: async () => {
          await held;
          return json(200, created, { ETag: '"v1"' });
        },
        'DELETE /auth/session': () => new Response(null, { status: 204 }),
      }),
    );
    const view = renderApp('/admin/staff/new');
    await fill(view);
    await view.user.click(submit());
    await waitFor(() => {
      expect(creates()).toHaveLength(1);
    });

    await view.user.click(screen.getByRole('button', { name: 'Sign out' }));
    await act(async () => {
      finish();
      await held;
    });

    expect(screen.queryByRole('heading', { name: 'Profile created' })).toBeNull();
  });
});

describeInterfaceStates('The staff creation form', {
  loading: {
    test: async () => {
      open(KEYS.approver, { [BUNDLES]: () => new Promise<Response>(() => undefined) });

      expect(await screen.findByText('Loading the roles…')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Create profile' })).toBeNull();
    },
  },
  empty: {
    test: async () => {
      open(KEYS.approver, { [BUNDLES]: () => json(200, { items: [] }) });

      expect(
        await screen.findByRole('heading', { name: 'There are no roles to choose from' }),
      ).toBeVisible();
    },
  },
  'validation error': {
    test: async () => {
      const view = open();
      await field(/Full name/);

      await view.user.click(submit());

      expect(screen.getByRole('textbox', { name: /Full name/ })).toHaveAttribute(
        'aria-invalid',
        'true',
      );
    },
  },
  error: {
    test: async () => {
      const view = open(KEYS.approver, { [CREATE]: () => refusal(403, 'PERMISSION_DENIED') });
      await fill(view);

      await view.user.click(submit());

      expect(await screen.findByRole('alert')).toBeVisible();
      expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    },
  },
  retry: {
    test: async () => {
      const view = open(KEYS.approver, {
        [CREATE]: () => Promise.reject(new TypeError('Failed to fetch')),
      });
      await fill(view);

      await view.user.click(submit());

      expect(await screen.findByRole('button', { name: 'Try again' })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'Creating a profile changes no record that was read, so it sends no version; a duplicate address is its own refusal, tested above.',
  },
  success: {
    test: async () => {
      const view = open();
      await fill(view);

      await view.user.click(submit());

      expect(await screen.findByRole('heading', { name: 'Profile created' })).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(KEYS.reader);

      expect(
        await screen.findByRole('heading', {
          level: 1,
          name: 'You do not have access to this page',
        }),
      ).toBeVisible();
      expect(screen.getByText('staff.identity.create')).toBeVisible();
    },
  },
});

describe('the staff creation form: accessibility', () => {
  it('has no WCAG violations that can be checked without a layout engine, in its states', async () => {
    const form = open();
    await field(/Full name/);
    expect(await wcagViolations(form.container)).toEqual([]);
    await form.user.click(submit());
    expect(await wcagViolations(form.container)).toEqual([]);
    form.unmount();
    api.restore();

    const done = open();
    await fill(done);
    await done.user.click(submit());
    await screen.findByRole('heading', { name: 'Profile created' });
    expect(await wcagViolations(done.container)).toEqual([]);
  });
});
