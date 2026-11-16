import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  DECLARED,
  INTAKE_HUB_ID,
  INTAKE_ID,
  INTAKE_RECEIVER_ID,
  PLANTED_DECLARATION,
  preCountFixture,
  postCountFixture,
  shortCountFixture,
} from '../../../test-support/hub-intake-fixture';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { renderApp } from '../../../test-support/render-app';
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/intakes/{id}/count` (`getHubIntake`, `acquireIntakeLock`, `submitBlindCount`; S1.35). **The blind page.** The rider's declared count is on it in no form: the intake it reads is one that has not been counted,
 * whose shape has no place for the declaration and refuses an answer that carries one, and the form takes the physical count and sends that and nothing else. Opening the page takes the receiver's advisory lock;
 * another receiver's is told as what it is (who is working, never a gate). `STATE_CONFLICT` says what happened and what to do instead of a bare failure.
 */
const PATH = `/intakes/${INTAKE_ID}/count`;
const GET = `GET /hub-intakes/${INTAKE_ID}`;
const LOCK = `POST /hub-intakes/${INTAKE_ID}/lock`;
const COUNT = `POST /hub-intakes/${INTAKE_ID}/count`;
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECEIVER = ['hub.read', 'hub.intake.count'];

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  handlers: Record<string, Handler> = {},
  keys: readonly string[] = RECEIVER,
  path = PATH,
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: INTAKE_HUB_ID, display_name: 'Accra Central' }],
      }),
      {
        [GET]: () => json(200, preCountFixture(), etag('v3')),
        [LOCK]: () => json(200, preCountFixture()),
        ...handlers,
      },
    ),
  );
  return renderApp(path);
}

/** The count's answer, after which the intake reads as counted (the record the officer is taken to reads it again). */
const counting =
  (answer: object): Handler =>
  () => {
    api.on(GET, () => json(200, answer, etag('v4')));
    return json(200, answer, etag('v4'));
  };

const sentCounts = () =>
  api.requests.filter((request) => request.method === 'POST' && request.url.endsWith('/count'));
const locks = () => api.requests.filter((request) => request.url.endsWith('/lock'));
const alertSaying = async (text: string | RegExp): Promise<void> => {
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
};

async function enter(user: UserEvent, count: string): Promise<void> {
  const field = await screen.findByRole('textbox', { name: /Parcels counted/ });
  await user.clear(field);
  if (count !== '') await user.type(field, count);
  await user.click(screen.getByRole('button', { name: 'Review the count' }));
}

async function enterAndReview(user: UserEvent, count: string): Promise<HTMLElement> {
  await enter(user, count);
  return screen.findByRole('alertdialog');
}

describe('the blind page', () => {
  it('asks for the physical count alone, in words that say it is blind, and takes the lock of the receiver', async () => {
    open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Count the parcels' }),
    ).toBeVisible();
    expect(document.title).toBe('Count the parcels · Melarc Ops Portal');
    expect(
      await screen.findByText(
        'Intake ACC-IN-7KQ2MZ. Count what has been handed over, then enter the number.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('textbox', { name: /Parcels counted/ })).toHaveValue('');
    expect(
      screen.getByText(/The count is blind: the number the rider declared is not shown to you/),
    ).toBeVisible();
    await waitFor(() => {
      expect(locks()).toHaveLength(1);
    });
    expect(locks()[0]?.headers.get('Idempotency-Key')).toBeNull();
  });

  // Break caught: the rider's declaration in any form on this page, whatever the answers carried: not in the text, an attribute, a title, an accessible name, a field's value, or a tooltip.
  it('has the declaration in no form: an answer that carries it is refused whole, and the number is nowhere on the page', async () => {
    open({
      [GET]: () =>
        json(200, { ...preCountFixture(), rider_declared_count: PLANTED_DECLARATION }, etag('v3')),
      [LOCK]: () => json(200, { ...preCountFixture(), rider_declared_count: PLANTED_DECLARATION }),
    });

    await alertSaying('This intake could not be loaded.');
    expect(screen.queryByRole('textbox', { name: /Parcels counted/ })).toBeNull();
    expect(document.documentElement.outerHTML).not.toContain(String(PLANTED_DECLARATION));
    expect(document.title).not.toContain(String(PLANTED_DECLARATION));
  });

  it('has no number in the field, in any attribute, until the receiver types one', async () => {
    open();
    const field = await screen.findByRole('textbox', { name: /Parcels counted/ });

    expect(field).toHaveValue('');
    expect(field).not.toHaveAttribute('placeholder');
    expect(field).not.toHaveAttribute('defaultValue');
    expect(field.getAttribute('title')).toBeNull();
    expect(document.documentElement.outerHTML).not.toMatch(/value="\d/);
  });
});

describe('the count', () => {
  // Break caught: a count sent with anything but the physical count (a declaration, a total), without the version read, without a fresh key, or without the confirmation that says it is recorded once.
  it('reviews the count, then sends the physical count alone under a fresh key and the version read, and shows the comparison', async () => {
    const { user } = open({
      [COUNT]: counting(shortCountFixture({ physical_count: 5, count_difference: -2 })),
    });

    const dialog = within(await enterAndReview(user, '5'));
    expect(dialog.getByText(/It is recorded once and cannot be changed here/)).toBeVisible();
    expect(sentCounts()).toHaveLength(0);
    await user.click(dialog.getByRole('button', { name: 'Record the count' }));

    await waitFor(() => {
      expect(sentCounts()).toHaveLength(1);
    });
    const [act] = sentCounts();
    expect(act?.headers.get('Idempotency-Key')).toMatch(KEY);
    expect(await act?.clone().json()).toEqual({ physical_count: 5 });
    // The version of the read is the version of the act (the first read was `v3`; the page does not read it again).
    expect(act?.headers.get('If-Match')).toBe('"v3"');

    expect(await screen.findByRole('heading', { level: 1, name: 'ACC-IN-7KQ2MZ' })).toBeVisible();
    expect(await screen.findByText(`${String(DECLARED)} parcels`)).toBeVisible();
    expect(screen.getByText('5 parcels')).toBeVisible();
    expect(
      screen.getByText('The count is 2 parcels short of what the rider declared.'),
    ).toBeVisible();
    expect(
      screen.getByText(
        'Your count is recorded. The number the rider declared is shown below, with the comparison.',
      ),
    ).toBeVisible();
  });

  // Break caught: a count of zero refused as empty (a rider may have declared parcels that never arrived), or an empty field sent as zero.
  it('sends a count of zero as zero, and an empty field as nothing', async () => {
    const { user } = open({
      [COUNT]: () =>
        json(
          200,
          postCountFixture({
            rider_declared_count: 4,
            physical_count: 0,
            count_variance: 'SHORT',
            count_difference: -4,
            state: 'RECONCILIATION_REQUIRED',
          }),
          etag('v4'),
        ),
    });

    await enter(user, '');
    expect(
      await screen.findByText('Enter the number of parcels you counted, as a whole number from 0.'),
    ).toBeVisible();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(sentCounts()).toHaveLength(0);

    const dialog = within(await enterAndReview(user, '0'));
    await user.click(dialog.getByRole('button', { name: 'Record the count' }));
    await waitFor(() => {
      expect(sentCounts()).toHaveLength(1);
    });
    expect(await sentCounts()[0]?.clone().json()).toEqual({ physical_count: 0 });
  });

  // Break caught: a limit on the parcels of an intake that comes back in the form (a count of any size the platform can hold is reviewed and sent as typed, never clamped or refused): the sizes are
  // examples spread across scales, up to the largest whole number the database holds.
  it.each(['7', '101', '25000', '12345678', '2147483647'])(
    'reviews and sends a count of %s as typed',
    async (typed) => {
      const counted = Number(typed);
      const { user } = open({
        [COUNT]: counting(
          shortCountFixture({ physical_count: counted, count_difference: counted - 3 }),
        ),
      });

      const dialog = within(await enterAndReview(user, typed));
      await user.click(dialog.getByRole('button', { name: 'Record the count' }));
      await waitFor(() => {
        expect(sentCounts()).toHaveLength(1);
      });
      expect(await sentCounts()[0]?.clone().json()).toEqual({ physical_count: Number(typed) });
    },
  );

  // Break caught: a count that is not a whole number from zero reviewed or sent, or one that no database could keep (the bound is the one of representation, not of parcels).
  it.each(['-1', '2.5', 'abc', '1e3', '١٢', '2147483648', '99999999999'])(
    'refuses %s at the field and sends nothing',
    async (typed) => {
      const { user } = open();

      await enter(user, typed);

      expect(
        await screen.findByText(
          'Enter the number of parcels you counted, as a whole number from 0.',
        ),
      ).toBeVisible();
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(sentCounts()).toHaveLength(0);
    },
  );

  // Break caught: a lost answer that is tried again under another key (a second count) or that offers no way to try again.
  it('keeps the same key when the outcome is not known, and tries again under it', async () => {
    let calls = 0;
    const answer = counting(shortCountFixture({ physical_count: 5, count_difference: -2 }));
    const { user } = open({
      [COUNT]: (request) => {
        calls += 1;
        return calls === 1 ? Promise.reject(new TypeError('Failed to fetch')) : answer(request);
      },
    });

    const dialog = within(await enterAndReview(user, '5'));
    await user.click(dialog.getByRole('button', { name: 'Record the count' }));
    expect(await dialog.findByText(/We could not confirm whether this was done/)).toBeVisible();
    await user.click(dialog.getByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(sentCounts()).toHaveLength(2);
    });
    expect(sentCounts()[0]?.headers.get('Idempotency-Key')).toBe(
      sentCounts()[1]?.headers.get('Idempotency-Key'),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'ACC-IN-7KQ2MZ' })).toBeVisible();
  });
});

describe('the lock is advisory', () => {
  it('says a lock the receiver holds is theirs, and keeps it while the page is open', async () => {
    open({
      [LOCK]: () =>
        json(
          200,
          preCountFixture({
            active_receiver_id: '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
            lock_acquired_at: '2026-11-14T09:10:00Z',
          }),
        ),
    });

    expect(await screen.findByText('Held by you')).toBeVisible();
    expect(screen.getByText('You hold the lock on this intake.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull();
  });

  // Break caught: another receiver's lock told as a gate: the form taken away, or the words that imply a count is refused for it.
  it('tells that another receiver holds it, never names them, keeps the form, and says a lock stops nobody', async () => {
    open({
      [LOCK]: () =>
        json(
          200,
          preCountFixture({
            active_receiver_id: INTAKE_RECEIVER_ID,
            lock_acquired_at: '2026-11-14T09:10:00Z',
          }),
        ),
    });

    expect(await screen.findByText('Held by someone else')).toBeVisible();
    expect(screen.getByText('Another receiver holds the lock on this intake.')).toBeVisible();
    expect(screen.getByText(/Last active 14 Nov, 09:10\./)).toBeVisible();
    expect(
      screen.getByText(
        /It never stops a second count: if two receivers count, the first count is kept and the other is refused\./,
      ),
    ).toBeVisible();
    expect(screen.getByRole('textbox', { name: /Parcels counted/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Review the count' })).toBeEnabled();
    expect(document.body.textContent).not.toContain(INTAKE_RECEIVER_ID);
  });

  // Break caught: "ask again" that does nothing, that is answered as if it had taken the lock, or that does not say the server grants it only after the idle time.
  it('asks again when asked, and says the server grants it only after the other receiver has been idle', async () => {
    const { user } = open({
      [LOCK]: () =>
        json(
          200,
          preCountFixture({
            active_receiver_id: INTAKE_RECEIVER_ID,
            lock_acquired_at: '2026-11-14T09:10:00Z',
          }),
        ),
    });

    expect(
      await screen.findByText(/only once they have been idle for the hub’s idle time/),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Ask again' }));

    await waitFor(() => {
      expect(locks()).toHaveLength(2);
    });
    expect(await screen.findByText(/Asked again\. Another receiver still holds it/)).toBeVisible();
  });

  it('says the lock could not be confirmed when it cannot, and still lets the receiver count', async () => {
    open({ [LOCK]: () => refusal(503, 'SERVICE_UNAVAILABLE') });

    expect(await screen.findByText('Not known')).toBeVisible();
    expect(
      screen.getByText(/The page could not tell whether another receiver is counting this intake/),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Review the count' })).toBeEnabled();
  });
});

describe('two receivers who count', () => {
  // Break caught (surfaces/ops-portal.md section 9): the second receiver given a bare failure: the words say another receiver counted first, that nothing was changed by theirs, and where the count is.
  it('tells the second receiver that another counted first, that their count was not kept, and where to look', async () => {
    const { user } = open({
      [COUNT]: () => refusal(409, 'STATE_CONFLICT', { rule: 'already_counted' }),
    });

    const dialog = within(await enterAndReview(user, '5'));
    await user.click(dialog.getByRole('button', { name: 'Record the count' }));

    expect(
      await dialog.findByText(
        /Another receiver counted this intake first, so your count was not kept and nothing was changed\./,
      ),
    ).toBeVisible();
    expect(
      dialog.getByText(
        /A lock only shows who is working; it never stops a second count, and the first one is kept\./,
      ),
    ).toBeVisible();
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    expect(dialog.getByRole('button', { name: 'Reload the record' })).toBeVisible();
  });

  it('reads the intake again on reload, and then says it has been counted and offers it, with no form', async () => {
    const { user } = open({
      [COUNT]: () => refusal(409, 'STATE_CONFLICT', { rule: 'already_counted' }),
    });
    const dialog = within(await enterAndReview(user, '5'));
    await user.click(dialog.getByRole('button', { name: 'Record the count' }));
    await dialog.findByText(/Another receiver counted this intake first/);
    api.on(GET, () =>
      json(200, shortCountFixture({ physical_count: 6, count_difference: -1 }), etag('v4')),
    );

    await user.click(dialog.getByRole('button', { name: 'Reload the record' }));

    expect(
      await screen.findByText(
        /This intake has been counted: another receiver’s count is the one that was recorded/,
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open the intake' })).toHaveAttribute(
      'href',
      `/intakes/${INTAKE_ID}`,
    );
    expect(screen.queryByRole('textbox', { name: /Parcels counted/ })).toBeNull();
  });

  it('tells a stale version in words, and offers to read it again', async () => {
    const { user } = open({ [COUNT]: () => refusal(409, 'STATE_CONFLICT', { rule: 'stale' }) });

    const dialog = within(await enterAndReview(user, '5'));
    await user.click(dialog.getByRole('button', { name: 'Record the count' }));

    expect(
      await dialog.findByText(
        /This intake changed after you opened it, so your count was not recorded\. Reload it to see where it stands, then count again if it is still waiting\./,
      ),
    ).toBeVisible();
    expect(dialog.getByRole('button', { name: 'Reload the record' })).toBeVisible();
  });

  // Break caught: a page that goes on counting an intake that was counted while it was open: the lock's own answer says so and the form is taken away.
  it('says the intake has been counted when the lock says so, and takes the form away', async () => {
    open({ [LOCK]: () => json(200, shortCountFixture()) });

    expect(
      await screen.findByText(
        /This intake has been counted: another receiver’s count is the one that was recorded/,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('textbox', { name: /Parcels counted/ })).toBeNull();
  });
});

describe('an intake that has been counted', () => {
  it('is told as counted, with its record offered, and asks for no lock', async () => {
    open({ [GET]: () => json(200, postCountFixture(), etag('v4')) });

    expect(await screen.findByText(/This intake has been counted/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open the intake' })).toBeVisible();
    expect(screen.queryByRole('textbox', { name: /Parcels counted/ })).toBeNull();
    expect(locks()).toHaveLength(0);
  });
});

describe('an intake the page cannot count', () => {
  it('tells an intake that is not there, and one that is not an id, without asking', async () => {
    open({ [GET]: () => refusal(404, 'NOT_FOUND') });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Intake not found' }),
    ).toBeVisible();
    api.restore();

    open({}, RECEIVER, '/intakes/not-an-id/count');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Intake not found' }),
    ).toBeVisible();
    expect(api.requests.filter((request) => request.url.includes('/hub-intakes/'))).toHaveLength(0);
  });

  it('tells an intake at a hub the account does not work in, in plain words', async () => {
    open({ [GET]: () => refusal(403, 'HUB_SCOPE_VIOLATION') });
    expect(await screen.findByText(/a hub your account does not work in/)).toBeVisible();
  });

  it('refuses a session without the key of the count, in plain words', async () => {
    open({}, ['hub.read']);
    expect(
      await screen.findByText(
        'Your account can’t count the parcels received at a hub. Ask an administrator for access.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('textbox', { name: /Parcels counted/ })).toBeNull();
    expect(locks()).toHaveLength(0);
  });
});

describeInterfaceStates('the blind count', {
  loading: {
    test: async () => {
      open({ [GET]: () => new Promise<Response>(() => undefined) });
      expect(await screen.findByText('Loading the intake…')).toBeVisible();
    },
  },
  empty: {
    inapplicable:
      'A record page is never empty: an intake that is not there is the not-found page, which another test shows.',
  },
  'validation error': {
    test: async () => {
      const { user } = open();
      await enter(user, 'abc');
      expect(
        await screen.findByText(
          'Enter the number of parcels you counted, as a whole number from 0.',
        ),
      ).toBeVisible();
    },
  },
  error: {
    test: async () => {
      open({ [GET]: () => refusal(500, 'INTERNAL_ERROR') });
      await alertSaying('This intake could not be loaded.');
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open({
        [GET]: () => {
          attempts += 1;
          return attempts === 1
            ? refusal(503, 'SERVICE_UNAVAILABLE')
            : json(200, preCountFixture(), etag('v3'));
        },
      });
      await alertSaying(/could not be loaded/);
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('textbox', { name: /Parcels counted/ })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const { user } = open({ [COUNT]: () => refusal(409, 'STATE_CONFLICT', { rule: 'stale' }) });
      const dialog = within(await enterAndReview(user, '5'));
      await user.click(dialog.getByRole('button', { name: 'Record the count' }));
      expect(await dialog.findByText(/changed after you opened it/)).toBeVisible();
    },
  },
  success: {
    test: async () => {
      const { user } = open({
        [COUNT]: counting(shortCountFixture({ physical_count: 5, count_difference: -2 })),
      });
      const dialog = within(await enterAndReview(user, '5'));
      await user.click(dialog.getByRole('button', { name: 'Record the count' }));
      expect(await screen.findByText(/Your count is recorded/)).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open({ [GET]: () => refusal(403, 'PERMISSION_DENIED') });
      expect(
        await screen.findByText(
          'Your account can’t see hub intakes. Ask an administrator for access.',
        ),
      ).toBeVisible();
    },
  },
});
