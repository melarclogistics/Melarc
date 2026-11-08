import { startDeliveryWorker } from './delivery-worker-process.js';
import { WORKER_APPLICATION_NAME } from './delivery-worker-runtime.js';
import { describeError } from './platform/logging/redaction.js';

/**
 * The delivery worker's entry point (S0.18), beside `main.ts`: a separate process whose only inbound listener is its optional private
 * metrics endpoint (S0.68, off unless `DELIVERY_WORKER_METRICS_PORT` is set), started with
 * `node dist/delivery-worker-main.js` (`pnpm --filter @melarc/api run start:worker`). Everything it does is in
 * `delivery-worker-process.ts`; this file only gives it the environment and reports a start-up that failed after the settings
 * were accepted (a real provider selected and none built; a capture sink inside the checkout).
 */
try {
  startDeliveryWorker(process.env);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      level: 'fatal',
      time: new Date().toISOString(),
      service: WORKER_APPLICATION_NAME,
      msg: 'startup failed',
      err: describeError(error),
    })}\n`,
  );
  process.exitCode = 1;
}
