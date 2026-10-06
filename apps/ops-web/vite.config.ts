import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// Explicit extensions: Vite plans to load its config natively in a future major version, and the Node
// loader does not resolve extensionless imports.
import { assertNoSecretsInClientEnv, CLIENT_ENV_PREFIX } from './config/client-env.ts';
import { createApiProxy, DEFAULT_API_TARGET } from './config/dev-proxy.ts';

export default defineConfig(({ mode }) => {
  // Everything the bundle could see must pass the guard before anything is built.
  assertNoSecretsInClientEnv(loadEnv(mode, import.meta.dirname, CLIENT_ENV_PREFIX));

  // The proxy target is read from the whole environment on purpose: it is a server-side value for the
  // dev server only, and without the VITE_ prefix it can never reach the bundle.
  const serverEnv = loadEnv(mode, import.meta.dirname, '');
  const apiTarget = serverEnv.OPS_API_PROXY_TARGET ?? DEFAULT_API_TARGET;

  return {
    plugins: [react()],
    // The guard above and the exposure rule here must name the same prefix, so it is stated once.
    envPrefix: CLIENT_ENV_PREFIX,
    server: { proxy: createApiProxy(apiTarget) },
  };
});
