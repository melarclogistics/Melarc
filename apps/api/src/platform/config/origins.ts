/**
 * The browser origins of the two surfaces and the links that point at them (SECURITY_DESIGN.md §14.8; surfaces/ops-portal.md,
 * "The three link pages"). An origin is written exactly as a browser sends it in `Origin`, because the check is an exact
 * comparison and a looser spelling would either never match or match too much.
 */

/** The origin as `new URL(text).origin` writes it, or undefined. http and https only, nothing after the host and port. */
export function parseOrigin(text: string): string | undefined {
  if (!/^https?:\/\/[^\s/?#@]+$/.test(text)) return undefined;
  try {
    const url = new URL(text);
    return url.origin === text && url.protocol.startsWith('http') ? text : undefined;
  } catch {
    return undefined;
  }
}

export interface LinkTemplates {
  readonly ops: {
    readonly setupCredential: string;
    readonly setupMfa: string;
    readonly recovery: string;
  };
  readonly vendor: {
    readonly setupCredential: string;
    readonly setupDevice: string;
    readonly recovery: string;
  };
}

const PLACEHOLDER = '{token}';

/**
 * Where each link points: the page the surface owns, on the configured origin, with the token in the **fragment**, which a
 * browser never sends to a server and which the page removes at once. The paths are the surfaces' own routes and are not
 * settings: a deployment can choose its host, not where a token travels, and a template cannot be made to point off the
 * configured origin because it is built from it.
 */
export function linkTemplates(origins: { ops: string; vendor: string }): LinkTemplates {
  const at = (origin: string, path: string): string => `${origin}${path}#token=${PLACEHOLDER}`;
  return {
    ops: {
      setupCredential: at(origins.ops, '/setup/credential'),
      setupMfa: at(origins.ops, '/setup/mfa'),
      recovery: at(origins.ops, '/recovery/complete'),
    },
    vendor: {
      setupCredential: at(origins.vendor, '/setup/credential'),
      setupDevice: at(origins.vendor, '/setup/device'),
      recovery: at(origins.vendor, '/recovery/complete'),
    },
  };
}

const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

/** A template with its placeholder as the one `{token}` of its fragment. */
function isTemplate(template: string): boolean {
  const hash = template.indexOf('#');
  if (hash < 0) return false;
  const path = template.slice(0, hash);
  const fragment = template.slice(hash + 1);
  return !path.includes(PLACEHOLDER) && fragment === `token=${PLACEHOLDER}`;
}

/** The link for one token. The token is the URL-safe form of a token (no character that would move or extend the link). */
export function renderLink(template: string, token: string): string {
  if (!isTemplate(template)) throw new Error('That is not a link template.');
  if (!TOKEN.test(token)) throw new Error('That is not a link token.');
  return template.replace(PLACEHOLDER, token);
}
