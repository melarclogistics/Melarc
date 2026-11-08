import { describe, expect, it } from 'vitest';

import { localLoginPassword } from './local-logins.js';

const ADMIN = 'an-administrator-password-for-a-test';

describe('localLoginPassword: the password a local cluster gives a login of its own', () => {
  // Break caught: a password that changes between runs, so a role provisioned by one process cannot be reached by the
  // next, or one that is not the same for the tool that sets it and the test that uses it.
  it('is the same for the same administrator password and role', () => {
    expect(localLoginPassword(ADMIN, 'melarc_worker_runtime')).toBe(
      localLoginPassword(ADMIN, 'melarc_worker_runtime'),
    );
  });

  // Break caught: two logins sharing a password, which would make a credential for one a credential for the other.
  it('differs for each role', () => {
    const worker = localLoginPassword(ADMIN, 'melarc_worker_runtime');
    const provisioning = localLoginPassword(ADMIN, 'melarc_provisioning');
    expect(worker).not.toBe(provisioning);
  });

  // Break caught: the password not depending on the administrator's, so that it is public knowledge from the source.
  it('depends on the administrator password', () => {
    expect(localLoginPassword(ADMIN, 'melarc_provisioning')).not.toBe(
      localLoginPassword(`${ADMIN}-changed`, 'melarc_provisioning'),
    );
  });

  // Break caught: the administrator password itself being used, or a short or guessable result.
  it('is not the administrator password, and is long enough to be a secret', () => {
    const password = localLoginPassword(ADMIN, 'melarc_provisioning');
    expect(password).not.toBe(ADMIN);
    expect(password).not.toContain(ADMIN);
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  // Break caught: a derivation that gives nothing for an empty secret, which would hide an unconfigured cluster.
  it('refuses an empty administrator password or role', () => {
    expect(() => localLoginPassword('', 'melarc_provisioning')).toThrow();
    expect(() => localLoginPassword(ADMIN, '')).toThrow();
  });
});
