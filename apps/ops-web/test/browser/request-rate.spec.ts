import { writeFileSync } from 'node:fs';

import { expect, test, type Page, type Route } from '@playwright/test';

import { SIGNED_IN_SESSION } from './support/api';
import { HUB_A, HUB_B, menuEntry, topBar } from './support/shell';

/**
 * How many requests a heavy officer's session sends (audit follow-up of 7 November 2026, B13; the Product Owner: "120 a minute stays", `MSC-DEC-371`, and
 * the six-bucket design is closed). The limit of `rate_limit_authenticated_api` is 120 requests a minute for a session, and the Portal sets no timer, so the
 * requests are the person's: this test **drives a session for at least three minutes at a human's pace** (a reading pause after each page, a pause between
 * one click and the next, keys typed at about 130 ms) and counts what the browser sent, by operation, from the `request` event of the page, with the time
 * each was sent. It then computes, per operation and for all of them, the **busiest 60 seconds** (a window that slides over the requests, not a clock
 * minute) and the **average per minute**, and prints them as a table.
 *
 * The session: My work; a switch of hub and back; the pickup queue (a filter, the next page, a refresh); three requests opened and confirmed, with the
 * queue again after each; two searches in the palette typed with corrections, one closed and one opening the record it finds; a run built from the pool (the hub first, four requests,
 * the day) and made; the runs; My work again. It goes round twice, and for as long as three minutes have not passed.
 *
 * **It takes about three and a half minutes, so it is not part of the default run**: it is skipped unless `MELARC_MEASURE=1` is set. To run it (from the
 * repository root, the application is built by the project's web server):
 *
 *   cmd:         set MELARC_MEASURE=1&& pnpm --filter @melarc/ops-web exec playwright test --project=request-rate-chromium
 *   PowerShell:  $env:MELARC_MEASURE='1'; pnpm --filter @melarc/ops-web exec playwright test --project=request-rate-chromium
 *   POSIX shell: MELARC_MEASURE=1 pnpm --filter @melarc/ops-web exec playwright test --project=request-rate-chromium
 *
 * `MELARC_MEASURE_SECONDS` (default 180) shortens or lengthens the session (a round is about two minutes, and the last one always finishes), and
 * `MELARC_MEASURE_QUICKER` (default 1) is how many times quicker than `PACE` the person is: 2 halves every pause, and shows how much room the figures leave.
 *
 * **What the stand-in does not model:** real latency (it answers at once, so a slow answer that keeps a person waiting, or makes them click again, is not
 * here), background tabs and the browser's own retries, a second person, and the real data (a queue of sixty requests, two hubs, a search that finds up
 * to three records). The pace is one person's guess at a heavy officer's, written in `PACE`. The figures are therefore a floor of what the Portal asks
 * for under that pace and not a promise about the server's limit.
 */
const MEASURE = process.env.MELARC_MEASURE === '1';
const SESSION_SECONDS = Number(process.env.MELARC_MEASURE_SECONDS ?? '180');
/** How many times quicker than `PACE` the person is: 2 halves every pause (the typing speed stays), for the question of how much room the figures leave. */
const QUICKER = Number(process.env.MELARC_MEASURE_QUICKER ?? '1');
const WINDOW_MS = 60_000;

/** The pauses of a person at work, in milliseconds. */
const PACE = {
  /** After a page has come: reading it. */
  read: 4000,
  /** Between one click and the next on the same page. */
  step: 2500,
  /** After an act has been answered: looking at what it did. */
  look: 3000,
  /** Between two keys of a fast typist. */
  key: 130,
  /** Between a search being typed and the next thing done to it: reading the results. */
  results: 1800,
} as const;

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const DAY = '2030-03-05';
const DAY_DIGITS = '05032030';
const VENDOR = '8d9e0f1a-2b3c-4d4e-8f5a-6b7c8d9e0f1a';

/** Every operation the session may use, by the key it holds. */
const KEYS = [
  'pickup.read',
  'pickup.request.create',
  'pickup.request.confirm',
  'pickup.manifest.create',
  'settings.reason.read',
  'notification.read',
];

interface Row {
  id: string;
  code: string;
  state: 'PENDING' | 'CONFIRMED';
  hub: string;
  version: number;
  manifested: boolean;
}

/** The characters an operational code is made of (the six after the kind): no 0, 1, I, L or O, which are confused when read aloud. */
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Sixty synthetic requests, two hubs alternating: sixteen already confirmed and in the pool, the rest waiting for confirmation. */
function makeRows(): Row[] {
  return Array.from({ length: 60 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    code: `ACC-PR-K${CODE_CHARS.charAt(Math.floor(index / CODE_CHARS.length))}${CODE_CHARS.charAt(index % CODE_CHARS.length)}Q73`,
    state: index < 16 ? 'CONFIRMED' : 'PENDING',
    hub: index % 2 === 0 ? HUB_A.id : HUB_B.id,
    version: 1,
    manifested: false,
  }));
}

interface Made {
  readonly id: string;
  readonly code: string;
  readonly requests: readonly string[];
}

interface World {
  readonly rows: Row[];
  readonly manifests: Made[];
  readonly unexpected: string[];
}

const wire = (row: Row) => ({
  id: row.id,
  code: row.code,
  state: row.state,
  responsible_hub_id: row.hub,
  pickup_intent: 'OWN_PACKAGES',
  vendor_organization_id: VENDOR,
  sender_name: 'Demo Fabrics Ltd',
  resolved_pickup_location: { address: '14 Demo Lane, Osu', landmark: 'Demo bakery' },
  scheduled_service_date: DAY,
  declared_package_count: 3,
  default_payer_intent: 'RECIPIENT_PAYS',
  attempt_number: 1,
  replaces_request_id: null,
  replacement_request_id: null,
  one_package_exception_id: null,
  one_package_exception: null,
  cutoff_exception_state: null,
  cancellation_charge_outcome: null,
  cancellation_charge: null,
  created_at: '2026-10-29T08:15:00Z',
  primary_phone: '+233201234567',
});

const ESTIMATE = {
  status: 'AVAILABLE',
  provisional: true,
  total: { amount_minor: 4500, currency: 'GHS' },
  assumes_size_class: 'SMALL',
  excludes: ['SIZE_SURCHARGE'],
  components: [],
};

const manifestWire = (made: Made, withStops = true) => ({
  id: made.id,
  code: made.code,
  state: 'DRAFT',
  service_date: DAY,
  responsible_hub_id: HUB_A.id,
  assigned_rider_id: null,
  assigned_at: null,
  dispatched_at: null,
  started_at: null,
  completed_at: null,
  ...(withStops
    ? {
        stops: made.requests.map((request, index) => ({
          id: `a1000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          pickup_manifest_id: made.id,
          pickup_request_id: request,
          sequence: index + 1,
          state: 'PENDING',
          arrived_at: null,
          failure_category: null,
          failure: null,
          skipped: null,
        })),
      }
    : {}),
});

function fulfil(route: Route, status: number, json: unknown, version?: number): Promise<void> {
  return route.fulfill({
    status,
    headers: {
      ...JSON_HEADERS,
      ...(version === undefined ? {} : { etag: `"v${String(version)}"` }),
    },
    json,
  });
}

function summaryOf(world: World, hub: string | null) {
  const mine = world.rows.filter((row) => hub === null || row.hub === hub);
  const waiting = mine.filter((row) => row.state === 'PENDING').length;
  const pool = mine.filter((row) => row.state === 'CONFIRMED' && !row.manifested).length;
  const queue = (name: string, count: number) => ({
    queue: name,
    count,
    ...(count === 0 ? {} : { oldest_at: '2030-03-01T08:00:00.000Z' }),
  });
  return {
    queues: [
      queue('PICKUP_AWAITING_CONFIRMATION', waiting),
      queue('PICKUP_CUTOFF_REVIEW', 0),
      queue('PICKUP_EXCEPTION_APPROVAL', 0),
      queue('PICKUP_UNMANIFESTED_POOL', pool),
      queue('PICKUP_RUNS_IN_PROGRESS', world.manifests.length),
    ],
  };
}

/** The stand-in: the operations the session uses, answered at once from a small world. Anything else is answered 404 and listed in `unexpected`. */
async function answer(route: Route, world: World): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const { pathname: path, searchParams: query } = url;
  const method = request.method();

  if (method === 'GET' && path === '/api/v1/auth/session') {
    return fulfil(route, 200, {
      ...SIGNED_IN_SESSION,
      permissions: KEYS,
      authorized_hubs: [HUB_A, HUB_B],
    });
  }
  if (method === 'GET' && path === '/api/v1/ops/queue-summary') {
    return fulfil(route, 200, summaryOf(world, query.get('hub_id')));
  }
  if (method === 'POST' && path === '/api/v1/ops/lookup') {
    const text = ((request.postDataJSON() as { q?: string }).q ?? '').toUpperCase();
    const found = world.rows.filter((row) => row.code.includes(text)).slice(0, 3);
    return fulfil(route, 200, {
      items: found.map((row) => ({
        kind: 'PICKUP_REQUEST',
        id: row.id,
        code: row.code,
        title: row.code,
        state: row.state,
        hub: row.hub === HUB_A.id ? HUB_A : HUB_B,
        service_date: DAY,
        sender_name: 'Demo Fabrics Ltd',
        phone_hint: '+233******567',
      })),
    });
  }
  if (method === 'GET' && path === '/api/v1/reason-definitions') return fulfil(route, 200, []);
  if (method === 'GET' && path === '/api/v1/pickup-requests') {
    const state = query.get('state');
    const hub = query.get('hub_id');
    const poolOnly = query.get('manifested') === 'false';
    const matching = world.rows
      .filter((row) => state === null || row.state === state)
      .filter((row) => hub === null || row.hub === hub)
      .filter((row) => !poolOnly || !row.manifested);
    const start = Number(query.get('page_token') ?? '0');
    return fulfil(route, 200, {
      items: matching.slice(start, start + 20).map(wire),
      next_page_token: start + 20 < matching.length ? String(start + 20) : null,
    });
  }
  const one = /^\/api\/v1\/pickup-requests\/([^/]+)(?:\/(confirm))?$/.exec(path);
  if (one !== null) {
    const row = world.rows.find((candidate) => candidate.id === one[1]);
    if (row === undefined)
      return fulfil(route, 404, { code: 'NOT_FOUND', message: 'x', request_id: 'r' });
    if (method === 'GET' && one[2] === undefined) return fulfil(route, 200, wire(row), row.version);
    if (method === 'POST' && one[2] === 'confirm') {
      row.state = 'CONFIRMED';
      row.version += 1;
      return fulfil(route, 200, { ...wire(row), indicative_estimate: ESTIMATE }, row.version);
    }
  }
  if (method === 'POST' && path === '/api/v1/pickup-manifests') {
    const body = request.postDataJSON() as { pickup_request_ids: string[] };
    const made: Made = {
      id: `f1000000-0000-4000-8000-${String(world.manifests.length + 1).padStart(12, '0')}`,
      code: `ACC-MF-Q92${CODE_CHARS.charAt(world.manifests.length)}42`,
      requests: body.pickup_request_ids,
    };
    world.manifests.push(made);
    for (const row of world.rows) if (made.requests.includes(row.id)) row.manifested = true;
    return fulfil(route, 201, manifestWire(made), 1);
  }
  if (method === 'GET' && path === '/api/v1/pickup-manifests') {
    return fulfil(route, 200, {
      items: world.manifests.map((made) => manifestWire(made, false)),
      next_page_token: null,
    });
  }
  const manifest = /^\/api\/v1\/pickup-manifests\/([^/]+)$/.exec(path);
  if (method === 'GET' && manifest !== null) {
    const made = world.manifests.find((candidate) => candidate.id === manifest[1]);
    if (made !== undefined) return fulfil(route, 200, manifestWire(made), 1);
  }
  world.unexpected.push(`${method} ${path}`);
  return fulfil(route, 404, { code: 'NOT_FOUND', message: 'No stand-in.', request_id: 'req-rate' });
}

/** The name of the operation a request is, by the method and the path (the contract's operation ids), or the method and the path when the table has none. */
const OPERATIONS: readonly [RegExp, string, string][] = [
  [/^\/api\/v1\/auth\/session$/, 'GET', 'getCurrentSession'],
  [/^\/api\/v1\/ops\/queue-summary$/, 'GET', 'getQueueSummary'],
  [/^\/api\/v1\/ops\/lookup$/, 'POST', 'lookupRecords'],
  [/^\/api\/v1\/reason-definitions$/, 'GET', 'listReasonDefinitions'],
  [/^\/api\/v1\/pickup-requests$/, 'GET', 'listPickupRequests'],
  [/^\/api\/v1\/pickup-requests\/[^/]+$/, 'GET', 'getPickupRequest'],
  [/^\/api\/v1\/pickup-requests\/[^/]+\/confirm$/, 'POST', 'confirmPickupRequest'],
  [/^\/api\/v1\/pickup-manifests$/, 'POST', 'createPickupManifest'],
  [/^\/api\/v1\/pickup-manifests$/, 'GET', 'listPickupManifests'],
  [/^\/api\/v1\/pickup-manifests\/[^/]+$/, 'GET', 'getPickupManifest'],
];

const operationOf = (method: string, path: string): string =>
  OPERATIONS.find(([pattern, verb]) => verb === method && pattern.test(path))?.[2] ??
  `${method} ${path}`;

interface Sent {
  readonly at: number;
  readonly operation: string;
}

/** The most requests that fall in any 60 seconds: a window that slides over the times, which are in order. */
function busiestWindow(times: readonly number[], windowMs = WINDOW_MS): number {
  let busiest = 0;
  let first = 0;
  for (let last = 0; last < times.length; last += 1) {
    while ((times[last] ?? 0) - (times[first] ?? 0) >= windowMs) first += 1;
    busiest = Math.max(busiest, last - first + 1);
  }
  return busiest;
}

interface Figures {
  readonly operation: string;
  readonly total: number;
  readonly perMinute: number;
  readonly busiest: number;
}

function figuresOf(sent: readonly Sent[], minutes: number): Figures[] {
  const names = [...new Set(sent.map((each) => each.operation))].toSorted();
  const of = (operation: string, list: readonly Sent[]): Figures => ({
    operation,
    total: list.length,
    perMinute: Math.round((list.length / minutes) * 10) / 10,
    busiest: busiestWindow(list.map((each) => each.at)),
  });
  return [
    of('ALL OPERATIONS', sent),
    ...names.map((name) =>
      of(
        name,
        sent.filter((each) => each.operation === name),
      ),
    ),
  ];
}

const pause = (page: Page, ms: number): Promise<void> => page.waitForTimeout(ms / QUICKER);

async function chooseHub(page: Page, name: string): Promise<void> {
  await topBar(page).getByRole('button', { name: /^Hub:/ }).click();
  await page.getByRole('menuitemradio', { name }).click();
}

/** The queue, opened from the menu, with its heading. */
async function openQueue(page: Page): Promise<void> {
  await menuEntry(page, 'Requests').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pickup requests' })).toBeVisible();
  await pause(page, PACE.read);
}

/** One request opened from the first page of the waiting ones, read, and confirmed. */
async function confirmOne(page: Page): Promise<void> {
  await page
    .getByRole('link', { name: /^ACC-PR-/ })
    .first()
    .click();
  await expect(page.getByRole('button', { name: 'Confirm the pickup' })).toBeVisible();
  await pause(page, PACE.read);
  await page.getByRole('button', { name: 'Confirm the pickup' }).click();
  await pause(page, PACE.step);
  await page
    .getByRole('alertdialog', { name: 'Confirm this pickup?' })
    .getByRole('button', { name: 'Confirm the pickup' })
    .click();
  await expect(
    page.getByText('The request is confirmed. It waits in the pool for a pickup run.'),
  ).toBeVisible();
  await pause(page, PACE.look);
}

/** A search typed, corrected and looked at, and closed again without opening anything. */
async function searchAndClose(page: Page): Promise<void> {
  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Search' });
  const field = palette.getByRole('combobox');
  await expect(field).toBeFocused();
  await field.pressSequentially('ACC-PR-K4', { delay: PACE.key });
  await pause(page, PACE.results);
  await field.press('Backspace');
  await field.pressSequentially('5', { delay: PACE.key });
  await pause(page, PACE.results);
  await field.press('Escape');
  await expect(palette).toBeHidden();
  await pause(page, PACE.step);
}

/** A search typed with a correction, and the first record it finds opened. */
async function searchAndOpen(page: Page): Promise<void> {
  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Search' });
  const field = palette.getByRole('combobox');
  await expect(field).toBeFocused();
  await field.pressSequentially('ACC-PR-K2', { delay: PACE.key });
  await pause(page, PACE.results);
  // A slip of the finger: the last key taken back, a moment to look, and another typed.
  await field.press('Backspace');
  await pause(page, PACE.results);
  await field.pressSequentially('3', { delay: PACE.key });
  await expect(palette.getByRole('option').first()).toBeVisible();
  await pause(page, PACE.results);
  await field.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('ACC-PR-');
  await pause(page, PACE.read);
}

/** A run built from the pool of the first hub: the hub, four requests, the day. */
async function buildRun(page: Page): Promise<void> {
  await topBar(page).getByRole('button', { name: 'New' }).click();
  await page.getByRole('menuitem', { name: 'Build a pickup run' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Build a manifest' })).toBeVisible();
  await pause(page, PACE.step);
  await page.getByRole('combobox', { name: /^Hub/ }).selectOption(HUB_A.id);
  await expect(page.getByRole('checkbox', { name: /^Choose / }).first()).toBeVisible();
  await pause(page, PACE.read);
  for (let each = 0; each < 4; each += 1) {
    await page
      .getByRole('checkbox', { name: /^Choose / })
      .nth(each)
      .check();
    await pause(page, PACE.step / 2);
  }
  await page
    .getByRole('group', { name: /Service date/ })
    .getByRole('textbox')
    .click();
  await page.keyboard.type(DAY_DIGITS, { delay: PACE.key });
  await pause(page, PACE.step);
  await page.getByRole('button', { name: 'Create the manifest' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^ACC-MF-/ })).toBeVisible();
  await pause(page, PACE.read);
}

async function oneRound(page: Page): Promise<void> {
  await menuEntry(page, 'My work').click();
  await expect(page.getByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
  await pause(page, PACE.read);
  await chooseHub(page, HUB_B.display_name);
  await pause(page, PACE.look);
  await chooseHub(page, 'All hubs');
  await pause(page, PACE.step);

  await openQueue(page);
  await page.getByRole('combobox', { name: 'State' }).selectOption('PENDING');
  await pause(page, PACE.look);
  await page.getByRole('button', { name: /Next page/ }).click();
  await pause(page, PACE.look);
  await page.getByRole('button', { name: 'Refresh page' }).click();
  await pause(page, PACE.look);
  await page.getByRole('combobox', { name: 'State' }).selectOption('');
  await pause(page, PACE.step);

  for (let each = 0; each < 3; each += 1) {
    if (each > 0) await openQueue(page);
    await page.getByRole('combobox', { name: 'State' }).selectOption('PENDING');
    await pause(page, PACE.step);
    await confirmOne(page);
  }
  await openQueue(page);

  await searchAndClose(page);
  await searchAndOpen(page);
  await buildRun(page);

  await menuEntry(page, 'Pickup runs').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Manifests' })).toBeVisible();
  await pause(page, PACE.read);
}

test.describe('the requests of a heavy session', () => {
  // A step that cannot be taken fails after 20 seconds and says which, where the default would wait for the whole test.
  test.use({ actionTimeout: 20_000 });
  test.skip(
    !MEASURE,
    'It takes about three and a half minutes: it runs when MELARC_MEASURE=1 is set.',
  );

  // The Product Owner's question (audit follow-up of 7 November 2026, B13): does a heavy officer's session stay at or under half of the 120 requests a minute?
  test(`sends no more than half of the limit in its busiest minute, in a session of ${String(SESSION_SECONDS)} seconds`, async ({
    page,
  }, testInfo) => {
    test.setTimeout((SESSION_SECONDS + 240) * 1000);
    const world: World = { rows: makeRows(), manifests: [], unexpected: [] };
    await page.route('**/api/v1/**', (route) => answer(route, world));
    const sent: Sent[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/api/v1/')) {
        sent.push({ at: Date.now(), operation: operationOf(request.method(), pathname) });
      }
    });

    const started = Date.now();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
    await pause(page, PACE.read);
    do {
      await oneRound(page);
    } while (Date.now() - started < SESSION_SECONDS * 1000);
    const ended = Date.now();

    const minutes = (ended - started) / 60_000;
    const figures = figuresOf(
      sent.map((each) => ({ ...each, at: each.at - started })),
      minutes,
    );
    const table = [
      `Session: ${(minutes * 60).toFixed(0)} s, ${String(sent.length)} requests.`,
      'operation'.padEnd(26) +
        'requests'.padStart(10) +
        'per minute'.padStart(12) +
        'busiest 60 s'.padStart(14),
      ...figures.map(
        (each) =>
          each.operation.padEnd(26) +
          String(each.total).padStart(10) +
          String(each.perMinute).padStart(12) +
          String(each.busiest).padStart(14),
      ),
    ].join('\n');
    console.log(`\n${table}\n`);
    writeFileSync(testInfo.outputPath('request-rate.txt'), table);

    expect(world.unexpected, 'requests no stand-in answers').toEqual([]);
    expect(ended - started).toBeGreaterThanOrEqual(SESSION_SECONDS * 1000);
    const all = figures[0];
    expect(all?.busiest ?? Number.POSITIVE_INFINITY, 'the busiest 60 seconds').toBeLessThanOrEqual(
      60,
    );
  });
});
