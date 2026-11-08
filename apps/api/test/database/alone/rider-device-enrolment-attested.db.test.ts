// Runs alone: it builds and starts the real verifier (Gradle and a JVM), which is too heavy to run beside other files.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { grantRow, insertGrant } from '../support/credentials.js';
import {
  deviceKey,
  insertRider,
  insertRiderDevice,
  randomToken,
  riderRow,
  type RiderRow,
} from '../support/riders.js';
import { API, HUB_A, codeOf, startStaffRoutes, type StaffRoutes } from '../support/staff-routes.js';
import { startVerifierService, type RunningVerifier } from '../support/verifier-service.js';

/**
 * S0.57 (J), `completeRiderDeviceEnrolment` against **the real verifier service** on chains it did not make (AC-SLICE-000-60 to -66, -70, -55):
 * the JVM of `apps/attestation-verifier`, started from its build with the settings a deployment gives it, and the chains of its own
 * deterministic fixtures (`apps/api/test/vectors/attestation-chains.v1.json`, made by `AttestationVectors.kt` and held to the fixtures by
 * `AttestationVectorsTest`). For each class of evidence the criteria name there is a chain here; the API sends it as a handset would, and what
 * the service decides is what the API answers, with the cause class in the ledger and nothing in the response but the class of refusal.
 *
 * The grant of each case is arranged to carry the hash of the challenge the case's chain attested (the QR of a real ceremony carries a fresh
 * challenge the chain could not have been made for), which is the one thing a ceremony does that a fixture cannot. Everything after it is the
 * real operation: the real application, the real database, the real service.
 */
interface Case {
  readonly name: string;
  readonly description: string;
  readonly certificate_chain: readonly string[];
  readonly challenge: string;
  readonly device_public_key: string;
  readonly expected: {
    readonly verdict: 'VERIFIED' | 'DEVICE_INTEGRITY_FAILED' | 'DEVICE_SECURITY_UNSUPPORTED';
    readonly cause?: string;
    readonly security_level?: string;
    readonly signer_digests?: readonly string[];
  };
}
interface Vectors {
  readonly version: number;
  readonly service: {
    readonly package_name: string;
    readonly signing_digests: readonly string[];
    readonly accepted_roots: readonly string[];
    readonly revoked_serials: readonly string[];
  };
  readonly cases: readonly Case[];
}
const VECTORS = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../vectors/attestation-chains.v1.json'), 'utf8'),
) as Vectors;
const ENROL = `${API}/auth/rider/device/enrol`;
const PIN = '905731';

const settingsOf = (digests: readonly string[]) => ({
  packageName: VECTORS.service.package_name,
  signingDigests: digests,
  acceptedRoots: VECTORS.service.accepted_roots,
  revokedSerials: VECTORS.service.revoked_serials,
});
const fingerprints = (digests: readonly string[] | undefined): string =>
  (digests ?? [])
    .map((digest) => digest.slice(0, 16))
    .toSorted()
    .join(',');

/** One running application against one running service, and a way to enrol a case. */
class Rig {
  private constructor(
    readonly service: RunningVerifier,
    readonly routes: StaffRoutes,
  ) {}

  static async start(digests: readonly string[]): Promise<Rig> {
    const service = await startVerifierService(settingsOf(digests));
    try {
      const routes = await startStaffRoutes({
        env: {
          ATTESTATION_VERIFIER: 'service',
          ATTESTATION_VERIFIER_URL: service.url,
          ATTESTATION_VERIFIER_TIMEOUT_MS: '15000',
        },
      });
      return new Rig(service, routes);
    } catch (failure) {
      await service.stop();
      throw failure;
    }
  }

  async stop(): Promise<void> {
    await this.routes.stop();
    await this.service.stop();
  }

  rows<T extends object>(text: string, values: unknown[] = []): Promise<T[]> {
    return this.routes.rows<T>(text, values);
  }

  /** A rider with a pending first-binding grant whose challenge is the one the case's chain attested, and the handset's request with it. */
  async enrol(
    chain: Case,
    challenge: string = chain.challenge,
  ): Promise<{
    readonly rider: RiderRow;
    readonly grantId: string;
    readonly response: Awaited<
      ReturnType<ReturnType<StaffRoutes['kit']['client']['fork']>['post']>
    >;
  }> {
    const rider = await insertRider(
      this.routes.admin,
      riderRow({ fullName: `Attested ${chain.name}`, hubId: HUB_A }),
    );
    const officer = await this.routes.seniorOps(HUB_A);
    const token = randomToken();
    const grant = await insertGrant(
      this.routes.admin,
      grantRow({
        principalType: 'RIDER',
        principalId: rider.id,
        purpose: 'RIDER_DEVICE_ENROLMENT',
        tokenHash: token.hash,
        issuedBy: officer.identity.id,
        attestationChallengeHash: createHash('sha256')
          .update(Buffer.from(challenge, 'base64url'))
          .digest(),
      }),
    );
    const response = await this.routes.kit.client.fork().post(
      ENROL,
      {
        setup_token: token.token,
        public_key: chain.device_public_key,
        pin: PIN,
        key_attestation: { certificate_chain: [...chain.certificate_chain] },
      },
      { origin: null },
    );
    return { rider, grantId: grant.id, response };
  }

  async devices(riderId: string) {
    return this.rows<{ id: string; status: string; public_key: string }>(
      `select id, status, public_key from registered_device where rider_identity_id = $1`,
      [riderId],
    );
  }

  async grantState(id: string): Promise<string | undefined> {
    return (
      await this.rows<{ state: string }>(`select state from setup_grant where id = $1`, [id])
    )[0]?.state;
  }

  async eventDetail(riderId: string, code: string): Promise<Record<string, unknown>> {
    return (
      (
        await this.rows<{ detail: Record<string, unknown> }>(
          `select detail from audit_event where actor_type = 'RIDER' and actor_id = $1 and event_code = $2`,
          [riderId, code],
        )
      )[0]?.detail ?? {}
    );
  }
}

describe('the vectors the service is held to', () => {
  // Break caught: a vectors file that is not the one the service's build wrote (the Kotlin test holds it to the generator; this holds what
  // the Node side reads to the shape it relies on).
  it('are version 1 and name the classes of evidence the criteria do', () => {
    expect(VECTORS.version).toBe(1);
    expect(VECTORS.service.signing_digests).toHaveLength(2);
    expect(VECTORS.service.accepted_roots).toHaveLength(2);
    const names = VECTORS.cases.map((each) => each.name);
    for (const expected of [
      'valid_trusted_environment',
      'valid_strongbox',
      'software_attestation',
      'package_other',
      'unknown_root',
      'leaf_revoked',
      'challenge_other',
      'device_unlocked',
      'key_other_than_the_attested',
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe('completeRiderDeviceEnrolment against the real verifier service (AC-SLICE-000-60 to -66)', () => {
  let rig: Rig;
  beforeAll(async () => {
    // The first run in a checkout builds the service (Gradle), which takes minutes; the rest start it in seconds.
    rig = await Rig.start(VECTORS.service.signing_digests);
  }, 900_000);
  afterAll(async () => {
    await rig.stop();
  });

  // Break caught (one chain for each class of evidence; AC-SLICE-000-62 a package or a signer that is not ours, -63 a chain to no accepted root
  // or through a revoked certificate, -64 evidence for another challenge, -65 a device unlocked or not verified, -66 a key that is not the attested
  // one): the API answering other than the service decided, or a decision lost on its way
  // (the cause class missing from the ledger, a key registered that is not the one verified, a device or a PIN left by a refusal).
  it.each(VECTORS.cases.map((each) => [each.name, each] as const))(
    'answers as the service decides for %s',
    async (_name, chain) => {
      const { rider, grantId, response } = await rig.enrol(chain);
      const verdict = chain.expected.verdict;

      if (verdict === 'VERIFIED') {
        expect(response.status, response.text).toBe(200);
        expect((await rig.devices(rider.id)).map((each) => [each.status, each.public_key])).toEqual(
          [['ACTIVE', chain.device_public_key]],
        );
        expect(await rig.grantState(grantId)).toBe('CONSUMED');
        expect(await rig.eventDetail(rider.id, 'auth.device.registered')).toMatchObject({
          attested: true,
          security_level: chain.expected.security_level,
          package_name: VECTORS.service.package_name,
          signer_fingerprints: fingerprints(chain.expected.signer_digests),
          verified_boot_state: 'VERIFIED',
          device_locked: true,
        });
        return;
      }

      expect([response.status, codeOf(response)], response.text).toEqual([422, verdict]);
      // The caller is told the class of refusal and not the step that failed.
      expect(Object.keys(response.json() as object).toSorted()).toEqual([
        'code',
        'message',
        'request_id',
      ]);
      expect(await rig.devices(rider.id)).toEqual([]);
      expect(await rig.grantState(grantId)).toBe('PENDING');
      const detail = await rig.eventDetail(rider.id, 'auth.device.attestation_failed');
      expect(detail).toMatchObject({ verdict });
      if (chain.expected.cause === undefined) expect(detail).not.toHaveProperty('cause');
      else {
        expect(detail).toMatchObject({ cause: chain.expected.cause });
        expect(response.text).not.toContain(chain.expected.cause);
      }
      expect(
        (
          await rig.rows<{ pin_hash: string | null }>(
            `select pin_hash from rider_identity where id = $1`,
            [rider.id],
          )
        )[0]?.pin_hash,
      ).toBeNull();
    },
  );

  // Break caught (AC-64, "including evidence produced for another enrolment"): a chain accepted for a grant it was not made for, the replay
  // of one enrolment's evidence at another's.
  it('refuses the evidence of one enrolment presented at another, and says CHALLENGE_MISMATCH', async () => {
    const chain = VECTORS.cases.find((each) => each.name === 'valid_trusted_environment');
    if (chain === undefined) throw new Error('the vectors hold no valid chain');
    const another = Buffer.from(deviceKey().publicKey, 'base64')
      .subarray(0, 32)
      .toString('base64url');

    const { rider, response } = await rig.enrol(chain, another);

    expect([response.status, codeOf(response)]).toEqual([422, 'DEVICE_INTEGRITY_FAILED']);
    expect(await rig.eventDetail(rider.id, 'auth.device.attestation_failed')).toMatchObject({
      cause: 'CHALLENGE_MISMATCH',
    });
    expect(await rig.devices(rider.id)).toEqual([]);
  });

  // Break caught (AC-63, "an attestation extension further toward the leaf than the one nearest the trusted root is never used"): the chain
  // with an appended forged leaf accepted because its description was well formed.
  it('is not made to accept a chain whose first certificate was added by the handset', async () => {
    const chain = VECTORS.cases.find((each) => each.name === 'chain_extended_with_fake_leaf');
    if (chain === undefined) throw new Error('the vectors hold no extended chain');

    const { rider, response } = await rig.enrol(chain);

    expect([response.status, codeOf(response)]).toEqual([422, 'DEVICE_INTEGRITY_FAILED']);
    expect(await rig.devices(rider.id)).toEqual([]);
  });

  // Break caught: a chain accepted whose key is not the key being registered, the registered key taken from the attestation or the request
  // without the two being compared.
  it('registers the key the request submitted and the service attested, and refuses the other', async () => {
    const valid = VECTORS.cases.find((each) => each.name === 'valid_trusted_environment');
    const other = VECTORS.cases.find((each) => each.name === 'key_other_than_the_attested');
    if (valid === undefined || other === undefined) throw new Error('the vectors lack a case');

    const accepted = await rig.enrol(valid);
    const refused = await rig.enrol(other);

    expect(accepted.response.status).toBe(200);
    expect((await rig.devices(accepted.rider.id))[0]?.public_key).toBe(valid.device_public_key);
    expect([refused.response.status, codeOf(refused.response)]).toEqual([
      422,
      'DEVICE_INTEGRITY_FAILED',
    ]);
    expect(await rig.eventDetail(refused.rider.id, 'auth.device.attestation_failed')).toMatchObject(
      {
        cause: 'KEY_MISMATCH',
      },
    );
  });
});

describe('the signing certificate can be rotated (AC-SLICE-000-70)', () => {
  const [older, newer] = VECTORS.service.signing_digests;
  if (older === undefined || newer === undefined)
    throw new Error('the vectors hold no two digests');
  const byName = (name: string): Case => {
    const found = VECTORS.cases.find((each) => each.name === name);
    if (found === undefined) throw new Error(`the vectors hold no ${name}`);
    return found;
  };

  let rig: Rig;
  beforeAll(async () => {
    // The set after the older digest is removed: the newer alone.
    rig = await Rig.start([newer]);
  }, 900_000);
  afterAll(async () => {
    await rig.stop();
  });

  // Break caught: the older certificate still accepted after the set no longer holds it, an enrolment attested under the newer refused, or a
  // device enrolled under the older one disturbed by the removal.
  it('refuses a new enrolment attested under the older digest once it is removed, accepts one under the newer, and leaves enrolled devices alone', async () => {
    const enrolled = await insertRider(
      rig.routes.admin,
      riderRow({ fullName: 'Enrolled under the older digest', hubId: HUB_A }),
    );
    const held = await insertRiderDevice(rig.routes.admin, enrolled.id);

    const underOlder = await rig.enrol(byName('valid_trusted_environment'));
    const underNewer = await rig.enrol(byName('valid_rotated_signer'));
    const underBoth = await rig.enrol(byName('valid_both_approved_signers'));

    expect([underOlder.response.status, codeOf(underOlder.response)]).toEqual([
      422,
      'DEVICE_INTEGRITY_FAILED',
    ]);
    expect(
      await rig.eventDetail(underOlder.rider.id, 'auth.device.attestation_failed'),
    ).toMatchObject({
      cause: 'SIGNER_NOT_APPROVED',
    });
    expect(underNewer.response.status, underNewer.response.text).toBe(200);
    // Every digest the evidence reports must be approved: one that is not makes the chain refused, whatever else it carries.
    expect([underBoth.response.status, codeOf(underBoth.response)]).toEqual([
      422,
      'DEVICE_INTEGRITY_FAILED',
    ]);
    expect((await rig.devices(enrolled.id)).map((each) => [each.id, each.status])).toEqual([
      [held.id, 'ACTIVE'],
    ]);
  });
});
