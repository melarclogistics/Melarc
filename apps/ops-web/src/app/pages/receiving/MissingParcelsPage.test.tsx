import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import { INTAKE_HUB_ID } from '../../../test-support/hub-intake-fixture';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import {
  KENTE,
  KENTE_INTAKE_CODE,
  RUN_CODE,
  arrivedParcel,
  countsOf,
  missingParcelFixture,
  photoLinkHandlers,
  runPage,
} from '../../../test-support/receiving-fixture';
import { narrowRoom, restoreRoom } from '../../../test-support/narrow-room';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/missing-parcels` (`listMissingParcels`; S1.35c; D-D4): *Missing — being searched for*. The parcels that were not on the table when a vendor was checked in, **oldest first**, each with its photo, its vendor and
 * run and how long it has been missing, in two views that are the API's `view` filter. A row opens the parcel beside the list, and **the one act is finding it** (the tap of the run's page): after it the list is read
 * again and the officer is told which vendor's parcel is checked in. A parcel that was written off is not found by this page, and the page says nobody is sent anything.
 */
const LIST = 'GET /missing-parcels';
const ARRIVAL = (n: number) => `PUT /intake-parcels/${missingParcelFixture(n).parcel_id}/arrival`;
const KEYS = ['hub.read', 'hub.intake.count'];
const ACCRA = { id: INTAKE_HUB_ID, display_name: 'Accra Hub' };
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const OPEN_ONE = `Open the missing parcel from ${KENTE}`;

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
  restoreRoom();
});

const photosOf = (items: readonly ReturnType<typeof missingParcelFixture>[]) =>
  photoLinkHandlers(
    items.map((item, index) => ({ photo_evidence_id: item.photo_evidence_id, ordinal: index + 1 })),
  );

function open(
  handler: Handler = () => json(200, runPage([missingParcelFixture(1)])),
  keys: readonly string[] = KEYS,
  extra: Record<string, Handler> = {},
  photos: readonly ReturnType<typeof missingParcelFixture>[] = [missingParcelFixture(1)],
) {
  api = installFakeApi(
    staffApi(sessionWith(keys, { authorized_hubs: [ACCRA] }), {
      [LIST]: handler,
      ...photosOf(photos),
      ...extra,
    }),
  );
  return renderApp('/missing-parcels');
}

const table = async (): Promise<HTMLElement> => {
  const found = await screen.findByRole('table', { name: 'Missing parcels' });
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
    .filter((request) => new URL(request.url).pathname === '/api/v1/missing-parcels')
    .map((request) => new URL(request.url).searchParams);
const arrivalAnswer = (n: number) =>
  json(200, {
    parcel: arrivedParcel(n),
    intake_etag: '"kente-3"',
    counts: { ...countsOf([arrivedParcel(n)]), received_count: null, count_variance: null },
  });

describe('the list of missing parcels: what it shows', () => {
  it('shows each parcel with its photo, its vendor and run, and how long it has been missing, under the words of the floor', async () => {
    open(
      () =>
        json(
          200,
          runPage([
            missingParcelFixture(1),
            missingParcelFixture(2, {
              vendor_name: 'Shea Naturals',
              missing_since: '2026-11-14T10:00:00Z',
            }),
          ]),
        ),
      KEYS,
      {},
      [missingParcelFixture(1), missingParcelFixture(2)],
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Missing — being searched for' }),
    ).toBeVisible();
    const found = await table();
    const first = within(within(found).getByText(KENTE).closest('tr') as HTMLElement);
    expect(first.getByText(KENTE_INTAKE_CODE)).toBeVisible();
    expect(first.getByText(RUN_CODE)).toBeVisible();
    expect(within(found).getByText('Shea Naturals')).toBeVisible();
    // The photo is the parcel's own, drawn by the kit's picture: nothing of its identifier is on the page.
    expect(document.querySelectorAll('img.photo-picture--tile').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/retrieval-authorization|photos\.example\.test/);
  });

  // Break caught (the pictures' review, defect 10): at a phone's width the vendor was said twice in a card, as its title and again as a "Vendor" row under it.
  it('says the vendor once in a card, as its title, in a room too narrow for the columns', async () => {
    narrowRoom();
    open();

    const cards = within(await screen.findByRole('list', { name: 'Missing parcels' }));
    expect(cards.getByRole('heading', { name: KENTE })).toBeVisible();
    expect(cards.getAllByText(KENTE)).toHaveLength(1);
    expect(cards.getByText(RUN_CODE)).toBeVisible();
  });

  // Break caught: a list that asks for no view, or the wrong one, so that the written-off parcels are shown as being searched for.
  it('is the API’s view and nothing the page filters: it asks for the parcels being searched for, then for the written-off ones', async () => {
    const { user } = open();
    await table();
    expect(reads().at(-1)?.get('view')).toBe('searching');

    await user.click(screen.getByRole('tab', { name: 'Written off, vendor not told yet' }));
    await waitFor(() => {
      expect(reads().at(-1)?.get('view')).toBe('vendor_to_tell');
    });
  });

  it('is an entry of the Hub group of the menu, with the words of the floor', async () => {
    open();
    await table();
    const links = screen.getAllByRole('link', { name: 'Missing parcels' });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link).toHaveAttribute('href', '/missing-parcels');
  });

  it('says it sends nobody anything, and names no figure it worked out', async () => {
    open();
    await table();
    expect(document.body.textContent).not.toMatch(
      /\b(?:intakes?|adjudicat\w*|itemi[sz]\w*|reconciliation|advisory|the server)\b/i,
    );
  });
});

describe('finding a parcel', () => {
  // Break caught: the act sent without the parcel it is about, or sent twice for one press.
  it('opens the parcel beside the list, checks it in on a press of the one act, tells whose parcel it is, and reads the list again', async () => {
    let list = 0;
    const { user } = open(
      () => {
        list += 1;
        return json(200, runPage(list === 1 ? [missingParcelFixture(1)] : []));
      },
      KEYS,
      { [ARRIVAL(1)]: () => arrivalAnswer(1) },
    );
    await table();
    await user.click(screen.getByRole('button', { name: OPEN_ONE }));
    await user.click(await screen.findByRole('button', { name: 'Found: check it in' }));

    await waitFor(() => {
      expect(screen.getByText(`A parcel from ${KENTE} is checked in.`)).toBeVisible();
    });
    const sent = api.requests.filter((request) => request.url.endsWith('/arrival'));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('PUT');
    expect(await sent[0]?.clone().json()).toEqual({ arrived: true });
    await waitFor(() => {
      expect(reads().length).toBeGreaterThan(1);
    });
  });

  it('does not offer the act to an account that may not check parcels in, and does not send it', async () => {
    const { user } = open(undefined, ['hub.read']);
    await table();
    await user.click(screen.getByRole('button', { name: OPEN_ONE }));
    // The parcel is open (its facts are drawn), and the one act is not there.
    expect(await screen.findByText('Missing since')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Found: check it in' })).toBeNull();
  });

  it('does not offer the act for a parcel that was written off, and says a senior officer records that the vendor was told', async () => {
    const written = missingParcelFixture(1, { written_off_at: '2026-11-14T12:00:00Z' });
    const { user } = open(() => json(200, runPage([written])), KEYS, {}, [written]);
    await table();
    await user.click(screen.getByRole('button', { name: OPEN_ONE }));
    expect(await screen.findByText(/The search for this parcel is over/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Found: check it in' })).toBeNull();
  });

  // Break caught: a parcel that changed under the officer (found by someone else) told as a failure of the portal, or the list not read again.
  it('tells a parcel that changed in the words of a conflict, with what to do next, and reads the list again', async () => {
    const { user } = open(undefined, KEYS, {
      [ARRIVAL(1)]: () => refusal(409, 'STATE_CONFLICT', { rule: 'stale' }),
    });
    await table();
    await user.click(screen.getByRole('button', { name: OPEN_ONE }));
    await user.click(await screen.findByRole('button', { name: 'Found: check it in' }));

    await alertSaying(/no longer as you saw it|changed after you opened it/);
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    await waitFor(() => {
      expect(reads().length).toBeGreaterThan(1);
    });
  });
});

describeInterfaceStates('the list of missing parcels', {
  loading: {
    test: async () => {
      open(() => new Promise<Response>(() => undefined));
      expect(await screen.findByText('Loading missing parcels')).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      open(() => json(200, runPage([])));
      expect(await screen.findByRole('heading', { name: 'No missing parcels yet' })).toBeVisible();
      expect(screen.getByText(/No parcel is being searched for/)).toBeVisible();
    },
  },
  'validation error': {
    test: async () => {
      open(() =>
        refusal(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'query', pointer: '/view', rule: 'enum' }],
        }),
      );
      await alertSaying('That view was not accepted. Choose one of the views of the list.');
    },
  },
  error: {
    test: async () => {
      open(() => refusal(500, 'INTERNAL_ERROR'));
      await alertSaying('The missing parcels could not be loaded.');
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
          : json(200, runPage([missingParcelFixture(1)]));
      });
      await alertSaying(/could not be loaded/);
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText(KENTE)).toBeVisible();
    },
  },
  offline: {
    inapplicable: `${OFFLINE_NOT_APPLICABLE} On the list a lost connection is an error of the read, with Retry; the banner for a lost connection is on the run's page, where the acts are made.`,
  },
  'stale / conflict': {
    test: async () => {
      const { user } = open(undefined, KEYS, {
        [ARRIVAL(1)]: () => refusal(409, 'STATE_CONFLICT'),
      });
      await table();
      await user.click(screen.getByRole('button', { name: OPEN_ONE }));
      await user.click(await screen.findByRole('button', { name: 'Found: check it in' }));
      await alertSaying(/no longer as you saw it/);
    },
  },
  success: {
    test: async () => {
      open();
      expect(await screen.findByText(KENTE)).toBeVisible();
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

describe('a list at a hub the account does not work in', () => {
  it('tells it in plain words', async () => {
    open(() => refusal(403, 'HUB_SCOPE_VIOLATION'));
    await alertSaying('These parcels went missing at a hub your account does not work in.');
  });
});
