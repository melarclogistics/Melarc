import {
  ATTESTATION_VERIFIER,
  ATTESTATION_VERIFIER_DESCRIPTOR,
  type AttestationVerifier,
} from './attestation-verifier.port.js';
import { AUDIT_WRITER, AUDIT_WRITER_DESCRIPTOR, type AuditWriter } from './audit-writer.port.js';
import { CLOCK, CLOCK_DESCRIPTOR, type Clock } from './clock.port.js';
import {
  DELIVERY_PROVIDER,
  DELIVERY_PROVIDER_DESCRIPTOR,
  type DeliveryProvider,
} from './delivery-provider.port.js';
import {
  DELIVERY_QUEUE,
  DELIVERY_QUEUE_DESCRIPTOR,
  type DeliveryQueue,
} from './delivery-queue.port.js';
import {
  HASH_ADMISSION,
  HASH_ADMISSION_DESCRIPTOR,
  type HashAdmission,
} from './hash-admission.port.js';
import { HASHER, HASHER_DESCRIPTOR, type Hasher } from './hasher.port.js';
import {
  IDEMPOTENCY_STORE,
  IDEMPOTENCY_STORE_DESCRIPTOR,
  type IdempotencyStore,
} from './idempotency-store.port.js';
import {
  IDENTITY_DIRECTORY,
  IDENTITY_DIRECTORY_DESCRIPTOR,
  type IdentityDirectory,
} from './identity-directory.port.js';
import { METRICS, METRICS_DESCRIPTOR, type Metrics } from './metrics.port.js';
import type { PortDescriptorShape } from './port-descriptor.js';
import { RATE_LIMITER, RATE_LIMITER_DESCRIPTOR, type RateLimiter } from './rate-limiter.port.js';
import {
  SECRET_CIPHER,
  SECRET_CIPHER_DESCRIPTOR,
  type SecretCipher,
} from './secret-cipher.port.js';
import {
  SESSION_STORE,
  SESSION_STORE_DESCRIPTOR,
  type SessionStore,
} from './session-store.port.js';
import {
  TOKEN_SERVICE,
  TOKEN_SERVICE_DESCRIPTOR,
  type TokenService,
} from './token-service.port.js';
import {
  TOTP_VERIFIER,
  TOTP_VERIFIER_DESCRIPTOR,
  type TotpVerifier,
} from './totp-verifier.port.js';
import { UNIT_OF_WORK, UNIT_OF_WORK_DESCRIPTOR, type UnitOfWork } from './unit-of-work.port.js';

/** Every port by name, with the type of the adapter that may be bound to it. */
export interface PortTypes {
  Clock: Clock;
  Hasher: Hasher;
  SecretCipher: SecretCipher;
  TokenService: TokenService;
  TotpVerifier: TotpVerifier;
  RateLimiter: RateLimiter;
  HashAdmission: HashAdmission;
  IdempotencyStore: IdempotencyStore;
  AuditWriter: AuditWriter;
  SessionStore: SessionStore;
  IdentityDirectory: IdentityDirectory;
  UnitOfWork: UnitOfWork;
  DeliveryQueue: DeliveryQueue;
  DeliveryProvider: DeliveryProvider;
  AttestationVerifier: AttestationVerifier;
  Metrics: Metrics;
}

export interface PortRegistryEntry {
  readonly name: keyof PortTypes;
  readonly token: symbol;
  readonly descriptor: PortDescriptorShape;
}

/**
 * The ports of `platform/auth`, in one list. `src/architecture.test.ts` checks it against the list it keeps of its own, so a
 * port cannot be added, dropped or left without a complete descriptor unnoticed.
 */
export const PORTS: readonly PortRegistryEntry[] = [
  { name: 'Clock', token: CLOCK, descriptor: CLOCK_DESCRIPTOR },
  { name: 'Hasher', token: HASHER, descriptor: HASHER_DESCRIPTOR },
  { name: 'SecretCipher', token: SECRET_CIPHER, descriptor: SECRET_CIPHER_DESCRIPTOR },
  { name: 'TokenService', token: TOKEN_SERVICE, descriptor: TOKEN_SERVICE_DESCRIPTOR },
  { name: 'TotpVerifier', token: TOTP_VERIFIER, descriptor: TOTP_VERIFIER_DESCRIPTOR },
  { name: 'RateLimiter', token: RATE_LIMITER, descriptor: RATE_LIMITER_DESCRIPTOR },
  { name: 'HashAdmission', token: HASH_ADMISSION, descriptor: HASH_ADMISSION_DESCRIPTOR },
  { name: 'IdempotencyStore', token: IDEMPOTENCY_STORE, descriptor: IDEMPOTENCY_STORE_DESCRIPTOR },
  { name: 'AuditWriter', token: AUDIT_WRITER, descriptor: AUDIT_WRITER_DESCRIPTOR },
  { name: 'SessionStore', token: SESSION_STORE, descriptor: SESSION_STORE_DESCRIPTOR },
  {
    name: 'IdentityDirectory',
    token: IDENTITY_DIRECTORY,
    descriptor: IDENTITY_DIRECTORY_DESCRIPTOR,
  },
  { name: 'UnitOfWork', token: UNIT_OF_WORK, descriptor: UNIT_OF_WORK_DESCRIPTOR },
  { name: 'DeliveryQueue', token: DELIVERY_QUEUE, descriptor: DELIVERY_QUEUE_DESCRIPTOR },
  { name: 'DeliveryProvider', token: DELIVERY_PROVIDER, descriptor: DELIVERY_PROVIDER_DESCRIPTOR },
  {
    name: 'AttestationVerifier',
    token: ATTESTATION_VERIFIER,
    descriptor: ATTESTATION_VERIFIER_DESCRIPTOR,
  },
  { name: 'Metrics', token: METRICS, descriptor: METRICS_DESCRIPTOR },
];
