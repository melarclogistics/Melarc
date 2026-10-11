import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { ContractValidator, type RequestParts, type ResponseParts } from './contract-validator.js';
import { isJsonObject, type JsonObject } from './json.js';
import { locateContract } from './locate-contract.js';

/**
 * The Product Owner's decisions of 6 October 2026 on the identity operations, as the real contracts/openapi.yaml
 * states them, and as the validator that will enforce it reads them. The decisions that are a rule a validator can
 * apply (a code's pattern, a required field, a cookie) are judged by the validator; those that are a statement
 * (which code an operation declares, what it says about a refusal) are read off the operation.
 */
const CONTRACT = parse(readFileSync(locateContract(import.meta.dirname), 'utf8')) as JsonObject;
const validator = new ContractValidator(CONTRACT);
const UUID = '0190d7c2-7a3e-7c1e-9d2a-3f4b5c6d7e8f';

function operation(id: string): JsonObject {
  for (const item of Object.values(CONTRACT.paths as JsonObject)) {
    if (!isJsonObject(item)) continue;
    for (const candidate of Object.values(item)) {
      if (isJsonObject(candidate) && candidate.operationId === id) return candidate;
    }
  }
  throw new Error(`No operation ${id}`);
}
const schema = (name: string): JsonObject =>
  ((CONTRACT.components as JsonObject).schemas as JsonObject)[name] as JsonObject;
const property = (name: string, field: string): JsonObject =>
  (schema(name).properties as JsonObject)[field] as JsonObject;
const codes = (id: string): string[] => operation(id)['x-error-codes'] as string[];
const statuses = (id: string): string[] => Object.keys(operation(id).responses as JsonObject);
const flat = (text: unknown): string => String(text).replaceAll(/\s+/g, ' ');
const description = (id: string): string => flat(operation(id).description);
const ROOT = dirname(dirname(locateContract(import.meta.dirname)));
const lines = (...segments: string[]): string =>
  readFileSync(join(ROOT, ...segments), 'utf8').replaceAll('\r', '');
const document = (...segments: string[]): string => flat(lines(...segments));

const request = (overrides: Partial<RequestParts>): RequestParts => ({
  params: {},
  query: {},
  headers: {},
  body: undefined,
  hasBody: true,
  ...overrides,
});
const response = (overrides: Partial<ResponseParts>): ResponseParts => ({
  status: 200,
  body: undefined,
  headers: {},
  ...overrides,
});

describe('I2: a stranded bootstrap administrator is not reissued a setup grant', () => {
  // Break caught: the operation describing a refusal it does not declare, or declaring one it does not describe.
  it('has reissueStaffCredentialSetup refuse a bootstrap identity with STATE_CONFLICT and its 409', () => {
    expect(codes('reissueStaffCredentialSetup')).toContain('STATE_CONFLICT');
    expect(statuses('reissueStaffCredentialSetup')).toContain('409');
    expect(description('reissueStaffCredentialSetup')).toMatch(
      /A bootstrap identity is refused with `STATE_CONFLICT`.*an address nobody verified.*provisioning channel.*resetStaffMfa/,
    );
  });
});

describe('I3: a privileged identity with no ACTIVE factor', () => {
  it('declares MFA_ENROLMENT_REQUIRED on completeStaffMfaSignIn, answered 403 and not counted', () => {
    expect(codes('completeStaffMfaSignIn')).toContain('MFA_ENROLMENT_REQUIRED');
    const forbidden = (operation('completeStaffMfaSignIn').responses as JsonObject)['403'];
    expect(flat((forbidden as JsonObject).description)).toMatch(/^`MFA_ENROLMENT_REQUIRED`\./);
    expect(description('completeStaffMfaSignIn')).toMatch(
      /`MFA_ENROLMENT_REQUIRED` with `403` here.*does not count towards the lockout/,
    );
  });

  // Break caught: the refusal moving to the password step, where it would tell a caller who knows only a password
  // that the identity has no factor. The same 202 is what an enrolled identity gets.
  it('says staffSignIn answers the same 202 challenge, and never declares the code itself', () => {
    expect(codes('staffSignIn')).not.toContain('MFA_ENROLMENT_REQUIRED');
    expect(description('staffSignIn')).toMatch(
      /no `ACTIVE` MFA factor.*same `202` challenge as an enrolled one/,
    );
  });
});

describe('I4: the reason_code of the identity operations', () => {
  const OPERATIONS = [
    ['revokeSession', 'SessionRevoke'],
    ['approveStaffIdentity', 'StaffIdentityApproval'],
    ['resetStaffMfa', 'MfaReset'],
    ['reissueStaffCredentialSetup', 'SetupGrantReissue'],
    ['reissueVendorCredentialSetup', 'SetupGrantReissue'],
    ['recoverStaffCredential', 'CredentialRecoveryInitiation'],
    ['recoverVendorCredential', 'CredentialRecoveryInitiation'],
    ['reregisterRiderDevice', 'RiderDeviceReregistration'],
    ['revokeRiderDevice', 'DeviceRevocation'],
  ] as const;

  // Break caught: an identity operation that takes a reason and neither says it is checked against the catalogue
  // nor declares the two refusals that check can make.
  it.each(OPERATIONS)('%s declares REASON_REQUIRED and REASON_NOT_ACTIVE, with a 422', (id) => {
    expect(codes(id)).toEqual(expect.arrayContaining(['REASON_REQUIRED', 'REASON_NOT_ACTIVE']));
    expect(statuses(id)).toContain('422');
  });

  it.each(OPERATIONS)('%s takes a catalogue reason_code, as %s says', (_id, name) => {
    const said = flat(property(name, 'reason_code').description);

    expect(said).toMatch(/code of the reason catalogue \(`ReasonDefinition`\)/);
    expect(said).toMatch(/identity domain for this operation/);
    expect(said).toMatch(/empty is `REASON_REQUIRED`/);
    expect(said).toMatch(/`REASON_NOT_ACTIVE`/);
  });

  // Break caught: the contract naming a domain or a value, which are the Product Owner's input and not given.
  it('names no reason domain and no reason value', () => {
    for (const [, name] of OPERATIONS) {
      const said = flat(property(name, 'reason_code').description);
      expect(said, name).not.toMatch(/\b[A-Z]+_[A-Z_]+\b(?<!REASON_REQUIRED|REASON_NOT_ACTIVE)/);
    }
  });

  // Break caught: the bare `reason` of a device revocation, which no catalogue checks.
  it('has DeviceRevocation take a reason_code and no bare reason', () => {
    expect(Object.keys(schema('DeviceRevocation').properties as JsonObject)).toEqual([
      'reason_code',
    ]);
    expect(schema('DeviceRevocation').required).toEqual(['reason_code']);

    const sent = (body: unknown) =>
      validator.validateRequest('revokeRiderDevice', request({ params: { riderId: UUID }, body }));
    expect(sent({ reason_code: 'ANY_CODE' })).toEqual([]);
    expect(sent({ reason: 'lost' })).toEqual([
      { in: 'body', pointer: '/reason_code', rule: 'required' },
      { in: 'body', pointer: '', rule: 'additionalProperties' },
    ]);
  });

  // Break caught: the schema refusing an empty reason itself, which would turn REASON_REQUIRED into a 400.
  it('lets an empty reason_code reach the catalogue check, where it is REASON_REQUIRED', () => {
    expect(
      validator.validateRequest(
        'revokeRiderDevice',
        request({ params: { riderId: UUID }, body: { reason_code: '' } }),
      ),
    ).toEqual([]);
  });
});

describe('I6: the vendor delivery channel is chosen at approval', () => {
  const decide = (body: unknown) =>
    validator.validateRequest(
      'decideVendorOrganization',
      request({ params: { id: UUID }, headers: { 'if-match': '"1"' }, body }),
    );

  it('takes PHONE or EMAIL on approval, and requires one', () => {
    expect(decide({ approved: true, delivery_channel: 'PHONE' })).toEqual([]);
    expect(decide({ approved: true, delivery_channel: 'EMAIL' })).toEqual([]);
    expect(decide({ approved: true, delivery_channel: 'SMS' })).toEqual([
      { in: 'body', pointer: '/delivery_channel', rule: 'enum' },
    ]);
    expect(decide({ approved: true })).toEqual([
      { in: 'body', pointer: '/delivery_channel', rule: 'required' },
    ]);
  });

  // Break caught: a rejection being made to name a channel for a grant it never issues.
  it('needs no channel on a rejection', () => {
    expect(decide({ approved: false, reason: 'Not a business we can verify' })).toEqual([]);
  });

  it('declares the 400 the missing channel is answered with', () => {
    expect(codes('decideVendorOrganization')).toContain('VALIDATION_FAILED');
    expect(statuses('decideVendorOrganization')).toContain('400');
  });

  // Break caught: the stored channel being writable from a response, or absent from the account an officer reads.
  it('shows the channel on the vendor account, read-only, null before approval', () => {
    const channel = property('VendorAccountSummary', 'delivery_channel');
    expect(channel.readOnly).toBe(true);
    expect(channel.enum).toEqual(['PHONE', 'EMAIL', null]);
    expect(channel.type).toEqual(['string', 'null']);
    expect(schema('VendorAccountSummary').required).not.toContain('delivery_channel');

    const account = {
      id: UUID,
      account_identifier: 'V-1',
      vendor_organization_id: UUID,
      legal_name: 'Kofi Traders',
      responsible_hub_id: UUID,
      status: 'ACTIVE',
      credential_established: false,
      active_device_count: 0,
      has_recovery_email: true,
      has_recovery_phone: false,
    };
    const read = (summary: JsonObject) =>
      validator.validateResponse(
        'getVendorAccount',
        response({ body: { account: summary, devices: [] }, headers: { etag: '"1"' } }),
      );
    expect(read({ ...account, delivery_channel: 'EMAIL' })).toEqual([]);
    expect(read({ ...account, delivery_channel: null })).toEqual([]);
    expect(read(account)).toEqual([]);
    expect(read({ ...account, delivery_channel: 'FAX' })).toEqual([
      { in: 'response-body', pointer: '/account/delivery_channel', rule: 'enum' },
    ]);
  });
});

describe('I7 to I9: the refusals of the identity operations', () => {
  it('has registerRiderDevice refuse a rider who had a device revoked, with its 409', () => {
    expect(codes('registerRiderDevice')).toContain('STATE_CONFLICT');
    expect(statuses('registerRiderDevice')).toContain('409');
    expect(description('registerRiderDevice')).toMatch(
      /who has had a device revoked is refused with `STATE_CONFLICT` too.*only `reregisterRiderDevice`.*verification note and the rider's ETag/,
    );
  });

  it('has resetStaffMfa refuse self-reset and a non-privileged target', () => {
    expect(codes('resetStaffMfa')).toEqual(
      expect.arrayContaining(['SELF_APPROVAL_FORBIDDEN', 'STATE_CONFLICT']),
    );
    expect(statuses('resetStaffMfa')).toEqual(expect.arrayContaining(['409', '422']));
    expect(description('resetStaffMfa')).toMatch(
      /Resetting one's own factor is `SELF_APPROVAL_FORBIDDEN`.*other bootstrap Platform Admin is a valid actor.*non-privileged identity.*are `STATE_CONFLICT`/,
    );
  });

  // Break caught: the reset still refusing a privileged identity whose factor is only PENDING, or whose earlier reset
  // never finished, which leaves it with no route back in (decision F05, 8 October 2026), or, the opposite error,
  // treating the mere absence of a factor as eligibility (R2 review).
  it('has resetStaffMfa reach a stranded enrolment and an unfinished reset from recorded state, without a factor or a session', () => {
    const said = description('resetStaffMfa');

    expect(said).toMatch(/exactly one of three \*\*recorded\*\* states/);
    expect(said).toMatch(
      /It holds a `PENDING` factor of recorded provenance with no usable enrolment or re-enrolment grant/,
    );
    expect(said).toMatch(
      /Its most recent factor was revoked by an administrator, carries a revocation episode, and no replacement factor was created/,
    );
    expect(said).toMatch(
      /queues a new `MFA_REENROLMENT` grant to the target's \*\*verified work email only\*\*/,
    );
    expect(said).toMatch(/\*\*It creates neither an `ACTIVE` factor nor a session\.\*\*/);
    expect(said).toMatch(/the request is coalesced/);
    expect(said).not.toMatch(/only `PENDING` \(never proven\)/);
  });

  // Break caught: an identity that merely has no factor being reset, a repeated reissue that leaves several grants of
  // one episode pending, and a terminal grant being rewritten to SUPERSEDED. (A pin on the contract text: it proves the
  // wording, not the behaviour, which is an acceptance obligation of the task that builds it.)
  it('has resetStaffMfa refuse the absence of a factor and chain a repeated reissue', () => {
    const said = description('resetStaffMfa');

    expect(said).toMatch(
      /a target with no factor record at all and a target whose latest factor the system ended\*\* are `STATE_CONFLICT`: the absence of a factor is never eligibility/,
    );
    expect(said).toMatch(
      /issues a new grant \*\*in the same reset episode\*\*; the pending predecessor, if there is one, ends `SUPERSEDED` and the new grant names it, so at most one grant of the episode is pending/,
    );
  });

  it("has resetStaffMfa supersede only pending grants and keep a factor's creation episode", () => {
    const said = description('resetStaffMfa');

    expect(said).toMatch(
      /supersedes the enrolment and re-enrolment grants that are \*\*still `PENDING`\*\*/,
    );
    expect(said).toMatch(
      /a grant that is already consumed, expired or superseded keeps that terminal state and is never rewritten/,
    );
    expect(said).toMatch(
      /A factor created in one episode and later reset keeps its creation episode and gains the revocation episode/,
    );
    expect(said).not.toMatch(/supersedes the outstanding enrolment and re-enrolment grants/);
  });

  // Break caught: a seeded bootstrap administrator in a stranded state being left with no route at all, because the
  // reset refuses it and the provisioning command is the only way back, or being told apart by inference.
  it('sends a stranded bootstrap administrator to the provisioning channel, identified by its immutable origin', () => {
    expect(description('resetStaffMfa')).toMatch(
      /immutable `origin` `BOOTSTRAP`, read as a column and never inferred - \*\*is reached in the first state only\*\*; in a stranded state it is refused too.*provisioning channel/,
    );
  });

  // Break caught: a rejection of a privileged profile being open to a lower tier because only approval said so.
  it('has approveStaffIdentity answer INSUFFICIENT_AUTHORITY, with its 403, on rejection too', () => {
    expect(codes('approveStaffIdentity')).toContain('INSUFFICIENT_AUTHORITY');
    expect(statuses('approveStaffIdentity')).toContain('403');
    expect(description('approveStaffIdentity')).toMatch(
      /The same holds for rejection.*Platform Admin other than the maker.*`INSUFFICIENT_AUTHORITY` \(`403`\)/,
    );
    expect(description('approveStaffIdentity')).toMatch(/Its work email is released/);
  });
});

describe('I12: the recovery supersede guard', () => {
  it('says a request inside the guard neither supersedes nor issues, with the same 202', () => {
    expect(description('requestCredentialRecovery')).toMatch(
      /less than `recovery_request_supersede_guard_seconds` \(60, a starting value\) after the pending link was issued neither supersedes it nor issues another.*same `202`/,
    );
    expect(statuses('requestCredentialRecovery')).toContain('202');
  });
});

describe('I13: the Session carries the permission keys it holds', () => {
  const session = {
    id: UUID,
    principal_type: 'STAFF',
    state: 'ACTIVE',
    expires_at: '2026-10-06T20:00:00Z',
    principal_display_name: 'Ada Lovelace',
    authorized_hubs: [],
  };
  const read = (extra: JsonObject) =>
    validator.validateResponse('getCurrentSession', response({ body: { ...session, ...extra } }));

  it('has a read-only list of permission keys, optional, in the contract', () => {
    const permissions = property('SessionRecord', 'permissions');

    expect(permissions.type).toBe('array');
    expect(permissions.readOnly).toBe(true);
    expect(permissions.uniqueItems).toBe(true);
    expect(schema('SessionRecord').required).not.toContain('permissions');
    expect(flat(permissions.description)).toMatch(/never role names/);
  });

  it('accepts permission keys, and refuses what is not a key', () => {
    expect(read({ permissions: ['pickup.read', 'staff.mfa.reset'] })).toEqual([]);
    expect(read({ permissions: [] })).toEqual([]);
    expect(read({})).toEqual([]);
    // Break caught: a role name, or a bundle, standing in for keys: the menu would be built from the role.
    expect(read({ permissions: ['Platform Admin'] })).toEqual([
      { in: 'response-body', pointer: '/permissions/0', rule: 'pattern' },
    ]);
    expect(read({ permissions: ['platform_admin'] })).toEqual([
      { in: 'response-body', pointer: '/permissions/0', rule: 'pattern' },
    ]);
    expect(read({ permissions: [{ key: 'pickup.read' }] })).toEqual([
      { in: 'response-body', pointer: '/permissions/0', rule: 'type' },
    ]);
    expect(read({ permissions: ['pickup.read', 'pickup.read'] })).toEqual([
      { in: 'response-body', pointer: '/permissions', rule: 'uniqueItems' },
    ]);
  });

  it('is described by getCurrentSession as keys only, never role names', () => {
    expect(description('getCurrentSession')).toMatch(/`permissions`.*keys only, never role names/);
  });
});

describe('I14: TOTP codes are six digits', () => {
  const signIn = (code: unknown) =>
    validator.validateRequest(
      'completeStaffMfaSignIn',
      request({ body: { challenge_id: UUID, code } }),
    );
  const enrol = (totp_code: unknown) =>
    validator.validateRequest(
      'completeMfaEnrolment',
      request({ body: { setup_token: 'T', totp_code } }),
    );

  it.each(['123456', '000000', '999999'])('accepts %s', (code) => {
    expect(signIn(code)).toEqual([]);
    expect(enrol(code)).toEqual([]);
  });

  // Break caught: a code that is not exactly six ASCII digits reaching the factor check, which would count it
  // against the lockout and the challenge as a wrong code.
  it.each([
    '12345',
    '1234567',
    'abcdef',
    '12345a',
    ' 123456',
    '123456 ',
    '123 456',
    '１２３４５６',
    '',
    '123456\n',
  ])('refuses %j', (code) => {
    expect(signIn(code)).toEqual([{ in: 'body', pointer: '/code', rule: 'pattern' }]);
    expect(enrol(code)).toEqual([{ in: 'body', pointer: '/totp_code', rule: 'pattern' }]);
  });

  it('states the rule in the description of each code field', () => {
    for (const [name, field] of [
      ['MfaSignInComplete', 'code'],
      ['MfaEnrolment', 'totp_code'],
    ] as const) {
      const said = flat(property(name, field).description);
      expect(said, name).toMatch(
        /6 digits, 30-second step, one step accepted either side, single use/,
      );
    }
  });

  // Break caught: a TOTP field added elsewhere with no pattern. Any property whose description speaks of a TOTP
  // code must carry it.
  it('leaves no TOTP code field without the pattern', () => {
    const missing: string[] = [];
    for (const [name, definition] of Object.entries(
      (CONTRACT.components as JsonObject).schemas as JsonObject,
    )) {
      const properties = isJsonObject(definition) ? definition.properties : undefined;
      if (!isJsonObject(properties)) continue;
      for (const [field, value] of Object.entries(properties)) {
        if (
          isJsonObject(value) &&
          (/totp/i.test(field) || flat(value.description ?? '').includes('TOTP code')) &&
          value.pattern !== '^[0-9]{6}$'
        ) {
          missing.push(`${name}.${field}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('I15 and I20 3: cookie lifetimes, and the recovery cookie for the vendor branch only', () => {
  const SESSION = 'melarc_session=S; Path=/; HttpOnly; Secure; SameSite=Lax';
  const CSRF = 'melarc_csrf=C; Path=/; Secure; SameSite=Lax';
  const DEVICE = 'melarc_vendor_device=D; Max-Age=34560000; Path=/; HttpOnly; Secure; SameSite=Lax';
  const cookies = (
    id: string,
    status: number,
    setCookie: string[] | undefined,
    context?: { principalType: string },
  ) =>
    validator
      .validateResponse(
        id,
        response({
          status,
          body: status === 200 ? {} : undefined,
          headers: setCookie === undefined ? {} : { 'set-cookie': setCookie },
        }),
        { headers: {} },
        context,
      )
      .filter((violation) => violation.in === 'response-cookie');

  it('declares the session and CSRF cookies as browser-session cookies and the device cookie for 400 days', () => {
    const declared = CONTRACT['x-cookies'] as JsonObject;
    const attributes = (name: string) => (declared[name] as JsonObject).attributes;

    expect((declared.melarc_session as JsonObject).browser_session).toBe(true);
    expect((declared.melarc_csrf as JsonObject).browser_session).toBe(true);
    expect((declared.melarc_vendor_device as JsonObject).browser_session).toBeUndefined();
    expect(attributes('melarc_vendor_device')).toBe(
      'HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000',
    );
    expect(34_560_000).toBe(400 * 24 * 60 * 60);
    for (const name of ['melarc_session', 'melarc_csrf', 'melarc_vendor_device']) {
      expect(attributes(name), name).toMatch(/\bSecure\b/);
    }
  });

  // Break caught: a session issued with a lifetime, which outlives the browser session on the user's disk.
  it('refuses a session cookie issued with a Max-Age or an Expires, on every operation that issues one', () => {
    for (const [id, status] of [
      ['staffSignIn', 200],
      ['completeStaffMfaSignIn', 200],
      ['vendorSignIn', 200],
    ] as const) {
      const extra = id === 'vendorSignIn' ? [DEVICE] : [];
      expect(cookies(id, status, [SESSION, CSRF, ...extra]), id).toEqual([]);
      expect(cookies(id, status, [`${SESSION}; Max-Age=3600`, CSRF, ...extra]), id).toEqual([
        { in: 'response-cookie', pointer: 'melarc_session', rule: 'max-age' },
      ]);
      expect(
        cookies(id, status, [SESSION, `${CSRF}; Expires=Fri, 31 Dec 2999 23:59:59 GMT`, ...extra]),
        id,
      ).toEqual([{ in: 'response-cookie', pointer: 'melarc_csrf', rule: 'expires' }]);
    }
  });

  // Break caught: the sign-out that removes a session cookie being refused for its Max-Age=0.
  it('still accepts the expiry a browser sign-out sets', () => {
    const expired = [
      'melarc_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
      'melarc_csrf=; Max-Age=0; Path=/; Secure; SameSite=Lax',
    ];
    expect(
      validator
        .validateResponse(
          'signOut',
          response({ status: 204, headers: { 'set-cookie': expired } }),
          {
            headers: { cookie: 'melarc_session=S' },
          },
        )
        .filter((violation) => violation.in === 'response-cookie'),
    ).toEqual([]);
  });

  // Break caught: a vendor sign-in that stops renewing the device credential, or renews it for a different time.
  it('has each vendor sign-in renew the device credential for 400 days', () => {
    expect(cookies('vendorSignIn', 200, [SESSION, CSRF, DEVICE])).toEqual([]);
    expect(cookies('vendorSignIn', 200, [SESSION, CSRF])).toEqual([
      { in: 'response-cookie', pointer: 'melarc_vendor_device', rule: 'required' },
    ]);
    expect(
      cookies('vendorSignIn', 200, [
        SESSION,
        CSRF,
        'melarc_vendor_device=D; Max-Age=86400; Path=/; HttpOnly; Secure; SameSite=Lax',
      ]),
    ).toEqual([{ in: 'response-cookie', pointer: 'melarc_vendor_device', rule: 'max-age' }]);
    expect(
      cookies('vendorSignIn', 200, [
        SESSION,
        CSRF,
        'melarc_vendor_device=D; Max-Age=34560000; Path=/; Secure; SameSite=Lax',
      ]),
    ).toEqual([{ in: 'response-cookie', pointer: 'melarc_vendor_device', rule: 'httponly' }]);
  });

  describe('completeCredentialRecovery', () => {
    // Break caught: a vendor recovery that leaves the vendor's browser without the credential that replaced the one
    // it just revoked.
    it('must set the device cookie on a vendor 204, and reports it when it does not', () => {
      const vendor = { principalType: 'VENDOR' };

      expect(cookies('completeCredentialRecovery', 204, [DEVICE], vendor)).toEqual([]);
      expect(cookies('completeCredentialRecovery', 204, undefined, vendor)).toEqual([
        { in: 'response-cookie', pointer: 'melarc_vendor_device', rule: 'required' },
      ]);
      expect(
        cookies(
          'completeCredentialRecovery',
          204,
          ['melarc_vendor_device=D; Path=/; HttpOnly; Secure; SameSite=Lax'],
          vendor,
        ),
      ).toEqual([{ in: 'response-cookie', pointer: 'melarc_vendor_device', rule: 'max-age' }]);
    });

    // Break caught: a staff recovery giving a staff member's browser a vendor device credential.
    it('must set no cookie on a staff 204, and reports one that does', () => {
      const staff = { principalType: 'STAFF' };

      expect(cookies('completeCredentialRecovery', 204, undefined, staff)).toEqual([]);
      expect(cookies('completeCredentialRecovery', 204, [DEVICE], staff)).toEqual([
        { in: 'response-cookie', pointer: 'melarc_vendor_device', rule: 'undeclared' },
      ]);
      expect(cookies('completeCredentialRecovery', 204, [SESSION, CSRF], staff)).toEqual([
        { in: 'response-cookie', pointer: 'melarc_csrf', rule: 'undeclared' },
        { in: 'response-cookie', pointer: 'melarc_session', rule: 'undeclared' },
      ]);
    });

    it('cannot be judged without knowing whose answer it is', () => {
      expect(() => cookies('completeCredentialRecovery', 204, [DEVICE])).toThrow(
        /completeCredentialRecovery.*x-set-cookies-when/,
      );
    });
  });
});

describe('I17: the canonical form of a work email', () => {
  it.each([
    ['StaffSignIn', 'email'],
    ['StaffIdentityCreate', 'work_email'],
    ['StaffIdentity', 'work_email'],
  ] as const)('%s.%s states it', (name, field) => {
    expect(flat(property(name, field).description)).toMatch(
      /canonical form: trimmed, Unicode NFKC-normalised and lower-cased as a whole address, with no dot or plus-tag folding.*stored and displayed as entered/,
    );
  });

  it('states it for the identifier of a recovery request, which may be a work email', () => {
    expect(flat(property('RecoveryRequestCreate', 'identifier').description)).toMatch(
      /work email is read in its canonical form: trimmed, Unicode NFKC-normalised and lower-cased/,
    );
  });

  // Break caught: a `format: email` on the schema, which refuses a padded or non-ASCII address before the server can
  // trim and normalise it, so the canonical form could never be applied to what a caller really typed.
  it.each([
    ['StaffSignIn', 'email'],
    ['StaffIdentityCreate', 'work_email'],
    ['StaffIdentity', 'work_email'],
  ] as const)('%s.%s carries no format of its own', (name, field) => {
    expect(property(name, field).format).toBeUndefined();
  });

  it.each([
    ['StaffSignIn', 'email'],
    ['StaffIdentityCreate', 'work_email'],
  ] as const)(
    '%s.%s says the address is canonicalised first and its shape checked after',
    (name, field) => {
      expect(flat(property(name, field).description)).toMatch(
        /canonicalised first and only then checked to be an email address.*`VALIDATION_FAILED`.*no `format: email`/,
      );
    },
  );

  // Break caught: the schema judging the raw text, so that a padded or upper-case address is refused with 400 where the
  // decision is that it is trimmed and lower-cased.
  it.each(['  Ada.Lovelace@Example.COM  ', 'ADA@EXAMPLE.COM', 'ａｄａ@example.com'])(
    'lets the raw address %j through to be canonicalised',
    (email) => {
      expect(
        validator.validateRequest(
          'staffSignIn',
          request({ body: { email, password: 'correct horse battery' } }),
        ),
      ).toEqual([]);
      expect(
        validator.validateRequest(
          'createStaffIdentity',
          request({
            headers: { 'idempotency-key': 'key-1' },
            body: { work_email: email, full_name: 'Ada Lovelace', role_bundle_id: UUID },
          }),
        ),
      ).toEqual([]);
    },
  );
});

describe('I20: mechanical corrections', () => {
  // Break caught: the order the three other documents and AC-SLICE-000-109 give being the contract's reverse again.
  it('has riderSignIn check the status before the lock', () => {
    const said = description('riderSignIn');
    const status = said.indexOf('a status other than `ACTIVE` is `INVALID_CREDENTIALS`');
    const lock = said.indexOf('a locked rider is `CREDENTIAL_LOCKED`');

    expect(status).toBeGreaterThan(0);
    expect(lock).toBeGreaterThan(status);
    expect(said).toMatch(/\(4\) With a valid signature, a status other than `ACTIVE`/);
    expect(said).toMatch(/\(5\) With a valid signature and an `ACTIVE` status, a locked rider/);
    expect(said).toMatch(/\(6\) Otherwise a wrong PIN is `INVALID_CREDENTIALS` and counts/);
  });

  it('has requestRiderSignInChallenge answer a bad request with its 400', () => {
    expect(codes('requestRiderSignInChallenge')).toContain('VALIDATION_FAILED');
    expect(statuses('requestRiderSignInChallenge')).toEqual(['200', '400', '429']);
    expect(
      validator.validateRequest(
        'requestRiderSignInChallenge',
        request({ body: { phone: '+233200000000', extra: true } }),
      ),
    ).toEqual([{ in: 'body', pointer: '', rule: 'additionalProperties' }]);
  });
});

describe('I21: the contract decisions of 8 October 2026 (SLICE-000-FINAL-DECISIONS C-01 to C-10)', () => {
  const BROWSER_PRE_SESSION = [
    'staffSignIn',
    'completeStaffMfaSignIn',
    'completeStaffCredentialSetup',
    'completeMfaEnrolment',
    'beginMfaReenrolment',
    'requestCredentialRecovery',
    'completeCredentialRecovery',
    'vendorSignIn',
    'completeVendorCredentialSetup',
    'completeAdditionalDeviceEnrolment',
  ];
  const NATIVE_RIDER = [
    'requestRiderSignInChallenge',
    'riderSignIn',
    'completeRiderDeviceEnrolment',
  ];
  const ISSUING = [
    'approveStaffIdentity',
    'resetStaffMfa',
    'reissueStaffCredentialSetup',
    'reissueVendorCredentialSetup',
    'requestAdditionalDeviceGrant',
    'recoverStaffCredential',
    'recoverVendorCredential',
    'decideVendorOrganization',
  ];

  // Break caught: a malformed body to one of these operations having no declared answer, so the generated client
  // and the validator disagree about what the server may say.
  it.each([
    'approveStaffIdentity',
    'reissueStaffCredentialSetup',
    'reissueVendorCredentialSetup',
    'resetStaffMfa',
    'beginMfaReenrolment',
  ])('C-01: %s declares VALIDATION_FAILED and its 400', (id) => {
    expect(codes(id)).toContain('VALIDATION_FAILED');
    expect(statuses(id)).toContain('400');
  });

  // Break caught: the impossible refusal staying declared, which a client would then be generated to handle.
  it('C-02: completeStaffCredentialSetup never answers MFA_ENROLMENT_REQUIRED', () => {
    expect(codes('completeStaffCredentialSetup')).not.toContain('MFA_ENROLMENT_REQUIRED');
    expect(description('completeStaffCredentialSetup')).toMatch(
      /never refuses a privileged identity for lacking a factor/,
    );
  });

  // Break caught: the additional-device ceiling keyed on a grant that does not exist yet.
  it('C-04: requestAdditionalDeviceGrant is keyed on the authenticated vendor account in the recovery bucket', () => {
    expect(description('requestAdditionalDeviceGrant')).toMatch(
      /per authenticated vendor account, in the `rate_limit_recovery` bucket.*never a grant that does not exist yet/,
    );
    expect(description('requestAdditionalDeviceGrant')).not.toMatch(/signin_max_attempts/);
  });

  // Break caught: Platform Admin status alone standing in for the explicit grant and its hub scope.
  it('C-05: registerRiderDevice is held by Senior Ops or an explicitly granted Platform Admin', () => {
    expect(description('registerRiderDevice')).toMatch(
      /Senior Ops, or a Platform Admin who holds an explicit grant of the key that reaches the rider's hub.*Platform Admin status alone is not a bypass/,
    );
  });

  describe('C-06: the current-session display projection', () => {
    const base = {
      id: UUID,
      principal_type: 'STAFF',
      state: 'ACTIVE',
      expires_at: '2026-10-08T20:00:00Z',
    };
    const display = {
      principal_display_name: 'Ada Lovelace',
      authorized_hubs: [{ id: UUID, display_name: 'Accra Hub' }],
    };
    const readCurrent = (body: JsonObject) =>
      validator.validateResponse('getCurrentSession', response({ body }));
    const ref = (value: unknown): unknown => (isJsonObject(value) ? value.$ref : undefined);
    const okSchema = (id: string): JsonObject => {
      const answer = (operation(id).responses as JsonObject)['200'] as JsonObject;
      return ((answer.content as JsonObject)['application/json'] as JsonObject)
        .schema as JsonObject;
    };

    // Break caught: the display fields reaching another principal's session through reuse of the shared schema.
    it('keeps the display fields out of the record and the ordinary projection and in a schema of their own', () => {
      const properties = Object.keys(schema('SessionRecord').properties as JsonObject);

      expect(properties).not.toContain('principal_display_name');
      expect(properties).not.toContain('authorized_hubs');
      expect(Object.keys(schema('SessionDisplay').properties as JsonObject).toSorted()).toEqual([
        'authorized_hubs',
        'principal_display_name',
      ]);
      expect(schema('Session').allOf).toEqual([{ $ref: '#/components/schemas/SessionRecord' }]);
      expect(schema('Session').unevaluatedProperties).toBe(false);
      expect(schema('CurrentSession').allOf).toEqual([
        { $ref: '#/components/schemas/SessionRecord' },
        { $ref: '#/components/schemas/SessionDisplay' },
      ]);
      expect(schema('CurrentSession').unevaluatedProperties).toBe(false);
    });

    // Break caught: the mapping drifting, so that listSessions or revokeSession gains a name or a hub list.
    it.each([
      ['getCurrentSession', 'CurrentSession'],
      ['staffSignIn', 'CurrentSession'],
      ['completeStaffMfaSignIn', 'CurrentSession'],
      ['vendorSignIn', 'CurrentSession'],
      ['revokeSession', 'Session'],
    ])('returns %s as %s', (id, name) => {
      expect(ref(okSchema(id))).toBe('#/components/schemas/' + name);
    });

    it('returns a listed session as plain Session', () => {
      const body = okSchema('listSessions');
      const items = (body.properties as JsonObject).items as JsonObject;

      expect(ref(items.items)).toBe('#/components/schemas/Session');
    });

    it('has the rider issuance response carry the current session', () => {
      expect(ref(property('RiderSessionIssued', 'session'))).toBe(
        '#/components/schemas/CurrentSession',
      );
    });

    // Break caught: one display field being optional, so that a client cannot tell "no hubs" from "not sent".
    it('requires both display fields on the current session', () => {
      expect(schema('SessionDisplay').required).toEqual([
        'principal_display_name',
        'authorized_hubs',
      ]);
      expect(readCurrent({ ...base, ...display })).toEqual([]);
      expect(readCurrent({ ...base, authorized_hubs: [] })).toEqual([
        { in: 'response-body', pointer: '/principal_display_name', rule: 'required' },
      ]);
      expect(readCurrent({ ...base, principal_display_name: 'Ada' })).toEqual([
        { in: 'response-body', pointer: '/authorized_hubs', rule: 'required' },
      ]);
      expect(
        readCurrent(base)
          .map((violation) => violation.pointer)
          .toSorted(),
      ).toEqual(['/authorized_hubs', '/principal_display_name']);
    });

    it('uses null for a principal without a name and an empty list for one without hubs', () => {
      expect(readCurrent({ ...base, principal_display_name: null, authorized_hubs: [] })).toEqual(
        [],
      );
    });

    // Break caught: a hub entry carrying more than the id and name, which is how bundle or policy detail leaks.
    it('refuses a hub entry with anything else, or without both fields', () => {
      expect(
        readCurrent({
          ...base,
          principal_display_name: null,
          authorized_hubs: [{ id: UUID, display_name: 'Accra', policy: 'x' }],
        }),
      ).toEqual([
        { in: 'response-body', pointer: '/authorized_hubs/0', rule: 'additionalProperties' },
      ]);
      expect(
        readCurrent({
          ...base,
          principal_display_name: null,
          authorized_hubs: [{ id: UUID }],
        }),
      ).toEqual([
        { in: 'response-body', pointer: '/authorized_hubs/0/display_name', rule: 'required' },
      ]);
    });

    // Break caught: a current session that also carries a field nobody declared, which the closed projection exists
    // to refuse.
    it('refuses an undeclared field on the current session', () => {
      expect(
        readCurrent({ ...base, ...display, token_hash: 'x' }).map((violation) => violation.rule),
      ).toContain('unevaluatedProperties');
    });

    // Break caught (the real response validation, not the schema text): an ordinary projection that carries the
    // caller-only display fields, or any field the contract does not declare.
    describe('ordinary projections reject the display fields in real response validation', () => {
      const listed = (item: JsonObject) =>
        validator.validateResponse('listSessions', response({ body: { items: [item] } }));
      const revoked = (item: JsonObject) =>
        validator.validateResponse('revokeSession', response({ body: item }));

      it('accepts a plain session in both', () => {
        expect(listed(base)).toEqual([]);
        expect(revoked(base)).toEqual([]);
      });

      it.each([
        ['principal_display_name', { principal_display_name: 'Ada Lovelace' }],
        ['authorized_hubs', { authorized_hubs: [] }],
        ['both display fields', display],
        ['an undeclared field', { token_hash: 'x' }],
      ])('refuses %s on listSessions', (_name, extra) => {
        expect(listed({ ...base, ...extra }).map((violation) => violation.rule)).toContain(
          'unevaluatedProperties',
        );
      });

      it.each([
        ['principal_display_name', { principal_display_name: 'Ada Lovelace' }],
        ['authorized_hubs', { authorized_hubs: [] }],
        ['an undeclared field', { token_hash: 'x' }],
      ])('refuses %s on revokeSession', (_name, extra) => {
        expect(revoked({ ...base, ...extra }).map((violation) => violation.rule)).toContain(
          'unevaluatedProperties',
        );
      });
    });

    // Break caught: an invented hub count becoming a contract constraint, or a list silently shortened to fit one.
    it('states no hub count and forbids silent truncation, leaving the number to the capacity task', () => {
      const hubs = property('SessionDisplay', 'authorized_hubs');
      const said = flat(hubs.description);

      expect(hubs.maxItems).toBeUndefined();
      expect(said).toMatch(/never silently truncated/);
      expect(said).toMatch(/capacity measurement owed before external exposure/);
    });
  });

  // Break caught: a native Rider operation refused for having no Origin, or a browser pre-session mutation with no
  // declared Origin refusal.
  it.each(BROWSER_PRE_SESSION)(
    'C-10: %s declares the Origin refusal as CSRF_VALIDATION_FAILED and a 403',
    (id) => {
      expect(codes(id)).toContain('CSRF_VALIDATION_FAILED');
      expect(statuses(id)).toContain('403');
    },
  );

  it.each(NATIVE_RIDER)('C-10: native %s declares no Origin refusal', (id) => {
    expect(codes(id)).not.toContain('CSRF_VALIDATION_FAILED');
    expect(statuses(id)).not.toContain('403');
  });

  describe('C-08: the version-1 QR payload', () => {
    const CHALLENGE = 'A'.repeat(43);
    const TOKEN = 'abc_DEF-123'.padEnd(43, 'x');
    const PAYLOAD = `melarc-rider://enrol/v1#token=${TOKEN}&challenge=${CHALLENGE}`;
    const grant = (enrolment_uri: string) =>
      validator.validateResponse(
        'registerRiderDevice',
        response({
          headers: { 'cache-control': 'no-store' },
          body: { enrolment_uri, expires_at: '2026-10-08T10:00:00Z' },
        }),
      );

    it('accepts the exact shape, which is exactly 127 characters', () => {
      expect(PAYLOAD).toHaveLength(127);
      expect(grant(PAYLOAD)).toEqual([]);
      expect(property('DeviceEnrolmentGrant', 'enrolment_uri').minLength).toBe(127);
      expect(property('DeviceEnrolmentGrant', 'enrolment_uri').maxLength).toBe(127);
    });

    // Break caught: a payload the Rider app would have to guess how to read, or one it would read without a bound.
    it.each([
      ['another version', PAYLOAD.replace('/v1#', '/v2#')],
      ['another scheme', PAYLOAD.replace('melarc-rider', 'https')],
      ['an upper-case scheme', PAYLOAD.replace('melarc-rider', 'MELARC-RIDER')],
      ['another host', PAYLOAD.replace('//enrol/', '//other/')],
      ['user-info', PAYLOAD.replace('//enrol/', '//user@enrol/')],
      ['a port', PAYLOAD.replace('//enrol/', '//enrol:8080/')],
      [
        'a padded challenge',
        PAYLOAD.replace(`challenge=${CHALLENGE}`, `challenge=${CHALLENGE.slice(1)}=`),
      ],
      ['a challenge one character short', PAYLOAD.slice(0, -1)],
      ['a challenge one character long', `${PAYLOAD}A`],
      ['a token one character short', PAYLOAD.replace(TOKEN, TOKEN.slice(1))],
      ['a token one character long', PAYLOAD.replace(TOKEN, `${TOKEN}x`)],
      ['a standard-base64 character', PAYLOAD.replace('abc_DEF', 'abc+DEF')],
      ['a percent-escape', PAYLOAD.replace('abc_DEF', 'abc%41DEF')],
      ['an extra field', `${PAYLOAD}&cb=x`],
      ['a reordered pair', `melarc-rider://enrol/v1#challenge=${CHALLENGE}&token=${TOKEN}`],
      ['a duplicate token', `melarc-rider://enrol/v1#token=${TOKEN}&token=${TOKEN}`],
      ['a query instead of a fragment', PAYLOAD.replace('#', '?')],
      ['a trailing newline', `${PAYLOAD}\n`],
    ])('refuses %s', (_name, uri) => {
      // A value can break the pattern and the length together: every violation must be about the field.
      const pointers = grant(uri).map((violation) => violation.pointer);

      expect(pointers.length).toBeGreaterThan(0);
      expect(new Set(pointers)).toEqual(new Set(['/enrolment_uri']));
    });
  });

  describe('C-09: the device-key protocol encodings', () => {
    const CHALLENGE = 'B'.repeat(43);
    const SIGNATURE = 'QUJD'.repeat(24);
    const signIn = (overrides: JsonObject) =>
      validator.validateRequest(
        'riderSignIn',
        request({
          body: {
            phone: '+233200000000',
            pin: '123456',
            challenge: CHALLENGE,
            device_signature: SIGNATURE,
            client_root_signal: 'UNKNOWN',
            ...overrides,
          },
        }),
      );

    it('accepts a canonical challenge and a canonical base64 signature', () => {
      expect(signIn({})).toEqual([]);
    });

    // Break caught: base64url or unpadded text standing in for the standard base64 the protocol fixes, or an
    // unbounded signature.
    it.each([
      ['a url-safe signature', { device_signature: 'QUJD-_8='.padEnd(96, 'Q') }],
      ['an unpadded signature', { device_signature: 'QUJDRA' }],
      ['an empty signature', { device_signature: '' }],
      [
        'a signature longer than a DER P-256 signature can be',
        { device_signature: 'QUJD'.repeat(25) },
      ],
      ['a standard-base64 challenge', { challenge: `${'B'.repeat(42)}+` }],
      ['a padded challenge', { challenge: `${'B'.repeat(41)}==` }],
      ['a short challenge', { challenge: 'B'.repeat(42) }],
      ['a long challenge', { challenge: 'B'.repeat(44) }],
    ])('refuses %s', (_name, overrides) => {
      const violations = signIn(overrides);

      expect(violations.length).toBeGreaterThan(0);
      expect(new Set(violations.map((violation) => violation.in))).toEqual(new Set(['body']));
      expect(new Set(violations.map((violation) => violation.pointer)).size).toBe(1);
    });

    it('bounds a DER signature at 8 to 72 bytes, which is 12 to 96 characters', () => {
      expect(signIn({ device_signature: 'QUJD'.repeat(3) })).toEqual([]);
      expect(signIn({ device_signature: 'QUJD'.repeat(2) }).length).toBeGreaterThan(0);
    });

    it('takes a public key of exactly the 91-byte uncompressed SPKI, which is 124 characters', () => {
      const KEY = `${'A'.repeat(121)}A==`;
      const enrol = (public_key: string) =>
        validator.validateRequest(
          'completeRiderDeviceEnrolment',
          request({
            body: {
              setup_token: 'T'.repeat(43),
              public_key,
              pin: '123456',
              key_attestation: { certificate_chain: ['AAAA'] },
            },
          }),
        );

      expect(KEY).toHaveLength(124);
      expect(enrol(KEY)).toEqual([]);
      for (const bad of [KEY.slice(1), `${KEY}A`, `${'A'.repeat(121)}B==`, `${'A'.repeat(122)}=`]) {
        const pointers = enrol(bad).map((violation) => violation.pointer);

        expect(pointers.length, bad).toBeGreaterThan(0);
        expect(new Set(pointers), bad).toEqual(new Set(['/public_key']));
      }
    });

    it('states the signed bytes in riderSignIn', () => {
      expect(description('riderSignIn')).toMatch(
        /UTF-8 text `MELARC-RIDER-SIGNIN-V1`, one byte `0A`, and the challenge exactly as `requestRiderSignInChallenge` returned it/,
      );
    });

    it('has the challenge response carry the same canonical form', () => {
      const challenge = (value: string) =>
        validator.validateResponse(
          'requestRiderSignInChallenge',
          response({ body: { challenge: value, expires_at: '2026-10-08T10:00:00Z' } }),
        );
      expect(challenge(CHALLENGE)).toEqual([]);
      expect(challenge('short')).toEqual([
        { in: 'response-body', pointer: '/challenge', rule: 'pattern' },
      ]);
    });
  });

  // Break caught: a description going back to the retired model in which the provider is called inside the
  // transaction and a refusal rolls the act back.
  it.each(ISSUING)(
    'delivery: %s describes the durable queue and not a send inside the transaction',
    (id) => {
      const said = description(id);

      expect(said).toMatch(/queued as an encrypted, durable delivery job/);
      expect(said).not.toMatch(/inside this operation, before it commits/);
      expect(said).not.toMatch(/the operation is rolled back/);
    },
  );

  it('delivery: requestCredentialRecovery queues durably, caps live links and never returns CREDENTIAL_DELIVERY_FAILED', () => {
    expect(codes('requestCredentialRecovery')).not.toContain('CREDENTIAL_DELIVERY_FAILED');
    expect(description('requestCredentialRecovery')).toMatch(
      /The message is queued durably in the same transaction as the request and sent by a separate worker/,
    );
    expect(description('requestCredentialRecovery')).toMatch(
      /At most two unexpired, unconsumed recovery links/,
    );
  });

  it('replay: registerRiderDevice states the one bounded exception', () => {
    expect(description('registerRiderDevice')).toMatch(
      /the one operation whose replay returns a secret, and the exception is bounded/,
    );
  });
});

describe('I22: the review corrections of 8 October 2026', () => {
  const component = (kind: 'responses' | 'schemas', name: string): JsonObject =>
    ((CONTRACT.components as JsonObject)[kind] as JsonObject)[name] as JsonObject;

  // Break caught: Senior Ops, who holds the key, being able to create, alter or globally deactivate a system-managed
  // identity reason, which is one global row.
  it('upsertReasonDefinition refuses a lower tier for the identity reason domains', () => {
    expect(codes('upsertReasonDefinition')).toContain('INSUFFICIENT_AUTHORITY');
    expect(statuses('upsertReasonDefinition')).toContain('403');
    expect(description('upsertReasonDefinition')).toMatch(
      /six identity reason domains are system-managed and are a Platform Admin's alone.*changes only `label` and `active`.*Senior Ops\) is refused\s*`INSUFFICIENT_AUTHORITY`/,
    );
    expect(description('upsertReasonDefinition')).toMatch(
      /Creating a row in those domains, or changing a seeded reason's `code`, `domain`, `permitted_operations` or behaviour metadata, is refused with `VALIDATION_FAILED`/,
    );
  });

  // Break caught: replacement being widened to match first registration, or the difference being left unstated.
  it('states that replacement is narrower than first registration and is not widened', () => {
    expect(description('reregisterRiderDevice')).toMatch(
      /deliberately narrower than first registration's and is not widened.*own hub.*both tiers/,
    );
    expect(description('registerRiderDevice')).toMatch(
      /Platform Admin who holds an explicit grant of the key that reaches the rider's hub/,
    );
  });

  // Break caught: a verifier fault being answered as a device refusal, or a device refusal being relabelled as a fault.
  it('answers a verifier fault and stale trust data with one code and never relabels a verdict', () => {
    const said = flat(component('responses', 'TrustDataUnavailable').description);

    expect(said).toMatch(
      /older than the 24-hour maximum.*unreachable, overloaded or did not answer within its deadline/,
    );
    expect(said).toMatch(
      /A verdict is never relabelled.*`DEVICE_INTEGRITY_FAILED` or `DEVICE_SECURITY_UNSUPPORTED`.*a verifier fault is never either of those/,
    );
    expect(description('completeRiderDeviceEnrolment')).toMatch(/cannot answer in time/);
  });

  // Break caught: sign-in or another operation gaining a dependency on the verifier.
  it('lets only completeRiderDeviceEnrolment answer 503', () => {
    const withUnavailable: string[] = [];
    for (const item of Object.values(CONTRACT.paths as JsonObject)) {
      if (!isJsonObject(item)) continue;
      for (const candidate of Object.values(item)) {
        if (
          isJsonObject(candidate) &&
          isJsonObject(candidate.responses) &&
          '503' in candidate.responses
        ) {
          withUnavailable.push(
            typeof candidate.operationId === 'string' ? candidate.operationId : '(no operationId)',
          );
        }
      }
    }

    expect(withUnavailable).toEqual(['completeRiderDeviceEnrolment']);
  });

  // Break caught: the audit outcomes of a recovery request left ambiguous, so that a coalesced request is both
  // "written" and "creates nothing writes no event", or an unknown identifier leaves a trace of what was typed.
  it('has requestCredentialRecovery state ISSUED, COALESCED and excluded without ambiguity', () => {
    const said = description('requestCredentialRecovery');

    expect(said).toMatch(
      /writes exactly one `auth\.recovery\.requested`, `ISSUED` \(a new request and its delivery job were created\) or `COALESCED` \(the guard or the cap applied, so no link, token or job was created, and the event names the existing live request\); it says nothing about delivery/,
    );
    expect(said).toMatch(
      /matches no principal or no eligible one, one refused by the rate limit and one refused before the operation runs write \*\*no\*\* event and store no raw identifier, token or destination anywhere/,
    );
    expect(said).not.toMatch(/A request that creates nothing writes no event/);
  });

  // Break caught: an administrator's request that reuses a live request being reported as a new issue.
  it('lets an administrator recovery report that it was coalesced', () => {
    expect(property('RecoveryRequest', 'coalesced').readOnly).toBe(true);
    expect(description('recoverStaffCredential')).toMatch(
      /with `coalesced` true and records that it was coalesced/,
    );
    expect(description('recoverVendorCredential')).toMatch(
      /with `coalesced` true and records that it was coalesced/,
    );
  });

  // Break caught: the token's size left unbounded in the one place a person types or scans it.
  it('keeps every secret-bearing grant field a string and bounds the payload that carries one', () => {
    expect(schema('DeviceEnrolmentGrant').additionalProperties).toBe(false);
    expect(property('DeviceEnrolmentGrant', 'enrolment_uri').pattern).toBe(
      '^melarc-rider://enrol/v1#token=[A-Za-z0-9_-]{43}&challenge=[A-Za-z0-9_-]{43}$',
    );
  });
});

describe('I23: who may recover, and a completion racing an offboarding (recorded 9 October 2026)', () => {
  // Break caught: a link sent to a rejected profile's released work email, or to an offboarded identity, because a
  // request read the status before the lock or not at all, or answered an ineligible identifier differently.
  it('has requestCredentialRecovery send a link to an eligible principal only', () => {
    const said = description('requestCredentialRecovery');

    expect(said).toMatch(/Only an eligible principal is ever sent a link/);
    expect(said).toMatch(
      /A `PENDING_APPROVAL`, `REJECTED` or `OFFBOARDED` staff identity and any principal with no established credential are answered \*\*exactly as an unknown identifier\*\*: the same `202`, nothing created, no provider call and no audit event/,
    );
    expect(said).toMatch(/Eligibility is read after the identity's lock is held/);
    expect(codes('requestCredentialRecovery')).not.toContain('STATE_CONFLICT');
    expect(statuses('requestCredentialRecovery')).not.toContain('409');
  });

  // Break caught: a completion that changes the credential of an identity offboarded while it waited, or one that
  // tells the caller why it was refused.
  it('has completeCredentialRecovery refuse an offboarded identity as an invalid link and change nothing', () => {
    const said = description('completeCredentialRecovery');

    expect(said).toMatch(/A completion is judged under the identity's lock/);
    expect(said).toMatch(
      /requires a `PENDING`, unexpired request \*\*and\*\* an eligible identity, both read after the lock is held/,
    );
    expect(said).toMatch(
      /offboarded in the meantime the answer is the same `RECOVERY_TOKEN_INVALID`, no credential changes, no lock is cleared and no session is touched/,
    );
    expect(codes('completeCredentialRecovery')).toContain('RECOVERY_TOKEN_INVALID');
    expect(codes('completeCredentialRecovery')).not.toContain('STATE_CONFLICT');
  });

  // Break caught: an administrator's recovery created for a terminal or credential-less target, or refused with a
  // code the caller cannot branch on.
  it('has the administrator recoveries refuse an ineligible target with STATE_CONFLICT and its 409', () => {
    for (const id of ['recoverStaffCredential', 'recoverVendorCredential']) {
      expect(codes(id)).toContain('STATE_CONFLICT');
      expect(statuses(id)).toContain('409');
    }
    expect(description('recoverStaffCredential')).toMatch(
      /A `PENDING_APPROVAL`, `REJECTED` or `OFFBOARDED` identity, or one with no established password, is `STATE_CONFLICT` and nothing is created/,
    );
    expect(description('recoverVendorCredential')).toMatch(
      /An account that has no shared secret yet is `STATE_CONFLICT` and nothing is created/,
    );
  });

  // Break caught: the rule recorded in one owning document and contradicted by another.
  it('is recorded in every owning document the rule touches', () => {
    const recovery = document('features', 'identity', 'credential-recovery.md');
    const states = document('contracts', 'state-machines.md');
    const model = document('contracts', 'domain-model.md');
    const audit = document('contracts', 'audit.md');

    expect(recovery).toMatch(/### 5\.7 Who may recover, and a completion racing an offboarding/);
    expect(recovery).toMatch(
      /\*\*`REJECTED`\*\*: terminal, it never held a credential, and \*\*its work email is released\*\*/,
    );
    expect(recovery).toMatch(/\*\*`OFFBOARDED`\*\*: terminal, with access and credentials revoked/);
    expect(recovery).toMatch(
      /Whichever commits first, no offboarded identity is left with a usable link/,
    );
    expect(recovery).toMatch(
      /And a link that is still PENDING and unexpired but whose staff identity has since become OFFBOARDED/,
    );
    expect(recovery).toMatch(
      /And a request judged before the identity became OFFBOARDED is ISSUED/,
    );

    expect(states).toMatch(
      /every outstanding `RecoveryRequest` and `SetupGrant` of the identity ends `SUPERSEDED` and its delivery job is cancelled/,
    );
    expect(states).toMatch(
      /\| `PENDING → SUPERSEDED`\| System\| A newer grant of the same purpose was issued, \*\*or the principal was offboarded\*\*/,
    );
    expect(states).toMatch(
      /\*\*The offboarding transaction and the recovery operations meet at the identity lock\*\*/,
    );

    expect(model).toMatch(/\*\*A request exists only for an eligible principal\*\*/);
    expect(model).toMatch(/Offboarding a staff identity ends its `PENDING` grants the same way/);
    expect(audit).toMatch(
      /a `PENDING_APPROVAL`, `REJECTED` or `OFFBOARDED` staff identity never is/,
    );
  });

  // Break caught: a proof the documents promise and no row of the matrix names, or a coverage table that no longer
  // counts the rows it lists.
  it('names the proof as GBT-B15 and keeps the matrix coverage table equal to its rows', () => {
    const matrix = lines('standards', 'security-test-matrix.md');
    const rows = new Map<string, number>();
    const seen = new Set<string>();
    for (const [, family = '', ordinal = ''] of matrix.matchAll(/^\| `GBT-([A-Z]+)(\d+)`\|/gm)) {
      const id = family + ordinal;
      expect(seen.has(id), `GBT-${id} appears twice`).toBe(false);
      seen.add(id);
      rows.set(family, (rows.get(family) ?? 0) + 1);
    }

    expect(seen.has('B15')).toBe(true);
    expect(document('features', 'identity', 'credential-recovery.md')).toMatch(/`GBT-B15`/);

    const declared = new Map<string, number>();
    for (const [, family = '', count = '0'] of matrix.matchAll(
      /^\| ([A-Z]+) — [^|]+\| (\d+)\|/gm,
    )) {
      declared.set(family, Number(count));
    }
    expect(Object.fromEntries(declared)).toEqual(Object.fromEntries(rows));
    const total = String([...rows.values()].reduce((sum, count) => sum + count, 0));
    expect(matrix).toContain(`| **Total**| **${total}**||`);
  });
});

describe('I24: the reason catalogue reader and the reset-readiness projection (decided 9 October 2026)', () => {
  const IDENTITY_OPERATIONS = [
    'revokeSession',
    'approveStaffIdentity',
    'resetStaffMfa',
    'reissueStaffCredentialSetup',
    'reissueVendorCredentialSetup',
    'recoverStaffCredential',
    'recoverVendorCredential',
    'reregisterRiderDevice',
    'revokeRiderDevice',
  ];
  const BRANCHES = ['APPROVAL_REJECTED', 'FACTOR_ACTIVE', 'ENROLMENT_UNFINISHED'];
  const WRITABLE = ['code', 'domain', 'label', 'attribution', 'active', 'consumesDeliveryAttempt'];
  const without = (source: JsonObject, key: string): JsonObject =>
    Object.fromEntries(Object.entries(source).filter(([name]) => name !== key));
  const parameter = (name: string): JsonObject => {
    const found = (operation('listReasonDefinitions').parameters as JsonObject[]).find(
      (candidate) => candidate.name === name,
    );
    if (found === undefined) throw new Error(`No parameter ${name}`);
    return found;
  };
  const filtered = (query: Record<string, unknown>) =>
    validator.validateRequest('listReasonDefinitions', request({ query, hasBody: false }));
  const reason = (overrides: Record<string, unknown> = {}): JsonObject => ({
    code: 'SESSION_SECURITY_CONCERN',
    domain: 'SESSION_REVOCATION',
    label: 'Session security concern',
    attribution: 'MELARC',
    active: true,
    consumesDeliveryAttempt: false,
    permittedOperations: [{ operationId: 'revokeSession', branch: null }],
    ...overrides,
  });
  const listed = (body: unknown) =>
    validator.validateResponse('listReasonDefinitions', response({ body }));

  // Break caught: a picker that cannot ask for the reasons an operation accepts, so it fetches everything and filters
  // on the client, or a filter value the server would have to guess at.
  it('filters by operation and by branch over closed enumerations, and declares the 400', () => {
    expect(parameter('operation').required).toBe(false);
    expect((parameter('operation').schema as JsonObject).enum).toEqual(IDENTITY_OPERATIONS);
    expect(parameter('branch').required).toBe(false);
    expect((parameter('branch').schema as JsonObject).enum).toEqual(BRANCHES);
    expect(statuses('listReasonDefinitions')).toContain('400');
    expect(codes('listReasonDefinitions')).toEqual(
      expect.arrayContaining(['PERMISSION_DENIED', 'SESSION_INVALID', 'VALIDATION_FAILED']),
    );
    expect(description('listReasonDefinitions')).toMatch(
      /A `branch` without an `operation`, or a value outside either enumeration, is `VALIDATION_FAILED`/,
    );

    expect(filtered({ operation: 'resetStaffMfa', branch: 'FACTOR_ACTIVE' })).toEqual([]);
    expect(filtered({ operation: 'resetStaffMfa' })).toEqual([]);
    expect(filtered({})).toEqual([]);
    expect(filtered({ operation: 'deleteEverything' })).toHaveLength(1);
    expect(filtered({ operation: 'resetStaffMfa', branch: 'SOMETIMES' })).toHaveLength(1);
  });

  // Break caught: a filter enumeration that drifts from the registry it filters, or a seed row that is branch-qualified
  // by accident or not at all.
  it('keeps the enumerations equal to the seed table of domain-model §3.9, with exactly four qualified rows', () => {
    const section = lines('contracts', 'domain-model.md');
    const start = section.indexOf('| `code`| `domain`| `label`| `permitted_operations`|');
    expect(start).toBeGreaterThan(0);
    const rows = [
      ...section.slice(start).matchAll(/^\| `([A-Z_]+)`\| `([A-Z_]+)`\| [^|]+\| ([^|]+)\|$/gm),
    ];
    expect(rows).toHaveLength(12);

    const entries = new Map<string, string[]>();
    for (const [, code = '', , raw = ''] of rows) {
      entries.set(
        code,
        raw.split(',').map((part) => part.trim().replaceAll('`', '')),
      );
    }
    const operations = new Set([...entries.values()].flat().map((entry) => entry.split('#')[0]));
    const branches = new Set(
      [...entries.values()]
        .flat()
        .map((entry) => entry.split('#')[1])
        .filter((branch) => branch !== undefined),
    );
    expect([...operations].sort()).toEqual([...IDENTITY_OPERATIONS].sort());
    expect([...branches].sort()).toEqual([...BRANCHES].sort());

    const qualified = Object.fromEntries(
      [...entries].filter(([, list]) => list.some((entry) => entry.includes('#'))),
    );
    expect(qualified).toEqual({
      STAFF_DETAILS_INCORRECT: ['approveStaffIdentity#APPROVAL_REJECTED'],
      STAFF_CREATION_NOT_AUTHORISED: ['approveStaffIdentity#APPROVAL_REJECTED'],
      MFA_AUTHENTICATOR_UNAVAILABLE: ['resetStaffMfa#FACTOR_ACTIVE'],
      MFA_ENROLMENT_EXPIRED: ['resetStaffMfa#ENROLMENT_UNFINISHED'],
    });
  });

  // Break caught: permittedOperations optional or open, so a screen cannot rely on it, or accepted in a shape the
  // registry cannot produce.
  it('requires permittedOperations on every ReasonDefinition, read-only and closed', () => {
    const field = property('ReasonDefinition', 'permittedOperations');
    expect(schema('ReasonDefinition').required).toContain('permittedOperations');
    expect(field).toMatchObject({
      type: ['array', 'null'],
      readOnly: true,
      minItems: 1,
      uniqueItems: true,
    });
    expect(field.items).toMatchObject({
      type: 'object',
      required: ['operationId', 'branch'],
      additionalProperties: false,
    });

    expect(listed([reason()])).toEqual([]);
    expect(listed([reason({ permittedOperations: null })])).toEqual([]);
    expect(
      listed([
        reason({
          permittedOperations: [{ operationId: 'resetStaffMfa', branch: 'FACTOR_ACTIVE' }],
        }),
      ]),
    ).toEqual([]);

    const missing = without(reason(), 'permittedOperations');
    expect(listed([missing])).toEqual([
      { in: 'response-body', pointer: '/0/permittedOperations', rule: 'required' },
    ]);
    expect(listed([reason({ permittedOperations: [] })])).toHaveLength(1);
    expect(
      listed([
        reason({
          permittedOperations: [
            { operationId: 'revokeSession', branch: null },
            { operationId: 'revokeSession', branch: null },
          ],
        }),
      ]),
    ).toHaveLength(1);
    expect(
      listed([reason({ permittedOperations: [{ operationId: 'dropDatabase', branch: null }] })]),
    ).toHaveLength(1);
    expect(
      listed([
        reason({ permittedOperations: [{ operationId: 'resetStaffMfa', branch: 'EITHER' }] }),
      ]),
    ).toHaveLength(1);
    expect(
      listed([
        reason({
          permittedOperations: [{ operationId: 'resetStaffMfa', branch: null, note: 'extra' }],
        }),
      ]),
    ).toHaveLength(1);
  });

  // Break caught: the required, read-only field reaching the PUT body, where the validator treats readOnly as an
  // annotation, so every upsert would have to send what the server owns (decision W1).
  it('gives upsertReasonDefinition a write schema that carries every writable field and permittedOperations never', () => {
    const body = (operation('upsertReasonDefinition').requestBody as JsonObject)
      .content as JsonObject;
    const sent = (body['application/json'] as JsonObject).schema as JsonObject;
    expect(sent.$ref).toBe('#/components/schemas/ReasonDefinitionWrite');
    const ok = (operation('upsertReasonDefinition').responses as JsonObject)['200'] as JsonObject;
    const returned = ((ok.content as JsonObject)['application/json'] as JsonObject)
      .schema as JsonObject;
    expect(returned.$ref).toBe('#/components/schemas/ReasonDefinition');

    const write = schema('ReasonDefinitionWrite');
    expect(write.additionalProperties).toBe(false);
    expect(write.required).toEqual(WRITABLE);
    const inherited = without(
      schema('ReasonDefinition').properties as JsonObject,
      'permittedOperations',
    );
    expect(write.properties).toEqual(inherited);

    const put = (extra: Record<string, unknown>) =>
      validator.validateRequest(
        'upsertReasonDefinition',
        request({
          params: { code: 'SESSION_SECURITY_CONCERN' },
          body: {
            code: 'SESSION_SECURITY_CONCERN',
            domain: 'SESSION_REVOCATION',
            label: 'Session security concern',
            attribution: 'MELARC',
            active: true,
            consumesDeliveryAttempt: false,
            ...extra,
          },
        }),
      );
    expect(put({})).toEqual([]);
    expect(put({ permittedOperations: [{ operationId: 'revokeSession', branch: null }] })).toEqual([
      { in: 'body', pointer: '', rule: 'additionalProperties' },
    ]);
  });

  // Break caught: a screen choosing the reset branch from mfa_enrolled, which cannot tell the branches apart, or a
  // projection that is optional, writable or open-ended.
  it('carries mfa_reset_state on every StaffIdentity, required, read-only and closed', () => {
    expect(schema('StaffIdentity').required).toContain('mfa_reset_state');
    expect(property('StaffIdentity', 'mfa_reset_state')).toMatchObject({
      type: 'string',
      readOnly: true,
      enum: ['FACTOR_ACTIVE', 'ENROLMENT_UNFINISHED', 'NOT_ELIGIBLE'],
    });
    const resetBranches = BRANCHES.filter((branch) => branch !== 'APPROVAL_REJECTED');
    expect((property('StaffIdentity', 'mfa_reset_state').enum as string[]).slice(0, 2)).toEqual(
      resetBranches,
    );

    const staff: JsonObject = {
      id: UUID,
      work_email: 'a@example.test',
      full_name: 'A',
      status: 'ACTIVE',
      role_bundle_id: UUID,
      mfa_enrolled: true,
      mfa_reset_state: 'FACTOR_ACTIVE',
      created_by: UUID,
    };
    const read = (body: JsonObject) =>
      validator.validateResponse('getStaffIdentity', response({ body, headers: { etag: '"1"' } }));
    for (const state of ['FACTOR_ACTIVE', 'ENROLMENT_UNFINISHED', 'NOT_ELIGIBLE']) {
      expect(read({ ...staff, mfa_reset_state: state })).toEqual([]);
    }
    expect(read({ ...staff, mfa_reset_state: 'MAYBE' })).toEqual([
      { in: 'response-body', pointer: '/mfa_reset_state', rule: 'enum' },
    ]);
    const missing = without(staff, 'mfa_reset_state');
    expect(read(missing)).toEqual([
      { in: 'response-body', pointer: '/mfa_reset_state', rule: 'required' },
    ]);
  });

  // Break caught: a count in the slice document that no longer matches the criteria it totals or the operations it
  // names, which is how a 38th operation or a 126th criterion goes missing from the document that says what is built.
  it('keeps the slice document equal to the criteria headings and the operations it lists', () => {
    const slice = lines('delivery', 'slices', 'SLICE-000.md');
    const features = [
      'staff-authentication',
      'rider-authentication',
      'vendor-authentication',
      'credential-recovery',
      'permission-enforcement',
    ];
    const ids = new Set<string>();
    let total = 0;
    for (const feature of features) {
      const headings = [
        ...lines('features', 'identity', `${feature}.md`).matchAll(/^### `AC-SLICE-000-(\d+)`/gm),
      ].map((match) => match[1] ?? '');
      for (const id of headings) {
        expect(ids.has(id), `AC-SLICE-000-${id} appears in two features`).toBe(false);
        ids.add(id);
      }
      const row = new RegExp(`\\(../../features/identity/${feature}.md\\)\\| (\\d+)\\|`).exec(
        slice,
      );
      expect(row?.[1], feature).toBe(String(headings.length));
      total += headings.length;
    }
    const named = new Set<string>();
    for (const row of slice.matchAll(
      /^\| \[[a-z-]+\]\(\.\.\/\.\.\/features\/identity\/[a-z-]+\.md\)\| \d+\| (.+)\|$/gm,
    )) {
      for (const [, id = ''] of (row[1] ?? '').matchAll(/`(\w+)`/g)) {
        expect(named.has(id), `${id} is listed twice`).toBe(false);
        named.add(id);
        expect(() => operation(id), id).not.toThrow();
      }
    }
    expect(slice).toContain(`| **Total**| **${String(total)}**| **${String(named.size)}**|`);
    expect(named.has('listReasonDefinitions')).toBe(true);
  });

  // Break caught: the reader added to the contract and not to the five screens that need it, or the key left off the
  // row that tells the page what to name when it is refused.
  it('names the reader and its key on the five Ops routes that take a reason', () => {
    const portal = lines('surfaces', 'ops-portal.md');
    for (const route of [
      '/admin/staff/{id}',
      '/admin/staff/{id}/mfa/reset',
      '/admin/sessions',
      '/admin/vendors/{id}',
      '/admin/riders/{id}/device',
    ]) {
      const row = portal.split('\n').find((candidate) => candidate.startsWith(`| \`${route}\`|`));
      expect(row, route).toBeDefined();
      expect(row, route).toContain('`listReasonDefinitions`');
      expect(row, route).toContain('`settings.reason.read`');
    }
  });

  // Break caught: the decision recorded in the contract and contradicted, or left unrecorded, in the documents that own
  // the rule.
  it('is recorded in the documents that own the rule', () => {
    expect(document('contracts', 'state-machines.md')).toMatch(
      /The same rule is the read-only projection `StaffIdentity\.mfa_reset_state`/,
    );
    expect(document('contracts', 'domain-model.md')).toMatch(
      /`permitted_operations` is a text array whose entry is an `operationId` or `operationId#BRANCH`/,
    );
    expect(document('contracts', 'permissions.md')).toMatch(
      /Scope in practice\*\* \(Product decision, 9 October 2026, for `listReasonDefinitions`\)/,
    );
    expect(document('features', 'identity', 'permission-enforcement.md')).toMatch(
      /### `AC-SLICE-000-132` — The reason catalogue is readable for the operations and branches that take a reason, and by no one else/,
    );
    expect(document('delivery', 'IMPLEMENTATION_PLAN.md')).toMatch(
      /`upsertReasonDefinition` is proved against the identity reason domains/,
    );
  });
});
