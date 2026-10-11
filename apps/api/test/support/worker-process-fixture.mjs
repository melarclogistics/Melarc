// A test-only entry point for the delivery worker's process tests (test/delivery-worker.process.test.ts and
// test/database/delivery-worker-process.db.test.ts). It is never built into dist and nothing in src/ refers to it, so production
// carries no switch for any of this.
//
// It starts the real worker from the built output through the same start-up the real entry point uses (startDeliveryWorker, which
// installs the same fault and stop-signal handlers), and adds what a test needs and production does not have:
//
//   plain       the worker as composed: the capture adapter and the reader that confirms nothing
//   stalling    a provider that is given a message and never answers, and a reader that says every record is pending, so that a
//               message is claimed and its send is in flight when the process is told to stop. As the provider receives the message
//               it writes one line to stdout, {"msg":"fixture: the provider received a message"}, for a test to wait for before it
//               signals the process; a stop that comes after the send's own time (the capture adapter's 5 s) has run out finds the
//               send recorded as UNKNOWN, not given back, so a test must signal while the send is within its time
//   --signal-itself            sends itself a stop signal shortly after it has started, so that a test does not depend on the
//                              operating system delivering one (Windows does not deliver SIGTERM)
//   --signal-itself-on-send    (stalling) sends itself a stop signal as the provider receives its first message
//   --signal-after=<ms>        sends itself a stop signal after that many milliseconds
//   --retention=<ms>           runs the retention cleanup at that interval instead of the real one
//
// usage: node worker-process-fixture.mjs <plain|stalling> [--signal-itself] [--signal-itself-on-send] [--signal-after=<ms>]
//                                        [--retention=<ms>]
import process from 'node:process';
import { setTimeout } from 'node:timers';

import { startDeliveryWorker } from '../../dist/delivery-worker-process.js';

const [mode, ...flags] = process.argv.slice(2);
if (mode !== 'plain' && mode !== 'stalling') {
  process.stderr.write(
    'usage: worker-process-fixture.mjs <plain|stalling> [--signal-itself] [--signal-itself-on-send]\n',
  );
  process.exit(2);
}

const stopSignal = () => process.emit('SIGTERM', 'SIGTERM');

// The line `stalling` writes as the provider receives a message (test/database/delivery-worker-process.db.test.ts waits for it).
const SEND_ANNOUNCEMENT = 'fixture: the provider received a message';

const flagValue = (name) => {
  const given = flags.find((flag) => flag.startsWith(`--${name}=`));
  return given === undefined ? undefined : Number(given.slice(name.length + 3));
};
const retention = flagValue('retention');
const signalAfter = flagValue('signal-after');

const options = {
  ...(retention === undefined ? {} : { retentionIntervalMs: retention }),
  ...(mode === 'plain'
    ? {}
    : {
        providerFactory: () => ({
          send: () => {
            // The message is in flight from here. Say so on stdout (a line a test can wait for): the worker's own line for the claim
            // is written at debug, which the default level does not write, so a test that waited for it would wait for nothing.
            process.stdout.write(`${JSON.stringify({ msg: SEND_ANNOUNCEMENT })}\n`);
            if (flags.includes('--signal-itself-on-send')) stopSignal();
            return new Promise(() => undefined);
          },
          status: () => Promise.resolve(null),
        }),
        redemptionReader: { standing: () => Promise.resolve('PENDING') },
      }),
};

const runtime = startDeliveryWorker(process.env, options);
if (runtime !== undefined && flags.includes('--signal-itself')) {
  setTimeout(stopSignal, 300);
}
if (runtime !== undefined && signalAfter !== undefined) {
  setTimeout(stopSignal, signalAfter);
}
