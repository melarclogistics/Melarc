import type { LanePolicy } from './notification-lane.js';
import type { SendLimits } from './notification-store.js';
import { isApproved } from './templates.js';

/**
 * What the lane asks before it reads a destination or asks a provider, and the day's limits it counts against (S1.12b, S1.12e;
 * PROJECT_MASTER_SPECIFICATION.md §31.1: SMS is "soft-fail and kill-switchable for selected events"; the Product Owner's decisions of
 * 29 October 2026: the pilot limits, the approval of the wording before any real send).
 *
 * **Three reasons to hold a message back before it is sent**, in this order: the global switch is off; the switch of this kind of message
 * is off; and, when the provider is a real one, the wording of the message has not been approved by the Product Owner (OQ-037). The
 * capture adapter reaches nobody, so unapproved words are sent to it freely: that is how a developer sees them.
 *
 * The settings are read through a port of their own (`NotificationSettings`), so that this file knows no table: the lane's reader of the
 * platform settings implements it (S1.12e), and a test gives its own.
 */
export interface NotificationSettings {
  /** The global kill switch of text messages: false holds every text back. */
  readonly smsEnabled: () => Promise<boolean>;
  /** The kinds of message whose own switch is off. */
  readonly disabledKinds: () => Promise<ReadonlySet<string>>;
  /** The day's limits, or null where one is not applied. */
  readonly limits: () => Promise<SendLimits>;
}

/** Everything on, nothing limited: for a lane whose sender reaches nobody and whose settings are not yet read from the database. */
export const OPEN_SETTINGS: NotificationSettings = {
  smsEnabled: () => Promise.resolve(true),
  disabledKinds: () => Promise.resolve(new Set<string>()),
  limits: () => Promise.resolve({ perNumberPerDay: null, perDay: null }),
};

export interface LanePolicyOptions {
  /** Whether the sender is a real provider: the wording must then be approved. */
  readonly realProvider: boolean;
  readonly settings: NotificationSettings;
}

export function createLanePolicy(options: LanePolicyOptions): LanePolicy {
  const { realProvider, settings } = options;
  return {
    withhold: async ({ kind, template }) => {
      if (!(await settings.smsEnabled())) return 'KILL_SWITCH';
      if ((await settings.disabledKinds()).has(kind)) return 'KILL_SWITCH';
      if (realProvider && !isApproved(template)) return 'WORDING_NOT_APPROVED';
      return null;
    },
    limits: () => settings.limits(),
  };
}
