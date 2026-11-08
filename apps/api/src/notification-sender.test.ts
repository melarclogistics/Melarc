import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  NotificationSenderConfigurationError,
  composeNotificationSender,
} from './notification-sender.js';
import { SystemClock } from './platform/auth/clock/system.clock.adapter.js';
import { loadWorkerConfig, type WorkerConfig } from './platform/delivery/worker/worker-config.js';
import { startHubtelStandIn, type HubtelStandIn } from './test-support/hubtel-stand-in.js';

/**
 * The text-message sender of the notification lane, as the worker composes it from its configuration (S1.12d): the capture adapter by
 * default, and Hubtel behind the guards of the controlled window, over a real socket to the stand-in. Nothing here reaches a real provider.
 */
const CLIENT_ID = 'SENTINEL-CLIENT-ID-7f3a';
const CLIENT_SECRET = 'SENTINEL-CLIENT-SECRET-b91c';
const OWNER_NUMBER = '+233244000111';
const STRANGER_NUMBER = '+233244000222';
const clock = new SystemClock();

let directory: string;
let standIn: HubtelStandIn | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'melarc-notification-sender-'));
});

afterEach(async () => {
  await standIn?.close();
  standIn = undefined;
  await rm(directory, { recursive: true, force: true });
});

const randomKey = () => randomBytes(32).toString('base64url');

function configFor(over: Record<string, string | undefined> = {}, now?: Date): WorkerConfig {
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'development',
    APP_ENV: 'local',
    DATABASE_WORKER_URL:
      'postgresql://melarc_worker_runtime:SENTINEL-DB-PASSWORD@127.0.0.1:5434/melarc_dev',
    KEY_CUSTODY: 'local',
    KEY_CREDENTIAL_DELIVERY_MATERIAL: `1:${randomKey()}`,
    KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION: '1',
    DELIVERY_CAPTURE_DIRECTORY: join(directory, 'sink'),
    ...over,
  };
  const loaded = loadWorkerConfig(env, now === undefined ? {} : { now });
  if (!loaded.ok)
    throw new Error(`refused: ${loaded.problems.map((problem) => problem.key).join(', ')}`);
  return loaded.config;
}

const inDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** A local run with the lane's provider selected, the stand-in as its endpoint and the whole window around it. */
function windowEnv(endpoint: string, over: Record<string, string | undefined> = {}) {
  return {
    NOTIFICATION_SMS_ADAPTER: 'provider',
    NOTIFICATION_SMS_ENDPOINT: endpoint,
    NOTIFICATION_SMS_TIMEOUT_MS: '3000',
    HUBTEL_SMS_CLIENT_ID: CLIENT_ID,
    HUBTEL_SMS_CLIENT_SECRET: CLIENT_SECRET,
    HUBTEL_SMS_SENDER_ID: 'Melarc',
    DELIVERY_PROVIDER_APPROVAL_REF: 'OWNER-2026-10-29-SMS',
    DELIVERY_PROVIDER_ALLOWLIST: OWNER_NUMBER,
    DELIVERY_PROVIDER_MESSAGE_CAP: '2',
    DELIVERY_PROVIDER_WINDOW_ENDS_AT: inDays(3),
    ...over,
  };
}

const message = (destination: string, id = 'a1b2c3d4-0000-4000-8000-000000000001') => ({
  dedupeId: id,
  destination,
  text: 'Melarc test message',
});

describe('the notification lane’s sender, as the worker composes it', () => {
  // Break caught: the default sender reaching a provider, or writing where the credential capture would be mistaken for it.
  it('is the capture adapter by default: it writes the message into the capture folder and reaches nobody', async () => {
    const sender = composeNotificationSender(configFor(), clock);
    const outcome = await sender.send(message(OWNER_NUMBER));
    expect(outcome).toMatchObject({ outcome: 'ACCEPTED' });
    const files = await readdir(join(directory, 'sink'));
    expect(files).toEqual(['a1b2c3d4-0000-4000-8000-000000000001.json']);
    const written = JSON.parse(await readFile(join(directory, 'sink', files[0] ?? ''), 'utf8')) as {
      destination: string;
      text: string;
    };
    expect(written).toMatchObject({ destination: OWNER_NUMBER, text: 'Melarc test message' });
    expect(
      await sender.status((outcome as { providerMessageRef: string }).providerMessageRef),
    ).toEqual({ state: 'DELIVERED' });
  });

  it('needs a capture folder to capture into, and names the setting', () => {
    const config = configFor();
    const without: WorkerConfig = {
      ...config,
      delivery: { ...config.delivery, captureDirectory: undefined },
    };
    expect(() => composeNotificationSender(without, clock)).toThrow(
      NotificationSenderConfigurationError,
    );
  });

  // Break caught: the window not standing in front of the provider: a message to a stranger, or past the cap, reaching Hubtel.
  it('puts Hubtel behind the window: it sends to the owner’s number and to nobody else, and stops at the cap', async () => {
    standIn = await startHubtelStandIn({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const sender = composeNotificationSender(configFor(windowEnv(standIn.endpoint)), clock);

    expect(await sender.send(message(STRANGER_NUMBER))).toEqual({
      outcome: 'REJECTED',
      outcomeClass: 'DESTINATION_NOT_ALLOWED',
    });
    expect(standIn.requests).toHaveLength(0);

    expect(await sender.send(message(OWNER_NUMBER))).toMatchObject({ outcome: 'ACCEPTED' });
    expect(await sender.send(message(OWNER_NUMBER))).toMatchObject({ outcome: 'ACCEPTED' });
    expect(await sender.send(message(OWNER_NUMBER))).toEqual({
      outcome: 'REJECTED',
      outcomeClass: 'WINDOW_CAP',
    });
    expect(standIn.requests.filter((request) => request.method === 'POST')).toHaveLength(2);
    expect(standIn.requests.every((request) => request.credentialsMatched)).toBe(true);
  });

  // Break caught: the count lost between two workers, or between two starts of one: a restart giving the window back its messages.
  it('keeps the cap across the start of a new worker with the same approval, and gives a new approval its own count', async () => {
    standIn = await startHubtelStandIn({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const first = composeNotificationSender(configFor(windowEnv(standIn.endpoint)), clock);
    await first.send(message(OWNER_NUMBER));
    await first.send(message(OWNER_NUMBER));
    const restarted = composeNotificationSender(configFor(windowEnv(standIn.endpoint)), clock);
    expect(await restarted.send(message(OWNER_NUMBER))).toEqual({
      outcome: 'REJECTED',
      outcomeClass: 'WINDOW_CAP',
    });
    const renewed = composeNotificationSender(
      configFor(
        windowEnv(standIn.endpoint, { DELIVERY_PROVIDER_APPROVAL_REF: 'OWNER-2026-11-02-SMS' }),
      ),
      clock,
    );
    expect(await renewed.send(message(OWNER_NUMBER))).toMatchObject({ outcome: 'ACCEPTED' });
  });

  // Break caught: a window whose end is not enforced when the message is sent, only when the worker starts.
  it('refuses at the end of the window, however long the worker has been running', async () => {
    standIn = await startHubtelStandIn({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const config = configFor(windowEnv(standIn.endpoint));
    const late = new SystemClock();
    const afterTheEnd = {
      now: () => new Date((config.delivery.providerWindow?.endsAt ?? new Date()).getTime() + 1_000),
      monotonicMilliseconds: () => late.monotonicMilliseconds(),
    };
    const sender = composeNotificationSender(config, afterTheEnd);
    expect(await sender.send(message(OWNER_NUMBER))).toEqual({
      outcome: 'REJECTED',
      outcomeClass: 'WINDOW_ENDED',
    });
    expect(standIn.requests).toHaveLength(0);
  });

  // Break caught: the credentials of the lane in a message, a file or an error.
  it('carries no credential into an outcome, an error or the capture folder', async () => {
    standIn = await startHubtelStandIn({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const sender = composeNotificationSender(configFor(windowEnv(standIn.endpoint)), clock);
    const outcome = await sender.send(message(OWNER_NUMBER));
    expect(JSON.stringify(outcome)).not.toContain(CLIENT_ID);
    expect(JSON.stringify(outcome)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(configFor(windowEnv(standIn.endpoint)))).not.toContain(CLIENT_SECRET);
    const folder = await readdir(directory).catch(() => []);
    for (const entry of folder) {
      expect(entry).not.toContain(CLIENT_SECRET);
    }
  });
});
