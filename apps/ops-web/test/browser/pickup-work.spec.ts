import type { Page } from '@playwright/test';
import { expect, test } from './support/guarded-test';

import {
  IDS,
  PLANTED,
  photoId,
  stored,
  stubPickupWorkApi,
  waiting,
  world,
  type PickupWorkApi,
  type World,
} from './support/pickup-work-api';
import { watchPage, wcagViolations } from './support/page';
import { menuEntry } from './support/shell';
import { expectNoTableScrollsSideways } from './support/tables';
import { expectWholeInTheWindow } from './support/whole';

/**
 * The screens of the door and the failure (S1.30) in a real browser: the failed pickups, the handshakes that need Ops, the short counts, the collection disputes, a stop with its photos, and the
 * form that lets a count through without them. What jsdom cannot show is here: the layout at the verified widths with axe (WCAG 2.2 A and AA), no sideways scrolling at 320 px, text enlarged to
 * 200%, forced colours, the native modal dialog of each act, the exact headers a real browser sends with each act, and **a photo that is really loaded, only when it is opened, from an address on
 * the page's own origin** (the production build's content-security policy is `img-src 'self'`).
 *
 * The same file runs against the production build and against the development server (strict mode runs every effect twice). The API is a small stateful stand-in; **everything planted is planted
 * in fields the contract never carries** (a handshake's code, digest and override note, a failure's phone number, an object key and an address on every piece of evidence), so that a screen which
 * could draw one would, and a test looks for them in what was drawn.
 */
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
  { width: 320, height: 640 },
] as const;
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const FAILURES = '/pickup-failures';
const HANDSHAKES = '/handshakes';
const SHORTFALLS = '/collection-shortfalls';
const DISPUTES = '/collection-disputes';
const STOP = `/manifests/${IDS.run}/stops/${IDS.stop}`;
const FORM = `${STOP}/photo-exception`;
const DIAGNOSTIC = 'Diagnostic text that must never reach a screen.';

async function open(
  page: Page,
  path: string,
  setup: Partial<World> = {},
): Promise<{ api: PickupWorkApi; watch: ReturnType<typeof watchPage> }> {
  const watch = watchPage(page);
  const api = await stubPickupWorkApi(page, world(setup));
  await page.goto(path);
  return { api, watch };
}

const acts = (api: PickupWorkApi) => api.calls.filter((call) => call.method === 'POST');
const reads = (api: PickupWorkApi, suffix: string) =>
  api.calls.filter((call) => call.method === 'GET' && call.path.endsWith(suffix));
const authorizations = (api: PickupWorkApi) =>
  api.calls.filter((call) => call.path.endsWith('/retrieval-authorization'));

const overflowOf = (page: Page): Promise<number> =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/** The controls whose content is wider than the control: a label cut off. */
function clippedControls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button, input, select, textarea')]
      .filter((element) => element.getClientRects().length > 0)
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.getAttribute('aria-label') ?? element.textContent),
  );
}

const table = (page: Page, name: string) => page.getByRole('table', { name });
const panelOf = (page: Page, code: string) => page.getByRole('dialog', { name: code });
const photos = (page: Page) => page.getByRole('region', { name: 'Photos', exact: true });
const tiles = (page: Page) => photos(page).getByRole('listitem');

/** A row of a list is opened by its button: the record then opens beside the list. */
async function openRow(page: Page, code: string, sender: string): Promise<void> {
  await page.getByRole('button', { name: `Open ${code}, ${sender}` }).click();
  await expect(panelOf(page, code)).toBeVisible();
}

/** Everything the page drew as text and in its attributes, for what must never be there. */
const drawn = (page: Page): Promise<string> => page.content();

test.describe('moving through the screens', () => {
  // Break caught: a menu entry that goes nowhere, or a new page whose heading a screen reader never hears.
  test('the menu leads to each list, each landing on its heading', async ({ page }) => {
    const { api, watch } = await open(page, '/');

    for (const [label, heading] of [
      ['Handshakes', 'Handshakes that need Ops'],
      ['Failed pickups', 'Failed pickups'],
      ['Short counts', 'Short counts'],
      ['Disputes', 'Collection disputes'],
    ] as const) {
      await menuEntry(page, label).click();
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeFocused();
    }

    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  // Break caught: a row that opens nothing, or a stop that cannot be reached from the lists and from the run.
  test('a short count and a dispute open their stop, and the run’s table links the stop by its number', async ({
    page,
  }) => {
    const { api, watch } = await open(page, SHORTFALLS);
    await table(page, 'Short counts').getByRole('link', { name: 'ACC-PR-7KQ2MZ' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Stop 1' })).toBeFocused();
    expect(new URL(page.url()).pathname).toBe(STOP);

    await page.goto(DISPUTES);
    await table(page, 'Collection disputes').getByRole('link', { name: 'ACC-PR-7KQ2MZ' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Stop 1' })).toBeVisible();

    await page.goto(`/manifests/${IDS.run}`);
    await page.getByRole('link', { name: /^(?:Stop )?1$/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Stop 1' })).toBeVisible();
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });
});

test.describe('the failed pickups', () => {
  // Break caught: a field section 17.3 makes mandatory missing from the row or the record, a wait the page worked out, or a phone number the answer should never have had drawn.
  test('shows the queue as the server gave it, and a failure beside it with every field', async ({
    page,
  }) => {
    const { api, watch } = await open(page, FAILURES);

    const rows = table(page, 'Failed pickups').getByRole('row');
    await expect(rows.filter({ hasText: 'ACC-PR-7KQ2MZ' })).toContainText('Waiting for Ops');
    await expect(rows.filter({ hasText: 'ACC-PR-7KQ2MZ' })).toContainText('2 h');
    await expect(rows.filter({ hasText: 'ACC-PR-9XM4TQ' })).toContainText(
      'Escalated, still waiting',
    );
    await expect(rows.filter({ hasText: 'ACC-PR-9XM4TQ' })).toContainText(
      'Escalated by the backstop: it had passed the limit of 24 hours and it had waited 1 d.',
    );
    expect(new URL(reads(api, '/pickup-failures')[0]?.path ?? '', 'http://x').pathname).toBe(
      '/api/v1/pickup-failures',
    );
    expect(reads(api, '/pickup-failures')[0]?.search).toContain('open=true');

    await openRow(page, 'ACC-PR-7KQ2MZ', 'Demo Fabrics Ltd');
    const panel = panelOf(page, 'ACC-PR-7KQ2MZ');
    await expect(panel).toContainText('Gate locked and nobody answered.');
    await expect(panel).toContainText('The vendor was not at the pickup point');
    await expect(panel).toContainText('2 photos.');
    await expect(
      panel.getByRole('region', { name: 'Contact attempts' }).getByRole('listitem'),
    ).toHaveCount(2);
    await expect(panel.getByRole('link', { name: 'Open the stop to see them' })).toHaveAttribute(
      'href',
      `/manifests/${IDS.run}/stops/${IDS.stop}`,
    );
    for (const name of ['Reschedule', 'Escalate', 'Extend the attempts', 'Cancel the pickup']) {
      await expect(panel.getByRole('button', { name })).toBeVisible();
    }
    // Planted: no failure carries a phone number; and the retryability and the cap are not drawn (the read has no field for them).
    expect(await drawn(page)).not.toContain(PLANTED.phone);
    await expect(page.getByRole('main')).not.toContainText(/retryable|cap reached|dispute/i);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  // Break caught: an escalation sent without the version read, without a fresh key, under another name for the note, or a queue that is not read again to show what the act did.
  test('escalates on the version read under a fresh key, and the queue then says who escalated it', async ({
    page,
  }) => {
    const { api, watch } = await open(page, FAILURES);
    await openRow(page, 'ACC-PR-7KQ2MZ', 'Demo Fabrics Ltd');
    await panelOf(page, 'ACC-PR-7KQ2MZ').getByRole('button', { name: 'Escalate' }).click();

    const dialog = page.getByRole('alertdialog', { name: 'Escalate this request?' });
    await dialog.getByRole('button', { name: 'Escalate the request' }).click();
    await expect(dialog.getByText('Write a note saying why.')).toBeVisible();
    expect(acts(api)).toHaveLength(0);
    await dialog
      .getByRole('textbox', { name: /Why it is escalated/ })
      .fill('Refused at the door twice');
    await dialog.getByRole('button', { name: 'Escalate the request' }).click();

    await expect(
      page.getByText('The request ACC-PR-7KQ2MZ is escalated. It still waits for a decision.'),
    ).toBeVisible();
    const [act] = acts(api);
    expect(act?.path).toMatch(/\/pickup-requests\/[0-9a-f-]{36}\/escalate$/);
    expect(act?.ifMatch).toBe('"v1"');
    expect(act?.idempotencyKey).toMatch(KEY);
    expect(act?.body).toEqual({ note: 'Refused at the door twice' });
    const row = table(page, 'Failed pickups').getByRole('row').filter({ hasText: 'ACC-PR-7KQ2MZ' });
    await expect(row).toContainText('Escalated, still waiting');
    await expect(row).toContainText('Escalated by an officer.');
    await expect(panelOf(page, 'ACC-PR-7KQ2MZ')).toHaveCount(0);
    expect(reads(api, '/pickup-failures').length).toBeGreaterThanOrEqual(2);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  test('says what was decided for a decided failure, from the server’s own view', async ({
    page,
  }) => {
    const { api, watch } = await open(page, `${FAILURES}?view=decided`);

    await openRow(page, 'ACC-PR-3HT6NC', 'Adwoa Bakery');
    const panel = panelOf(page, 'ACC-PR-3HT6NC');
    await expect(panel).toContainText('The pickup was rescheduled');
    await expect(panel.getByRole('link', { name: 'Open the new request' })).toHaveAttribute(
      'href',
      `/pickup-requests/${IDS.replacement}`,
    );
    await expect(panel.getByRole('button', { name: 'Reschedule' })).toHaveCount(0);
    expect(reads(api, '/pickup-failures')[0]?.search).toContain('open=false');
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });
});

test.describe('the handshakes that need Ops', () => {
  // Break caught: a code, a digest or the note of an override drawn from an answer that carried them, or a limit with no value filled in with a default.
  test('shows why each needs Ops and the counters beside their limits, and never a code', async ({
    page,
  }) => {
    const { api, watch } = await open(page, HANDSHAKES);

    const first = table(page, 'Handshakes that need Ops')
      .getByRole('row')
      .filter({ hasText: 'ACC-PR-7KQ2MZ' });
    await expect(first).toContainText('The code ran out before the vendor entered it.');
    await expect(first).toContainText('Attempts: 0 of 5');
    const second = table(page, 'Handshakes that need Ops')
      .getByRole('row')
      .filter({ hasText: 'ACC-PR-9XM4TQ' });
    await expect(second).toContainText('Attempts: 5 (the limit is not known)');
    await openRow(page, 'ACC-PR-7KQ2MZ', 'Demo Fabrics Ltd');

    const html = await drawn(page);
    for (const planted of [PLANTED.code, PLANTED.digest, PLANTED.overrideNote]) {
      expect(html).not.toContain(planted);
    }
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  // Break caught: an override sent with a version (the operation declares none), without a fresh key, with the note under another name, without a note, or one that does not move to the settled view.
  test('overrides with a note under a fresh key and no version, and the handshake moves to the settled view', async ({
    page,
  }) => {
    const { api, watch } = await open(page, HANDSHAKES);
    await openRow(page, 'ACC-PR-7KQ2MZ', 'Demo Fabrics Ltd');
    await panelOf(page, 'ACC-PR-7KQ2MZ').getByRole('button', { name: 'Override' }).click();

    const dialog = page.getByRole('alertdialog', { name: 'Override this handshake?' });
    await dialog.getByRole('button', { name: 'Override the handshake' }).click();
    await expect(dialog.getByText('Write a note saying why.')).toBeVisible();
    expect(acts(api)).toHaveLength(0);
    await dialog
      .getByRole('textbox', { name: /How you verified the vendor/ })
      .fill('Called the owner back on the number the office holds');
    await dialog.getByRole('button', { name: 'Override the handshake' }).click();

    await expect(
      page.getByText(
        'The handshake of ACC-PR-7KQ2MZ is overridden: Ops established the collection as an exception.',
      ),
    ).toBeVisible();
    const [act] = acts(api);
    expect(act?.path).toMatch(/\/handshake\/ops-override$/);
    expect(act?.ifMatch).toBeUndefined();
    expect(act?.idempotencyKey).toMatch(KEY);
    expect(act?.body).toEqual({
      verification_note: 'Called the owner back on the number the office holds',
    });
    await expect(table(page, 'Handshakes that need Ops').getByRole('rowheader')).toHaveCount(1);

    await page.getByRole('tab', { name: 'Settled by Ops' }).click();
    const settled = table(page, 'Handshakes that need Ops')
      .getByRole('row')
      .filter({ hasText: 'ACC-PR-7KQ2MZ' });
    await expect(settled).toContainText('Settled by Ops');
    await expect(settled).toContainText('You settled it on ');
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });
});

test.describe('the short counts and the collection disputes', () => {
  // Break caught: an act drawn that the API does not have, or a price, a total or a fee on a count.
  test('show what was counted, offer no act, and say so', async ({ page }) => {
    const { api, watch } = await open(page, SHORTFALLS);

    const row = table(page, 'Short counts').getByRole('row').filter({ hasText: 'ACC-PR-7KQ2MZ' });
    await expect(row).toContainText('3 counted of 5 declared');
    await expect(row).toContainText('Short by 2');
    await expect(page.getByText(/Nothing marks a short count as read or worked yet/)).toBeVisible();
    await expect(
      page
        .getByRole('main')
        .getByRole('button')
        .filter({ hasText: /mark|resolve/i }),
    ).toHaveCount(0);
    expect(await page.getByRole('main').innerText()).not.toMatch(
      /GH₵|\bfee\b|\bprice\b|\btotal\b/i,
    );
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  // Break caught: the vendor's words drawn as markup: a tag in a note would be run in the officer's session.
  test('draw the vendor’s words as text and never as markup, and offer no resolution', async ({
    page,
  }) => {
    const { api, watch } = await open(page, DISPUTES);

    const row = table(page, 'Collection disputes')
      .getByRole('row')
      .filter({ hasText: 'ACC-PR-7KQ2MZ' });
    await expect(row).toContainText('<b>Please check</b>');
    await expect(page.locator('main b')).toHaveCount(0);
    await expect(page.getByText(/no operation resolves one yet/)).toBeVisible();
    await expect(
      page.getByRole('main').getByRole('button', { name: /resolve|reverse|refund/i }),
    ).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });
});

test.describe('the photos of a stop', () => {
  // Break caught: a tile with a picture (no small copy of a photo is made, so a tile that fetched one would fetch every image of the stop), the progress worked out by the page, an object key or an address drawn,
  // or a stop of forty photos costing the page more than one read of its list.
  test('a stop of forty photos is a read of its list and forty tiles with no picture, and no image or authorization is asked for', async ({
    page,
  }) => {
    const { api, watch } = await open(page, STOP);

    await expect(tiles(page)).toHaveCount(40);
    await expect(photos(page)).toContainText('40 of 40 parcel photos uploaded.');
    await expect(photos(page).locator('img')).toHaveCount(0);
    const list = reads(api, '/evidence');
    expect(list).toHaveLength(1);
    expect(list[0]?.search).toContain('page_size=100');
    expect(authorizations(api)).toHaveLength(0);
    expect(api.images).toEqual([]);
    const html = await drawn(page);
    expect(html).not.toContain(PLANTED.objectKey);
    expect(html).not.toContain(PLANTED.address);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  // Break caught: the image fetched without an authorization of its own, one authorization for every photo, the picture kept after the photo is closed, or a second opening that reuses the first one.
  test('a photo opened asks for its own authorization, loads from the page’s origin, is dropped on close, and is asked for again when opened again', async ({
    page,
  }) => {
    const { api, watch } = await open(page, STOP);
    await expect(tiles(page)).toHaveCount(40);

    await page.getByRole('button', { name: 'Open Parcel photo 3', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Parcel photo 3' });
    const image = dialog.getByRole('img', { name: /^Parcel photo 3, taken / });
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0);
    expect(authorizations(api)).toHaveLength(1);
    expect(authorizations(api)[0]?.path).toContain(`/evidence/${photoId(3)}/`);
    expect(api.images).toHaveLength(1);
    expect(api.images[0]).toBe(`/test-evidence-store/${photoId(3)}`);

    await dialog.getByRole('button', { name: 'Close the photo' }).click();
    await expect(page.locator('img.stop-photo__image')).toHaveCount(0);

    await page.getByRole('button', { name: 'Open Parcel photo 3', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: 'Parcel photo 3' }).getByRole('img'),
    ).toBeVisible();
    expect(authorizations(api)).toHaveLength(2);
    expect(api.images).toHaveLength(2);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  // Break caught: a photo that is not stored drawn as one that can be opened, or told as zero uploaded.
  test('a photo that is not stored yet is shown as waiting and cannot be opened', async ({
    page,
  }) => {
    const { api, watch } = await open(page, STOP, { photos: [stored(1), stored(2), waiting(3)] });

    await expect(photos(page)).toContainText(
      '2 of 3 parcel photos uploaded. 1 photo is still waiting to upload.',
    );
    await expect(photos(page).getByText('Waiting to upload', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Open Parcel photo 3', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Open Parcel photo 2', exact: true }),
    ).toBeVisible();
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  // Break caught: a page that loads all of a long stop at once, a position that is not the server's, or a page that fails taking the photos already loaded away.
  test('a stop of a hundred and thirty photos is read a page at a time, and a page that fails keeps the photos loaded', async ({
    page,
  }) => {
    const many = Array.from({ length: 130 }, (_, index) => stored(index + 1));
    const { api, watch } = await open(page, STOP, { photos: many, failEvidenceAfter: '100' });

    await expect(tiles(page)).toHaveCount(100);
    await expect(photos(page)).toContainText('130 of 130 parcel photos uploaded.');
    await page.getByRole('button', { name: 'Load more photos' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'The photos of this stop could not be loaded. The photos shown are those that were loaded.',
    );
    await expect(tiles(page)).toHaveCount(100);

    await page.getByRole('button', { name: 'Try to load more photos again' }).click();
    await expect(tiles(page)).toHaveCount(130);
    const list = reads(api, '/evidence');
    expect(
      list.map((call) =>
        new URL(`http://x${call.path}${call.search}`).searchParams.get('page_token'),
      ),
    ).toEqual([null, '100', '100']);
    expect(authorizations(api)).toHaveLength(0);
    expect(api.unexpected).toEqual([]);
    // The one refusal the test makes on purpose.
    expect(
      watch.problems.filter(
        (problem) => !problem.includes('HTTP 500') && !problem.includes('status of 500'),
      ),
    ).toEqual([]);
  });

  test('says who, when and why where Ops let the count through without photos', async ({
    page,
  }) => {
    const { api, watch } = await open(page, STOP, {
      photos: [],
      exception: {
        id: '28ac1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e',
        pickup_stop_id: IDS.stop,
        authorised_by: '4c3d2e1f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
        authorised_at: '2026-11-04T09:20:00Z',
        note: 'The rider’s camera failed.',
      },
    });

    await expect(photos(page)).toContainText('Counted without parcel photos');
    await expect(photos(page)).toContainText(
      'Another member of staff let this stop’s count through without parcel photos on ',
    );
    await expect(photos(page)).toContainText('Why: The rider’s camera failed.');
    await expect(
      page.getByRole('link', { name: 'Let the count through without photos' }),
    ).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });
});

test.describe('letting a count through without photos', () => {
  // Break caught: an exception sent without a note, with a version (the operation declares none), without a fresh key, or one that is not on the stop afterwards, or an act still offered once it is made.
  test('takes a note, confirms, sends it under a fresh key and no version, and the stop then says who, when and why', async ({
    page,
  }) => {
    const { api, watch } = await open(page, STOP);
    await expect(tiles(page)).toHaveCount(40);
    await page.getByRole('link', { name: 'Let the count through without photos' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Let a count through without photos' }),
    ).toBeFocused();

    await page.getByRole('button', { name: 'Let the count through' }).click();
    await expect(page.getByText('Write a note saying why.')).toBeVisible();
    expect(acts(api)).toHaveLength(0);
    await page.getByRole('textbox', { name: /Note/ }).fill('The camera failed');
    await page.getByRole('button', { name: 'Let the count through' }).click();
    const dialog = page.getByRole('alertdialog', { name: /through without photos\?/ });
    await expect(dialog).toContainText('never changed or removed');
    expect(acts(api)).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Let the count through' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'Stop 1' })).toBeVisible();
    await expect(
      page.getByText(
        'This stop’s count is let through without parcel photos. The rider can now count it.',
      ),
    ).toBeVisible();
    await expect(photos(page)).toContainText(
      'You let this stop’s count through without parcel photos',
    );
    await expect(photos(page)).toContainText('Why: The camera failed');
    await expect(
      page.getByRole('link', { name: 'Let the count through without photos' }),
    ).toHaveCount(0);
    const [act] = acts(api);
    expect(act?.path).toBe(`/api/v1/pickup-stops/${IDS.stop}/parcel-photo-exception`);
    expect(act?.ifMatch).toBeUndefined();
    expect(act?.idempotencyKey).toMatch(KEY);
    expect(act?.body).toEqual({ note: 'The camera failed' });
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  // Break caught: a stop that has been let through offered the form again, or a refusal told as a generic failure with the diagnostic text.
  test('tells a stop that was let through already in plain words, and shows no form', async ({
    page,
  }) => {
    const { api } = await open(page, FORM, {
      photos: [],
      exception: {
        id: '28ac1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e',
        pickup_stop_id: IDS.stop,
        authorised_by: IDS.me,
        authorised_at: '2026-11-04T09:20:00Z',
        note: 'Earlier',
      },
    });

    await expect(
      page.getByText(/This stop has already been let through without photos/),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: /Note/ })).toHaveCount(0);
    expect(await drawn(page)).not.toContain(DIAGNOSTIC);
    expect(api.unexpected).toEqual([]);
  });
});

/** Each screen the page draws, and how to reach it with its content on screen. */
const SCREENS: readonly {
  readonly name: string;
  readonly heading: boolean;
  readonly reach: (page: Page) => Promise<void>;
}[] = [
  {
    name: 'the failed pickups',
    heading: true,
    reach: async (page) => {
      await open(page, FAILURES);
      await expect(page.getByText('ACC-PR-7KQ2MZ').first()).toBeVisible();
    },
  },
  {
    name: 'a failure opened beside the queue',
    heading: false,
    reach: async (page) => {
      await open(page, FAILURES);
      await openRow(page, 'ACC-PR-7KQ2MZ', 'Demo Fabrics Ltd');
      await expect(
        panelOf(page, 'ACC-PR-7KQ2MZ').getByRole('button', { name: 'Reschedule' }),
      ).toBeVisible();
    },
  },
  {
    name: 'the handshakes',
    heading: true,
    reach: async (page) => {
      await open(page, HANDSHAKES);
      await expect(page.getByText('ACC-PR-7KQ2MZ').first()).toBeVisible();
    },
  },
  {
    name: 'a handshake opened beside the list',
    heading: false,
    reach: async (page) => {
      await open(page, HANDSHAKES);
      await openRow(page, 'ACC-PR-7KQ2MZ', 'Demo Fabrics Ltd');
      await expect(
        panelOf(page, 'ACC-PR-7KQ2MZ').getByRole('button', { name: 'Override' }),
      ).toBeVisible();
    },
  },
  {
    name: 'the short counts',
    heading: true,
    reach: async (page) => {
      await open(page, SHORTFALLS);
      await expect(page.getByText('ACC-PR-7KQ2MZ').first()).toBeVisible();
    },
  },
  {
    name: 'the collection disputes',
    heading: true,
    reach: async (page) => {
      await open(page, DISPUTES);
      await expect(page.getByText('ACC-PR-7KQ2MZ').first()).toBeVisible();
    },
  },
  {
    name: 'a stop with forty photos',
    heading: true,
    reach: async (page) => {
      await open(page, STOP);
      await expect(tiles(page)).toHaveCount(40);
    },
  },
  {
    name: 'a photo opened',
    heading: false,
    reach: async (page) => {
      await open(page, STOP);
      await expect(tiles(page)).toHaveCount(40);
      await page.getByRole('button', { name: 'Open Parcel photo 3', exact: true }).click();
      await expect(
        page.getByRole('dialog', { name: 'Parcel photo 3' }).getByRole('img'),
      ).toBeVisible();
    },
  },
  {
    name: 'the form that lets a count through without photos',
    heading: true,
    reach: async (page) => {
      await open(page, FORM);
      await expect(page.getByRole('textbox', { name: /Note/ })).toBeVisible();
    },
  },
];

test.describe('every screen, at the verified widths', () => {
  for (const { width, height } of VIEWPORTS) {
    for (const screen of SCREENS) {
      // Break caught: a screen that clips, scrolls sideways, fails contrast with layout, has an unlabelled control, or loses its heading.
      test(`${screen.name} has no WCAG 2.2 A or AA violation and no sideways scrolling at ${String(width)} px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await screen.reach(page);

        expect(await wcagViolations(page)).toEqual([]);
        expect(await overflowOf(page)).toBeLessThanOrEqual(0);
        await expectNoTableScrollsSideways(page);
        if (screen.heading) await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      });
    }
  }
});

test.describe('the same screens in the dark theme', () => {
  for (const screen of SCREENS) {
    // Break caught: a tile, a panel or a note whose colours were written for the light theme and fail contrast in the dark one.
    test(`${screen.name} has no WCAG 2.2 A or AA violation in the dark theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.setViewportSize({ width: 1280, height: 800 });
      await screen.reach(page);

      expect(await wcagViolations(page)).toEqual([]);
    });
  }
});

test.describe('enlarged text and forced colours', () => {
  // Break caught (WCAG 1.4.4): sizes in pixels, so enlarged text does not grow a tile, a panel or a control, or breaks them.
  for (const { width, height } of [
    { width: 1280, height: 800 },
    { width: 640, height: 800 },
  ]) {
    for (const [name, path] of [
      ['the stop with its photos', STOP],
      ['the failed pickups', FAILURES],
      ['the handshakes', HANDSHAKES],
    ] as const) {
      test(`${name} at 200% text keeps its layout at ${String(width)} px`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await open(page, path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(
          path === STOP ? tiles(page).first() : page.getByText('ACC-PR-7KQ2MZ').first(),
        ).toBeVisible();
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '200%';
        });

        expect(await overflowOf(page)).toBeLessThanOrEqual(0);
        expect(await clippedControls(page)).toEqual([]);
      });
    }
  }

  // Break caught: a tile with no border once forced colours paint the fill away, so that the photos run together.
  test('under forced colours a tile keeps its border and the first act of a panel is whole in the window', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', 'Playwright cannot emulate forced colours in WebKit.');
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page, STOP);
    await expect(tiles(page).first()).toBeVisible();

    const border = await page
      .locator('.stop-photo')
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return { style: style.borderTopStyle, width: parseFloat(style.borderTopWidth) };
      });
    expect(border).toEqual({ style: 'solid', width: 1 });

    await page.goto(FAILURES);
    await openRow(page, 'ACC-PR-7KQ2MZ', 'Demo Fabrics Ltd');
    await panelOf(page, 'ACC-PR-7KQ2MZ')
      .getByRole('button', { name: 'Reschedule' })
      .scrollIntoViewIfNeeded();
    await expectWholeInTheWindow(
      page,
      panelOf(page, 'ACC-PR-7KQ2MZ').getByRole('button', { name: 'Reschedule' }),
    );
  });
});
