/**
 * What a describe adapter throws when anything asks it to run. The describe composition exists so that the application can be
 * built and described without a database, a provider or a key; an adapter in it that did real work would be a fixture posing
 * as an adapter, so every operation says plainly that it is one. The message names the port and the operation, and nothing else.
 */
export class DescribeAdapterInvokedError extends Error {
  constructor(
    readonly port: string,
    readonly operation: string,
  ) {
    super(
      `The describe adapter for the ${port} port cannot run ${port}.${operation}: it is bound only so that the application can describe itself, and it never connects, delivers or reads a secret.`,
    );
    this.name = 'DescribeAdapterInvokedError';
  }
}
