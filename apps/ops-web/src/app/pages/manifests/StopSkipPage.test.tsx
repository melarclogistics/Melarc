import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { byHand } from '../../../test-support/by-hand';
import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import {
  manifestFixture,
  MANIFEST_ID,
  REQUEST_ONE_ID,
  STOP_ONE_ID,
  stopFixture,
  summaryFixture,
} from '../../../test-support/manifest-fixture';
import {
  cancellationReasonFixture,
  PICKUP_HUB_ID,
  pickupRequestFixture,
} from '../../../test-support/pickup-fixture';
import { renderApp } from '../../../test-support/render-app';
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/manifests/{id}/stops/{stopId}/skip` (`getPickupStop`, `listReasonDefinitions`, `skipPickupStop`; S1.25). Ops skips a stop with a reason
 * of the `PICKUP_STOP_SKIP` catalogue, read from the server; the note is mandatory exactly where the reason's `requires_note` says; the act
 * sends the version of the stop read and a key; the page says the vendor is notified, and the manifest is read again afterwards.
 */
const PATH = `/manifests/${MANIFEST_ID}/stops/${STOP_ONE_ID}/skip`;
const STOP = `GET /pickup-stops/${STOP_ONE_ID}`;
const SKIP = `POST /pickup-stops/${STOP_ONE_ID}/skip`;
const REASONS = 'GET /reason-definitions';
const MANIFEST = `GET /pickup-manifests/${MANIFEST_ID}`;
const KEYS = ['pickup.read', 'pickup.stop.skip', 'settings.reason.read'];
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;

const reason = (code: string, label: string, requiresNote: boolean) =>
  cancellationReasonFixture({
    code,
    domain: 'PICKUP_STOP_SKIP',
    label,
    requiresNote,
    attribution: 'MELARC',
  });
/** The four codes of the catalogue (domain-model.md section 3.9), two of which want a note: here under demo labels, since the page writes none. */
const CATALOGUE = [
  reason('RUN_CUT_SHORT', 'Demo: the run was cut short', false),
  reason('VENDOR_REQUESTED_SKIP', 'Demo: the vendor asked to skip', false),
  reason('LOCATION_INACCESSIBLE', 'Demo: the place cannot be reached', true),
  reason('STOP_RAISED_IN_ERROR', 'Demo: the stop was raised in error', true),
];

const waitingStop = (overrides = {}) =>
  stopFixture({ pickup_summary: summaryFixture('ACC-PR-7KQ2MZ'), ...overrides });
const skippedStop = (code: string, note?: string) =>
  waitingStop({
    state: 'SKIPPED',
    skipped: {
      reason_code: code,
      ...(note === undefined ? {} : { note }),
      skipped_at: '2026-11-04T09:00:00Z',
    },
  });

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(handlers: Record<string, Handler> = {}, keys: readonly string[] = KEYS) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: PICKUP_HUB_ID, display_name: 'Accra Central' }],
      }),
      {
        [STOP]: () => json(200, waitingStop(), etag('s1')),
        [REASONS]: () => json(200, CATALOGUE),
        ...handlers,
      },
    ),
  );
  return renderApp(PATH);
}

const sent = (route: string) =>
  api.requests.filter(
    (candidate) =>
      `${candidate.method} ${new URL(candidate.url).pathname.replace(/^\/api\/v1/, '')}` === route,
  );
const bodyOf = async (route: string): Promise<unknown> => sent(route).at(-1)?.clone().json();
const form = () => screen.findByRole('combobox', { name: /Reason/ });

/** The manifest the officer comes back to, read again after the skip. */
const afterwards = {
  [MANIFEST]: () =>
    json(
      200,
      manifestFixture({
        state: 'IN_PROGRESS',
        started_at: '2026-11-04T07:30:00Z',
        stops: [skippedStop('RUN_CUT_SHORT')],
      }),
      etag('v2'),
    ),
  'GET /run-custody-handovers': () => json(200, { items: [], next_page_token: null }),
};
const skipped = () => json(200, skippedStop('RUN_CUT_SHORT'), etag('s2'));

describe('the skip: what the page says and asks', () => {
  it('names the stop and the pickup, and says the vendor is always told', async () => {
    open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Skip a stop' })).toBeVisible();
    expect(await screen.findByText('Stop 1, ACC-PR-7KQ2MZ.')).toBeVisible();
    expect(await screen.findByText(/The vendor is always told/)).toBeVisible();
    expect(screen.getByText(/uses up no pickup attempt/)).toBeVisible();
  });

  // Break caught: the skip offered as a way to clear a failed pickup, which is another permission's page.
  it('says this is not the way to clear a failed pickup, and names the key that is', async () => {
    open();
    await form();

    expect(screen.getByText(/not the way to clear a failed pickup/)).toBeVisible();
    expect(screen.getByText('pickup.failure.resolve')).toBeVisible();
  });

  // Break caught: reason codes written into the page, which would offer a code the catalogue has retired.
  it('offers the reasons the catalogue gives, in its words, and asks for the skip domain', async () => {
    open();

    const select = await form();
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Choose a reason',
      'Demo: the run was cut short',
      'Demo: the vendor asked to skip',
      'Demo: the place cannot be reached',
      'Demo: the stop was raised in error',
    ]);
    const asked = api.requests.find(
      (request) => new URL(request.url).pathname === '/api/v1/reason-definitions',
    );
    expect(new URL(asked?.url ?? 'http://x/').searchParams.get('domain')).toBe('PICKUP_STOP_SKIP');
    expect(document.body.textContent).not.toContain('RUN_CUT_SHORT');
  });

  // Break caught: a note required for the codes the page remembers rather than for those the catalogue says.
  it('asks for a note exactly where the reason’s requires_note says', async () => {
    const { user } = open({
      [REASONS]: () =>
        json(200, [
          reason('RUN_CUT_SHORT', 'Demo: one', true),
          reason('LOCATION_INACCESSIBLE', 'Demo: two', false),
        ]),
    });
    const select = await form();

    await user.selectOptions(select, 'RUN_CUT_SHORT');
    expect(screen.getByRole('textbox', { name: /Note/ })).toBeRequired();
    await user.selectOptions(select, 'LOCATION_INACCESSIBLE');
    expect(screen.getByRole('textbox', { name: /Note/ })).not.toBeRequired();
  });

  it('says plainly that no skip reason is configured, naming the key that adds one', async () => {
    open({ [REASONS]: () => json(200, []) });

    expect(
      await screen.findByText(/No reason for skipping a stop is configured yet/),
    ).toBeVisible();
    expect(screen.getByText('settings.reason.manage')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Skip this stop' })).toBeNull();
  });

  it('asks for the reason, and for the note a reason needs, before it asks to confirm', async () => {
    const { user } = open();
    const select = await form();

    await user.click(screen.getByRole('button', { name: 'Skip this stop' }));
    expect(await screen.findByText('Choose a reason.')).toBeVisible();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await user.selectOptions(select, 'LOCATION_INACCESSIBLE');
    await user.click(screen.getByRole('button', { name: 'Skip this stop' }));
    expect(await screen.findByText('This reason needs a note.')).toBeVisible();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(sent(SKIP)).toHaveLength(0);
  });
});

describe('the skip: doing it', () => {
  async function review(
    user: ReturnType<typeof userEvent.setup>,
    code = 'LOCATION_INACCESSIBLE',
    note = 'Gate locked',
  ) {
    await user.selectOptions(await form(), code);
    if (note !== '') await user.type(screen.getByRole('textbox', { name: /Note/ }), note);
    await user.click(screen.getByRole('button', { name: 'Skip this stop' }));
    return screen.getByRole('alertdialog', { name: 'Skip stop 1, ACC-PR-7KQ2MZ?' });
  }

  it('confirms first, saying the vendor is notified, and sends nothing until the officer confirms', async () => {
    const { user } = open({ [SKIP]: skipped, ...afterwards });
    const dialog = await review(user);

    expect(within(dialog).getByText(/The vendor is notified/)).toBeVisible();
    expect(within(dialog).getByText(/No pickup attempt is used up/)).toBeVisible();
    expect(sent(SKIP)).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(sent(SKIP)).toHaveLength(0);
  });

  // Break caught: a skip sent without the version of the stop, without a key, or with a field the operation does not take.
  it('sends the reason and the note on the version of the stop read, under a key', async () => {
    const { user } = open({
      [SKIP]: () => json(200, skippedStop('LOCATION_INACCESSIBLE', 'Gate locked'), etag('s2')),
      ...afterwards,
    });
    const dialog = await review(user);

    await user.click(within(dialog).getByRole('button', { name: 'Skip the stop' }));

    await waitFor(() => {
      expect(sent(SKIP)).toHaveLength(1);
    });
    expect(sent(SKIP)[0]?.headers.get('If-Match')).toBe('"s1"');
    expect(sent(SKIP)[0]?.headers.get('Idempotency-Key')).toMatch(KEY);
    expect(await bodyOf(SKIP)).toEqual({
      reason_code: 'LOCATION_INACCESSIBLE',
      note: 'Gate locked',
    });
  });

  it('sends no note when none was written for a reason that does not ask for one', async () => {
    const { user } = open({ [SKIP]: skipped, ...afterwards });
    const dialog = await review(user, 'RUN_CUT_SHORT', '');

    await user.click(within(dialog).getByRole('button', { name: 'Skip the stop' }));

    await waitFor(() => {
      expect(sent(SKIP)).toHaveLength(1);
    });
    expect(await bodyOf(SKIP)).toEqual({ reason_code: 'RUN_CUT_SHORT' });
  });

  // Break caught: the manifest left as it was drawn, when the API may have completed the run in the same act.
  it('takes the officer back to the manifest, which is read again, and says so', async () => {
    const { user } = open({ [SKIP]: skipped, ...afterwards });
    const dialog = await review(user, 'RUN_CUT_SHORT', '');

    await user.click(within(dialog).getByRole('button', { name: 'Skip the stop' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'ACC-MF-Q92422' })).toBeVisible();
    expect(screen.getByText(/The stop is skipped and the vendor is told\./)).toBeVisible();
    expect(sent(MANIFEST)).toHaveLength(1);
  });

  it.each([
    ['STATE_CONFLICT', 409, /can no longer be skipped/],
    ['REASON_NOT_ACTIVE', 422, /can no longer be used to skip a stop/],
    ['REASON_REQUIRED', 422, /a reason, or the note the reason asks for/],
    ['PERMISSION_DENIED', 403, /pickup\.stop\.skip/],
    ['HUB_SCOPE_VIOLATION', 403, /hub your session does not act in/],
  ])('tells %s in the officer’s words, and shows no diagnostic', async (code, status, words) => {
    const { user } = open({ [SKIP]: () => refusal(status, code) });
    const dialog = await review(user);

    await user.click(within(dialog).getByRole('button', { name: 'Skip the stop' }));

    expect(await within(dialog).findByText(words)).toBeVisible();
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  it('reads the reasons again when the one chosen can no longer be used', async () => {
    let reads = 0;
    const { user } = open({
      [REASONS]: () => {
        reads += 1;
        return json(200, CATALOGUE);
      },
      [SKIP]: () => refusal(422, 'REASON_NOT_ACTIVE'),
    });
    const dialog = await review(user);

    await user.click(within(dialog).getByRole('button', { name: 'Skip the stop' }));
    await within(dialog).findByText(/can no longer be used to skip a stop/);

    await waitFor(() => {
      expect(reads).toBe(2);
    });
  });

  it('reads the stop again from the reload after a conflict, for the version a new skip takes', async () => {
    let reads = 0;
    const { user } = open({
      [STOP]: () => json(200, waitingStop(), etag(`s${String(++reads)}`)),
      [SKIP]: () => refusal(409, 'STATE_CONFLICT'),
    });
    const dialog = await review(user);
    await user.click(within(dialog).getByRole('button', { name: 'Skip the stop' }));

    await user.click(await within(dialog).findByRole('button', { name: 'Reload the record' }));

    await waitFor(() => {
      expect(reads).toBe(2);
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('keeps one key for a retry after a lost answer, and sends once more', async () => {
    let calls = 0;
    const { user } = open({
      [SKIP]: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new TypeError('Failed to fetch')) : skipped();
      },
      ...afterwards,
    });
    const dialog = await review(user, 'RUN_CUT_SHORT', '');
    await user.click(within(dialog).getByRole('button', { name: 'Skip the stop' }));

    await user.click(await within(dialog).findByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(sent(SKIP)).toHaveLength(2);
    });
    expect(sent(SKIP)[0]?.headers.get('Idempotency-Key')).toBe(
      sent(SKIP)[1]?.headers.get('Idempotency-Key'),
    );
  });
});

describe('the skip: a stop that cannot be skipped, or is not there', () => {
  it.each([
    ['collected', 'COLLECTED', 'Collected'],
    ['failed', 'FAILED', 'Failed'],
  ])(
    'says a %s stop is not waiting to be worked, and offers no form',
    async (_name, state, label) => {
      open({
        [STOP]: () =>
          json(
            200,
            waitingStop({
              state,
              ...(state === 'FAILED' ? { failure_category: 'ACCESS_DENIED' } : {}),
            }),
            etag('s1'),
          ),
      });

      expect(
        await screen.findByText('This stop is not waiting to be worked, so it cannot be skipped.'),
      ).toBeVisible();
      expect(screen.getByText(label)).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Skip this stop' })).toBeNull();
      expect(api.requests.some((request) => request.url.includes('reason-definitions'))).toBe(
        false,
      );
    },
  );

  // Break caught: a stop skipped under the address of a manifest that is not its own.
  it('is a stop that is not there when the manifest in the address is not its own', async () => {
    open({
      [STOP]: () => json(200, waitingStop({ pickup_manifest_id: REQUEST_ONE_ID }), etag('s1')),
    });

    expect(await screen.findByRole('heading', { level: 1, name: 'Stop not found' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Skip this stop' })).toBeNull();
  });

  it('tells a stop that does not exist as that, with the way back', async () => {
    open({ [STOP]: () => refusal(404, 'NOT_FOUND') });

    expect(await screen.findByRole('heading', { level: 1, name: 'Stop not found' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to the manifest' })).toHaveAttribute(
      'href',
      `/manifests/${MANIFEST_ID}`,
    );
  });

  it('tells a stop of another hub as that', async () => {
    open({ [STOP]: () => refusal(403, 'HUB_SCOPE_VIOLATION') });

    expect(await screen.findByText(/hub your session does not act in/)).toBeVisible();
  });

  it('names the pickup by a read of its request when the stop carries no summary', async () => {
    open({
      [STOP]: () => json(200, stopFixture(), etag('s1')),
      [`GET /pickup-requests/${REQUEST_ONE_ID}`]: () =>
        json(
          200,
          pickupRequestFixture({ id: REQUEST_ONE_ID, code: 'ACC-PR-9WXH4T', state: 'CONFIRMED' }),
          etag('r1'),
        ),
    });

    expect(await screen.findByText('Stop 1, ACC-PR-9WXH4T.')).toBeVisible();
  });
});

describeInterfaceStates('the skip page', {
  loading: {
    test: async () => {
      const held = byHand();
      open({ [STOP]: held.handler });
      expect(await screen.findByText('Loading the stop…')).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      open({ [REASONS]: () => json(200, []) });
      expect(
        await screen.findByText(/No reason for skipping a stop is configured yet/),
      ).toBeVisible();
    },
  },
  'validation error': {
    test: async () => {
      const { user } = open();
      await form();
      await user.click(screen.getByRole('button', { name: 'Skip this stop' }));
      expect(await screen.findByText('Choose a reason.')).toBeVisible();
    },
  },
  error: {
    test: async () => {
      open({ [STOP]: () => refusal(500, 'INTERNAL_ERROR') });
      expect(await screen.findByText('This stop could not be loaded.')).toBeVisible();
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let calls = 0;
      const { user } = open({
        [STOP]: () =>
          calls++ === 0 ? refusal(500, 'INTERNAL_ERROR') : json(200, waitingStop(), etag('s1')),
      });
      await user.click(await screen.findByRole('button', { name: /try again|retry/i }));
      await form();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const { user } = open({ [SKIP]: () => refusal(409, 'STATE_CONFLICT') });
      await user.selectOptions(await form(), 'RUN_CUT_SHORT');
      await user.click(screen.getByRole('button', { name: 'Skip this stop' }));
      const dialog = screen.getByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Skip the stop' }));
      expect(
        await within(dialog).findByRole('button', { name: 'Reload the record' }),
      ).toBeVisible();
    },
  },
  success: {
    test: async () => {
      open();
      await form();
    },
  },
  'permission-restricted': {
    test: async () => {
      open({ [STOP]: () => refusal(403, 'PERMISSION_DENIED') });
      expect(await screen.findByText(/pickup\.read/)).toBeVisible();
    },
  },
});
