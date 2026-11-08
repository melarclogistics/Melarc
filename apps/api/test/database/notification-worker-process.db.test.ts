import { randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { WORKER_RUNTIME_ROLE } from '../../src/platform/database/technical-roles.js';
import { spokenDate } from '../../src/platform/notifications/templates.js';
import { startHubtelStandIn, type HubtelStandIn } from '../../src/test-support/hubtel-stand-in.js';
import { localKeys } from '../../src/test-support/key-config.js';
import {
  DEADLINES,
  freePort,
  killAll,
  requireBuild,
  start,
  WORKER_MAIN,
} from '../support/api-process.js';
import { insertAdHocSender, insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { HUB_A } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * The notification lane in the real, built delivery worker against a real database (S1.12; review I-4 of 30 October 2026). The lane's own
 * tests build the lane themselves; nothing else proved that the worker **composes it**: that its periodic task runs, that its gauges are
 * served, and above all that a real provider is put behind the wording gate (`realProvider` is derived from the configuration in the
 * runtime, and a lane given `false` would send words the owner never approved to the allow-listed numbers). The worker says at its start
 * which mode it composed (`notification lane composed`), and the tests read that line; the gate itself, with a wording that is a draft, is
 * proved against the lane (`notification-lane.db.test.ts`), because every wording built so far has been approved by the owner.
 *
 * Both tests start the built process (`dist/delivery-worker-main.js`) with an environment, as an operator's would be, and read what it did
 * from the database and from its private metrics endpoint. The provider of the second is the Hubtel stand-in on a real socket, which
 * records every request; the numbers are made up and no credential is real.
 */
let database: TestDatabase;
let admin: pg.Client;
let sink: string;
let numbers = 0;

const keys = localKeys();

beforeAll(async () => {
  requireBuild();
  database = await createTestDatabase();
  // The platform's settings (the switch and the two limits) are seeded as the product seeds them: the lane reads them.
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  await admin.query(
    `insert into hub (id, name) values ('${HUB_A}', 'Hub A') on conflict do nothing`,
  );
  sink = await mkdtemp(join(tmpdir(), 'melarc-lane-process-sink-'));
});

afterAll(async () => {
  await admin.end();
  await database.drop();
  await rm(sink, { recursive: true, force: true });
});

afterEach(killAll);

function workerEnvironment(over: Record<string, string> = {}): Record<string, string> {
  const delivery = keys.purposes.credential_delivery;
  const secret = delivery.versions[delivery.activeVersion]?.reveal();
  if (secret === undefined) throw new Error('the test keys hold no delivery key');
  return {
    NODE_ENV: 'development',
    APP_ENV: 'local',
    DATABASE_WORKER_URL: database.urlFor(WORKER_RUNTIME_ROLE),
    KEY_CUSTODY: 'local',
    KEY_CREDENTIAL_DELIVERY_MATERIAL: `${String(delivery.activeVersion)}:${secret}`,
    KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION: String(delivery.activeVersion),
    DELIVERY_CAPTURE_DIRECTORY: sink,
    DELIVERY_WORKER_POLL_INTERVAL_MS: '100',
    SHUTDOWN_TIMEOUT_MS: '5000',
    ...over,
  };
}

/** A confirmed pickup request of an ad-hoc sender with a number of its own, and the envelope its confirmation wrote. */
async function confirmedRequest(): Promise<{ id: string; code: string; phone: string }> {
  numbers += 1;
  const phone = `+23324${String(1_000_000 + randomInt(0, 8_000_000) + numbers)}`;
  const sender = await insertAdHocSender(admin, { phone });
  const request = await insertPickupRequest(
    admin,
    pickupRequestRow('', HUB_A, {
      vendorOrganizationId: null,
      adHocSenderId: sender.id,
      intent: 'ADHOC_SENDER',
      state: 'CONFIRMED',
    }),
  );
  await admin.query(
    `insert into outbox (id, event_type, aggregate_type, aggregate_id, responsible_hub_id, originating_principal_type,
                         originating_principal_id, operation_id, correlation_id)
     values ($1, 'pickup.request.confirmed', 'PICKUP_REQUEST', $2, $3, 'STAFF', $4, 'confirmPickupRequest', $5)`,
    [randomUUID(), request.id, HUB_A, '5eed0000-0000-4000-8000-0000000000e1', randomUUID()],
  );
  return { id: request.id, code: request.code, phone };
}

interface Row {
  readonly state: string;
  readonly suppression_reason: string | null;
  readonly outcome_class: string | null;
  readonly attempt_count: number;
}

/** What the worker said it composed, from its start-up line. */
const composed = (said: string): Record<string, unknown> | undefined =>
  said
    .split('\n')
    .filter((line) => line.includes('notification lane composed'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)[0];

const rowOf = async (requestId: string): Promise<Row | undefined> =>
  (
    await admin.query<Row>(
      'select state, suppression_reason, outcome_class, attempt_count from notification where subject_id = $1',
      [requestId],
    )
  ).rows[0];

async function until(
  condition: () => Promise<boolean> | boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

const scrape = async (port: number): Promise<string | undefined> => {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/metrics`, {
      signal: AbortSignal.timeout(DEADLINES.request),
    });
    return response.status === 200 ? await response.text() : undefined;
  } catch {
    return undefined;
  }
};

describe('the built worker runs the notification lane', () => {
  // Break caught: a worker that never runs the lane (the periodic task dropped from the composition), so that every confirmation waits in
  // the outbox for ever; or one that serves no gauge of it, so that nobody can see that it does.
  it('relays the envelope of a confirmed request, writes the text to the capture folder and serves the lane’s metrics', async () => {
    const request = await confirmedRequest();
    const port = await freePort();
    const running = start(
      WORKER_MAIN,
      workerEnvironment({ DELIVERY_WORKER_METRICS_PORT: String(port) }),
    );

    await until(async () => (await rowOf(request.id))?.state === 'SENT', 'the text to be sent');
    // It says which mode it composed: a sender that reaches nobody, and no wording gate in front of it.
    expect(composed(running.stdout)).toMatchObject({
      notification_sms: 'capture',
      wording_gate: false,
    });
    expect(await rowOf(request.id)).toMatchObject({
      state: 'SENT',
      outcome_class: 'ACCEPTED',
      attempt_count: 1,
    });

    // The capture adapter wrote the text where the owner reads it (the test's own folder; the number is made up).
    const captured = (await readdir(sink)).filter((name) => name.endsWith('.json'));
    const bodies = await Promise.all(captured.map((name) => readFile(join(sink, name), 'utf8')));
    const mine = bodies.find((body) => body.includes(request.phone));
    expect(mine, 'a capture file for the number').toBeDefined();
    expect(mine).toContain(request.code);
    expect(mine).toMatch(/confirmed/);

    // ...and the worker serves what the lane did, and the backlog it has not.
    await until(async () => (await scrape(port)) !== undefined, 'the metrics endpoint to answer');
    const text = (await scrape(port)) ?? '';
    expect(text).toMatch(/^notification_relay_total\{outcome="MATERIALISED"\} 1$/m);
    expect(text).toMatch(/^notification_sends_total\{result="SENT"\} 1$/m);
    expect(text).toMatch(/^notification_oldest_due_age_seconds 0$/m);
    expect(text).toMatch(/^notification_dead_envelopes 0$/m);
    // No number, no code and no identifier on the endpoint.
    expect(text).not.toContain(request.phone);
    expect(text).not.toContain(request.code);

    await running.stop('SIGKILL');
  }, 90_000);

  // Break caught (review I-4): the wording gate lost in the composition, or the real provider never reached. The worker, given a real
  // provider and a window, says it composed the gate; it asks the provider (the stand-in, which records every request) once for the number
  // on the window's list, with the owner's words exactly as approved; and it puts no credential, number or word in what it says.
  describe('with a real provider', () => {
    let standIn: HubtelStandIn;
    beforeAll(async () => {
      standIn = await startHubtelStandIn({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      });
    });
    afterAll(async () => {
      await standIn.close();
    });

    it('puts the wording gate in front of the provider and sends it the words the owner approved, once', async () => {
      const request = await confirmedRequest();
      const port = await freePort();
      const ends = new Date(Date.now() + 2 * 24 * 3_600_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z');
      const running = start(
        WORKER_MAIN,
        workerEnvironment({
          DELIVERY_WORKER_METRICS_PORT: String(port),
          NOTIFICATION_SMS_ADAPTER: 'provider',
          NOTIFICATION_SMS_ENDPOINT: standIn.endpoint,
          NOTIFICATION_SMS_TIMEOUT_MS: '3000',
          HUBTEL_SMS_CLIENT_ID: 'test-client-id',
          HUBTEL_SMS_CLIENT_SECRET: 'test-client-secret',
          HUBTEL_SMS_SENDER_ID: 'Melarc',
          DELIVERY_PROVIDER_APPROVAL_REF: 'TEST-WINDOW-0001',
          DELIVERY_PROVIDER_ALLOWLIST: request.phone,
          DELIVERY_PROVIDER_MESSAGE_CAP: '5',
          DELIVERY_PROVIDER_WINDOW_ENDS_AT: ends,
        }),
      );

      await until(async () => (await rowOf(request.id))?.state === 'SENT', 'the text to be sent');
      // The worker says it composed the real provider behind the gate.
      expect(composed(running.stdout)).toMatchObject({
        notification_sms: 'provider',
        wording_gate: true,
      });
      // The provider was asked once, with the credentials, for the number on the window's list, and with the approved words.
      const sends = standIn.requests.filter((each) => each.method === 'POST');
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({ credentialsMatched: true });
      expect(sends[0]?.body).toMatchObject({
        From: 'Melarc',
        To: request.phone.replace('+', ''),
        Content: `Melarc: your pickup ${request.code} is confirmed for ${spokenDate('2026-11-03')}. Please have your parcels ready.`,
      });

      await until(async () => (await scrape(port)) !== undefined, 'the metrics endpoint to answer');
      expect((await scrape(port)) ?? '').toMatch(/^notification_sends_total\{result="SENT"\} 1$/m);
      // No credential, number or word of the message in what the process said.
      const said = running.stdout + running.stderr;
      expect(said).not.toContain('test-client-secret');
      expect(said).not.toContain(request.phone);
      expect(said).not.toContain('Please have your parcels ready');

      await running.stop('SIGKILL');
    }, 90_000);
  });
});
