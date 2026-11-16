import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  DECLARED,
  INTAKE_CODE,
  INTAKE_HUB_ID,
  INTAKE_ID,
  INTAKE_RECEIVER_ID,
  PLANTED_DECLARATION,
  postCountFixture,
  preCountFixture,
} from '../../../test-support/hub-intake-fixture';
import {
  RUN_ID,
  checkInFixture,
  parcelFixture,
  photoLinkHandlers,
  photoVendorFixture,
  runFixture,
} from '../../../test-support/receiving-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/intakes/{id}/count` (`getHubIntake`, `submitBlindCount`; S1.35, D-D3): **the blind page, for a vendor whose parcels were not photographed at the door**, and the one place a number is typed. It keeps one line of its
 * own (*count first; the rider's number is shown after*); **the rider's number is on it in no form** and a read that carries it is refused whole; **the lock is taken on the first digit typed and never by opening the
 * page**, and another's is told as who opened this and when (never a name, never a gate); the count is reviewed, then recorded once on the version read and under a fresh key; two receivers are told what happened and
 * where to look; and **a vendor photographed at the door is never counted**: it is sent to its run's page, which says why.
 */
const READ = `GET /hub-intakes/${INTAKE_ID}`;
const LOCK = `POST /hub-intakes/${INTAKE_ID}/lock`;
const COUNT = `POST /hub-intakes/${INTAKE_ID}/count`;
const KEYS = ['hub.read', 'hub.intake.count'];
const ACCRA = { id: INTAKE_HUB_ID, display_name: 'Accra Hub' };
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const FORBIDDEN =
  /\b(?:intakes?|adjudicat\w*|itemi[sz]\w*|reconciliation|advisory|locks?\b(?! is)|the server)\b/i;
const V1 = { ETag: '"v1"' };
const V2 = { ETag: '"v2"' };
const ONE_LINE =
  'Count this vendor’s parcels on the table first. The rider’s number is shown only after you have typed yours.';
const FIELD_ERROR = 'Enter the number of parcels you counted, as a whole number from 0.';

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(handlers: Record<string, Handler> = {}, keys: readonly string[] = KEYS) {
  api = installFakeApi(
    staffApi(sessionWith(keys, { authorized_hubs: [ACCRA] }), {
      [READ]: () => json(200, preCountFixture(), V1),
      [LOCK]: () => json(200, preCountFixture()),
      ...handlers,
    }),
  );
  return renderApp(`/intakes/${INTAKE_ID}/count`);
}

const requestsTo = (route: string) =>
  api.requests.filter(
    (request) =>
      `${request.method} ${new URL(request.url).pathname}` ===
      `${route.split(' ')[0] ?? ''} /api/v1${route.split(' ')[1] ?? ''}`,
  );
const field = async (): Promise<HTMLElement> =>
  screen.findByRole('textbox', { name: /Parcels counted/ });
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

describe('the blind page', () => {
  it('asks for the number of parcels alone, in one line of its own, and takes no lock by being opened', async () => {
    open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Count the parcels' }),
    ).toBeVisible();
    expect(await field()).toHaveValue('');
    expect(screen.getByText(ONE_LINE)).toBeVisible();
    expect(requestsTo(LOCK)).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
  });

  // Break caught: a lock taken by opening the page, so that an officer who only looks is shown to others as counting.
  it('takes the lock on the first digit typed, once, and never again for the next', async () => {
    const { user } = open();
    await user.type(await field(), '12');

    await waitFor(() => {
      expect(requestsTo(LOCK)).toHaveLength(1);
    });
  });

  // Break caught: the rider's number drawn, hidden or sent along before the count: a read that carries it is refused whole, and the number is nowhere on the page.
  it('has the rider’s number in no form: a read that carries it is refused whole, and it is nowhere on the page', async () => {
    open({
      [READ]: () =>
        json(200, { ...preCountFixture(), rider_declared_count: PLANTED_DECLARATION }, V1),
    });
    await alertSaying('This vendor could not be loaded.');
    expect(document.body.innerHTML).not.toContain(String(PLANTED_DECLARATION));
    expect(screen.queryByRole('textbox', { name: /Parcels counted/ })).toBeNull();
  });

  it('has no number in the field, in any attribute, until the officer types one', async () => {
    open();
    expect(await field()).toHaveValue('');
    expect(document.body.innerHTML).not.toContain(String(PLANTED_DECLARATION));
    expect(document.body.innerHTML).not.toMatch(/placeholder="d/);
  });
});

describe('the count', () => {
  // Break caught: a count sent without the version read, under a key that is not fresh, or with more than the number of parcels in its body.
  it('reviews the count, then sends the number alone on the version read under a key, and brings the officer to the record', async () => {
    let reads = 0;
    const { user } = open({
      [READ]: () => {
        reads += 1;
        return reads === 1
          ? json(200, preCountFixture(), V1)
          : json(200, postCountFixture({ physical_count: DECLARED }), V2);
      },
      [COUNT]: () => json(200, postCountFixture({ physical_count: DECLARED }), V2),
    });
    await user.type(await field(), String(DECLARED));
    await user.click(screen.getByRole('button', { name: 'Review the count' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Record a count of 7 parcels?' });
    expect(within(dialog).getByText(/It is recorded once/)).toBeVisible();
    expect(requestsTo(COUNT)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Record the count' }));

    await waitFor(() => {
      expect(requestsTo(COUNT)).toHaveLength(1);
    });
    const [sent] = requestsTo(COUNT);
    expect(await sent?.clone().json()).toEqual({ physical_count: DECLARED });
    expect(sent?.headers.get('If-Match')).toBe('"v1"');
    expect(sent?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    // The record says what was done, and shows the rider's number now that it is counted.
    expect(
      await screen.findByText(
        'Your count is recorded. The rider’s number is shown below, with the comparison.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: INTAKE_CODE })).toBeVisible();
  });

  it('sends a count of zero as zero, and an empty field as nothing', async () => {
    const { user } = open({
      [COUNT]: () =>
        json(
          200,
          postCountFixture({
            state: 'RECONCILIATION_REQUIRED',
            physical_count: 0,
            count_variance: 'SHORT',
            count_difference: -DECLARED,
          }),
          V2,
        ),
    });
    await user.click(await screen.findByRole('button', { name: 'Review the count' }));
    expect(await screen.findByText(FIELD_ERROR)).toBeVisible();
    expect(requestsTo(COUNT)).toHaveLength(0);

    await user.type(await field(), '0');
    await user.click(screen.getByRole('button', { name: 'Review the count' }));
    await user.click(
      await within(
        await screen.findByRole('alertdialog', { name: 'Record a count of 0 parcels?' }),
      ).findByRole('button', { name: 'Record the count' }),
    );
    await waitFor(() => {
      expect(requestsTo(COUNT)).toHaveLength(1);
    });
    expect(await requestsTo(COUNT)[0]?.clone().json()).toEqual({ physical_count: 0 });
  });

  // Break caught: a number that is not a whole count (a sign, a fraction, an exponent, another script's digits, more than the platform holds) sent as a count.
  it.each(['-1', '2.5', 'abc', '1e3', '١٢', '2147483648', '99999999999'])(
    'refuses %s at the field and sends nothing',
    async (typed) => {
      const { user } = open();
      await user.type(await field(), typed);
      await user.click(screen.getByRole('button', { name: 'Review the count' }));

      expect(await screen.findByText(FIELD_ERROR)).toBeVisible();
      expect(requestsTo(COUNT)).toHaveLength(0);
      expect(screen.queryByRole('alertdialog')).toBeNull();
    },
  );

  it('cancels back to the vendor’s record', async () => {
    const { user } = open({
      [`GET /hub-intakes/${INTAKE_ID}`]: () => json(200, preCountFixture(), V1),
    });
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('heading', { level: 1, name: INTAKE_CODE })).toBeVisible();
  });
});

describe('the lock tells who is working and stops nobody', () => {
  // Break caught: another's lock told as a gate, or as a name, or in the words of the people who built it.
  it('tells that someone else opened this, when, never names them, and keeps the form', async () => {
    open({
      [READ]: () =>
        json(
          200,
          preCountFixture({
            active_receiver_id: INTAKE_RECEIVER_ID,
            lock_acquired_at: '2026-11-14T09:12:00Z',
          }),
          V1,
        ),
    });
    expect(
      await screen.findByText('Someone else opened this check-in at 09:12. It stops nobody.'),
    ).toBeVisible();
    expect(await field()).toBeEnabled();
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
  });

  // Break caught: a lock that could not be confirmed told as the officer's, or taken as a reason not to count.
  it('says when the page cannot check, and still lets the officer count', async () => {
    const { user } = open({ [LOCK]: () => refusal(500, 'INTERNAL_ERROR') });
    await user.type(await field(), '7');

    expect(
      await screen.findByText(/The page cannot check who else is checking this in right now/),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Review the count' })).toBeEnabled();
  });
});

describe('two officers who count', () => {
  async function countAnd(user: ReturnType<typeof open>['user']) {
    await user.type(await field(), '7');
    await user.click(screen.getByRole('button', { name: 'Review the count' }));
    await user.click(
      await within(await screen.findByRole('alertdialog')).findByRole('button', {
        name: 'Record the count',
      }),
    );
  }

  // Break caught (surfaces/ops-portal.md section 9): the second officer given a bare failure: the words say who counted first, that nothing was changed, and where to look.
  it('tells the second officer that someone else counted first, that their count was not kept, and where to look', async () => {
    const { user } = open({
      [COUNT]: () => refusal(409, 'STATE_CONFLICT', { rule: 'already_counted' }),
    });
    await countAnd(user);

    const alert = await alertSaying(/Someone else counted this vendor first/);
    expect(alert).toHaveTextContent('your count was not kept and nothing was changed');
    expect(alert).toHaveTextContent('Only the first count is kept');
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  it('reads the vendor again on reload, and then says it has been counted and offers it, with no form', async () => {
    let reads = 0;
    const { user } = open({
      [READ]: () => {
        reads += 1;
        return reads === 1
          ? json(200, preCountFixture(), V1)
          : json(
              200,
              postCountFixture({
                physical_count: 5,
                count_variance: 'SHORT',
                count_difference: -2,
                state: 'RECONCILIATION_REQUIRED',
              }),
              V2,
            );
      },
      [COUNT]: () => refusal(409, 'STATE_CONFLICT', { rule: 'already_counted' }),
    });
    await countAnd(user);
    await user.click(await screen.findByRole('button', { name: 'Reload the record' }));

    expect(
      await screen.findByText(
        'Someone else counted this vendor first, so their count is the one that was recorded and nothing was changed by this page.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open the vendor' })).toHaveAttribute(
      'href',
      `/intakes/${INTAKE_ID}`,
    );
    expect(screen.queryByRole('textbox', { name: /Parcels counted/ })).toBeNull();
  });

  it('tells a stale version in words, with what to do next', async () => {
    const { user } = open({ [COUNT]: () => refusal(409, 'STATE_CONFLICT', { rule: 'stale' }) });
    await countAnd(user);
    await alertSaying(/changed after you opened it, so your count was not recorded/);
  });
});

describe('a vendor the page cannot count', () => {
  // Break caught (D-D3): a vendor photographed at the door counted by number, which would hide what the door photos are for.
  it('sends a vendor photographed at the door to its run’s page, tells why there, and takes no lock', async () => {
    const parcels = [parcelFixture(1), parcelFixture(2)];
    const run = runFixture([photoVendorFixture(2, {}, parcels)]);
    open({
      [READ]: () =>
        json(
          200,
          checkInFixture(parcels, {
            id: INTAKE_ID,
            state: 'AWAITING_COUNT',
            received_count: null,
            count_variance: null,
            count_difference: null,
            counted_at: null,
            counted_by_name: null,
          }),
          V1,
        ),
      [`GET /receiving-runs/${RUN_ID}`]: () => json(200, run),
      ...photoLinkHandlers(parcels),
    });

    expect(
      await screen.findByText(
        'This vendor was photographed at the door, so it is checked in on its run’s page and is never counted.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('textbox', { name: /Parcels counted/ })).toBeNull();
    expect(requestsTo(LOCK)).toHaveLength(0);
  });

  it('tells a vendor that is not there', async () => {
    open({ [READ]: () => refusal(404, 'NOT_FOUND') });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Vendor not found' }),
    ).toBeVisible();
    expect(screen.getByText('This vendor could not be found.')).toBeVisible();
  });

  it('tells an address that is not a vendor’s, without asking', async () => {
    api = installFakeApi(staffApi(sessionWith(KEYS, { authorized_hubs: [ACCRA] })));
    renderApp('/intakes/not-an-id/count');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Vendor not found' }),
    ).toBeVisible();
    expect(api.requests.filter((request) => request.url.includes('/hub-intakes/'))).toHaveLength(0);
  });

  it('tells a vendor at a hub the account does not work in, in plain words', async () => {
    open({ [READ]: () => refusal(403, 'HUB_SCOPE_VIOLATION') });
    expect(
      await screen.findByText(/This record belongs to a hub your account does not work in\./),
    ).toBeVisible();
  });

  it('refuses a session without the key of the count, in plain words, and asks the API nothing', async () => {
    api = installFakeApi(staffApi(sessionWith(['hub.read'], { authorized_hubs: [ACCRA] })));
    renderApp(`/intakes/${INTAKE_ID}/count`);
    expect(
      await screen.findByText(
        'Your account can’t check in the parcels received at a hub. Ask an administrator for access.',
      ),
    ).toBeVisible();
    expect(requestsTo(READ)).toHaveLength(0);
  });
});
