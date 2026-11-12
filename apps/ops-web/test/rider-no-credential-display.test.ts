import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { codeOf } from './support/code-of';
import { moduleSpecifiers } from './support/wire-type-scan';

/**
 * **The rider screens hold one credential, and one place draws it** (surfaces/ops-portal.md section 7; SECURITY_DESIGN.md section 13.6). The
 * enrolment code of a first binding or a replacement is a short-lived bearer credential that the officer's browser must hold to draw it as a QR
 * code. Everything else a rider has (the PIN, the private key, the attestation) is made on the handset and never reaches the officer, and no
 * answer carries it.
 *
 * The runtime tests of each screen plant the code and look for it in every place it could be left. This is the structural half: the code of the
 * rider screens reaches for the QR picture and the transient secret from one file each, for nothing that draws, holds or reads a PIN or a
 * password, and names the credential only where it is judged and where it is drawn. It reads the syntax tree, not the text, so a comment that
 * says "the PIN is never shown" is not a PIN being shown. It is by construction, so that a later change that adds a "copy the link" button, a PIN
 * field or a second place that prints the code fails here, before anyone has to notice it in review.
 */
const SRC = resolve(import.meta.dirname, '../src');

const SCREEN_CODE = ['app/pages/riders', 'platform/rider'];

/** The one file that draws the code, and the one that holds it. */
const DRAWS = 'app/pages/riders/EnrolmentCode.tsx';
const HOLDS = 'app/pages/riders/use-enrolment-code.ts';
/** The file that judges what the API answers, and so is the one place that names the field of the code. */
const JUDGES = 'platform/rider/rider-shape.ts';

/** Modules that no rider screen may import: they draw or read a PIN, a password, an authenticator's material or a link's grant. */
const NEVER = [
  /password-input/,
  /code-input/,
  /one-time-secret/,
  /qr-matrix/,
  /secrets\/otpauth/,
  /auth\/use-grant-token/,
  /auth\/grant-fragment/,
  /auth\/pre-sign-in-shape/,
  /auth\/password-rule/,
];

/**
 * The names of what a handset makes or a server hashes, as they would be written in code (as a name or as a string): nothing of the rider
 * screens can name one.
 */
const NAMES_OF_WHAT_NEVER_ARRIVES = [
  'pin_hash',
  'pinHash',
  'public_key',
  'publicKey',
  'key_attestation',
  'keyAttestation',
  'certificate_chain',
  'certificateChain',
  'setup_token',
  'setupToken',
  'token_hash',
  'password_hash',
  'secret_hash',
  'device_credential_hash',
  'new_credential',
  'otpauth_uri',
  'OneTimeSecret',
  'PasswordInput',
  'CodeInput',
  'useGrantToken',
  'tokenFromHash',
];

/** A bare `pin` is the PIN itself; the string `'pin'` is a column of the roster that says whether one is set, and is no name. */
const BARE_NAMES_OF_WHAT_NEVER_ARRIVES = ['pin'];

function sourceFiles(path: string): string[] {
  const absolute = join(SRC, path);
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    return /\.tsx?$/.test(path) ? [absolute] : [];
  }
  return entries.flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return sourceFiles(child);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [join(SRC, child)]
      : [];
  });
}

const files = SCREEN_CODE.flatMap(sourceFiles).map((path) => {
  const text = readFileSync(path, 'utf8');
  const name = relative(SRC, path).split(sep).join('/');
  return { path: name, text, code: codeOf(text, name) };
});

const fileNamed = (path: string) => {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`The scan does not include ${path}`);
  return file;
};

describe('what is scanned', () => {
  // Break caught: a scan over nothing, which would pass whatever the code contains.
  it('is the pages and the platform code of the rider screens', () => {
    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'app/pages/riders/RiderListPage.tsx',
        'app/pages/riders/RiderDetailPage.tsx',
        'app/pages/riders/RiderDevicePage.tsx',
        'app/pages/riders/RiderDeviceRegisterPage.tsx',
        DRAWS,
        HOLDS,
        JUDGES,
        'platform/rider/rider-commands.ts',
        'platform/rider/use-rider-queries.ts',
      ]),
    );
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  // Break caught: a reader of code that takes a comment for code, or cannot see what it is looking for, which would pass whatever the code holds.
  it('reads the code and not the comments, and sees an element, an attribute, a name and a string in it', () => {
    const code = codeOf(
      [
        '// pin_hash',
        '/* public_key */',
        'const a = <Input type="password" name="pin" />;',
        "const b = answer.pin_hash + 'setup_token';",
      ].join('\n'),
      'x.tsx',
    );

    expect(code.names.has('pin_hash')).toBe(true);
    expect(code.names.has('public_key')).toBe(false);
    expect(code.strings.has('setup_token')).toBe(true);
    expect(code.elements.has('Input')).toBe(true);
    expect(code.elements.has('Textarea')).toBe(false);
    expect(code.attributes.has('Input.type=password')).toBe(true);
    expect(code.attributes.has('Input.name=pin')).toBe(true);
    expect(code.accesses).toContain('answer.pin_hash');
    expect(
      codeOf('const c = <QrCode payload={grant.enrolmentUri} />;', 'x.tsx').attributes,
    ).toContain('QrCode.payload={grant.enrolmentUri}');
  });

  // Break caught: a reader that loses its place in a file full of templates, which is how a scan over tokens went blind on the roster page.
  it('reads the whole of a file that holds template strings and text with apostrophes', () => {
    const code = codeOf(
      'const a = `Showing ${String(n)} ${n === 1 ? "rider" : "riders"}.`; const b = <p>Rider’s <Input name="q" /></p>;',
      'x.tsx',
    );

    expect(code.elements.has('Input')).toBe(true);
    expect(code.attributes.has('Input.name=q')).toBe(true);
  });
});

describe('the rider screens and a credential', () => {
  // Break caught: an import of anything that draws or reads a PIN, a password or an authenticator's material into a screen of an officer.
  it('import nothing that draws, holds or reads a PIN, a password or a link’s grant', () => {
    const offending = files.flatMap((file) =>
      moduleSpecifiers(file.text, file.path)
        .filter((specifier) => NEVER.some((pattern) => pattern.test(specifier)))
        .map((specifier) => `${file.path}: ${specifier}`),
    );

    expect(offending).toEqual([]);
  });

  // Break caught: a second place that draws the code, which is a second place to get its rules wrong.
  it('draw the QR code in one file', () => {
    const importing = files
      .filter((file) =>
        moduleSpecifiers(file.text, file.path).some((specifier) => specifier.includes('qr-code/')),
      )
      .map((file) => file.path);

    expect(importing).toEqual([DRAWS]);
  });

  // Break caught: a second place that holds the code, outside the rule that clears it on navigation, expiry, completion and a hidden page.
  it('hold a credential with the transient secret in one file', () => {
    const importing = files
      .filter((file) =>
        moduleSpecifiers(file.text, file.path).some((specifier) =>
          specifier.includes('use-transient-secret'),
        ),
      )
      .map((file) => file.path);

    expect(importing).toEqual([HOLDS]);
  });

  // Break caught: a field of an answer that carries what a handset made, or a component that shows a credential, named in a screen.
  it('name nothing that a handset makes or a server hashes, in code', () => {
    const offending = files.flatMap((file) =>
      [
        ...NAMES_OF_WHAT_NEVER_ARRIVES.filter(
          (name) => file.code.names.has(name) || file.code.strings.has(name),
        ),
        ...BARE_NAMES_OF_WHAT_NEVER_ARRIVES.filter((name) => file.code.names.has(name)),
      ].map((name) => `${file.path}: ${name}`),
    );

    expect(offending).toEqual([]);
  });

  // Break caught: the field of the code read anywhere but where the answer is judged and where it is drawn: a page that read it could print it.
  it('read the field of the code in the file that judges the answer and the file that draws it, and nowhere else', () => {
    const naming = files
      .filter(
        (file) =>
          file.code.names.has('enrolment_uri') ||
          file.code.strings.has('enrolment_uri') ||
          file.code.names.has('enrolmentUri'),
      )
      .map((file) => file.path)
      .toSorted();

    expect(naming).toEqual([DRAWS, JUDGES].toSorted());
  });

  // Break caught: the code used as text, a link or an attribute in the one file that draws it: it is the payload of the picture and nothing else.
  it('use the code in the one file that draws it as the payload of the picture and nothing else', () => {
    const { code } = fileNamed(DRAWS);

    expect(code.accesses.filter((access) => access.endsWith('.enrolmentUri'))).toEqual([
      'grant.enrolmentUri',
    ]);
    expect(code.attributes.has('QrCode.payload={grant.enrolmentUri}')).toBe(true);
  });

  // Break caught: a text field or a password field on a screen that is not a form for one. The roster search is a field of the filter bar since Stage 4.7 (the page hands the bar its search: a label,
  // the text, what to do with it and the length it may have), so no rider screen draws an input of its own; the verification note is the one text area.
  it('draw no text input of their own (the roster search is the filter bar’s, the note is a text area), and never a password or a PIN field', () => {
    const drawing = (element: string) =>
      files.filter((file) => file.code.elements.has(element)).map((file) => file.path);

    expect(drawing('Input')).toEqual([]);
    expect(drawing('Textarea')).toEqual(['app/pages/riders/RiderDevicePage.tsx']);
    for (const file of files) {
      for (const element of file.code.elements) {
        for (const forbidden of ['type=password', 'type=tel', 'name=password', 'name=pin']) {
          expect(
            file.code.attributes.has(`${element}.${forbidden}`),
            `${file.path}: ${element}`,
          ).toBe(false);
        }
      }
    }
  });
});
