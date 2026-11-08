import {
  formatReport,
  parseBenchmarkArguments,
  runBenchmark,
} from './benchmark/argon2-benchmark.js';
import { runCli } from './database/cli.js';

/**
 * Times one Argon2id hash at a time, for each cost in a grid, and prints the result with a record of the machine as JSON. It is
 * the measurement behind the development-qualified cost (plan task S0.3a); its figures describe this machine and make no capacity
 * claim. It hashes a synthetic text with a throwaway salt and pepper, needs no environment, no database and no key, and prints
 * none of them.
 *
 * Run it on a quiet machine and say so with `--note`, because what else was running changes the figure.
 *
 * usage: node dist/tools/benchmark-argon2.js [--runs <3-200>] [--note <text>] [--memory-kib <n> --passes <n> --parallelism <n>]
 */
await runCli(async () => {
  const options = parseBenchmarkArguments(process.argv.slice(2));
  process.stdout.write(formatReport(await runBenchmark(options)));
});
