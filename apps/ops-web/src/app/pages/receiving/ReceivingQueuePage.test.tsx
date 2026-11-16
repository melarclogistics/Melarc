import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BUNDLE_KEY_SETS } from '../../../test-support/bundle-key-sets';
import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import { INTAKE_HUB_ID } from '../../../test-support/hub-intake-fixture';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import {
  KENTE,
  OTHER_RUN_CODE,
  OTHER_RUN_ID,
  PLANTED_BLIND_NUMBER,
  RUN_CODE,
  RUN_ID,
  runPage,
  runSummaryFixture,
} from '../../../test-support/receiving-fixture';
import { renderApp } from '../../../test-support/render-app';
import { sessionFixture } from '../../../test-support/session-fixture';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/receiving` (`listReceivingRuns`; S1.35c; D-D2). The receiving queue by run: one row for each run that has parcels to check in, naming the run by its code and the rider and the vendors by name, oldest handover
 * first, in three views that are the server's `view` filter. **The hub the switcher chose narrows it** (the server's `hub_id`), a lookup in the bar finds a run by its code or its vendor's name (the server finds;
 * the page filters nothing), and **no declared count is on a row**: a vendor counted blind is counted, and nothing of its number is said. A rider is a name and never a number to dial.
 */
const LIST = 'GET /receiving-runs';
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const KEYS = ['hub.read', 'hub.intake.count'];
const ACCRA = { id: INTAKE_HUB_ID, display_name: 'Accra Hub' };
const KUMASI = { id: '6c7d8e9f-0a12-4b3c-9d4e-5f6a7b8c9d0e', display_name: 'Kumasi Hub' };

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  handler: Handler = () => json(200, runPage([runSummaryFixture()])),
  keys: readonly string[] = KEYS,
  path = '/receiving',
) {
  api = installFakeApi(
    staffApi(sessionWith(keys, { authorized_hubs: [ACCRA] }), { [LIST]: handler }),
  );
  return renderApp(path);
}

const table = async (): Promise<HTMLElement> => {
  const found = await screen.findByRole('table', { name: 'Runs' });
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
const reads = () =>
  api.requests
    .filter((request) => new URL(request.url).pathname === '/api/v1/receiving-runs')
    .map((request) => new URL(request.url).searchParams);
const lastRead = () => reads().at(-1) ?? new URLSearchParams();

describe('the queue by run: what the list shows', () => {
  it('shows each run with its code, its rider, its vendors, what is left to do, how long it has waited and who is checking in', async () => {
    open(() =>
      json(
        200,
        runPage([
          runSummaryFixture({
            vendor_names: [KENTE, 'Shea Naturals', 'Adwoa Stalls', 'Yaw Textiles'],
            vendors_total: 4,
            vendors_waiting: 3,
            vendors_needing_decision: 1,
            missing_searching: 2,
            checking_in: [{ name: 'Ama Owusu', is_you: false }],
          }),
          runSummaryFixture({
            run_id: OTHER_RUN_ID,
            run_code: OTHER_RUN_CODE,
            vendor_names: ['Shea Naturals'],
            vendors_total: 1,
            vendors_waiting: 0,
            vendors_needing_decision: 0,
            blind_count_vendors: 1,
            parcels_expected: 0,
            rider_name: 'Efua Sarpong',
          }),
        ]),
      ),
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Receiving' })).toBeVisible();
    const found = await table();
    const first = within(within(found).getByText(RUN_CODE).closest('tr') as HTMLElement);
    expect(first.getByRole('link', { name: RUN_CODE })).toHaveAttribute(
      'href',
      `/receiving/${RUN_ID}`,
    );
    expect(first.getByText('Kofi Boateng')).toBeVisible();
    expect(first.getByText('Kente Crafts, Shea Naturals +2 more')).toBeVisible();
    expect(first.getByText('7 parcels')).toBeVisible();
    expect(first.getByText('3 of 4 vendors still to check in')).toBeVisible();
    expect(first.getByText('1 vendor needs a decision')).toBeVisible();
    expect(first.getByText('2 parcels being searched for')).toBeVisible();
    expect(first.getByText('Ama Owusu')).toBeVisible();
    expect(first.getByText('Accra hub')).toBeVisible();

    const second = within(within(found).getByText(OTHER_RUN_CODE).closest('tr') as HTMLElement);
    expect(second.getByText('Counted without photos')).toBeVisible();
    expect(second.getByText('Everything is checked in')).toBeVisible();
    expect(second.getByText('No one')).toBeVisible();
  });

  // Break caught: a lock told as someone else's when it is the person's own, or an officer named by an identifier.
  it('says "You" for a run the person is checking in, and names no identifier', async () => {
    open(() =>
      json(
        200,
        runPage([runSummaryFixture({ checking_in: [{ name: 'Ama Owusu', is_you: true }] })]),
      ),
    );
    const found = await table();
    expect(within(found).getByText('You')).toBeVisible();
    expect(within(found).queryByText('Ama Owusu')).toBeNull();
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  // Break caught: the queue's words in the voice of the builders: the floor says run, vendor, parcels, check in.
  it('speaks the words of the floor', async () => {
    open();
    await table();
    expect(document.body.textContent).not.toMatch(
      /\b(?:intakes?|adjudicat\w*|itemi[sz]\w*|reconciliation|advisory)\b/i,
    );
    expect(screen.getByRole('tab', { name: 'Waiting to be checked in' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it.each([
    ['needs_decision', 'needs_decision'],
    ['all', 'all'],
  ])('asks the server for the %s view with view=%s', async (view, asked) => {
    open(undefined, KEYS, `/receiving?view=${view}`);
    await table();
    expect(lastRead().get('view')).toBe(asked);
  });

  // Break caught: a hub filter sent for All hubs, or a view the page filtered itself: the page filters nothing, so it asks the server for the first view.
  it('asks the server for the waiting view first, by name, and no hub for a session that has one', async () => {
    open();
    await table();
    expect(lastRead().get('view')).toBe('waiting');
    expect(lastRead().has('hub_id')).toBe(false);
    expect(lastRead().has('q')).toBe(false);
  });
});

describe('the hub the switcher chose', () => {
  // Break caught: the queue that ignores the switcher (OB-S1-104: the receiving queue now has a hub filter): the screen says Kumasi Hub and shows every hub.
  it('narrows the queue to the hub chosen at the top, and sends nothing for All hubs', async () => {
    api = installFakeApi({
      ...staffApi(
        sessionFixture({
          permissions: [...BUNDLE_KEY_SETS['Platform Admin']],
          authorized_hubs: [ACCRA, KUMASI],
        }),
        {},
      ),
      [LIST]: () => json(200, runPage([runSummaryFixture()])),
    });
    const { user } = renderApp('/receiving');
    await table();
    expect(reads()).toHaveLength(1);
    expect(reads()[0]?.has('hub_id')).toBe(false);

    await user.click(
      within(screen.getByRole('banner')).getByRole('button', { name: 'Hub: All hubs' }),
    );
    await user.click(await screen.findByRole('menuitemradio', { name: 'Kumasi Hub' }));
    await waitFor(() => {
      expect(reads()).toHaveLength(2);
    });
    expect(reads()[1]?.get('hub_id')).toBe(KUMASI.id);
  });
});

describe('the lookup', () => {
  // Break caught: a lookup that is not sent, or sent as typed with its spaces, or sent twice.
  it('finds a run by what was typed, sent once and trimmed, and says what is searched for', async () => {
    const { user } = open();
    await table();
    await user.type(
      screen.getByRole('searchbox', { name: 'Search by run code or vendor name' }),
      '  kente  ',
    );
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      expect(lastRead().get('q')).toBe('kente');
    });
    expect(lastRead().getAll('q')).toHaveLength(1);
    expect(await screen.findByText('Search: kente')).toBeVisible();
  });

  // Break caught: a lookup of one character sent, which the server refuses as a failure for a person who has only begun to type.
  it('sends nothing for a single character', async () => {
    const { user } = open();
    await table();
    const before = reads().length;
    await user.type(
      screen.getByRole('searchbox', { name: 'Search by run code or vendor name' }),
      'k',
    );
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reads()).toHaveLength(before);
    expect(screen.queryByText(/Search: k/)).toBeNull();
  });

  // Break caught: a search that finds nothing told as "No runs yet", as if nothing existed anywhere.
  it('says nothing matches, with the way to clear the search, and keeps the view when it is applied', async () => {
    const { user } = open((request) =>
      new URL(request.url).searchParams.has('q')
        ? json(200, runPage([]))
        : json(200, runPage([runSummaryFixture()])),
    );
    await table();
    await user.click(screen.getByRole('tab', { name: 'Needs a decision' }));
    await waitFor(() => {
      expect(lastRead().get('view')).toBe('needs_decision');
    });
    await user.type(
      screen.getByRole('searchbox', { name: 'Search by run code or vendor name' }),
      'zzz',
    );
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/Nothing matches “zzz”/)).toBeVisible();
    expect(lastRead().get('view')).toBe('needs_decision');
    expect(lastRead().get('q')).toBe('zzz');
    await user.click(screen.getByRole('button', { name: 'Clear the search' }));
    await waitFor(() => {
      expect(lastRead().has('q')).toBe(false);
    });
    expect(await screen.findByText(RUN_CODE)).toBeVisible();
  });

  it('applies a lookup that the address carries', async () => {
    open(undefined, KEYS, '/receiving?q=shea');
    await table();
    expect(lastRead().get('q')).toBe('shea');
  });
});

describe('the queue and the blind count', () => {
  // Break caught: a rider's number planted in a row where the contract carries none: the queue draws no figure of a count that it was not given, and none of a blind vendor's.
  it('draws no declared number, even from an answer that carries one', async () => {
    open(() =>
      json(
        200,
        runPage([
          {
            ...runSummaryFixture({ blind_count_vendors: 1 }),
            rider_declared_count: PLANTED_BLIND_NUMBER,
            declared_parcels: PLANTED_BLIND_NUMBER,
          },
        ]),
      ),
    );
    const found = await table();
    expect(within(found).getByText(RUN_CODE)).toBeVisible();
    expect(document.body.textContent).not.toContain(String(PLANTED_BLIND_NUMBER));
  });

  // Break caught (OB-S1-106): a rider drawn as a number to dial.
  it('refuses a row that names a rider by a telephone number', async () => {
    open(() => json(200, runPage([runSummaryFixture({ rider_name: '+233 24 123 4567' })])));
    await alertSaying('The runs could not be loaded.');
    expect(document.body.textContent).not.toContain('233 24');
  });
});

describe('the old address', () => {
  // Break caught: the queue of S1.35 at /intakes left as a dead address: a link made before the redesign goes to the queue by run.
  it('sends /intakes to the queue by run', async () => {
    open(undefined, KEYS, '/intakes');
    expect(await screen.findByRole('heading', { level: 1, name: 'Receiving' })).toBeVisible();
    expect(await screen.findByText(RUN_CODE)).toBeVisible();
  });
});

describeInterfaceStates('the receiving queue by run', {
  loading: {
    test: async () => {
      open(() => new Promise<Response>(() => undefined));
      expect(await screen.findByText('Loading runs')).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      open(() => json(200, runPage([])));
      expect(await screen.findByRole('heading', { name: 'No runs yet' })).toBeVisible();
      expect(screen.getByText(/No run is waiting to be checked in/)).toBeVisible();
    },
  },
  'validation error': {
    test: async () => {
      open(() =>
        refusal(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'query', pointer: '/view', rule: 'enum' }],
        }),
      );
      await alertSaying(
        'That search or view was not accepted. Use at least 2 letters or digits, or choose another view.',
      );
    },
  },
  error: {
    test: async () => {
      open(() => refusal(500, 'INTERNAL_ERROR'));
      await alertSaying('The runs could not be loaded.');
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
          : json(200, runPage([runSummaryFixture()]));
      });
      await alertSaying(/could not be loaded/);
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText(RUN_CODE)).toBeVisible();
    },
  },
  offline: {
    inapplicable: `${OFFLINE_NOT_APPLICABLE} On the queue a lost connection is an error of the read, with Retry; the banner for a lost connection is on the run's page, where the acts are made.`,
  },
  'stale / conflict': {
    inapplicable:
      'The queue has no act, so nothing the officer does can leave it stale or in conflict: a read again is the freshness line’s own Refresh.',
  },
  success: {
    test: async () => {
      open();
      expect(await screen.findByText(RUN_CODE)).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(() => refusal(403, 'PERMISSION_DENIED'));
      await alertSaying(
        'Your account can’t see what has been handed over at a hub. Ask an administrator for access.',
      );
    },
  },
});
