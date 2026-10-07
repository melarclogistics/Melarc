import { readFileSync } from 'node:fs';

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

  it('has resetStaffMfa refuse self-reset, a pending factor and a non-privileged target', () => {
    expect(codes('resetStaffMfa')).toEqual(
      expect.arrayContaining(['SELF_APPROVAL_FORBIDDEN', 'STATE_CONFLICT']),
    );
    expect(statuses('resetStaffMfa')).toEqual(expect.arrayContaining(['409', '422']));
    expect(description('resetStaffMfa')).toMatch(
      /Resetting one's own factor is `SELF_APPROVAL_FORBIDDEN`.*other bootstrap Platform Admin is a valid actor.*only `PENDING`.*non-privileged identity.*are `STATE_CONFLICT`/,
    );
  });

  // Break caught: a stranded bootstrap administrator (a password and a factor that is only PENDING) being left with no
  // route at all, because the reset refuses it and the provisioning command stopped for another administrator's sake.
  it('sends a stranded bootstrap administrator to the provisioning channel, not to the reset', () => {
    expect(description('resetStaffMfa')).toMatch(
      /only `PENDING`.*stranded bootstrap administrator.*provisioning channel/,
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
  };
  const read = (extra: JsonObject) =>
    validator.validateResponse('getCurrentSession', response({ body: { ...session, ...extra } }));

  it('has a read-only list of permission keys, optional, in the contract', () => {
    const permissions = property('Session', 'permissions');

    expect(permissions.type).toBe('array');
    expect(permissions.readOnly).toBe(true);
    expect(permissions.uniqueItems).toBe(true);
    expect(schema('Session').required).not.toContain('permissions');
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
