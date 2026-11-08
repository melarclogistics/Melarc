import { describe, expect, it } from 'vitest';

import { TASK_CAPABILITIES } from './task-capabilities.js';
import { SecurityContextError, toContextSettings } from './transaction-context.js';

const PRINCIPAL = '3f2c1d9e-8a7b-4c6d-9e5f-1a2b3c4d5e6f';
const SESSION = '4a3b2c1d-9e8f-4a7b-8c6d-0f1e2d3c4b5a';
const HUB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HUB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VENDOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RIDER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const STAFF = {
  principalType: 'STAFF',
  principalId: PRINCIPAL,
  sessionId: SESSION,
  surface: 'OPS_PORTAL',
  authorizationKey: 'pickup.request.reassign_hub',
  hubScopeMode: 'SET',
  authorizedHubIds: [HUB_A, HUB_B],
  correlationId: 'req-1',
};

const SYSTEM = {
  principalType: 'SYSTEM',
  principalId: PRINCIPAL,
  surface: 'SYSTEM',
  taskCapability: 'authentication',
  correlationId: 'job-7',
};

/** The fields a rejected context names, or a failure if it was accepted. */
function rejectedFields(context: unknown): readonly string[] {
  try {
    toContextSettings(context);
  } catch (error) {
    if (error instanceof SecurityContextError) return error.fields;
    throw error;
  }
  throw new Error('expected the context to be rejected');
}

describe('toContextSettings: accepted contexts', () => {
  // Break caught: a key spelled differently from the one the policies read (SECURITY_DESIGN.md §14.1), a
  // value set under the wrong key, or a hub set not written the way the accessor function parses it.
  it('turns a staff context into the melarc.* settings the policies read', () => {
    expect(toContextSettings(STAFF)).toEqual([
      ['melarc.principal_type', 'STAFF'],
      ['melarc.principal_id', PRINCIPAL],
      ['melarc.session_id', SESSION],
      ['melarc.surface', 'OPS_PORTAL'],
      ['melarc.authorization_key', 'pickup.request.reassign_hub'],
      ['melarc.hub_scope_mode', 'SET'],
      ['melarc.authorized_hub_ids', `${HUB_A},${HUB_B}`],
      ['melarc.correlation_id', 'req-1'],
    ]);
  });

  // Break caught: a vendor or rider boundary not reaching the database, so the policy branch finds
  // nothing to compare against.
  it('carries the vendor and rider boundaries', () => {
    expect(
      toContextSettings({
        principalType: 'VENDOR',
        principalId: PRINCIPAL,
        surface: 'VENDOR_PWA',
        vendorOrganizationId: VENDOR,
        correlationId: 'r',
      }),
    ).toContainEqual(['melarc.vendor_organization_id', VENDOR]);
    expect(
      toContextSettings({
        principalType: 'RIDER',
        principalId: PRINCIPAL,
        surface: 'RIDER_ANDROID',
        riderId: RIDER,
        correlationId: 'r',
      }),
    ).toContainEqual(['melarc.rider_id', RIDER]);
  });

  // Break caught: a SYSTEM principal being refused, or one that needs a hub or a session it does not have; or the
  // capability it works under not reaching the database, where every SYSTEM branch of a policy tests it.
  it('accepts a SYSTEM context with a task capability, no session and no hub', () => {
    expect(
      toContextSettings({
        principalType: 'SYSTEM',
        principalId: PRINCIPAL,
        surface: 'SYSTEM',
        taskCapability: 'authentication',
        correlationId: 'job-7',
      }),
    ).toEqual([
      ['melarc.principal_type', 'SYSTEM'],
      ['melarc.principal_id', PRINCIPAL],
      ['melarc.surface', 'SYSTEM'],
      ['melarc.task_capability', 'authentication'],
      ['melarc.correlation_id', 'job-7'],
    ]);
  });

  // Break caught: a capability of the registry's closed list being refused (SECURITY_DESIGN.md §14.1b;
  // data-scope-registry.md §5.2), or the list drifting from the registry without a test noticing.
  it.each(TASK_CAPABILITIES)('accepts the %s capability for a SYSTEM context', (taskCapability) => {
    expect(toContextSettings({ ...SYSTEM, taskCapability })).toContainEqual([
      'melarc.task_capability',
      taskCapability,
    ]);
  });

  // Break caught: an empty hub set turning into "no setting", or into all hubs. It must be set, and empty.
  it('sets an empty hub set explicitly, as empty', () => {
    const settings = toContextSettings({ ...STAFF, authorizedHubIds: [] });
    expect(settings).toContainEqual(['melarc.authorized_hub_ids', '']);
  });

  // Break caught: a differently cased UUID compared unequal to the same UUID in a row.
  it('writes identifiers in lower case', () => {
    const settings = toContextSettings({ ...STAFF, principalId: PRINCIPAL.toUpperCase() });
    expect(settings).toContainEqual(['melarc.principal_id', PRINCIPAL]);
  });

  // Break caught: the bound of a correlation id being one short. The contract's Idempotency-Key is 128 long, and a
  // correlation id may be one.
  it('accepts a correlation id of exactly 128 characters', () => {
    const correlationId = 'x'.repeat(128);
    expect(toContextSettings({ ...STAFF, correlationId })).toContainEqual([
      'melarc.correlation_id',
      correlationId,
    ]);
  });

  // Break caught: an identifier written in capitals reaching a policy as it came, where it compares unequal to the
  // same identifier in a row. Every identifier is lower-cased, the hub set included.
  it('writes every identifier in lower case, the hubs and the boundaries too', () => {
    const settings = toContextSettings({
      principalType: 'STAFF',
      principalId: PRINCIPAL,
      sessionId: SESSION.toUpperCase(),
      surface: 'OPS_PORTAL',
      hubScopeMode: 'SET',
      authorizedHubIds: [HUB_A.toUpperCase(), HUB_B.toUpperCase()],
      vendorOrganizationId: VENDOR.toUpperCase(),
      riderId: RIDER.toUpperCase(),
      correlationId: 'r',
    });

    expect(settings).toEqual(
      expect.arrayContaining([
        ['melarc.session_id', SESSION],
        ['melarc.authorized_hub_ids', `${HUB_A},${HUB_B}`],
        ['melarc.vendor_organization_id', VENDOR],
        ['melarc.rider_id', RIDER],
      ]),
    );
  });

  // Break caught: ALL being dropped, or a hub list being demanded for it. It is never inferred, so it must
  // arrive exactly as given.
  it('carries an explicit all-hub scope', () => {
    const settings = toContextSettings({
      ...STAFF,
      hubScopeMode: 'ALL',
      authorizedHubIds: undefined,
    });
    expect(settings).toContainEqual(['melarc.hub_scope_mode', 'ALL']);
  });
});

describe('toContextSettings: refused contexts', () => {
  // Break caught: a malformed value reaching set_config. An invalid context must stop here, before any
  // transaction exists (SECURITY_DESIGN.md §14.1b), and must name what is wrong.
  it.each([
    ['an unknown principal type', { ...STAFF, principalType: 'ADMIN' }, 'principalType'],
    ['a lower-case principal type', { ...STAFF, principalType: 'staff' }, 'principalType'],
    ['no principal type', { ...STAFF, principalType: undefined }, 'principalType'],
    ['a malformed principal id', { ...STAFF, principalId: 'not-a-uuid' }, 'principalId'],
    ['a principal id with padding', { ...STAFF, principalId: ` ${PRINCIPAL}` }, 'principalId'],
    ['no principal id', { ...STAFF, principalId: undefined }, 'principalId'],
    ['a malformed session id', { ...STAFF, sessionId: '123' }, 'sessionId'],
    ['an unknown surface', { ...STAFF, surface: 'ADMIN_CONSOLE' }, 'surface'],
    ['no surface', { ...STAFF, surface: undefined }, 'surface'],
    ['a malformed scope mode', { ...STAFF, hubScopeMode: 'ANY' }, 'hubScopeMode'],
    ['a malformed hub id', { ...STAFF, authorizedHubIds: [HUB_A, 'hub-b'] }, 'authorizedHubIds'],
    ['a hub list that is not a list', { ...STAFF, authorizedHubIds: HUB_A }, 'authorizedHubIds'],
    [
      'a hub id containing a comma',
      { ...STAFF, authorizedHubIds: [`${HUB_A},${HUB_B}`] },
      'authorizedHubIds',
    ],
    [
      'a malformed authorization key',
      { ...STAFF, authorizationKey: 'Pickup Request' },
      'authorizationKey',
    ],
    [
      'an authorization key of one word',
      { ...STAFF, authorizationKey: 'pickup' },
      'authorizationKey',
    ],
    [
      'an authorization key ending in a dot',
      { ...STAFF, authorizationKey: 'pickup.' },
      'authorizationKey',
    ],
    [
      'an authorization key starting with a dot',
      { ...STAFF, authorizationKey: '.pickup' },
      'authorizationKey',
    ],
    [
      'an authorization key in capitals',
      { ...STAFF, authorizationKey: 'Pickup.Request' },
      'authorizationKey',
    ],
    [
      'a hub list with a hole in it',
      // eslint-disable-next-line no-sparse-arrays -- a sparse list is the input under test
      { ...STAFF, authorizedHubIds: [HUB_A, , HUB_B] },
      'authorizedHubIds',
    ],
    [
      'a vendor organization on a staff principal that is not a uuid',
      { ...STAFF, vendorOrganizationId: 'nope' },
      'vendorOrganizationId',
    ],
    ['a rider on a staff principal that is not a uuid', { ...STAFF, riderId: 'nope' }, 'riderId'],
    [
      'an authorization key with an injection attempt',
      { ...STAFF, authorizationKey: "a.b'; --" },
      'authorizationKey',
    ],
    ['no correlation id', { ...STAFF, correlationId: undefined }, 'correlationId'],
    ['an empty correlation id', { ...STAFF, correlationId: '' }, 'correlationId'],
    [
      'a correlation id of 129 characters',
      { ...STAFF, correlationId: 'x'.repeat(129) },
      'correlationId',
    ],
    [
      'a correlation id with a control character',
      { ...STAFF, correlationId: 'a\u0000b' },
      'correlationId',
    ],
    ['a correlation id with a newline', { ...STAFF, correlationId: 'a\nb' }, 'correlationId'],
    [
      'a correlation id with a unit separator',
      { ...STAFF, correlationId: 'a\u001fb' },
      'correlationId',
    ],
    [
      'a correlation id with a delete character',
      { ...STAFF, correlationId: 'a\u007fb' },
      'correlationId',
    ],
    [
      'a correlation id with a C1 control',
      { ...STAFF, correlationId: 'a\u0085b' },
      'correlationId',
    ],
  ])('refuses %s', (_label, context, field) => {
    expect(rejectedFields(context)).toEqual([field]);
  });

  // Break caught: a vendor or rider context without the boundary its policy compares against, which would
  // turn "no boundary" into an error inside the policy instead of a refusal before it.
  it('requires the vendor organization for a vendor and the rider for a rider', () => {
    const vendor = {
      principalType: 'VENDOR',
      principalId: PRINCIPAL,
      surface: 'VENDOR_PWA',
      correlationId: 'r',
    };
    const rider = {
      principalType: 'RIDER',
      principalId: PRINCIPAL,
      surface: 'RIDER_ANDROID',
      correlationId: 'r',
    };
    expect(rejectedFields(vendor)).toEqual(['vendorOrganizationId']);
    expect(rejectedFields({ ...vendor, vendorOrganizationId: 'nope' })).toEqual([
      'vendorOrganizationId',
    ]);
    expect(rejectedFields(rider)).toEqual(['riderId']);
    expect(rejectedFields({ ...rider, riderId: 'nope' })).toEqual(['riderId']);
  });

  // Break caught: only the first problem reported, so each fix needs another failed request.
  it('names every invalid field', () => {
    expect(
      rejectedFields({ ...STAFF, principalType: 'x', surface: 'y', correlationId: '' }).toSorted(),
    ).toEqual(['correlationId', 'principalType', 'surface']);
  });

  // Break caught: a value echoed into the error, which would carry an attacker-chosen string, or a
  // credential pasted into the wrong field, into a log.
  it('names fields and never repeats a value', () => {
    let message = '';
    try {
      toContextSettings({
        ...STAFF,
        authorizationKey: 'SECRET-VALUE-123',
        principalId: 'TOKEN-ABC',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('authorizationKey');
    expect(message).toContain('principalId');
    expect(message).not.toContain('SECRET-VALUE-123');
    expect(message).not.toContain('TOKEN-ABC');
  });

  // Break caught: a caller passing something that is not an object being treated as an empty, valid context.
  it.each([[null], [undefined], ['STAFF'], [42], [[]]])('refuses %j as a whole', (context) => {
    expect(rejectedFields(context)).toEqual(['context']);
  });
});

describe('toContextSettings: the task capability (SecurityContext v2)', () => {
  // Break caught: a SYSTEM context with no capability reaching the database, where "SYSTEM" alone must open
  // nothing (SECURITY_DESIGN.md §14.1: no SYSTEM branch is ever true without one).
  it('requires a task capability for a SYSTEM context', () => {
    expect(rejectedFields({ ...SYSTEM, taskCapability: undefined })).toEqual(['taskCapability']);
  });

  // Break caught: a value outside the closed list being written, which a typo or an attacker-chosen string would
  // turn into a label no policy tests but one a future branch might. Capitals, padding and other registries'
  // spellings are not the capability.
  it.each([
    ['an unknown capability', 'admin'],
    ['a capability in capitals', 'AUTHENTICATION'],
    ['a capability with padding', ' authentication'],
    ['a worker capability that is not yet in the closed list', 'worker:notification'],
    ['an empty capability', ''],
    ['the placeholder the accessor returns for none', 'NONE'],
    ['an injection attempt', "seed'; drop table x; --"],
  ])('refuses %s', (_label, taskCapability) => {
    expect(rejectedFields({ ...SYSTEM, taskCapability })).toEqual(['taskCapability']);
  });

  // Break caught: a business principal carrying a capability, which would make a label available to a branch it
  // must never reach. The capability is present exactly when the principal is SYSTEM.
  it.each([
    ['a staff', STAFF],
    [
      'a vendor',
      {
        principalType: 'VENDOR',
        principalId: PRINCIPAL,
        surface: 'VENDOR_PWA',
        vendorOrganizationId: VENDOR,
        correlationId: 'r',
      },
    ],
    [
      'a rider',
      {
        principalType: 'RIDER',
        principalId: PRINCIPAL,
        surface: 'RIDER_ANDROID',
        riderId: RIDER,
        correlationId: 'r',
      },
    ],
  ])('refuses a capability on %s principal', (_label, context) => {
    expect(rejectedFields({ ...context, taskCapability: 'authentication' })).toEqual([
      'taskCapability',
    ]);
  });

  // Break caught: a capability that is not a string being coerced into one.
  it.each([[42], [['seed']], [{ name: 'seed' }], [true]])(
    'refuses %j as a capability',
    (taskCapability) => {
      expect(rejectedFields({ ...SYSTEM, taskCapability })).toEqual(['taskCapability']);
    },
  );
});

describe('toContextSettings: the scope probe belongs to existingRecordHub alone', () => {
  // Break caught: the probe id arriving with a context. It is set by one repository function and never from a
  // request (§14.1b), so a context that carries one, however well formed, is refused.
  it('refuses a context that carries a scope probe id', () => {
    expect(rejectedFields({ ...STAFF, scopeProbeId: HUB_A })).toEqual(['scopeProbeId']);
  });

  it('refuses a probe id on a SYSTEM context too', () => {
    expect(rejectedFields({ ...SYSTEM, scopeProbeId: HUB_A })).toEqual(['scopeProbeId']);
  });

  // Break caught: a blank or null probe being read as "not given" and quietly accepted, which a later change that
  // reads the field would then turn into a way in.
  it.each([[null], ['']])('refuses even an empty probe id: %j', (value) => {
    expect(rejectedFields({ ...STAFF, scopeProbeId: value })).toEqual(['scopeProbeId']);
  });

  it('never writes the setting', () => {
    expect(toContextSettings(STAFF).map(([name]) => name)).not.toContain('melarc.scope_probe_id');
  });
});

describe('toContextSettings: the principal and its surface', () => {
  // Break caught: the pairing check missing, so a staff session could present as the Rider app and a vendor as the
  // Ops Portal. The three authentication models never mix (SECURITY_DESIGN.md §14.8 and the permissions surface
  // gate), and the surface in the context is what the audit records.
  it.each([
    ['STAFF', 'OPS_PORTAL'],
    ['VENDOR', 'VENDOR_PWA'],
    ['RIDER', 'RIDER_ANDROID'],
    ['SYSTEM', 'SYSTEM'],
  ] as const)('accepts %s on %s', (principalType, surface) => {
    const context = {
      principalType,
      principalId: PRINCIPAL,
      surface,
      correlationId: 'r',
      ...(principalType === 'VENDOR' ? { vendorOrganizationId: VENDOR } : {}),
      ...(principalType === 'RIDER' ? { riderId: RIDER } : {}),
      ...(principalType === 'SYSTEM' ? { taskCapability: 'authentication' } : {}),
    };
    expect(toContextSettings(context)).toContainEqual(['melarc.surface', surface]);
  });

  it.each([
    ['STAFF', 'VENDOR_PWA'],
    ['STAFF', 'RIDER_ANDROID'],
    ['STAFF', 'SYSTEM'],
    ['VENDOR', 'OPS_PORTAL'],
    ['VENDOR', 'RIDER_ANDROID'],
    ['VENDOR', 'SYSTEM'],
    ['RIDER', 'OPS_PORTAL'],
    ['RIDER', 'VENDOR_PWA'],
    ['RIDER', 'SYSTEM'],
    ['SYSTEM', 'OPS_PORTAL'],
    ['SYSTEM', 'VENDOR_PWA'],
    ['SYSTEM', 'RIDER_ANDROID'],
  ] as const)('refuses %s on %s, and names the surface', (principalType, surface) => {
    const context = {
      principalType,
      principalId: PRINCIPAL,
      surface,
      correlationId: 'r',
      ...(principalType === 'VENDOR' ? { vendorOrganizationId: VENDOR } : {}),
      ...(principalType === 'RIDER' ? { riderId: RIDER } : {}),
      ...(principalType === 'SYSTEM' ? { taskCapability: 'authentication' } : {}),
    };
    expect(rejectedFields(context)).toEqual(['surface']);
  });

  // Break caught: a pairing failure hiding that the principal type itself is invalid, or a second error being
  // added for a surface that is merely unknown.
  it('reports an unknown surface once, and not a second time as a pairing failure', () => {
    expect(rejectedFields({ ...STAFF, surface: 'ADMIN_CONSOLE' })).toEqual(['surface']);
  });

  it('does not judge the pairing of an unknown principal type', () => {
    expect(rejectedFields({ ...STAFF, principalType: 'ADMIN' })).toEqual(['principalType']);
  });
});
