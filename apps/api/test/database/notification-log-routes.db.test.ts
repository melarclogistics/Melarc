import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { arrangedFixedSession } from './support/http-sessions.js';
import {
  ARRANGED_DIGEST,
  insertNotification,
  type NotificationArrangement,
} from './support/notifications.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import { API, HUB_A, HUB_B, codeOf } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.12e, `listNotifications`, the Ops message log (section 31.6), against the real application and a real PostgreSQL: what a staff
 * reader sees follows the hubs of the grant of `notification.read`; **no entry holds a destination in clear, a text, a code, the count
 * digest, the provider's reference or the lease**; the list pages by an opaque position without skipping or repeating a row; every filter
 * is checked; a vendor, a rider, a holder of another bundle and a caller with no session are refused; and a read of another hub is
 * audited without contents.
 */
const LIST = `${API}/notifications`;

let routes: VendorRoutes;
let vendor: ArrangedVendor;
let vendorBrowser: TestClient;
const known: Record<string, string> = {};
const id = (name: string): string => {
  const found = known[name];
  if (found === undefined) throw new Error(`no notification was arranged as ${name}`);
  return found;
};
/** The pickup request each notification is about: one for each name, so that a filter by subject has something to tell apart. */
const subject: Record<string, string> = {};
const subjectOf = (name: string): string => {
  const found = subject[name];
  if (found === undefined) throw new Error(`no record was arranged as ${name}`);
  return found;
};

interface Entry {
  readonly id: string;
  readonly message_kind: string;
  readonly template_version: number;
  readonly audience: string;
  readonly channel: string;
  readonly state: string;
  readonly suppression_reason: string | null;
  readonly outcome_class: string | null;
  readonly provider_outcome_class: string | null;
  readonly destination_hint: string | null;
  readonly attempt_count: number;
  readonly subject: { readonly type: string; readonly id: string };
  readonly responsible_hub_id: string;
  readonly sent_at: string | null;
  readonly delivered_at: string | null;
  readonly expires_at: string;
  readonly created_at: string;
}
interface Page {
  readonly items: Entry[];
  readonly next_page_token: string | null;
}
const pageOf = (response: TestResponse): Page => response.json() as Page;
const firstOf = (response: TestResponse): Entry => {
  const [first] = pageOf(response).items;
  if (first === undefined) throw new Error('the page holds no entry');
  return first;
};
const idsOf = (response: TestResponse): string[] => pageOf(response).items.map((item) => item.id);

/** A moment `seconds` after a fixed start, as the database reads it: the list is ordered by it, so the order is the test's and not the clock's. */
const at = (seconds: number): string =>
  new Date(Date.UTC(2026, 9, 28, 10, 0, 0) + seconds * 1000).toISOString();

/** The messages of the first hub, newest first, by the order they were arranged in. */
const NEWEST_FIRST_IN_A = (): string[] => [
  id('sent'),
  id('opsFeed'),
  id('feedEntry'),
  id('failed'),
  id('suppressed'),
  id('queued'),
  id('timed'),
  id('delivered'),
];

beforeAll(async () => {
  routes = await startVendorRoutes();
  vendor = await routes.vendor();
  vendorBrowser = routes.browser(vendor.device.credential.token);
  expect(
    (await routes.signIn(vendorBrowser, vendor.row.accountIdentifier, vendor.secret)).status,
  ).toBe(200);

  const make = async (
    name: string,
    over: Omit<NotificationArrangement, 'subjectId' | 'hubId'> & {
      hubId?: string;
      subjectName?: string;
    } = {},
  ): Promise<void> => {
    const { hubId, subjectName, ...rest } = over;
    const subjectKey = subjectName ?? name;
    subject[subjectKey] ??= randomUUID();
    known[name] = (
      await insertNotification(routes.admin, {
        hubId: hubId ?? HUB_A,
        subjectId: subjectOf(subjectKey),
        ...rest,
      })
    ).id;
  };

  // In order of time, oldest first; the list shows the newest first.
  await make('delivered', { createdAt: at(0), state: 'DELIVERED' });
  await make('queued', { createdAt: at(10), state: 'QUEUED' });
  await make('suppressed', {
    createdAt: at(20),
    state: 'SUPPRESSED',
    suppressionReason: 'DAY_LIMIT',
  });
  await make('failed', {
    createdAt: at(30),
    state: 'FAILED',
    outcomeClass: 'REJECTED',
    providerOutcomeClass: 'REQUEST_INVALID',
  });
  await make('feedEntry', {
    createdAt: at(40),
    channel: 'FEED',
    audience: 'VENDOR_FEED',
    state: 'DELIVERED',
    messageKind: 'PICKUP_CONFIRMED_VENDOR_FEED',
  });
  await make('opsFeed', {
    createdAt: at(50),
    channel: 'FEED',
    audience: 'OPS_FEED',
    state: 'DELIVERED',
    messageKind: 'PICKUP_FAILURE_ESCALATED_OPS_FEED',
  });
  await make('sent', { createdAt: at(60), state: 'SENT' });
  // The two moments of a delivered text are told apart on purpose: a view that swaps them is found by the exact values.
  await make('timed', {
    createdAt: at(5),
    state: 'DELIVERED',
    sentAt: at(100),
    deliveredAt: at(130),
    attemptCount: 2,
    messageKind: 'PICKUP_CONFIRMED_SENDER',
    subjectName: 'timed',
  });
  await make('elsewhere', { createdAt: at(70), state: 'DELIVERED', hubId: HUB_B });
  await make('elsewhereQueued', { createdAt: at(80), state: 'QUEUED', hubId: HUB_B });
}, 120_000);

afterAll(async () => {
  await routes.stop();
});

describe('listNotifications: what a staff reader sees', () => {
  // Break caught: a log that crosses hubs, that is not newest first, or that shows a message of another hub to the staff of this one.
  it('shows Ops Staff the messages of the hub of the grant, newest first', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const answer = await ops.client.get(LIST);
    expect(answer.status).toBe(200);
    expect(idsOf(answer)).toEqual(NEWEST_FIRST_IN_A());
    expect(pageOf(answer).next_page_token).toBeNull();

    const other = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
    expect(idsOf(await other.client.get(LIST))).toEqual([id('elsewhereQueued'), id('elsewhere')]);
  });

  // Break caught: a bundle the catalogue gives notification.read to (A S P) left without it.
  it('shows Senior Ops the same log at its hub', async () => {
    const reader = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const answer = await reader.client.get(LIST);
    expect(answer.status).toBe(200);
    expect(idsOf(answer)).toHaveLength(8);
  });

  // Break caught (task P1, AC-SLICE-001-83): the Platform Admin's grant of the key left at its own hub, so that an administrator with no
  // primary hub (the bootstrap one) reads no log, and one with a hub only that hub's. The key is a grant of all hubs.
  it('shows a Platform Admin the messages of every hub, with a primary hub or none', async () => {
    for (const admin of [
      await routes.actor(BUNDLE_IDS.platformAdmin, HUB_A),
      await routes.platformAdmin(),
    ]) {
      const answer = await admin.client.get(LIST);
      expect(answer.status).toBe(200);
      expect(idsOf(answer)).toHaveLength(10);
      expect(idsOf(answer)).toEqual(
        expect.arrayContaining([id('elsewhere'), id('elsewhereQueued')]),
      );
    }
  });
});

describe('listNotifications: what an entry carries, and what it never does', () => {
  // Break caught: a representation that grows a field the contract does not name, which is how a destination or a code gets into a log.
  it('carries exactly the fields of the contract', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const answer = await ops.client.get(`${LIST}?state=DELIVERED&channel=SMS`);
    expect(answer.status).toBe(200);
    const first = firstOf(answer);
    expect(Object.keys(first).toSorted()).toEqual(
      [
        'attempt_count',
        'audience',
        'channel',
        'created_at',
        'delivered_at',
        'destination_hint',
        'expires_at',
        'id',
        'message_kind',
        'outcome_class',
        'provider_outcome_class',
        'responsible_hub_id',
        'sent_at',
        'state',
        'subject',
        'suppression_reason',
        'template_version',
      ].toSorted(),
    );
    expect(Object.keys(first.subject).toSorted()).toEqual(['id', 'type']);
  });

  // Break caught: the number in clear, the count digest, the provider's reference or the lease reaching the log: the API role is granted
  // none of them, and no view may name them.
  it('shows the number only as a masked hint, and never the digest, the provider’s reference or the lease', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const body = (await ops.client.get(`${LIST}?page_size=100`)).text;
    expect(body).toContain('+233******111');
    for (const hidden of [
      ARRANGED_DIGEST,
      'provider-ref-arranged',
      'arranged-lane',
      'destination_digest',
      'provider_message_ref',
      'lease_',
      'next_attempt_at',
      'receipt_checks',
    ]) {
      expect(body, hidden).not.toContain(hidden);
    }
  });

  // Break caught: a held-back message shown as sent, or without the reason it was held back.
  it('shows a held-back message with its reason and no moment of sending', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const entry = pageOf(await ops.client.get(`${LIST}?state=SUPPRESSED`)).items[0];
    expect(entry).toMatchObject({
      id: id('suppressed'),
      state: 'SUPPRESSED',
      suppression_reason: 'DAY_LIMIT',
      sent_at: null,
      delivered_at: null,
      attempt_count: 0,
      subject: { type: 'PICKUP_REQUEST', id: subjectOf('suppressed') },
      responsible_hub_id: HUB_A,
      audience: 'AD_HOC_SENDER',
      channel: 'SMS',
      message_kind: 'PICKUP_CONFIRMED_SENDER',
      template_version: 1,
    });
  });

  // Break caught: a refusal that loses the provider's closed word, which is what tells Ops a number from an account problem.
  it('shows a refused message with how it ended and the provider’s own closed word', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const entry = pageOf(await ops.client.get(`${LIST}?state=FAILED`)).items[0];
    expect(entry).toMatchObject({
      id: id('failed'),
      state: 'FAILED',
      outcome_class: 'REJECTED',
      provider_outcome_class: 'REQUEST_INVALID',
      suppression_reason: null,
      sent_at: null,
    });
  });

  // Break caught: a delivered text without the two moments, or a feed entry shown as sent over a network.
  it('tells when a text left and when the network said it arrived, and neither for a feed entry', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const delivered = pageOf(await ops.client.get(`${LIST}?state=DELIVERED&channel=SMS`)).items[0];
    expect(delivered).toMatchObject({
      id: id('timed'),
      sent_at: at(100),
      delivered_at: at(130),
      attempt_count: 2,
      // Made at at(5), and a text stays worth sending for six hours after that.
      created_at: at(5),
      expires_at: at(5 + 6 * 3600),
    });
    const feed = pageOf(await ops.client.get(`${LIST}?channel=FEED&audience=VENDOR_FEED`)).items[0];
    expect(feed).toMatchObject({
      id: id('feedEntry'),
      sent_at: null,
      delivered_at: null,
      destination_hint: null,
      state: 'DELIVERED',
    });
  });
});

describe('listNotifications: filters and pages', () => {
  // Break caught: a filter that is ignored, or that widens the scope instead of narrowing it.
  it('filters by state, audience, channel and the record the message is about', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    expect(idsOf(await ops.client.get(`${LIST}?state=QUEUED`))).toEqual([id('queued')]);
    expect(idsOf(await ops.client.get(`${LIST}?channel=FEED`))).toEqual([
      id('opsFeed'),
      id('feedEntry'),
    ]);
    // The Ops feed is the log filtered to its audience and channel.
    expect(idsOf(await ops.client.get(`${LIST}?channel=FEED&audience=OPS_FEED`))).toEqual([
      id('opsFeed'),
    ]);
    expect(idsOf(await ops.client.get(`${LIST}?audience=VENDOR_FEED`))).toEqual([id('feedEntry')]);
    expect(idsOf(await ops.client.get(`${LIST}?subject_id=${subjectOf('failed')}`))).toEqual([
      id('failed'),
    ]);
    expect(idsOf(await ops.client.get(`${LIST}?state=FAILED&channel=FEED`))).toEqual([]);
    // A record of another hub matches nothing for a reader outside that hub.
    expect(idsOf(await ops.client.get(`${LIST}?subject_id=${subjectOf('elsewhere')}`))).toEqual([]);
    expect(idsOf(await ops.client.get(`${LIST}?subject_id=${randomUUID()}`))).toEqual([]);
  });

  // Break caught: a page that skips or repeats a row at its edge, or a token that is not a position.
  it('pages by an opaque position, without a row skipped or repeated', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const seen: string[] = [];
    let token: string | null = null;
    let pages = 0;
    do {
      const query = `?page_size=3${token === null ? '' : `&page_token=${token}`}`;
      const answer: TestResponse = await ops.client.get(`${LIST}${query}`);
      expect(answer.status).toBe(200);
      seen.push(...idsOf(answer));
      token = pageOf(answer).next_page_token;
      pages += 1;
    } while (token !== null && pages < 6);
    expect(pages).toBe(3);
    expect(seen).toEqual(NEWEST_FIRST_IN_A());
  });

  // Break caught: messages made in one instant (a relay makes several together) reordered or lost at a page edge: the position is the
  // moment and the id, not the moment alone.
  it('does not skip or repeat messages that share a moment at the edge of a page', async () => {
    const twin = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
    const hub = HUB_B;
    const same = at(500);
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      made.push(
        (
          await insertNotification(routes.admin, {
            hubId: hub,
            subjectId: randomUUID(),
            createdAt: same,
            state: 'QUEUED',
          })
        ).id,
      );
    }
    const seen: string[] = [];
    let token: string | null = null;
    let pages = 0;
    do {
      const query = `?page_size=2${token === null ? '' : `&page_token=${token}`}`;
      const answer: TestResponse = await twin.client.get(`${LIST}${query}`);
      expect(answer.status).toBe(200);
      seen.push(...idsOf(answer));
      token = pageOf(answer).next_page_token;
      pages += 1;
    } while (token !== null && pages < 8);
    const ofTheMoment = seen.filter((each) => made.includes(each));
    expect(new Set(seen).size).toBe(seen.length);
    expect(ofTheMoment.toSorted()).toEqual(made.toSorted());
    // Newest first, and within one moment the larger id first.
    expect(ofTheMoment).toEqual(made.toSorted().toReversed());
  });

  // Break caught: a filter or a page parameter read as a statement, or taken on trust, and an answer that is not the contract's 400.
  it.each([
    ['a page size of zero', 'page_size=0'],
    ['a page size over the maximum', 'page_size=101'],
    ['a page size that is not a number', 'page_size=many'],
    ['a position that is not one', 'page_token=not-a-position'],
    ['a state that is not one', 'state=SENDING'],
    ['an empty state', 'state='],
    ['an audience that is not one', 'audience=EVERYONE'],
    ['a channel that is not one', 'channel=PUSH'],
    ['a subject that is not an id', 'subject_id=not-a-uuid'],
    ['a lower-case state', 'state=queued'],
  ])('refuses %s as a validation failure', async (_label, query) => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const answer = await ops.client.get(`${LIST}?${query}`);
    expect(answer.status).toBe(400);
    expect(codeOf(answer)).toBe('VALIDATION_FAILED');
  });
});

describe('listNotifications: who may ask', () => {
  // Break caught: a reader without the key of the operation served, or told anything but PERMISSION_DENIED.
  it('refuses a holder of another bundle’s keys: Finance holds no notification.read', async () => {
    const finance = await routes.actor(BUNDLE_IDS.finance, HUB_A);
    const answer = await finance.client.get(LIST);
    expect(answer.status).toBe(403);
    expect(codeOf(answer)).toBe('PERMISSION_DENIED');
  });

  // Break caught: a vendor shown the platform's log of messages (it holds many numbers of other senders' pickups).
  it('refuses a vendor', async () => {
    const answer = await vendorBrowser.get(LIST);
    expect(answer.status).toBe(403);
    expect(codeOf(answer)).toBe('PERMISSION_DENIED');
    expect(answer.text).not.toContain('message_kind');
  });

  it('refuses a request with no session', async () => {
    const answer = await routes.browser().get(LIST);
    expect(answer.status).toBe(401);
    expect(codeOf(answer)).toBe('SESSION_INVALID');
  });

  // Break caught: a Rider reaching the log. The operation serves a browser session, and a rider holds neither.
  it('shows a Rider no message', async () => {
    const rider = await arrangedFixedSession(routes.kit, routes.admin, 'RIDER');
    const client = routes.kit.client.fork().bearer(rider.token);
    const answer = await client.get(LIST);
    expect([401, 403]).toContain(answer.status);
    expect(answer.text).not.toContain('message_kind');
  });

  // Break caught: the scope of another key opening the log: a reader with the pickup keys of the hub and not notification.read.
  it('refuses a staff member whose bundle holds pickup keys and not notification.read', async () => {
    const bundle = await newBundle(routes.admin, [grant('pickup.read', 'own', 'any', 'A')]);
    const reader = await routes.actor(bundle, HUB_A);
    const answer = await reader.client.get(LIST);
    expect(answer.status).toBe(403);
    expect(codeOf(answer)).toBe('PERMISSION_DENIED');
  });
});

describe('an authorised read of another hub is audited, without contents', () => {
  // Break caught: a read of another hub that leaves no record, or a record that carries the messages' contents.
  it('writes one hub-boundary event for each other hub a page represents, and none for the actor’s own', async () => {
    const bundle = await newBundle(routes.admin, [grant('notification.read', 'all', 'any', 'A')]);
    const reader = await routes.actor(bundle, HUB_A);
    const events = async () =>
      routes.rows<{ object_type: string; object_id: string; responsible_hub_id: string }>(
        `select object_type, object_id, responsible_hub_id from audit_event
          where event_code = 'auth.hub_boundary.crossed' and actor_id = $1 order by recorded_at, id`,
        [reader.identity.id],
      );

    // A page of the actor's own hub only: nothing crossed.
    expect((await reader.client.get(`${LIST}?state=SENT`)).status).toBe(200);
    expect(await events()).toEqual([]);

    // A page that holds rows of the other hub: one event for that hub, naming it and the operation, however many rows it holds.
    const answer = await reader.client.get(`${LIST}?page_size=100`);
    expect(answer.status).toBe(200);
    expect(pageOf(answer).items.some((item) => item.responsible_hub_id === HUB_B)).toBe(true);
    const crossed = await events();
    expect(crossed).toHaveLength(1);
    expect(crossed[0]).toMatchObject({
      object_type: 'HUB',
      object_id: HUB_B,
      responsible_hub_id: HUB_B,
    });
    const detail = await routes.rows<{ related_ids: unknown; detail: unknown }>(
      `select related_ids, detail from audit_event where event_code = 'auth.hub_boundary.crossed' and actor_id = $1`,
      [reader.identity.id],
    );
    expect(JSON.stringify(detail)).toContain('listNotifications');
    expect(JSON.stringify(detail)).not.toContain('+233');
    expect(JSON.stringify(detail)).not.toContain(ARRANGED_DIGEST);
  });
});
