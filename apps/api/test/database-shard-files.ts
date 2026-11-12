/**
 * Prints one line of JSON: the shard Vitest resolved from the configuration (`MELARC_DB_SHARD`, test/database-shard.ts) and the test files of the two
 * database projects that shard keeps, relative to this package. It runs no test and needs no database: it lists the files with Vitest's own node
 * interface and cuts them with Vitest's own sequencer, the code `vitest run --shard` uses. `vitest list` cannot do this (it ignores the shard).
 * `scripts/db-shards.test.ts` runs it for every shard of the CI matrix to prove the shards hold every file once; nothing else uses it.
 */
import { relative } from 'node:path';

import { BaseSequencer, createVitest } from 'vitest/node';

const vitest = await createVitest({
  run: true,
  watch: false,
  project: ['database', 'database-alone'],
});
try {
  const specifications = await vitest.globTestSpecifications();
  const shard = vitest.config.shard;
  const kept =
    shard === undefined ? specifications : await new BaseSequencer(vitest).shard(specifications);
  const files = kept
    .map((specification) =>
      relative(vitest.config.root, specification.moduleId).replaceAll('\\', '/'),
    )
    .toSorted();
  console.log(JSON.stringify({ shard: shard ?? null, files }));
} finally {
  await vitest.close();
}
