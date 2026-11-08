import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveConfig } from 'vite';
import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(import.meta.dirname, '..');
const API_ENV_EXAMPLE = resolve(APP_ROOT, '../api/.env.example');

/**
 * The origin the API's example settings let the Ops Portal come from. The API accepts a state-changing request only from the exact
 * origin it is configured with (`OPS_ORIGIN`), so a browser that opens the portal at any other address (another host name for the same
 * machine, or the next free port) loads the page and is refused at every sign-in.
 */
function opsOriginOfTheApiExample(): URL {
  const line = readFileSync(API_ENV_EXAMPLE, 'utf8')
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith('OPS_ORIGIN='));
  if (line === undefined) throw new Error('apps/api/.env.example has no OPS_ORIGIN.');
  return new URL(line.slice('OPS_ORIGIN='.length).trim());
}

async function developmentServer() {
  const config = await resolveConfig(
    { root: APP_ROOT, configFile: resolve(APP_ROOT, 'vite.config.ts'), logLevel: 'silent' },
    'serve',
    'development',
  );
  return config.server;
}

describe('the development server and the origin the API allows', () => {
  // Break caught (found on a real run): `pnpm run dev` listened on `localhost` (the IPv6 loopback on this machine) while the API
  // allowed `http://127.0.0.1:5173`, so the one address that loaded the page was refused at sign-in with 403, and the address the API
  // allows did not connect at all.
  it('listens on the host and the port that OPS_ORIGIN of the API example names', async () => {
    const origin = opsOriginOfTheApiExample();
    const server = await developmentServer();

    expect(server.host).toBe(origin.hostname);
    expect(server.port).toBe(Number(origin.port));
  });

  // Break caught: a busy port silently taking the next one (5174 is the Vendor origin), which the API then refuses as another origin.
  it('stops, and does not move to another port, when its own is taken', async () => {
    expect((await developmentServer()).strictPort).toBe(true);
  });
});
