import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  errorResponse,
  installFakeApi,
  json,
  type FakeApi,
  type Handler,
} from '../../test-support/fake-api';
import { INTAKE_HUB_ID } from '../../test-support/hub-intake-fixture';
import {
  manifestFixture,
  MANIFEST_ID,
  REQUEST_ONE_ID,
  REQUEST_THREE_ID,
  REQUEST_TWO_ID,
  STOP_ONE_ID,
  stopFixture,
  summaryFixture,
} from '../../test-support/manifest-fixture';
import { ORDER_ID, orderOf } from '../../test-support/orders-fixture';
import { evidenceListFixture } from '../../test-support/pickup-work-fixture';
import { PICKUP_HUB_ID, pickupRequestFixture, REQUEST_ID } from '../../test-support/pickup-fixture';
import { RUN_ID, runFixture } from '../../test-support/receiving-fixture';
import { renderApp } from '../../test-support/render-app';
import { RIDER_ID, riderDetailFixture, riderFixture } from '../../test-support/rider-fixture';
import { bundlesAnswer, etag, KEYS, sessionWith, staffApi } from '../../test-support/staff-api';
import { STAFF_ID, staffIdentityFixture } from '../../test-support/staff-fixture';

/**
 * Run G2, OB-S1-169 item 10 (the Product Owner's decision of 24 November 2026, D-S7-16): `ReadState` keeps the page it drew when a read it holds is asked for again and fails the way a retry could mend
 * (`keepsPage`), and tells it in one line with *Try again*. Every screen that draws part of itself around a `ReadState` had to follow it, or it drew its heading twice or lost its body: this table is those
 * screens, each opened at its own address, each made to read again with the connection lost (the page's reads are idle, so a test asks the query client), and each held to the same three things: **the
 * page is exactly the page that was there**, the line is drawn, and there is one level-one heading. The three the brief names (the order form, the change page and the close page) have their own tests, with
 * what was typed.
 */
const HUB = { id: PICKUP_HUB_ID, display_name: 'Accra Central' };
const ACCRA = { id: INTAKE_HUB_ID, display_name: 'Accra Hub' };

interface Case {
  readonly name: string;
  readonly path: string;
  readonly keys: readonly string[];
  readonly hub?: { readonly id: string; readonly display_name: string };
  /** The read the page makes of its record, which fails once the connection is lost. */
  readonly read: string;
  readonly answer: () => Response;
  /** What else the page reads to be drawn. */
  readonly handlers?: Record<string, Handler>;
}

const request = (id: string, code: string) =>
  pickupRequestFixture({
    id,
    code,
    state: 'CONFIRMED',
    sender_name: 'Demo Fabrics Ltd',
    resolved_pickup_location: { address: '14 Demo Lane, Osu' },
  });

const CASES: readonly Case[] = [
  {
    name: 'a pickup run',
    path: `/manifests/${MANIFEST_ID}`,
    keys: ['pickup.read', 'dispatch.read'],
    read: `GET /pickup-manifests/${MANIFEST_ID}`,
    answer: () => json(200, manifestFixture(), etag('v1')),
    handlers: {
      [`GET /pickup-requests/${REQUEST_ONE_ID}`]: () =>
        json(200, request(REQUEST_ONE_ID, 'ACC-PR-7KQ2MZ'), etag('r1')),
      [`GET /pickup-requests/${REQUEST_TWO_ID}`]: () =>
        json(200, request(REQUEST_TWO_ID, 'ACC-PR-9WXH4T'), etag('r1')),
      [`GET /pickup-requests/${REQUEST_THREE_ID}`]: () =>
        json(200, request(REQUEST_THREE_ID, 'ACC-PR-ZYU26H'), etag('r1')),
      [`GET /ops/riders/${RIDER_ID}`]: () =>
        json(200, { rider: riderFixture(), devices: [] }, etag('rd1')),
    },
  },
  {
    name: 'a pickup request',
    path: `/pickup-requests/${REQUEST_ID}`,
    keys: ['pickup.read'],
    read: `GET /pickup-requests/${REQUEST_ID}`,
    answer: () => json(200, pickupRequestFixture(), etag('v1')),
  },
  {
    name: 'a staff profile',
    path: `/admin/staff/${STAFF_ID}`,
    keys: KEYS.approver,
    read: `GET /staff-identities/${STAFF_ID}`,
    answer: () => json(200, staffIdentityFixture(), etag('v1')),
    handlers: {
      'GET /staff-role-bundles/assignable': bundlesAnswer,
      [`GET /ops/staff/${STAFF_ID}/trusted-browsers`]: () => json(200, { items: [] }),
    },
  },
  {
    name: 'a rider',
    path: `/admin/riders/${RIDER_ID}`,
    keys: ['dispatch.read'],
    read: `GET /ops/riders/${RIDER_ID}`,
    answer: () => json(200, riderDetailFixture(), etag('v1')),
  },
  {
    name: 'the device of a rider',
    path: `/admin/riders/${RIDER_ID}/device`,
    keys: ['dispatch.read', 'staff.device.revoke', 'staff.device.reregister'],
    read: `GET /ops/riders/${RIDER_ID}`,
    answer: () => json(200, riderDetailFixture(), etag('v1')),
    handlers: { 'GET /reason-definitions': () => json(200, []) },
  },
  {
    name: 'a stop',
    path: `/manifests/${MANIFEST_ID}/stops/${STOP_ONE_ID}`,
    keys: ['pickup.read'],
    read: `GET /pickup-stops/${STOP_ONE_ID}`,
    answer: () =>
      json(
        200,
        stopFixture({
          state: 'ARRIVED',
          arrived_at: '2026-11-04T09:00:00Z',
          pickup_summary: summaryFixture('ACC-PR-7KQ2MZ'),
        }),
        etag('v1'),
      ),
    handlers: {
      [`GET /pickup-manifests/${MANIFEST_ID}`]: () =>
        json(200, manifestFixture({ state: 'IN_PROGRESS' }), etag('v1')),
      [`GET /pickup-stops/${STOP_ONE_ID}/evidence`]: () => json(200, evidenceListFixture()),
    },
  },
  {
    name: 'an order',
    path: `/orders/${ORDER_ID}`,
    keys: ['hub.read', 'pricing.read'],
    hub: ACCRA,
    read: `GET /orders/${ORDER_ID}`,
    answer: () => json(200, orderOf('frozen'), { ETag: '"o1"' }),
  },
];

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function openCase(c: Case, connection: { down: boolean }) {
  api = installFakeApi(
    staffApi(sessionWith(c.keys, { authorized_hubs: [c.hub ?? HUB] }), {
      ...c.handlers,
      [c.read]: () => (connection.down ? errorResponse(500, 'INTERNAL_ERROR') : c.answer()),
    }),
  );
  return renderApp(c.path);
}

const main = (): HTMLElement => {
  const element = document.getElementById('main-content');
  if (element === null) throw new Error('the page has no main place');
  return element;
};
/** What the page says, without the line that tells a read failed: the line is the one thing a kept page adds. */
const pageWithoutTheLine = (): string => {
  const copy = main().cloneNode(true) as HTMLElement;
  for (const line of copy.querySelectorAll('.ui-read-state__kept')) line.remove();
  return copy.textContent;
};
const settled = async (c: Case, queryClient: { isFetching: () => number }): Promise<void> => {
  await waitFor(() => {
    expect(
      api.requests.some(
        (sent) =>
          `${sent.method} ${new URL(sent.url).pathname.replace(/^\/api\/v1/, '')}` === c.read,
      ),
    ).toBe(true);
    expect(queryClient.isFetching()).toBe(0);
  });
  // The page is drawn from what was read: its own heading is there, which a page still loading has not.
  await screen.findByRole('heading', { level: 1 });
};

describe('a screen whose read fails again keeps the page that was read', () => {
  // Break caught: a screen that gates part of itself on `status === 'success'` (its heading, its body) beside a `ReadState` that keeps the page: its heading drawn twice, or its body gone and a line that says "what you see".
  it.each(CASES)('$name', async (c) => {
    const connection = { down: false };
    const { queryClient, user } = openCase(c, connection);
    await settled(c, queryClient);
    const before = pageWithoutTheLine();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const title = screen.getByRole('heading', { level: 1 }).textContent;

    connection.down = true;
    await act(async () => {
      await queryClient.refetchQueries();
    });
    expect(await screen.findByText(/could not be refreshed/i)).toBeVisible();
    // Exactly the page that was there, with its one heading, and the line.
    expect(pageWithoutTheLine()).toBe(before);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(title);

    // The connection is back: Try again reads the page, the line goes, and the page is still the one that was there.
    connection.down = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(screen.queryByText(/could not be refreshed/i)).toBeNull();
    });
    expect(pageWithoutTheLine()).toBe(before);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});

describe('the run of a receiving officer', () => {
  // Break caught: a second line for a failure the page already tells in its own freshness line and its connection banner (three messages for one lost read), or no page at all.
  it('keeps its page and tells a failed refresh in its own words, not in a second line', async () => {
    const connection = { down: false };
    const read = `GET /receiving-runs/${RUN_ID}`;
    api = installFakeApi(
      staffApi(sessionWith(['hub.read', 'hub.intake.count'], { authorized_hubs: [ACCRA] }), {
        [read]: () =>
          connection.down ? errorResponse(500, 'INTERNAL_ERROR') : json(200, runFixture([])),
      }),
    );
    const { queryClient } = renderApp(`/receiving/${RUN_ID}`);
    await waitFor(() => {
      expect(api.requests.some((sent) => sent.url.endsWith(`/receiving-runs/${RUN_ID}`))).toBe(
        true,
      );
      expect(queryClient.isFetching()).toBe(0);
    });
    // The run's own header, which carries its code: not the one that stands while it is read.
    const heading = await screen.findByRole('heading', { level: 1, name: /^ACC-MF-/ });
    const title = heading.textContent;

    connection.down = true;
    await act(async () => {
      await queryClient.refetchQueries();
    });
    expect(await screen.findByText(/Refresh failed\./)).toBeVisible();
    expect(screen.queryByText(/could not be refreshed/i)).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(title);
  });
});
