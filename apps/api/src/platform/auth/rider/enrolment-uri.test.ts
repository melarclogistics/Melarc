import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { isJsonObject, type JsonObject } from '../../contract/json.js';
import { locateContract } from '../../contract/locate-contract.js';
import {
  ENROLMENT_URI_LENGTH,
  ENROLMENT_URI_PATTERN,
  buildEnrolmentUri,
  isCanonicalBase64Url32,
  parseEnrolmentUri,
} from './enrolment-uri.js';

const TOKEN = 'A'.repeat(42) + 'A';
const CHALLENGE = 'B'.repeat(42) + 'A';
const GOOD = buildEnrolmentUri(TOKEN, CHALLENGE);
const RANDOM = () => randomBytes(32).toString('base64url');

const CONTRACT = parse(readFileSync(locateContract(import.meta.dirname), 'utf8')) as JsonObject;
const grantSchema = (): JsonObject => {
  const schemas = (CONTRACT.components as JsonObject).schemas as JsonObject;
  const grant = schemas.DeviceEnrolmentGrant;
  if (!isJsonObject(grant)) throw new Error('The contract has no DeviceEnrolmentGrant');
  return grant;
};
const uriSchema = (): JsonObject => {
  const properties = grantSchema().properties as JsonObject;
  return properties.enrolment_uri as JsonObject;
};

describe('the version-1 enrolment URI (SECURITY_DESIGN.md section 13.6; DeviceEnrolmentGrant)', () => {
  // Break caught: a payload of another length than the contract's 127 characters, which a scanner would still read but a handset would refuse.
  it('is exactly 127 ASCII characters, as the contract says', () => {
    const uri = buildEnrolmentUri(RANDOM(), RANDOM());
    expect(uri).toHaveLength(127);
    expect(ENROLMENT_URI_LENGTH).toBe(127);
    expect(uriSchema().minLength).toBe(127);
    expect(uriSchema().maxLength).toBe(127);
    // The point of the check is that no byte is outside printable ASCII.
    expect(/^[\x20-\x7e]+$/.test(uri)).toBe(true);
  });

  // Break caught: a builder that drifts from the pattern the contract validates a response against.
  it('matches the pattern of the contract', () => {
    expect(ENROLMENT_URI_PATTERN).toBe(uriSchema().pattern);
    const pattern = new RegExp(uriSchema().pattern as string);
    for (let index = 0; index < 50; index += 1) {
      expect(pattern.test(buildEnrolmentUri(RANDOM(), RANDOM()))).toBe(true);
    }
  });

  it('puts the exact scheme, host and path first, then the token, then the challenge', () => {
    expect(buildEnrolmentUri(TOKEN, CHALLENGE)).toBe(
      `melarc-rider://enrol/v1#token=${TOKEN}&challenge=${CHALLENGE}`,
    );
  });

  it('reads back exactly what it was built from', () => {
    for (let index = 0; index < 50; index += 1) {
      const token = RANDOM();
      const challenge = RANDOM();
      expect(parseEnrolmentUri(buildEnrolmentUri(token, challenge))).toEqual({ token, challenge });
    }
  });

  // Break caught: a builder that accepts a value it could not have made, so a malformed token reaches a QR code.
  it('refuses to build from a token or a challenge that is not 32 bytes in their one spelling', () => {
    const wrong = [
      '',
      'A'.repeat(42),
      'A'.repeat(44),
      `${'A'.repeat(42)}=`,
      `${'A'.repeat(42)}+`,
      `${'A'.repeat(42)}/`,
      // 43 characters of the alphabet whose last character carries bits that must be zero (the same 32 bytes spelled two ways)
      `${'A'.repeat(42)}B`,
      `${'A'.repeat(42)}Z`,
    ];
    for (const value of wrong) {
      expect(() => buildEnrolmentUri(value, CHALLENGE), value).toThrow(TypeError);
      expect(() => buildEnrolmentUri(TOKEN, value), value).toThrow(TypeError);
    }
  });
});

describe('the strict reader of the URI, against the published vectors', () => {
  interface UriVector {
    readonly name: string;
    readonly payload: string;
    readonly valid: boolean;
    readonly why?: string;
  }
  const FILE = JSON.parse(
    readFileSync(
      join(
        dirname(dirname(locateContract(import.meta.dirname))),
        'apps',
        'api',
        'test',
        'vectors',
        'enrolment-uri.v1.json',
      ),
      'utf8',
    ),
  ) as { format: string; vectors: UriVector[] };

  // Break caught: an empty or reshaped file read as "all vectors passed".
  it('are the version-1 file, with the valid payloads and a refusal for each way of being wrong', () => {
    expect(FILE.format).toBe('melarc.enrolment-uri-vectors.v1');
    expect(FILE.vectors.filter((vector) => vector.valid)).toHaveLength(2);
    expect(FILE.vectors.filter((vector) => !vector.valid).length).toBeGreaterThanOrEqual(70);
    expect(new Set(FILE.vectors.map((vector) => vector.name)).size).toBe(FILE.vectors.length);
  });

  // Break caught: a reader that is lenient about anything but the one form, which is how a handset ends up calling a host the QR named.
  it.each(FILE.vectors.map((vector) => [vector.name, vector] as const))(
    'agrees on: %s',
    (_name, vector) => {
      const parsed = parseEnrolmentUri(vector.payload);
      expect(parsed !== null, vector.why ?? '').toBe(vector.valid);
      if (parsed !== null) {
        expect(buildEnrolmentUri(parsed.token, parsed.challenge)).toBe(vector.payload);
      }
    },
  );

  it('refuses what is not text', () => {
    for (const value of [undefined, null, 127, {}, [GOOD], Buffer.from(GOOD)]) {
      expect(parseEnrolmentUri(value)).toBeNull();
    }
  });
});

describe('a value of 32 bytes in its one canonical spelling', () => {
  it('accepts the encodings of 32 bytes and nothing else', () => {
    for (let index = 0; index < 50; index += 1) expect(isCanonicalBase64Url32(RANDOM())).toBe(true);
    expect(isCanonicalBase64Url32('A'.repeat(43))).toBe(true);
    expect(isCanonicalBase64Url32('A'.repeat(42))).toBe(false);
    expect(isCanonicalBase64Url32(undefined)).toBe(false);
    expect(isCanonicalBase64Url32(42)).toBe(false);
  });
});
