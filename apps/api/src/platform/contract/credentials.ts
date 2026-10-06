import { parseCookieHeader } from './cookies.js';
import { isJsonObject, type Json } from './json.js';

type Headers = Readonly<Record<string, string | readonly string[] | undefined>>;

/** Whether a request, by its headers, presented one security scheme's credential. */
export type CredentialCheck = (headers: Headers) => boolean;

const first = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : value?.[0];

/**
 * Reads a security scheme of the contract into a check for whether a request presented its credential: a cookie
 * by its exact name, a header by its name, an HTTP scheme by its word and a token after it. It looks at what was
 * sent and never at whether it is any good: authenticating the caller belongs to the guard.
 *
 * A scheme it cannot judge (OAuth, a key in the query) throws. Treating it as "never presented" would turn off
 * a rule of the contract without anyone being told.
 */
export function credentialCheck(scheme: string, definition: Json | undefined): CredentialCheck {
  if (isJsonObject(definition)) {
    if (definition.type === 'apiKey' && typeof definition.name === 'string') {
      const name = definition.name;
      if (definition.in === 'cookie') {
        return (headers) => parseCookieHeader(headers.cookie).has(name);
      }
      if (definition.in === 'header') {
        const key = name.toLowerCase();
        return (headers) => headers[key] !== undefined;
      }
    }
    if (definition.type === 'http' && typeof definition.scheme === 'string') {
      const word = definition.scheme.replaceAll(/[^\w-]/g, '');
      const pattern = new RegExp(`^${word}\\s+\\S`, 'i');
      return (headers) => pattern.test(first(headers.authorization) ?? '');
    }
  }
  throw new Error(
    `The contract's security scheme ${scheme} is of a kind whose credential this validator cannot recognise in a request.`,
  );
}
