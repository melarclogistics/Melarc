import type { Secret } from '../config/secret.js';

/**
 * What the notification lane's text-message channel is built from, and the rules its controlled window keeps (S1.12; the Product
 * Owner's decisions of 29 October 2026). The lane sends business SMS through Hubtel. A real provider belongs to Staging and production,
 * and to a local run only inside a controlled window (DEPLOYMENT_AND_ENVIRONMENTS.md §4.1), which amends the decision of 11 October
 * 2026 that a local run uses the capture adapter only: an approval reference, an allow-list of numbers the owner controls, the most
 * messages the window may send and the moment it ends. The credential channels keep the earlier rule.
 *
 * Pure values and pure judgements: nothing here reads the environment, the clock or a file.
 */

/**
 * The longest a controlled window may stay open from the moment the worker starts. A validation window is days of work with a few
 * numbers the owner controls, never a standing configuration: a window that cannot end soon is a provider in disguise.
 */
export const PROVIDER_WINDOW_MAX_DAYS = 14;

/** A sender ID Hubtel can show beside a message: 3 to 11 letters or digits. */
export const SENDER_ID_PATTERN = /^[A-Za-z0-9]{3,11}$/;

/** An instant in UTC as the settings write it: the date, the time, optional milliseconds and the Z. Never an offset: it moves with a zone. */
export const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** The detail a real provider is built from: Hubtel's credentials (secrets, never printed) and the sender ID. */
export interface HubtelSettings {
  readonly clientId: Secret;
  readonly clientSecret: Secret;
  readonly senderId: string;
}

/** How the lane sends its text messages: into a capture sink, or through Hubtel. */
export type NotificationSmsConfig =
  | { readonly kind: 'capture' }
  | {
      readonly kind: 'provider';
      /** The messages resource of the provider: the send is `POST {endpoint}/send`, the status `GET {endpoint}/{messageId}`. */
      readonly endpoint: string;
      readonly timeoutMs: number;
      readonly hubtel: HubtelSettings;
    };

/** The controlled real-provider window, as far as the settings say. The credential channels take the first two; the lane takes all four. */
export interface ProviderWindowConfig {
  readonly approvalRef: string;
  readonly allowList: readonly string[];
  /** The most messages the window may send in total. */
  readonly messageCap?: number;
  /** The moment the window ends: no message is sent at or after it. */
  readonly endsAt?: Date;
}

/** Why the end of a window is refused at the start of the worker. */
export type WindowEndRefusal = 'NOT_AFTER_NOW' | 'TOO_FAR';

const DAY_MS = 86_400_000;

/**
 * Judges the end of a window against the moment the worker starts: it must lie after it, and no later than the controlled fortnight.
 * An unreadable date is not after anything.
 */
export function windowEndRefusal(endsAt: Date, now: Date): WindowEndRefusal | undefined {
  if (!(endsAt.getTime() > now.getTime())) return 'NOT_AFTER_NOW';
  if (endsAt.getTime() > now.getTime() + PROVIDER_WINDOW_MAX_DAYS * DAY_MS) return 'TOO_FAR';
  return undefined;
}
