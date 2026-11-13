import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import {
  PICKUP_HUB_ID,
  cancellationReasonFixture,
  pickupRequestFixture,
} from '../../../test-support/pickup-fixture';
import {
  WORK_REQUEST_ID,
  WORK_STOP_ID,
  failureFixture,
} from '../../../test-support/pickup-work-fixture';
import { renderApp } from '../../../test-support/render-app';
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/pickup-failures` (`listPickupFailures`; S1.30). The failure decision queue of the hubs of the grant, as the server lists it: oldest failure first, the three views its `open` filter makes, every
 * field section 17.3 makes mandatory as the server gave it (the wait is the database's; the escalation is the ledger's), and the four acts of the office in the panel of a row, over the version of
 * the request as it is read. **The server filters**: the page asks, in the address and in the request, and draws what comes back whole.
 */
const LIST = 'GET /pickup-failures';
const READ = `GET /pickup-requests/${WORK_REQUEST_ID}`;
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OTHER_STOP = '4ace3f4a-5b6c-4d7e-8f8a-9b0c1d2e3f4a';
const OTHER_REQUEST = '5bdf4a5b-6c7d-4e8f-8a9b-0c1d2e3f4a5b';

/** What an officer of the hub holds for this queue: the key of the queue and of the cancellation. */
const OFFICER = ['pickup.read', 'pickup.failure.resolve', 'pickup.request.cancel'];
const SENIOR = [...OFFICER, 'pickup.attempt.extend'];

const waiting = failureFixture();
const escalated = failureFixture({
  pickup_stop_id: OTHER_STOP,
  pickup_request_id: OTHER_REQUEST,
  request_code: 'ACC-PR-9XM4TQ',
  sender_name: 'Kente Traders',
  decision: 'ESCALATED',
  waiting_seconds: 90_000,
  escalated_at: '2026-11-05T09:00:00Z',
  escalation: { by: 'BACKSTOP', threshold_hours: 24, waited_seconds: 86_400 },
});

const page = (items: unknown[], next: string | null = null): Response =>
  json(200, { items, next_page_token: next });

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  handler: Handler = () => page([waiting, escalated]),
  keys: readonly string[] = OFFICER,
  handlers: Record<string, Handler> = {},
  path = '/pickup-failures',
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: PICKUP_HUB_ID, display_name: 'Accra Central' }],
      }),
      { [LIST]: handler, ...handlers },
    ),
  );
  return renderApp(path);
}

const table = async (): Promise<HTMLElement> => {
  const found = await screen.findByRole('table', { name: 'Failed pickups' });
  await waitFor(() => {
    expect(found).not.toHaveAttribute('aria-busy', 'true');
  });
  return found;
};
const alertSaying = async (text: string | RegExp): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });
  return screen.getByRole('alert');
};
const asked = () =>
  api.requests.filter((request) => new URL(request.url).pathname === '/api/v1/pickup-failures');
const queryOf = (index = -1) => new URL(asked().at(index)?.url ?? 'http://x/').searchParams;
const sent = (route: string) =>
  api.requests.filter(
    (request) =>
      `${request.method} ${new URL(request.url).pathname.replace(/^\/api\/v1/, '')}` === route,
  );
const request = (version = 'v1', overrides: Record<string, unknown> = {}): Response =>
  json(
    200,
    pickupRequestFixture({ id: WORK_REQUEST_ID, state: 'CONFIRMED', ...overrides }),
    etag(version),
  );

/** A row is opened by its button: the panel beside the list then holds the record. */
async function openRow(user: UserEvent, code = 'ACC-PR-7KQ2MZ', sender = 'Demo Fabrics Ltd') {
  await table();
  await user.click(screen.getByRole('button', { name: `Open ${code}, ${sender}` }));
  return screen.findByRole('region', { name: `Details of ${code}` });
}

describe('the failed pickups: what the queue shows', () => {
  it('shows each failure by its code, sender, why, wait and decision, in the order the server gave', async () => {
    open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Failed pickups' })).toBeVisible();
    expect(document.title).toBe('Failed pickups · Melarc Ops Portal');
    const rows = within(await table()).getAllByRole('rowheader');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('ACC-PR-7KQ2MZ'),
      expect.stringContaining('ACC-PR-9XM4TQ'),
    ]);
    const first = rows[0]?.closest('tr');
    expect(first).not.toBeNull();
    const row = within(first as HTMLElement);
    expect(row.getByText('The vendor was not available')).toBeVisible();
    expect(row.getByText('The vendor was not at the pickup point')).toBeVisible();
    expect(row.getByText('2 h')).toBeVisible();
    expect(row.getByText('Waiting for Ops')).toBeVisible();
    expect(row.getByText('Accra Central')).toBeVisible();
  });

  // Break caught: a wait worked out by the page (the clock of the browser) and not the database's figure.
  it('tells the wait as the server stated it, and works out no time', async () => {
    open(() => page([failureFixture({ waiting_seconds: 93_784 })]));

    const row = within((await table()).querySelector('tbody') as HTMLElement);
    expect(row.getByText('1 d 2 h')).toBeVisible();
  });

  // Break caught: a decision told as the raw enum, or an escalation by the backstop told with no threshold and no wait (section 17.3 makes them mandatory beside the moment).
  it('tells the decision in words and an escalation by the backstop with the threshold and the wait', async () => {
    open();

    const row = within((await screen.findByText('ACC-PR-9XM4TQ')).closest('tr') as HTMLElement);
    expect(row.getByText('Escalated, still waiting')).toBeVisible();
    expect(
      row.getByText(
        'Escalated by the backstop: it had passed the limit of 24 hours and it had waited 1 d.',
      ),
    ).toBeVisible();
    expect(screen.queryByText('ESCALATED')).toBeNull();
    expect(screen.queryByText('PENDING')).toBeNull();
  });

  it('asks the server for the waiting view and filters nothing itself', async () => {
    open();
    await table();

    expect(queryOf().get('open')).toBe('true');
    expect(queryOf().has('hub_id')).toBe(false);
  });

  // Break caught: a view that filters in the browser (the part of a page that matched would pass for the whole), or one that sends the wrong filter.
  it.each([
    ['decided', 'false'],
    ['all', null],
  ])('asks the server for the %s view with open=%s', async (view, open_) => {
    open(
      () => page([failureFixture({ decision: 'CANCELLED', request_state: 'CANCELLED' })]),
      OFFICER,
      {},
      `/pickup-failures?view=${view}`,
    );
    await table();

    expect(queryOf().get('open')).toBe(open_);
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent(
      view === 'decided' ? 'Decided' : 'All',
    );
  });

  it('changes view in the address and asks again from the first page', async () => {
    const { user } = open(() => page([waiting], 'next-1'));
    await table();

    await user.click(screen.getByRole('tab', { name: 'Decided' }));

    await waitFor(() => {
      expect(queryOf().get('open')).toBe('false');
    });
    expect(queryOf().has('page_token')).toBe(false);
  });

  it('pages by the server’s token, asking for the next page under the same filter', async () => {
    const { user } = open((request_) =>
      new URL(request_.url).searchParams.get('page_token') === 'next-1'
        ? page([escalated])
        : page([waiting], 'next-1'),
    );
    await table();
    expect(screen.getByText(/Showing 1 failed pickup/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: /Next/ }));

    expect(await screen.findByText('ACC-PR-9XM4TQ')).toBeVisible();
    expect(queryOf().get('page_token')).toBe('next-1');
    expect(queryOf().get('open')).toBe('true');
  });
});

describe('a failure opened beside the queue', () => {
  // Break caught: a field section 17.3 makes mandatory missing from the record: the category, the reason, the rider's note, the contact attempts, the attempt, the photos, the wait, the escalation.
  it('shows every field of section 17.3 as the server gave it, and nothing worked out', async () => {
    const { user } = open(
      () =>
        page([
          failureFixture({
            note: 'Gate locked.',
            photo_count: 3,
            attempt_number: 2,
            attempt_extended: true,
            contact_attempts: [
              { method: 'PHONE_CALL', attempted_at: '2026-11-04T09:10:00Z', outcome: 'No answer' },
              {
                method: 'SMS',
                attempted_at: '2026-11-04T09:11:00Z',
                outcome: 'Sent',
                note: 'Twice',
              },
            ],
          }),
        ]),
      OFFICER,
      { [READ]: () => request() },
    );
    const panel = within(await openRow(user));

    expect(panel.getByText('The vendor was not available')).toBeVisible();
    expect(panel.getByText('The vendor was not at the pickup point')).toBeVisible();
    expect(panel.getByText('Gate locked.')).toBeVisible();
    expect(panel.getByText('2 h')).toBeVisible();
    expect(panel.getByText('Attempt 2, extended by Senior Ops')).toBeVisible();
    expect(panel.getByText(/3 photos\./)).toBeVisible();
    expect(panel.getByRole('link', { name: 'Open the stop to see them' })).toHaveAttribute(
      'href',
      expect.stringContaining(`/stops/${WORK_STOP_ID}`),
    );
    expect(panel.getByText('Not escalated.')).toBeVisible();
    const attempts = within(panel.getByRole('region', { name: 'Contact attempts' }));
    expect(attempts.getAllByRole('listitem')).toHaveLength(2);
    expect(attempts.getByText('Phone call')).toBeVisible();
    expect(attempts.getByText('Twice')).toBeVisible();
  });

  it('tells a failure the rider attached no photo to as that, and a note that is missing as that', async () => {
    const { user } = open(
      () => page([failureFixture({ note: null, photo_count: 0, contact_attempts: [] })]),
      OFFICER,
      {
        [READ]: () => request(),
      },
    );
    const panel = within(await openRow(user));

    expect(panel.getByText('The rider attached no photo.')).toBeVisible();
    expect(panel.getByText('The rider left no note.')).toBeVisible();
    expect(panel.getByText('The rider recorded no attempt to reach the sender.')).toBeVisible();
  });

  // Break caught: the retryability, the cap or a vendor dispute drawn: the read has no field for the first two and the surface offers no dispute of a failure.
  it('draws no retryability, no state of the cap and no dispute', async () => {
    const { user } = open(undefined, SENIOR, { [READ]: () => request() });
    const panel = within(await openRow(user));
    await panel.findByRole('button', { name: 'Reschedule' });

    expect(
      within(screen.getByRole('main')).queryByText(/retry|retryable|cap\b|limit reached|dispute/i),
    ).toBeNull();
  });

  it('offers the four acts to a session that holds their keys, and only those', async () => {
    const { user } = open(undefined, SENIOR, { [READ]: () => request() });
    const panel = within(await openRow(user));

    for (const name of ['Reschedule', 'Escalate', 'Extend the attempts', 'Cancel the pickup']) {
      expect(await panel.findByRole('button', { name })).toBeVisible();
    }
  });

  it('offers neither the extension nor the cancellation to a session that holds only the queue’s key', async () => {
    const { user } = open(undefined, ['pickup.read', 'pickup.failure.resolve'], {
      [READ]: () => request(),
    });
    const panel = within(await openRow(user));

    expect(await panel.findByRole('button', { name: 'Escalate' })).toBeVisible();
    expect(panel.queryByRole('button', { name: 'Reschedule' })).toBeNull();
    expect(panel.queryByRole('button', { name: 'Cancel the pickup' })).toBeNull();
    expect(panel.queryByRole('button', { name: 'Extend the attempts' })).toBeNull();
    expect(
      panel.getByText('Your account can’t cancel a pickup. Ask an administrator for access.'),
    ).toBeVisible();
  });

  it('offers no escalation for a failure that was escalated already, and says what that did', async () => {
    const { user } = open(() => page([escalated]), OFFICER, {
      [`GET /pickup-requests/${OTHER_REQUEST}`]: () =>
        json(200, pickupRequestFixture({ id: OTHER_REQUEST, state: 'CONFIRMED' }), etag('v1')),
    });
    const panel = within(await openRow(user, 'ACC-PR-9XM4TQ', 'Kente Traders'));

    expect(await panel.findByRole('button', { name: 'Reschedule' })).toBeVisible();
    expect(panel.queryByRole('button', { name: 'Escalate' })).toBeNull();
    expect(panel.getByText(/It is escalated already/)).toBeVisible();
  });

  // Break caught: an escalation sent without the version read, under a key that is not fresh, or with the note under another name; and a list that is not read again after the act.
  it('escalates with a note, on the version read, under a fresh key, and reads the queue again', async () => {
    const { user } = open(undefined, OFFICER, {
      [READ]: () => request('v7'),
      [`POST /pickup-requests/${WORK_REQUEST_ID}/escalate`]: () =>
        request('v8', { escalated_at: '2026-11-04T11:00:00Z' }),
    });
    const panel = within(await openRow(user));

    await user.click(await panel.findByRole('button', { name: 'Escalate' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Escalate this request?' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why it is escalated/ }),
      'Refused at the door twice',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Escalate the request' }));

    expect(
      await screen.findByText(
        'The request ACC-PR-7KQ2MZ is escalated. It still waits for a decision.',
      ),
    ).toBeVisible();
    const [act] = sent(`POST /pickup-requests/${WORK_REQUEST_ID}/escalate`);
    expect(act?.headers.get('If-Match')).toBe('"v7"');
    expect(act?.headers.get('Idempotency-Key')).toMatch(KEY);
    expect(await act?.clone().json()).toEqual({ note: 'Refused at the door twice' });
    await waitFor(() => {
      expect(asked().length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: /^Details of / })).toBeNull();
    });
  });

  it('extends the attempts with a reason, for a holder of the senior key', async () => {
    const { user } = open(undefined, SENIOR, {
      [READ]: () => request('v3'),
      [`POST /pickup-requests/${WORK_REQUEST_ID}/attempt-extension`]: () => request('v4'),
    });
    const panel = within(await openRow(user));

    await user.click(await panel.findByRole('button', { name: 'Extend the attempts' }));
    const dialog = screen.getByRole('alertdialog', {
      name: 'Extend the attempts of this request?',
    });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why the attempts are extended/ }),
      'The vendor asked for one more',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Allow one further attempt' }));

    expect(await screen.findByText(/The attempts of ACC-PR-7KQ2MZ are extended/)).toBeVisible();
    const [act] = sent(`POST /pickup-requests/${WORK_REQUEST_ID}/attempt-extension`);
    expect(act?.headers.get('If-Match')).toBe('"v3"');
    expect(await act?.clone().json()).toEqual({ reason: 'The vendor asked for one more' });
  });

  // Break caught: a version that was not the request's now: a conflict is explained and read again, and never an overwrite.
  it('explains a request that changed and reads the queue again', async () => {
    const { user } = open(undefined, OFFICER, {
      [READ]: () => request('v1'),
      [`POST /pickup-requests/${WORK_REQUEST_ID}/escalate`]: () => refusal(409, 'STATE_CONFLICT'),
    });
    const panel = within(await openRow(user));

    await user.click(await panel.findByRole('button', { name: 'Escalate' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Escalate this request?' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why it is escalated/ }),
      'Refused',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Escalate the request' }));

    expect(await within(dialog).findByText(/changed/i)).toBeVisible();
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  it('says what was decided for a decided failure, links the replacement, and offers no act', async () => {
    const decided = failureFixture({
      decision: 'RESCHEDULED',
      request_state: 'CANCELLED',
      decided_at: '2026-11-04T12:00:00Z',
      replacement_request_id: OTHER_REQUEST,
      waiting_seconds: 10_800,
    });
    const { user } = open(() => page([decided]), SENIOR, {}, '/pickup-failures?view=decided');
    const panel = within(await openRow(user));

    expect(panel.getByText(/The pickup was rescheduled/)).toBeVisible();
    expect(panel.getByRole('link', { name: 'Open the new request' })).toHaveAttribute(
      'href',
      `/pickup-requests/${OTHER_REQUEST}`,
    );
    expect(panel.getByText('Waited')).toBeVisible();
    expect(panel.queryByRole('button', { name: 'Reschedule' })).toBeNull();
    expect(sent(READ)).toHaveLength(0);
  });

  it('tells a request that is no longer confirmed as that, with no acts', async () => {
    const { user } = open(undefined, OFFICER, {
      [READ]: () => request('v2', { state: 'CANCELLED' }),
    });
    const panel = within(await openRow(user));

    expect(await panel.findByText(/no longer confirmed/)).toBeVisible();
    expect(panel.queryByRole('button', { name: 'Escalate' })).toBeNull();
  });
});

describe('rescheduling and cancelling a failed pickup', () => {
  const REASONS = 'GET /reason-definitions';
  const CANCEL = `POST /pickup-requests/${WORK_REQUEST_ID}/cancel`;
  const catalogue = () => json(200, [cancellationReasonFixture()]);
  const cancelled = (version: string, overrides: Record<string, unknown> = {}): Response =>
    json(
      200,
      pickupRequestFixture({ id: WORK_REQUEST_ID, state: 'CANCELLED', ...overrides }),
      etag(version),
    );

  // Break caught: a reschedule sent without the new attempt (create_replacement), on a version that is not the one read, under a key that is not fresh, or one that does not lead to the new request.
  it('reschedules with create_replacement on the version read under a fresh key, and links the new request', async () => {
    const { user } = open(undefined, OFFICER, {
      [READ]: () => request('v4'),
      [REASONS]: catalogue,
      [CANCEL]: () => cancelled('v5', { replacement_request_id: OTHER_REQUEST }),
    });
    const panel = within(await openRow(user));

    await user.click(await panel.findByRole('button', { name: 'Reschedule' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Reschedule this pickup?' });
    await user.selectOptions(
      await within(dialog).findByRole('combobox', { name: /^Reason/ }),
      'DEMO_CUSTOMER_CHANGED_MIND',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reschedule the pickup' }));

    expect(
      await screen.findByText(
        'The pickup ACC-PR-7KQ2MZ is rescheduled: its request is cancelled and its next attempt is booked.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open the new request' })).toHaveAttribute(
      'href',
      `/pickup-requests/${OTHER_REQUEST}`,
    );
    const [act] = sent(CANCEL);
    expect(act?.headers.get('If-Match')).toBe('"v4"');
    expect(act?.headers.get('Idempotency-Key')).toMatch(KEY);
    expect(await act?.clone().json()).toMatchObject({
      reason_code: 'DEMO_CUSTOMER_CHANGED_MIND',
      create_replacement: true,
    });
  });

  // Break caught: a cancellation that books a new attempt, or one sent on the wrong version.
  it('cancels without a replacement', async () => {
    const { user } = open(undefined, OFFICER, {
      [READ]: () => request('v2'),
      [REASONS]: catalogue,
      [CANCEL]: () => cancelled('v3'),
    });
    const panel = within(await openRow(user));

    await user.click(await panel.findByRole('button', { name: 'Cancel the pickup' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel this pickup request?' });
    await user.selectOptions(
      await within(dialog).findByRole('combobox', { name: /Reason/ }),
      'DEMO_CUSTOMER_CHANGED_MIND',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the request' }));

    expect(await screen.findByText('The request ACC-PR-7KQ2MZ is cancelled.')).toBeVisible();
    const [act] = sent(CANCEL);
    expect(act?.headers.get('If-Match')).toBe('"v2"');
    expect(await act?.clone().json()).toMatchObject({ create_replacement: false });
  });

  // Break caught: the cap told as a generic failure, or as if the request had been cancelled (the surface says the cap is "told as it is" by the refusal, never drawn as a state).
  it('tells the cap as the refusal says it, and nothing was cancelled', async () => {
    const { user } = open(() => page([failureFixture({ attempt_number: 3 })]), OFFICER, {
      [READ]: () => request('v2'),
      [REASONS]: catalogue,
      [CANCEL]: () => refusal(422, 'PICKUP_ATTEMPT_LIMIT_REACHED'),
    });
    const panel = within(await openRow(user));

    await user.click(await panel.findByRole('button', { name: 'Reschedule' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Reschedule this pickup?' });
    await user.selectOptions(
      await within(dialog).findByRole('combobox', { name: /^Reason/ }),
      'DEMO_CUSTOMER_CHANGED_MIND',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reschedule the pickup' }));

    const alert = await within(dialog).findByRole('alert');
    expect(within(alert).getByText(/^Nothing was cancelled/)).toBeVisible();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    expect(screen.queryByText(/is rescheduled/)).toBeNull();
  });
});

describeInterfaceStates('the failed pickups queue', {
  loading: {
    test: async () => {
      open(() => new Promise<Response>(() => undefined));
      expect(await screen.findByText('Loading failed pickups')).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      open(() => page([]));
      expect(await screen.findByRole('heading', { name: 'No failed pickups yet' })).toBeVisible();
      expect(
        screen.getByText(/A failed pickup appears here when a rider reports one/),
      ).toBeVisible();
    },
  },
  'validation error': {
    test: async () => {
      open(() =>
        refusal(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'query', pointer: '/open', rule: 'type' }],
        }),
      );
      await alertSaying('That filter was not accepted. Choose one of the views of the list.');
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  error: {
    test: async () => {
      open(() => refusal(500, 'INTERNAL_ERROR'));
      await alertSaying('The failed pickups could not be loaded.');
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open(() => {
        attempts += 1;
        return attempts === 1 ? refusal(503, 'SERVICE_UNAVAILABLE') : page([waiting]);
      });
      await alertSaying(/could not be loaded/);
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText('ACC-PR-7KQ2MZ')).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      // A request that changed under the officer is explained in the act's dialog, and a read of the queue again that fails leaves the rows under a line that says they may be out of date.
      let reads = 0;
      const { user } = open(
        () => {
          reads += 1;
          return reads === 1 ? page([waiting]) : refusal(500, 'INTERNAL_ERROR');
        },
        OFFICER,
        {
          [READ]: () => request(),
          [`POST /pickup-requests/${WORK_REQUEST_ID}/escalate`]: () => request('v2'),
        },
      );
      const panel = within(await openRow(user));
      await user.click(await panel.findByRole('button', { name: 'Escalate' }));
      const dialog = screen.getByRole('alertdialog', { name: 'Escalate this request?' });
      await user.type(
        within(dialog).getByRole('textbox', { name: /Why it is escalated/ }),
        'Refused',
      );
      await user.click(within(dialog).getByRole('button', { name: 'Escalate the request' }));

      expect(
        await screen.findByText(
          'The failed pickups could not be read again, so these rows may be out of date.',
        ),
      ).toBeVisible();
      expect(within(await table()).getByText('ACC-PR-7KQ2MZ')).toBeVisible();
    },
  },
  success: {
    test: async () => {
      open();
      expect(await screen.findByText('ACC-PR-7KQ2MZ')).toBeVisible();
      expect(screen.getByText('Waiting for Ops')).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(() => refusal(403, 'PERMISSION_DENIED'));
      await alertSaying(
        'Your account can’t escalate or reschedule a failed pickup. Ask an administrator for access.',
      );
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
});
