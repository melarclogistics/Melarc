/**
 * An operation of a domain was asked for in an application composed without a part it needs: a database, and so the runner of an
 * operation, or a port. Nothing was read or written, and nothing answers as though it had been (an empty list, a missing record): the
 * platform answers its fixed, code-less `503` (`operational-failure.ts`). One class for every domain operation, so that a domain
 * module, which the platform may not import, needs no error of its own to fail closed.
 */
export class OperationUnavailableError extends Error {
  constructor(readonly operation: string) {
    super('An operation was asked for and the application is not composed to carry it out');
    this.name = 'OperationUnavailableError';
  }
}
