import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { narrowRoom, restoreRoom } from '../../../test-support/narrow-room';
import { reasonFixture } from '../../../test-support/reason-fixture';
import { renderApp } from '../../../test-support/render-app';
import { etag, KEYS, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';
import {
  HUB_ID,
  sessionRecordFixture,
  STAFF_ID,
  staffIdentityFixture,
} from '../../../test-support/staff-fixture';
import { wcagViolations } from '../../../test-support/wcag';
import { cannotText } from '../../../platform/problem/capability-words';

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
  restoreRoom();
});

const PATH = `/admin/sessions?principal_type=STAFF&principal_id=${STAFF_ID}`;
const LIST = 'GET /auth/sessions';
const PERSON = `GET /staff-identities/${STAFF_ID}`;
const REASONS = 'GET /reason-definitions';
const DIAGNOSTIC = /Diagnostic text that must never reach a screen/;
const MY_SESSION = '3f4c6b0e-0d8a-4a6e-9f55-1b2f0c9d7e11';
const FIRST = 'c0000000-0000-4000-8000-000000000001';
const SECOND = 'c0000000-0000-4000-8000-000000000002';
const REVOKE = (id: string) => `POST /auth/sessions/${id}/revoke`;

const first = sessionRecordFixture({ id: FIRST });
const second = sessionRecordFixture({
  id: SECOND,
  issued_at: '2026-10-22T07:05:00.000Z',
  last_activity_at: '2026-10-22T10:30:00.000Z',
  expires_at: '2026-10-22T15:05:00.000Z',
});

const revokeReasons = () =>
  json(200, [
    reasonFixture({
      code: 'DEVICE_LOST',
      label: 'The device was lost',
      permittedOperations: [{ operationId: 'revokeSession', branch: null }],
    }),
  ]);

function open(
  keys: readonly string[] = KEYS.approver,
  handlers: Record<string, () => Response | Promise<Response>> = {},
  path = PATH,
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        id: MY_SESSION,
        authorized_hubs: [{ id: HUB_ID, display_name: 'Accra Central' }],
      }),
      {
        [LIST]: () => json(200, { items: [first, second] }),
        [PERSON]: () => json(200, staffIdentityFixture({ status: 'ACTIVE' }), etag('v1')),
        [REASONS]: revokeReasons,
        ...handlers,
      },
    ),
  );
  return renderApp(path);
}

const posts = () => api.requests.filter((request) => request.method === 'POST');
const lists = () =>
  api.requests.filter(
    (request) => request.url.includes('/auth/sessions') && request.method === 'GET',
  );
const heading = (name: string) => screen.findByRole('heading', { level: 1, name });
/** The table is drawn while the rows are on their way, as rows of its own shape and `aria-busy`: it is the rows that are awaited. */
const table = async (): Promise<HTMLElement> => {
  const found = await screen.findByRole('table', { name: 'Open sessions' });
  await waitFor(() => {
    expect(found).not.toHaveAttribute('aria-busy', 'true');
  });
  return found;
};
/** In a room under 40rem the rows are cards (`narrowRoom`). */
const cards = () => screen.findByRole('list', { name: 'Open sessions' });
/** The table's region of failures is in the page before it has anything to say, so it is the words that are awaited, and not the region. */
const alertSaying = async (text: string | RegExp): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });
  return screen.getByRole('alert');
};
/** A session's row header is the time it started. The table's own message (nothing open, a failure) sits in a cell and is not one. */
const sessionRows = () => screen.queryAllByRole('rowheader');

async function end(view: ReturnType<typeof open>, index = 0) {
  const buttons = await screen.findAllByRole('button', { name: /^End session/ });
  await view.user.click(buttons[index] ?? buttons[0] ?? document.body);
  const dialog = screen.getByRole('alertdialog', { name: 'End this session?' });
  await view.user.selectOptions(
    await within(dialog).findByRole('combobox', { name: 'Reason (required)' }),
    'DEVICE_LOST',
  );
  await view.user.click(within(dialog).getByRole('button', { name: 'End session' }));
}

describe('the sessions: choosing whose', () => {
  // Break caught: a request for a principal nobody named, or for one the address made up.
  it('asks for a person first when the address names none, and asks the server nothing', async () => {
    open(KEYS.approver, {}, '/admin/sessions');

    expect(await heading('Sessions')).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Choose a person first' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Go to staff' })).toHaveAttribute(
      'href',
      '/admin/staff',
    );
    expect(lists()).toHaveLength(0);
  });

  it.each([
    ['a principal type that is not one', '?principal_type=ROBOT&principal_id=' + STAFF_ID],
    ['an id that is not an id', '?principal_type=STAFF&principal_id=abc'],
    ['a type without an id', '?principal_type=STAFF'],
    ['an id without a type', '?principal_id=' + STAFF_ID],
    ['a type in lower case', '?principal_type=staff&principal_id=' + STAFF_ID],
  ])('asks for a person first for %s', async (_label, query) => {
    open(KEYS.approver, {}, `/admin/sessions${query}`);

    expect(await screen.findByRole('heading', { name: 'Choose a person first' })).toBeVisible();
    expect(lists()).toHaveLength(0);
  });
});

describe('the sessions: what it shows', () => {
  it('names the page and the person whose sessions these are', async () => {
    open();

    expect(await heading('Sessions')).toBeVisible();
    expect(document.title).toBe('Sessions · Melarc Ops Portal');
    expect(await screen.findByText('Open sessions of Kofi Boateng.')).toBeVisible();
  });

  it('asks the server for the sessions of that principal and no other', async () => {
    open();
    await table();

    const url = new URL(lists()[0]?.url ?? 'http://x');
    expect(url.searchParams.get('principal_type')).toBe('STAFF');
    expect(url.searchParams.get('principal_id')).toBe(STAFF_ID);
  });

  // Break caught: a refresh that reads nothing, or one that reads another person's sessions; the list says when it was last checked.
  it('says when the sessions were last checked, and Refresh reads the same person’s sessions again', async () => {
    const view = open();
    await table();
    expect(screen.getByText(/^Updated /)).toBeVisible();
    const before = lists().length;

    await view.user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      expect(lists()).toHaveLength(before + 1);
    });
    await table();
    const url = new URL(lists().at(-1)?.url ?? 'http://x');
    expect(url.searchParams.get('principal_type')).toBe('STAFF');
    expect(url.searchParams.get('principal_id')).toBe(STAFF_ID);
  });

  it('lists each session with when it started, when it was last used and when it ends, in Accra time', async () => {
    open();

    const found = await table();
    const rows = within(found).getAllByRole('row');

    expect(rows).toHaveLength(3);
    const one = within(rows[1] ?? found);
    expect(one.getByText('23 Oct, 08:00')).toBeVisible();
    expect(one.getByText('23 Oct, 09:15')).toBeVisible();
    expect(one.getByText('23 Oct, 16:00')).toBeVisible();
    expect(within(rows[2] ?? found).getByText('22 Oct, 07:05')).toBeVisible();
  });

  it('draws a session as a card with the same facts and its act, in a room too narrow for the columns', async () => {
    narrowRoom();
    open(KEYS.approver, {
      [LIST]: () => json(200, { items: [sessionRecordFixture({ id: MY_SESSION }), second] }),
    });

    const found = within(await cards());
    const mine = found.getByText('This is your session').closest('li');
    expect(mine).not.toBeNull();
    expect(within(mine as HTMLElement).getByText('23 Oct, 09:15')).toBeVisible();
    expect(within(mine as HTMLElement).getByText('23 Oct, 16:00')).toBeVisible();
    expect(
      within(mine as HTMLElement).getByRole('button', {
        name: 'End session started 23 Oct, 08:00',
      }),
    ).toBeVisible();
    // The person's other session has no mark of being theirs, and its act names the session it ends.
    expect(found.getAllByText('This is your session')).toHaveLength(1);
    expect(found.getByRole('button', { name: 'End session started 22 Oct, 07:05' })).toBeVisible();
  });

  // Break caught: a credential, a token hash or a bundle on a session row.
  it('shows nothing of a session’s credential, whatever the server sends', async () => {
    open(KEYS.approver, {
      [LIST]: () =>
        json(200, { items: [{ ...first, token_hash: 'SECRET-HASH', token: 'SECRET' }] }),
    });
    await table();

    expect(document.body.textContent).not.toContain('SECRET');
  });

  // Break caught (the security review of run 5, Stage 5.1): a credential drawn in the cards, or in an attribute, which a check of the table's text cannot see. A token or its hash
  // that the server sent anyway has no place in either drawing, in any text or any attribute of the page (the whole markup is read).
  it.each([
    ['the table', false],
    ['the cards', true],
  ] as const)(
    'draws nothing of a session’s credential in %s, in any text or attribute',
    async (_name, narrow) => {
      if (narrow) narrowRoom();
      open(KEYS.approver, {
        [LIST]: () =>
          json(200, {
            items: [
              {
                ...first,
                token_hash: 'SECRET-HASH',
                token: 'SECRET',
                password_hash: 'SECRET-PASSWORD-HASH',
              },
            ],
          }),
      });
      await (narrow ? cards() : table());

      expect(document.body.innerHTML).not.toContain('SECRET');
    },
  );

  it('marks the session the person is using', async () => {
    open(KEYS.approver, {
      [LIST]: () => json(200, { items: [sessionRecordFixture({ id: MY_SESSION }), second] }),
    });

    const found = await table();

    expect(within(found).getAllByText('This is your session')).toHaveLength(1);
  });

  it('says whose sessions these are in general words when the person cannot be named', async () => {
    open(KEYS.approver, { [PERSON]: () => refusal(500, 'INTERNAL_ERROR') });

    expect(await screen.findByText('Open sessions of this staff member.')).toBeVisible();
    expect(await table()).toBeVisible();
  });

  it('does not look up a rider as a staff member', async () => {
    open(
      KEYS.approver,
      {},
      '/admin/sessions?principal_type=RIDER&principal_id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );

    expect(await screen.findByText('Open sessions of this rider.')).toBeVisible();
    expect(api.requests.some((request) => request.url.includes('/staff-identities'))).toBe(false);
  });

  it('links back to the profile of a staff member', async () => {
    open();

    expect(await screen.findByRole('link', { name: 'Back to profile' })).toHaveAttribute(
      'href',
      `/admin/staff/${STAFF_ID}`,
    );
  });

  it('says nothing is open as good news', async () => {
    open(KEYS.approver, { [LIST]: () => json(200, { items: [] }) });

    expect(await screen.findByRole('heading', { name: 'No open sessions' })).toBeVisible();
    expect(screen.getByText('Kofi Boateng is not signed in anywhere.')).toBeVisible();
    expect(sessionRows()).toHaveLength(0);
  });
});

describe('the sessions: who may end one', () => {
  it('offers to end each session to a person who can, naming the session it ends', async () => {
    open();

    const buttons = await screen.findAllByRole('button', { name: /^End session/ });

    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'End session started 23 Oct, 08:00',
      'End session started 22 Oct, 07:05',
    ]);
  });

  it('names the permission, and offers no button, to a person who cannot', async () => {
    open(KEYS.reader);

    await table();

    expect(screen.getByText(cannotText('staff.session.revoke'))).toBeVisible();
    expect(screen.queryByRole('button', { name: /^End session/ })).toBeNull();
  });
});

describe('the sessions: ending one', () => {
  it('asks first, says what it means and asks for a reason from the catalogue of this act', async () => {
    const view = open();
    const buttons = await screen.findAllByRole('button', { name: /^End session/ });
    await view.user.click(buttons[0] ?? document.body);

    const dialog = screen.getByRole('alertdialog', { name: 'End this session?' });
    expect(dialog).toHaveAccessibleDescription(
      /Kofi Boateng is signed out of this session at once\. They can sign in again\./,
    );
    await within(dialog).findByRole('combobox', { name: 'Reason (required)' });
    expect(
      new URL(
        api.requests.find((request) => request.url.includes('/reason-definitions'))?.url ??
          'http://x',
      ).searchParams.get('operation'),
    ).toBe('revokeSession');
    expect(within(dialog).getByRole('button', { name: 'End session' })).toHaveClass(
      'ui-button--danger',
    );
    expect(posts()).toHaveLength(0);
  });

  it('warns when the session is the one the person is using', async () => {
    const view = open(KEYS.approver, {
      [LIST]: () => json(200, { items: [sessionRecordFixture({ id: MY_SESSION })] }),
    });
    const [button] = await screen.findAllByRole('button', { name: /^End session/ });
    await view.user.click(button ?? document.body);

    expect(
      screen.getByRole('alertdialog', { name: 'End this session?' }),
    ).toHaveAccessibleDescription(/This is the session you are using\. Ending it signs you out\./);
  });

  it('sends the reason for that session, with no version and no key, and reads the list again', async () => {
    let count = 0;
    const view = open(KEYS.approver, {
      [LIST]: () => {
        count += 1;
        return json(200, { items: count === 1 ? [first, second] : [second] });
      },
      [REVOKE(FIRST)]: () =>
        json(200, { ...first, state: 'TERMINATED', termination_reason: 'ADMIN_REVOKED' }),
    });

    await end(view);

    expect(await screen.findByText('The session has ended.')).toBeVisible();
    const [request] = posts();
    expect(new URL(request?.url ?? 'http://x').pathname).toBe(
      `/api/v1/auth/sessions/${FIRST}/revoke`,
    );
    expect(request?.headers.has('If-Match')).toBe(false);
    expect(request?.headers.has('Idempotency-Key')).toBe(false);
    expect(await request?.json()).toEqual({ reason_code: 'DEVICE_LOST' });
    await waitFor(() => {
      expect(
        within(screen.getByRole('table', { name: 'Open sessions' })).getAllByRole('row'),
      ).toHaveLength(2);
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  // Break caught: the rows replaced by a loading treatment for the read that follows the act, so that the person loses their place.
  it('keeps the rows where they are while the list is read again, and says it is busy', async () => {
    let count = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = open(KEYS.approver, {
      [LIST]: async () => {
        count += 1;
        if (count === 1) return json(200, { items: [first, second] });
        await held;
        return json(200, { items: [second] });
      },
      [REVOKE(FIRST)]: () => json(200, { ...first, state: 'TERMINATED' }),
    });

    await end(view);

    expect(await screen.findByText('The session has ended.')).toBeVisible();
    expect(sessionRows()).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Open sessions' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    release();
    await waitFor(() => {
      expect(sessionRows()).toHaveLength(1);
    });
  });

  it('sends the note as it was typed', async () => {
    const view = open(KEYS.approver, {
      [REVOKE(FIRST)]: () => json(200, { ...first, state: 'TERMINATED' }),
    });
    const [button] = await screen.findAllByRole('button', { name: /^End session/ });
    await view.user.click(button ?? document.body);
    const dialog = screen.getByRole('alertdialog', { name: 'End this session?' });
    await view.user.selectOptions(
      await within(dialog).findByRole('combobox', { name: 'Reason (required)' }),
      'DEVICE_LOST',
    );
    await view.user.click(within(dialog).getByRole('textbox', { name: 'Note' }));
    await view.user.paste('Phone reported lost.');
    await view.user.click(within(dialog).getByRole('button', { name: 'End session' }));

    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    expect(await posts()[0]?.json()).toEqual({
      reason_code: 'DEVICE_LOST',
      note: 'Phone reported lost.',
    });
  });

  it('puts focus on the news when it is done', async () => {
    const view = open(KEYS.approver, {
      [REVOKE(FIRST)]: () => json(200, { ...first, state: 'TERMINATED' }),
    });

    await end(view);

    const news = await screen.findByText('The session has ended.');
    expect(news.closest('[tabindex="-1"]')).toHaveFocus();
  });

  // Break caught (ops-portal.md section 7): ending a session that had already ended read as a failure.
  it('reads a session that was already gone as already done', async () => {
    const view = open(KEYS.approver, { [REVOKE(FIRST)]: () => refusal(404, 'NOT_FOUND') });

    await end(view);

    expect(await screen.findByText('That session had already ended.')).toBeVisible();
    // The table keeps its region of failures in the page, empty until it has something to say: nothing was said.
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('tells a refusal of the tier plainly and keeps the dialog', async () => {
    const view = open(KEYS.approver, {
      [REVOKE(FIRST)]: () => refusal(403, 'INSUFFICIENT_AUTHORITY'),
    });

    await end(view);

    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent(
      'Your session cannot end this person’s sessions. Staff and vendor sessions are ended by a Platform Admin.',
    );
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  // Break caught: a retry offered for an act that is not safe to send again, or withheld for one that is. Ending a session is idempotent.
  it('offers to try again when the answer is lost, with the same command', async () => {
    let attempts = 0;
    const view = open(KEYS.approver, {
      [REVOKE(FIRST)]: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new TypeError('Failed to fetch'))
          : json(200, { ...first, state: 'TERMINATED' });
      },
    });
    await end(view);

    await view.user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('The session has ended.')).toBeVisible();
    expect(posts()).toHaveLength(2);
    expect(await posts()[1]?.json()).toEqual(await posts()[0]?.json());
  });

  it('reads the list again when the dialog is cancelled, because a session may have ended while it was open', async () => {
    const view = open();
    const [button] = await screen.findAllByRole('button', { name: /^End session/ });
    await view.user.click(button ?? document.body);

    await view.user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(lists()).toHaveLength(2);
    });
    expect(posts()).toHaveLength(0);
  });
});

describe('the sessions: when it cannot be had', () => {
  // Break caught (ops-portal.md section 7): a refusal of the tier shown as a missing key, or as a fault.
  it('says plainly that the session cannot see the sessions of this kind of person', async () => {
    open(KEYS.approver, { [LIST]: () => refusal(403, 'INSUFFICIENT_AUTHORITY') });

    const alert = await alertSaying(
      'Your session cannot see this person’s sessions. Staff and vendor sessions are seen by a Platform Admin.',
    );
    expect(alert).toHaveTextContent('A higher authority is needed');
    expect(sessionRows()).toHaveLength(0);
  });

  it('says a person who does not exist is not there', async () => {
    open(KEYS.approver, { [LIST]: () => refusal(404, 'NOT_FOUND') });

    await alertSaying('That person could not be found.');
  });

  it('names what the account cannot do when the server refuses the key', async () => {
    open(KEYS.approver, { [LIST]: () => refusal(403, 'PERMISSION_DENIED') });

    await alertSaying(cannotText('staff.read'));
    expect(document.body.textContent).not.toMatch(/staff\.read/);
  });

  it('says a person in a hub the session does not act in is outside its hubs', async () => {
    open(KEYS.approver, { [LIST]: () => refusal(403, 'HUB_SCOPE_VIOLATION') });

    await alertSaying('This person is at a hub your account does not work in.');
  });

  it('says it could not load, with a retry', async () => {
    let answers = 0;
    const view = open(KEYS.approver, {
      [LIST]: () => {
        answers += 1;
        return answers === 1 ? refusal(500, 'INTERNAL_ERROR') : json(200, { items: [first] });
      },
    });

    await alertSaying('The sessions could not be loaded.');
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    await view.user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await table()).toBeVisible();
    expect(sessionRows()).toHaveLength(1);
  });

  it('treats an answer that is not a list of sessions as an answer that is not the API’s', async () => {
    open(KEYS.approver, { [LIST]: () => json(200, { items: [{ surprise: true }] }) });

    await alertSaying('The sessions could not be loaded.');
    expect(screen.queryByRole('heading', { name: 'No open sessions' })).toBeNull();
  });

  it('names staff.read for a session that does not hold it, and reads nothing', async () => {
    open(KEYS.maker);

    expect(await heading('You do not have access to this page')).toBeVisible();
    expect(screen.getByText(cannotText('staff.read'))).toBeVisible();
    expect(lists()).toHaveLength(0);
  });
});

describeInterfaceStates('The sessions of a person', {
  loading: {
    test: async () => {
      open(KEYS.approver, { [LIST]: () => new Promise<Response>(() => undefined) });

      expect(await screen.findByText('Loading sessions')).toBeVisible();
      expect(sessionRows()).toHaveLength(0);
    },
  },
  empty: {
    test: async () => {
      open(KEYS.approver, { [LIST]: () => json(200, { items: [] }) });

      expect(await screen.findByRole('heading', { name: 'No open sessions' })).toBeVisible();
    },
  },
  'validation error': {
    test: async () => {
      const view = open();
      const [button] = await screen.findAllByRole('button', { name: /^End session/ });
      await view.user.click(button ?? document.body);
      const dialog = screen.getByRole('alertdialog');
      await within(dialog).findByRole('combobox', { name: 'Reason (required)' });

      await view.user.click(within(dialog).getByRole('button', { name: 'End session' }));

      expect(within(dialog).getByRole('combobox', { name: 'Reason (required)' })).toHaveAttribute(
        'aria-invalid',
        'true',
      );
      expect(posts()).toHaveLength(0);
    },
  },
  error: {
    test: async () => {
      open(KEYS.approver, { [LIST]: () => refusal(500, 'INTERNAL_ERROR') });

      await alertSaying('The sessions could not be loaded.');
    },
  },
  retry: {
    test: async () => {
      let answers = 0;
      const view = open(KEYS.approver, {
        [LIST]: () => {
          answers += 1;
          return answers === 1 ? refusal(500, 'INTERNAL_ERROR') : json(200, { items: [first] });
        },
      });

      await view.user.click(await screen.findByRole('button', { name: 'Retry' }));

      expect(await table()).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const view = open(KEYS.approver, { [REVOKE(FIRST)]: () => refusal(404, 'NOT_FOUND') });

      await end(view);

      expect(await screen.findByText('That session had already ended.')).toBeVisible();
    },
  },
  success: {
    test: async () => {
      const view = open(KEYS.approver, {
        [REVOKE(FIRST)]: () => json(200, { ...first, state: 'TERMINATED' }),
      });

      await end(view);

      expect(await screen.findByText('The session has ended.')).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(KEYS.maker);

      expect(await heading('You do not have access to this page')).toBeVisible();
    },
  },
});

describe('the sessions: accessibility', () => {
  it('has no WCAG violations that can be checked without a layout engine, in its states', async () => {
    const view = open();
    await table();
    expect(await wcagViolations(view.container)).toEqual([]);
    const [button] = screen.getAllByRole('button', { name: /^End session/ });
    await view.user.click(button ?? document.body);
    expect(await wcagViolations(view.container)).toEqual([]);
    view.unmount();
    api.restore();

    const guide = open(KEYS.approver, {}, '/admin/sessions');
    await screen.findByRole('heading', { name: 'Choose a person first' });
    expect(await wcagViolations(guide.container)).toEqual([]);
  });
});
