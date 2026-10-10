import { describe, expect, it } from 'vitest';

import { auditActorOf } from './audit-actor.js';
import { TASK_CAPABILITIES } from './task-capabilities.js';
import type { SecurityContext } from './transaction-context.js';

const PRINCIPAL = '3f2c1d9e-8a7b-4c6d-9e5f-1a2b3c4d5e6f';
const VENDOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RIDER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('auditActorOf (SECURITY_DESIGN.md §14.1b; audit.md: actor_id is null for SYSTEM)', () => {
  // Break caught: the context's technical identifier being copied into the event. A SYSTEM context carries the
  // stable identifier of its capability so that an idempotency record has a principal; the audit records a SYSTEM
  // actor with no identifier, and the mapping is made here and never by copying.
  it.each(TASK_CAPABILITIES)(
    'maps a SYSTEM context under %s to the null actor',
    (taskCapability) => {
      const context: SecurityContext = {
        principalType: 'SYSTEM',
        principalId: PRINCIPAL,
        surface: 'SYSTEM',
        taskCapability,
        correlationId: 'job-1',
      };

      expect(auditActorOf(context)).toEqual({ actorType: 'SYSTEM', actorId: null });
    },
  );

  // Break caught: the mapping nulling the identifier of a person or an account, which would make their actions
  // unattributable, or naming a vendor principal with the wrong actor type.
  it.each([
    [
      'a staff principal',
      {
        principalType: 'STAFF',
        principalId: PRINCIPAL,
        surface: 'OPS_PORTAL',
        correlationId: 'r',
      },
      { actorType: 'STAFF', actorId: PRINCIPAL },
    ],
    [
      'a vendor principal, recorded as its account',
      {
        principalType: 'VENDOR',
        principalId: PRINCIPAL,
        surface: 'VENDOR_PWA',
        vendorOrganizationId: VENDOR,
        correlationId: 'r',
      },
      { actorType: 'VENDOR_ACCOUNT', actorId: PRINCIPAL },
    ],
    [
      'a rider principal',
      {
        principalType: 'RIDER',
        principalId: PRINCIPAL,
        surface: 'RIDER_ANDROID',
        riderId: RIDER,
        correlationId: 'r',
      },
      { actorType: 'RIDER', actorId: PRINCIPAL },
    ],
  ] as const)('keeps the identifier of %s', (_label, context, expected) => {
    expect(auditActorOf(context as SecurityContext)).toEqual(expected);
  });

  // Break caught: the identifier being compared in a different case from the one in the row it came from.
  it('writes an identifier in lower case, as the context setting does', () => {
    expect(
      auditActorOf({
        principalType: 'STAFF',
        principalId: PRINCIPAL.toUpperCase(),
        surface: 'OPS_PORTAL',
        correlationId: 'r',
      }),
    ).toEqual({ actorType: 'STAFF', actorId: PRINCIPAL });
  });

  // Break caught: an unvalidated value being turned into an actor. The mapping is for a context that was accepted,
  // so anything else is refused, not mapped to "system".
  it('refuses a principal type it does not know, and does not call it SYSTEM', () => {
    expect(() =>
      auditActorOf({
        principalType: 'ADMIN',
        principalId: PRINCIPAL,
        surface: 'SYSTEM',
        correlationId: 'r',
      } as unknown as SecurityContext),
    ).toThrow();
  });
});
