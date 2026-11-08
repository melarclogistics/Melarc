import { describe, expect, it } from 'vitest';

import type { IdempotencyScope } from '../auth/ports/idempotency-store.port.js';
import type { SecurityContext } from '../database/transaction-context.js';
import {
  IdempotencyRefusedError,
  ON_BEHALF_OPERATIONS,
  SEALED_REPLAY_OPERATIONS,
  checkFingerprint,
  checkScope,
  isIdempotencyKey,
  scopeKey,
} from './idempotency-scope.js';

const PRINCIPAL = '11111111-1111-4111-8111-111111111111';
const STAFF: SecurityContext = {
  principalType: 'STAFF',
  principalId: PRINCIPAL,
  surface: 'OPS_PORTAL',
  correlationId: 'request-1',
};
const SCOPE: IdempotencyScope = {
  principalType: 'STAFF',
  principalId: PRINCIPAL,
  operationId: 'registerRiderDevice',
  key: 'retry-1',
};

const refusal = (run: () => unknown): IdempotencyRefusedError => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(IdempotencyRefusedError);
    return error as IdempotencyRefusedError;
  }
  throw new Error('expected a refusal');
};

describe('the scope of an idempotency key', () => {
  // Break caught: a scope the principal of the transaction does not own being accepted.
  it('accepts the scope of the principal the transaction runs as, in lower case', () => {
    const upper = { ...SCOPE, principalId: PRINCIPAL.toUpperCase() };

    expect(checkScope(upper, { ...STAFF, principalId: PRINCIPAL.toUpperCase() })).toEqual(SCOPE);
  });

  // Break caught: another principal's key being used from this transaction, which would read or write that principal's records.
  it('refuses a scope whose principal is not the transaction’s', () => {
    for (const other of [
      { ...SCOPE, principalId: '22222222-2222-4222-8222-222222222222' },
      { ...SCOPE, principalType: 'VENDOR' as const },
      { ...SCOPE, principalType: 'RIDER' as const },
    ]) {
      expect(refusal(() => checkScope(other, STAFF)).code).toBe('IDEMPOTENCY_SCOPE_REFUSED');
    }
  });

  // Break caught: a SYSTEM context keying a record, which has no stable principal identity yet (OB-48).
  it('refuses a SYSTEM transaction, which has no principal of its own to key a command', () => {
    const system: SecurityContext = {
      principalType: 'SYSTEM',
      principalId: PRINCIPAL,
      surface: 'SYSTEM',
      taskCapability: 'authentication',
      correlationId: 'request-1',
    };

    expect(refusal(() => checkScope(SCOPE, system)).code).toBe('IDEMPOTENCY_SCOPE_REFUSED');
    expect(
      refusal(() => checkScope({ ...SCOPE, principalType: 'SYSTEM' as never }, system)).code,
    ).toBe('IDEMPOTENCY_SCOPE_REFUSED');
  });

  // Break caught (S0.49): the exception widened beyond its one operation. `requestAdditionalDeviceGrant` writes a grant and a message only
  // the authentication capability may write (data-scope-registry.md: Vendor `DENY`), in one transaction with the vendor's own record, which
  // that capability therefore keeps on the vendor's behalf; any other operation, principal type or capability is refused as before.
  it('lets the authentication capability key the vendor’s additional-browser grant on the vendor’s behalf, and nothing else', () => {
    const authentication: SecurityContext = {
      principalType: 'SYSTEM',
      principalId: '61757468-0000-4000-8000-000000000001',
      surface: 'SYSTEM',
      taskCapability: 'authentication',
      correlationId: 'request-1',
    };
    const vendor: IdempotencyScope = {
      principalType: 'VENDOR',
      principalId: PRINCIPAL,
      operationId: 'requestAdditionalDeviceGrant',
      key: 'retry-1',
    };

    expect(checkScope(vendor, authentication)).toEqual(vendor);
    expect(ON_BEHALF_OPERATIONS).toEqual({ requestAdditionalDeviceGrant: 'VENDOR' });
    for (const scope of [
      { ...vendor, operationId: 'registerRiderDevice' },
      { ...vendor, principalType: 'STAFF' as const },
      { ...vendor, principalType: 'RIDER' as const },
    ]) {
      expect(refusal(() => checkScope(scope, authentication)).code).toBe(
        'IDEMPOTENCY_SCOPE_REFUSED',
      );
    }
    expect(
      refusal(() =>
        checkScope(vendor, { ...authentication, taskCapability: 'credential_delivery' }),
      ).code,
    ).toBe('IDEMPOTENCY_SCOPE_REFUSED');
  });

  // Break caught: an operation name or a key outside the bounds the table and the contract hold.
  it('bounds the operation and the key', () => {
    const bad: Partial<IdempotencyScope>[] = [
      { operationId: '' },
      { operationId: 'not a name' },
      { operationId: '1op' },
      { operationId: 'a'.repeat(65) },
      { key: '' },
      { key: 'k'.repeat(129) },
      { key: 'line\nbreak' },
      { key: 'tab\there' },
      { key: 'nul\u0000' },
    ];
    for (const change of bad) {
      expect(refusal(() => checkScope({ ...SCOPE, ...change }, STAFF)).code).toBe(
        'IDEMPOTENCY_SCOPE_REFUSED',
      );
    }
    expect(checkScope({ ...SCOPE, key: 'k'.repeat(128) }, STAFF).key).toHaveLength(128);
    expect(checkScope({ ...SCOPE, key: 'Retry #1 (café)' }, STAFF).key).toBe('Retry #1 (café)');
  });

  // Break caught: the key being trimmed or case-folded, which would merge two keys a client made different.
  it('keeps the key exactly as it was sent', () => {
    expect(checkScope({ ...SCOPE, key: ' Retry-1 ' }, STAFF).key).toBe(' Retry-1 ');
    expect(checkScope({ ...SCOPE, key: 'Retry-1' }, STAFF).key).not.toBe(
      checkScope({ ...SCOPE, key: 'retry-1' }, STAFF).key,
    );
  });

  // Break caught: two different scopes sharing a map key, so that one command could complete another's record.
  it('names a scope by all four parts, with no way to run one into the next', () => {
    const keys = new Set([
      scopeKey(SCOPE),
      scopeKey({ ...SCOPE, key: 'retry-2' }),
      scopeKey({ ...SCOPE, operationId: 'reregisterRiderDevice' }),
      scopeKey({ ...SCOPE, principalType: 'VENDOR' }),
      scopeKey({ ...SCOPE, principalId: '22222222-2222-4222-8222-222222222222' }),
      scopeKey({ ...SCOPE, operationId: 'registerRiderDevic', key: 'eretry-1' }),
    ]);

    expect(keys.size).toBe(6);
  });

  // Break caught: the one operation that replays a secret becoming more than one without a visible change.
  it('lists registerRiderDevice as the only operation that replays a secret', () => {
    expect([...SEALED_REPLAY_OPERATIONS]).toEqual(['registerRiderDevice']);
  });
});

describe('the fingerprint given to the store', () => {
  // Break caught: a free-form string standing in for a fingerprint (the table holds 64 hex characters).
  it('is 64 lower-case hexadecimal characters', () => {
    expect(checkFingerprint('a'.repeat(64))).toBe('a'.repeat(64));
    for (const bad of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 7]) {
      expect(refusal(() => checkFingerprint(bad as never)).code).toBe('IDEMPOTENCY_SCOPE_REFUSED');
    }
  });
});

describe('isIdempotencyKey', () => {
  // Break caught (the adversarial review): a key the store refuses reaching it inside a transaction, which a request would then answer as a
  // server error. The predicate is the store's own rule, so a service can refuse the same keys first.
  it('accepts one to 128 characters without a control character, and nothing else', () => {
    for (const key of ['retry-1', 'a', 'x'.repeat(128), 'clé-du-jour-😀', ' padded ']) {
      expect(isIdempotencyKey(key), key).toBe(true);
    }
    const tab = String.fromCharCode(9);
    const c1 = String.fromCharCode(0x85);
    for (const key of ['', 'x'.repeat(129), `a${tab}b`, `a${c1}b`, undefined, null, 5, {}]) {
      expect(isIdempotencyKey(key)).toBe(false);
    }
  });
});
