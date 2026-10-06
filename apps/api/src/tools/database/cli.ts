/** A command line was used wrongly or a value it needs is unusable. The message names the setting, never its value. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

interface NetworkError extends Error {
  readonly code?: string;
  readonly address?: string;
  readonly port?: number;
  readonly cause?: unknown;
}

const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * One readable line (or a few) for a failure: what refused or broke, never a stack trace and never a
 * connection string. A server that cannot be reached says so and says what to check.
 */
export function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'the command failed for an unexpected reason';
  const failure = error as NetworkError;
  // A name that resolves to several addresses fails with one error per address, wrapped in one.
  const attempts: readonly unknown[] = error instanceof AggregateError ? error.errors : [];
  const unreachable = [failure, ...attempts].find(
    (candidate): candidate is NetworkError =>
      candidate instanceof Error && UNREACHABLE.has((candidate as NetworkError).code ?? ''),
  );
  if (unreachable !== undefined) {
    const where =
      unreachable.address === undefined
        ? ''
        : ` at ${unreachable.address}${unreachable.port === undefined ? '' : `:${String(unreachable.port)}`}`;
    return `PostgreSQL is not reachable${where} (${unreachable.code ?? 'unknown'}). Is the local container running? See infrastructure/postgres/compose.yaml.`;
  }
  const cause = failure.cause instanceof Error ? `\n  caused by: ${failure.cause.message}` : '';
  return `${error.message}${cause}`;
}

/** Runs a tool's main function. A failure is one message on stderr and exit code 1. */
export async function runCli(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${describeFailure(error)}\n`);
    process.exitCode = 1;
  }
}

/** The database a tool acts on: the first argument, else the local development database. */
export function databaseArgument(argv: readonly string[]): string {
  return argv[2] ?? 'melarc_dev';
}
