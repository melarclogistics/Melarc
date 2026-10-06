import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';

/**
 * A port on this machine that nothing is listening on. The operating system picks it, and it is released
 * before it is returned, so another process could take it in the gap: a stack that fails to bind says so,
 * and a rerun gets another.
 */
export async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}
