import { afterAll, beforeAll } from 'vitest';

import { holdServer } from './server-hold.js';

// A file of `database-alone` has the server to itself (server-hold.ts says why). The hold is taken before the file's own hooks
// and given back after them.
let release: (() => Promise<void>) | undefined;

beforeAll(async () => {
  release = await holdServer('alone');
});

afterAll(async () => {
  await release?.();
});
