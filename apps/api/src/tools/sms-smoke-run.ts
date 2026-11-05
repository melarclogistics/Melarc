import type { TextMessageSender } from '../platform/auth/ports/text-message-sender.port.js';
import { loadWorkerConfig, type WorkerConfig } from '../platform/delivery/worker/worker-config.js';
import { destinationHint } from '../platform/notifications/notification-lane.js';

/**
 * The logic of `pnpm --filter @melarc/api run sms:smoke -- --to +233XXXXXXXXX` (S1.12d): the owner's one real text message, through the
 * sender the worker is composed with, under the guards of the controlled window (DEPLOYMENT_AND_ENVIRONMENTS.md §4.1). It exists so that
 * the first contact with Hubtel is a command the owner runs and reads, with their own credentials in the git-ignored `apps/api/.env.sms`
 * that nobody else sees, and not a message the application sends in the middle of a workflow.
 *
 * It reads its settings **as the worker does** (`loadWorkerConfig`): the same keys, the same refusals, the same window. A window that is
 * not complete, a number that is not on its allow-list, a window that has ended and a cap that is spent are refused here exactly as the
 * worker refuses them, before anything leaves this machine. With the capture adapter selected it sends nothing and writes the message to the
 * capture folder, which is a dry run of everything but the provider.
 *
 * **What it prints.** What happened, in words: the mode, a masked form of the number, the provider's answer (its closed word, and the
 * reference of a message it took), and what the network later said. **It never prints a credential, a header, an address of the provider
 * or the text of the provider's answer**, and a refused setting is named by its key and never by its value. The text of the message is the
 * owner's own and is printed as sent.
 *
 * Exit status: 0 when the provider took the message and the network did not say it failed; 1 when it did not (refused, no answer, held
 * back by a guard, or failed in delivery); 2 when the command line or the settings are wrong and nothing was sent.
 */

export interface SmokeIo {
  readonly out: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Date;
  readonly newId: () => string;
  /** The worker's sender for this configuration (`composeNotificationSender`), made by the file that composes it. */
  readonly composeSender: (config: WorkerConfig) => TextMessageSender;
}

const E164 = /^\+[1-9][0-9]{7,14}$/;
const DEFAULT_TEXT = 'Melarc test message. No reply is needed.';
const POLL_EVERY_MS = 5_000;
const DEFAULT_WAIT_SECONDS = 60;
const MAX_WAIT_SECONDS = 600;

interface Options {
  readonly to: string;
  readonly text: string;
  readonly waitSeconds: number;
}

const USAGE =
  'usage: sms:smoke -- --to +233XXXXXXXXX [--text "words, plain letters, no link"] [--wait seconds]';

/** What is wrong with the command line, in words that hold no value; or the options. */
export function parseSmokeArguments(argv: readonly string[]): Options | string {
  let to: string | undefined;
  let text = DEFAULT_TEXT;
  let waitSeconds = DEFAULT_WAIT_SECONDS;
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    const value = argv[at + 1];
    if (flag === '--') continue;
    if (flag === '--to' && value !== undefined) {
      to = value;
      at += 1;
    } else if (flag === '--text' && value !== undefined) {
      text = value;
      at += 1;
    } else if (flag === '--wait' && value !== undefined) {
      waitSeconds = Number(value);
      at += 1;
    } else {
      return `Unknown or unfinished option. ${USAGE}`;
    }
  }
  if (to === undefined || !E164.test(to)) {
    return `--to is required, as a number in international form with its plus (for example +233244000111). ${USAGE}`;
  }
  if (text.length < 1 || text.length > 160 || !/^[\x20-\x7e]+$/.test(text)) {
    return '--text is 1 to 160 characters of plain letters, digits and punctuation, so that it travels as one message.';
  }
  if (/https?:|www\.|\/\//i.test(text)) {
    return '--text carries no link: a business text never does.';
  }
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > MAX_WAIT_SECONDS) {
    return `--wait is a whole number of seconds from 0 to ${String(MAX_WAIT_SECONDS)}.`;
  }
  return { to, text, waitSeconds };
}

export async function runSmoke(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: SmokeIo,
): Promise<number> {
  const options = parseSmokeArguments(argv);
  if (typeof options === 'string') {
    io.out(options);
    return 2;
  }

  const loaded = loadWorkerConfig({ ...env }, { now: io.now() });
  if (!loaded.ok) {
    io.out(
      'The settings are refused, and nothing was sent. Fix these (the keys are in apps/api/.env and apps/api/.env.sms):',
    );
    for (const problem of loaded.problems) io.out(`  ${problem.key}: ${problem.problem}`);
    return 2;
  }
  const config = loaded.config;
  const sms = config.delivery.notificationSms;
  const window = config.delivery.providerWindow;
  if (sms.kind === 'capture') {
    io.out(
      'Mode: DRY RUN. The lane is on capture (NOTIFICATION_SMS_ADAPTER is not "provider"): the message is written to the capture folder and nothing leaves this machine.',
    );
  } else {
    io.out(
      `Mode: REAL. Hubtel, under the controlled window of ${window?.approvalRef ?? '(no approval)'}: ${String(window?.allowList.length ?? 0)} number(s) on the allow-list, at most ${String(window?.messageCap ?? 0)} message(s), ends ${window?.endsAt?.toISOString() ?? '(no end)'}.`,
    );
  }
  io.out(`To: ${destinationHint(options.to)}`);
  io.out(`Text: ${options.text}`);

  let sender: TextMessageSender;
  try {
    sender = io.composeSender(config);
  } catch (error) {
    io.out(
      `The sender could not be built (${error instanceof Error ? error.constructor.name : 'unknown'}), and nothing was sent.`,
    );
    return 2;
  }

  const outcome = await sender.send({
    dedupeId: io.newId(),
    destination: options.to,
    text: options.text,
  });
  if (outcome.outcome === 'REJECTED') {
    io.out(`Not sent. Refused: ${outcome.outcomeClass}.`);
    io.out(guidance(outcome.outcomeClass));
    return 1;
  }
  if (outcome.outcome === 'UNKNOWN') {
    io.out(
      'No answer that can be trusted (a time-out, a provider fault, or an unfunded account). The message may or may not have been taken: do not send it again blindly.',
    );
    return 1;
  }
  const reference = outcome.providerMessageRef;
  io.out(
    reference === null
      ? 'The provider took the message (it named none).'
      : `The provider took the message. Its reference: ${reference}`,
  );
  if (reference === null) return 0;

  const deadline = io.now().getTime() + options.waitSeconds * 1_000;
  let last = '';
  for (;;) {
    const status = await sender.status(reference);
    const word =
      status.state === 'FAILED'
        ? `FAILED (${status.outcomeClass ?? 'no reason given'})`
        : status.state;
    if (word !== last) {
      io.out(`Network: ${word}`);
      last = word;
    }
    if (status.state === 'DELIVERED') return 0;
    if (status.state === 'FAILED') return 1;
    if (io.now().getTime() + POLL_EVERY_MS > deadline) break;
    await io.sleep(POLL_EVERY_MS);
  }
  io.out(
    'The network has not said yet. The provider took the message; check your phone and the Hubtel dashboard.',
  );
  return 0;
}

/** What to do about a refusal, in words. */
function guidance(outcomeClass: string): string {
  switch (outcomeClass) {
    case 'DESTINATION_NOT_ALLOWED':
      return 'The number is not on DELIVERY_PROVIDER_ALLOWLIST. Add it (in the form +233XXXXXXXXX) to apps/api/.env.sms and run again.';
    case 'WINDOW_ENDED':
      return 'The window has ended (DELIVERY_PROVIDER_WINDOW_ENDS_AT). Open a new one with a new DELIVERY_PROVIDER_APPROVAL_REF.';
    case 'WINDOW_CAP':
      return 'The window has sent as many messages as DELIVERY_PROVIDER_MESSAGE_CAP allows. Open a new one with a new DELIVERY_PROVIDER_APPROVAL_REF.';
    case 'PROVIDER_AUTHENTICATION':
      return 'Hubtel does not accept the credentials (HUBTEL_SMS_CLIENT_ID and HUBTEL_SMS_CLIENT_SECRET in apps/api/.env.sms).';
    case 'REQUEST_INVALID':
      return 'Hubtel cannot take this number or text. Check the number, the sender ID (HUBTEL_SMS_SENDER_ID) and the text.';
    default:
      return 'Hubtel refused the message. Paste Hubtel’s Send SMS reference page so that the adapter can be matched to it.';
  }
}
