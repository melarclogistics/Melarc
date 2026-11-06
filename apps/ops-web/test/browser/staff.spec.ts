import { expect, test, type Page } from '@playwright/test';

import { reachableNames, watchPage, wcagViolations } from './support/page';
import {
  ama,
  IDS,
  PLANTED,
  stubStaffApi,
  world,
  type StaffApi,
  type World,
} from './support/staff-api';

/**
 * The six signed-in screens (S0.44) in a real browser: the landing, `/admin/staff` with the approver's queue, `/admin/staff/new`,
 * `/admin/staff/{id}`, `/admin/staff/{id}/mfa/reset` and `/admin/sessions`. What jsdom cannot show is here: the native modal dialog (the page
 * behind it inert, Tab kept inside it, focus given back to what opened it), the move of focus to a new page's heading, the exact `If-Match` a
 * real browser sends, times shown in Accra whatever the machine's zone, the keyboard order and the focus ring, and every screen with axe at the
 * verified widths.
 *
 * The same file runs against the production build and against the development server (strict mode runs every effect twice). The API is a small
 * stateful stand-in with a credential planted in answers that never carry one, so that a screen which could display one would. The pages hold
 * answers shaped like credentials, so these tests turn tracing, screenshots and video off for their own contexts (playwright.config.ts).
 */
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
  { width: 320, height: 640 },
] as const;

async function overflowOf(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/** Opens a path as a person who holds the keys of `kind` would, against a world the test shapes. */
async function open(
  page: Page,
  path: string,
  setup: Partial<World> = {},
): Promise<{ api: StaffApi; watch: ReturnType<typeof watchPage> }> {
  const watch = watchPage(page);
  const api = await stubStaffApi(page, world(setup));
  await page.goto(path);
  return { api, watch };
}

/** What has focus, as a person would say it: in a dialog, `outside` it, or `document` for the body (where a browser's own interface lies). */
const focusPlace = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) return 'document';
    return active.closest('dialog') === null ? 'outside' : 'dialog';
  });

const focusedIs = (page: Page, name: string) =>
  expect(page.getByRole('heading', { level: 1, name })).toBeFocused();

const acts = (api: StaffApi) => api.calls.filter((call) => call.method === 'POST');

test.describe('moving through the screens', () => {
  // Break caught: a navigation that leaves focus where the link was, so that a screen reader says nothing about the new page.
  test('the landing counts what waits, and each step lands on the new page’s heading', async ({
    page,
  }) => {
    const { api, watch } = await open(page, '/');

    await expect(
      page.getByRole('link', { name: 'Staff profiles waiting for approval' }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Staff profiles waiting for approval' }).click();

    await expect(page).toHaveURL('/admin/staff?view=waiting');
    await focusedIs(page, 'Staff');
    await page.getByRole('link', { name: 'Kofi Boateng' }).click();
    await focusedIs(page, 'Kofi Boateng');
    await expect(page).toHaveURL(`/admin/staff/${IDS.kofi}`);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  test('the menu offers what the keys allow and marks where the person is', async ({ page }) => {
    await open(page, '/admin/staff');

    const menu = page.getByRole('navigation', { name: 'Primary' });
    // The names of the entries (what each is called; the count beside one is the server's, and is asserted on the line below).
    await expect(menu.locator('.ui-primary-nav__label')).toHaveText([
      'Overview',
      'Staff',
      'Add a staff profile',
      'Sessions',
      'Trusted browsers',
    ]);
    await expect(menu.getByRole('link', { name: /^Staff(?: |$)/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // The one profile that waits is counted beside the entry of the queue it is in (task C1).
    await expect(menu.getByRole('link', { name: 'Staff 1 waiting for approval' })).toBeVisible();
    // "Add a staff profile" lies under "Staff": at its own page it alone is current.
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Add a staff profile' })
      .click();
    await expect(page).toHaveURL('/admin/staff/new');
    await expect(menu.locator('[aria-current="page"]')).toHaveText(['Add a staff profile']);
  });

  // Break caught: a screen that exists but that nothing in the menu leads to (found on the real stack: the sessions page could be
  // reached only from a profile). The entry opens it with nobody chosen, and the page says how to choose.
  test('the menu leads to the sessions page, which says how to choose a person', async ({
    page,
  }) => {
    await open(page, '/admin/staff');

    const menu = page.getByRole('navigation', { name: 'Primary' });
    await menu.getByRole('link', { name: 'Sessions' }).click();

    await expect(page).toHaveURL('/admin/sessions');
    await expect(menu.locator('[aria-current="page"]')).toHaveText(['Sessions']);
    await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible();
    await expect(page.getByText('Choose a person first')).toBeVisible();
  });

  test('a person who cannot read staff sees no entry for it, and is told which key the page needs', async ({
    page,
  }) => {
    await open(page, '/admin/staff', {
      permissions: ['staff.identity.create', 'permission.assignable_bundle.read'],
    });

    await expect(
      page.getByRole('heading', { level: 1, name: 'You do not have access to this page' }),
    ).toBeVisible();
    await expect(page.getByText('staff.read', { exact: true })).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Primary' })
        .getByRole('link', { name: /^Staff(?: |$)/ }),
    ).toHaveCount(0);
  });

  // Break caught: a link-button that shows no focus ring, or one a keyboard cannot reach.
  test('the primary action is a link a keyboard reaches, and it shows where focus is', async ({
    page,
    browserName,
  }) => {
    await open(page, '/admin/staff');
    await page.getByRole('heading', { level: 1, name: 'Staff' }).waitFor();

    // Safari's engine leaves links out of the Tab order unless the user turns on "Press Tab to highlight each item".
    test.skip(browserName === 'webkit', 'WebKit for Windows never moves focus to a link by Tab.');
    const names = await reachableNames(page, true);
    expect(names).toContain('Add a staff profile');
    const link = page.getByRole('main').getByRole('link', { name: 'Add a staff profile' });
    await link.focus();
    const ring = await link.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: style.outlineWidth };
    });
    expect(ring.style).not.toBe('none');
    expect(ring.width).not.toBe('0px');
  });
});

test.describe('times', () => {
  // Break caught: a time shown in the machine's zone: the same instant would read differently on every laptop that opens the page.
  test.describe('whatever the machine’s zone', () => {
    test.use({ timezoneId: 'Pacific/Auckland' });

    test('are shown in Accra, 24-hour, with no zone label', async ({ page }) => {
      await open(page, `/admin/sessions?principal_type=STAFF&principal_id=${IDS.kofi}`);

      const table = page.getByRole('table', { name: 'Open sessions' });
      await expect(table.getByText('23 Oct, 08:00')).toBeVisible();
      await expect(table.getByText('23 Oct, 16:00')).toBeVisible();
      await expect(table.getByText('22 Oct, 07:05')).toBeVisible();
      expect(await table.innerText()).not.toMatch(/GMT|UTC|AM|PM/);
    });
  });
});

test.describe('approving and rejecting', () => {
  // Break caught: a modal that leaves the page behind it reachable, that lets Tab out, or that loses the person's place when it closes.
  test('the dialog keeps Tab inside it and gives focus back to the button that opened it', async ({
    page,
  }) => {
    await open(page, `/admin/staff/${IDS.kofi}`);
    const approve = page.getByRole('button', { name: 'Approve profile' });
    // Opened with the keyboard, as a keyboard user does: Safari's engine does not focus a button that is clicked, so a click leaves nothing to give back.
    await approve.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('alertdialog', { name: 'Approve Kofi Boateng?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    for (let step = 0; step < 8; step += 1) {
      await page.keyboard.press('Tab');
      // In the dialog, or on the document (where a browser's own interface lies): never on the page behind it.
      expect(await focusPlace(page), `Tab ${String(step + 1)}`).not.toBe('outside');
    }
    // A script cannot focus what is behind a modal dialog.
    const reached = await page.evaluate(() => {
      const behind = [...document.querySelectorAll('button')].find(
        (candidate) =>
          candidate.textContent === 'Reject profile' && candidate.closest('dialog') === null,
      );
      behind?.focus();
      return behind !== undefined && document.activeElement === behind;
    });
    expect(reached).toBe(false);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(approve).toBeFocused();
  });

  // Break caught: a decision sent without the version the browser read, or with another one: a silent overwrite of a record that moved.
  test('approving sends the exact version it read, says it is done and puts focus on the news', async ({
    page,
  }) => {
    const { api, watch } = await open(page, `/admin/staff/${IDS.kofi}`);
    await page.getByRole('button', { name: 'Approve profile' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Approve profile' }).click();

    const news = page.getByText(
      'Kofi Boateng is approved. A setup link is on its way to kofi.boateng@example.test.',
    );
    await expect(news).toBeVisible();
    await expect(page.locator('.staff-notice')).toBeFocused();
    await expect(page.locator('.ui-status-badge', { hasText: 'Active' })).toBeVisible();
    const [call] = acts(api);
    expect(call?.path).toBe(`/api/v1/staff-identities/${IDS.kofi}/approve`);
    expect(call?.ifMatch).toBe('"v1"');
    expect(call?.idempotencyKey).toBeUndefined();
    expect(call?.body).toEqual({ approved: true });
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  test('a record that moved is a conflict that is explained, and reloading shows where it stands', async ({
    page,
  }) => {
    const { api } = await open(page, `/admin/staff/${IDS.kofi}`, {});
    api.world.moveVersionBeforeNextAct = true;
    await page.getByRole('button', { name: 'Approve profile' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Approve profile' }).click();

    await expect(
      page.getByText(
        /changed after you opened it, perhaps because someone else has already decided it/,
      ),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Reload the record' }).click();

    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.locator('.ui-status-badge', { hasText: 'Active' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve profile' })).toHaveCount(0);
  });

  test('rejecting asks for a reason from the catalogue of rejections and says the profile is rejected', async ({
    page,
  }) => {
    const { api } = await open(page, `/admin/staff/${IDS.kofi}`);
    await page.getByRole('button', { name: 'Reject profile' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Reject Kofi Boateng?' });
    await dialog
      .getByRole('combobox', { name: 'Reason (required)' })
      .selectOption('NOT_A_REAL_HIRE');
    await dialog.getByRole('button', { name: 'Reject profile' }).click();

    await expect(page.getByText('The profile of Kofi Boateng is rejected.')).toBeVisible();
    const reasonRequest = api.calls.find((call) => call.path === '/api/v1/reason-definitions');
    expect(reasonRequest?.search).toContain('operation=approveStaffIdentity');
    expect(reasonRequest?.search).toContain('branch=APPROVAL_REJECTED');
    expect(acts(api)[0]?.body).toEqual({ approved: false, reason_code: 'NOT_A_REAL_HIRE' });
  });
});

test.describe('a credential has nowhere to go', () => {
  // Break caught (ops-portal.md section 7): the grant shown to the administrator who reset the factor. The stand-in plants one in the answer.
  test('the reset shows how many sessions ended and when the link lapses, and never the link', async ({
    page,
  }) => {
    const { api, watch } = await open(page, `/admin/staff/${IDS.ama}/mfa/reset`);
    await page.getByRole('button', { name: 'Reset authenticator' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('combobox', { name: 'Reason (required)' }).selectOption('PHONE_LOST');
    await dialog.getByRole('button', { name: 'Reset authenticator' }).click();

    await expect(page.getByRole('heading', { name: 'Authenticator reset' })).toBeVisible();
    await expect(page.getByText('2 sessions were ended.')).toBeVisible();
    await expect(page.getByText(/It works until 23 Oct, 08:30\./)).toBeVisible();
    expect(await page.content()).not.toContain(PLANTED);
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(PLANTED);
    await expect(page.locator('input, textarea, canvas, code')).toHaveCount(0);
    expect(
      await page.evaluate(async () => ({
        local: localStorage.length,
        session: sessionStorage.length,
        databases: (await indexedDB.databases()).length,
      })),
    ).toEqual({ local: 0, session: 0, databases: 0 });
    expect(acts(api)[0]?.ifMatch).toBe('"v1"');
    expect(acts(api)[0]?.idempotencyKey).toBeUndefined();
    expect(watch.problems).toEqual([]);
  });

  test('a profile never shows a hash or a token the server should not have sent, and a new setup link shows none', async ({
    page,
  }) => {
    // A new first setup link is for an active profile that has no password yet, so one with no authenticator.
    const { api } = await open(page, `/admin/staff/${IDS.ama}`, {
      identities: [ama({ status: 'ACTIVE', approved_by: IDS.me })],
    });
    await expect(page.getByRole('heading', { level: 1, name: 'Ama Mensah' })).toBeVisible();
    await page.getByRole('button', { name: 'Send a new setup link' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('combobox', { name: 'Reason (required)' }).selectOption('EMAIL_LOST');
    await dialog.getByRole('button', { name: 'Send new link' }).click();

    await expect(
      page.getByText(
        /A new setup link is on its way to ama\.mensah@example\.test\. It works until 23 Oct, 08:30\./,
      ),
    ).toBeVisible();
    expect(await page.content()).not.toContain(PLANTED);
    expect(acts(api)[0]?.path).toBe(`/api/v1/ops/staff/${IDS.ama}/credential/setup/reissue`);
  });

  test('a session list shows nothing of a session’s credential', async ({ page }) => {
    await open(page, `/admin/sessions?principal_type=STAFF&principal_id=${IDS.kofi}`);
    await expect(page.getByRole('table', { name: 'Open sessions' })).toBeVisible();

    expect(await page.content()).not.toContain(PLANTED);
  });
});

test.describe('adding a profile', () => {
  test('is done from the keyboard, sends one profile with a key, and puts focus on the news', async ({
    page,
  }) => {
    const { api, watch } = await open(page, '/admin/staff/new');
    await page.getByRole('textbox', { name: /Full name/ }).waitFor();

    // Nothing filled in: the first problem takes focus.
    await page.getByRole('button', { name: 'Create profile' }).click();
    await expect(page.getByRole('textbox', { name: /Full name/ })).toBeFocused();
    expect(acts(api)).toHaveLength(0);

    await page.getByRole('textbox', { name: /Full name/ }).fill('Esi Quaye');
    await page.getByRole('textbox', { name: /Work email/ }).fill('esi.quaye@example.test');
    await page.getByRole('combobox', { name: /Role/ }).selectOption({ label: 'Ops Staff' });
    await page.keyboard.press('Enter');

    await expect(page.getByRole('heading', { name: 'Profile created' })).toBeVisible();
    await expect(page.locator('.staff-created')).toBeFocused();
    await expect(
      page.getByText(/Esi Quaye cannot sign in until the profile is approved/),
    ).toBeVisible();
    const [call] = acts(api);
    expect(call?.path).toBe('/api/v1/staff-identities');
    expect(call?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(call?.ifMatch).toBeUndefined();
    expect(call?.body).toEqual({
      work_email: 'esi.quaye@example.test',
      full_name: 'Esi Quaye',
      role_bundle_id: IDS.ops,
      primary_hub_id: IDS.hub,
    });
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  // The owner's decision of 25 October 2026: a Platform Admin needs no second person. The stand-in answers as a Platform Admin's session
  // does (it accepts the maker's decision), and the page offers the maker the acts, with a note on who may use them.
  test('lets the maker open the profile they made and approve it, told who may', async ({
    page,
  }) => {
    const { api, watch } = await open(page, '/admin/staff/new');
    await page.getByRole('textbox', { name: /Full name/ }).fill('Esi Quaye');
    await page.getByRole('textbox', { name: /Work email/ }).fill('esi.quaye@example.test');
    await page.getByRole('combobox', { name: /Role/ }).selectOption({ label: 'Ops Staff' });
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Profile created' })).toBeVisible();

    await page.getByRole('link', { name: 'View the profile' }).click();
    await expect(page.getByRole('heading', { name: 'Esi Quaye' })).toBeVisible();
    await expect(
      page.getByText(
        'You created this profile. A Platform Admin can approve or reject a profile they made; anyone else needs a different person to.',
      ),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Approve profile' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: /^Approve profile$/ })
      .click();

    await expect(
      page.getByText(/Esi Quaye is approved\. A setup link is on its way/),
    ).toBeVisible();
    const approval = acts(api).find((call) => call.path.endsWith('/approve'));
    expect(approval?.body).toEqual({ approved: true });
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });
});

test.describe('ending a session', () => {
  test('asks for a reason, sends no version, and reads the list again', async ({ page }) => {
    const { api } = await open(
      page,
      `/admin/sessions?principal_type=STAFF&principal_id=${IDS.kofi}`,
    );
    await page.getByRole('button', { name: 'End session started 22 Oct, 07:05' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'End this session?' });
    await dialog.getByRole('combobox', { name: 'Reason (required)' }).selectOption('DEVICE_LOST');
    await dialog.getByRole('button', { name: 'End session' }).click();

    await expect(page.getByText('The session has ended.')).toBeVisible();
    await expect(page.getByRole('table', { name: 'Open sessions' }).getByRole('row')).toHaveCount(
      2,
    );
    const [call] = acts(api);
    expect(call?.path).toBe(`/api/v1/auth/sessions/${IDS.other}/revoke`);
    expect(call?.ifMatch).toBeUndefined();
    expect(call?.body).toEqual({ reason_code: 'DEVICE_LOST' });
  });
});

test.describe('the trusted browsers (staff-authentication.md section 5.8)', () => {
  // Break caught: a page that exists and that nothing leads to, one that draws a credential it was sent, or a removal that asks for no
  // confirmation or reads the list no more.
  test('the menu leads to the person’s own browsers, which are removed after a confirmation and are shown with no credential', async ({
    page,
  }) => {
    const { api } = await open(page, '/');
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Trusted browsers' })
      .click();
    await expect(page).toHaveURL('/account/trusted-browsers');
    await focusedIs(page, 'Trusted browsers');
    const table = page.getByRole('table', { name: 'Your trusted browsers' });
    await expect(table.getByRole('row')).toHaveCount(3);
    await expect(table).toContainText('This browser');
    await expect(page.locator('body')).not.toContainText(PLANTED);

    await page.getByRole('button', { name: 'Remove Safari on macOS' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Remove this browser?' });
    await expect(dialog).toBeVisible();
    expect(api.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Remove browser' }).click();

    await expect(
      page.getByText('The browser is removed. It will ask for a code at its next sign-in.'),
    ).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(2);
    const [call] = api.calls.filter((each) => each.method === 'DELETE');
    expect(call?.path).toBe(`/api/v1/auth/staff/trusted-browsers/${IDS.other}`);
    expect(call?.ifMatch).toBeUndefined();
    expect(call?.idempotencyKey).toBeUndefined();
    await expect(page.locator('body')).not.toContainText(PLANTED);
  });

  test('an administrator removes all of a person’s browsers with a reason, and sees none of their credentials', async ({
    page,
  }) => {
    const { api } = await open(page, `/admin/staff/${IDS.ama}`);
    const section = page.getByRole('region', { name: 'Trusted browsers' });
    await expect(section.getByRole('table')).toContainText('Firefox on Linux');
    await expect(section.getByRole('table')).toContainText('Edge on Windows');
    await expect(page.locator('body')).not.toContainText(PLANTED);

    await section.getByRole('button', { name: 'Remove all trusted browsers' }).click();
    const dialog = page.getByRole('alertdialog', { name: /^Remove the trusted browsers of / });
    await dialog.getByRole('combobox', { name: 'Reason (required)' }).selectOption('DEVICE_LOST');
    await dialog.getByRole('button', { name: 'Remove trusted browsers' }).click();

    await expect(page.getByText('2 trusted browsers removed.')).toBeVisible();
    await expect(section.getByText(/has no browser that skips the code/)).toBeVisible();
    const [call] = acts(api).filter((each) => each.path.endsWith('/trusted-browsers/revoke'));
    expect(call?.path).toBe(`/api/v1/ops/staff/${IDS.ama}/trusted-browsers/revoke`);
    expect(call?.ifMatch).toBeUndefined();
    // The act takes an Idempotency-Key (audit G03 of 26 October 2026), which a retry would send again unchanged.
    expect(call?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(call?.body).toEqual({ reason_code: 'DEVICE_LOST' });
  });
});

/** Every screen and state the identity screens have, reached the way a person reaches them. */
const STATES: { name: string; reach: (page: Page) => Promise<void>; setup?: Partial<World> }[] = [
  {
    name: 'the landing',
    reach: async (page) => {
      await open(page, '/');
      await expect(
        page.getByRole('link', { name: 'Staff profiles waiting for approval' }),
      ).toBeVisible();
    },
  },
  {
    name: 'the approval queue',
    reach: async (page) => {
      await open(page, '/admin/staff');
      await expect(page.getByRole('table', { name: 'Staff profiles' })).toBeVisible();
    },
  },
  {
    name: 'an empty queue',
    reach: async (page) => {
      await open(page, '/admin/staff', { identities: [ama({ status: 'ACTIVE' })] });
      await expect(
        page.getByRole('heading', { name: 'Nothing is waiting for approval' }),
      ).toBeVisible();
    },
  },
  {
    name: 'the form to add a profile',
    reach: async (page) => {
      await open(page, '/admin/staff/new');
      await expect(page.getByRole('textbox', { name: /Full name/ })).toBeVisible();
    },
  },
  {
    name: 'the form with problems',
    reach: async (page) => {
      await open(page, '/admin/staff/new');
      await page.getByRole('button', { name: 'Create profile' }).click();
      await expect(page.getByRole('textbox', { name: /Full name/ })).toHaveAttribute(
        'aria-invalid',
        'true',
      );
    },
  },
  {
    name: 'a profile that waits',
    reach: async (page) => {
      await open(page, `/admin/staff/${IDS.kofi}`);
      await expect(page.getByRole('button', { name: 'Approve profile' })).toBeVisible();
    },
  },
  {
    name: 'a profile with the approval dialog open',
    reach: async (page) => {
      await open(page, `/admin/staff/${IDS.kofi}`);
      await page.getByRole('button', { name: 'Reject profile' }).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Reason (required)' })).toBeVisible();
    },
  },
  {
    name: 'an active profile',
    reach: async (page) => {
      await open(page, `/admin/staff/${IDS.ama}`);
      await expect(page.getByRole('link', { name: 'Reset authenticator' })).toBeVisible();
    },
  },
  {
    name: 'the reset of an authenticator',
    reach: async (page) => {
      await open(page, `/admin/staff/${IDS.ama}/mfa/reset`);
      await expect(page.getByRole('button', { name: 'Reset authenticator' })).toBeVisible();
    },
  },
  {
    name: 'a reset that is done',
    reach: async (page) => {
      await open(page, `/admin/staff/${IDS.ama}/mfa/reset`);
      await page.getByRole('button', { name: 'Reset authenticator' }).click();
      await page.getByRole('combobox', { name: 'Reason (required)' }).selectOption('PHONE_LOST');
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Reset authenticator' })
        .click();
      await expect(page.getByRole('heading', { name: 'Authenticator reset' })).toBeVisible();
    },
  },
  {
    name: 'the sessions of a person',
    reach: async (page) => {
      await open(page, `/admin/sessions?principal_type=STAFF&principal_id=${IDS.kofi}`);
      await expect(page.getByRole('table', { name: 'Open sessions' })).toBeVisible();
    },
  },
  {
    name: 'the sessions page opened without a person',
    reach: async (page) => {
      await open(page, '/admin/sessions');
      await expect(page.getByRole('heading', { name: 'Choose a person first' })).toBeVisible();
    },
  },
  {
    name: 'the trusted browsers of the person',
    reach: async (page) => {
      await open(page, '/account/trusted-browsers');
      await expect(page.getByRole('table', { name: 'Your trusted browsers' })).toBeVisible();
    },
  },
  {
    name: 'the trusted browsers of a person on their profile',
    reach: async (page) => {
      await open(page, `/admin/staff/${IDS.ama}`);
      await expect(page.getByRole('table', { name: /^Trusted browsers of / })).toBeVisible();
    },
  },
  {
    name: 'a profile that is not there',
    reach: async (page) => {
      await open(page, '/admin/staff/00000000-0000-4000-8000-000000000000');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Profile not found' }),
      ).toBeVisible();
    },
  },
];

test.describe('every screen and state, at the verified widths', () => {
  for (const { width, height } of VIEWPORTS) {
    for (const state of STATES) {
      // Break caught: a state that clips, scrolls sideways, fails contrast with layout, has an unlabelled control, or loses the shell.
      test(`${state.name} has no WCAG 2.2 A or AA violation and no sideways scrolling at ${String(width)} px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await state.reach(page);

        expect(await wcagViolations(page)).toEqual([]);
        expect(await overflowOf(page)).toBeLessThanOrEqual(0);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        // The shell is around the screen, in the form its width gives it: docked at the side on a wide screen, and on a narrow one behind its
        // button, in a bar, out of sight and out of the tab order. (By layout, not by role: a modal dialog makes the rest of the page inert.)
        const navigation = page.getByRole('navigation', { name: 'Primary', includeHidden: true });
        await expect(navigation).toHaveCount(1);
        if (width >= 768) {
          await expect(page.locator('.ui-side-menu__panel')).toBeVisible();
          await expect(page.locator('.ui-side-menu__bar')).toBeHidden();
        } else {
          await expect(page.locator('.ui-side-menu__bar')).toBeVisible();
          await expect(page.locator('.ui-side-menu__panel')).toBeHidden();
        }
      });
    }
  }
});
