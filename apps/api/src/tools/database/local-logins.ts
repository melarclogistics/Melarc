import { createHmac } from 'node:crypto';

/**
 * The password a local or test cluster gives a login role of its own beyond the three that have settings: the worker
 * base identity and the provisioning identity (S0.5). It is derived from the administrator password and the role name,
 * so those two logins need no `MELARC_PG_*` setting of their own and an existing local settings file keeps working. The
 * same function is used by the tool that sets the password and by the tests that connect with it.
 *
 * This is for a cluster on this machine only: `provisionRoles` refuses any other host. A deployed environment gives
 * each identity a secret of its own, held in its secret store (DEPLOYMENT_AND_ENVIRONMENTS.md), and never derives one.
 */
export function localLoginPassword(adminPassword: string, role: string): string {
  if (adminPassword === '' || role === '') {
    throw new Error('A local login password needs the administrator password and the role name');
  }
  return createHmac('sha256', adminPassword)
    .update(`melarc-local-login:${role}`)
    .digest('base64url');
}
