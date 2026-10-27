import type {
  FailedAttempt,
  IdentityDirectory,
  LockoutPolicy,
  PrincipalRef,
  RegisteredChannel,
  PrincipalSummary,
  SignInCandidate,
} from '../ports/identity-directory.port.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';

/** The directories of the audiences, each a domain's adapter of the port: the staff domain's (staff and, since S0.53, riders) and the vendor domain's (S0.47). */
export interface AudienceDirectories {
  readonly STAFF: IdentityDirectory;
  readonly VENDOR: IdentityDirectory;
  readonly RIDER: IdentityDirectory;
}

/**
 * The `IdentityDirectory` the platform is given (S0.47, S0.53): one port over the directories the domains provide, each asked only what is
 * its own. A question about a principal goes to the directory of its type; a finder goes to the directory of the identifier it takes (the
 * work email to the staff directory, the account identifier to the vendor directory, the canonical phone to the rider directory). The
 * router holds no table and decides nothing; it is a composition, bound by the composition root, which alone may import the adapters it
 * routes to.
 */
export class RoutedIdentityDirectory implements IdentityDirectory {
  readonly #directories: AudienceDirectories;

  constructor(directories: AudienceDirectories) {
    this.#directories = directories;
  }

  #of(ref: PrincipalRef): IdentityDirectory {
    switch (ref.type) {
      case 'VENDOR':
        return this.#directories.VENDOR;
      case 'RIDER':
        return this.#directories.RIDER;
      case 'STAFF':
        return this.#directories.STAFF;
    }
  }

  findStaffByCanonicalEmail(
    transaction: TransactionHandle,
    canonicalEmail: string,
  ): Promise<PrincipalSummary | null> {
    return this.#directories.STAFF.findStaffByCanonicalEmail(transaction, canonicalEmail);
  }

  findVendorAccountByIdentifier(
    transaction: TransactionHandle,
    accountIdentifier: string,
  ): Promise<PrincipalSummary | null> {
    return this.#directories.VENDOR.findVendorAccountByIdentifier(transaction, accountIdentifier);
  }

  findRiderByCanonicalPhone(
    transaction: TransactionHandle,
    canonicalPhone: string,
  ): Promise<PrincipalSummary | null> {
    return this.#directories.RIDER.findRiderByCanonicalPhone(transaction, canonicalPhone);
  }

  readIdentity(
    transaction: TransactionHandle,
    ref: PrincipalRef,
  ): Promise<PrincipalSummary | null> {
    return this.#of(ref).readIdentity(transaction, ref);
  }

  lockIdentity(
    transaction: TransactionHandle,
    ref: PrincipalRef,
  ): Promise<PrincipalSummary | null> {
    return this.#of(ref).lockIdentity(transaction, ref);
  }

  establishCredential(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    encodedHash: string,
  ): Promise<{ readonly generation: number } | null> {
    return this.#of(ref).establishCredential(transaction, ref, encodedHash);
  }

  accountLabel(transaction: TransactionHandle, ref: PrincipalRef): Promise<string | null> {
    return this.#of(ref).accountLabel(transaction, ref);
  }

  findStaffForSignIn(
    transaction: TransactionHandle,
    canonicalEmail: string,
  ): Promise<SignInCandidate | null> {
    return this.#directories.STAFF.findStaffForSignIn(transaction, canonicalEmail);
  }

  isCredentialLocked(transaction: TransactionHandle, ref: PrincipalRef): Promise<boolean> {
    return this.#of(ref).isCredentialLocked(transaction, ref);
  }

  readCredentialHash(transaction: TransactionHandle, ref: PrincipalRef): Promise<string | null> {
    return this.#of(ref).readCredentialHash(transaction, ref);
  }

  recordFailedAttempt(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    generation: number,
    policy: LockoutPolicy,
  ): Promise<FailedAttempt> {
    return this.#of(ref).recordFailedAttempt(transaction, ref, generation, policy);
  }

  rehashCredential(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    generation: number,
    verifiedHash: string,
    encodedHash: string,
  ): Promise<boolean> {
    return this.#of(ref).rehashCredential(transaction, ref, generation, verifiedHash, encodedHash);
  }

  clearFailedAttempts(transaction: TransactionHandle, ref: PrincipalRef): Promise<void> {
    return this.#of(ref).clearFailedAttempts(transaction, ref);
  }

  displayName(transaction: TransactionHandle, ref: PrincipalRef): Promise<string | null> {
    return this.#of(ref).displayName(transaction, ref);
  }

  vendorOrganizationOf(transaction: TransactionHandle, ref: PrincipalRef): Promise<string | null> {
    return this.#of(ref).vendorOrganizationOf(transaction, ref);
  }

  registeredChannel(
    transaction: TransactionHandle,
    ref: PrincipalRef,
  ): Promise<RegisteredChannel | null> {
    return this.#of(ref).registeredChannel(transaction, ref);
  }

  recoveryEligible(transaction: TransactionHandle, ref: PrincipalRef): Promise<boolean> {
    return this.#of(ref).recoveryEligible(transaction, ref);
  }

  replaceCredential(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    encodedHash: string,
  ): Promise<{ readonly generation: number } | null> {
    return this.#of(ref).replaceCredential(transaction, ref, encodedHash);
  }
}
