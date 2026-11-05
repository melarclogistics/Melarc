import { sql } from 'drizzle-orm';

import type { Clock } from '../auth/ports/clock.port.js';
import { randomUUIDv7 } from '../auth/crypto/uuid-v7.js';
import type { DatabaseService } from '../database/database.service.js';
import type { SecurityContext } from '../database/transaction-context.js';
import type { NotificationSettings } from './lane-policy.js';
import { NOTIFICATION_LANE_PRINCIPAL_ID, type SendLimits } from './notification-store.js';

/**
 * What the notification lane reads of the platform settings (S1.12e; settings.md section 7.8; the Product Owner's pilot figures of
 * 29 October 2026): the global switch of the business texts and the two limits of a day. **Three keys and no other**: the lane's
 * capability reads exactly these rows of the `setting` table (migration 0056), by a policy that names them, and the grant is
 * the two columns that say what the setting is.
 *
 * **Missing or invalid fails safe, and visibly** (settings.md section 8; section 33.3): a switch that is not a boolean holds every text
 * back (the message is shown `SUPPRESSED` in the Ops log, and the unusable key is named in the log, never its value); a limit that is not
 * a whole number of at least zero is read as zero, which holds the text back as a limit reached. A setting that cannot be read is
 * never read as "no limit" or "on": sending is the act that costs money and reaches a person.
 *
 * **Read often, changed rarely**: the lane asks for these on every message, so the three values are kept for a short time
 * (`SETTINGS_CACHE_MS`). A change by a Platform Admin takes effect within that time, in every process.
 */
export const SMS_SETTING_KEYS = Object.freeze({
  enabled: 'sms_enabled',
  perNumberPerDay: 'sms_per_number_daily_limit',
  perDay: 'sms_daily_limit',
});

/** How long a read of the three settings is kept. */
export const SETTINGS_CACHE_MS = 10_000;

export interface SettingsReader {
  /** The value of each key that exists, as the database holds it (JSON); a key that does not exist is absent. */
  readonly read: (keys: readonly string[]) => Promise<ReadonlyMap<string, unknown>>;
}

/** Reads settings as the lane: `SYSTEM` under `notification`, in a read transaction of its own. */
export class DatabaseSettingsReader implements SettingsReader {
  readonly #database: DatabaseService;
  readonly #clock: Clock;

  constructor(options: { readonly database: DatabaseService; readonly clock: Clock }) {
    this.#database = options.database;
    this.#clock = options.clock;
  }

  readonly read = async (keys: readonly string[]): Promise<ReadonlyMap<string, unknown>> => {
    const context: SecurityContext = {
      principalType: 'SYSTEM',
      principalId: NOTIFICATION_LANE_PRINCIPAL_ID,
      surface: 'SYSTEM',
      taskCapability: 'notification',
      correlationId: randomUUIDv7(this.#clock),
    };
    return this.#database.transactionWithContext(context, async (tx) => {
      const found = await tx.execute(
        sql`select key, value from setting where key in (${sql.join(
          keys.map((key) => sql`${key}`),
          sql`, `,
        )})`,
      );
      return new Map(
        (found.rows as unknown as { key: string; value: unknown }[]).map((row) => [
          row.key,
          row.value,
        ]),
      );
    });
  };
}

export interface DatabaseNotificationSettingsOptions {
  readonly reader: SettingsReader;
  readonly clock: Pick<Clock, 'now'>;
  /** Told, by key, that a setting could not be used. Never given a value. */
  readonly onUnusable?: (key: string) => void;
  readonly cacheMs?: number;
}

const isWholeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

export class DatabaseNotificationSettings implements NotificationSettings {
  readonly #options: DatabaseNotificationSettingsOptions;
  #kept: { readonly at: number; readonly values: ReadonlyMap<string, unknown> } | undefined;

  constructor(options: DatabaseNotificationSettingsOptions) {
    this.#options = options;
  }

  async #values(): Promise<ReadonlyMap<string, unknown>> {
    const now = this.#options.clock.now().getTime();
    const kept = this.#kept;
    // A clock that stepped backwards since the read (a correction of the host's time) does not keep a value for as long as the step: a
    // switch the owner turned Off must not stay On because the time went back.
    if (
      kept !== undefined &&
      now >= kept.at &&
      now - kept.at < (this.#options.cacheMs ?? SETTINGS_CACHE_MS)
    ) {
      return kept.values;
    }
    const values = await this.#options.reader.read(Object.values(SMS_SETTING_KEYS));
    this.#kept = { at: now, values };
    return values;
  }

  readonly smsEnabled = async (): Promise<boolean> => {
    const value = (await this.#values()).get(SMS_SETTING_KEYS.enabled);
    if (typeof value === 'boolean') return value;
    this.#options.onUnusable?.(SMS_SETTING_KEYS.enabled);
    return false;
  };

  /** The per-kind switches are the hub settings of the messages that have them; none of those messages is wired yet. */
  readonly disabledKinds = (): Promise<ReadonlySet<string>> => Promise.resolve(new Set<string>());

  readonly limits = async (): Promise<SendLimits> => {
    const values = await this.#values();
    const limit = (key: string): number => {
      const value = values.get(key);
      if (isWholeNumber(value)) return value;
      this.#options.onUnusable?.(key);
      return 0;
    };
    return {
      perNumberPerDay: limit(SMS_SETTING_KEYS.perNumberPerDay),
      perDay: limit(SMS_SETTING_KEYS.perDay),
    };
  };
}
