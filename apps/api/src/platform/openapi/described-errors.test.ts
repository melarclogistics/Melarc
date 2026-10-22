import 'reflect-metadata';

import { DECORATORS } from '@nestjs/swagger';
import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../http/error-codes.js';
import { DescribeErrors, ERROR_BODY_SCHEMA } from './described-errors.js';

class Probe {
  @DescribeErrors(
    ErrorCode.ValidationFailed,
    ErrorCode.SetupGrantInvalid,
    ErrorCode.RateLimited,
    ErrorCode.CsrfValidationFailed,
    ErrorCode.MfaProofInvalid,
  )
  everything(): string {
    return 'declared';
  }
}

/** The handler as the decorators see it, taken from the prototype's descriptor so that it is not read as a loose method. */
const handler = (): object =>
  Object.getOwnPropertyDescriptor(Probe.prototype, 'everything')?.value as object;

const responses = (): Record<string, { schema: unknown }> =>
  Reflect.getMetadata(DECORATORS.API_RESPONSE, handler()) as Record<string, { schema: unknown }>;

describe('the errors an operation describes (S0.31)', () => {
  // Break caught: a status typed beside a code instead of read from the code's own table, so an operation could declare a code with the
  // wrong status, or a status for none; the three codes here are a 400, a 403, a 422 (twice) and a 429.
  it('declares one response for each status its codes are answered with, and no other', () => {
    expect(Object.keys(responses()).toSorted()).toEqual(['400', '403', '422', '429']);
  });

  it('carries the error envelope on each of them', () => {
    for (const response of Object.values(responses()))
      expect(response.schema).toBe(ERROR_BODY_SCHEMA);
  });

  // Break caught: an unsorted or incomplete list, which would make the comparison with the contract depend on the order written.
  it('states the codes it raises, sorted, as x-error-codes', () => {
    const extensions = Reflect.getMetadata(DECORATORS.API_EXTENSION, handler()) as Record<
      string,
      unknown
    >;

    expect(extensions['x-error-codes']).toEqual([
      'CSRF_VALIDATION_FAILED',
      'MFA_PROOF_INVALID',
      'RATE_LIMITED',
      'SETUP_GRANT_INVALID',
      'VALIDATION_FAILED',
    ]);
  });

  it('refuses a code whose status no document decides, a repeated code, and none at all', () => {
    expect(() => DescribeErrors(ErrorCode.SettingMissing)).toThrow(/No status is decided/);
    expect(() => DescribeErrors(ErrorCode.RateLimited, ErrorCode.RateLimited)).toThrow(TypeError);
    expect(() => DescribeErrors()).toThrow(TypeError);
  });

  // Break caught: an envelope that names a code the catalogue does not have, or leaves one out.
  it('describes the envelope with every code of the catalogue and the four members of the contract', () => {
    expect(ERROR_BODY_SCHEMA.required).toEqual(['code', 'message', 'request_id']);
    expect(Object.keys(ERROR_BODY_SCHEMA.properties).toSorted()).toEqual([
      'code',
      'details',
      'message',
      'request_id',
    ]);
    expect([...ERROR_BODY_SCHEMA.properties.code.enum]).toEqual(
      Object.values(ErrorCode).toSorted(),
    );
  });
});
