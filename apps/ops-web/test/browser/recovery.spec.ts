import { expect, test, type Page, type Route } from '@playwright/test';

import { answerQueueSummary } from './support/queue-summary';
import { SIGNED_IN_SESSION } from './support/api';
import { wcagViolations } from './support/page';
import { errorAnswer, stubPreSignInApi } from './support/pre-sign-in-api';

/**
 * The recovery and vendor screens in a real browser (S0.52): `/recovery`, `/recovery/complete`, `/admin/vendors` and `/admin/vendors/{id}`. What
 * jsdom cannot show is here: the recovery token read from a fragment and removed by a real history (twice, in development's strict mode), the
 * headers a real browser sends with the one request that redeems it, the keyboard and the layout at 320 px in each engine, and the contrast and
 * structure of each page (axe, WCAG 2.2).
 *
 * The API is a stand-in that answers as each test says; everything in it is synthetic. The recovery pages type a password-shaped value, so these
 * tests turn tracing, screenshots and video off for their own contexts. The real stack's journeys are the e2e harness's (rows 10a and 11).
 */
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

const TOKEN = 'Rq7x9Qm2-Zt7_VbN4wYc8LdR1pHs5GfXaUe6OiTjA0E';
const PASSWORD = 'a long enough passphrase';
const EMAIL = 'officer@example.test';
const ACCOUNT = '7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
/** A credential-shaped value no real answer carries on these screens: if it is ever drawn, a screen showed what it must not. */
const PLANTED = 'PLANTED-CREDENTIAL-a8f3d2c1b7e94056';

const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

async function overflowOf(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

test.describe('asking for a recovery link', () => {
  // Break caught (§37.7): a success that differs for an unknown address, or a field that could name a destination.
  test('sends the work email alone, from the Ops origin, and shows the one success', async ({
    page,
    baseURL,
  }) => {
    const api = await stubPreSignInApi(page, { recoveryRequest: { status: 202 } });
    await page.goto('/recovery');
    await expect(page.locator('input')).toHaveCount(1);
    await field(page, 'Work email (required)').fill(EMAIL);
    await page.keyboard.press('Enter');

    await expect(page.getByRole('heading', { level: 1, name: 'Check your email' })).toBeVisible();
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.origin).toBe(new URL(baseURL ?? '').origin);
    expect(api.requests[0]?.body).toEqual({ principal_type: 'STAFF', identifier: EMAIL });
    expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(EMAIL);
    expect(api.unexpected).toEqual([]);
  });

  test('is reached from sign-in, has no sideways scroll at 320 px, and passes axe', async ({
    page,
  }) => {
    await stubPreSignInApi(page, {});
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/sign-in');
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Recover your password' }),
    ).toBeVisible();
    expect(await overflowOf(page)).toBeLessThanOrEqual(0);
    expect(await wcagViolations(page)).toEqual([]);
  });
});

test.describe('completing a recovery link (GBT-W16, the page’s half)', () => {
  // Break caught: the token left in the address or the history, read twice into two requests in strict mode, or redeemed by opening the page.
  test('reads the token once, removes it from the address, redeems nothing by opening, and posts it in the body alone', async ({
    page,
    baseURL,
  }) => {
    const api = await stubPreSignInApi(page, { recoveryComplete: { status: 204 } });
    await page.goto(`/recovery/complete#token=${TOKEN}`);

    await expect(page.getByRole('heading', { level: 1, name: 'Set a new password' })).toBeVisible();
    await expect(page).toHaveURL('/recovery/complete');
    expect(api.requests).toEqual([]);
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');

    await field(page, 'New password (required)').fill(PASSWORD);
    await page.getByRole('button', { name: 'Set new password' }).click();

    await expect(
      page.getByRole('heading', { level: 1, name: 'Your password is changed' }),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Every session that was signed in with your account has ended, on this browser and on any other.',
      ),
    ).toBeVisible();
    expect(api.requests).toHaveLength(1);
    const [request] = api.requests;
    expect(request?.origin).toBe(new URL(baseURL ?? '').origin);
    expect(request?.referer).toBeUndefined();
    expect(request?.search).toBe('');
    expect(request?.body).toEqual({ token: TOKEN, new_credential: PASSWORD });
    expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(PASSWORD);
    expect(api.unexpected).toEqual([]);
  });

  // Break caught (AC-SLICE-000-103): an error that says which way the link failed, or re-opens the form.
  test('shows the one error for a refused link, without the form, and offers a new link', async ({
    page,
  }) => {
    await stubPreSignInApi(page, { recoveryComplete: errorAnswer(422, 'RECOVERY_TOKEN_INVALID') });
    await page.goto(`/recovery/complete#token=${TOKEN}`);
    await field(page, 'New password (required)').fill(PASSWORD);
    await page.getByRole('button', { name: 'Set new password' }).click();

    await expect(
      page.getByRole('heading', { level: 1, name: 'This link cannot be used' }),
    ).toBeVisible();
    await expect(field(page, 'New password (required)')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Ask for a new link' })).toHaveAttribute(
      'href',
      '/recovery',
    );
    await expect(page.getByText(/Diagnostic text|RECOVERY_TOKEN_INVALID/)).toHaveCount(0);
    expect(await wcagViolations(page)).toEqual([]);
  });
});

/** A signed-in browser for the vendor screens, with the stand-in answers the test gives. */
async function signedInWith(
  page: Page,
  permissions: readonly string[],
  answers: Record<string, (route: Route) => Promise<void>>,
): Promise<{
  unexpected: string[];
  posted: { line: string; ifMatch: string | undefined; body: unknown }[];
}> {
  const seen = {
    unexpected: [] as string[],
    posted: [] as { line: string; ifMatch: string | undefined; body: unknown }[],
  };
  await page.route('**/api/v1/**', async (route) => {
    // The shell of every signed-in screen reads the queue summary for the menu (task C1): no queue, and not a request of the test.
    if (await answerQueueSummary(route)) return;
    const request = route.request();
    const url = new URL(request.url());
    const line = `${request.method()} ${url.pathname}`;
    if (line === 'GET /api/v1/auth/session') {
      await route.fulfill({
        status: 200,
        json: { ...SIGNED_IN_SESSION, permissions: [...permissions] },
      });
      return;
    }
    const handler = answers[line];
    if (handler === undefined) {
      seen.unexpected.push(line);
      await route.abort('failed');
      return;
    }
    if (request.method() === 'POST') {
      seen.posted.push({
        line,
        ifMatch: request.headers()['if-match'],
        body: request.postDataJSON() as unknown,
      });
    }
    await handler(route);
  });
  return seen;
}

const ACCOUNT_BODY = {
  id: ACCOUNT,
  account_identifier: 'K7M2Q9X4',
  vendor_organization_id: '8d9e0f1a-2b3c-4d4e-8f5a-6b7c8d9e0f1a',
  legal_name: 'Synthetic Fabrics Ltd',
  responsible_hub_id: SIGNED_IN_SESSION.authorized_hubs[0].id,
  status: 'ACTIVE',
  credential_established: true,
  active_device_count: 1,
  has_recovery_email: true,
  has_recovery_phone: false,
  delivery_channel: 'EMAIL',
  secret_hash: PLANTED,
  recovery_email: PLANTED,
};

/** The columns of the vendor list's table, in order. */
const VENDOR_COLUMNS = ['Account / organisation', 'Status', 'Secret', 'Active browsers', 'Hub'];
const LONG_ORGANISATION =
  'Kwabena Boateng and Sons Household Linen, Curtains and Upholstery Wholesale Trading Company Limited';

test.describe('the vendor screens', () => {
  // Break caught: a credential or a recovery address drawn on the list, or the list wider than a phone.
  test('list the accounts the session reaches with nothing of a credential, at 320 px, passing axe', async ({
    page,
  }) => {
    const seen = await signedInWith(page, ['vendor.read'], {
      'GET /api/v1/ops/vendors': (route) =>
        route.fulfill({ status: 200, json: { items: [ACCOUNT_BODY], next_page_token: null } }),
    });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/admin/vendors');

    await expect(page.getByRole('heading', { level: 1, name: 'Vendors' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'K7M2Q9X4' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(PLANTED);
    expect(await wcagViolations(page)).toEqual([]);
    expect(seen.unexpected).toEqual([]);
  });

  // The list is drawn by the queue workspace template: a table with every column where the table's own box has room for them (40rem, so at 1280 px with the menu open and at 768 px), and
  // cards under that, each with every fact of the account, never both in the page. The long name of an organisation wraps in its cell and the page never scrolls sideways.
  for (const size of [
    { width: 1280, height: 800 },
    { width: 768, height: 1024 },
  ]) {
    // Break caught: a table squeezed into a room it cannot be read in, a column dropped where nothing else shows it, or a long name that pushes the page sideways.
    test(`draws a table of every column at ${String(size.width)} px, with a long name wrapped in its cell and no cards`, async ({
      page,
    }) => {
      const seen = await signedInWith(page, ['vendor.read'], {
        'GET /api/v1/ops/vendors': (route) =>
          route.fulfill({
            status: 200,
            json: {
              items: [{ ...ACCOUNT_BODY, legal_name: LONG_ORGANISATION }],
              next_page_token: null,
            },
          }),
      });
      await page.setViewportSize(size);
      await page.goto('/admin/vendors');

      const table = page.getByRole('table', { name: 'Vendor accounts' });
      await expect(table).toBeVisible();
      await expect(table.getByRole('columnheader')).toHaveText(VENDOR_COLUMNS);
      await expect(page.getByRole('list', { name: 'Vendor accounts' })).toHaveCount(0);
      await expect(table.getByRole('link', { name: 'K7M2Q9X4' })).toBeVisible();
      await expect(table.getByText(LONG_ORGANISATION)).toBeVisible();
      expect(await overflowOf(page)).toBeLessThanOrEqual(0);
      expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(PLANTED);
      expect(await wcagViolations(page)).toEqual([]);
      expect(seen.unexpected).toEqual([]);
    });
  }

  // Break caught (the Product Owner, 10 November 2026: no table scrolls sideways): a list that marks no column lesser, so that where its cells ask for more than a box of 768 px has (a style that
  // gives every cell 9.5rem on one line stands for a long organisation, a long status) its box scrolls sideways. It takes its lesser columns away instead, the hub first, and the account and the
  // status stay.
  test('takes its lesser columns away, the hub first, rather than scroll sideways at 768 px, when its cells cannot wrap', async ({
    page,
  }) => {
    const seen = await signedInWith(page, ['vendor.read'], {
      'GET /api/v1/ops/vendors': (route) =>
        route.fulfill({
          status: 200,
          json: { items: [ACCOUNT_BODY], next_page_token: null },
        }),
    });
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/admin/vendors');

    const table = page.getByRole('table', { name: 'Vendor accounts' });
    await expect(table).toBeVisible();
    // Every cell asks for 9.5rem on one line, and the table is made to measure its box again (two pixels wider, then as it was): five columns ask for more than the box has.
    await page.addStyleTag({
      content:
        '.ui-data-table__table :is(td, th) { white-space: nowrap !important; min-width: 9.5rem !important; }',
    });
    await page.setViewportSize({ width: 770, height: 1024 });
    await page.setViewportSize({ width: 768, height: 1024 });
    // The lesser columns go, the most lesser first: the hub is the first to be taken away.
    await expect(table.getByRole('columnheader', { name: 'Hub' })).toHaveCount(0);
    expect(
      await page
        .locator('.ui-data-table__scroller')
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(0);
    const headers = await table.getByRole('columnheader').allTextContents();
    for (const kept of ['Account / organisation', 'Status']) expect(headers).toContain(kept);
    expect(await overflowOf(page)).toBeLessThanOrEqual(0);
    expect(seen.unexpected).toEqual([]);
  });

  for (const size of [
    { width: 390, height: 844 },
    { width: 320, height: 640 },
  ]) {
    // Break caught: a fact the table shows and the card forgets, a card with no heading, or a table drawn where the room has none.
    test(`draws a card for each account at ${String(size.width)} px, with every fact, a heading and the link, and no table`, async ({
      page,
    }) => {
      const seen = await signedInWith(page, ['vendor.read'], {
        'GET /api/v1/ops/vendors': (route) =>
          route.fulfill({
            status: 200,
            json: {
              items: [{ ...ACCOUNT_BODY, legal_name: LONG_ORGANISATION }],
              next_page_token: null,
            },
          }),
      });
      await page.setViewportSize(size);
      await page.goto('/admin/vendors');

      const cards = page.getByRole('list', { name: 'Vendor accounts' });
      await expect(cards).toBeVisible();
      await expect(page.getByRole('table', { name: 'Vendor accounts' })).toHaveCount(0);
      const card = cards.getByRole('listitem').first();
      await expect(card.getByRole('heading', { level: 2 })).toHaveText('K7M2Q9X4');
      await expect(card.getByRole('link', { name: 'K7M2Q9X4' })).toHaveAttribute(
        'href',
        `/admin/vendors/${ACCOUNT}`,
      );
      for (const fact of [
        'Active',
        LONG_ORGANISATION,
        'Set',
        '1',
        SIGNED_IN_SESSION.authorized_hubs[0].display_name,
      ]) {
        await expect(card).toContainText(fact);
      }
      expect(await overflowOf(page)).toBeLessThanOrEqual(0);
      expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(PLANTED);
      expect(await wcagViolations(page)).toEqual([]);
      expect(seen.unexpected).toEqual([]);
    });
  }

  // Break caught: a search that cannot be reached by the keyboard from the filter row, that is not sent as `q`, or that is not in the address and shown as a filter.
  test('searches from the filter row by the keyboard, sends the text as q, shows it as a filter and takes it off', async ({
    page,
  }) => {
    const queries: string[] = [];
    const seen = await signedInWith(page, ['vendor.read'], {
      'GET /api/v1/ops/vendors': (route) => {
        queries.push(new URL(route.request().url()).search);
        return route.fulfill({
          status: 200,
          json: { items: [ACCOUNT_BODY], next_page_token: null },
        });
      },
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/admin/vendors');
    await expect(page.getByRole('link', { name: 'K7M2Q9X4' })).toBeVisible();

    await page.getByRole('button', { name: 'Filter', exact: true }).focus();
    await page.keyboard.press('Enter');
    const field = page.getByRole('searchbox', { name: 'Search by organisation or account' });
    await expect(field).toBeFocused();
    await page.keyboard.type('synthetic');
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL('/admin/vendors?q=synthetic');
    await expect(
      page.getByRole('button', { name: 'Remove filter: Search: synthetic' }),
    ).toBeVisible();
    await expect(field).toHaveCount(0);
    expect(queries.at(-1)).toBe('?q=synthetic');

    await page.getByRole('button', { name: 'Remove filter: Search: synthetic' }).click();
    await expect(page).toHaveURL('/admin/vendors');
    await expect(page.getByRole('button', { name: /^Remove filter/ })).toHaveCount(0);
    await expect.poll(() => queries.at(-1)).toBe('');
    expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(PLANTED);
    expect(seen.unexpected).toEqual([]);
  });

  // The account is drawn by the record template: its identifier is the heading, its status and one sentence sit beside it, its facts are under their names, and its browsers are a table
  // where the table's own box has room (40rem) and cards under that, never both. Nothing of a credential reaches the page, and it never scrolls sideways.
  for (const [shown, size] of [
    ['a table', { width: 1280, height: 800 }],
    ['a table or cards, one of them', { width: 768, height: 1024 }],
    ['cards', { width: 390, height: 844 }],
    ['cards', { width: 320, height: 640 }],
  ] as const) {
    // Break caught: a fact the record forgets, browsers drawn twice or not at all, a credential drawn from the answer, or a page wider than a phone.
    test(`draws the account as a record, with its browsers as ${shown}, at ${String(size.width)} px`, async ({
      page,
    }) => {
      const seen = await signedInWith(page, ['vendor.read'], {
        [`GET /api/v1/ops/vendors/${ACCOUNT}`]: (route) =>
          route.fulfill({
            status: 200,
            headers: { etag: '"v7"' },
            json: {
              account: { ...ACCOUNT_BODY, legal_name: LONG_ORGANISATION },
              devices: [
                {
                  id: '9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b',
                  principal_type: 'VENDOR',
                  principal_id: ACCOUNT,
                  device_kind: 'VENDOR_BROWSER_CREDENTIAL',
                  status: 'ACTIVE',
                  registered_at: '2026-10-20T09:00:00Z',
                  registered_by: null,
                  device_credential_hash: PLANTED,
                },
              ],
            },
          }),
      });
      await page.setViewportSize(size);
      await page.goto(`/admin/vendors/${ACCOUNT}`);

      await expect(page.getByRole('heading', { level: 1, name: 'K7M2Q9X4' })).toBeVisible();
      await expect(page.getByText('This account can sign in.')).toBeVisible();
      for (const [term, value] of [
        ['Organisation', LONG_ORGANISATION],
        ['Shared secret', 'Set'],
        ['Where links go', 'Its registered email'],
        ['Active browsers', '1'],
      ] as const) {
        await expect(page.locator(`dt:text-is("${term}") + dd`)).toHaveText(value);
      }
      const table = page.getByRole('table', { name: 'Browsers of the account' });
      const cards = page.getByRole('list', { name: 'Browsers of the account' });
      if (shown === 'a table') {
        await expect(table).toBeVisible();
        await expect(cards).toHaveCount(0);
      } else if (shown === 'cards') {
        await expect(cards).toBeVisible();
        await expect(table).toHaveCount(0);
      } else {
        expect((await table.count()) + (await cards.count())).toBe(1);
      }
      expect(await overflowOf(page)).toBeLessThanOrEqual(0);
      expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(PLANTED);
      expect(await wcagViolations(page)).toEqual([]);
      expect(seen.unexpected).toEqual([]);
    });
  }

  // Break caught (AC-SLICE-000-105, -23): a recovery sent without the version or a reason, or its outcome showing a link the answer planted.
  test('start a recovery with the version read and a reason, by the keyboard, and show no link', async ({
    page,
  }) => {
    const seen = await signedInWith(
      page,
      ['vendor.read', 'vendor.credential.recover', 'settings.reason.read'],
      {
        [`GET /api/v1/ops/vendors/${ACCOUNT}`]: (route) =>
          route.fulfill({
            status: 200,
            headers: { etag: '"v7"' },
            json: {
              account: ACCOUNT_BODY,
              devices: [
                {
                  id: '9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b',
                  principal_type: 'VENDOR',
                  principal_id: ACCOUNT,
                  device_kind: 'VENDOR_BROWSER_CREDENTIAL',
                  status: 'ACTIVE',
                  registered_at: '2026-10-20T09:00:00Z',
                  registered_by: null,
                  device_credential_hash: PLANTED,
                },
              ],
            },
          }),
        'GET /api/v1/reason-definitions': (route) =>
          route.fulfill({
            status: 200,
            json: [
              {
                code: 'CREDENTIAL_RECOVERY_ASSISTANCE',
                domain: 'IDENTITY',
                label: 'Verified credential recovery assistance',
                attribution: 'MELARC',
                active: true,
                consumesDeliveryAttempt: false,
                requiresNote: false,
                permittedOperations: [{ operationId: 'recoverVendorCredential', branch: null }],
              },
            ],
          }),
        [`POST /api/v1/ops/vendors/${ACCOUNT}/credential/recover`]: (route) =>
          route.fulfill({
            status: 200,
            json: {
              id: '1a2b3c4d-5e6f-4a7b-8c8d-9e0f1a2b3c4d',
              principal_type: 'VENDOR',
              channel: 'EMAIL',
              state: 'PENDING',
              issued_at: '2026-10-23T08:00:00Z',
              expires_at: '2026-10-23T08:30:00Z',
              consumed_at: null,
              initiated_by: SIGNED_IN_SESSION.principal_id,
              coalesced: false,
              token: PLANTED,
            },
          }),
      },
    );
    await page.goto(`/admin/vendors/${ACCOUNT}`);
    await expect(page.getByRole('heading', { level: 1, name: 'K7M2Q9X4' })).toBeVisible();
    // A browser the shared account registered is the organisation's act (AC-SLICE-000-15).
    await expect(
      page
        .getByRole('table', { name: 'Browsers of the account' })
        .getByText('Synthetic Fabrics Ltd'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Start recovery' }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('alertdialog', { name: 'Start recovery?' });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole('combobox', { name: 'Reason (required)' })
      .selectOption('CREDENTIAL_RECOVERY_ASSISTANCE');
    await dialog.getByRole('button', { name: 'Send recovery link' }).click();

    await expect(
      page.getByText(/A recovery link is on its way to its registered email\./),
    ).toBeVisible();
    expect(seen.posted).toEqual([
      {
        line: `POST /api/v1/ops/vendors/${ACCOUNT}/credential/recover`,
        ifMatch: '"v7"',
        body: { reason_code: 'CREDENTIAL_RECOVERY_ASSISTANCE' },
      },
    ]);
    expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(PLANTED);
    expect(seen.unexpected).toEqual([]);
    expect(await wcagViolations(page)).toEqual([]);
  });
});
