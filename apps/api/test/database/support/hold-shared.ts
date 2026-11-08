import { afterAll, beforeAll } from 'vitest';

import { holdServer } from './server-hold.js';

// A file of the `database` project shares the server with the files beside it, and with no file that must run alone
// (server-hold.ts says why). The hold is taken before the file's own hooks and given back after them.
let release: (() => Promise<void>) | undefined;

beforeAll(async () => {
  release = await holdServer('shared');
});

afterAll(async () => {
  await release?.();
});
