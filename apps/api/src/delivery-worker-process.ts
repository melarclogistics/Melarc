import { loadWorkerConfig } from './platform/delivery/worker/worker-config.js';
import { reportConfigProblems } from './platform/config/report-config-problems.js';
import { installFaultHandlers } from './platform/lifecycle/fault-handlers.js';
import { installShutdownHandlers } from './platform/lifecycle/shutdown-handlers.js';
import { describeError } from './platform/logging/redaction.js';
import {
  WORKER_APPLICATION_NAME,
  createDeliveryWorkerRuntime,
  type DeliveryWorkerRuntime,
  type RuntimeOptions,
} from './delivery-worker-runtime.js';
import { withLocalWorkerDefaults } from './tools/delivery/worker-local-env.js';

/**
 * Starts the delivery worker as a process (S0.18): the settings, the runtime, the fault and stop-signal handlers, and the lanes.
 * `delivery-worker-main.ts` calls it with the process's environment and nothing else; the process tests call it with a provider
 * that stalls, a reader that answers, or a destination they can read, so that what they test is this start-up and not a copy of it.
 *
 * It validates the settings before anything exists and refuses to start on a bad one, naming the keys and never a value, with exit
 * code 1. Like the API it does not call `process.exit()` on the normal paths: a stop signal runs the shutdown, which sets the
 * exit code and lets the event loop drain; a shutdown that ran out of its budget ends the process non-zero at once
 * (`installShutdownHandlers`). A local run is given its login and its sink by `withLocalWorkerDefaults`; no other is.
 *
 * Returns the runtime, or `undefined` when the settings were refused (the exit code is set). A composition that refuses throws.
 */
export function startDeliveryWorker(
  environment: Readonly<Record<string, string | undefined>>,
  options: RuntimeOptions = {},
): DeliveryWorkerRuntime | undefined {
  let env: Record<string, string | undefined>;
  try {
    env = withLocalWorkerDefaults(environment);
  } catch (error) {
    // The local cluster is not set up. The message names settings and never their values.
    process.stderr.write(
      `${JSON.stringify({
        level: 'fatal',
        time: new Date().toISOString(),
        service: WORKER_APPLICATION_NAME,
        msg: 'The local settings of the delivery worker are missing: the delivery worker will not start',
        err: describeError(error),
      })}\n`,
    );
    process.exitCode = 1;
    return undefined;
  }

  const loaded = loadWorkerConfig(env);
  if (!loaded.ok) {
    process.stderr.write(
      reportConfigProblems(loaded.problems, new Date(), {
        service: WORKER_APPLICATION_NAME,
        subject: 'the delivery worker',
      }),
    );
    process.exitCode = 1;
    return undefined;
  }

  // Composition can still refuse (a real provider selected and none built; a sink inside the checkout): that is a start-up failure
  // the caller reports, and nothing has been opened yet.
  const runtime = createDeliveryWorkerRuntime(loaded.config, options);

  installFaultHandlers(runtime.logger, {
    on: (event, listener) => process.on(event, listener),
    exit: (code) => process.exit(code),
  });
  installShutdownHandlers({
    logger: runtime.logger,
    target: {
      on: (signal, listener) => process.on(signal, listener),
      setExitCode: (code) => {
        process.exitCode = code;
      },
      exit: (code) => process.exit(code),
    },
    shutdown: () => runtime.shutdown(),
  });
  runtime.start();
  return runtime;
}
