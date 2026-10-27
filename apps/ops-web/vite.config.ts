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
    server: {
      // The API accepts a state-changing request only from the one origin it is configured with (`OPS_ORIGIN`, http://127.0.0.1:5172 in
      // its example settings), so the development server listens exactly there and never moves to another port: a portal opened at any
      // other address loads and is then refused at every sign-in (test/dev-server-origin.test.ts). It is not Vite's default 5173, which
      // other projects on the same machine take (the owner's decision of 27 October 2026).
      host: '127.0.0.1',
      port: 5172,
      strictPort: true,
      proxy: createApiProxy(apiTarget),
    },
  };
});
