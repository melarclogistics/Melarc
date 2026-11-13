import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeNotificationSender } from '../notification-sender.js';
import { SystemClock } from '../platform/auth/clock/system.clock.adapter.js';
import {
  accepted,
  dropped,
  refused,
  startHubtelStandIn,
  statusIs,
  type HubtelStandIn,
} from '../test-support/hubtel-stand-in.js';
import { parseSmokeArguments, runSmoke, type SmokeIo } from './sms-smoke-run.js';

/**
 * The owner's one real text message (S1.12d), run against the Hubtel stand-in: the command reads the settings as the worker does, is
 * refused by the same guards, tells what happened in words, and never prints a credential. Nothing here reaches a real provider.
 */
const CLIENT_ID = 'SENTINEL-CLIENT-ID-7f3a';
const CLIENT_SECRET = 'SENTINEL-CLIENT-SECRET-b91c';
const OWNER_NUMBER = '+233244000111';
const clock = new SystemClock();

let directory: string;
let standIn: HubtelStandIn | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'melarc-smoke-'));
});
afterEach(async () => {
  await standIn?.close();
  standIn = undefined;
  await rm(directory, { recursive: true, force: true });
});

const inDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

function baseEnv(
  over: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: 'development',
    APP_ENV: 'local',
    DATABASE_WORKER_URL:
      'postgresql://melarc_worker_runtime:SENTINEL-DB-PASSWORD@127.0.0.1:5434/melarc_dev',
    KEY_CUSTODY: 'local',
    KEY_CREDENTIAL_DELIVERY_MATERIAL: `1:${randomBytes(32).toString('base64url')}`,
    KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION: '1',
    DELIVERY_CAPTURE_DIRECTORY: join(directory, 'sink'),
    PICKUP_BACKSTOP_INTERVAL_MINUTES: '15',
    ...over,
  };
}

const realEnv = (endpoint: string, over: Record<string, string | undefined> = {}) =>
  baseEnv({
    NOTIFICATION_SMS_ADAPTER: 'provider',
    NOTIFICATION_SMS_ENDPOINT: endpoint,
    NOTIFICATION_SMS_TIMEOUT_MS: '1500',
    HUBTEL_SMS_CLIENT_ID: CLIENT_ID,
    HUBTEL_SMS_CLIENT_SECRET: CLIENT_SECRET,
    HUBTEL_SMS_SENDER_ID: 'Melarc',
    DELIVERY_PROVIDER_APPROVAL_REF: 'OWNER-2026-10-29-SMS',
    DELIVERY_PROVIDER_ALLOWLIST: OWNER_NUMBER,
    DELIVERY_PROVIDER_MESSAGE_CAP: '3',
    DELIVERY_PROVIDER_WINDOW_ENDS_AT: inDays(3),
    ...over,
  });

function io(lines: string[], composed: { count: number } = { count: 0 }): SmokeIo {
  return {
    out: (line) => {
      lines.push(line);
    },
    sleep: () => Promise.resolve(),
    now: () => new Date(),
    newId: () => randomUUID(),
    composeSender: (config) => {
      composed.count += 1;
      return composeNotificationSender(config, clock);
    },
  };
}

const ran = async (argv: string[], env: Record<string, string | undefined>) => {
  const lines: string[] = [];
  const composed = { count: 0 };
  const code = await runSmoke(argv, env, io(lines, composed));
  return { code, lines, text: lines.join('\n'), composed };
};

describe('the command line', () => {
  it('needs a number in international form', () => {
    for (const bad of [
      [],
      ['--to'],
      ['--to', '0244000111'],
      ['--to', '233244000111'],
      ['--to', '+233 244 000 111'],
    ]) {
      expect(typeof parseSmokeArguments(bad), String(bad)).toBe('string');
    }
    expect(parseSmokeArguments(['--to', OWNER_NUMBER])).toEqual({
      to: OWNER_NUMBER,
      text: 'Melarc test message. No reply is needed.',
      waitSeconds: 60,
    });
  });

  // Break caught: a text that carries a link, is not plain, or does not fit one message: each is refused before anything is composed.
  it.each([
    ['a link', 'see https://x.test/a'],
    ['a host', 'visit www.example'],
    ['a curly quote', 'it’s me'],
    ['nothing', ''],
    ['too much', 'x'.repeat(161)],
  ])('refuses a text with %s', (_what, text) => {
    expect(typeof parseSmokeArguments(['--to', OWNER_NUMBER, '--text', text])).toBe('string');
  });

  it('refuses an option it does not know, a wait that is not a count of seconds, and a flag without its value', () => {
    expect(typeof parseSmokeArguments(['--to', OWNER_NUMBER, '--force'])).toBe('string');
    expect(typeof parseSmokeArguments(['--to', OWNER_NUMBER, '--wait', '-1'])).toBe('string');
    expect(typeof parseSmokeArguments(['--to', OWNER_NUMBER, '--wait', '601'])).toBe('string');
    expect(typeof parseSmokeArguments(['--to', OWNER_NUMBER, '--wait', '1.5'])).toBe('string');
    expect(typeof parseSmokeArguments(['--to', OWNER_NUMBER, '--text'])).toBe('string');
  });

  it('ends with status 2 and sends nothing, and builds no sender, when the command line is wrong', async () => {
    const result = await ran(['--to', 'nope'], baseEnv());
    expect(result.code).toBe(2);
    expect(result.composed.count).toBe(0);
  });
});

describe('the settings', () => {
  // Break caught: the command running on settings the worker would refuse: an incomplete window, a value that says too much.
  it('is refused as the worker is, naming the keys and never a value', async () => {
    standIn = await startHubtelStandIn({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const unreadable = await ran(
      ['--to', OWNER_NUMBER],
      realEnv(standIn.endpoint, { DELIVERY_PROVIDER_MESSAGE_CAP: 'SENTINEL-NOT-A-NUMBER' }),
    );
    expect(unreadable.code).toBe(2);
    expect(unreadable.text).toContain('DELIVERY_PROVIDER_MESSAGE_CAP');
    expect(unreadable.text).not.toContain('SENTINEL-NOT-A-NUMBER');
    const incomplete = await ran(
      ['--to', OWNER_NUMBER],
      realEnv(standIn.endpoint, { DELIVERY_PROVIDER_ALLOWLIST: undefined }),
    );
    expect(incomplete.code).toBe(2);
    expect(incomplete.text).toContain('DELIVERY_PROVIDER_ALLOWLIST');
    expect(unreadable.composed.count + incomplete.composed.count).toBe(0);
    expect(standIn.requests).toHaveLength(0);
  });

  // Break caught: a window that is open for months being used for a smoke test.
  it('refuses a window that ends beyond the controlled fortnight', async () => {
    standIn = await startHubtelStandIn({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const result = await ran(
      ['--to', OWNER_NUMBER],
      realEnv(standIn.endpoint, { DELIVERY_PROVIDER_WINDOW_ENDS_AT: inDays(30) }),
    );
    expect(result.code).toBe(2);
    expect(result.text).toContain('DELIVERY_PROVIDER_WINDOW_ENDS_AT');
  });
});

describe('a dry run on the capture adapter', () => {
  it('writes the message into the capture folder, says it is a dry run, and reaches nobody', async () => {
    const result = await ran(['--to', OWNER_NUMBER, '--text', 'Hello from the dry run'], baseEnv());
    expect(result.code).toBe(0);
    expect(result.text).toContain('DRY RUN');
    expect(await readdir(join(directory, 'sink'))).toHaveLength(1);
    expect(result.text).toContain('Network: DELIVERED');
  });
});

describe('the real message, against the stand-in', () => {
  // Break caught: the whole path: the credentials, the contract, the answer, the network's word, and what the owner reads.
  it('sends to the owner’s number, waits for the network, and reports delivered', async () => {
    standIn = await startHubtelStandIn({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    standIn.queueSend(accepted('MSG-9001'));
    standIn.scriptStatus('MSG-9001', statusIs('Sent'), statusIs('Delivered'));
    const result = await ran(
      ['--to', OWNER_NUMBER, '--text', 'Smoke test'],
      realEnv(standIn.endpoint),
    );
    expect(result.code).toBe(0);
    expect(result.text).toContain('Mode: REAL');
    expect(result.text).toContain('Its reference: MSG-9001');
    expect(result.text).toContain('Network: PENDING');
    expect(result.text).toContain('Network: DELIVERED');
    const [send] = standIn.requests;
    expect(send).toMatchObject({ method: 'POST', credentialsMatched: true });
    expect(send?.body).toMatchObject({ From: 'Melarc', To: '233244000111', Content: 'Smoke test' });
  });

  // Break caught: a credential, or the whole number, in what the owner reads or pastes into a chat.
  it('prints no credential and not the whole number', async () => {
    standIn = await startHubtelStandIn({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    standIn.queueSend(accepted('MSG-9002'));
    standIn.scriptStatus('MSG-9002', statusIs('Delivered'));
    const result = await ran(['--to', OWNER_NUMBER], realEnv(standIn.endpoint));
    for (const secret of [
      CLIENT_ID,
      CLIENT_SECRET,
      Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      OWNER_NUMBER,
      'SENTINEL-DB-PASSWORD',
    ]) {
      expect(result.text, secret).not.toContain(secret);
    }
  });

  // Break caught (the window): a number the owner does not control reaching Hubtel from a command the owner types.
  it('refuses a number that is not on the allow-list, before Hubtel is asked', async () => {
    standIn = await startHubtelStandIn({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const result = await ran(['--to', '+233244000222'], realEnv(standIn.endpoint));
    expect(result.code).toBe(1);
    expect(result.text).toContain('DESTINATION_NOT_ALLOWED');
    expect(result.text).toContain('DELIVERY_PROVIDER_ALLOWLIST');
    expect(standIn.requests).toHaveLength(0);
  });

  it('stops at the cap of the window, across runs of the command', async () => {
    standIn = await startHubtelStandIn({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    standIn.scriptStatus('MSG-1', statusIs('Delivered'));
    const env = realEnv(standIn.endpoint, { DELIVERY_PROVIDER_MESSAGE_CAP: '1' });
    standIn.queueSend(accepted('MSG-1'));
    expect((await ran(['--to', OWNER_NUMBER], env)).code).toBe(0);
    const second = await ran(['--to', OWNER_NUMBER], env);
    expect(second.code).toBe(1);
    expect(second.text).toContain('WINDOW_CAP');
    expect(standIn.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('says what a credential Hubtel does not know comes to, without printing any', async () => {
    standIn = await startHubtelStandIn({
      clientId: 'someone-else',
      clientSecret: 'another-secret',
    });
    const result = await ran(['--to', OWNER_NUMBER], realEnv(standIn.endpoint));
    expect(result.code).toBe(1);
    expect(result.text).toContain('PROVIDER_AUTHENTICATION');
    expect(result.text).toContain('HUBTEL_SMS_CLIENT_ID');
    expect(result.text).not.toContain(CLIENT_SECRET);
  });

  it('reports a refusal by the provider with its closed word', async () => {
    standIn = await startHubtelStandIn({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    standIn.queueSend(refused(422));
    const result = await ran(['--to', OWNER_NUMBER], realEnv(standIn.endpoint));
    expect(result.code).toBe(1);
    expect(result.text).toContain('REQUEST_INVALID');
  });

  // Break caught: an answer that cannot be trusted read as a success or as a refusal, either of which makes the owner send again.
  it('reports no answer as unknown and tells the owner not to send again blindly', async () => {
    standIn = await startHubtelStandIn({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    standIn.queueSend(dropped());
    const result = await ran(['--to', OWNER_NUMBER], realEnv(standIn.endpoint));
    expect(result.code).toBe(1);
    expect(result.text).toContain('do not send it again blindly');
  });

  it('reports a failure in delivery as a failure', async () => {
    standIn = await startHubtelStandIn({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    standIn.queueSend(accepted('MSG-3'));
    standIn.scriptStatus('MSG-3', statusIs('Undeliverable'));
    const result = await ran(['--to', OWNER_NUMBER], realEnv(standIn.endpoint));
    expect(result.code).toBe(1);
    expect(result.text).toContain('Network: FAILED (UNDELIVERABLE)');
  });

  it('stops waiting when the network has not said, and still counts the message as taken', async () => {
    standIn = await startHubtelStandIn({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    standIn.queueSend(accepted('MSG-4'));
    standIn.scriptStatus('MSG-4', statusIs('Sent'));
    const result = await ran(['--to', OWNER_NUMBER, '--wait', '0'], realEnv(standIn.endpoint));
    expect(result.code).toBe(0);
    expect(result.text).toContain('The network has not said yet');
  });
});
