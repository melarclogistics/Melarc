import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CONTINUATION_PURPOSE,
  CONTINUED_FROM_PURPOSES,
  EPISODE_PURPOSES,
  FACTOR_ACTIVATING_PURPOSE,
  FACTOR_CREATING_PURPOSES,
  GRANT_PRINCIPAL_TYPES,
  GRANT_TOKEN_HASH_BYTES,
  MESSAGE_PURPOSES,
  NO_EXPIRY_PURPOSE,
  PURPOSES_OF_PRINCIPAL,
  RIDER_DEVICE_PURPOSES,
  SETUP_GRANT_LIFETIME_SETTING,
  SETUP_GRANT_PURPOSES,
  SETUP_GRANT_STATES,
  TERMINAL_GRANT_STATES,
  isMessagePurpose,
} from './setup-grant-vocabulary.js';

const read = (path: string): string =>
  readFileSync(resolve(import.meta.dirname, '../../../../../../', path), 'utf8').replaceAll(
    '\r',
    '',
  );
const DOMAIN_MODEL = read('contracts/domain-model.md');
const STATE_MACHINES = read('contracts/state-machines.md');

/**
 * The backticked words of the notes cell of the row `| \`field\`|` that follows `heading`: the row of an entity table that states a
 * closed set. The heading scopes the search, because `purpose` is also a field of the sign-in challenges.
 */
const wordsOfRow = (document: string, heading: string, field: string): string[] => {
  const lines = document.split('\n');
  const start = lines.findIndex((line) => line.startsWith(heading));
  const row = lines.slice(start + 1).find((line) => line.startsWith(`| \`${field}\`|`));
  if (start < 0 || row === undefined) throw new Error(`no row for ${field} under ${heading}`);
  const notes = row.split('|')[4] ?? '';
  return (notes.match(/`[A-Z_]+`/g) ?? []).map((word) => word.slice(1, -1));
};

describe('the vocabulary of a setup grant (domain-model.md §6.8, state-machines.md §19)', () => {
  // Break caught: the list drifting from the document, a purpose added or dropped in one place and not the other. The table repeats
  // the list as a CHECK and `setup-grant-schema.db.test.ts` holds the table to it.
  it('has the eight purposes of the SetupGrant record, in its order', () => {
    const documented = wordsOfRow(DOMAIN_MODEL, '#### `SetupGrant`', 'purpose');

    expect(documented).toHaveLength(8);
    expect([...SETUP_GRANT_PURPOSES]).toEqual(documented);
    // `VENDOR_CREDENTIAL_RECOVERY` was withdrawn from this enum (domain-model.md §6.8, R1.3).
    expect(SETUP_GRANT_PURPOSES).not.toContain('VENDOR_CREDENTIAL_RECOVERY');
  });

  it('has the four states, three of them terminal, as state-machines.md §19 says', () => {
    expect([...SETUP_GRANT_STATES]).toEqual(['PENDING', 'CONSUMED', 'EXPIRED', 'SUPERSEDED']);
    expect([...TERMINAL_GRANT_STATES]).toEqual(['CONSUMED', 'EXPIRED', 'SUPERSEDED']);
    expect(STATE_MACHINES).toMatch(
      /States: `PENDING` · `CONSUMED` · `EXPIRED` · `SUPERSEDED`\. Terminal: `CONSUMED`, `EXPIRED`, `SUPERSEDED`\./,
    );
  });

  // Break caught: a purpose granted to the wrong principal type, which the principal-bound grant could then be presented for.
  it('gives each purpose to exactly one kind of principal, and every purpose to one', () => {
    expect([...GRANT_PRINCIPAL_TYPES]).toEqual(['STAFF', 'RIDER', 'VENDOR']);
    const owned = GRANT_PRINCIPAL_TYPES.flatMap((type) => PURPOSES_OF_PRINCIPAL[type]);
    expect(owned.toSorted()).toEqual([...SETUP_GRANT_PURPOSES].toSorted());
    expect(PURPOSES_OF_PRINCIPAL.STAFF).toEqual([
      'STAFF_CREDENTIAL_SETUP',
      'MFA_ENROLMENT',
      'MFA_REENROLMENT',
      'BOOTSTRAP_SETUP',
    ]);
    expect(PURPOSES_OF_PRINCIPAL.RIDER).toEqual([
      'RIDER_DEVICE_ENROLMENT',
      'RIDER_DEVICE_REREGISTRATION',
    ]);
    expect(PURPOSES_OF_PRINCIPAL.VENDOR).toEqual([
      'VENDOR_CREDENTIAL_SETUP',
      'VENDOR_DEVICE_ENROLMENT',
    ]);
  });

  // Break caught (§6.8 "Null only for BOOTSTRAP_SETUP"): a second purpose without an expiry, which would be a standing key.
  it('has one purpose with no expiry, the bootstrap secret, and its lifetime is the recovery link’s', () => {
    expect(NO_EXPIRY_PURPOSE).toBe('BOOTSTRAP_SETUP');
    expect(SETUP_GRANT_LIFETIME_SETTING).toBe('recovery_link_ttl_minutes');
    expect(DOMAIN_MODEL).toMatch(/\*\*Null only for `BOOTSTRAP_SETUP`\*\*/);
  });

  // Break caught (state-machines.md §18): a fourth purpose that creates a factor, or a second that activates one. BOOTSTRAP_SETUP never
  // activates, because it alone has no expiry.
  it('has three purposes that create a factor and one that activates it', () => {
    expect([...FACTOR_CREATING_PURPOSES]).toEqual([
      'STAFF_CREDENTIAL_SETUP',
      'BOOTSTRAP_SETUP',
      'MFA_REENROLMENT',
    ]);
    expect(FACTOR_ACTIVATING_PURPOSE).toBe('MFA_ENROLMENT');
    expect(FACTOR_CREATING_PURPOSES).not.toContain(FACTOR_ACTIVATING_PURPOSE);
    expect(STATE_MACHINES).toMatch(/\*\*Three creating purposes, one activating purpose\.\*\*/);
  });

  it('has a continuation that follows the three creating purposes and is itself the activating grant', () => {
    expect(CONTINUATION_PURPOSE).toBe(FACTOR_ACTIVATING_PURPOSE);
    expect([...CONTINUED_FROM_PURPOSES].toSorted()).toEqual(
      [...FACTOR_CREATING_PURPOSES].toSorted(),
    );
  });

  it('carries a reset episode on the two MFA purposes and an attestation challenge on the two rider device purposes', () => {
    expect([...EPISODE_PURPOSES]).toEqual(['MFA_REENROLMENT', 'MFA_ENROLMENT']);
    expect([...RIDER_DEVICE_PURPOSES]).toEqual([
      'RIDER_DEVICE_ENROLMENT',
      'RIDER_DEVICE_REREGISTRATION',
    ]);
    expect(PURPOSES_OF_PRINCIPAL.RIDER).toEqual([...RIDER_DEVICE_PURPOSES]);
  });

  // Break caught (SECURITY_DESIGN.md §13.9a: "four grants do not travel as messages and never enter this port"): the bootstrap secret,
  // the continuation and the two rider grants queued for delivery, which would put a credential the design hands over some other way
  // into a job and a provider.
  it('lets four purposes travel as a message and four never do', () => {
    expect([...MESSAGE_PURPOSES].toSorted()).toEqual([
      'MFA_REENROLMENT',
      'STAFF_CREDENTIAL_SETUP',
      'VENDOR_CREDENTIAL_SETUP',
      'VENDOR_DEVICE_ENROLMENT',
    ]);
    for (const purpose of SETUP_GRANT_PURPOSES) {
      expect(isMessagePurpose(purpose), purpose).toBe(
        (MESSAGE_PURPOSES as readonly string[]).includes(purpose),
      );
    }
    for (const purpose of ['BOOTSTRAP_SETUP', 'MFA_ENROLMENT', ...RIDER_DEVICE_PURPOSES]) {
      expect(isMessagePurpose(purpose), purpose).toBe(false);
    }
    expect(isMessagePurpose('anything')).toBe(false);
    expect(isMessagePurpose(undefined)).toBe(false);
  });

  it('stores a token as its SHA-256, 32 bytes', () => {
    expect(GRANT_TOKEN_HASH_BYTES).toBe(32);
  });
});
