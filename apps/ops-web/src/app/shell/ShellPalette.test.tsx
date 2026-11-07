import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BUNDLE_KEY_SETS } from '../../test-support/bundle-key-sets';
import {
  errorResponse,
  installFakeApi,
  json,
  signedInApi,
  type FakeApi,
} from '../../test-support/fake-api';
import { renderApp } from '../../test-support/render-app';
import { sessionFixture } from '../../test-support/session-fixture';
import { ANY_SIGNED_IN_SESSION, type SignedInRoute } from '../navigation/route-registry';

/**
 * The palette as a person uses it (Ctrl or ⌘ K): the keyboard, where focus goes, what each state of the search says, and what a record is drawn
 * as. Only the network is replaced; the providers, the router, the shell and the lookup are the real ones.
 */
let api: FakeApi;

afterEach(() => {
  document.querySelector('dialog')?.remove();
  // Every request the shell makes is one the test has answered (review of 7 November 2026).
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const HUB = { id: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d', display_name: 'Accra Hub' };
const REQUEST_ID = '3f4c6b0e-0d8a-4a6e-9f55-1b2f0c9d7e11';
const RIDER_ID = '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';

const page = (name: string) => <h1 tabIndex={-1}>{name}</h1>;

const REGISTRY: readonly SignedInRoute[] = [
  {
    path: '/',
    element: page('My work'),
    access: ANY_SIGNED_IN_SESSION,
    menu: { place: 'sidebar', group: 'today', label: 'My work', icon: 'my-work', order: 0 },
  },
  {
    path: '/admin/vendors',
    element: page('Vendors'),
    access: { permission: 'vendor.read' },
    menu: {
      place: 'sidebar',
      group: 'people',
      label: 'Vendors',
      icon: 'vendors',
      order: 0,
      description: 'Find a vendor account, send a setup link again, or start a recovery.',
    },
  },
  {
    path: '/pickup-requests/new',
    element: page('Book a pickup'),
    access: { permission: 'pickup.request.create' },
    menu: { place: 'create', label: 'Book a pickup', icon: 'book-pickup', order: 0 },
  },
  {
    path: '/pickup-requests/:id',
    element: page('A request'),
    access: { permission: 'pickup.read' },
    menu: null,
  },
  {
    path: '/admin/riders/:id',
    element: page('A rider'),
    access: { permission: 'dispatch.read' },
    menu: null,
  },
  {
    path: '/account/trusted-browsers',
    element: page('Trusted browsers'),
    access: ANY_SIGNED_IN_SESSION,
    menu: { place: 'account', label: 'Trusted browsers', icon: 'trusted-browsers', order: 0 },
  },
];

const REQUEST = {
  kind: 'PICKUP_REQUEST',
  id: REQUEST_ID,
  code: 'PR-000123',
  title: 'PR-000123',
  state: 'PENDING',
  hub: HUB,
  service_date: '2026-11-02',
  sender_name: 'Ama Vendor',
};
const RIDER = {
  kind: 'RIDER',
  id: RIDER_ID,
  title: 'Kofi Rider',
  state: 'ACTIVE',
  hub: HUB,
  phone_hint: '+233******222',
};

function open(handlers: Parameters<typeof installFakeApi>[0] = {}) {
  api = installFakeApi({
    ...signedInApi(
      sessionFixture({
        permissions: [...BUNDLE_KEY_SETS['Senior Ops']],
        authorized_hubs: [HUB],
      }),
    ),
    ...handlers,
  });
  return renderApp('/', [], REGISTRY);
}

const lookups = () => api.requests.filter((request) => request.url.endsWith('/ops/lookup'));
const palette = () => screen.getByRole('dialog', { name: 'Search' });
const field = () => within(palette()).getByRole('combobox');
const ready = () => screen.findByRole('heading', { level: 1, name: 'My work' });

describe('the palette: opening and closing', () => {
  // Break caught: a shortcut that does not open it, or that opens it with focus left behind it.
  it.each([
    ['Ctrl K', '{Control>}k{/Control}'],
    ['⌘ K', '{Meta>}k{/Meta}'],
  ])('opens with %s from anywhere, with focus in its field', async (_name, keys) => {
    const { user } = open();
    await ready();

    await user.keyboard(keys);

    expect(await screen.findByRole('dialog', { name: 'Search' })).toBeVisible();
    expect(field()).toHaveFocus();
  });

  // Break caught: the shortcut that only opens, so that a person who changed their mind has to find the way out; or one that fires for other keys.
  it('closes with the shortcut again, and does nothing for K with Alt or Shift or without a modifier', async () => {
    const { user } = open();
    await ready();

    await user.keyboard('k');
    await user.keyboard('{Control>}{Shift>}k{/Shift}{/Control}');
    await user.keyboard('{Alt>}k{/Alt}');
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Search' });
    await user.keyboard('{Control>}k{/Control}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  // Break caught: the browser's own use of the key (a search of the address bar) taken while the shell has not handled it, or left to happen when it has.
  it('takes the browser’s own use of the key, and only when it handles it', async () => {
    const { user } = open();
    await ready();
    const keyDown = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', {
        key: 'k',
        cancelable: true,
        bubbles: true,
        ...init,
      });
      document.dispatchEvent(event);
      return event.defaultPrevented;
    };

    expect(keyDown({ ctrlKey: true })).toBe(true);
    await user.keyboard('{Escape}');
    expect(keyDown({})).toBe(false);
    expect(keyDown({ ctrlKey: true, shiftKey: true })).toBe(false);
  });

  // Break caught (review of 7 November 2026): the browser's key taken while the shell does nothing with it. With a modal dialog of the page open the
  // shortcut does nothing, so the browser's own use of the key (the address bar's search) is left to it, as the comment of the hook says.
  it('leaves the browser’s own use of the key alone while a modal dialog of the page is open', async () => {
    open();
    await ready();
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    const event = new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });

    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull();
  });

  // Break caught (review of 7 November 2026): a key held down toggling the palette, open and shut at the speed of the keyboard's repeat, and ending in
  // either state; a repeat is the shell's too, so it still takes the browser's key (a held Ctrl K must not give the address bar focus midway).
  it('is not toggled by a held key: a repeating Ctrl K neither closes the palette nor opens it', async () => {
    const { user } = open();
    await ready();
    const press = (repeat: boolean): KeyboardEvent => {
      const event = new KeyboardEvent('keydown', {
        key: 'k',
        ctrlKey: true,
        repeat,
        cancelable: true,
        bubbles: true,
      });
      act(() => {
        document.dispatchEvent(event);
      });
      return event;
    };

    press(false);
    await screen.findByRole('dialog', { name: 'Search' });
    const held = press(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeVisible();
    expect(held.defaultPrevented).toBe(true);

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    press(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // Break caught: the search of the top bar not opening the palette, or opening it with focus left on the button (a modal that is not entered).
  it('opens when the search of the top bar is pressed, and Escape closes it and returns focus to that button', async () => {
    const { user } = open();
    await ready();
    const button = within(screen.getByRole('banner')).getByRole('button', {
      name: 'Search a code, name or phone',
    });

    await user.click(button);
    expect(await screen.findByRole('dialog', { name: 'Search' })).toBeVisible();
    expect(field()).toHaveFocus();
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(button).toHaveFocus();
    });
  });

  // Break caught: focus given back to the search button when the palette was opened from somewhere else: it returns to whatever opened it.
  it('returns focus to whatever had it when the shortcut opened the palette', async () => {
    const { user } = open();
    await ready();
    const link = within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', {
      name: 'My work',
    });
    link.focus();

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Search' });
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(link).toHaveFocus();
    });
  });

  // Break caught: a palette opened over a modal dialog of the page, beneath its layer where it cannot be reached (the shortcut does nothing then).
  it('does nothing while a modal dialog of the page is open', async () => {
    const { user } = open();
    await ready();
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);

    await user.keyboard('{Control>}k{/Control}');

    expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull();
  });

  // Break caught: the text of one opening left in the field of the next, with a search made for a palette that is closed.
  it('forgets what was typed when it closes, and asks nothing for a closed palette', async () => {
    const { user } = open({ 'POST /ops/lookup': () => json(200, { items: [REQUEST] }) });
    await ready();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(field(), 'ama');
    await screen.findByRole('option', { name: /PR-000123/ });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const asked = lookups().length;

    await user.keyboard('{Control>}k{/Control}');

    expect(field()).toHaveValue('');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(lookups()).toHaveLength(asked);
  });
});

describe('the palette: the pages it goes to and creates', () => {
  // Break caught: a page the session may not open offered, or one it may open missing; and the account's page left out of Go to.
  it('lists Go to as the pages of the sidebar and the account menu, and Create as the New menu’s actions', async () => {
    const { user } = open();
    await ready();
    await user.keyboard('{Control>}k{/Control}');

    const options = within(palette()).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'My work',
      'Vendors',
      'Trusted browsers',
      'Book a pickup',
    ]);
  });

  // Break caught: the palette's own filter hiding what it should find: the page's name or what it is for ("recovery" finds the vendors).
  it('narrows the pages by what is typed: the name, or what the page is for', async () => {
    const { user } = open();
    await ready();
    await user.keyboard('{Control>}k{/Control}');

    await user.type(field(), 'book');
    expect(
      within(palette())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Book a pickup']);

    await user.clear(field());
    await user.type(field(), 'recovery');
    expect(
      within(palette())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Vendors']);
  });

  // Break caught: Enter that opens nothing, a palette that stays open over the page it went to, or focus left on the body instead of the heading.
  it('goes to the page that is chosen, closes, and leaves focus on its heading', async () => {
    const { user } = open();
    await ready();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(field(), 'vendors');

    await user.keyboard('{Enter}');

    const heading = await screen.findByRole('heading', { level: 1, name: 'Vendors' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
  });
});

describe('the palette: the search of records', () => {
  // Break caught: a search for text that is too short (a request for every letter), or one made for text that has not stood still.
  it('asks nothing for one character, says how to search, and asks once for a text that has stood still', async () => {
    const { user } = open({ 'POST /ops/lookup': () => json(200, { items: [] }) });
    await ready();
    await user.keyboard('{Control>}k{/Control}');
    expect(within(palette()).getByRole('status')).toHaveTextContent(
      'Type two letters or more to search records.',
    );

    await user.type(field(), 'a');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(lookups()).toHaveLength(0);

    await user.type(field(), 'mas');
    await waitFor(() => {
      expect(lookups()).toHaveLength(1);
    });
    expect(await lookups()[0]?.clone().json()).toEqual({ q: 'amas' });
  });

  // Break caught (review of 7 November 2026): a text longer than the server takes (64 characters once trimmed and folded) told as the hint "Type two
  // letters or more" (which is not what is wrong, and leaves the person typing more), or asked of the server and refused with a 400. Nothing is asked,
  // and the sentence says what to do. Whitespace the server folds is not counted: 60 letters and many spaces are 62 characters, and are searched.
  it('says to use 64 characters or fewer for a longer text, and asks nothing for it', async () => {
    const { user } = open({ 'POST /ops/lookup': () => json(200, { items: [] }) });
    await ready();
    await user.keyboard('{Control>}k{/Control}');

    await user.type(field(), 'x'.repeat(65));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(within(palette()).getByRole('status')).toHaveTextContent(
      'Use 64 characters or fewer to search records.',
    );
    expect(palette().textContent).not.toMatch(/Type two letters/);
    expect(lookups()).toHaveLength(0);

    await user.clear(field());
    await user.type(field(), `${'y'.repeat(30)}${' '.repeat(10)}${'z'.repeat(30)}`);
    await waitFor(() => {
      expect(lookups()).toHaveLength(1);
    });
  });

  // Break caught: the portal's own words under a result (the state in plain words, the hub, the date) not composed, or the server's facts shown raw.
  it('draws a record with its code and the line the portal wrote, and a masked phone only as returned', async () => {
    const { user } = open({
      'POST /ops/lookup': () =>
        json(200, { items: [{ ...REQUEST, phone_hint: '+233******111' }, RIDER] }),
    });
    await ready();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(field(), '0244');

    const requestOption = await screen.findByRole('option', { name: /PR-000123/ });
    expect(requestOption).toHaveTextContent(
      'PR-000123Ama Vendor · Waiting for confirmation · Accra Hub · Mon 2 Nov 2026 · +233******111',
    );
    expect(screen.getByRole('option', { name: /Kofi Rider/ })).toHaveTextContent(
      'Kofi RiderActive · Accra Hub · +233******222',
    );
    expect(palette().textContent).not.toMatch(/PENDING|\+233\d{9}|0244\d/);
  });

  // Break caught: Enter on a record that opens the wrong page, or no page; the portal maps a kind and an id to its own route.
  it('opens a record by its own page with Enter, closes, and leaves focus on the heading of the page', async () => {
    const { user } = open({ 'POST /ops/lookup': () => json(200, { items: [REQUEST] }) });
    await ready();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(field(), 'ama');
    await screen.findByRole('option', { name: /PR-000123/ });

    await user.keyboard('{Enter}');

    const heading = await screen.findByRole('heading', { level: 1, name: 'A request' });
    expect(heading).toBeVisible();
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // Break caught: results of an earlier text offered for a later one, or the loading state missing between them.
  it('says Searching… while the text is asked, and shows no result of an earlier text meanwhile', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user } = open({
      'POST /ops/lookup': async () => {
        await held;
        return json(200, { items: [REQUEST] });
      },
    });
    await ready();
    await user.keyboard('{Control>}k{/Control}');

    await user.type(field(), 'ama');

    expect(await within(palette()).findByText('Searching…')).toBeVisible();
    expect(within(palette()).queryByRole('option', { name: /PR-000123/ })).toBeNull();
    await act(async () => {
      release();
      await held;
    });
    expect(await screen.findByRole('option', { name: /PR-000123/ })).toBeVisible();
  });

  // Break caught: nothing found told as a failure, or not told at all.
  it('says that no record matches, naming what was typed', async () => {
    const { user } = open({ 'POST /ops/lookup': () => json(200, { items: [] }) });
    await ready();
    await user.keyboard('{Control>}k{/Control}');

    await user.type(field(), 'zzzz');

    expect(await within(palette()).findByText('No record matches “zzzz”.')).toBeVisible();
  });

  // Break caught: the server's diagnostic shown, no way to ask again, or an automatic retry (the session's bucket is 120 requests a minute for
  // every call, and a person typing steadily can exceed it: nothing may ask again by itself).
  it('says in plain words that the search could not be completed, offers Try again, asks again only when pressed', async () => {
    let answers = 0;
    const { user } = open({
      'POST /ops/lookup': () => {
        answers += 1;
        return answers === 1
          ? errorResponse(500, 'INTERNAL_ERROR')
          : json(200, { items: [REQUEST] });
      },
    });
    await ready();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(field(), 'ama');

    // The alert is a container that is in the palette through every state, so it is waited for by its text and not by its presence.
    await waitFor(() => {
      expect(within(palette()).getByRole('alert')).toHaveTextContent(
        'The search could not be completed.',
      );
    });
    expect(palette().textContent).not.toMatch(/INTERNAL_ERROR|Diagnostic text/);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(lookups()).toHaveLength(1);

    await user.click(within(palette()).getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('option', { name: /PR-000123/ })).toBeVisible();
    expect(lookups()).toHaveLength(2);
  });

  // Break caught: the rate limit shown as an error alert or in other words, or asked again by itself (audit A2: the shared calm message, in the status line).
  it('says to wait when the session has asked too often, and does not ask again by itself', async () => {
    const { user } = open({ 'POST /ops/lookup': () => errorResponse(429, 'RATE_LIMITED') });
    await ready();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(field(), 'ama');

    await waitFor(() => {
      expect(within(palette()).getByRole('status')).toHaveTextContent(
        "You're going a little fast. Try again in a few seconds.",
      );
    });
    // Not an alert: the alert container is in the document through every state, and stays empty.
    expect(within(palette()).getByRole('alert')).toBeEmptyDOMElement();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(lookups()).toHaveLength(1);
  });
});
