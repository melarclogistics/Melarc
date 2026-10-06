/** Vite exposes exactly the variables with this prefix to the browser bundle. */
export const CLIENT_ENV_PREFIX = 'VITE_';

/** Exported so that its test can try every word in it. */
export const LOOKS_LIKE_A_SECRET =
  /(SECRET|TOKEN|PASSWORD|PASSWD|KEY|CREDENTIAL|PRIVATE|SIGNATURE)/i;

/**
 * Refuses to build when a variable that will be bundled into public JavaScript is named like a secret.
 * Anything with the VITE_ prefix is readable by every visitor, so "keep secrets out of browser bundles"
 * (DEVELOPMENT_EXECUTION_PLAN.md section 6) becomes a failing build rather than a review item.
 *
 * Variables without the prefix never reach the bundle and are not examined. The message names the
 * offending variables and never their values.
 */
export function assertNoSecretsInClientEnv(
  env: Readonly<Record<string, string | undefined>>,
): void {
  const offending = Object.keys(env).filter(
    (name) =>
      name.startsWith(CLIENT_ENV_PREFIX) &&
      LOOKS_LIKE_A_SECRET.test(name.slice(CLIENT_ENV_PREFIX.length)),
  );
  if (offending.length > 0) {
    throw new Error(
      `Refusing to build: ${offending.join(', ')} would be bundled into the public browser code but ` +
        `look like secrets. Everything prefixed ${CLIENT_ENV_PREFIX} is public; keep secrets on the server.`,
    );
  }
}
