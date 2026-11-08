import type { Clock } from './platform/auth/ports/clock.port.js';
import type { TextMessageSender } from './platform/auth/ports/text-message-sender.port.js';
import type { WorkerConfig } from './platform/delivery/worker/worker-config.js';
import type { PrivacyProbe } from './platform/delivery/worker/outside-checkout.js';
import {
  CaptureTextMessageSender,
  FileTextCaptureSink,
} from './platform/notifications/capture.text-message-sender.adapter.js';
import { GuardedTextMessageSender } from './platform/notifications/guarded.text-message-sender.adapter.js';
import { HubtelSmsClient } from './platform/notifications/hubtel-sms-client.js';
import { HubtelTextMessageSender } from './platform/notifications/hubtel.text-message-sender.adapter.js';
import { FileWindowCounter } from './platform/notifications/window-counter.js';

/**
 * The composition of the notification lane's text-message sender (S1.12): the one file that binds the capture adapter, the Hubtel
 * adapter and the guards of the controlled window to the port, for the two processes that send (the delivery worker and the `sms:smoke`
 * command), so that the command the owner runs by hand is composed exactly as the worker is. It is on the architecture test's list of
 * composition-root files.
 */

/** The notification lane's sender cannot be built from this configuration. The message names the setting and never a value. */
export class NotificationSenderConfigurationError extends Error {
  constructor(readonly key: string) {
    super(`${key} is required to build the text-message sender of the notification lane.`);
    this.name = 'NotificationSenderConfigurationError';
  }
}

export interface NotificationSenderOptions {
  /** Where to look for the checkout the capture folder must stay out of: the working directory and the application's folder by default. */
  readonly startingPoints?: readonly string[];
  /** What the check that the capture folder is private reads of the file system: the real one by default. A test gives its own. */
  readonly privacyProbe?: PrivacyProbe;
  /** The transport of the Hubtel client; the platform's `fetch` by default. A test points it at the stand-in. */
  readonly fetch?: typeof fetch;
}

/**
 * The text-message sender of the notification lane (S1.12). Capture reaches nobody and writes each message to the capture folder; the
 * provider is Hubtel, and **outside production it stands behind the guards of the controlled window**: the end, the allow-list and the
 * cap, enforced before any provider call (DEPLOYMENT_AND_ENVIRONMENTS.md §4.1). In production there is no window and no guard to stand
 * behind: the configuration refuses one (`refusals` of the worker configuration).
 */
export function composeNotificationSender(
  config: WorkerConfig,
  clock: Clock,
  options: NotificationSenderOptions = {},
): TextMessageSender {
  const sms = config.delivery.notificationSms;
  const directory = config.delivery.captureDirectory;
  if (sms.kind === 'capture') {
    if (directory === undefined)
      throw new NotificationSenderConfigurationError('DELIVERY_CAPTURE_DIRECTORY');
    return new CaptureTextMessageSender({
      sink: new FileTextCaptureSink(directory, {
        ...(options.startingPoints === undefined ? {} : { startingPoints: options.startingPoints }),
        ...(options.privacyProbe === undefined ? {} : { privacyProbe: options.privacyProbe }),
      }),
      clock,
    });
  }
  const provider = new HubtelTextMessageSender(
    new HubtelSmsClient({
      endpoint: sms.endpoint,
      clientId: sms.hubtel.clientId,
      clientSecret: sms.hubtel.clientSecret,
      senderId: sms.hubtel.senderId,
      timeoutMs: sms.timeoutMs,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
  );
  const window = config.delivery.providerWindow;
  if (window === undefined) return provider;
  if (window.endsAt === undefined)
    throw new NotificationSenderConfigurationError('DELIVERY_PROVIDER_WINDOW_ENDS_AT');
  if (window.messageCap === undefined)
    throw new NotificationSenderConfigurationError('DELIVERY_PROVIDER_MESSAGE_CAP');
  if (directory === undefined)
    throw new NotificationSenderConfigurationError('DELIVERY_CAPTURE_DIRECTORY');
  return new GuardedTextMessageSender({
    inner: provider,
    clock,
    allowList: new Set(window.allowList),
    endsAt: window.endsAt,
    counter: new FileWindowCounter({
      directory,
      approvalRef: window.approvalRef,
      cap: window.messageCap,
    }),
  });
}
