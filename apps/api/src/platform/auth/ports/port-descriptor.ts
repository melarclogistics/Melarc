/**
 * How a port is described before any adapter or table exists (SOLUTION_ARCHITECTURE.md §5, "How `platform/auth` reaches domain
 * data without importing it"). Every port names, for each of its operations, its inputs, its outputs, what it returns other than
 * success, what it raises, and its transaction requirement, and names its owner once. The description is data a test reads, so a
 * port that was written without one cannot pass `src/architecture.test.ts`.
 *
 * **Two kinds of non-success, kept apart.**
 * - `outcomes` are answers the operation *returns* in the normal course of the rules: a `null` for "not found", a verdict, a
 *   refusal. The use case maps them to the contract's codes.
 * - `raises` are conditions the adapter *throws* because the operation cannot proceed: a missing key, an unusable store, a
 *   caller's programming error. They are plain named conditions, not a hierarchy of error classes, and they roll back the
 *   caller's transaction.
 * A storage fault that every database operation can meet (a database error, a statement or lock timeout, a lost connection)
 * is raised too and is not repeated in each descriptor; `lockIdentity` lists `LOCK_TIMEOUT` because its timeout is the one a
 * caller must tell apart. Both lists are `none` when empty, never omitted, and a name is in one list or the other.
 */

/**
 * Where an operation may be called from, in terms of the transaction the use case owns.
 *
 * - `inside-callers-transaction`: the operation takes the caller's `TransactionHandle` and joins it. It never opens, nests or
 *   commits a transaction, and it holds no lock beyond the caller's. Only an operation with that parameter is described so.
 * - `outside-any-transaction`: the caller has **no transaction open** when it calls. The operation opens its own transaction,
 *   or does external I/O, or holds memory-hard or bounded resources. **Every autonomous database operation is here**, however
 *   short its transaction and however few locks it takes: called from inside a caller's transaction it would take a second
 *   pooled connection (a deadlock against a pool of one) and act outside the caller's lock order.
 * - `independent`: safe local work only. It runs in process, with no database connection, no I/O and no lock, so calling it
 *   anywhere, inside a transaction included, changes nothing about that transaction. The operations described so are listed in
 *   `src/architecture.test.ts`, so the claim is reviewed each time it is made.
 */
export type TransactionRequirement =
  'inside-callers-transaction' | 'outside-any-transaction' | 'independent';

export const TRANSACTION_REQUIREMENTS = [
  'inside-callers-transaction',
  'outside-any-transaction',
  'independent',
] as const satisfies readonly TransactionRequirement[];

/**
 * Who supplies the adapter. `platform` is a technical adapter in `platform/` with no domain data of its own (it may own a
 * platform table). `domain` names the permission domains whose modules implement the persistence adapter over data they own;
 * no identity table is duplicated to satisfy a module boundary, and identity creates no new domain.
 */
export type PortOwner =
  | { readonly kind: 'platform'; readonly area: string }
  | { readonly kind: 'domain'; readonly domains: readonly [string, ...string[]] };

/** `none`, or the SCREAMING_SNAKE names of the conditions. */
export type NamedConditions = 'none' | readonly [string, ...string[]];

export interface OperationDescriptor {
  /** What the caller gives, in words; `none` when nothing. */
  readonly inputs: string;
  /** What comes back on success. */
  readonly outputs: string;
  /** The answers other than success that the operation returns. */
  readonly outcomes: NamedConditions;
  /** The conditions the adapter throws. */
  readonly raises: NamedConditions;
  readonly transaction: TransactionRequirement;
}

/** The methods of a port, as a union of names: what its descriptor must cover. */
export type PortMethod<P> = {
  [K in keyof P]-?: P[K] extends (...parameters: never[]) => unknown ? K : never;
}[keyof P] &
  string;

export interface PortDescriptorShape {
  readonly port: string;
  readonly owner: PortOwner;
  readonly operations: Readonly<Record<string, OperationDescriptor>>;
}

/**
 * The descriptor of the port `P`. Its `operations` has exactly the methods of `P` as keys, so adding a method to a port
 * without describing it, or describing one it does not have, does not compile.
 */
export interface PortDescriptor<P> extends PortDescriptorShape {
  readonly operations: Readonly<Record<PortMethod<P>, OperationDescriptor>>;
}
