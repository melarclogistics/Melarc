import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { insertStaff, staffRow } from './support/identities.js';
import { insertManifest, insertStop, manifestRow, stopRow } from './support/manifests.js';
import {
  ARRANGED_DIGEST,
  insertNotification,
  type NotificationArrangement,
} from './support/notifications.js';
import {
  exceptionRow,
  insertOnePackageException,
  insertPickupRequest,
  pickupRequestRow,
  type PickupRequestRow,
} from './support/pickups.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import { insertRider, riderRow } from './support/riders.js';
import { arrangedRider, type ArrangedRider } from './support/runs.js';
import { API, HUB_A, HUB_B, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * Task C3, the optional `hub_id` of `listPickupRequests`, `listPickupManifests`, `listNotifications` (the message log) and `getQueueSummary`,
 * against the real application and a real PostgreSQL (`AC-HUBF-01` to `-08`, `-10`, `-11` and `-12` of features/operations/hub-filters.md; the
 * Product Owner's decision D12 of 6 November 2026): **a filter that narrows what the caller may see and never widens it**; a hub outside the
 * session's grant, or that names no hub, is an empty page and a count of 0 and never `HUB_SCOPE_VIOLATION`; a value that is not an identifier
 * is `VALIDATION_FAILED` naming `hub_id`, after the guards; the audit of a read does not change with the filter; and a count with a hub is
 * what the list of its queue returns with that hub.
 *
 * One arrangement serves them all: two hubs with requests, runs, messages and staff profiles in every queue (and a third hub that exists and
 * holds none of them), two vendors with requests in both hubs, and riders with dispatched runs in both. It is read by an Ops Staff officer
 * and a Senior Ops user of the first hub, a Platform Admin with no primary hub and a Platform Admin whose primary hub is the first, and by the
 * bundles of the queues' keys at one hub and at every hub.
 *
 * **Every derived expectation is paired with one written out by hand.** The derived ones are the application's own answers to another
 * question: the unfiltered read of the same session, kept in the test to the hub that each item carries; a partition (the hubs' reads
 * together are the whole read, and nothing is in two) or a sum (the pickup queues of the hubs add up to the all-hub count); and, for every
 * queue and hub, the number of items of the queue's own list read to its last page with the same `hub_id`. The hand-written ones are the names
 * and figures of the arranged data (below, where it is arranged: the staff queue is the one that does not add up), which the first describe
 * also finds again from the rows by plain code. A count equal to its list cannot catch a hub condition lost from the one function both call,
 * which is why the figures exist. Two comparisons are such by nature, and have no figure of their own: an identifier in capitals is the same
 * hub as in lower case, and the officer and the Senior Ops user, naming their own hub, are given the pages they are given without it.
 */
const REQUESTS = `${API}/pickup-requests`;
const RUNS = `${API}/pickup-manifests`;
const MESSAGES = `${API}/notifications`;
const SUMMARY = `${API}/ops/queue-summary`;
const STAFF = `${API}/staff-identities`;

/** A hub that exists and holds none of the records, and the identifier of no hub at all. */
const HUB_C = 'c0c0c0c0-0000-4000-8000-00000000000c';
const NO_HUB = randomUUID();

/** Two days of service, for the filters by day. */
const D1 = '2026-11-03';
const D2 = '2026-11-04';

/**
 * The moments the arranged records entered their queues, chosen so that the oldest of a queue is not always the same hub's: for the late
 * bookings and the runs in progress the second hub's is the older of the two, for the exceptions asked for and the pool the first hub's is.
 */
const T = {
  lateB1: new Date('2026-10-29T08:00:00.000Z'),
  lateA: new Date('2026-10-30T08:00:00.000Z'),
  lateB2: new Date('2026-11-01T08:00:00.000Z'),
  poolA1: new Date('2026-10-31T08:00:00.000Z'),
  poolA2: new Date('2026-11-01T09:00:00.000Z'),
  poolA3: new Date('2026-11-02T08:00:00.000Z'),
  poolB1: new Date('2026-11-02T10:00:00.000Z'),
  askedA1: new Date('2026-10-30T09:00:00.000Z'),
  askedB1: new Date('2026-11-01T10:00:00.000Z'),
  askedA2: new Date('2026-11-02T09:00:00.000Z'),
  startedB1: new Date('2026-11-02T07:00:00.000Z'),
  startedA1: new Date('2026-11-03T07:00:00.000Z'),
  startedB2: new Date('2026-11-03T09:00:00.000Z'),
};

/** The moment the nth request is created: a minute after the one before it, so that the order of the list is the test's and not the clock's. */
const createdAt = (n: number): Date => new Date(Date.UTC(2026, 9, 19, 8, n, 0));

/** A moment `seconds` after a fixed start: a message is made then, and the log is ordered by it. */
const at = (seconds: number): string =>
  new Date(Date.UTC(2026, 9, 28, 10, 0, 0) + seconds * 1000).toISOString();

// ---- What is arranged, in the order it is made (which is the order of the lists), and the names the tests call it by. A name begins with
// the hub's letter: `a.` is the first hub's and `b.` the second's.

interface RequestSpec {
  readonly name: string;
  readonly hub: string;
  readonly vendor: 'one' | 'two';
  readonly day: string;
  readonly overrides?: Partial<PickupRequestRow>;
  /** The moment an exception is asked for on this request (it is a request of one package), when it has one. */
  readonly asked?: Date;
}

const REQUEST_SPECS: readonly RequestSpec[] = [
  { name: 'b.pending1', hub: HUB_B, vendor: 'one', day: D1 },
  { name: 'a.pending1', hub: HUB_A, vendor: 'one', day: D1 },
  { name: 'a.pending2', hub: HUB_A, vendor: 'two', day: D2 },
  {
    name: 'b.late1',
    hub: HUB_B,
    vendor: 'two',
    day: D2,
    overrides: { state: 'CONFIRMED', cutoffState: 'PENDING_OPS_REVIEW', confirmedAt: T.lateB1 },
  },
  {
    name: 'a.pool1',
    hub: HUB_A,
    vendor: 'one',
    day: D1,
    overrides: { state: 'CONFIRMED', confirmedAt: T.poolA1 },
  },
  {
    name: 'a.late',
    hub: HUB_A,
    vendor: 'two',
    day: D1,
    overrides: { state: 'CONFIRMED', cutoffState: 'PENDING_OPS_REVIEW', confirmedAt: T.lateA },
  },
  {
    name: 'b.pool1',
    hub: HUB_B,
    vendor: 'one',
    day: D2,
    overrides: { state: 'CONFIRMED', confirmedAt: T.poolB1 },
  },
  {
    name: 'a.pendingExc',
    hub: HUB_A,
    vendor: 'one',
    day: D1,
    overrides: { packages: 1 },
    asked: T.askedA1,
  },
  {
    name: 'b.pendingExc',
    hub: HUB_B,
    vendor: 'two',
    day: D1,
    overrides: { packages: 1 },
    asked: T.askedB1,
  },
  {
    name: 'a.pool2',
    hub: HUB_A,
    vendor: 'two',
    day: D2,
    overrides: { state: 'CONFIRMED', confirmedAt: T.poolA2 },
  },
  { name: 'b.cancelled', hub: HUB_B, vendor: 'one', day: D1, overrides: { state: 'CANCELLED' } },
  { name: 'a.cancelled', hub: HUB_A, vendor: 'one', day: D2, overrides: { state: 'CANCELLED' } },
  {
    name: 'a.pendingExc2',
    hub: HUB_A,
    vendor: 'two',
    day: D2,
    overrides: { packages: 1 },
    asked: T.askedA2,
  },
  {
    name: 'b.late2',
    hub: HUB_B,
    vendor: 'one',
    day: D1,
    overrides: { state: 'CONFIRMED', cutoffState: 'PENDING_OPS_REVIEW', confirmedAt: T.lateB2 },
  },
  {
    name: 'a.pool3',
    hub: HUB_A,
    vendor: 'one',
    day: D1,
    overrides: { state: 'CONFIRMED', confirmedAt: T.poolA3 },
  },
  // Confirmed and held by a stop of a draft run: not in the pool.
  { name: 'a.onRun', hub: HUB_A, vendor: 'two', day: D1, overrides: { state: 'CONFIRMED' } },
  { name: 'b.onRun', hub: HUB_B, vendor: 'one', day: D2, overrides: { state: 'CONFIRMED' } },
  // The two requests that messages are about under the other hub (below): cancelled, so that they are in no queue.
  { name: 'a.moved', hub: HUB_A, vendor: 'two', day: D1, overrides: { state: 'CANCELLED' } },
  { name: 'b.moved', hub: HUB_B, vendor: 'two', day: D2, overrides: { state: 'CANCELLED' } },
];

type RunState = 'DRAFT' | 'DISPATCHED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
interface RunSpec {
  readonly name: string;
  readonly hub: string;
  readonly state: RunState;
  readonly day: string;
  /** Which of the three riders it is assigned to (none: unassigned). */
  readonly rider?: 'one' | 'two' | 'three';
  readonly startedAt?: Date;
  /** The request a stop of this run holds. */
  readonly holds?: string;
}

const RUN_SPECS: readonly RunSpec[] = [
  {
    name: 'b.progress1',
    hub: HUB_B,
    state: 'IN_PROGRESS',
    day: D2,
    rider: 'two',
    startedAt: T.startedB1,
  },
  // A draft is assigned to rider one and not shown to it: it has not been dispatched.
  { name: 'a.draft', hub: HUB_A, state: 'DRAFT', day: D1, rider: 'one', holds: 'a.onRun' },
  {
    name: 'a.progress',
    hub: HUB_A,
    state: 'IN_PROGRESS',
    day: D1,
    rider: 'two',
    startedAt: T.startedA1,
  },
  { name: 'b.draft', hub: HUB_B, state: 'DRAFT', day: D2, holds: 'b.onRun' },
  { name: 'a.dispatched', hub: HUB_A, state: 'DISPATCHED', day: D2, rider: 'one' },
  {
    name: 'b.progress2',
    hub: HUB_B,
    state: 'IN_PROGRESS',
    day: D1,
    rider: 'three',
    startedAt: T.startedB2,
  },
  { name: 'a.cancelled', hub: HUB_A, state: 'CANCELLED', day: D2 },
  { name: 'b.dispatched', hub: HUB_B, state: 'DISPATCHED', day: D1, rider: 'one' },
  { name: 'a.completed', hub: HUB_A, state: 'COMPLETED', day: D1, rider: 'one' },
  { name: 'b.cancelled', hub: HUB_B, state: 'CANCELLED', day: D1 },
];

interface MessageSpec {
  readonly name: string;
  readonly hub: string;
  /** The request the message is about. */
  readonly about: string;
  readonly over: Omit<NotificationArrangement, 'subjectId' | 'hubId' | 'createdAt'>;
}

/** Oldest first; the log shows the newest first. */
const MESSAGE_SPECS: readonly MessageSpec[] = [
  { name: 'a.delivered', hub: HUB_A, about: 'a.pending1', over: { state: 'DELIVERED' } },
  { name: 'b.queued', hub: HUB_B, about: 'b.pending1', over: { state: 'QUEUED' } },
  { name: 'a.queued', hub: HUB_A, about: 'a.pending2', over: { state: 'QUEUED' } },
  {
    name: 'b.feed',
    hub: HUB_B,
    about: 'b.late1',
    over: {
      state: 'DELIVERED',
      channel: 'FEED',
      audience: 'VENDOR_FEED',
      messageKind: 'PICKUP_CONFIRMED_VENDOR_FEED',
    },
  },
  {
    name: 'a.opsFeed',
    hub: HUB_A,
    about: 'a.late',
    over: {
      state: 'DELIVERED',
      channel: 'FEED',
      audience: 'OPS_FEED',
      messageKind: 'PICKUP_FAILURE_ESCALATED_OPS_FEED',
    },
  },
  {
    name: 'a.suppressed',
    hub: HUB_A,
    about: 'a.pool1',
    over: { state: 'SUPPRESSED', suppressionReason: 'DAY_LIMIT' },
  },
  {
    name: 'b.failed',
    hub: HUB_B,
    about: 'b.pool1',
    over: { state: 'FAILED', outcomeClass: 'REJECTED', providerOutcomeClass: 'REQUEST_INVALID' },
  },
  {
    name: 'a.rider',
    hub: HUB_A,
    about: 'a.onRun',
    over: { state: 'SENT', audience: 'RIDER', messageKind: 'RUN_DISPATCHED_RIDER' },
  },
  {
    name: 'b.opsFeed',
    hub: HUB_B,
    about: 'b.late2',
    over: {
      state: 'DELIVERED',
      channel: 'FEED',
      audience: 'OPS_FEED',
      messageKind: 'PICKUP_FAILURE_ESCALATED_OPS_FEED',
    },
  },
  {
    name: 'a.feed',
    hub: HUB_A,
    about: 'a.pendingExc',
    over: {
      state: 'DELIVERED',
      channel: 'FEED',
      audience: 'VENDOR_FEED',
      messageKind: 'PICKUP_CONFIRMED_VENDOR_FEED',
    },
  },
  {
    name: 'b.recipient',
    hub: HUB_B,
    about: 'b.pendingExc',
    over: { state: 'SENT', audience: 'RECIPIENT', messageKind: 'RECIPIENT_HEADS_UP' },
  },
  // The first hub's message about a request that is the second hub's now (and the other way round): a message is in the hub its record
  // answered to when the act was done, and keeps it.
  { name: 'a.aboutB', hub: HUB_A, about: 'b.moved', over: { state: 'DELIVERED' } },
  {
    name: 'b.aboutA',
    hub: HUB_B,
    about: 'a.moved',
    over: {
      state: 'QUEUED',
      audience: 'VENDOR_NUMBER',
      messageKind: 'HANDSHAKE_CODE_VENDOR_NUMBER',
    },
  },
];

// ---- The lists, written out by hand: each hub's, and the whole, in the order the list serves them.

const A_REQUESTS = [
  'a.pending1',
  'a.pending2',
  'a.pool1',
  'a.late',
  'a.pendingExc',
  'a.pool2',
  'a.cancelled',
  'a.pendingExc2',
  'a.pool3',
  'a.onRun',
  'a.moved',
];
const B_REQUESTS = [
  'b.pending1',
  'b.late1',
  'b.pool1',
  'b.pendingExc',
  'b.cancelled',
  'b.late2',
  'b.onRun',
  'b.moved',
];
const ALL_REQUESTS = [
  'b.pending1',
  'a.pending1',
  'a.pending2',
  'b.late1',
  'a.pool1',
  'a.late',
  'b.pool1',
  'a.pendingExc',
  'b.pendingExc',
  'a.pool2',
  'b.cancelled',
  'a.cancelled',
  'a.pendingExc2',
  'b.late2',
  'a.pool3',
  'a.onRun',
  'b.onRun',
  'a.moved',
  'b.moved',
];

const A_RUNS = ['a.draft', 'a.progress', 'a.dispatched', 'a.cancelled', 'a.completed'];
const B_RUNS = ['b.progress1', 'b.draft', 'b.progress2', 'b.dispatched', 'b.cancelled'];
const ALL_RUNS = [
  'b.progress1',
  'a.draft',
  'a.progress',
  'b.draft',
  'a.dispatched',
  'b.progress2',
  'a.cancelled',
  'b.dispatched',
  'a.completed',
  'b.cancelled',
];

/** Newest first. */
const A_MESSAGES = [
  'a.aboutB',
  'a.feed',
  'a.rider',
  'a.suppressed',
  'a.opsFeed',
  'a.queued',
  'a.delivered',
];
const B_MESSAGES = ['b.aboutA', 'b.recipient', 'b.opsFeed', 'b.failed', 'b.feed', 'b.queued'];
const ALL_MESSAGES = [
  'b.aboutA',
  'a.aboutB',
  'b.recipient',
  'a.feed',
  'b.opsFeed',
  'a.rider',
  'b.failed',
  'a.suppressed',
  'a.opsFeed',
  'b.feed',
  'a.queued',
  'b.queued',
  'a.delivered',
];

/** Each read, with another filter of its own, and what each hub holds of it: two names' lists, written out by hand, for every combination. */
type Filter = Readonly<Record<string, string | undefined>>;
interface Combination {
  readonly label: string;
  readonly filter: () => Filter;
  readonly a: readonly string[];
  readonly b: readonly string[];
}

const REQUEST_COMBINATIONS: readonly Combination[] = [
  {
    label: 'state=PENDING',
    filter: () => ({ state: 'PENDING' }),
    a: ['a.pending1', 'a.pending2', 'a.pendingExc', 'a.pendingExc2'],
    b: ['b.pending1', 'b.pendingExc'],
  },
  {
    label: 'state=CONFIRMED',
    filter: () => ({ state: 'CONFIRMED' }),
    a: ['a.pool1', 'a.late', 'a.pool2', 'a.pool3', 'a.onRun'],
    b: ['b.late1', 'b.pool1', 'b.late2', 'b.onRun'],
  },
  {
    label: 'state=CANCELLED',
    filter: () => ({ state: 'CANCELLED' }),
    a: ['a.cancelled', 'a.moved'],
    b: ['b.cancelled', 'b.moved'],
  },
  {
    label: 'service_date=D1',
    filter: () => ({ service_date: D1 }),
    a: ['a.pending1', 'a.pool1', 'a.late', 'a.pendingExc', 'a.pool3', 'a.onRun', 'a.moved'],
    b: ['b.pending1', 'b.pendingExc', 'b.cancelled', 'b.late2'],
  },
  // The second hub has no pending request on the second day: "and", and not "or".
  {
    label: 'state=PENDING and service_date=D2',
    filter: () => ({ state: 'PENDING', service_date: D2 }),
    a: ['a.pending2', 'a.pendingExc2'],
    b: [],
  },
  {
    label: 'state=CONFIRMED and service_date=D2',
    filter: () => ({ state: 'CONFIRMED', service_date: D2 }),
    a: ['a.pool2'],
    b: ['b.late1', 'b.pool1', 'b.onRun'],
  },
  {
    label: 'manifested=true',
    filter: () => ({ manifested: 'true' }),
    a: ['a.onRun'],
    b: ['b.onRun'],
  },
  {
    label: 'state=CONFIRMED and manifested=false (the pool)',
    filter: () => ({ state: 'CONFIRMED', manifested: 'false' }),
    a: ['a.pool1', 'a.pool2', 'a.pool3'],
    b: ['b.pool1'],
  },
  {
    label: 'one_package_exception_state=REQUESTED',
    filter: () => ({ one_package_exception_state: 'REQUESTED' }),
    a: ['a.pendingExc', 'a.pendingExc2'],
    b: ['b.pendingExc'],
  },
  {
    label: 'cutoff_exception_state=PENDING_OPS_REVIEW',
    filter: () => ({ cutoff_exception_state: 'PENDING_OPS_REVIEW' }),
    a: ['a.late'],
    b: ['b.late1', 'b.late2'],
  },
  {
    label: 'state=CONFIRMED and cutoff_exception_state=PENDING_OPS_REVIEW',
    filter: () => ({ state: 'CONFIRMED', cutoff_exception_state: 'PENDING_OPS_REVIEW' }),
    a: ['a.late'],
    b: ['b.late1', 'b.late2'],
  },
];

const RUN_COMBINATIONS: readonly Combination[] = [
  {
    label: 'state=IN_PROGRESS',
    filter: () => ({ state: 'IN_PROGRESS' }),
    a: ['a.progress'],
    b: ['b.progress1', 'b.progress2'],
  },
  { label: 'state=DRAFT', filter: () => ({ state: 'DRAFT' }), a: ['a.draft'], b: ['b.draft'] },
  {
    label: 'state=DISPATCHED',
    filter: () => ({ state: 'DISPATCHED' }),
    a: ['a.dispatched'],
    b: ['b.dispatched'],
  },
  {
    label: 'state=COMPLETED',
    filter: () => ({ state: 'COMPLETED' }),
    a: ['a.completed'],
    b: [],
  },
  {
    label: 'state=CANCELLED',
    filter: () => ({ state: 'CANCELLED' }),
    a: ['a.cancelled'],
    b: ['b.cancelled'],
  },
  {
    label: 'service_date=D1',
    filter: () => ({ service_date: D1 }),
    a: ['a.draft', 'a.progress', 'a.completed'],
    b: ['b.progress2', 'b.dispatched', 'b.cancelled'],
  },
  {
    label: 'service_date=D2',
    filter: () => ({ service_date: D2 }),
    a: ['a.dispatched', 'a.cancelled'],
    b: ['b.progress1', 'b.draft'],
  },
  {
    label: 'state=IN_PROGRESS and service_date=D1',
    filter: () => ({ state: 'IN_PROGRESS', service_date: D1 }),
    a: ['a.progress'],
    b: ['b.progress2'],
  },
  // The second hub's draft is on the second day, and its dispatched run on the first: "and", and not "or".
  {
    label: 'state=DRAFT and service_date=D1',
    filter: () => ({ state: 'DRAFT', service_date: D1 }),
    a: ['a.draft'],
    b: [],
  },
  {
    label: 'state=DISPATCHED and service_date=D2',
    filter: () => ({ state: 'DISPATCHED', service_date: D2 }),
    a: ['a.dispatched'],
    b: [],
  },
];

const MESSAGE_COMBINATIONS: readonly Combination[] = [
  {
    label: 'state=QUEUED',
    filter: () => ({ state: 'QUEUED' }),
    a: ['a.queued'],
    b: ['b.aboutA', 'b.queued'],
  },
  {
    label: 'state=DELIVERED',
    filter: () => ({ state: 'DELIVERED' }),
    a: ['a.aboutB', 'a.feed', 'a.opsFeed', 'a.delivered'],
    b: ['b.opsFeed', 'b.feed'],
  },
  {
    label: 'state=SENT',
    filter: () => ({ state: 'SENT' }),
    a: ['a.rider'],
    b: ['b.recipient'],
  },
  {
    label: 'state=SUPPRESSED',
    filter: () => ({ state: 'SUPPRESSED' }),
    a: ['a.suppressed'],
    b: [],
  },
  { label: 'state=FAILED', filter: () => ({ state: 'FAILED' }), a: [], b: ['b.failed'] },
  {
    label: 'audience=OPS_FEED',
    filter: () => ({ audience: 'OPS_FEED' }),
    a: ['a.opsFeed'],
    b: ['b.opsFeed'],
  },
  {
    label: 'audience=AD_HOC_SENDER',
    filter: () => ({ audience: 'AD_HOC_SENDER' }),
    a: ['a.aboutB', 'a.suppressed', 'a.queued', 'a.delivered'],
    b: ['b.failed', 'b.queued'],
  },
  {
    label: 'channel=FEED',
    filter: () => ({ channel: 'FEED' }),
    a: ['a.feed', 'a.opsFeed'],
    b: ['b.opsFeed', 'b.feed'],
  },
  {
    label: 'channel=SMS',
    filter: () => ({ channel: 'SMS' }),
    a: ['a.aboutB', 'a.rider', 'a.suppressed', 'a.queued', 'a.delivered'],
    b: ['b.aboutA', 'b.recipient', 'b.failed', 'b.queued'],
  },
  {
    label: 'channel=FEED and audience=VENDOR_FEED',
    filter: () => ({ channel: 'FEED', audience: 'VENDOR_FEED' }),
    a: ['a.feed'],
    b: ['b.feed'],
  },
  {
    label: 'state=DELIVERED and audience=AD_HOC_SENDER',
    filter: () => ({ state: 'DELIVERED', audience: 'AD_HOC_SENDER' }),
    a: ['a.aboutB', 'a.delivered'],
    b: [],
  },
  // A record of the second hub whose message is the second hub's: the first hub's page of it is empty, and the second's is the message.
  {
    label: 'subject_id of a request of the second hub',
    filter: () => ({ subject_id: requestId('b.pending1') }),
    a: [],
    b: ['b.queued'],
  },
  // A request that is the second hub's now, whose message was made when it answered to the first: the message stays where it was made.
  {
    label: 'subject_id of a request that is the second hub’s now',
    filter: () => ({ subject_id: requestId('b.moved') }),
    a: ['a.aboutB'],
    b: [],
  },
  {
    label: 'subject_id of a request that is the first hub’s now',
    filter: () => ({ subject_id: requestId('a.moved') }),
    a: [],
    b: ['b.aboutA'],
  },
];

// ---- The queues: what each holds, per hub, written out by hand (the staff queue is the one that does not add up).

type PickupQueue =
  | 'PICKUP_AWAITING_CONFIRMATION'
  | 'PICKUP_CUTOFF_REVIEW'
  | 'PICKUP_EXCEPTION_APPROVAL'
  | 'PICKUP_UNMANIFESTED_POOL'
  | 'PICKUP_RUNS_IN_PROGRESS';
type Queue = PickupQueue | 'STAFF_AWAITING_APPROVAL';

interface Entry {
  readonly queue: Queue;
  readonly count: number;
  readonly oldest_at?: string;
}

/** What a queue holds of one group of records (one hub's), and the moment of the oldest of them. */
interface Group {
  readonly count: number;
  readonly oldest?: string;
}

const PICKUP_QUEUES: readonly PickupQueue[] = [
  'PICKUP_AWAITING_CONFIRMATION',
  'PICKUP_CUTOFF_REVIEW',
  'PICKUP_EXCEPTION_APPROVAL',
  'PICKUP_UNMANIFESTED_POOL',
  'PICKUP_RUNS_IN_PROGRESS',
];

/**
 * Pending: A has four (two plain, two with an exception asked for) and B two; the oldest of all is B's. Late bookings: A one, B two (the oldest
 * of all is B's). Exceptions asked for: A two, B one (the oldest of all is A's). The pool: A three, B one (a request on a run, and the late
 * bookings, are not in it; the oldest of all is A's). Runs in progress: A one, B two (the oldest of all is B's).
 */
const PICKUP_FIGURES: Record<PickupQueue, { readonly a: Group; readonly b: Group }> = {
  PICKUP_AWAITING_CONFIRMATION: {
    a: { count: 4, oldest: '2026-10-19T08:02:00.000Z' },
    b: { count: 2, oldest: '2026-10-19T08:01:00.000Z' },
  },
  PICKUP_CUTOFF_REVIEW: {
    a: { count: 1, oldest: '2026-10-30T08:00:00.000Z' },
    b: { count: 2, oldest: '2026-10-29T08:00:00.000Z' },
  },
  PICKUP_EXCEPTION_APPROVAL: {
    a: { count: 2, oldest: '2026-10-30T09:00:00.000Z' },
    b: { count: 1, oldest: '2026-11-01T10:00:00.000Z' },
  },
  PICKUP_UNMANIFESTED_POOL: {
    a: { count: 3, oldest: '2026-10-31T08:00:00.000Z' },
    b: { count: 1, oldest: '2026-11-02T10:00:00.000Z' },
  },
  PICKUP_RUNS_IN_PROGRESS: {
    a: { count: 1, oldest: '2026-11-03T07:00:00.000Z' },
    b: { count: 2, oldest: '2026-11-02T07:00:00.000Z' },
  },
};

/** The profiles waiting for approval, by the hub they were made for: two at A, one at B, and one with no hub (so that the hubs do not add up). */
const STAFF_PROFILES: readonly { readonly name: string; readonly hub: string | null }[] = [
  { name: 'none', hub: null },
  { name: 'b.only', hub: HUB_B },
  { name: 'a.first', hub: HUB_A },
  { name: 'a.second', hub: HUB_A },
];

// ---- Who asks.

/**
 * What a session reads. `reaches` is the hubs of its grant of the key of the pickup lists (and of the message log); `staff` is the grant of
 * the key of the staff list and of its decision key, which the queue of profiles needs: none (no entry), the hubs it reaches and whether it
 * reaches the profiles with no hub (the grant of every hub does).
 */
interface Role {
  readonly become: () => Promise<Actor>;
  readonly reaches: readonly string[];
  readonly staff: { readonly hubs: readonly string[]; readonly hubless: boolean } | null;
}

let routes: VendorRoutes;
let vendorOne: ArrangedVendor;
let vendorTwo: ArrangedVendor;
let browserOne: TestClient;
let browserTwo: TestClient;
/** Dispatched runs in both hubs (and a draft that it is not shown); and a dispatched run in the second hub alone. */
let riderOne: ArrangedRider;
let riderThree: ArrangedRider;
const requestIds: Record<string, string> = {};
const runIds: Record<string, string> = {};
/** When each profile was made, as the table has it: a profile's creation moment is not in its representation. */
const profileMoments: Record<string, string> = {};
/** The name of every arranged record by its identifier: a list is read as the names of what it returned. */
const named = new Map<string, string>();

const ROLES: readonly [string, Role][] = [
  [
    'an Ops Staff officer of the first hub',
    { become: () => routes.actor(BUNDLE_IDS.opsStaff, HUB_A), reaches: [HUB_A], staff: null },
  ],
  [
    'a Senior Ops user of the first hub',
    {
      become: () => routes.actor(BUNDLE_IDS.seniorOps, HUB_A),
      reaches: [HUB_A],
      staff: { hubs: [HUB_A], hubless: false },
    },
  ],
  [
    'a Platform Admin with no primary hub',
    {
      become: () => routes.platformAdmin(),
      reaches: [HUB_A, HUB_B],
      staff: { hubs: [HUB_A, HUB_B], hubless: true },
    },
  ],
  [
    'a Platform Admin whose primary hub is the first',
    {
      become: () => routes.actor(BUNDLE_IDS.platformAdmin, HUB_A),
      reaches: [HUB_A, HUB_B],
      staff: { hubs: [HUB_A, HUB_B], hubless: true },
    },
  ],
];
const [OFFICER, SENIOR, ADMIN_NO_HUB, ADMIN_WITH_HUB] = ROLES.map(([, role]) => role) as [
  Role,
  Role,
  Role,
  Role,
];

/** The sessions that read one hub (the first), and the sessions that read both. */
const ONE_HUB_ROLES = ROLES.slice(0, 2);
const BOTH_HUBS_ROLES = ROLES.slice(2);

/** The bundles of the keys of the queues' lists: every one at all hubs; and the pickup keys at one hub with the staff key at all of them. */
const BUNDLE_ROLES: readonly [string, Role][] = [
  [
    'a bundle of the all-hub grants of the queues’ lists',
    {
      become: async () =>
        routes.actor(
          await newBundle(routes.admin, [
            grant('pickup.read', 'all'),
            grant('pickup.exception.approve', 'all'),
            grant('staff.read', 'all'),
            grant('staff.identity.approve', 'all'),
          ]),
          HUB_A,
        ),
      reaches: [HUB_A, HUB_B],
      staff: { hubs: [HUB_A, HUB_B], hubless: true },
    },
  ],
  [
    'a bundle that reads the pickups at its first hub and the staff at all of them',
    {
      become: async () => routes.actor(await mixedBundle(), HUB_A),
      reaches: [HUB_A],
      staff: { hubs: [HUB_A, HUB_B], hubless: true },
    },
  ],
  [
    'a bundle that reads the pickups at its second hub and the staff at all of them',
    {
      become: async () => routes.actor(await mixedBundle(), HUB_B),
      reaches: [HUB_B],
      staff: { hubs: [HUB_A, HUB_B], hubless: true },
    },
  ],
];

const [ALL_HUB_BUNDLE, MIXED_AT_FIRST, MIXED_AT_SECOND] = BUNDLE_ROLES.map(([, role]) => role) as [
  Role,
  Role,
  Role,
];

/** Pickup keys at the hub of the session, the exception's decision key at every hub, the staff key at every hub and its decision key at the hub. */
const mixedBundle = (): Promise<string> =>
  newBundle(routes.admin, [
    grant('pickup.read', 'own'),
    grant('pickup.exception.approve', 'all'),
    grant('staff.read', 'all'),
    grant('staff.identity.approve', 'own'),
  ]);

// ---- Reading.

const requestId = (name: string): string => idOf(requestIds, name);
const runId = (name: string): string => idOf(runIds, name);

function idOf(table: Readonly<Record<string, string>>, name: string): string {
  const found = table[name];
  if (found === undefined) throw new Error(`nothing was arranged as ${name}`);
  return found;
}

const nameOf = (id: string): string => named.get(id) ?? `unarranged ${id}`;
const namesOf = (items: readonly { readonly id: string }[]): string[] =>
  items.map((item) => nameOf(item.id));

/** The names of a hub in the order of the whole list, whichever hubs a session reads and whichever one is asked for. */
function expectedNames(
  role: Role,
  hub: string | undefined,
  combination: Combination,
  order: readonly string[],
): string[] {
  const hubOf = (name: string): string => (name.startsWith('a.') ? HUB_A : HUB_B);
  return [...combination.a, ...combination.b]
    .filter(
      (name) => role.reaches.includes(hubOf(name)) && (hub === undefined || hubOf(name) === hub),
    )
    .toSorted((x, y) => order.indexOf(x) - order.indexOf(y));
}

const queryOf = (filter: Filter): string => {
  const given = Object.entries(filter).filter(
    (pair): pair is [string, string] => pair[1] !== undefined,
  );
  return given.length === 0
    ? ''
    : `?${given.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&')}`;
};

interface Page<T> {
  readonly items: T[];
  readonly next_page_token: string | null;
}
interface RequestItem {
  readonly id: string;
  readonly responsible_hub_id: string;
  readonly created_at: string;
  readonly confirmed_at: string | null;
  readonly one_package_exception: { readonly requested_at: string } | null;
}
interface RunItem {
  readonly id: string;
  readonly responsible_hub_id: string;
  readonly started_at: string | null;
}
interface MessageItem {
  readonly id: string;
  readonly responsible_hub_id: string;
}
interface StaffItem {
  readonly id: string;
  readonly primary_hub_id: string | null;
}

interface Read<T> {
  readonly status: number;
  readonly items: readonly T[];
  /** The pages as they were served, first to last: their items and their tokens. */
  readonly pages: readonly Page<T>[];
  /** The answer to the last request, for what is read from its head. */
  readonly last: TestResponse;
}

/** A list read to its last page by the tokens it gave, with the same filters on every page; a status other than 200 stops the read at it. */
async function readAll<T>(
  client: TestClient,
  path: string,
  filter: Filter = {},
  pageSize = 100,
): Promise<Read<T>> {
  const pages: Page<T>[] = [];
  let token: string | undefined;
  for (;;) {
    const response = await client.get(
      `${path}${queryOf({ ...filter, page_size: String(pageSize), page_token: token })}`,
    );
    if (response.status !== 200)
      return { status: response.status, items: [], pages, last: response };
    const page = response.json() as Page<T>;
    pages.push(page);
    if (page.next_page_token === null) {
      return { status: 200, items: pages.flatMap((each) => each.items), pages, last: response };
    }
    token = page.next_page_token;
    if (pages.length > 60) throw new Error(`${path} did not end after 60 pages`);
  }
}

/** What two answers must share to be indistinguishable: everything but the request's own identifier and the moment. */
const shapeOf = (response: TestResponse) => ({
  status: response.status,
  body: (() => {
    const body = response.json() as Record<string, unknown>;
    return { ...body, request_id: undefined };
  })(),
  headers: response
    .headerEntries()
    .filter(([name]) => !/^(date|x-request-id|request-id)$/.test(name)),
  cookies: response.setCookies,
});

async function summaryOf(
  client: TestClient,
  hub?: string,
): Promise<{
  readonly status: number;
  readonly queues: readonly Entry[];
  readonly response: TestResponse;
}> {
  const response = await client.get(`${SUMMARY}${queryOf({ hub_id: hub })}`);
  const body = response.json() as { queues?: Entry[] };
  return { status: response.status, queues: body.queues ?? [], response };
}

/** An entry of the answer; a queue the answer does not have fails the test where it is asked for, and is not a count of 0. */
function entryIn(queues: readonly Entry[], queue: Queue): Entry {
  const found = queues.find((entry) => entry.queue === queue);
  if (found === undefined) throw new Error(`the answer has no entry for ${queue}`);
  return found;
}
const countIn = (queues: readonly Entry[], queue: Queue): number => entryIn(queues, queue).count;

/** The earliest of some ISO moments (the same format, so the text orders as the moments do). */
const earliest = (moments: readonly string[]): string | undefined => moments.toSorted()[0];

/**
 * What the queue holds of the hubs the session reads, narrowed to the hub asked for: the groups of the arranged data that both are in a hub
 * the session reaches and match the hub asked for, added up. This is the model of a filter that narrows inside a grant; it reads nothing of the
 * code under test.
 */
function combined(groups: readonly Group[]): { count: number; oldest_at?: string } {
  const oldest = earliest(
    groups.flatMap((group) => (group.oldest === undefined ? [] : [group.oldest])),
  );
  const count = groups.reduce((sum, group) => sum + group.count, 0);
  return oldest === undefined || count === 0 ? { count } : { count, oldest_at: oldest };
}

/** The summary the arranged data says for a session that reads the hubs of `role`, with `hub` asked for (or none): the hand figures, by group. */
function expectedSummary(role: Role, hub: string | undefined): Entry[] {
  const wanted = (each: string): boolean => hub === undefined || each === hub;
  const entries: Entry[] = PICKUP_QUEUES.map((queue) => {
    const groups: Group[] = [];
    if (role.reaches.includes(HUB_A) && wanted(HUB_A)) groups.push(PICKUP_FIGURES[queue].a);
    if (role.reaches.includes(HUB_B) && wanted(HUB_B)) groups.push(PICKUP_FIGURES[queue].b);
    return { queue, ...combined(groups) };
  });
  if (role.staff !== null) {
    const groups: Group[] = [];
    for (const [hubName, profileNames] of [
      [HUB_A, ['a.first', 'a.second']],
      [HUB_B, ['b.only']],
      [null, ['none']],
    ] as const) {
      const reached = hubName === null ? role.staff.hubless : role.staff.hubs.includes(hubName);
      const asked = hubName === null ? hub === undefined : wanted(hubName);
      if (reached && asked) {
        groups.push({
          count: profileNames.length,
          oldest: earliest(profileNames.map((name) => profileMoments[name] ?? '')),
        });
      }
    }
    entries.push({ queue: 'STAFF_AWAITING_APPROVAL', ...combined(groups) });
  }
  return entries;
}

// ---- The audit and the arrangement's own facts, read from the observer connection (past row-level security).

async function auditEvents(): Promise<number> {
  const [row] = await routes.rows<{ events: string }>(`select count(*) as events from audit_event`);
  return Number(row?.events);
}

interface Crossing {
  readonly object_type: string;
  readonly object_id: string;
  readonly responsible_hub_id: string;
  readonly related_ids: Record<string, unknown> | null;
  readonly detail: unknown;
}

const crossingsOf = (actor: Actor): Promise<Crossing[]> =>
  routes.rows<Crossing>(
    `select object_type, object_id, responsible_hub_id, related_ids, detail from audit_event
      where event_code = 'auth.hub_boundary.crossed' and actor_id = $1 order by recorded_at, id`,
    [actor.identity.id],
  );

// ---- The arrangement.

beforeAll(async () => {
  routes = await startVendorRoutes();
  await routes.admin.query(`insert into hub (id, name) values ($1, 'Tamale')`, [HUB_C]);
  vendorOne = await routes.vendor();
  vendorTwo = await routes.vendor();
  browserOne = routes.browser(vendorOne.device.credential.token);
  browserTwo = routes.browser(vendorTwo.device.credential.token);
  for (const [browser, vendor] of [
    [browserOne, vendorOne],
    [browserTwo, vendorTwo],
  ] as const) {
    expect((await routes.signIn(browser, vendor.row.accountIdentifier, vendor.secret)).status).toBe(
      200,
    );
  }

  // ---- The requests, in the order of the list: a minute apart, the two hubs interleaved.
  for (const [index, spec] of REQUEST_SPECS.entries()) {
    const owner = spec.vendor === 'one' ? vendorOne : vendorTwo;
    const row = await insertPickupRequest(
      routes.admin,
      pickupRequestRow(owner.row.organizationId, spec.hub, {
        serviceDate: spec.day,
        createdAt: createdAt(index + 1),
        ...spec.overrides,
      }),
    );
    requestIds[spec.name] = row.id;
    named.set(row.id, spec.name);
    if (spec.asked !== undefined) {
      await insertOnePackageException(
        routes.admin,
        exceptionRow(row.id, { requestedAt: spec.asked }),
      );
    }
  }

  // ---- The runs, two hubs interleaved. Rider one holds dispatched runs in both hubs (and a draft, which is not shown to it), rider two the
  // runs in progress of the first hub and one of the second, and rider three one run of the second hub.
  riderOne = await arrangedRider(routes.kit, routes.admin, HUB_A);
  riderThree = await arrangedRider(routes.kit, routes.admin, HUB_B);
  const riderTwo = (await insertRider(routes.admin, riderRow({ hubId: HUB_A }))).id;
  const riders = { one: riderOne.id, two: riderTwo, three: riderThree.id };
  for (const spec of RUN_SPECS) {
    const manifest = await insertManifest(
      routes.admin,
      manifestRow(spec.hub, {
        state: spec.state,
        serviceDate: spec.day,
        assignedRiderId: spec.rider === undefined ? null : riders[spec.rider],
        ...(spec.startedAt === undefined ? {} : { startedAt: spec.startedAt }),
      }),
    );
    runIds[spec.name] = manifest.id;
    named.set(manifest.id, spec.name);
    if (spec.holds !== undefined) {
      await insertStop(routes.admin, stopRow(manifest, requestId(spec.holds), 1));
    }
  }

  // ---- The messages, oldest first, each about a request.
  for (const [index, spec] of MESSAGE_SPECS.entries()) {
    const message = await insertNotification(routes.admin, {
      hubId: spec.hub,
      subjectId: requestId(spec.about),
      createdAt: at(index * 10),
      ...spec.over,
    });
    named.set(message.id, spec.name);
  }

  // ---- The profiles waiting for approval: the one with no hub is the oldest of all, then the second hub's, then the first's two.
  for (const profile of STAFF_PROFILES) {
    const row = await insertStaff(
      routes.admin,
      staffRow({
        status: 'PENDING_APPROVAL',
        approvedBy: null,
        primaryHubId: profile.hub,
        roleBundleId: BUNDLE_IDS.opsStaff,
      }),
    );
    named.set(row.id, profile.name);
    const [made] = await routes.rows<{ created_at: Date }>(
      `select created_at from staff_identity where id = $1`,
      [row.id],
    );
    profileMoments[profile.name] = made?.created_at.toISOString() ?? '';
  }
  // ... and two that are not waiting, in the first hub.
  await insertStaff(routes.admin, staffRow({ primaryHubId: HUB_A }));
  await insertStaff(
    routes.admin,
    staffRow({
      status: 'REJECTED',
      primaryHubId: HUB_A,
      credentialHash: null,
      credentialEstablishedAt: null,
    }),
  );
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

describe('the arrangement is what these tests say it is', () => {
  // Break caught: a fixture that was not inserted as intended (a request in the wrong hub or state, a stop that does not hold the claim, a message
  // under another hub than the one written, a list in another order than the one written), which would make every test below pass or fail for
  // the wrong reason.
  it('holds the requests, runs, messages and profiles of each hub as they are written above, in the order the lists serve them', async () => {
    expect(
      await routes.rows(
        `select responsible_hub_id as hub, state, count(*)::int as n from pickup_request group by 1, 2 order by 1, 2`,
      ),
    ).toEqual([
      { hub: HUB_A, state: 'CANCELLED', n: 2 },
      { hub: HUB_A, state: 'CONFIRMED', n: 5 },
      { hub: HUB_A, state: 'PENDING', n: 4 },
      { hub: HUB_B, state: 'CANCELLED', n: 2 },
      { hub: HUB_B, state: 'CONFIRMED', n: 4 },
      { hub: HUB_B, state: 'PENDING', n: 2 },
    ]);
    expect(
      await routes.rows(
        `select responsible_hub_id as hub, state, count(*)::int as n from pickup_manifest group by 1, 2 order by 1, 2`,
      ),
    ).toEqual([
      { hub: HUB_A, state: 'CANCELLED', n: 1 },
      { hub: HUB_A, state: 'COMPLETED', n: 1 },
      { hub: HUB_A, state: 'DISPATCHED', n: 1 },
      { hub: HUB_A, state: 'DRAFT', n: 1 },
      { hub: HUB_A, state: 'IN_PROGRESS', n: 1 },
      { hub: HUB_B, state: 'CANCELLED', n: 1 },
      { hub: HUB_B, state: 'DISPATCHED', n: 1 },
      { hub: HUB_B, state: 'DRAFT', n: 1 },
      { hub: HUB_B, state: 'IN_PROGRESS', n: 2 },
    ]);
    expect(
      await routes.rows(
        `select responsible_hub_id as hub, count(*)::int as n from notification group by 1 order by 1`,
      ),
    ).toEqual([
      { hub: HUB_A, n: 7 },
      { hub: HUB_B, n: 6 },
    ]);
    // Two messages are in another hub than the request they are about is in now: a message keeps the hub its record answered to when the
    // act was done.
    expect(
      await routes.rows(
        `select n.responsible_hub_id as message_hub, r.responsible_hub_id as record_hub
           from notification n join pickup_request r on r.id = n.subject_id
          where n.responsible_hub_id <> r.responsible_hub_id order by 1`,
      ),
    ).toEqual([
      { message_hub: HUB_A, record_hub: HUB_B },
      { message_hub: HUB_B, record_hub: HUB_A },
    ]);
    expect(
      await routes.rows(
        `select primary_hub_id as hub, count(*)::int as n from staff_identity
          where status = 'PENDING_APPROVAL' group by 1 order by 1`,
      ),
    ).toEqual([
      { hub: HUB_A, n: 2 },
      { hub: HUB_B, n: 1 },
      { hub: null, n: 1 },
    ]);
    // Two requests are held by a stop that no one has released: the ones on a run.
    expect(
      await routes.rows(`select count(*)::int as n from pickup_stop where released_at is null`),
    ).toEqual([{ n: 2 }]);

    // The order of every list is the order written above: the whole, and each hub's part of it.
    const requests = await routes.rows<{ id: string }>(
      `select id from pickup_request order by created_at, id`,
    );
    expect(namesOf(requests)).toEqual(ALL_REQUESTS);
    const runs = await routes.rows<{ id: string }>(
      `select id from pickup_manifest order by created_at, id`,
    );
    expect(namesOf(runs)).toEqual(ALL_RUNS);
    const messages = await routes.rows<{ id: string }>(
      `select id from notification order by created_at desc, id desc`,
    );
    expect(namesOf(messages)).toEqual(ALL_MESSAGES);
    for (const [whole, a, b] of [
      [ALL_REQUESTS, A_REQUESTS, B_REQUESTS],
      [ALL_RUNS, A_RUNS, B_RUNS],
      [ALL_MESSAGES, A_MESSAGES, B_MESSAGES],
    ] as const) {
      expect(whole.filter((name) => name.startsWith('a.'))).toEqual(a);
      expect(whole.filter((name) => name.startsWith('b.'))).toEqual(b);
    }
    // The profiles were made in the order that makes the one with no hub the oldest, and the second hub's older than the first's.
    expect(
      [
        profileMoments.none,
        profileMoments['b.only'],
        profileMoments['a.first'],
        profileMoments['a.second'],
      ].toSorted(),
    ).toEqual([
      profileMoments.none,
      profileMoments['b.only'],
      profileMoments['a.first'],
      profileMoments['a.second'],
    ]);
  });

  // Break caught: a hand figure that is not what the arranged rows say (a miscount of mine, or a row that did not reach its queue), which would
  // make a correct filter fail below. The figures are found again here by plain code over the rows as the administrator reads them, from the
  // definitions of the data dictionary's section 5.5, and not from anything the application answers.
  it('has the figures written out for each queue and hub: what the rows say, found by plain code', async () => {
    const rows = await routes.rows<{
      hub: string;
      state: string;
      cutoff: string | null;
      created_at: Date;
      confirmed_at: Date | null;
      held: boolean;
      asked_at: Date | null;
    }>(
      `select r.responsible_hub_id as hub, r.state, r.cutoff_exception_state as cutoff, r.created_at, r.confirmed_at,
              exists (select 1 from pickup_stop s where s.pickup_request_id = r.id and s.released_at is null) as held,
              (select min(e.requested_at) from one_package_exception e
                where e.pickup_request_id = r.id and e.state = 'REQUESTED') as asked_at
         from pickup_request r`,
    );
    const runs = await routes.rows<{ hub: string; started_at: Date }>(
      `select responsible_hub_id as hub, started_at from pickup_manifest where state = 'IN_PROGRESS'`,
    );
    const iso = (moment: Date | null): string[] => (moment === null ? [] : [moment.toISOString()]);
    const group = (moments: string[][]): Group => ({
      count: moments.length,
      oldest: earliest(moments.flat()),
    });
    for (const [key, hub] of [
      ['a', HUB_A],
      ['b', HUB_B],
    ] as const) {
      const mine = rows.filter((row) => row.hub === hub);
      const waiting = mine.filter((row) => row.state === 'CONFIRMED');
      expect(
        group(mine.filter((row) => row.state === 'PENDING').map((row) => iso(row.created_at))),
      ).toEqual(PICKUP_FIGURES.PICKUP_AWAITING_CONFIRMATION[key]);
      expect(
        group(
          waiting
            .filter((row) => row.cutoff === 'PENDING_OPS_REVIEW')
            .map((row) => iso(row.confirmed_at)),
        ),
      ).toEqual(PICKUP_FIGURES.PICKUP_CUTOFF_REVIEW[key]);
      expect(
        group(
          mine
            .filter((row) => row.state === 'PENDING' && row.asked_at !== null)
            .map((row) => iso(row.asked_at)),
        ),
      ).toEqual(PICKUP_FIGURES.PICKUP_EXCEPTION_APPROVAL[key]);
      expect(
        group(
          waiting
            .filter((row) => row.cutoff !== 'PENDING_OPS_REVIEW' && !row.held)
            .map((row) => iso(row.confirmed_at)),
        ),
      ).toEqual(PICKUP_FIGURES.PICKUP_UNMANIFESTED_POOL[key]);
      expect(
        group(runs.filter((run) => run.hub === hub).map((run) => iso(run.started_at))),
      ).toEqual(PICKUP_FIGURES.PICKUP_RUNS_IN_PROGRESS[key]);
    }

    // The profiles: the oldest of each hub's is the first that was made for it.
    const waitingProfiles = await routes.rows<{ hub: string | null; created_at: Date }>(
      `select primary_hub_id as hub, created_at from staff_identity where status = 'PENDING_APPROVAL'`,
    );
    for (const [hub, written] of [
      [HUB_A, ['a.first', 'a.second']],
      [HUB_B, ['b.only']],
      [null, ['none']],
    ] as const) {
      const ofHub = waitingProfiles.filter((profile) => profile.hub === hub);
      expect(ofHub.length).toBe(written.length);
      expect(earliest(ofHub.map((profile) => profile.created_at.toISOString()))).toBe(
        profileMoments[written[0]],
      );
    }
  });
});

describe('AC-HUBF-01: listPickupRequests narrows to one hub, and only narrows', () => {
  // Break caught: the hub ignored by the list (every hub's request comes back), compared with another column, or the scope widened by it (a
  // session given a hub it does not reach); and, for a Platform Admin, a request in the reads of two hubs or of none (a partition).
  it.each(ROLES)(
    'for %s, a hub names exactly the requests of that hub in the order of the list without it, and the hubs together are the whole list',
    async (_label, role) => {
      const actor = await role.become();
      const whole = await readAll<RequestItem>(actor.client, REQUESTS);
      expect(whole.status).toBe(200);
      expect(namesOf(whole.items)).toEqual(role.reaches.length === 2 ? ALL_REQUESTS : A_REQUESTS);

      const parts: RequestItem[][] = [];
      for (const [hub, written] of [
        [HUB_A, A_REQUESTS],
        [HUB_B, B_REQUESTS],
      ] as const) {
        const read = await readAll<RequestItem>(actor.client, REQUESTS, { hub_id: hub });
        expect(read.status).toBe(200);
        // A list carries no ETag, with a hub or without one.
        expect(read.last.header('etag')).toBeNull();
        // The unfiltered list of the same session, kept to the hub each request carries, in the same order; and the names, written out.
        expect(read.items).toEqual(whole.items.filter((item) => item.responsible_hub_id === hub));
        expect(namesOf(read.items)).toEqual(role.reaches.includes(hub) ? written : []);
        parts.push([...read.items]);
      }
      const together = parts.flat();
      expect(together.map((item) => item.id).toSorted()).toEqual(
        whole.items.map((item) => item.id).toSorted(),
      );
      expect(new Set(together.map((item) => item.id)).size).toBe(together.length);
      if (role.reaches.length === 2) {
        // A filter that keeps everything, or nothing, is not a filter: each hub's part is something and less than the whole.
        for (const part of parts) {
          expect(part.length).toBeGreaterThan(0);
          expect(part.length).toBeLessThan(whole.items.length);
        }
      }
    },
  );

  // Break caught: the hub combined with another filter as "or" (the other hub's requests that match the other filter come back: every
  // combination below matches some in both hubs, and one of them matches none in the second), dropped when another filter is given, or the
  // other filter dropped when the hub is.
  it.each(ROLES)(
    'for %s, hub_id combines as "and" with state, service_date, manifested and the exception filters',
    async (_label, role) => {
      const actor = await role.become();
      for (const combination of REQUEST_COMBINATIONS) {
        const without = await readAll<RequestItem>(actor.client, REQUESTS, combination.filter());
        expect(namesOf(without.items), combination.label).toEqual(
          expectedNames(role, undefined, combination, ALL_REQUESTS),
        );
        for (const hub of [HUB_A, HUB_B]) {
          const read = await readAll<RequestItem>(actor.client, REQUESTS, {
            ...combination.filter(),
            hub_id: hub,
          });
          const label = `${combination.label} in ${hub === HUB_A ? 'the first hub' : 'the second hub'}`;
          expect(read.items, label).toEqual(
            without.items.filter((item) => item.responsible_hub_id === hub),
          );
          expect(namesOf(read.items), label).toEqual(
            expectedNames(role, hub, combination, ALL_REQUESTS),
          );
        }
      }
    },
  );

  // Break caught: the hub lost on the second page (the next page built from the filters without it, so that it is a page of everything), a
  // page that repeats or skips a request at its edge, or a last page that carries a token.
  it('continues a page of a list with hub_id, with the next page token and the same hub_id, to the end of that list, each request once', async () => {
    const admin = await ADMIN_NO_HUB.become();
    for (const [hub, written, sizes] of [
      [HUB_A, A_REQUESTS, [2, 2, 2, 2, 2, 1]],
      [HUB_B, B_REQUESTS, [2, 2, 2, 2]],
    ] as const) {
      const read = await readAll<RequestItem>(admin.client, REQUESTS, { hub_id: hub }, 2);
      expect(read.status).toBe(200);
      expect(read.pages.map((page) => page.items.length)).toEqual(sizes);
      expect(namesOf(read.items)).toEqual(written);
      expect(read.items.every((item) => item.responsible_hub_id === hub)).toBe(true);
      expect(read.pages.slice(0, -1).every((page) => page.next_page_token !== null)).toBe(true);
      expect(read.pages.at(-1)?.next_page_token).toBeNull();
    }
    // ... and inside another filter: the confirmed requests of the second hub, in pages of two.
    const confirmed = await readAll<RequestItem>(
      admin.client,
      REQUESTS,
      { state: 'CONFIRMED', hub_id: HUB_B },
      2,
    );
    expect(confirmed.pages.map((page) => page.items.length)).toEqual([2, 2]);
    expect(namesOf(confirmed.items)).toEqual(['b.late1', 'b.pool1', 'b.late2', 'b.onRun']);
  });

  // Break caught: a hub filter that changes what a session already reaches when it names its own hub (a page that is another page, a token
  // that is another position): the officer and the Senior Ops user are given the very pages they are given without it, tokens included.
  it.each(ONE_HUB_ROLES)(
    'gives %s, naming their own hub, exactly the pages they are given without hub_id',
    async (_label, role) => {
      const actor = await role.become();
      const without = await readAll<RequestItem>(actor.client, REQUESTS, {}, 2);
      const withHub = await readAll<RequestItem>(actor.client, REQUESTS, { hub_id: HUB_A }, 2);

      expect(without.pages.map((page) => page.items.length)).toEqual([2, 2, 2, 2, 2, 1]);
      expect(withHub.pages).toEqual(without.pages);
    },
  );
});

describe('AC-HUBF-02: listPickupManifests narrows to one hub, and only narrows', () => {
  // Break caught: the hub ignored by the list of runs, compared with another column, or the scope widened by it; and, for a Platform Admin, a
  // run in the reads of two hubs or of none.
  it.each(ROLES)(
    'for %s, a hub names exactly the runs of that hub in the order of the list without it, and the hubs together are the whole list',
    async (_label, role) => {
      const actor = await role.become();
      const whole = await readAll<RunItem>(actor.client, RUNS);
      expect(whole.status).toBe(200);
      expect(namesOf(whole.items)).toEqual(role.reaches.length === 2 ? ALL_RUNS : A_RUNS);

      const parts: RunItem[][] = [];
      for (const [hub, written] of [
        [HUB_A, A_RUNS],
        [HUB_B, B_RUNS],
      ] as const) {
        const read = await readAll<RunItem>(actor.client, RUNS, { hub_id: hub });
        expect(read.status).toBe(200);
        expect(read.items).toEqual(whole.items.filter((item) => item.responsible_hub_id === hub));
        expect(namesOf(read.items)).toEqual(role.reaches.includes(hub) ? written : []);
        parts.push([...read.items]);
      }
      const together = parts.flat();
      expect(together.map((item) => item.id).toSorted()).toEqual(
        whole.items.map((item) => item.id).toSorted(),
      );
      expect(new Set(together.map((item) => item.id)).size).toBe(together.length);
      if (role.reaches.length === 2) {
        for (const part of parts) {
          expect(part.length).toBeGreaterThan(0);
          expect(part.length).toBeLessThan(whole.items.length);
        }
      }
    },
  );

  // Break caught: the hub combined with the state or the day as "or", or either dropped when the other is given.
  it.each(ROLES)(
    'for %s, hub_id combines as "and" with state and service_date',
    async (_label, role) => {
      const actor = await role.become();
      for (const combination of RUN_COMBINATIONS) {
        const without = await readAll<RunItem>(actor.client, RUNS, combination.filter());
        expect(namesOf(without.items), combination.label).toEqual(
          expectedNames(role, undefined, combination, ALL_RUNS),
        );
        for (const hub of [HUB_A, HUB_B]) {
          const read = await readAll<RunItem>(actor.client, RUNS, {
            ...combination.filter(),
            hub_id: hub,
          });
          const label = `${combination.label} in ${hub === HUB_A ? 'the first hub' : 'the second hub'}`;
          expect(read.items, label).toEqual(
            without.items.filter((item) => item.responsible_hub_id === hub),
          );
          expect(namesOf(read.items), label).toEqual(
            expectedNames(role, hub, combination, ALL_RUNS),
          );
        }
      }
    },
  );

  // Break caught: the hub lost on the next page of the list of runs, or a page that repeats or skips a run at its edge.
  it('continues a page of a list with hub_id to the end of that list, each run once', async () => {
    const admin = await ADMIN_NO_HUB.become();
    for (const [hub, written, sizes] of [
      [HUB_A, A_RUNS, [2, 2, 1]],
      [HUB_B, B_RUNS, [2, 2, 1]],
    ] as const) {
      const read = await readAll<RunItem>(admin.client, RUNS, { hub_id: hub }, 2);
      expect(read.pages.map((page) => page.items.length)).toEqual(sizes);
      expect(namesOf(read.items)).toEqual(written);
      expect(read.pages.slice(0, -1).every((page) => page.next_page_token !== null)).toBe(true);
      expect(read.pages.at(-1)?.next_page_token).toBeNull();
    }
  });

  // Break caught: a list of runs that, with a hub, grows the stops of each run or an ETag (it is a list: neither is on it without the filter),
  // or a representation that is not the one the list gives without it.
  it('carries neither the stops nor an ETag, and the very representation of the list without the filter', async () => {
    const admin = await ADMIN_NO_HUB.become();
    const whole = await readAll<RunItem>(admin.client, RUNS);
    const read = await readAll<RunItem>(admin.client, RUNS, { hub_id: HUB_B });

    expect(read.last.header('etag')).toBeNull();
    expect(whole.last.header('etag')).toBeNull();
    for (const item of read.items) expect(Object.keys(item)).not.toContain('stops');
    const keysOf = (item: object): string[] => Object.keys(item).toSorted();
    expect(read.items.map(keysOf)).toEqual(
      whole.items.filter((item) => item.responsible_hub_id === HUB_B).map(keysOf),
    );
    // The draft of the second hub holds a stop (it is arranged so), and its entry in the list is there without it.
    expect(read.items.some((item) => item.id === runId('b.draft'))).toBe(true);
  });
});

describe('AC-HUBF-03: listNotifications narrows to one hub, and only narrows', () => {
  // Break caught: the hub ignored by the message log, compared with another column (the subject's hub, the record's), or the scope widened by
  // it; and, for a Platform Admin, a message in the reads of two hubs or of none.
  it.each(ROLES)(
    'for %s, a hub names exactly the messages of that hub, newest first, and the hubs together are the whole log',
    async (_label, role) => {
      const actor = await role.become();
      const whole = await readAll<MessageItem>(actor.client, MESSAGES);
      expect(whole.status).toBe(200);
      expect(namesOf(whole.items)).toEqual(role.reaches.length === 2 ? ALL_MESSAGES : A_MESSAGES);

      const parts: MessageItem[][] = [];
      for (const [hub, written] of [
        [HUB_A, A_MESSAGES],
        [HUB_B, B_MESSAGES],
      ] as const) {
        const read = await readAll<MessageItem>(actor.client, MESSAGES, { hub_id: hub });
        expect(read.status).toBe(200);
        expect(read.last.header('etag')).toBeNull();
        expect(read.items).toEqual(whole.items.filter((item) => item.responsible_hub_id === hub));
        expect(namesOf(read.items)).toEqual(role.reaches.includes(hub) ? written : []);
        parts.push([...read.items]);
      }
      const together = parts.flat();
      expect(together.map((item) => item.id).toSorted()).toEqual(
        whole.items.map((item) => item.id).toSorted(),
      );
      expect(new Set(together.map((item) => item.id)).size).toBe(together.length);
      if (role.reaches.length === 2) {
        for (const part of parts) {
          expect(part.length).toBeGreaterThan(0);
          expect(part.length).toBeLessThan(whole.items.length);
        }
      }
    },
  );

  // Break caught: the hub combined with the state, the audience, the channel or the record as "or", or any of them dropped when the hub is; the
  // last three combinations are the hub of a message that is not the hub its record is in now.
  it.each(ROLES)(
    'for %s, hub_id combines as "and" with state, audience, channel and subject_id',
    async (_label, role) => {
      const actor = await role.become();
      for (const combination of MESSAGE_COMBINATIONS) {
        const without = await readAll<MessageItem>(actor.client, MESSAGES, combination.filter());
        expect(namesOf(without.items), combination.label).toEqual(
          expectedNames(role, undefined, combination, ALL_MESSAGES),
        );
        for (const hub of [HUB_A, HUB_B]) {
          const read = await readAll<MessageItem>(actor.client, MESSAGES, {
            ...combination.filter(),
            hub_id: hub,
          });
          const label = `${combination.label} in ${hub === HUB_A ? 'the first hub' : 'the second hub'}`;
          expect(read.items, label).toEqual(
            without.items.filter((item) => item.responsible_hub_id === hub),
          );
          expect(namesOf(read.items), label).toEqual(
            expectedNames(role, hub, combination, ALL_MESSAGES),
          );
        }
      }
    },
  );

  // Break caught: a message placed in the hub its record is in now (a join to the request, or the subject's hub), so that a message made while
  // the record answered to another hub moves with the record.
  it('puts a message in the hub its record answered to when the act was done, whatever hub the record is in now', async () => {
    const admin = await ADMIN_NO_HUB.become();
    const first = await readAll<MessageItem>(admin.client, MESSAGES, { hub_id: HUB_A });
    const second = await readAll<MessageItem>(admin.client, MESSAGES, { hub_id: HUB_B });
    const aboutSecond = await readAll<MessageItem>(admin.client, MESSAGES, {
      subject_id: requestId('b.moved'),
    });

    expect(namesOf(first.items)).toContain('a.aboutB');
    expect(namesOf(second.items)).not.toContain('a.aboutB');
    expect(namesOf(second.items)).toContain('b.aboutA');
    expect(namesOf(first.items)).not.toContain('b.aboutA');
    // The only message about that request is the first hub's, and the request is the second's: read by its subject, it is in the first hub.
    expect(namesOf(aboutSecond.items)).toEqual(['a.aboutB']);
    expect(aboutSecond.items.map((item) => item.responsible_hub_id)).toEqual([HUB_A]);
  });

  // Break caught: a subject's hub told by the page (the answer for the record of the second hub asked in the first hub differing from the answer
  // for a record that does not exist), which would let a caller learn where a record is.
  it.each(ROLES)(
    'answers a record of the second hub, asked in the first hub, as it answers a record that does not exist: an empty page (%s)',
    async (_label, role) => {
      const actor = await role.become();
      const known = await actor.client.get(
        `${MESSAGES}${queryOf({ subject_id: requestId('b.pending1'), hub_id: HUB_A })}`,
      );
      const unknown = await actor.client.get(
        `${MESSAGES}${queryOf({ subject_id: randomUUID(), hub_id: HUB_A })}`,
      );

      expect(known.status).toBe(200);
      expect(known.json()).toEqual({ items: [], next_page_token: null });
      expect(shapeOf(known)).toEqual(shapeOf(unknown));
    },
  );

  // Break caught: a message log that, with a hub, shows a destination in clear, a text, a code or a field the contract does not name (the filter
  // is a different statement path, and a new column list would not be the closed one).
  it('shows no destination in clear, no text and no code, and the closed fields of an entry, as without the filter', async () => {
    const admin = await ADMIN_NO_HUB.become();
    const read = await readAll<MessageItem>(admin.client, MESSAGES, { hub_id: HUB_B });
    const whole = await readAll<MessageItem>(admin.client, MESSAGES);

    expect(read.items.length).toBeGreaterThan(0);
    const keysOf = (item: object): string[] => Object.keys(item).toSorted();
    expect(read.items.map(keysOf)).toEqual(
      whole.items.filter((item) => item.responsible_hub_id === HUB_B).map(keysOf),
    );
    expect(keysOf(read.items[0] ?? {})).toEqual(
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
    const text = read.pages.map((page) => JSON.stringify(page)).join('');
    expect(text).toContain('+233******111');
    for (const hidden of [
      ARRANGED_DIGEST,
      'destination_digest',
      'provider_message_ref',
      'provider-ref-arranged',
      'lease_',
    ]) {
      expect(text, hidden).not.toContain(hidden);
    }
    expect(text).not.toMatch(/\+233\d{9}/);
  });

  // Break caught: the hub lost on the next page of the message log, or a page that repeats or skips a message at its edge.
  it('continues a page of a list with hub_id to the end of that list, each message once, newest first', async () => {
    const admin = await ADMIN_NO_HUB.become();
    for (const [hub, written, sizes] of [
      [HUB_A, A_MESSAGES, [2, 2, 2, 1]],
      [HUB_B, B_MESSAGES, [2, 2, 2]],
    ] as const) {
      const read = await readAll<MessageItem>(admin.client, MESSAGES, { hub_id: hub }, 2);
      expect(read.pages.map((page) => page.items.length)).toEqual(sizes);
      expect(namesOf(read.items)).toEqual(written);
      expect(read.pages.slice(0, -1).every((page) => page.next_page_token !== null)).toBe(true);
      expect(read.pages.at(-1)?.next_page_token).toBeNull();
    }
  });
});

// ---- The queues, each with the list the screen reads for it: what it returns with a hub is what its count must be.

/** The queues in the order of the contract, each with the key of its own list and, for an approver's queue, the decision key. */
const QUEUES: readonly {
  readonly queue: Queue;
  readonly listKey: string;
  readonly decisionKey?: string;
}[] = [
  { queue: 'PICKUP_AWAITING_CONFIRMATION', listKey: 'pickup.read' },
  { queue: 'PICKUP_CUTOFF_REVIEW', listKey: 'pickup.read' },
  {
    queue: 'PICKUP_EXCEPTION_APPROVAL',
    listKey: 'pickup.read',
    decisionKey: 'pickup.exception.approve',
  },
  { queue: 'PICKUP_UNMANIFESTED_POOL', listKey: 'pickup.read' },
  { queue: 'PICKUP_RUNS_IN_PROGRESS', listKey: 'pickup.read' },
  {
    queue: 'STAFF_AWAITING_APPROVAL',
    listKey: 'staff.read',
    decisionKey: 'staff.identity.approve',
  },
];

/**
 * What the queue's own list returns to the session with the hub (the list's own `hub_id`), read to its last page in pages of two, as the entry
 * that must equal it; or the status of the list when the session may not read it.
 */
async function fromTheList(
  client: TestClient,
  queue: Queue,
  hub: string | undefined,
): Promise<{ readonly status: number; readonly entry: Omit<Entry, 'queue'> }> {
  const entry = (moments: readonly string[], count: number): Omit<Entry, 'queue'> => {
    const oldest = earliest(moments);
    return oldest === undefined || count === 0 ? { count } : { count, oldest_at: oldest };
  };
  switch (queue) {
    case 'PICKUP_AWAITING_CONFIRMATION': {
      const list = await readAll<RequestItem>(
        client,
        REQUESTS,
        { state: 'PENDING', hub_id: hub },
        2,
      );
      return {
        status: list.status,
        entry: entry(
          list.items.map((item) => item.created_at),
          list.items.length,
        ),
      };
    }
    case 'PICKUP_CUTOFF_REVIEW': {
      const list = await readAll<RequestItem>(
        client,
        REQUESTS,
        { state: 'CONFIRMED', cutoff_exception_state: 'PENDING_OPS_REVIEW', hub_id: hub },
        2,
      );
      return {
        status: list.status,
        entry: entry(
          list.items.map((item) => item.confirmed_at ?? ''),
          list.items.length,
        ),
      };
    }
    case 'PICKUP_EXCEPTION_APPROVAL': {
      const list = await readAll<RequestItem>(
        client,
        REQUESTS,
        { one_package_exception_state: 'REQUESTED', hub_id: hub },
        2,
      );
      return {
        status: list.status,
        entry: entry(
          list.items.map((item) => item.one_package_exception?.requested_at ?? ''),
          list.items.length,
        ),
      };
    }
    case 'PICKUP_UNMANIFESTED_POOL': {
      const list = await readAll<RequestItem>(
        client,
        REQUESTS,
        { state: 'CONFIRMED', manifested: 'false', hub_id: hub },
        2,
      );
      return {
        status: list.status,
        entry: entry(
          list.items.map((item) => item.confirmed_at ?? ''),
          list.items.length,
        ),
      };
    }
    case 'PICKUP_RUNS_IN_PROGRESS': {
      const list = await readAll<RunItem>(client, RUNS, { state: 'IN_PROGRESS', hub_id: hub }, 2);
      return {
        status: list.status,
        entry: entry(
          list.items.map((item) => item.started_at ?? ''),
          list.items.length,
        ),
      };
    }
    case 'STAFF_AWAITING_APPROVAL': {
      const list = await readAll<StaffItem>(
        client,
        STAFF,
        { status: 'PENDING_APPROVAL', hub_id: hub },
        2,
      );
      // A staff representation carries no creation moment: it is read, for the profiles the list returned, from the table.
      const ids = list.items.map((item) => item.id);
      const moments =
        ids.length === 0
          ? []
          : (
              await routes.rows<{ created_at: Date }>(
                `select created_at from staff_identity where id = any($1::uuid[])`,
                [ids],
              )
            ).map((row) => row.created_at.toISOString());
      return { status: list.status, entry: entry(moments, list.items.length) };
    }
  }
}

/** The keys the actor's session holds, as the session says them. */
async function keysHeldBy(actor: Actor): Promise<ReadonlySet<string>> {
  const response = await actor.client.get(`${API}/auth/session`);
  expect(response.status).toBe(200);
  return new Set((response.json() as { permissions: string[] }).permissions);
}

/**
 * The summary the lists predict for the actor with the hub: an entry for each queue whose list key and decision key the session holds, built from
 * what its list returned with the same hub; and, for a queue it may not read, the list must refuse the session (so that "no entry" is the list's
 * refusal and not a count that was lost).
 */
async function predictedFor(actor: Actor, hub: string | undefined): Promise<Entry[]> {
  const held = await keysHeldBy(actor);
  const entries: Entry[] = [];
  for (const definition of QUEUES) {
    const read = await fromTheList(actor.client, definition.queue, hub);
    if (!held.has(definition.listKey)) {
      expect(read.status, `${definition.queue}: the list refuses a session without its key`).toBe(
        403,
      );
      continue;
    }
    expect(read.status, `${definition.queue}: the list is read`).toBe(200);
    if (definition.decisionKey !== undefined && !held.has(definition.decisionKey)) continue;
    entries.push({ queue: definition.queue, ...read.entry });
  }
  return entries;
}

/** The hubs a session is asked about: none, the first, the second, one that exists and holds none of the records, and none that exists. */
const HUBS_ASKED: readonly (string | undefined)[] = [undefined, HUB_A, HUB_B, HUB_C, NO_HUB];
const describeHub = (hub: string | undefined): string =>
  hub === undefined
    ? 'no hub'
    : hub === HUB_A
      ? 'the first hub'
      : hub === HUB_B
        ? 'the second hub'
        : hub === HUB_C
          ? 'a hub with none of the records'
          : 'a hub that does not exist';

describe('AC-HUBF-04: getQueueSummary counts one hub’s work, entry by entry as it counts all of it', () => {
  // Break caught: the hub not reaching a counter (the count of every hub's records), a moment taken from another hub's records, an entry absent
  // because of the hub, or present for a queue the session may not read; each session is asked for the first hub, the second, a hub with none of
  // the records, one that does not exist, and none.
  it.each(ROLES)(
    'for %s, every entry is the number of that hub’s records in its queue with the moment of the oldest, and the entries are those it is given with no hub',
    async (_label, role) => {
      const actor = await role.become();
      const withNone = await summaryOf(actor.client);
      expect(withNone.status).toBe(200);
      for (const hub of HUBS_ASKED) {
        const answer = await summaryOf(actor.client, hub);
        const label = describeHub(hub);
        expect(answer.status, label).toBe(200);
        // The entries present are exactly the entries it is given with none, in the same order (none absent because of the hub).
        expect(
          answer.queues.map((entry) => entry.queue),
          label,
        ).toEqual(withNone.queues.map((entry) => entry.queue));
        expect(answer.queues, label).toEqual(expectedSummary(role, hub));
      }
    },
  );

  // Break caught: a count and a list that are wrong in the same way (a hub condition lost from the one function both call): the figures are
  // written out for the arranged data, in the open, so that each can be read against it by eye (the staff queue is the one that does not add up).
  it('has the figures of the arranged data for a Platform Admin with no hub: the first hub’s, the second hub’s and all of them', async () => {
    const admin = await ADMIN_NO_HUB.become();

    expect((await summaryOf(admin.client, HUB_A)).queues).toEqual([
      { queue: 'PICKUP_AWAITING_CONFIRMATION', count: 4, oldest_at: '2026-10-19T08:02:00.000Z' },
      { queue: 'PICKUP_CUTOFF_REVIEW', count: 1, oldest_at: '2026-10-30T08:00:00.000Z' },
      { queue: 'PICKUP_EXCEPTION_APPROVAL', count: 2, oldest_at: '2026-10-30T09:00:00.000Z' },
      { queue: 'PICKUP_UNMANIFESTED_POOL', count: 3, oldest_at: '2026-10-31T08:00:00.000Z' },
      { queue: 'PICKUP_RUNS_IN_PROGRESS', count: 1, oldest_at: '2026-11-03T07:00:00.000Z' },
      { queue: 'STAFF_AWAITING_APPROVAL', count: 2, oldest_at: profileMoments['a.first'] },
    ]);
    expect((await summaryOf(admin.client, HUB_B)).queues).toEqual([
      { queue: 'PICKUP_AWAITING_CONFIRMATION', count: 2, oldest_at: '2026-10-19T08:01:00.000Z' },
      { queue: 'PICKUP_CUTOFF_REVIEW', count: 2, oldest_at: '2026-10-29T08:00:00.000Z' },
      { queue: 'PICKUP_EXCEPTION_APPROVAL', count: 1, oldest_at: '2026-11-01T10:00:00.000Z' },
      { queue: 'PICKUP_UNMANIFESTED_POOL', count: 1, oldest_at: '2026-11-02T10:00:00.000Z' },
      { queue: 'PICKUP_RUNS_IN_PROGRESS', count: 2, oldest_at: '2026-11-02T07:00:00.000Z' },
      { queue: 'STAFF_AWAITING_APPROVAL', count: 1, oldest_at: profileMoments['b.only'] },
    ]);
    // All of it: the oldest pending and the oldest late booking and run are the second hub's, the oldest exception and pool entry the first's,
    // and the oldest profile is the one with no hub, which no hub's count has.
    expect((await summaryOf(admin.client)).queues).toEqual([
      { queue: 'PICKUP_AWAITING_CONFIRMATION', count: 6, oldest_at: '2026-10-19T08:01:00.000Z' },
      { queue: 'PICKUP_CUTOFF_REVIEW', count: 3, oldest_at: '2026-10-29T08:00:00.000Z' },
      { queue: 'PICKUP_EXCEPTION_APPROVAL', count: 3, oldest_at: '2026-10-30T09:00:00.000Z' },
      { queue: 'PICKUP_UNMANIFESTED_POOL', count: 4, oldest_at: '2026-10-31T08:00:00.000Z' },
      { queue: 'PICKUP_RUNS_IN_PROGRESS', count: 3, oldest_at: '2026-11-02T07:00:00.000Z' },
      { queue: 'STAFF_AWAITING_APPROVAL', count: 4, oldest_at: profileMoments.none },
    ]);
  });

  // Break caught: the first hub's officer given another hub's work, or the hub the officer names not narrowing its own: its own hub is the whole of
  // its summary, and the second hub is five entries at 0 (the officer holds no staff key: no sixth entry).
  it('has, for an Ops Staff officer of the first hub, its own figures for its hub and for none, and 0 in each of its five entries for the second', async () => {
    const officer = await OFFICER.become();
    const own = [
      { queue: 'PICKUP_AWAITING_CONFIRMATION', count: 4, oldest_at: '2026-10-19T08:02:00.000Z' },
      { queue: 'PICKUP_CUTOFF_REVIEW', count: 1, oldest_at: '2026-10-30T08:00:00.000Z' },
      { queue: 'PICKUP_EXCEPTION_APPROVAL', count: 2, oldest_at: '2026-10-30T09:00:00.000Z' },
      { queue: 'PICKUP_UNMANIFESTED_POOL', count: 3, oldest_at: '2026-10-31T08:00:00.000Z' },
      { queue: 'PICKUP_RUNS_IN_PROGRESS', count: 1, oldest_at: '2026-11-03T07:00:00.000Z' },
    ];

    expect((await summaryOf(officer.client)).queues).toEqual(own);
    expect((await summaryOf(officer.client, HUB_A)).queues).toEqual(own);
    expect((await summaryOf(officer.client, HUB_B)).queues).toEqual(
      own.map((entry) => ({ queue: entry.queue, count: 0 })),
    );
  });

  // Break caught: the counts of the hubs not adding up to the count of all of them (a record counted in no hub, or in two); and the staff queue,
  // which the contract says does not add up (a profile with no primary hub is in the count with no hub and in no hub's), made to add up.
  it.each(BOTH_HUBS_ROLES)(
    'for %s, the pickup queues of the two hubs add up to the count of all hubs, and the staff queue does not: the profile with no hub is in no hub’s count',
    async (_label, role) => {
      const actor = await role.become();
      const all = await summaryOf(actor.client);
      const first = await summaryOf(actor.client, HUB_A);
      const second = await summaryOf(actor.client, HUB_B);

      for (const queue of PICKUP_QUEUES) {
        expect(countIn(first.queues, queue) + countIn(second.queues, queue), queue).toBe(
          countIn(all.queues, queue),
        );
        // The oldest of all of them is the earliest of the hubs' oldest.
        expect(entryIn(all.queues, queue).oldest_at, queue).toBe(
          earliest(
            [first.queues, second.queues].flatMap((queues) => {
              const moment = entryIn(queues, queue).oldest_at;
              return moment === undefined ? [] : [moment];
            }),
          ),
        );
      }
      const staff = 'STAFF_AWAITING_APPROVAL';
      expect(countIn(first.queues, staff)).toBe(2);
      expect(countIn(second.queues, staff)).toBe(1);
      expect(countIn(all.queues, staff)).toBe(4);
      expect(countIn(all.queues, staff)).toBe(
        countIn(first.queues, staff) + countIn(second.queues, staff) + 1,
      );
      // The profile that no hub's count has is the oldest of all (it was made first): the all-hub count says so, and each hub's is its own
      // first profile's.
      expect(entryIn(all.queues, staff).oldest_at).toBe(profileMoments.none);
      expect(entryIn(first.queues, staff).oldest_at).toBe(profileMoments['a.first']);
      expect(entryIn(second.queues, staff).oldest_at).toBe(profileMoments['b.only']);
    },
  );

  // Break caught: a moment on an empty queue, an entry that names the hub or holds anything beyond the queue, the count and the moment, and an
  // answer that is stored by a browser or a proxy, or carries a version, as the summary without the filter does not.
  it.each(ROLES)(
    'for %s, an entry holds the queue, the count and, when the count is not 0, the moment of the oldest, and nothing else: the answer names no hub',
    async (_label, role) => {
      const actor = await role.become();
      for (const hub of [undefined, HUB_A, HUB_B, HUB_C]) {
        const answer = await summaryOf(actor.client, hub);
        const label = describeHub(hub);
        for (const entry of answer.queues) {
          expect(Object.keys(entry), `${label}: ${entry.queue}`).toEqual(
            entry.count === 0 ? ['queue', 'count'] : ['queue', 'count', 'oldest_at'],
          );
        }
        expect(Object.keys(answer.response.json() as object), label).toEqual(['queues']);
        expect(answer.response.header('cache-control'), label).toBe('no-store');
        expect(answer.response.header('etag'), label).toBeNull();
        for (const aHub of [HUB_A, HUB_B, HUB_C]) {
          expect(answer.response.text, label).not.toContain(aHub);
        }
      }
    },
  );

  // Break caught: an entry absent because a hub is asked for (a queue with nothing in that hub drawn as "not yours"), an entry present for a
  // queue the session may not read, or an approver's queue shown to a session that does not hold its decision key, for some hub.
  it.each([
    [
      'an Ops Staff officer, who holds no staff key',
      () => OFFICER.become(),
      [
        'PICKUP_AWAITING_CONFIRMATION',
        'PICKUP_CUTOFF_REVIEW',
        'PICKUP_EXCEPTION_APPROVAL',
        'PICKUP_UNMANIFESTED_POOL',
        'PICKUP_RUNS_IN_PROGRESS',
      ],
    ],
    [
      'a bundle that reads the pickups and the staff and holds neither decision key',
      async () =>
        routes.actor(
          await newBundle(routes.admin, [grant('pickup.read', 'own'), grant('staff.read', 'own')]),
          HUB_A,
        ),
      [
        'PICKUP_AWAITING_CONFIRMATION',
        'PICKUP_CUTOFF_REVIEW',
        'PICKUP_UNMANIFESTED_POOL',
        'PICKUP_RUNS_IN_PROGRESS',
      ],
    ],
    [
      'a bundle that holds the decision keys and no list key',
      async () =>
        routes.actor(
          await newBundle(routes.admin, [
            grant('pickup.exception.approve', 'own'),
            grant('staff.identity.approve', 'own'),
          ]),
          HUB_A,
        ),
      [],
    ],
    [
      'a bundle that reads none of the queues',
      async () =>
        routes.actor(await newBundle(routes.admin, [grant('dispatch.read', 'own')]), HUB_A),
      [],
    ],
  ] as const)(
    'gives %s the entries it is given with no hub, for every hub',
    async (_label, become, present) => {
      const actor = await become();
      for (const hub of HUBS_ASKED) {
        const answer = await summaryOf(actor.client, hub);
        expect(answer.status, describeHub(hub)).toBe(200);
        expect(
          answer.queues.map((entry) => entry.queue),
          describeHub(hub),
        ).toEqual(present);
        // An entry that is there says "read, and nothing waits" when the hub has no work in it: a 0, and never a missing entry.
        if (hub !== undefined && hub !== HUB_A) {
          expect(answer.queues.every((entry) => entry.count === 0)).toBe(true);
        }
      }
    },
  );
});

describe('AC-HUBF-05, GBT-GS14: a hub outside the grant, and a hub that does not exist, are an empty page and a count of 0, and nothing else', () => {
  const READS = [
    ['listPickupRequests', REQUESTS],
    ['listPickupManifests', RUNS],
    ['listNotifications', MESSAGES],
  ] as const;
  const EMPTY_PAGE = { items: [], next_page_token: null };

  // Break caught (AC-HUBF-05, GBT-GS14): a hub that widens what the session may read (a read run in the context of the hub named, or in every
  // hub), a refusal of a hub outside the grant (HUB_SCOPE_VIOLATION, which would let a caller learn which hubs exist), a hub that is looked up
  // (an answer for one that does not exist that is not the answer for one that does), or an audit event for a page that returned nothing.
  it.each(ONE_HUB_ROLES)(
    'for %s, a second hub outside the grant and the identifier of no hub are each an empty page and a count of 0, and the two are one answer',
    async (_label, role) => {
      const actor = await role.become();
      const events = await auditEvents();

      for (const [operation, path] of READS) {
        const outside = await actor.client.get(`${path}${queryOf({ hub_id: HUB_B })}`);
        const nowhere = await actor.client.get(`${path}${queryOf({ hub_id: NO_HUB })}`);
        for (const answer of [outside, nowhere]) {
          expect([answer.status, answer.json()], operation).toEqual([200, EMPTY_PAGE]);
        }
        expect(shapeOf(outside), operation).toEqual(shapeOf(nowhere));
        // The page is empty because of the filter and not because the session reads nothing: its own hub is not empty.
        const own = await readAll<MessageItem>(actor.client, path, { hub_id: HUB_A });
        expect(own.items.length, operation).toBeGreaterThan(0);
      }

      const outside = await summaryOf(actor.client, HUB_B);
      const nowhere = await summaryOf(actor.client, NO_HUB);
      const own = await summaryOf(actor.client, HUB_A);
      for (const answer of [outside, nowhere]) {
        expect(answer.status).toBe(200);
        // Every entry the session may read is there, at 0 and with no moment: never absent, never an error.
        expect(answer.queues).toEqual(expectedSummary(role, HUB_B));
        expect(answer.queues.length).toBe(expectedSummary(role, undefined).length);
        for (const entry of answer.queues) expect(Object.keys(entry)).toEqual(['queue', 'count']);
        expect(answer.queues.every((entry) => entry.count === 0)).toBe(true);
      }
      expect(shapeOf(outside.response)).toEqual(shapeOf(nowhere.response));
      expect(own.queues.some((entry) => entry.count > 0)).toBe(true);

      // Nothing was written for any of it: no event for a page that returned nothing, none for the summary.
      expect(await auditEvents()).toBe(events);
    },
  );

  // Break caught (AC-HUBF-05, GBT-GS14): a Platform Admin, whose grant reaches every hub, refused or told something for a hub that holds nothing
  // or that does not exist; the identifier of no hub answered another way than a hub that exists with none of the records (an oracle on which
  // hubs exist).
  it.each(BOTH_HUBS_ROLES)(
    'for %s, the identifier of no hub and a hub with none of the records are each an empty page and a count of 0, and the two are one answer',
    async (_label, role) => {
      const actor = await role.become();
      const events = await auditEvents();

      for (const [operation, path] of READS) {
        const missing = await actor.client.get(`${path}${queryOf({ hub_id: NO_HUB })}`);
        const empty = await actor.client.get(`${path}${queryOf({ hub_id: HUB_C })}`);
        for (const answer of [missing, empty]) {
          expect([answer.status, answer.json()], operation).toEqual([200, EMPTY_PAGE]);
        }
        expect(shapeOf(missing), operation).toEqual(shapeOf(empty));
      }

      const missing = await summaryOf(actor.client, NO_HUB);
      const empty = await summaryOf(actor.client, HUB_C);
      for (const answer of [missing, empty]) {
        expect(answer.status).toBe(200);
        expect(answer.queues).toEqual(expectedSummary(role, NO_HUB));
        expect(answer.queues.map((entry) => entry.queue)).toEqual(QUEUES.map((each) => each.queue));
        expect(answer.queues.every((entry) => entry.count === 0)).toBe(true);
      }
      expect(shapeOf(missing.response)).toEqual(shapeOf(empty.response));
      expect(await auditEvents()).toBe(events);
    },
  );

  // Break caught (AC-HUBF-05, GBT-GS14): the read of one record changed by the new filter's convention (a record of another hub read by its
  // identifier answered as an empty or an absent record, or an identifier that matches nothing answered as another hub's): the scope probe of the
  // read by identifier is not the list's, and a list never probes.
  it('leaves the read of one record by its identifier as it was: HUB_SCOPE_VIOLATION for another hub’s record and NOT_FOUND for one that matches nothing', async () => {
    const officer = await OFFICER.become();

    const foreign = await officer.client.get(`${REQUESTS}/${requestId('b.pending1')}`);
    expect([foreign.status, codeOf(foreign)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    const missing = await officer.client.get(`${REQUESTS}/${randomUUID()}`);
    expect([missing.status, codeOf(missing)]).toEqual([404, 'NOT_FOUND']);
    const foreignRun = await officer.client.get(`${RUNS}/${runId('b.draft')}`);
    expect([foreignRun.status, codeOf(foreignRun)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    const missingRun = await officer.client.get(`${RUNS}/${randomUUID()}`);
    expect([missingRun.status, codeOf(missingRun)]).toEqual([404, 'NOT_FOUND']);
    // The same session, asking the same hub through the list, is told nothing.
    const listed = await officer.client.get(`${REQUESTS}${queryOf({ hub_id: HUB_B })}`);
    expect([listed.status, listed.json()]).toEqual([200, EMPTY_PAGE]);
    // ... and a Platform Admin, whose grant reaches the hub, reads the record.
    const admin = await ADMIN_NO_HUB.become();
    expect((await admin.client.get(`${REQUESTS}/${requestId('b.pending1')}`)).status).toBe(200);
  });
});

describe('AC-HUBF-06: a count with a hub is what the list with that hub returns, for every queue, role and hub', () => {
  // Break caught: a counter that ignores the filter it is given (the runs in progress and the staff queue are separate statements), a hub given
  // to one key's group of counters and not the other's, or a count whose predicate has drifted from its list's. Every count is compared with the
  // list of its own queue, read to its last page in pages of two with the same hub, and then with the figures written out for the arranged data,
  // so that a count and a list that are wrong in the same way (a hub condition lost from the one function both call) still fail.
  it.each([...ROLES, ...BUNDLE_ROLES])(
    'for %s, every count with a hub is the number of items of its queue’s list with that hub, and the oldest is the earliest of them',
    async (_label, role) => {
      const actor = await role.become();
      for (const hub of HUBS_ASKED) {
        const label = describeHub(hub);
        const fromLists = await predictedFor(actor, hub);
        const answer = await summaryOf(actor.client, hub);

        expect(answer.status, label).toBe(200);
        expect(answer.queues, `${label}: the lists`).toEqual(fromLists);
        expect(answer.queues, `${label}: the figures`).toEqual(expectedSummary(role, hub));
      }
    },
  );

  // Break caught: the comparison above passing because both sides are empty, or the arranged data never reaching the queue of a hub.
  it('is not a comparison of empty things: every queue of both hubs has records in its list', async () => {
    const admin = await ADMIN_NO_HUB.become();
    for (const hub of [HUB_A, HUB_B]) {
      for (const { queue } of QUEUES) {
        const read = await fromTheList(admin.client, queue, hub);
        expect(read.status).toBe(200);
        expect(read.entry.count, `${queue} in ${describeHub(hub)}`).toBeGreaterThan(0);
      }
    }
  });
});

const outcomeOf = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];

const violationsOf = (
  response: TestResponse,
): { readonly in?: string; readonly pointer?: string; readonly rule?: string }[] =>
  (
    response.json() as {
      details?: { violations?: { in?: string; pointer?: string; rule?: string }[] };
    }
  ).details?.violations ?? [];

/** The four reads, each by the name of its operation. */
const FOUR_READS = [
  ['listPickupRequests', REQUESTS],
  ['listPickupManifests', RUNS],
  ['listNotifications', MESSAGES],
  ['getQueueSummary', SUMMARY],
] as const;

describe('AC-HUBF-07: an identifier that is not an identifier is VALIDATION_FAILED naming hub_id, after the guards', () => {
  /** A word, an empty value, a UUID with spaces around it, a UUID written as a URN, and a hub given twice; and the rule each breaks. */
  const NOT_IDENTIFIERS = [
    ['a word', 'hub_id=not-a-uuid', 'format'],
    ['an empty value', 'hub_id=', 'format'],
    ['a UUID with spaces around it', `hub_id=%20${HUB_A}%20`, 'format'],
    ['a UUID written as a URN', `hub_id=urn:uuid:${HUB_A}`, 'format'],
    ['a hub given twice', `hub_id=${HUB_A}&hub_id=${HUB_B}`, 'type'],
  ] as const;

  // Break caught: a value that is not an identifier read as one (compared as text, trimmed, the first of two), answered with an empty page or a
  // count of 0 that hides the mistake, or refused as another failure than VALIDATION_FAILED, or without naming hub_id. The refusal is the
  // contract's own, so it names the parameter by its bare name and the rule of the contract it breaks (the form of the other filters, pinned for
  // `state` and `service_date` in pickup-manifest-routes.db.test.ts): a read whose contract does not declare `hub_id` as a UUID (a parameter
  // missing from an operation, or without its format) is refused later and by the service, as `/hub_id`, and fails here.
  it.each(ROLES)(
    'for %s, a value that is not an identifier is VALIDATION_FAILED naming hub_id, on each of the four reads',
    async (_label, role) => {
      const actor = await role.become();
      for (const [operation, path] of FOUR_READS) {
        for (const [what, raw, rule] of NOT_IDENTIFIERS) {
          const answer = await actor.client.get(`${path}?${raw}`);
          const label = `${operation}: ${what}`;
          expect(outcomeOf(answer), label).toEqual([400, 'VALIDATION_FAILED']);
          expect(violationsOf(answer), label).toEqual([{ in: 'query', pointer: 'hub_id', rule }]);
        }
      }
    },
  );

  // Break caught: a bad value answered with a page, a count or an audit event instead of a refusal (a Platform Admin's page would cross hubs and so
  // write events, as the control, the same read with a hub that is one, does). At HTTP the contract validator refuses first, so this cannot see a
  // service that judges the value late (the unit tests of the refusals do): it fails only if the value gets past the contract (one that does not
  // declare hub_id or its format) and then past the service or the controller as well.
  it('reads nothing for a value that is not an identifier: no page and no audit event', async () => {
    const admin = await ADMIN_NO_HUB.become();
    const before = await auditEvents();

    for (const [operation, path] of FOUR_READS) {
      for (const [what, raw] of NOT_IDENTIFIERS) {
        const answer = await admin.client.get(`${path}?${raw}`);
        const body = Object.keys(answer.json() as object);
        expect(answer.status, `${operation}: ${what}`).toBe(400);
        expect(body, `${operation}: ${what}`).not.toContain('items');
        expect(body, `${operation}: ${what}`).not.toContain('queues');
      }
    }
    expect(await auditEvents()).toBe(before);

    expect((await admin.client.get(`${REQUESTS}?hub_id=${HUB_A}`)).status).toBe(200);
    expect(await auditEvents()).toBeGreaterThan(before);
  });

  // Break caught: the value judged before the guards (a caller who may not use a read told the shape of its parameter, or a refusal replaced by
  // VALIDATION_FAILED): a session without the key, a request with no session, a Vendor on a staff read and a Rider's bearer on the same are each
  // answered as they are with no value at all. The summary has no key of its own (any staff session may ask it), so Finance is told its value is wrong.
  it('answers by the guards, before the value is judged: a session without the key, a request with no session, a Vendor and a Rider’s bearer', async () => {
    const finance = await routes.actor(BUNDLE_IDS.finance, HUB_A);
    const anonymous = routes.browser();
    const refused = [403, 'PERMISSION_DENIED'];
    const noSession = [401, 'SESSION_INVALID'];
    const invalid = [400, 'VALIDATION_FAILED'];
    // A Rider is served the list of requests and is shown none of them (hub-filters.md section 3): an empty page, so that a bad value is judged.
    const riderRequests = await riderOne.client.get(REQUESTS);
    expect([riderRequests.status, riderRequests.json()]).toEqual([
      200,
      { items: [], next_page_token: null },
    ]);

    const expectations: readonly [string, TestClient, Record<string, unknown>][] = [
      [
        'a session whose bundle holds none of the keys of the lists',
        finance.client,
        {
          listPickupRequests: refused,
          listPickupManifests: refused,
          listNotifications: refused,
          getQueueSummary: invalid,
        },
      ],
      [
        'a request with no session',
        anonymous,
        {
          listPickupRequests: noSession,
          listPickupManifests: noSession,
          listNotifications: noSession,
          getQueueSummary: noSession,
        },
      ],
      [
        'a Vendor session',
        browserOne,
        {
          listPickupRequests: invalid,
          listPickupManifests: refused,
          listNotifications: refused,
          getQueueSummary: refused,
        },
      ],
      [
        'a Rider’s bearer credential',
        riderOne.client,
        {
          listPickupRequests: invalid,
          listPickupManifests: invalid,
          listNotifications: noSession,
          getQueueSummary: noSession,
        },
      ],
    ];
    for (const [who, client, outcomes] of expectations) {
      for (const [operation, path] of FOUR_READS) {
        for (const raw of ['hub_id=not-a-uuid', `hub_id=${HUB_A}&hub_id=${HUB_B}`]) {
          const answer = await client.get(`${path}?${raw}`);
          expect(outcomeOf(answer), `${who}: ${operation}: ${raw}`).toEqual(outcomes[operation]);
        }
        // A refusal is the answer with no value at all: the value was never looked at.
        if (outcomes[operation] !== invalid) {
          expect(outcomeOf(await client.get(path)), `${who}: ${operation} without a value`).toEqual(
            outcomes[operation],
          );
        }
      }
    }
    // The summary is not refused to Finance: its read of it with a hub that is one is an answer, with no queue in it.
    const allowed = await summaryOf(finance.client, HUB_A);
    expect([allowed.status, allowed.queues]).toEqual([200, []]);
  });

  // Break caught: the hub compared as text (an identifier in capitals taken for another hub: an empty page for it), or refused by a pattern that
  // knows only lower case. Each answer is compared with the lower-case one, which is not empty for a hub the session reaches.
  it.each(ROLES)(
    'for %s, reads an identifier in capitals as the same hub as in lower case, on each of the four reads',
    async (_label, role) => {
      const actor = await role.become();
      for (const hub of [HUB_A, HUB_B]) {
        const capitals = hub.toUpperCase();
        expect(capitals).not.toBe(hub);
        const reached = role.reaches.includes(hub);
        for (const [operation, path] of [
          ['listPickupRequests', REQUESTS],
          ['listPickupManifests', RUNS],
          ['listNotifications', MESSAGES],
        ] as const) {
          const lower = await readAll<MessageItem>(actor.client, path, { hub_id: hub });
          const upper = await readAll<MessageItem>(actor.client, path, { hub_id: capitals });
          expect(upper.status, operation).toBe(200);
          expect(lower.items.length > 0, `${operation}: the lower-case read`).toBe(reached);
          expect(upper.items, operation).toEqual(lower.items);
        }
        const lower = await summaryOf(actor.client, hub);
        const upper = await summaryOf(actor.client, capitals);
        expect(upper.status).toBe(200);
        expect(
          lower.queues.some((entry) => entry.count > 0),
          'the lower-case summary',
        ).toBe(reached);
        expect(upper.queues).toEqual(lower.queues);
      }
    },
  );
});

describe('AC-HUBF-08: the audit of a read does not change with the filter', () => {
  const LISTS = [
    ['listPickupRequests', REQUESTS],
    ['listPickupManifests', RUNS],
    ['listNotifications', MESSAGES],
  ] as const;

  /**
   * What a page writes, by the hub asked for: one crossing for each hub other than the session's own that the rows of the page represent
   * (the hubs, written out by hand; each hub has rows in each of the three lists). The Platform Admin with no primary hub has none of its own,
   * so every hub is foreign; the one whose primary hub is the first crosses the second only; an officer and a Senior Ops user cross nothing.
   * A page with no row writes none, whatever hub was named.
   */
  const WRITES: readonly [
    string,
    Role,
    readonly (readonly [string | undefined, readonly string[]])[],
  ][] = [
    [
      'a Platform Admin with no primary hub',
      ADMIN_NO_HUB,
      [
        [HUB_A, [HUB_A]],
        [HUB_B, [HUB_B]],
        [HUB_C, []],
        [NO_HUB, []],
        [undefined, [HUB_A, HUB_B]],
      ],
    ],
    [
      'a Platform Admin whose primary hub is the first',
      ADMIN_WITH_HUB,
      [
        [HUB_A, []],
        [HUB_B, [HUB_B]],
        [HUB_C, []],
        [NO_HUB, []],
        [undefined, [HUB_B]],
      ],
    ],
    [
      'an Ops Staff officer of the first hub',
      OFFICER,
      [
        [HUB_A, []],
        [HUB_B, []],
        [HUB_C, []],
        [NO_HUB, []],
        [undefined, []],
      ],
    ],
    [
      'a Senior Ops user of the first hub',
      SENIOR,
      [
        [HUB_A, []],
        [HUB_B, []],
        [HUB_C, []],
        [NO_HUB, []],
        [undefined, []],
      ],
    ],
  ];

  // Break caught: an event written for the hub asked for and not for the hubs the rows of the page represent, one for an empty page (a filter that
  // matched nothing made an attempt on a hub), none for a filtered page that crosses, one for the actor's own hub, one that carries a row, or the
  // wrong operation named.
  it.each(WRITES)(
    'for %s, a page writes one crossing for each other hub its rows represent, naming the hub and the operation and no row, and none for an empty page',
    async (_label, role, cases) => {
      const actor = await role.become();
      for (const [operation, path] of LISTS) {
        for (const [hub, expectedHubs] of cases) {
          const before = (await crossingsOf(actor)).length;
          const answer = await actor.client.get(
            `${path}${queryOf({ hub_id: hub, page_size: '100' })}`,
          );
          const label = `${operation} with ${describeHub(hub)}`;
          expect(answer.status, label).toBe(200);

          const written = (await crossingsOf(actor)).slice(before);
          expect(written.map((event) => event.object_id).toSorted(), label).toEqual(
            expectedHubs.toSorted(),
          );
          for (const event of written) {
            expect(event.object_type, label).toBe('HUB');
            expect(event.responsible_hub_id, label).toBe(event.object_id);
            expect(event.related_ids, label).toEqual({ operation_id: operation });
            // No row: nothing of any arranged record is in the event.
            const text = JSON.stringify(event);
            expect(
              [...named.keys()].filter((id) => text.includes(id)),
              label,
            ).toEqual([]);
          }
        }
      }
    },
  );

  // Break caught: the summary writing an audit event when a hub is given (or when it is not): it returns no record, so it crosses no hub. The
  // control, for a session that does cross, is a page of the second hub, which writes one.
  it.each(ROLES)(
    'for %s, the summary writes no audit event, with a hub or with none',
    async (_label, role) => {
      const actor = await role.become();
      for (const hub of HUBS_ASKED) {
        const before = await auditEvents();
        expect((await summaryOf(actor.client, hub)).status).toBe(200);
        expect(await auditEvents(), describeHub(hub)).toBe(before);
      }
      if (role.reaches.length === 2) {
        const before = await auditEvents();
        expect((await actor.client.get(`${REQUESTS}?hub_id=${HUB_B}`)).status).toBe(200);
        expect(await auditEvents()).toBeGreaterThan(before);
      }
    },
  );
});

describe('AC-HUBF-10, GBT-GS14: the filter is narrowed by the grant of the read’s own key and never widened by another grant', () => {
  const PENDING = 'PICKUP_AWAITING_CONFIRMATION';
  const CUTOFF = 'PICKUP_CUTOFF_REVIEW';
  const ASKED = 'PICKUP_EXCEPTION_APPROVAL';
  const POOL = 'PICKUP_UNMANIFESTED_POOL';
  const RUNNING = 'PICKUP_RUNS_IN_PROGRESS';
  const PROFILES = 'STAFF_AWAITING_APPROVAL';
  const countsOf = (queues: readonly Entry[]): [string, number][] =>
    queues.map((entry) => [entry.queue, entry.count]);

  // Break caught (AC-HUBF-10, GBT-GS14): a count taken in the widest grant the session holds (the exception queue counted in the second hub
  // because its decision key reaches every hub, or the pickup queues in the grant of another key), or the hub put into the context of the read
  // (a hub the session does not reach counted for it). The staff queue, whose own key reaches every hub, is the second hub's count. Asked in both
  // directions: a bundle whose pickup keys reach its hub and whose staff key reaches every hub, at the first hub and at the second.
  it.each([
    ['the first hub', MIXED_AT_FIRST, HUB_A, HUB_B],
    ['the second hub', MIXED_AT_SECOND, HUB_B, HUB_A],
  ] as const)(
    'counts, for a bundle that reads the pickups at its hub and the staff at every hub, the other hub’s pickup queues as 0 and its staff queue as it is (its hub: %s)',
    async (_label, role, own, other) => {
      const actor = await role.become();
      // Written out: the pending requests of its own hub, the profiles of its own hub and the profiles of the other (the hubs of the arrangement).
      const [ownPickups, ownStaff, otherStaff] =
        own === HUB_A ? ([4, 2, 1] as const) : ([2, 1, 2] as const);

      const asked = await summaryOf(actor.client, other);
      expect(asked.queues.map((entry) => entry.count)).toEqual([0, 0, 0, 0, 0, otherStaff]);
      expect(asked.queues.map((entry) => entry.queue)).toEqual(QUEUES.map((each) => each.queue));
      // The same session's lists agree with each count, queue by queue.
      expect(asked.queues).toEqual(await predictedFor(actor, other));
      expect(asked.queues).toEqual(expectedSummary(role, other));
      // The control: a Platform Admin, whose grants reach the hub, counts work in every pickup queue of it, so that the 0 above is the grant's
      // and not the hub's.
      const control = await summaryOf((await ADMIN_NO_HUB.become()).client, other);
      expect(control.queues.slice(0, 5).map((entry) => entry.count > 0)).toEqual([
        true,
        true,
        true,
        true,
        true,
      ]);

      // Its own hub: its own pickup work, and the profiles of its hub; and with no hub: its hub's pickup work and the profiles of every hub (four).
      const mine = await summaryOf(actor.client, own);
      expect(mine.queues[0]?.count).toBe(ownPickups);
      expect(countIn(mine.queues, PROFILES)).toBe(ownStaff);
      expect(mine.queues).toEqual(await predictedFor(actor, own));
      const everywhere = await summaryOf(actor.client);
      expect(countIn(everywhere.queues, PENDING)).toBe(ownPickups);
      expect(countIn(everywhere.queues, PROFILES)).toBe(4);
    },
  );

  // Break caught (AC-HUBF-10, GBT-GS14): the same widening the other way: the staff queue counted at every hub because its decision key reaches
  // every hub although its list key reaches one, or the pickup queues narrowed to the session's hub by its other keys.
  it('counts, for a bundle that reads the pickups at every hub and the staff at its hub, the second hub’s pickup work and no profile', async () => {
    const reverse: Role = {
      become: async () =>
        routes.actor(
          await newBundle(routes.admin, [
            grant('pickup.read', 'all'),
            grant('pickup.exception.approve', 'own'),
            grant('staff.read', 'own'),
            grant('staff.identity.approve', 'all'),
          ]),
          HUB_A,
        ),
      reaches: [HUB_A, HUB_B],
      staff: { hubs: [HUB_A], hubless: false },
    };
    const actor = await reverse.become();

    const second = await summaryOf(actor.client, HUB_B);
    expect(countsOf(second.queues)).toEqual([
      [PENDING, 2],
      [CUTOFF, 2],
      [ASKED, 1],
      [POOL, 1],
      [RUNNING, 2],
      [PROFILES, 0],
    ]);
    expect(second.queues).toEqual(await predictedFor(actor, HUB_B));
    expect(second.queues).toEqual(expectedSummary(reverse, HUB_B));
    // With no hub, its staff key reaches its own hub's two profiles and not the two with another hub or none.
    expect(countIn((await summaryOf(actor.client)).queues, PROFILES)).toBe(2);
  });

  // Break caught (AC-HUBF-10, GBT-GS14): a session whose grant reaches no hub read as though it reached every hub when a hub is named (an empty set
  // of hubs widened by the filter, or by the absence of one): it reads nothing for any hub_id, in the counts and in the lists.
  it('reads nothing, for any hub, for a session whose grant of the keys reaches no hub', async () => {
    const bundle = await newBundle(routes.admin, [
      grant('pickup.read', 'own'),
      grant('pickup.exception.approve', 'own'),
      grant('staff.read', 'own'),
      grant('staff.identity.approve', 'own'),
      grant('notification.read', 'own'),
    ]);
    const actor = await routes.actor(bundle, null);

    for (const hub of HUBS_ASKED) {
      const label = describeHub(hub);
      const summary = await summaryOf(actor.client, hub);
      expect(
        summary.queues.map((entry) => entry.queue),
        label,
      ).toEqual(QUEUES.map((each) => each.queue));
      expect(
        summary.queues.every((entry) => entry.count === 0),
        label,
      ).toBe(true);
      for (const path of [REQUESTS, RUNS, MESSAGES]) {
        const read = await readAll<MessageItem>(actor.client, path, { hub_id: hub });
        expect([read.status, read.items.length], `${path} with ${label}`).toEqual([200, 0]);
      }
    }
  });

  // Break caught (AC-HUBF-10, GBT-GS14): a hub named read as "every hub" for a session whose grant is of every hub (the filter dropped when the
  // grant is wide), or another hub's record let in beside it: it reads the hub named and no other.
  it('reads, for a session whose grant is of every hub, the hub named and no other', async () => {
    const actor = await ALL_HUB_BUNDLE.become();
    for (const [hub, other, written] of [
      [HUB_A, HUB_B, A_REQUESTS],
      [HUB_B, HUB_A, B_REQUESTS],
    ] as const) {
      const requests = await readAll<RequestItem>(actor.client, REQUESTS, { hub_id: hub });
      expect(namesOf(requests.items)).toEqual(written);
      expect(requests.items.some((item) => item.responsible_hub_id === other)).toBe(false);
      const summary = await summaryOf(actor.client, hub);
      expect(summary.queues).toEqual(expectedSummary(ALL_HUB_BUNDLE, hub));
      expect(summary.queues).toEqual(await predictedFor(actor, hub));
    }
  });
});

describe('AC-HUBF-11: leaving the filter out changes nothing', () => {
  // Break caught: a read without hub_id that is no longer what it was (an empty list, the filter taken as "the hub of no hub"; a reordered or
  // reshaped one; a count that moved): the whole of what the session reaches, in the order the lists have always had, and the figures written out.
  it.each(ROLES)(
    'for %s, each read without hub_id gives the whole of what the session reaches, in order, and the figures of all of it',
    async (_label, role) => {
      const actor = await role.become();
      const both = role.reaches.length === 2;

      expect(namesOf((await readAll<RequestItem>(actor.client, REQUESTS)).items)).toEqual(
        both ? ALL_REQUESTS : A_REQUESTS,
      );
      expect(namesOf((await readAll<RunItem>(actor.client, RUNS)).items)).toEqual(
        both ? ALL_RUNS : A_RUNS,
      );
      expect(namesOf((await readAll<MessageItem>(actor.client, MESSAGES)).items)).toEqual(
        both ? ALL_MESSAGES : A_MESSAGES,
      );
      expect((await summaryOf(actor.client)).queues).toEqual(expectedSummary(role, undefined));
    },
  );

  // Break caught: a page token that is more than a position (one that carries the filters it was made with: the hub asked for, a third element),
  // the position of another list, or a last page that carries one: every token of the lists read to their end in pages of two, without hub_id
  // and with it, is exactly the moment and the id of the last item of its page, so that page tokens are not bound to the filters (hub-filters.md
  // sections 5 and 14).
  it('gives page tokens that are only a position, without hub_id and with it: two elements, the second the id of the last row of each page', async () => {
    const admin = await ADMIN_NO_HUB.become();
    const positionOf = (token: string): unknown[] =>
      JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown[];

    for (const [path, whole, first, second] of [
      [REQUESTS, ALL_REQUESTS, A_REQUESTS, B_REQUESTS],
      [RUNS, ALL_RUNS, A_RUNS, B_RUNS],
      [MESSAGES, ALL_MESSAGES, A_MESSAGES, B_MESSAGES],
    ] as const) {
      for (const [filter, written] of [
        [{}, whole],
        [{ hub_id: HUB_A }, first],
        [{ hub_id: HUB_B }, second],
      ] as const) {
        const label = `${path} ${JSON.stringify(filter)}`;
        const read = await readAll<MessageItem>(admin.client, path, filter, 2);
        // Two to a page: as many pages as the hand-written list has pairs, the last one not full when the list is odd.
        expect(read.pages.length, label).toBe(Math.ceil(written.length / 2));
        for (const page of read.pages.slice(0, -1)) {
          const last = page.items.at(-1);
          expect(page.next_page_token, label).not.toBeNull();
          const position = positionOf(page.next_page_token ?? '');
          expect(position, label).toHaveLength(2);
          expect(position[1], label).toBe(last?.id);
        }
        expect(read.pages.at(-1)?.next_page_token, label).toBeNull();
      }
    }
  });

  // Break caught: a hub that adds a queue, drops one, reorders them or reshapes an entry: the answer with a hub has the entries of the answer
  // without it, in their order, and each count is at most the count of all of them.
  it.each(ROLES.filter(([, role]) => role === ADMIN_NO_HUB || role === OFFICER))(
    'for %s, a hub changes the summary only by narrowing its counts: the same entries in the same order, never more',
    async (_label, role) => {
      const actor = await role.become();
      const all = await summaryOf(actor.client);
      for (const hub of [HUB_A, HUB_B]) {
        const narrowed = await summaryOf(actor.client, hub);
        expect(narrowed.queues.map((entry) => entry.queue)).toEqual(
          all.queues.map((entry) => entry.queue),
        );
        for (const entry of narrowed.queues) {
          expect(entry.count, `${entry.queue} in ${describeHub(hub)}`).toBeLessThanOrEqual(
            countIn(all.queues, entry.queue),
          );
        }
      }
    },
  );
});

describe('AC-HUBF-12: a Vendor’s and a Rider’s reads are narrowed inside what they are shown', () => {
  /** The first vendor's requests (five in the first hub, five in the second) and the second's (six and three), in the order the list serves them. */
  const ONE = {
    all: [
      'b.pending1',
      'a.pending1',
      'a.pool1',
      'b.pool1',
      'a.pendingExc',
      'b.cancelled',
      'a.cancelled',
      'b.late2',
      'a.pool3',
      'b.onRun',
    ],
    a: ['a.pending1', 'a.pool1', 'a.pendingExc', 'a.cancelled', 'a.pool3'],
    b: ['b.pending1', 'b.pool1', 'b.cancelled', 'b.late2', 'b.onRun'],
  };
  const TWO = {
    all: [
      'a.pending2',
      'b.late1',
      'a.late',
      'b.pendingExc',
      'a.pool2',
      'a.pendingExc2',
      'a.onRun',
      'a.moved',
      'b.moved',
    ],
    a: ['a.pending2', 'a.late', 'a.pool2', 'a.pendingExc2', 'a.onRun', 'a.moved'],
    b: ['b.late1', 'b.pendingExc', 'b.moved'],
  };

  // Break caught: a Vendor's list that ignores the hub (both hubs' requests come back), that is widened by it (another vendor's request of the hub
  // let in, or the staff's reading by hub taken for the vendor's), or that is not the whole of its own organisation's requests without it; and an
  // audit event written for a read that crosses no hub.
  it.each([
    ['the first vendor', () => browserOne, ONE, TWO],
    ['the second vendor', () => browserTwo, TWO, ONE],
  ] as const)(
    'gives %s its own requests of the hub named, none of the other vendor’s and none of another hub’s, and its whole list without a hub',
    async (_label, browser, own, theirs) => {
      const client = browser();
      const events = await auditEvents();

      const whole = await readAll<RequestItem>(client, REQUESTS);
      expect(namesOf(whole.items)).toEqual(own.all);
      for (const [hub, written, outsideThisHub] of [
        [HUB_A, own.a, own.b],
        [HUB_B, own.b, own.a],
      ] as const) {
        const read = await readAll<RequestItem>(client, REQUESTS, { hub_id: hub });
        expect(read.status).toBe(200);
        expect(namesOf(read.items)).toEqual(written);
        expect(read.items).toEqual(whole.items.filter((item) => item.responsible_hub_id === hub));
        const seen = namesOf(read.items);
        for (const name of [...theirs.all, ...outsideThisHub]) expect(seen).not.toContain(name);
      }
      // A hub where it has no request, and one that does not exist: an empty page.
      for (const hub of [HUB_C, NO_HUB]) {
        const read = await client.get(`${REQUESTS}${queryOf({ hub_id: hub })}`);
        expect([read.status, read.json()]).toEqual([200, { items: [], next_page_token: null }]);
      }
      // It crosses no hub, so nothing is written for any of it.
      expect(await auditEvents()).toBe(events);
    },
  );

  // Break caught: a Rider's list of runs that ignores the hub, that is widened by it (a draft assigned to it, another rider's run, or a run it was
  // never assigned shown for the hub), or that is not the whole of its assigned and dispatched runs without it; and an event written for a read that
  // crosses no hub. Rider one holds runs in both hubs (and a draft in the first, never shown to it); rider three holds one run in the second hub.
  it('gives a Rider its assigned and dispatched runs of the hub named, and its whole list without a hub', async () => {
    const events = await auditEvents();

    const whole = await readAll<RunItem>(riderOne.client, RUNS);
    expect(namesOf(whole.items)).toEqual(['a.dispatched', 'b.dispatched', 'a.completed']);
    for (const [hub, written] of [
      [HUB_A, ['a.dispatched', 'a.completed']],
      [HUB_B, ['b.dispatched']],
      [HUB_C, []],
      [NO_HUB, []],
    ] as const) {
      const read = await readAll<RunItem>(riderOne.client, RUNS, { hub_id: hub });
      expect(read.status, describeHub(hub)).toBe(200);
      expect(namesOf(read.items), describeHub(hub)).toEqual(written);
      expect(read.items, describeHub(hub)).toEqual(
        whole.items.filter((item) => item.responsible_hub_id === hub),
      );
    }
    // The other rider, whose only run is the second hub's: the first hub is an empty page for it.
    expect(namesOf((await readAll<RunItem>(riderThree.client, RUNS)).items)).toEqual([
      'b.progress2',
    ]);
    expect(
      namesOf((await readAll<RunItem>(riderThree.client, RUNS, { hub_id: HUB_A })).items),
    ).toEqual([]);
    expect(
      namesOf((await readAll<RunItem>(riderThree.client, RUNS, { hub_id: HUB_B })).items),
    ).toEqual(['b.progress2']);

    expect(await auditEvents()).toBe(events);
  });

  // Break caught: a request shown to a Rider because a hub is named (the staff's reading by hub taken for the rider's), or a refusal of the read
  // that the filter changes: a Rider is served the list and is shown none of the requests (hub-filters.md section 3), so the answer is an empty
  // page, with a hub as without one.
  it('gives a Rider, for the requests, an empty page with a hub as without one: never a request', async () => {
    const events = await auditEvents();
    const emptyPage = { items: [], next_page_token: null };
    const without = await riderOne.client.get(REQUESTS);
    expect([without.status, without.json()]).toEqual([200, emptyPage]);

    for (const hub of [HUB_A, HUB_B, HUB_C, NO_HUB]) {
      const answer = await riderOne.client.get(`${REQUESTS}${queryOf({ hub_id: hub })}`);
      expect([answer.status, answer.json()], describeHub(hub)).toEqual([200, emptyPage]);
      expect(shapeOf(answer), describeHub(hub)).toEqual(shapeOf(without));
      for (const id of Object.values(requestIds)) expect(answer.text).not.toContain(id);
    }
    expect(await auditEvents()).toBe(events);
  });
});
