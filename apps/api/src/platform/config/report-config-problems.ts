import type { ConfigProblem } from './load-config.js';

/**
 * The single log line written when the API refuses to start because its configuration is wrong. The
 * configured logger cannot exist yet, so this is written by hand, in the same shape. It names the keys
 * and what each should look like, and never a value.
 */
export function reportConfigProblems(
  problems: readonly ConfigProblem[],
  now: Date = new Date(),
): string {
  return `${JSON.stringify({
    level: 'fatal',
    time: now.toISOString(),
    service: 'melarc-api',
    msg: 'Invalid configuration: the API will not start',
    problems,
  })}\n`;
}
