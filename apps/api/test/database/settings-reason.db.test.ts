import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sql } from 'drizzle-orm';

import { RATE_LIMIT_BUCKETS } from '../../src/platform/auth/ports/rate-limiter.port.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import {
  IDENTITY_OPERATION_DOMAINS,
  REASON_BRANCHES,
  ReasonRefusedError,
  ReasonValidator,
  type ReasonBranch,
} from '../../src/platform/settings/reason-validator.js';
import {
  SettingInvalidError,
  SettingMissingError,
  SettingsReader,
} from '../../src/platform/settings/settings-reader.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { parseIdentityReasons } from '../../src/test-support/seed-documents.js';
import { SETTINGS } from '../../src/tools/seed/settings.js';
import { openAdmin, type Admin } from './support/admin.js';
import { withHandle } from './support/handle.js';
import {
  riderContext,
  staffContext,
  systemContext,
  vendorContext,
  HUB_A,
} from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.13 against a real PostgreSQL seeded the way the product seeds it: the typed settings reader and the reason validator, as
 * `melarc_api_runtime`. Security test matrix Family O (O5: a reason of the wrong domain on each identity operation's list is
 * refused; a branch-qualified reason on the other branch is `REASON_NOT_ACTIVE`); settings.md; domain-model.md §3.9.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
const DOMAIN_MODEL = readFileSync(resolve(ROOT, 'contracts/domain-model.md'), 'utf8').replaceAll(
  '\r',
  '',
);

const STAFF = staffContext([HUB_A]);
const settings = new SettingsReader();
const validator = new ReasonValidator();

let database: TestDatabase;
let built: BuiltService;
let admin: Admin;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database, { fixtures: true });
  built = buildService(database);
  admin = await openAdmin(database);
});

afterAll(async () => {
  await admin.close();
  await built.close();
  await database.drop();
});

const asStaff = <T>(
  work: (handle: Parameters<Parameters<typeof withHandle>[2]>[0]) => Promise<T>,
) => withHandle(built.service, STAFF, (handle) => work(handle));

describe('the settings reader', () => {
  // Break caught: a seeded value read back differently from what the document approved, or in the wrong type.
  it('reads every seeded setting back in its declared type, equal to the seed', async () => {
    await asStaff(async (handle) => {
      for (const seeded of SETTINGS) {
        const read = await settings.get(handle, seeded.key);
        expect(read.value, seeded.key).toEqual(seeded.value);
        expect(read.type, seeded.key).toBe(seeded.valueType);
        expect(read.scope, seeded.key).toBe(seeded.scope);
        expect(read.unit, seeded.key).toBe(seeded.unit);
      }
    });
  });

  // Break caught: the typed getters returning another type, and the launch values of the six buckets (settings.md section 7.7).
  it('gives the typed value of the six rate-limit buckets as the contract states them', async () => {
    await asStaff(async (handle) => {
      expect(await settings.integer(handle, 'rate_limit_staff_signin')).toBe(10);
      expect(await settings.integer(handle, 'rate_limit_privileged_mfa')).toBe(10);
      expect(await settings.integer(handle, 'rate_limit_vendor_signin')).toBe(10);
      expect(await settings.integer(handle, 'rate_limit_rider_challenge')).toBe(20);
      expect(await settings.integer(handle, 'rate_limit_recovery')).toBe(10);
      expect(await settings.integer(handle, 'rate_limit_authenticated_api')).toBe(120);
      expect(await settings.integer(handle, 'idempotency_record_ttl_hours')).toBe(24);
    });
  });

  // Break caught: a missing key answered with a default, a neighbour's value or a guess (the contract: it never borrows).
  it('says SETTING_MISSING for a key with no row, and for the keys the documents leave open', async () => {
    await asStaff(async (handle) => {
      for (const key of [
        'no_such_setting',
        'evidence_upload_max_mb',
        'rate_limit_seventh_bucket',
      ]) {
        const error = await settings.get(handle, key).catch((caught: unknown) => caught);
        expect(error, key).toBeInstanceOf(SettingMissingError);
        expect((error as SettingMissingError).code).toBe('SETTING_MISSING');
      }
    });
  });

  // Break caught: the reader reading what the context may not see and answering it with a value.
  it('sees nothing in a vendor or a rider context, and so reads every key as missing', async () => {
    for (const context of [
      vendorContext('a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'),
      riderContext('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'),
    ]) {
      const error = await withHandle(built.service, context, (handle) =>
        settings.integer(handle, 'rate_limit_staff_signin'),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SettingMissingError);
    }
    // And the authentication capability, which the registry lets read the table, does.
    expect(
      await withHandle(built.service, systemContext('authentication'), (handle) =>
        settings.integer(handle, 'rate_limit_staff_signin'),
      ),
    ).toBe(10);
  });

  // Break caught (section 11.B of the Gate 2 brief; OB-102): the limiter's capability reading more than its six settings (a policy on
  // the table as a whole), or writing any. It reads each bucket's limit, sees no other row, and cannot insert, update or delete.
  it('lets the rate_limit capability read the six bucket settings and no other row, and write none', async () => {
    const limiterContext = systemContext('rate_limit');
    for (const bucket of RATE_LIMIT_BUCKETS) {
      expect(
        await withHandle(built.service, limiterContext, (handle) =>
          settings.integer(handle, bucket),
        ),
        bucket,
      ).toBeGreaterThan(0);
    }
    const visible = await withHandle(built.service, limiterContext, async (_handle, tx) =>
      (await tx.execute(sql`select key from setting order by key`)).rows.map(
        (row) => (row as { key: string }).key,
      ),
    );
    expect(visible).toEqual([...RATE_LIMIT_BUCKETS].toSorted());
    // The names in the policy are the buckets' (a seventh bucket, or a renamed one, is a change to both).
    const policy = /"setting_rate_limit_read"[\s\S]*?key IN \(([^)]*)\)/.exec(
      readFileSync(
        resolve(import.meta.dirname, '../../migrations/0012_rate_limit_hardening.sql'),
        'utf8',
      ),
    );
    expect(
      (policy?.[1] ?? '')
        .split(',')
        .map((name) => name.trim().replaceAll("'", ''))
        .toSorted(),
    ).toEqual([...RATE_LIMIT_BUCKETS].toSorted());
    // A setting the capability has no business with reads as missing, as for a vendor.
    for (const other of [
      'signin_max_attempts',
      'mfa_max_attempts',
      'report_export_initiation_ceiling_per_minute',
    ]) {
      const error = await withHandle(built.service, limiterContext, (handle) =>
        settings.integer(handle, other),
      ).catch((caught: unknown) => caught);
      expect(error, other).toBeInstanceOf(SettingMissingError);
    }
    // And it writes nothing: the runtime login holds no privilege to, whatever the policy says.
    const write = async (statement: ReturnType<typeof sql>): Promise<string> => {
      try {
        await withHandle(built.service, limiterContext, (_handle, tx) => tx.execute(statement));
        return 'allowed';
      } catch (error) {
        return serverErrorIn(error)?.code ?? String(error);
      }
    };
    expect(
      await write(sql`update setting set value = '1'::jsonb where key = 'rate_limit_staff_signin'`),
    ).toBe('42501');
    expect(await write(sql`delete from setting where key = 'rate_limit_staff_signin'`)).toBe(
      '42501',
    );
    expect(
      await write(
        sql`insert into setting (key, scope, value_type, value, unit, description) values ('rate_limit_seventh', 'PLATFORM', 'integer', '1'::jsonb, 'requests', 'x')`,
      ),
    ).toBe('42501');
  });

  // Break caught: a stored value that does not fit its declared type being passed on, and a request for the wrong type succeeding.
  it('says SETTING_INVALID for a stored value of the wrong type and for the wrong type asked for', async () => {
    await admin.query(
      "insert into setting (key, scope, value_type, value, unit, description) values ('corrupt_setting', 'PLATFORM', 'integer', '\"ten\"', 'attempts', 'A corrupt row made for the test')",
    );
    await asStaff(async (handle) => {
      const corrupt = await settings
        .integer(handle, 'corrupt_setting')
        .catch((caught: unknown) => caught);
      expect(corrupt).toBeInstanceOf(SettingInvalidError);
      expect((corrupt as SettingInvalidError).code).toBe('SETTING_INVALID');
      expect((corrupt as Error).message).not.toContain('ten');

      const wrongType = await settings
        .string(handle, 'rate_limit_staff_signin')
        .catch((caught: unknown) => caught);
      expect(wrongType).toBeInstanceOf(SettingInvalidError);
    });
  });

  // Break caught: a key that is not a plain name reaching the query.
  it('refuses a key that is not a plain name before it reads', async () => {
    await asStaff(async (handle) => {
      for (const key of ['', 'a b', "a'; drop table setting; --", '1a', 'a-b']) {
        await expect(settings.get(handle, key), key).rejects.toThrow(TypeError);
      }
    });
  });
});

describe('the reason validator, per refusal', () => {
  const validate = (
    reasonCode: unknown,
    operationId: string,
    extra: { branch?: ReasonBranch; note?: string | null } = {},
    context: SecurityContext = STAFF,
  ) =>
    withHandle(built.service, context, (handle) =>
      validator.validate(handle, { reasonCode, operationId, ...extra }),
    );

  const refusedWith = async (work: Promise<unknown>): Promise<string> => {
    try {
      await work;
      return 'accepted';
    } catch (error) {
      return error instanceof ReasonRefusedError ? error.code : `other: ${String(error)}`;
    }
  };

  // Break caught: an empty reason answered as an unknown one.
  it('says REASON_REQUIRED when no reason is given', async () => {
    for (const reasonCode of [undefined, null, '', '  ']) {
      expect(await refusedWith(validate(reasonCode, 'revokeSession')), String(reasonCode)).toBe(
        'REASON_REQUIRED',
      );
    }
  });

  // Break caught: an unknown or retired reason accepted.
  it('says REASON_NOT_ACTIVE for an unknown reason and for a retired one', async () => {
    expect(await refusedWith(validate('NO_SUCH_REASON', 'revokeSession'))).toBe(
      'REASON_NOT_ACTIVE',
    );
    expect(await refusedWith(validate('FIXTURE_REASON_INACTIVE', 'revokeSession'))).toBe(
      'REASON_NOT_ACTIVE',
    );
  });

  // Break caught: a reason that no real operation permits accepted for a real one.
  it('says REASON_NOT_ACTIVE for a reason that permits only another operation', async () => {
    expect(await refusedWith(validate('FIXTURE_REASON_OTHER_OPERATION', 'revokeSession'))).toBe(
      'REASON_NOT_ACTIVE',
    );
  });

  // Break caught: a vendor, rider or other context validating a reason it cannot read (the catalogue reads as empty to it).
  it('treats a context that cannot read the catalogue as having no reason to find', async () => {
    expect(
      await refusedWith(
        validate(
          'SESSION_SECURITY_CONCERN',
          'revokeSession',
          {},
          vendorContext('a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'),
        ),
      ),
    ).toBe('REASON_NOT_ACTIVE');
    expect(await refusedWith(validate('SESSION_SECURITY_CONCERN', 'revokeSession'))).toBe(
      'accepted',
    );
    expect(
      await refusedWith(
        validate('SESSION_SECURITY_CONCERN', 'revokeSession', {}, systemContext('authentication')),
      ),
    ).toBe('accepted');
  });

  // Break caught: an accepted reason not carrying the label the audit event snapshots.
  it('returns the code and label of an accepted reason for the audit event to snapshot', async () => {
    const reason = await validate('RIDER_HANDSET_UNAVAILABLE', 'reregisterRiderDevice');

    expect(reason).toMatchObject({
      code: 'RIDER_HANDSET_UNAVAILABLE',
      domain: 'RIDER_DEVICE_REPLACEMENT',
      label: 'Rider handset lost or unusable',
      attribution: 'MELARC',
      requiresNote: false,
    });
  });

  // Break caught: a reason that requires a note, with no note, accepted (§35.9.2). Shown on a row made for the test.
  it('says REASON_REQUIRED when the reason requires a note and none is given', async () => {
    await admin.query(
      "update reason_code set requires_note = true where code = 'SESSION_ACCESS_NO_LONGER_REQUIRED'",
    );
    try {
      expect(
        await refusedWith(validate('SESSION_ACCESS_NO_LONGER_REQUIRED', 'revokeSession')),
      ).toBe('REASON_REQUIRED');
      expect(
        await refusedWith(
          validate('SESSION_ACCESS_NO_LONGER_REQUIRED', 'revokeSession', {
            note: 'Left the company.',
          }),
        ),
      ).toBe('accepted');
    } finally {
      await admin.query(
        "update reason_code set requires_note = false where code = 'SESSION_ACCESS_NO_LONGER_REQUIRED'",
      );
    }
  });
});

describe('every identity reason against every identity operation (Family O5)', () => {
  const documented = parseIdentityReasons(DOMAIN_MODEL);

  // Break caught: the table of operations and domains in the code drifting from the document that owns it.
  it('uses the operations and domains the document states', () => {
    const fromDocument: Record<string, string> = {};
    for (const match of DOMAIN_MODEL.matchAll(/^\| `([A-Z][A-Z_]+)`\| ([^|]+)\|$/gm)) {
      const domain = match[1] ?? '';
      // "approveStaffIdentity with approved: false": the operation is the name before " with ".
      const taken = (match[2] ?? '').split(' with ')[0] ?? '';
      for (const operation of taken.matchAll(/`([a-z][A-Za-z]+)`/g)) {
        fromDocument[operation[1] ?? ''] = domain;
      }
    }
    const identityOnly = Object.fromEntries(
      Object.entries(fromDocument).filter(([, domain]) =>
        Object.values(IDENTITY_OPERATION_DOMAINS).includes(domain),
      ),
    );

    expect(IDENTITY_OPERATION_DOMAINS).toEqual(identityOnly);
    expect(documented).toHaveLength(12);
  });

  // Break caught: any reason accepted for an operation (or a branch of it) that the document's list for it does not name.
  it('accepts a reason exactly when the document’s list names the operation on that branch, and refuses it otherwise', async () => {
    const branches: (ReasonBranch | undefined)[] = [undefined, ...REASON_BRANCHES];
    let accepted = 0;
    let refused = 0;
    for (const reason of documented) {
      for (const operationId of Object.keys(IDENTITY_OPERATION_DOMAINS)) {
        for (const branch of branches) {
          const sameDomain = IDENTITY_OPERATION_DOMAINS[operationId] === reason.domain;
          const listed = reason.permittedOperations.some(
            (entry) =>
              entry === operationId ||
              (branch !== undefined && entry === `${operationId}#${branch}`),
          );
          const expected = sameDomain && listed ? 'accepted' : 'REASON_NOT_ACTIVE';
          const result = await withHandle(built.service, STAFF, async (handle) => {
            try {
              await validator.validate(handle, {
                reasonCode: reason.code,
                operationId,
                ...(branch === undefined ? {} : { branch }),
              });
              return 'accepted';
            } catch (error) {
              return error instanceof ReasonRefusedError ? error.code : `other: ${String(error)}`;
            }
          });
          expect(result, `${reason.code} on ${operationId} ${branch ?? '(no branch)'}`).toBe(
            expected,
          );
          if (expected === 'accepted') accepted += 1;
          else refused += 1;
        }
      }
    }
    // The three qualified reasons are accepted on their own branch only, and the others on every branch of their operations.
    expect(accepted).toBeGreaterThan(12);
    expect(refused).toBeGreaterThan(accepted);
  });

  // Break caught: a branch-qualified reason accepted on the other branch of its operation (the heart of O5).
  it('refuses a branch-qualified reason on the other branch', async () => {
    const attempt = (reasonCode: string, operationId: string, branch: ReasonBranch) =>
      withHandle(built.service, STAFF, async (handle) => {
        try {
          await validator.validate(handle, { reasonCode, operationId, branch });
          return 'accepted';
        } catch (error) {
          return error instanceof ReasonRefusedError ? error.code : String(error);
        }
      });

    expect(await attempt('MFA_AUTHENTICATOR_UNAVAILABLE', 'resetStaffMfa', 'FACTOR_ACTIVE')).toBe(
      'accepted',
    );
    expect(
      await attempt('MFA_AUTHENTICATOR_UNAVAILABLE', 'resetStaffMfa', 'ENROLMENT_UNFINISHED'),
    ).toBe('REASON_NOT_ACTIVE');
    expect(await attempt('MFA_ENROLMENT_EXPIRED', 'resetStaffMfa', 'ENROLMENT_UNFINISHED')).toBe(
      'accepted',
    );
    expect(await attempt('MFA_ENROLMENT_EXPIRED', 'resetStaffMfa', 'FACTOR_ACTIVE')).toBe(
      'REASON_NOT_ACTIVE',
    );
    expect(
      await attempt('STAFF_DETAILS_INCORRECT', 'approveStaffIdentity', 'APPROVAL_REJECTED'),
    ).toBe('accepted');
    expect(await attempt('STAFF_DETAILS_INCORRECT', 'approveStaffIdentity', 'FACTOR_ACTIVE')).toBe(
      'REASON_NOT_ACTIVE',
    );
  });
});
