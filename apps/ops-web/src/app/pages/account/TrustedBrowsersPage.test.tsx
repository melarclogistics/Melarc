import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { errorResponse, installFakeApi, json, type FakeApi } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { renderApp } from '../../../test-support/render-app';
import { sessionWith, staffApi } from '../../../test-support/staff-api';
import { trustedBrowserFixture } from '../../../test-support/staff-fixture';
import { wcagViolations } from '../../../test-support/wcag';

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const PATH = '/account/trusted-browsers';
const LIST = 'GET /auth/staff/trusted-browsers';
const REMOVE = (id: string) => `DELETE /auth/staff/trusted-browsers/${id}`;
const DIAGNOSTIC = /Diagnostic text that must never reach a screen/;
const FIRST = 'd1000000-0000-4000-8000-000000000001';
const SECOND = 'd1000000-0000-4000-8000-000000000002';

const chrome = trustedBrowserFixture({
  id: FIRST,
  current: true,
  last_used_at: '2026-10-24T07:30:00.000Z',
});
const safari = trustedBrowserFixture({
  id: SECOND,
  label: 'Safari on macOS',
  created_at: '2026-10-22T09:00:00.000Z',
  expires_at: '2026-10-29T09:00:00.000Z',
});

function open(
  handlers: Record<string, () => Response | Promise<Response>> = {},
  keys: readonly string[] = [],
) {
  api = installFakeApi(
    staffApi(sessionWith(keys), {
      [LIST]: () => json(200, { items: [chrome, safari] }),
      ...handlers,
    }),
  );
  return renderApp(PATH);
}

const heading = (name: string) => screen.findByRole('heading', { level: 1, name });
const deletes = () => api.requests.filter((request) => request.method === 'DELETE');

async function remove(view: ReturnType<typeof open>, name: RegExp | string) {
  await view.user.click(await screen.findByRole('button', { name }));
  const dialog = screen.getByRole('alertdialog', { name: 'Remove this browser?' });
  await view.user.click(within(dialog).getByRole('button', { name: 'Remove browser' }));
}

describe('the trusted browsers: what the page shows (AC-SLICE-000-136, -138)', () => {
  it('is a page of its own, for any signed-in session, with no permission', async () => {
    open();

    expect(await heading('Trusted browsers')).toBeVisible();
    expect(document.title).toBe('Trusted browsers · Melarc Ops Portal');
    expect(await screen.findByRole('table', { name: 'Your trusted browsers' })).toBeVisible();
  });

  // Break caught: dates that are not words, a browser that is not told from the one in use, or a column that hides when a browser was last used.
  it('shows what each browser is called, when it was added, last used and ends, and which one this is', async () => {
    open();

    const table = await screen.findByRole('table', { name: 'Your trusted browsers' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1] ?? table).getByRole('rowheader')).toHaveTextContent(
      'Chrome on WindowsThis browser',
    );
    expect(within(rows[1] ?? table).getAllByRole('cell')[1]).toHaveTextContent('24 Oct, 07:30');
    expect(within(rows[2] ?? table).getByRole('rowheader')).toHaveTextContent('Safari on macOS');
    expect(rows[2]).toHaveTextContent('Not used yet');
    expect(rows[2]).not.toHaveTextContent('This browser');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Browser', 'Added', 'Last used', 'Ends', 'Action']);
  });

  it('says plainly that the password is still asked, and shows nothing that could sign anyone in', async () => {
    const view = open({
      // A server that sent a credential anyway has nowhere on the page to put it.
      [LIST]: () =>
        json(200, {
          items: [
            {
              ...chrome,
              token: 'SENTINEL-CREDENTIAL-VALUE',
              token_hash: 'SENTINEL-HASH',
              factor_id: 'x',
            },
          ],
        }),
    });

    expect(await screen.findByText(/Your password is still asked every time/)).toBeVisible();
    await screen.findByRole('table', { name: 'Your trusted browsers' });
    expect(view.container.textContent).not.toContain('SENTINEL');
  });
});

describe('the trusted browsers: removing one', () => {
  it('asks first, says what it means for another browser, and sends the one removal', async () => {
    const view = open({ [REMOVE(SECOND)]: () => new Response(null, { status: 204 }) });
    await view.user.click(await screen.findByRole('button', { name: 'Remove Safari on macOS' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove this browser?' });

    expect(dialog).toHaveAccessibleDescription(
      /Safari on macOS will ask for an authenticator code the next time you sign in on it\./,
    );
    expect(deletes()).toHaveLength(0);
    await view.user.click(within(dialog).getByRole('button', { name: 'Remove browser' }));

    await waitFor(() => {
      expect(deletes()).toHaveLength(1);
    });
    expect(deletes()[0]?.url).toMatch(new RegExp(`/auth/staff/trusted-browsers/${SECOND}$`));
    expect(deletes()[0]?.headers.has('Idempotency-Key')).toBe(false);
    expect(
      await screen.findByText(
        'The browser is removed. It will ask for a code at its next sign-in.',
      ),
    ).toBeVisible();
  });

  // Break caught: removing the browser in use without saying so, or implying that the session ends.
  it('says that removing this browser leaves the session open', async () => {
    const view = open({ [REMOVE(FIRST)]: () => new Response(null, { status: 204 }) });
    await view.user.click(
      await screen.findByRole('button', { name: 'Remove Chrome on Windows (this browser)' }),
    );

    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(
      /This is the browser you are using\. It will ask for an authenticator code the next time you sign in\. Your session stays open\./,
    );
  });

  it('cancels without sending anything', async () => {
    const view = open();
    await view.user.click(await screen.findByRole('button', { name: 'Remove Safari on macOS' }));
    await view.user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(deletes()).toHaveLength(0);
  });

  // Break caught: a browser that has already gone read as a failure, which would leave the person unsure whether it is still trusted.
  it('reads a browser that is already gone as done', async () => {
    const view = open({ [REMOVE(SECOND)]: () => errorResponse(404, 'NOT_FOUND') });

    await remove(view, 'Remove Safari on macOS');

    expect(await screen.findByText('That browser had already been removed.')).toBeVisible();
  });

  it('reads the list again after a removal, so what is shown is what is in force', async () => {
    let answers = 0;
    const view = open({
      [LIST]: () => {
        answers += 1;
        return json(200, { items: answers === 1 ? [chrome, safari] : [chrome] });
      },
      [REMOVE(SECOND)]: () => new Response(null, { status: 204 }),
    });

    await remove(view, 'Remove Safari on macOS');

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Remove Safari on macOS' })).toBeNull();
    });
    expect(answers).toBe(2);
  });

  // Break caught: a failed removal worded with the server's diagnostic, or shown as if it had worked.
  it('words a refusal in its own words, never the server’s', async () => {
    const view = open({ [REMOVE(SECOND)]: () => errorResponse(422, 'UNEXPECTED_REFUSAL') });

    await remove(view, 'Remove Safari on macOS');

    const dialog = screen.getByRole('alertdialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That browser could not be removed, so it can still skip the code. Try again.',
    );
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });
});

describeInterfaceStates('The trusted browsers of a person', {
  loading: {
    test: async () => {
      open({ [LIST]: () => new Promise<Response>(() => undefined) });

      expect(await screen.findByText('Loading your trusted browsers…')).toBeVisible();
      expect(screen.queryByRole('table')).toBeNull();
    },
  },
  empty: {
    test: async () => {
      open({ [LIST]: () => json(200, { items: [] }) });

      expect(await screen.findByRole('heading', { name: 'No trusted browsers' })).toBeVisible();
      expect(
        screen.getByText(/Roles that sign in without an authenticator have nothing to remember/),
      ).toBeVisible();
    },
  },
  'validation error': {
    inapplicable:
      'The page has no field: the only input is a confirmation, and the choice of browser is a button on its own row.',
  },
  error: {
    test: async () => {
      open({ [LIST]: () => errorResponse(500, 'INTERNAL_ERROR') });

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Your trusted browsers could not be loaded.',
      );
      expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    },
  },
  retry: {
    test: async () => {
      let answers = 0;
      const view = open({
        [LIST]: () => {
          answers += 1;
          return answers === 1
            ? errorResponse(500, 'INTERNAL_ERROR')
            : json(200, { items: [chrome] });
        },
      });

      await view.user.click(await screen.findByRole('button', { name: 'Try again' }));

      expect(await screen.findByRole('table', { name: 'Your trusted browsers' })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const view = open({ [REMOVE(SECOND)]: () => errorResponse(404, 'NOT_FOUND') });

      await remove(view, 'Remove Safari on macOS');

      expect(await screen.findByText('That browser had already been removed.')).toBeVisible();
    },
  },
  success: {
    test: async () => {
      const view = open({ [REMOVE(SECOND)]: () => new Response(null, { status: 204 }) });

      await remove(view, 'Remove Safari on macOS');

      expect(
        await screen.findByText(
          'The browser is removed. It will ask for a code at its next sign-in.',
        ),
      ).toBeVisible();
    },
  },
  'permission-restricted': {
    inapplicable:
      'The page is the signed-in person’s own and holds no permission: the server shows a person their own browsers and nobody else’s.',
  },
});

describe('the trusted browsers: accessibility', () => {
  it('has no WCAG violations that can be checked without a layout engine, in its states', async () => {
    const view = open();
    await screen.findByRole('table', { name: 'Your trusted browsers' });
    expect(await wcagViolations(view.container)).toEqual([]);
    await view.user.click(screen.getByRole('button', { name: 'Remove Safari on macOS' }));
    expect(await wcagViolations(view.container)).toEqual([]);
    view.unmount();
    api.restore();

    const empty = open({ [LIST]: () => json(200, { items: [] }) });
    await screen.findByRole('heading', { name: 'No trusted browsers' });
    expect(await wcagViolations(empty.container)).toEqual([]);
  });
});
