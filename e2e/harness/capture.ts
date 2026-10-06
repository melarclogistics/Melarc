import { existsSync, readFileSync } from 'node:fs';

/** One attempt, by code under test, to reach something outside this machine. The guard wrote it and refused it. */
export interface CapturedAttempt {
  readonly at: string;
  readonly kind: string;
  readonly host: string;
  readonly port: number;
}

/**
 * What the outbound guard recorded, oldest first. A file that does not exist means nothing was attempted,
 * and a last line that is cut short (a process ended while it wrote) is skipped, not an error: what was
 * recorded before it still counts.
 */
export function readCaptured(file: string): CapturedAttempt[] {
  if (!existsSync(file)) return [];
  const attempts: CapturedAttempt[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      attempts.push(JSON.parse(line) as CapturedAttempt);
    } catch {
      // A line that was not finished.
    }
  }
  return attempts;
}

/** Fails if the code under test tried to reach anything outside this machine, naming each host. */
export function assertNoExternalAttempts(file: string): void {
  const attempts = readCaptured(file);
  if (attempts.length === 0) return;
  throw new Error(
    `The code under test tried to reach ${String(attempts.length)} external address(es), and the sandbox refused:\n${attempts
      .map((attempt) => `  ${attempt.host}:${String(attempt.port)} (${attempt.at})`)
      .join('\n')}`,
  );
}
