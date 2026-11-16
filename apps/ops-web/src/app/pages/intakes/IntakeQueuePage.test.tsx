import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  INTAKE_HUB_ID,
  INTAKE_ID,
  INTAKE_OFFICER_ID,
  INTAKE_RECEIVER_ID,
  OTHER_INTAKE_ID,
  PLANTED_DECLARATION,
  intakePage,
  postCountFixture,
  preCountFixture,
  shortCountFixture,
} from '../../../test-support/hub-intake-fixture';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { MANIFEST_ID } from '../../../test-support/manifest-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/intakes` (`listHubIntakes`; S1.35). The receiving queue: the intakes at the hubs of the grant, oldest handover first, in three views that are the server's `state` filter. **No declared count is on
 * it, not even a zero one**: the guard of the list refuses an item that has not been counted and carries one, and gives a page the base of a counted intake and nothing of its count. The hub the switcher
 * chose does not narrow it (the operation has no hub filter), and the page says so.
 */
const LIST = 'GET /hub-intakes';
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const KEYS = ['hub.read', 'hub.intake.count'];

const waiting = preCountFixture();
let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  handler: Handler = () => json(200, intakePage([waiting])),
  keys: readonly string[] = KEYS,
  path = '/intakes',
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: INTAKE_HUB_ID, display_name: 'Accra Central' }],
      }),
      { [LIST]: handler },
    ),
  );
  return renderApp(path);
}

const table = async (): Promise<HTMLElement> => {
  const found = await screen.findByRole('table', { name: 'Intakes' });
  await waitFor(() => {
    expect(found).not.toHaveAttribute('aria-busy', 'true');
  });
  return found;
};
const alertSaying = async (text: string | RegExp): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(
      screen
        .getAllByRole('alert')
        .some((alert) =>
          typeof text === 'string'
            ? alert.textContent.includes(text)
            : text.test(alert.textContent),
        ),
    ).toBe(true);
  });
  const [first] = screen.getAllByRole('alert');
  if (first === undefined) throw new Error('no alert');
  return first;
};
const queryOf = () =>
  new URL(
    api.requests.filter((request) => new URL(request.url).pathname === '/api/v1/hub-intakes').at(-1)
      ?.url ?? 'http://x/',
  ).searchParams;

describe('the receiving queue: what the list shows', () => {
  it('shows each intake with its code, its run, when it was handed over, who is receiving and its state', async () => {
    open(() =>
      json(
        200,
        intakePage([
          waiting,
          preCountFixture({
            id: OTHER_INTAKE_ID,
            code: 'ACC-IN-9XM4TQ',
            handed_over_at: '2026-11-14T10:30:00Z',
            active_receiver_id: INTAKE_RECEIVER_ID,
            lock_acquired_at: '2026-11-14T10:40:00Z',
          }),
        ]),
      ),
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Receiving' })).toBeVisible();
    const found = await table();
    const first = within(within(found).getByText('ACC-IN-7KQ2MZ').closest('tr') as HTMLElement);
    expect(first.getByRole('link', { name: 'ACC-IN-7KQ2MZ' })).toHaveAttribute(
      'href',
      `/intakes/${INTAKE_ID}`,
    );
    expect(first.getByRole('link', { name: 'Open the run' })).toHaveAttribute(
      'href',
      `/manifests/${MANIFEST_ID}`,
    );
    expect(first.getByText('Awaiting count')).toBeVisible();
    expect(first.getByText('No one')).toBeVisible();
    expect(first.getByText('Accra Central')).toBeVisible();

    const second = within(within(found).getByText('ACC-IN-9XM4TQ').closest('tr') as HTMLElement);
    expect(second.getByText(/^Another receiver, last active /)).toBeVisible();
  });

  // Break caught: a lock told as someone else's when it is the person's own (a receiver who reopens the queue is told another is counting what they hold).
  it('says "You" for a lock the person holds, and never names another receiver', async () => {
    open(() =>
      json(
        200,
        intakePage([
          preCountFixture({
            active_receiver_id: INTAKE_OFFICER_ID,
            lock_acquired_at: '2026-11-14T10:40:00Z',
          }),
        ]),
      ),
    );
    const found = await table();

    expect(within(found).getByText(/^You, last active /)).toBeVisible();
    expect(document.body.textContent).not.toContain(INTAKE_OFFICER_ID);
  });

  // Break caught: a rider named by an identifier or by a name the portal does not have: a rider is told as "a rider".
  it('does not name the rider who handed the run over', async () => {
    open();
    const found = await table();

    expect(within(found).getByText('By a rider')).toBeVisible();
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('asks for the awaiting-count view first, by the server’s state filter, and no hub', async () => {
    open();
    await table();

    expect(queryOf().get('state')).toBe('AWAITING_COUNT');
    expect(queryOf().has('hub_id')).toBe(false);
    expect(screen.getByRole('tab', { name: 'Awaiting count' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it.each([
    ['decision', 'RECONCILIATION_REQUIRED'],
    ['all', null],
  ])('asks the server for the %s view with state=%s', async (view, state) => {
    open(() => json(200, intakePage([shortCountFixture()])), KEYS, `/intakes?view=${view}`);
    await table();

    expect(queryOf().get('state')).toBe(state);
  });

  // Break caught: the queue saying the hub switcher narrows it, or an empty list said to be empty "at" the hub chosen (the server did not filter by it).
  it('says the hub chosen at the top does not narrow the list, and never says an empty list is empty at a hub', async () => {
    open(() => json(200, intakePage([])));

    expect(await screen.findByRole('heading', { name: 'No intakes yet' })).toBeVisible();
    expect(screen.getByText(/whichever hub is chosen at the top/)).toBeVisible();
    expect(screen.queryByText(/Nothing at/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Show all hubs/ })).toBeNull();
  });
});

describe('the receiving queue and the blind count', () => {
  // Break caught: the rider's declaration, a zero one included, drawn on the queue from an answer that carried it (the contract never sends it; a server that did would be refused whole).
  it('shows no declared number, and refuses an item that has not been counted and carries one', async () => {
    open(() => json(200, intakePage([{ ...waiting, rider_declared_count: PLANTED_DECLARATION }])));

    await alertSaying('The intakes could not be loaded.');
    expect(document.body.textContent).not.toContain(String(PLANTED_DECLARATION));
    expect(screen.queryByText('ACC-IN-7KQ2MZ')).toBeNull();
    expect(screen.queryByText(/d+ parcels? declared/i)).toBeNull();
  });

  it('refuses a zero declaration in the same way, and a declaration under another name', async () => {
    open(() => json(200, intakePage([{ ...waiting, rider_declared_count: 0 }])));
    await alertSaying('The intakes could not be loaded.');
    api.restore();

    open(() => json(200, intakePage([{ ...waiting, riderDeclaredCount: PLANTED_DECLARATION }])));
    await alertSaying('The intakes could not be loaded.');
    expect(document.body.textContent).not.toContain(String(PLANTED_DECLARATION));
  });

  // Break caught: a counted intake in the All view that shows the number the rider declared, or the count, or the variance: the queue is not where a comparison is told.
  it('shows a counted intake with no declared number, no count and no comparison', async () => {
    open(
      () =>
        json(
          200,
          intakePage([
            shortCountFixture({
              rider_declared_count: PLANTED_DECLARATION,
              physical_count: PLANTED_DECLARATION - 2,
              count_difference: -2,
            }),
            postCountFixture({ id: OTHER_INTAKE_ID, code: 'ACC-IN-9XM4TQ' }),
          ]),
        ),
      KEYS,
      '/intakes?view=all',
    );
    const found = await table();

    expect(within(found).getByText('ACC-IN-7KQ2MZ')).toBeVisible();
    expect(within(found).getByText('Needs a decision')).toBeVisible();
    expect(within(found).getByText('Ready to itemise')).toBeVisible();
    expect(document.body.textContent).not.toContain(String(PLANTED_DECLARATION));
    expect(found.textContent).not.toMatch(/\b(?:declared|counted|short|over|matches)\b/i);
  });
});

describeInterfaceStates('the receiving queue', {
  loading: {
    test: async () => {
      open(() => new Promise<Response>(() => undefined));
      expect(await screen.findByText('Loading intakes')).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      open(() => json(200, intakePage([])));
      expect(await screen.findByRole('heading', { name: 'No intakes yet' })).toBeVisible();
      expect(screen.getByText(/Nothing is waiting to be counted/)).toBeVisible();
    },
  },
  'validation error': {
    test: async () => {
      open(() =>
        refusal(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'query', pointer: '/state', rule: 'enum' }],
        }),
      );
      await alertSaying('That filter was not accepted. Choose one of the views of the list.');
    },
  },
  error: {
    test: async () => {
      open(() => refusal(500, 'INTERNAL_ERROR'));
      await alertSaying('The intakes could not be loaded.');
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open(() => {
        attempts += 1;
        return attempts === 1
          ? refusal(503, 'SERVICE_UNAVAILABLE')
          : json(200, intakePage([waiting]));
      });
      await alertSaying(/could not be loaded/);
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText('ACC-IN-7KQ2MZ')).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'The queue has no act, so nothing the officer does can leave it stale or in conflict: a read again is the freshness line’s own Refresh.',
  },
  success: {
    test: async () => {
      open();
      expect(await screen.findByText('ACC-IN-7KQ2MZ')).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(() => refusal(403, 'PERMISSION_DENIED'));
      await alertSaying('Your account can’t see what has been handed over at a hub. Ask an administrator for access.');
    },
  },
});
