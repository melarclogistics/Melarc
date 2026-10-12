import type {
  AttestationVerdict,
  AttestationVerifier,
  AuditWriter,
  Clock,
  ClaimedDelivery,
  DeliveryJobRef,
  DeliveryOutcome,
  DeliveryProvider,
  DeliveryQueue,
  HashAdmission,
  HashSlot,
  HashVerdict,
  Hasher,
  IdempotencyStart,
  IdempotencyStore,
  IdentityDirectory,
  IssuedToken,
  JobEnd,
  Metrics,
  PortBindings,
  PrincipalSummary,
  RateLimitDecision,
  RateLimiter,
  SealedSecret,
  SecretCipher,
  SessionStore,
  StoredSession,
  TokenService,
  TotpVerdict,
  TotpVerifier,
  UnitOfWork,
} from '../ports/index.js';
import { DescribeAdapter } from './describe-adapter.js';
import { DescribeAdapterInvokedError } from './describe-adapter-error.js';

/**
 * The inert adapters of the describe composition (SOLUTION_ARCHITECTURE.md §5; plan task S0.2). Every port resolves to one of
 * them when the application is built to be described: by the OpenAPI generator, the contract check and the default test
 * application. They hold nothing, import nothing that could connect, and never read the environment or a secret. Invoking an
 * operation fails at once with a `DescribeAdapterInvokedError` that names the port and the operation, and does nothing else.
 *
 * They are adapters like any other for the rules of `src/architecture.test.ts`: this file is on its list of those allowed to
 * implement a port inside `platform/`, and only the composition root imports it. **Two refusals keep them out of a real run.**
 * Production and staging configuration refuse the describe composition (`adapterRefusals`), and the runtime composition
 * refuses a binding that is one of these (every class below extends `DescribeAdapter`, which `port-binding-check.ts`
 * looks for), whether it was written as a class or a value or came out of a factory or an alias when the application started.
 */
const refuse = (port: string, operation: string): never => {
  throw new DescribeAdapterInvokedError(port, operation);
};

export class DescribeClock extends DescribeAdapter implements Clock {
  now(): Date {
    return refuse('Clock', 'now');
  }
  monotonicMilliseconds(): number {
    return refuse('Clock', 'monotonicMilliseconds');
  }
}

export class DescribeHasher extends DescribeAdapter implements Hasher {
  hash(): Promise<string> {
    return refuse('Hasher', 'hash');
  }
  verify(): Promise<HashVerdict> {
    return refuse('Hasher', 'verify');
  }
  verifyAgainstDummy(): Promise<void> {
    return refuse('Hasher', 'verifyAgainstDummy');
  }
}

export class DescribeSecretCipher extends DescribeAdapter implements SecretCipher {
  seal(): Promise<SealedSecret> {
    return refuse('SecretCipher', 'seal');
  }
  open(): Promise<Uint8Array> {
    return refuse('SecretCipher', 'open');
  }
}

export class DescribeTokenService extends DescribeAdapter implements TokenService {
  issue(): IssuedToken {
    return refuse('TokenService', 'issue');
  }
  hash(): Uint8Array | null {
    return refuse('TokenService', 'hash');
  }
  matches(): boolean {
    return refuse('TokenService', 'matches');
  }
}

export class DescribeTotpVerifier extends DescribeAdapter implements TotpVerifier {
  newSeed(): Uint8Array {
    return refuse('TotpVerifier', 'newSeed');
  }
  verify(): TotpVerdict {
    return refuse('TotpVerifier', 'verify');
  }
}

export class DescribeRateLimiter extends DescribeAdapter implements RateLimiter {
  admit(): Promise<RateLimitDecision> {
    return refuse('RateLimiter', 'admit');
  }
}

export class DescribeHashAdmission extends DescribeAdapter implements HashAdmission {
  tryAdmit(): HashSlot | null {
    return refuse('HashAdmission', 'tryAdmit');
  }
}

export class DescribeIdempotencyStore extends DescribeAdapter implements IdempotencyStore {
  begin(): Promise<IdempotencyStart> {
    return refuse('IdempotencyStore', 'begin');
  }
  complete(): Promise<void> {
    return refuse('IdempotencyStore', 'complete');
  }
  eraseSealedReplay(): Promise<boolean> {
    return refuse('IdempotencyStore', 'eraseSealedReplay');
  }
}

export class DescribeAuditWriter extends DescribeAdapter implements AuditWriter {
  write(): Promise<void> {
    return refuse('AuditWriter', 'write');
  }
}

export class DescribeSessionStore extends DescribeAdapter implements SessionStore {
  create(): Promise<StoredSession> {
    return refuse('SessionStore', 'create');
  }
  findByTokenHash(): Promise<StoredSession | null> {
    return refuse('SessionStore', 'findByTokenHash');
  }
  recordActivity(): Promise<void> {
    return refuse('SessionStore', 'recordActivity');
  }
  terminate(): Promise<readonly string[]> {
    return refuse('SessionStore', 'terminate');
  }
}

export class DescribeIdentityDirectory extends DescribeAdapter implements IdentityDirectory {
  findStaffByCanonicalEmail(): Promise<PrincipalSummary | null> {
    return refuse('IdentityDirectory', 'findStaffByCanonicalEmail');
  }
  findVendorAccountByIdentifier(): Promise<PrincipalSummary | null> {
    return refuse('IdentityDirectory', 'findVendorAccountByIdentifier');
  }
  findRiderByCanonicalPhone(): Promise<PrincipalSummary | null> {
    return refuse('IdentityDirectory', 'findRiderByCanonicalPhone');
  }
  readIdentity(): Promise<PrincipalSummary | null> {
    return refuse('IdentityDirectory', 'readIdentity');
  }
  lockIdentity(): Promise<PrincipalSummary | null> {
    return refuse('IdentityDirectory', 'lockIdentity');
  }
}

export class DescribeUnitOfWork extends DescribeAdapter implements UnitOfWork {
  run<T>(): Promise<T> {
    return refuse('UnitOfWork', 'run');
  }
  databaseNow(): Promise<Date> {
    return refuse('UnitOfWork', 'databaseNow');
  }
}

export class DescribeDeliveryQueue extends DescribeAdapter implements DeliveryQueue {
  enqueue(): Promise<DeliveryJobRef> {
    return refuse('DeliveryQueue', 'enqueue');
  }
  cancel(): Promise<number> {
    return refuse('DeliveryQueue', 'cancel');
  }
  claim(): Promise<ClaimedDelivery | null> {
    return refuse('DeliveryQueue', 'claim');
  }
  recordOutcome(): Promise<JobEnd> {
    return refuse('DeliveryQueue', 'recordOutcome');
  }
}

export class DescribeDeliveryProvider extends DescribeAdapter implements DeliveryProvider {
  send(): Promise<DeliveryOutcome> {
    return refuse('DeliveryProvider', 'send');
  }
  status(): Promise<DeliveryOutcome | null> {
    return refuse('DeliveryProvider', 'status');
  }
}

export class DescribeAttestationVerifier extends DescribeAdapter implements AttestationVerifier {
  verify(): Promise<AttestationVerdict> {
    return refuse('AttestationVerifier', 'verify');
  }
}

export class DescribeMetrics extends DescribeAdapter implements Metrics {
  increment(): void {
    refuse('Metrics', 'increment');
  }
  observe(): void {
    refuse('Metrics', 'observe');
  }
}

/** What the composition root binds when the application is composed to be described: one inert adapter per port. */
export const DESCRIBE_PORT_BINDINGS: PortBindings = {
  clock: { useClass: DescribeClock },
  hasher: { useClass: DescribeHasher },
  secretCipher: { useClass: DescribeSecretCipher },
  tokenService: { useClass: DescribeTokenService },
  totpVerifier: { useClass: DescribeTotpVerifier },
  rateLimiter: { useClass: DescribeRateLimiter },
  hashAdmission: { useClass: DescribeHashAdmission },
  idempotencyStore: { useClass: DescribeIdempotencyStore },
  auditWriter: { useClass: DescribeAuditWriter },
  sessionStore: { useClass: DescribeSessionStore },
  identityDirectory: { useClass: DescribeIdentityDirectory },
  unitOfWork: { useClass: DescribeUnitOfWork },
  deliveryQueue: { useClass: DescribeDeliveryQueue },
  deliveryProvider: { useClass: DescribeDeliveryProvider },
  attestationVerifier: { useClass: DescribeAttestationVerifier },
  metrics: { useClass: DescribeMetrics },
};
