import { X509Certificate, createPrivateKey } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * The test certificates of the trusted HTTPS origin (S0.23; SLICE-000-FINAL-DECISIONS.md §11; implementation plan §11.5): a
 * disposable CA and one leaf it signed, **kept outside the repository** in a directory the developer names with
 * `MELARC_E2E_TLS_DIR`. Nothing is ever generated into the checkout, nothing is trusted machine-wide by any code here, and no
 * check in this harness turns certificate validation off (`ignoreHTTPSErrors` is not trust evidence).
 *
 * This file is the **policy**: what a directory of test material must look like before a run is allowed to use it. It reads the
 * files and judges facts about them; it generates nothing (`test-ca.ts` does, on a machine the owner has cleared) and it never
 * prints or returns a private key.
 */

export const TLS_FILES = Object.freeze({
  /** The CA certificate: public. */
  ca: 'ca.pem',
  /** The leaf certificate the Ops origin presents: public. */
  leaf: 'leaf.pem',
  /** The leaf's private key. The CA's own key is never kept: the generator removes it as soon as the leaf is signed. */
  leafKey: 'leaf-key.pem',
});

/** The longest a test certificate may be valid. The material is disposable; a certificate valid for years is not. */
export const MAX_VALID_DAYS = 31;
const DAY_MS = 86_400_000;

/** Whether a certificate carries the name constraints extension (2.5.29.30), and whether it marks it critical. */
export type NameConstraints = 'critical' | 'not-critical' | 'absent';

/** What is judged about a certificate: facts, so that the policy is tested without a certificate to sign. */
export interface CertificateFacts {
  readonly subject: string;
  readonly issuer: string;
  readonly isCa: boolean;
  readonly validFrom: Date;
  readonly validTo: Date;
  /** The names of the subject alternative name extension, as `DNS:localhost` and `IP Address:127.0.0.1` read. */
  readonly alternativeNames: readonly string[];
  readonly nameConstraints: NameConstraints;
  /** Whether the certificate's signature verifies with its own public key: a self-signed certificate that is, and not only says so. */
  readonly selfSignatureValid: boolean;
  readonly fingerprint256: string;
}

export function factsOf(certificate: X509Certificate): CertificateFacts {
  return {
    subject: certificate.subject,
    issuer: certificate.issuer,
    isCa: certificate.ca,
    validFrom: new Date(certificate.validFrom),
    validTo: new Date(certificate.validTo),
    alternativeNames:
      certificate.subjectAltName === undefined
        ? []
        : certificate.subjectAltName.split(',').map((name) => name.trim()),
    nameConstraints: nameConstraintsOf(certificate.raw),
    selfSignatureValid: certificate.verify(certificate.publicKey),
    fingerprint256: certificate.fingerprint256,
  };
}

/** One DER element: its tag, and where its content begins and ends. */
interface Element {
  readonly tag: number;
  readonly start: number;
  readonly end: number;
}

/** The element at `offset`, or undefined when what is there is not a well-formed element that fits before `limit`. */
function elementAt(der: Uint8Array, offset: number, limit: number): Element | undefined {
  const tag = der[offset];
  const first = der[offset + 1];
  if (tag === undefined || first === undefined || offset + 2 > limit) return undefined;
  // A tag number of 31 or more is not used by anything read here.
  if ((tag & 0x1f) === 0x1f) return undefined;
  let length = first;
  let start = offset + 2;
  if ((first & 0x80) !== 0) {
    const octets = first & 0x7f;
    // Indefinite lengths (0x80) are BER, not DER, and a length of more than four octets is not a certificate.
    if (octets === 0 || octets > 4 || start + octets > limit) return undefined;
    length = 0;
    for (let at = 0; at < octets; at += 1) length = length * 256 + (der[start + at] ?? 0);
    start += octets;
  }
  const end = start + length;
  return end > limit ? undefined : { tag, start, end };
}

/** The elements directly inside `parent`, in order. A malformed one ends the list. */
function elementsIn(der: Uint8Array, parent: Element): Element[] {
  const found: Element[] = [];
  for (let at = parent.start; at < parent.end;) {
    const element = elementAt(der, at, parent.end);
    if (element === undefined) break;
    found.push(element);
    at = element.end;
  }
  return found;
}

/** An object identifier in the dotted form (`2.5.29.30`). */
function dotted(der: Uint8Array, identifier: Element): string {
  const parts: number[] = [];
  let value = 0;
  for (let at = identifier.start; at < identifier.end; at += 1) {
    const octet = der[at] ?? 0;
    value = value * 128 + (octet & 0x7f);
    if ((octet & 0x80) === 0) {
      if (parts.length === 0) {
        // The first octet carries the first two arcs as 40 * first + second, the first being 0, 1 or 2.
        const first = Math.min(Math.floor(value / 40), 2);
        parts.push(first, value - first * 40);
      } else parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
}

/** One extension of a certificate: its identifier in the dotted form, and whether it is marked critical. */
export interface ExtensionEntry {
  readonly id: string;
  readonly critical: boolean;
}

/**
 * The extensions of the certificate in `der`, in order, read **structurally** (the certificate, its to-be-signed part, the `[3]`
 * extensions, each extension's identifier and flag), so that the same bytes inside another extension, a name or a key are not
 * mistaken for one. Anything that does not read as a certificate has none: the policy fails closed.
 */
export function extensionsOf(der: Uint8Array): ExtensionEntry[] {
  const certificate = elementAt(der, 0, der.length);
  if (certificate?.tag !== 0x30) return [];
  const tbs = elementsIn(der, certificate)[0];
  if (tbs?.tag !== 0x30) return [];
  // `extensions [3] EXPLICIT Extensions`: a context-specific constructed element holding the one sequence of extensions.
  const wrapper = elementsIn(der, tbs).find((element) => element.tag === 0xa3);
  const sequence = wrapper === undefined ? undefined : elementsIn(der, wrapper)[0];
  if (sequence?.tag !== 0x30) return [];
  const found: ExtensionEntry[] = [];
  for (const extension of elementsIn(der, sequence)) {
    if (extension.tag !== 0x30) continue;
    const [identifier, second] = elementsIn(der, extension);
    if (identifier?.tag !== 0x06) continue;
    // `critical BOOLEAN DEFAULT FALSE` is written only when it is TRUE, and comes before the value when it is.
    const critical =
      second?.tag === 0x01 && second.end - second.start === 1 && der[second.start] !== 0;
    found.push({ id: dotted(der, identifier), critical });
  }
  return found;
}

/** 2.5.29.30: the name constraints extension. */
const NAME_CONSTRAINTS = '2.5.29.30';

/** Whether the certificate in `der` has a name constraints extension and whether it is critical. */
export function nameConstraintsOf(der: Uint8Array): NameConstraints {
  const found = extensionsOf(der).find((extension) => extension.id === NAME_CONSTRAINTS);
  if (found === undefined) return 'absent';
  return found.critical ? 'critical' : 'not-critical';
}

/** The names the leaf has, as a certificate's subject alternative name reads: the loopback host and its address. */
const LEAF_NAMES: readonly string[] = ['DNS:localhost', 'IP Address:127.0.0.1'];

/** The reasons a certificate is not acceptable as test material in the role it was given, or an empty list. */
export function certificateProblems(
  role: 'ca' | 'leaf',
  facts: CertificateFacts,
  now: Date,
): string[] {
  const problems: string[] = [];
  const name = role === 'ca' ? 'the CA certificate' : 'the leaf certificate';
  if (facts.validFrom.getTime() > now.getTime()) problems.push(`${name} is not valid yet`);
  if (facts.validTo.getTime() <= now.getTime()) problems.push(`${name} has expired`);
  if (facts.validTo.getTime() - facts.validFrom.getTime() > MAX_VALID_DAYS * DAY_MS) {
    problems.push(
      `${name} is valid for more than ${String(MAX_VALID_DAYS)} days: test material is disposable`,
    );
  }
  if (role === 'ca') {
    if (!facts.isCa) problems.push('the CA certificate is not a certificate authority');
    if (facts.subject !== facts.issuer) problems.push('the CA certificate is not self-signed');
    else if (!facts.selfSignatureValid) {
      problems.push('the CA certificate is not signed by its own key');
    }
    // What this can say of the constraints is that they exist and bind. What they permit is what the generator asks `openssl` for, and
    // whether the CA refuses a name outside the loopback is proved with `openssl verify` on the machine that generates it (e2e/README.md).
    if (facts.nameConstraints === 'absent') {
      problems.push('the CA certificate has no name constraints: it could vouch for any name');
    } else if (facts.nameConstraints === 'not-critical') {
      problems.push(
        'the name constraints of the CA certificate are not critical: a client that does not understand them would ignore them',
      );
    }
  } else {
    if (facts.isCa) problems.push('the leaf certificate is a certificate authority');
    for (const required of LEAF_NAMES) {
      if (!facts.alternativeNames.includes(required)) {
        problems.push(`the leaf certificate does not name ${required}`);
      }
    }
    // The leaf names the loopback and nothing else: a name beyond it is one the browser would accept this leaf for.
    for (const name of facts.alternativeNames) {
      if (!LEAF_NAMES.includes(name)) {
        problems.push(`the leaf certificate names ${name}, which is outside the loopback`);
      }
    }
  }
  return problems;
}

/**
 * Whether `child` lies inside `parent` (or is it), compared as paths by their components and not as text. The relative path leaves
 * the parent only when it is exactly `..` or begins with `..` and the separator: a child whose name merely begins with dots
 * (`..keys`) is inside, and a different drive or share has no relative path (it comes back absolute).
 */
export function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  if (path === '') return true;
  if (isAbsolute(path)) return false;
  return path !== '..' && !path.startsWith(`..${sep}`);
}

/**
 * The path as the operating system resolves it: every link, junction, short name and case in the part that exists is followed, and
 * what does not exist yet is added back unchanged. A path nothing of which can be resolved is returned as written.
 */
export function resolvedPath(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(existing);
      return missing.length === 0 ? real : join(real, ...missing.toReversed());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return resolve(path);
      missing.push(basename(existing));
      existing = parent;
    }
  }
}

/** What a folder is, apart from its name: the same string for the same folder, whatever reaches it; undefined if it cannot be told. */
export type FolderIdentity = (path: string) => string | undefined;

/** The device and file identity of what is at `path`, or undefined when it does not exist or the file system gives no identity. */
const identityOf: FolderIdentity = (path) => {
  try {
    const found = statSync(path, { bigint: true });
    // A file system without file identities (some shares, FAT) reports 0 for all of them, which would make every folder one folder.
    return found.ino === 0n ? undefined : `${String(found.dev)}:${String(found.ino)}`;
  } catch {
    return undefined;
  }
};

/**
 * Whether `directory`, or any folder above it that exists, is the very folder `root` is, whatever name reaches it: a share of the
 * local disk, a bind mount or another spelling of the path that resolving it does not collapse.
 */
export function isSameFolderAbove(
  root: string,
  directory: string,
  identity: FolderIdentity = identityOf,
): boolean {
  const target = identity(root);
  if (target === undefined) return false;
  for (let current = resolvedPath(directory); ;) {
    if (identity(current) === target) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * The directory must be absolute and outside the checkout **wherever it leads**: key material never sits where `git add` could take
 * it, and a link, a junction, a short name, a case or an extended-length spelling that only differs on this file system puts a folder
 * inside the checkout though its written path is outside it. The directory and the checkout are compared as written, as the operating
 * system resolves them, and by the identity of the folders.
 */
export function directoryProblems(
  directory: string,
  checkoutRoot: string,
  identity: FolderIdentity = identityOf,
): string[] {
  const problems: string[] = [];
  if (!isAbsolute(directory)) problems.push('the TLS directory is not an absolute path');
  else if (
    isInside(checkoutRoot, directory) ||
    isInside(resolvedPath(checkoutRoot), resolvedPath(directory)) ||
    isSameFolderAbove(checkoutRoot, directory, identity)
  ) {
    problems.push(
      'the TLS directory is inside the repository checkout: test key material is kept outside it',
    );
  }
  return problems;
}

export interface TlsMaterial {
  readonly directory: string;
  readonly caPath: string;
  readonly leafPath: string;
  readonly leafKeyPath: string;
  readonly caFingerprint256: string;
  readonly leafFingerprint256: string;
  /** Things worth knowing that are not failures (for instance that file modes cannot be checked on this platform). */
  readonly notes: readonly string[];
}

export type TlsMaterialResult =
  | { readonly ok: true; readonly material: TlsMaterial }
  | { readonly ok: false; readonly problems: readonly string[] };

export interface TlsMaterialOptions {
  readonly checkoutRoot: string;
  readonly now?: Date;
  /** The platform, so that the mode check is judged as it would be there. Defaults to this one. */
  readonly platform?: NodeJS.Platform;
}

/**
 * Reads the material in `directory` and judges it. Everything wrong is reported at once, and nothing but the paths, the fingerprints
 * and the reasons is ever returned or printed.
 *
 * The checks: the directory is outside the checkout (wherever it leads: links, junctions and other spellings are resolved); the
 * three files are regular files (not links); the private key is readable by its owner alone where the platform has modes (on
 * Windows the directory must be private to the account and is **not checked**: the result says so); the CA is a self-signed
 * authority (it verifies under its own key) that carries critical name constraints, and the leaf is not an authority and names
 * `localhost` and `127.0.0.1` and nothing else; both are valid now and for no more than 31 days; the leaf was signed by this CA; and
 * the private key is the leaf's. That the constraints permit the loopback alone is what the generator asks `openssl` for; the policy
 * reads that they exist and bind, not their content, and does not claim to prove it. The proof that this CA refuses a name outside the
 * loopback is made with `openssl verify` where the CA is made, before its key is deleted (e2e/README.md); a handwritten reader of
 * the extension's content is not a certificate validator and is not grown into one.
 */
export function checkTlsMaterial(
  directory: string,
  options: TlsMaterialOptions,
): TlsMaterialResult {
  const now = options.now ?? new Date();
  const platform = options.platform ?? process.platform;
  const problems = directoryProblems(directory, options.checkoutRoot);
  if (problems.length > 0) return { ok: false, problems };

  const notes: string[] = [];
  const paths = {
    ca: join(directory, TLS_FILES.ca),
    leaf: join(directory, TLS_FILES.leaf),
    leafKey: join(directory, TLS_FILES.leafKey),
  };
  for (const [role, path] of Object.entries(paths)) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) problems.push(`${role}: ${path} is not a regular file`);
      else if (role === 'leafKey') {
        if (platform === 'win32') {
          notes.push(
            'the private key file mode is not checked on Windows: the directory must be private to the account',
          );
        } else if ((stat.mode & 0o077) !== 0) {
          problems.push(`the private key ${path} is readable by others: its mode must be 0600`);
        }
      }
    } catch {
      problems.push(`${role}: ${path} does not exist`);
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  let ca: X509Certificate;
  let leaf: X509Certificate;
  try {
    ca = new X509Certificate(readFileSync(paths.ca));
    leaf = new X509Certificate(readFileSync(paths.leaf));
  } catch {
    return { ok: false, problems: ['a certificate file could not be read as a certificate'] };
  }
  problems.push(...certificateProblems('ca', factsOf(ca), now));
  problems.push(...certificateProblems('leaf', factsOf(leaf), now));
  if (!leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) {
    problems.push('the leaf certificate was not signed by this CA');
  }
  try {
    if (!leaf.checkPrivateKey(createPrivateKey(readFileSync(paths.leafKey)))) {
      problems.push('the private key is not the leaf certificate’s');
    }
  } catch {
    problems.push('the private key file could not be read as a private key');
  }
  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    material: {
      directory,
      caPath: paths.ca,
      leafPath: paths.leaf,
      leafKeyPath: paths.leafKey,
      caFingerprint256: ca.fingerprint256,
      leafFingerprint256: leaf.fingerprint256,
      notes,
    },
  };
}

/** The directory the developer named, or `undefined` when the run is the plain HTTP one. Blank is not a directory. */
export function tlsDirectoryFrom(environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment.MELARC_E2E_TLS_DIR;
  return value === undefined || value.trim() === '' ? undefined : value;
}
