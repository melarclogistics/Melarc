import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { PRE_SIGN_IN_FIELDS } from '../src/platform/auth/pre-sign-in-shape';

/**
 * The guards that judge the answers of the pre-sign-in operations (`src/platform/auth/pre-sign-in-shape.ts`) are runtime checks, not a
 * second description of the wire: the types of the answers are the generated ones. This test reads the contract and holds each guard to it,
 * the way `session-contract.test.ts` does for the session: every field a guard reads is a field of its schema, and every field the contract
 * requires of an answer is one the guard requires.
 */
const CONTRACT = resolve(import.meta.dirname, '../../../contracts/openapi.yaml');

interface Schema {
  readonly type?: string | readonly string[];
  readonly format?: string;
  readonly pattern?: string;
  readonly required?: readonly string[];
  readonly properties?: Record<string, Schema>;
  readonly $ref?: string;
  readonly additionalProperties?: boolean;
}

const document = parse(readFileSync(CONTRACT, 'utf8')) as {
  components: { schemas: Record<string, Schema> };
  paths: Record<string, Record<string, { operationId?: string; security?: unknown[] }>>;
};

function schemaNamed(name: string): { properties: Record<string, Schema>; required: string[] } {
  const schema = document.components.schemas[name];
  if (schema === undefined) throw new Error(`The contract has no schema ${name}`);
  return { properties: schema.properties ?? {}, required: [...(schema.required ?? [])] };
}

describe.each(Object.entries(PRE_SIGN_IN_FIELDS))(
  'the guard of %s and the contract',
  (name, fields) => {
    const schema = schemaNamed(name);

    // Break caught: a guard reading a field the contract does not have (a rename in the contract would leave it refusing every real answer).
    it('reads only fields that the schema has', () => {
      for (const field of [...fields.required, ...fields.optional]) {
        expect(Object.keys(schema.properties), field).toContain(field);
      }
    });

    // Break caught: the contract making a field mandatory that the guard treats as optional.
    it('requires every field that the contract requires of the answer', () => {
      for (const field of schema.required) {
        expect(fields.required, field).toContain(field);
      }
    });

    // Break caught: the guard requiring a field the contract says may be absent, which would refuse a real answer.
    it('requires only fields that the contract requires', () => {
      for (const field of fields.required) {
        expect(schema.required, field).toContain(field);
      }
    });
  },
);

describe('the shapes the guards assume', () => {
  it('has a challenge id that is a uuid and an expiry that is an instant', () => {
    const challenge = schemaNamed('MfaChallenge');
    expect(challenge.properties.challenge_id?.format).toBe('uuid');
    expect(challenge.properties.expires_at?.format).toBe('date-time');
  });

  it('has the continuation grant as a string, absent or null for an ordinary employee', () => {
    const result = schemaNamed('CredentialSetupResult');
    expect(result.properties.authentication_ready?.type).toBe('boolean');
    expect(result.properties.mfa_setup_token?.type).toEqual(['string', 'null']);
    expect(result.properties.mfa_provisioning).toBeDefined();
    expect(schemaNamed('MfaProvisioning').properties.otpauth_uri?.type).toBe('string');
    expect(schemaNamed('MfaReenrolmentBegun').properties.mfa_setup_token?.type).toBe('string');
  });

  // Break caught: a form that sends a code the schema would refuse, or a password the page checks against other bounds than the contract's.
  it('has the bounds that the page’s own checks are made from', () => {
    expect(schemaNamed('MfaSignInComplete').properties.code?.pattern).toBe('^[0-9]{6}$');
    expect(schemaNamed('MfaEnrolment').properties.totp_code?.pattern).toBe('^[0-9]{6}$');
    const setup = schemaNamed('CredentialSetup').properties.password as Schema & {
      minLength?: number;
      maxLength?: number;
    };
    expect(setup.minLength).toBe(12);
    expect(setup.maxLength).toBe(128);
    const signIn = schemaNamed('StaffSignIn').properties.password as Schema & {
      maxLength?: number;
    };
    expect(signIn.maxLength).toBe(128);
  });

  // Break caught: a screen that calls an operation the contract says needs a session, or a pre-session operation that is not anonymous
  // (the pages of this task are reached with no session at all).
  it('has all five operations as anonymous, pre-session ones', () => {
    const operations = new Map<string, { path: string; security: unknown[] | undefined }>();
    for (const [path, item] of Object.entries(document.paths)) {
      for (const operation of Object.values(item)) {
        if (operation.operationId !== undefined) {
          operations.set(operation.operationId, { path, security: operation.security });
        }
      }
    }
    for (const id of [
      'staffSignIn',
      'completeStaffMfaSignIn',
      'completeStaffCredentialSetup',
      'beginMfaReenrolment',
      'completeMfaEnrolment',
    ]) {
      const operation = operations.get(id);
      expect(operation, id).toBeDefined();
      expect(operation?.security, id).toEqual([]);
    }
    expect(operations.get('staffSignIn')?.path).toBe('/auth/staff/sign-in');
    expect(operations.get('completeStaffMfaSignIn')?.path).toBe('/auth/staff/sign-in/mfa');
    expect(operations.get('completeStaffCredentialSetup')?.path).toBe(
      '/auth/staff/setup/credential',
    );
    expect(operations.get('beginMfaReenrolment')?.path).toBe('/auth/staff/setup/mfa/begin');
    expect(operations.get('completeMfaEnrolment')?.path).toBe('/auth/staff/setup/mfa');
  });
});
