import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { composeNotificationSender } from '../notification-sender.js';
import { SystemClock } from '../platform/auth/clock/system.clock.adapter.js';
import { runSmoke } from './sms-smoke-run.js';

/**
 * The owner's real text message (S1.12d): `pnpm --filter @melarc/api run sms:smoke -- --to +233XXXXXXXXX`. The logic is `sms-smoke-run.ts`;
 * this file is where the clock and the worker's sender are bound to it, so it is on the architecture test's list of composition-root
 * files. The environment is `apps/api/.env` and the git-ignored `apps/api/.env.sms`, loaded by the package script.
 */
const clock = new SystemClock();
process.exitCode = await runSmoke(process.argv.slice(2), process.env, {
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  sleep: (ms) => sleep(ms),
  now: () => clock.now(),
  newId: () => randomUUID(),
  composeSender: (config) => composeNotificationSender(config, clock),
});
