import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ATTESTATION_INTEGRITY_CAUSES,
  ATTESTATION_UNAVAILABLE_CAUSES,
} from '../ports/attestation-verifier.port.js';
import { AttestationInterfaceError } from './attestation-errors.js';
import { MAX_ANSWER_BYTES, readVerifierAnswer } from './verifier-answer.js';

const JSON_TYPE = 'application/json; charset=utf-8';
const KEY = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  .publicKey.export({ type: 'spki', format: 'der' })
  .toString('base64');
const DIGEST = 'a'.repeat(64);

const summary = {
  security_level: 'TRUSTED_ENVIRONMENT',
  attestation_version: 300,
  key_mint_version: 300,
  package_name: 'com.melarc.rider',
  signer_digests: [DIGEST],
};
const verified = { version: 1, verdict: 'VERIFIED', attested_public_key: KEY, summary };

const bytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
};

const answer = (body: unknown, status = 200, contentType: string | null = JSON_TYPE) =>
  readVerifierAnswer({ status, contentType, body: bytes(body) });

/** The field an interface error names, or a failure when nothing was thrown. */
function fieldOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AttestationInterfaceError) return error.field;
    throw error;
  }
  throw new Error('expected an interface error, got an answer');
}

describe('the answer of the verifier service, read strictly', () => {
  describe('a verdict', () => {
    it('reads an accepted attestation with the key it attested and a summary that identifies no handset', () => {
      expect(answer(verified)).toEqual({
        verdict: 'VERIFIED',
        attestedPublicKey: KEY,
        summary: {
          securityLevel: 'TRUSTED_ENVIRONMENT',
          attestationVersion: 300,
          keyMintVersion: 300,
          packageName: 'com.melarc.rider',
          signerDigests: [DIGEST],
        },
      });
      expect(
        answer({ ...verified, summary: { ...summary, security_level: 'STRONG_BOX' } }),
      ).toMatchObject({ summary: { securityLevel: 'STRONG_BOX' } });
    });

    // Break caught: a cause renamed, dropped or invented on either side of the interface.
    it.each(ATTESTATION_INTEGRITY_CAUSES)('reads the integrity failure %s', (cause) => {
      expect(answer({ version: 1, verdict: 'DEVICE_INTEGRITY_FAILED', cause })).toEqual({
        verdict: 'DEVICE_INTEGRITY_FAILED',
        cause,
      });
    });

    it.each(ATTESTATION_UNAVAILABLE_CAUSES)('reads the unavailable verifier %s', (cause) => {
      expect(answer({ version: 1, verdict: 'TRUST_DATA_UNAVAILABLE', cause })).toEqual({
        verdict: 'TRUST_DATA_UNAVAILABLE',
        cause,
      });
    });

    it('reads a device that has no hardware-backed key', () => {
      expect(answer({ version: 1, verdict: 'DEVICE_SECURITY_UNSUPPORTED' })).toEqual({
        verdict: 'DEVICE_SECURITY_UNSUPPORTED',
      });
    });

    it('takes the media type with or without the charset, in any case, and no other', () => {
      for (const type of [
        'application/json',
        'Application/JSON',
        'application/json; charset=UTF-8',
        ' application/json ;charset=utf-8',
      ]) {
        expect(answer({ version: 1, verdict: 'DEVICE_SECURITY_UNSUPPORTED' }, 200, type)).toEqual({
          verdict: 'DEVICE_SECURITY_UNSUPPORTED',
        });
      }
    });
  });

  describe('an answer that breaks the interface is thrown, never read as a verdict', () => {
    const unsupported = { version: 1, verdict: 'DEVICE_SECURITY_UNSUPPORTED' };

    // Break caught: a lenient reader that takes whatever is close to a verdict for one.
    it.each([
      ['an unknown version', { ...unsupported, version: 2 }, 'body.version'],
      ['no version', { verdict: 'DEVICE_SECURITY_UNSUPPORTED' }, 'body.version'],
      ['a version as text', { ...unsupported, version: '1' }, 'body.version'],
      ['an unknown verdict', { version: 1, verdict: 'OK' }, 'body.verdict'],
      ['no verdict', { version: 1 }, 'body.verdict'],
      ['a verdict that is not text', { version: 1, verdict: 5 }, 'body.verdict'],
      ['an unknown member', { ...unsupported, note: 'x' }, 'body.unknown_member'],
      [
        'a cause on a verdict that has none',
        { ...unsupported, cause: 'CHAIN_INVALID' },
        'body.unknown_member',
      ],
      [
        'a cause outside the integrity set',
        { version: 1, verdict: 'DEVICE_INTEGRITY_FAILED', cause: 'TRUST_DATA_STALE' },
        'body.cause',
      ],
      [
        'a cause outside the unavailable set',
        { version: 1, verdict: 'TRUST_DATA_UNAVAILABLE', cause: 'CHAIN_INVALID' },
        'body.cause',
      ],
      [
        'an integrity failure with no cause',
        { version: 1, verdict: 'DEVICE_INTEGRITY_FAILED' },
        'body.cause',
      ],
      [
        'a lower-case cause',
        { version: 1, verdict: 'DEVICE_INTEGRITY_FAILED', cause: 'chain_invalid' },
        'body.cause',
      ],
      [
        'an accepted attestation with no key',
        { version: 1, verdict: 'VERIFIED', summary },
        'body.attested_public_key',
      ],
      [
        'an accepted attestation with no summary',
        { version: 1, verdict: 'VERIFIED', attested_public_key: KEY },
        'body.summary',
      ],
      [
        'a summary with an unknown member',
        { ...verified, summary: { ...summary, serial: '1' } },
        'body.unknown_member',
      ],
      [
        'a software security level',
        { ...verified, summary: { ...summary, security_level: 'SOFTWARE' } },
        'body.summary.security_level',
      ],
      [
        'a negative version',
        { ...verified, summary: { ...summary, attestation_version: -1 } },
        'body.summary.attestation_version',
      ],
      [
        'a fractional version',
        { ...verified, summary: { ...summary, key_mint_version: 1.5 } },
        'body.summary.key_mint_version',
      ],
      [
        'an empty package',
        { ...verified, summary: { ...summary, package_name: '' } },
        'body.summary.package_name',
      ],
      [
        'a package of 256 characters',
        { ...verified, summary: { ...summary, package_name: 'a'.repeat(256) } },
        'body.summary.package_name',
      ],
      [
        'no signer',
        { ...verified, summary: { ...summary, signer_digests: [] } },
        'body.summary.signer_digests',
      ],
      [
        'eleven signers',
        {
          ...verified,
          summary: { ...summary, signer_digests: Array.from({ length: 11 }, () => DIGEST) },
        },
        'body.summary.signer_digests',
      ],
      [
        'an upper-case digest',
        { ...verified, summary: { ...summary, signer_digests: ['A'.repeat(64)] } },
        'body.summary.signer_digests',
      ],
      [
        'a short digest',
        { ...verified, summary: { ...summary, signer_digests: ['a'.repeat(63)] } },
        'body.summary.signer_digests',
      ],
      [
        'a digest with a character past its 64',
        { ...verified, summary: { ...summary, signer_digests: [`${DIGEST}a`] } },
        'body.summary.signer_digests',
      ],
      [
        'a digest with a character before its 64',
        { ...verified, summary: { ...summary, signer_digests: [`a${DIGEST}`] } },
        'body.summary.signer_digests',
      ],
      [
        'a fractional attestation version',
        { ...verified, summary: { ...summary, attestation_version: 1.5 } },
        'body.summary.attestation_version',
      ],
      // Break caught: a verdict that is strict in one shape and lenient in another. Each of the four shapes refuses a member it does not
      // define, and a version that is not 1, so that a service that has moved on is a broken interface whatever it says.
      [
        'an unknown member on an accepted attestation',
        { ...verified, note: 'x' },
        'body.unknown_member',
      ],
      [
        'an unknown member on an integrity failure',
        { version: 1, verdict: 'DEVICE_INTEGRITY_FAILED', cause: 'CHAIN_INVALID', note: 'x' },
        'body.unknown_member',
      ],
      [
        'an unknown member on an unavailable verifier',
        { version: 1, verdict: 'TRUST_DATA_UNAVAILABLE', cause: 'VERIFIER_TIMEOUT', note: 'x' },
        'body.unknown_member',
      ],
      [
        'an unknown version on an accepted attestation',
        { ...verified, version: 2 },
        'body.version',
      ],
      [
        'an unknown version on an integrity failure',
        { version: 2, verdict: 'DEVICE_INTEGRITY_FAILED', cause: 'CHAIN_INVALID' },
        'body.version',
      ],
      [
        'an unknown version on an unavailable verifier',
        { version: 2, verdict: 'TRUST_DATA_UNAVAILABLE', cause: 'VERIFIER_TIMEOUT' },
        'body.version',
      ],
    ])('refuses %s', (_label, body, field) => {
      expect(fieldOf(() => answer(body))).toBe(field);
    });

    it.each([
      ['not base64', 'not a key'],
      ['an empty key', ''],
      ['the key with its padding left off', KEY.replace(/=+$/, '')],
      ['the key with a newline', `${KEY}\n`],
      ['a key of the right size and no key in it', Buffer.alloc(91).toString('base64')],
      [
        'an RSA key',
        generateKeyPairSync('rsa', { modulusLength: 2048 })
          .publicKey.export({ type: 'spki', format: 'der' })
          .toString('base64'),
      ],
      [
        'a P-384 key',
        generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
          .publicKey.export({ type: 'spki', format: 'der' })
          .toString('base64'),
      ],
      [
        'a compressed point',
        Buffer.concat([
          Buffer.from(KEY, 'base64').subarray(0, 26),
          Buffer.from([0x03]),
          Buffer.alloc(32, 1),
        ]).toString('base64'),
      ],
    ])('refuses an attested key that is %s', (_label, key) => {
      expect(fieldOf(() => answer({ ...verified, attested_public_key: key }))).toBe(
        'body.attested_public_key',
      );
    });

    it.each([
      ['bytes that are not text', Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), 'body.encoding'],
      [
        'a byte order mark',
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]),
        'body.json',
      ],
      ['text that is not json', '{"version":1,', 'body.json'],
      ['nothing', '', 'body.json'],
      ['two documents', '{"version":1,"verdict":"DEVICE_SECURITY_UNSUPPORTED"}{}', 'body.json'],
      ['an array', '[]', 'body'],
      ['null', 'null', 'body'],
      ['a string', '"DEVICE_SECURITY_UNSUPPORTED"', 'body'],
    ])('refuses %s', (_label, body, field) => {
      expect(
        fieldOf(() =>
          readVerifierAnswer({ status: 200, contentType: JSON_TYPE, body: bytes(body) }),
        ),
      ).toBe(field);
    });

    it.each([
      null,
      '',
      'text/plain',
      'text/html; charset=utf-8',
      'application/jsonp',
      'application/json; charset=latin1',
      'application/x-json',
      'application/json, text/plain',
    ])('refuses a verdict sent as %s', (type) => {
      expect(
        fieldOf(() => answer({ version: 1, verdict: 'DEVICE_SECURITY_UNSUPPORTED' }, 200, type)),
      ).toBe('content_type');
    });

    // Break caught: an error that echoes what the peer sent, in a service that handles certificates and keys.
    it('names a field of ours and never a value of the answer', () => {
      const leak = 'leak-me-0123456789';
      const bodies: unknown[] = [
        { version: leak, verdict: 'VERIFIED' },
        { version: 1, verdict: leak },
        { version: 1, verdict: 'DEVICE_INTEGRITY_FAILED', cause: leak },
        { version: 1, verdict: 'DEVICE_SECURITY_UNSUPPORTED', [leak]: 1 },
        { ...verified, attested_public_key: leak },
        { ...verified, summary: { ...summary, package_name: 5, signer_digests: [leak] } },
        `{"x":"${leak}"`,
      ];
      for (const body of bodies) {
        let thrown: unknown;
        try {
          answer(body);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(AttestationInterfaceError);
        const error = thrown as AttestationInterfaceError;
        expect(error.message).not.toContain(leak);
        expect(error.field).not.toContain(leak);
      }
    });
  });

  describe('the status says what the answer is', () => {
    const body = { version: 1, verdict: 'DEVICE_SECURITY_UNSUPPORTED' };
    const overloaded = {
      version: 1,
      verdict: 'TRUST_DATA_UNAVAILABLE',
      cause: 'VERIFIER_OVERLOADED',
    };

    it('reads the service’s own refusals when they come as 503 with the verdict of an unavailable verifier', () => {
      for (const cause of ['VERIFIER_OVERLOADED', 'VERIFIER_TIMEOUT'] as const) {
        expect(answer({ version: 1, verdict: 'TRUST_DATA_UNAVAILABLE', cause }, 503)).toEqual({
          verdict: 'TRUST_DATA_UNAVAILABLE',
          cause,
        });
      }
    });

    // Break caught: a proxy’s 503 page read as the verifier saying something, or a device verdict accepted under an error status.
    it.each([
      ['a 503 with a page', '<html>busy</html>', 503, 'text/html'],
      ['a 503 with no body', '', 503, null],
      ['a 503 with a verdict of a device', body, 503, JSON_TYPE],
      [
        'a 503 with a verdict that breaks the interface',
        { version: 1, verdict: 'NOPE' },
        503,
        JSON_TYPE,
      ],
      ['a 500 from the service itself', { version: 1, error: 'INTERNAL' }, 500, JSON_TYPE],
      ['a 502', 'bad gateway', 502, 'text/plain'],
      ['a 504', '', 504, null],
      ['a 599', '', 599, null],
      // Break caught: the verdict of an unavailable verifier read from anything but the service's own 503 (a proxy in front of it can send any
      // body): its cause is the service's word only when the service says it with the status and the media type it uses.
      ['a 500 with the verdict of an unavailable verifier', overloaded, 500, JSON_TYPE],
      ['a 502 with the verdict of an unavailable verifier', overloaded, 502, JSON_TYPE],
      ['a 503 with that verdict and no media type', overloaded, 503, null],
      ['a 503 with that verdict sent as text', overloaded, 503, 'text/plain'],
    ])('treats %s as a verifier that did not answer', (_label, content, status, type) => {
      expect(answer(content, status, type)).toEqual({
        verdict: 'TRUST_DATA_UNAVAILABLE',
        cause: 'VERIFIER_UNREACHABLE',
      });
    });

    // Break caught: evidence the service will not read for its size taken as a broken interface. The size of the chain is the caller's, the
    // API accepts a body up to 100 KiB and the service reads 64 KiB by default, so a request only too big would be a 500 that anyone can ask for
    // and an alert for nothing. It is a chain that is oversized, which is a malformed one (§15.2.1, step 1), whatever the body of the refusal is.
    it.each([
      ['the service’s own refusal', { version: 1, error: 'REQUEST_TOO_LARGE' }, JSON_TYPE],
      ['a proxy’s page', '<html>too large</html>', 'text/html'],
      ['no body', '', null],
    ])('reads a 413 with %s as a malformed chain', (_label, content, type) => {
      expect(answer(content, 413, type)).toEqual({
        verdict: 'DEVICE_INTEGRITY_FAILED',
        cause: 'EVIDENCE_MALFORMED',
      });
    });

    it.each([
      [301, 'status.redirect'],
      [302, 'status.redirect'],
      [307, 'status.redirect'],
      [399, 'status.redirect'],
      [400, 'status.refused'],
      [401, 'status.refused'],
      [403, 'status.refused'],
      [404, 'status.refused'],
      [405, 'status.refused'],
      [415, 'status.refused'],
      [429, 'status.refused'],
      [499, 'status.refused'],
      [100, 'status'],
      [201, 'status'],
      [204, 'status'],
      [206, 'status'],
    ])('does not read status %i as an answer', (status, field) => {
      expect(fieldOf(() => answer(body, status))).toBe(field);
    });

    it('holds the cap of an answer', () => {
      expect(MAX_ANSWER_BYTES).toBe(16 * 1024);
    });
  });
});
