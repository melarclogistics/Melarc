import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import {
  RECOVERY_REQUEST_LIMIT,
  RECOVERY_REQUEST_LIMIT_NAMESPACE,
  recoveryPrincipalPartition,
} from './recovery-request-limit.js';

const keyOf = async (body: unknown): Promise<string | undefined> => {
  const identifier = (body as { identifier?: unknown } | null)?.identifier;
  const canonical =
    typeof identifier === 'string' ? RECOVERY_REQUEST_LIMIT.canonical(identifier) : undefined;
  return canonical === undefined
    ? undefined
    : recoveryPrincipalPartition({ body } as Request, canonical);
};

describe('the key of a recovery request in the recovery bucket (AC-SLICE-000-104)', () => {
  // Break caught: a key that varies with how the identifier was typed, so that changing its case or padding buys another ten requests.
  it('is the identifier in its type’s canonical form, however it was typed', async () => {
    const staff = await keyOf({ principal_type: 'STAFF', identifier: 'ama@example.test' });
    expect(staff).toBe(`${RECOVERY_REQUEST_LIMIT_NAMESPACE}\u0000STAFF\u0000ama@example.test`);
    expect(await keyOf({ principal_type: 'STAFF', identifier: '  AMA@Example.TEST ' })).toBe(staff);
    // A compatibility form is the character it stands for (NFKC), as the work email's canonical form is.
    expect(await keyOf({ principal_type: 'STAFF', identifier: 'ａma@example.test' })).toBe(staff);

    const vendor = await keyOf({ principal_type: 'VENDOR', identifier: 'abcd2345efgh6789' });
    expect(vendor).toBe(`${RECOVERY_REQUEST_LIMIT_NAMESPACE}\u0000VENDOR\u0000ABCD2345EFGH6789`);
    expect(await keyOf({ principal_type: 'VENDOR', identifier: ' ABCD2345efgh6789' })).toBe(vendor);
  });

  // Break caught: the principal type left out of the key, so that one type's requests count against the other's identifier.
  it('keeps the two types apart, and gives a body of neither type one key of its own', async () => {
    // Digits fold to themselves in either case, so the two keys differ by the type alone.
    const staff = await keyOf({ principal_type: 'STAFF', identifier: '23456789' });
    const vendor = await keyOf({ principal_type: 'VENDOR', identifier: '23456789' });
    expect(staff).not.toBe(vendor);
    expect(await keyOf({ principal_type: 'RIDER', identifier: 'abcd' })).toBe(
      `${RECOVERY_REQUEST_LIMIT_NAMESPACE}\u0000UNTYPED\u0000abcd`,
    );
    expect(await keyOf({ identifier: 'abcd' })).toBe(
      await keyOf({ principal_type: 42, identifier: 'abcd' }),
    );
  });

  // Break caught: a text that cannot be an identifier keyed anyway (malformed Unicode, nothing but padding).
  it('takes no key from a blank or malformed identifier, which validation refuses', () => {
    expect(RECOVERY_REQUEST_LIMIT.canonical('   ')).toBeUndefined();
    expect(RECOVERY_REQUEST_LIMIT.canonical('\uD800abc')).toBeUndefined();
    expect(RECOVERY_REQUEST_LIMIT).toMatchObject({
      bucket: 'rate_limit_recovery',
      partition: 'RECOVERY_PRINCIPAL',
    });
  });
});
