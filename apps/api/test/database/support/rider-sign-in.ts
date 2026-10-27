import { createHash, sign, type KeyObject } from 'node:crypto';

import type { Hasher } from '../../../src/platform/auth/ports/hasher.port.js';
import type { TestClient, TestResponse } from '../../../src/test-support/test-client.js';
import {
  deviceKey,
  insertRider,
  insertRiderDevice,
  riderRow,
  type RiderDeviceRow,
  type RiderRow,
} from './riders.js';
import { API, HUB_A, type StaffRoutes } from './staff-routes.js';

/**
 * The rider's sign-in as the Rider app does it, for the tests of S0.59: a rider arranged past row-level security with a PIN the real hasher
 * made and a device whose key pair the test holds, a challenge requested over HTTP as the native client does (no `Origin`, no cookie, no
 * credential), and a signature made **here**, from the protocol's published words, so that the production code is held to the protocol and not
 * to itself: the signed message is the UTF-8 text `MELARC-RIDER-SIGNIN-V1`, one `0x0A` byte and the challenge exactly as it was issued, and the
 * signature is the standard base64 of an ASN.1 DER ECDSA P-256 signature over SHA-256 of that message.
 */
export const CHALLENGE_URL = `${API}/auth/rider/sign-in/challenge`;
export const SIGN_IN_URL = `${API}/auth/rider/sign-in`;
/** `getCurrentSession` (GET) and `signOut` (DELETE). */
export const SESSION_URL = `${API}/auth/session`;

export const PIN = '739204';
export const WRONG_PIN = '000000';

/** The bytes a device signs for a challenge, written out and not taken from the production module. */
export function signedMessage(challenge: string): Buffer {
  return Buffer.concat([
    Buffer.from('MELARC-RIDER-SIGNIN-V1', 'utf8'),
    Buffer.from([0x0a]),
    Buffer.from(challenge, 'utf8'),
  ]);
}

/** What a handset sends as `device_signature`: ECDSA P-256 over SHA-256 of the signed message, DER, standard base64. */
export function signChallenge(key: KeyObject, challenge: string): string {
  return sign('sha256', signedMessage(challenge), { key, dsaEncoding: 'der' }).toString('base64');
}

export interface Enrolled {
  readonly rider: RiderRow;
  /** The device the rider enrolled: `null` for a rider arranged with none. */
  readonly device: RiderDeviceRow | null;
  readonly pin: string;
}

export interface EnrolledOptions {
  readonly pin?: string;
  readonly status?: string;
  readonly hubId?: string;
  /** `ACTIVE` unless said otherwise; `null` arranges a rider who never enrolled a device (and so holds no PIN). */
  readonly device?: 'ACTIVE' | 'REVOKED' | 'REPLACED' | null;
  readonly fullName?: string;
  /** The encoded hash the PIN is stored as, where the test needs one the hasher would not make now (an older cost). */
  readonly pinHash?: string;
}

let counter = 0;

/**
 * A rider as enrolment leaves one: the PIN hashed by the application's own hasher, an `ACTIVE` device whose key the test holds. A rider with
 * `device: null` has neither a device nor a PIN, as one who never enrolled.
 */
export async function enrolledRider(
  routes: StaffRoutes,
  hasher: Hasher,
  options: EnrolledOptions = {},
): Promise<Enrolled> {
  counter += 1;
  const pin = options.pin ?? PIN;
  const never = options.device === null;
  const rider = await insertRider(
    routes.admin,
    riderRow({
      fullName: options.fullName ?? `Signing rider ${String(counter)}`,
      hubId: options.hubId ?? HUB_A,
      status: options.status ?? 'ACTIVE',
      ...(never ? {} : { pinHash: options.pinHash ?? (await hasher.hash('RIDER_PIN', pin)) }),
    }),
  );
  const device = never
    ? null
    : await insertRiderDevice(routes.admin, rider.id, { status: options.device ?? 'ACTIVE' });
  return { rider, device, pin };
}

/** A device for a rider who already has one: a new key pair, `ACTIVE`, as a replacement leaves it (the earlier one ended by the caller). */
export function anotherDevice(routes: StaffRoutes, riderId: string): Promise<RiderDeviceRow> {
  return insertRiderDevice(routes.admin, riderId, { key: deviceKey() });
}

/** A native client: no cookie jar kept, no `Origin`, no credential, as the Rider app sends a pre-session request. */
export const native = (routes: StaffRoutes): TestClient => routes.kit.client.fork();

export const requestChallenge = (
  routes: StaffRoutes,
  phone: string,
  client: TestClient = native(routes),
): Promise<TestResponse> => client.post(CHALLENGE_URL, { phone }, { origin: null });

export const post = (
  routes: StaffRoutes,
  body: unknown,
  client: TestClient = native(routes),
): Promise<TestResponse> => client.post(SIGN_IN_URL, body, { origin: null });

export interface SignInParts {
  readonly phone: string;
  readonly pin: string;
  readonly challenge: string;
  readonly device_signature: string;
  readonly client_root_signal: 'NOT_DETECTED' | 'DETECTED' | 'UNKNOWN';
}

export const challengeOf = (response: TestResponse): string => {
  const body = response.json() as { challenge?: unknown };
  if (response.status !== 200 || typeof body.challenge !== 'string') {
    throw new Error(`no challenge was issued: ${String(response.status)}`);
  }
  return body.challenge;
};

/** A fresh challenge for `phone`, as the handset asks for one. */
export async function freshChallenge(routes: StaffRoutes, phone: string): Promise<string> {
  return challengeOf(await requestChallenge(routes, phone));
}

/**
 * The whole sign-in as a handset makes it: a fresh challenge for the number, signed with `key` (the registered device's, unless the test
 * presents another), and the PIN. `over` replaces any field of the body after it was made.
 */
export async function attempt(
  routes: StaffRoutes,
  subject: { readonly phone: string; readonly key?: KeyObject; readonly pin: string },
  over: Partial<Record<keyof SignInParts, unknown>> = {},
  client?: TestClient,
): Promise<{ readonly response: TestResponse; readonly challenge: string }> {
  const challenge = await freshChallenge(routes, subject.phone);
  const body = {
    phone: subject.phone,
    pin: subject.pin,
    challenge,
    device_signature:
      subject.key === undefined
        ? signChallenge(deviceKey().privateKey, challenge)
        : signChallenge(subject.key, challenge),
    client_root_signal: 'NOT_DETECTED',
    ...over,
  };
  return { response: await post(routes, body, client), challenge };
}

/** The hash the application keeps of a nonce: the SHA-256 of its 32 decoded bytes. */
export const nonceHashOf = (challenge: string): Buffer =>
  createHash('sha256').update(Buffer.from(challenge, 'base64url')).digest();
