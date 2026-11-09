import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { errorResponse, installFakeApi, json, type FakeApi } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { narrowRoom, restoreRoom } from '../../../test-support/narrow-room';
import { renderApp } from '../../../test-support/render-app';
import { sessionWith, staffApi } from '../../../test-support/staff-api';
import { trustedBrowserFixture } from '../../../test-support/staff-fixture';
import { wcagViolations } from '../../../test-support/wcag';

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
  restoreRoom();
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
/** The table is drawn while the rows are on their way, as rows of its own shape and `aria-busy`: it is the rows that are awaited. */
const table = async (): Promise<HTMLElement> => {
  const found = await screen.findByRole('table', { name: 'Your trusted browsers' });
  await waitFor(() => {
    expect(found).not.toHaveAttribute('aria-busy', 'true');
  });
  return found;
};
/** In a room under 40rem the rows are cards (`narrowRoom`). */
const cards = () => screen.findByRole('list', { name: 'Your trusted browsers' });
/** The table's region of failures is in the page before it has anything to say, so it is the words that are awaited, and not the region. */
const alertSaying = async (text: string | RegExp): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });
  return screen.getByRole('alert');
};
/** A browser's row header is what it is called. The table's own message (none remembered, a failure) sits in a cell and is not one. */
const browserRows = () => screen.queryAllByRole('rowheader');

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
    expect(await table()).toBeVisible();
  });

  // Break caught: a refresh that reads nothing; the list says when it was last checked.
  it('says when the browsers were last checked, and Refresh reads the person’s own browsers again', async () => {
    const view = open();
    await table();
    expect(screen.getByText(/^Updated /)).toBeVisible();
    const lists = () =>
      api.requests.filter(
        (request) =>
          request.method === 'GET' && request.url.endsWith('/auth/staff/trusted-browsers'),
      );
    const before = lists().length;

    await view.user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      expect(lists()).toHaveLength(before + 1);
    });
    await table();
    expect(deletes()).toHaveLength(0);
  });

  // Break caught: dates that are not words, a browser that is not told from the one in use, or a column that hides when a browser was last used.
  it('shows what each browser is called, when it was added, last used and ends, and which one this is', async () => {
    open();

    const found = await table();
    const rows = within(found).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1] ?? found).getByRole('rowheader')).toHaveTextContent(
      'Chrome on WindowsThis browser',
    );
    expect(within(rows[1] ?? found).getAllByRole('cell')[1]).toHaveTextContent('24 Oct, 07:30');
    expect(within(rows[2] ?? found).getByRole('rowheader')).toHaveTextContent('Safari on macOS');
    expect(rows[2]).toHaveTextContent('Not used yet');
    expect(rows[2]).not.toHaveTextContent('This browser');
    expect(
      within(found)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Browser', 'Added', 'Last used', 'Ends', 'Action']);
  });

  it('draws a browser as a card with the same facts and its act, in a room too narrow for the columns', async () => {
    narrowRoom();
    open();

    const found = within(await cards());
    const first = found.getByRole('heading', { name: 'Chrome on Windows' }).closest('li');
    expect(first).not.toBeNull();
    expect(within(first as HTMLElement).getByText('This browser')).toBeVisible();
    expect(within(first as HTMLElement).getByText('24 Oct, 07:30')).toBeVisible();
    expect(
      within(first as HTMLElement).getByRole('button', {
        name: 'Remove Chrome on Windows (this browser)',
      }),
    ).toBeVisible();
    const second = found.getByRole('heading', { name: 'Safari on macOS' }).closest('li');
    expect(within(second as HTMLElement).getByText('Not used yet')).toBeVisible();
    expect(within(second as HTMLElement).queryByText('This browser')).toBeNull();
    expect(
      within(second as HTMLElement).getByRole('button', { name: 'Remove Safari on macOS' }),
    ).toBeVisible();
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
    await table();
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

  // Break caught: the rows replaced by a loading treatment for the read that follows the removal, so that the person loses their place.
  it('keeps the rows where they are while the list is read again, and says it is busy', async () => {
    let answers = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = open({
      [LIST]: async () => {
        answers += 1;
        if (answers === 1) return json(200, { items: [chrome, safari] });
        await held;
        return json(200, { items: [chrome] });
      },
      [REMOVE(SECOND)]: () => new Response(null, { status: 204 }),
    });

    await remove(view, 'Remove Safari on macOS');

    expect(
      await screen.findByText(
        'The browser is removed. It will ask for a code at its next sign-in.',
      ),
    ).toBeVisible();
    expect(browserRows()).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Your trusted browsers' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    release();
    await waitFor(() => {
      expect(browserRows()).toHaveLength(1);
    });
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

      expect(await screen.findByText('Loading trusted browsers')).toBeVisible();
      expect(browserRows()).toHaveLength(0);
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

      await alertSaying('Your trusted browsers could not be loaded.');
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

      await view.user.click(await screen.findByRole('button', { name: 'Retry' }));

      expect(await table()).toBeVisible();
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
    await table();
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
