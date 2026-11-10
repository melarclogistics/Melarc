import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { codeOf } from './support/code-of';
import { moduleSpecifiers } from './support/wire-type-scan';

/**
 * **No page that acts on another principal's credential may have a field capable of displaying one** (surfaces/ops-portal.md section 7).
 * Recovery, re-issue and the reset of an authenticator re-establish a path for a person to set their own credential; a screen that could show
 * one turns an administrator into a person who knows a colleague's password or can enrol a factor on a colleague's account.
 *
 * The runtime tests of each screen plant a token in the answer and look for it. This is the structural half: the code of the identity screens
 * and of what they read reaches for nothing that draws, holds or reads a credential. It is by construction, so that a later change which
 * adds a "copy the link" button or a QR code to one of these screens fails here, before anyone has to notice it in review. **It reads the syntax tree**
 * (`support/code-of.ts`, as the rider guard does), and not the tokens of a scanner: a scanner that does not read JSX as JSX takes an apostrophe in the
 * text of an element for the start of a string and a `//` for the start of a comment, and goes blind to the rest of the line, so a credential name, or an
 * `<Input` written after one, passed (the review of f6cf02b).
 */
const SRC = resolve(import.meta.dirname, '../src');

/** The code of the identity screens: their pages, and the platform code they read through and send with. */
const SCREEN_CODE = [
  'app/pages/staff',
  'app/pages/my-work/MyWorkPage.tsx',
  'platform/staff',
  // The vendor screens (S0.52b): they re-issue a setup link and start a recovery, and show a vendor's secret and browsers as facts only.
  'app/pages/vendors',
  'platform/vendor',
  // The trusted browsers (S0.45, redesign R7b): the staff profile draws a colleague's browsers through the row-and-card factory of the person's own page, which is in this folder, so
  // a "copy" control or a credential field added there would reach the profile (the security review of run 5, Stage 5.1).
  'app/pages/account',
];

/** The modules that draw, hold or read a credential: nothing of the identity screens imports one. */
const CREDENTIAL_MODULES = [
  /one-time-secret/,
  /qr-code/,
  /qr-matrix/,
  /use-transient-secret/,
  /password-input/,
  /code-input/,
  /secrets\/otpauth/,
  /auth\/use-grant-token/,
  /auth\/grant-fragment/,
  /auth\/pre-sign-in-shape/,
  /auth\/password-rule/,
];

/** The names a credential has on the wire and in the page, as they would be written in code. */
const CREDENTIAL_NAMES = [
  'setup_token',
  'mfa_setup_token',
  'mfa_provisioning',
  'otpauth_uri',
  'otpauthUri',
  'setupToken',
  'QrCode',
  'OneTimeSecret',
  'PasswordInput',
  'CodeInput',
  'useTransientSecret',
  'useGrantToken',
  'tokenFromHash',
  'password_hash',
  'token_hash',
  'secret_hash',
  'device_credential_hash',
  'new_credential',
  'recovery_email',
  'recovery_phone',
];

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

/**
 * The credential names a code names, in an identifier, a property or a string. The text of an element, and a comment, are not code.
 */
function credentialNamesIn(code: ReturnType<typeof codeOf>): string[] {
  return CREDENTIAL_NAMES.filter((name) => code.names.has(name) || code.strings.has(name));
}

/** Whether a code draws a text field (`<Input`) or a field that is a password (`type="password"`, `name="password"`, on any element). */
function fieldsIn(code: ReturnType<typeof codeOf>): {
  readonly text: boolean;
  readonly password: boolean;
} {
  const password = [...code.elements].some(
    (element) =>
      code.attributes.has(`${element}.type=password`) ||
      code.attributes.has(`${element}.name=password`),
  );
  return { text: code.elements.has('Input'), password };
}

describe('what is scanned', () => {
  // Break caught: a scan over nothing, which would pass whatever the code contains.
  it('is the pages and the platform code of the identity screens', () => {
    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'app/pages/staff/StaffDetailPage.tsx',
        'app/pages/staff/StaffMfaResetPage.tsx',
        'app/pages/staff/StaffCreatePage.tsx',
        'app/pages/staff/StaffListPage.tsx',
        'app/pages/staff/SessionsPage.tsx',
        'app/pages/my-work/MyWorkPage.tsx',
        'platform/staff/staff-shape.ts',
        'platform/staff/staff-commands.ts',
        // The row-and-card factory of the trusted browsers, which the staff profile draws as well as the person's own page.
        'app/pages/account/TrustedBrowserTable.tsx',
        'app/pages/account/TrustedBrowsersPage.tsx',
      ]),
    );
    expect(files.length).toBeGreaterThanOrEqual(11);
  });

  it('reads a file without its comments', () => {
    const code = codeOf('// setup_token\nconst a = 1; /* otpauth_uri */', 'x.ts');

    expect(credentialNamesIn(code)).toEqual([]);
  });

  // Break caught: a check for a field that cannot see one, because it reads the text and not the syntax.
  it('sees a text field and a password field in code, and not in a comment or a string of words', () => {
    const field = fieldsIn(
      codeOf('const a = <Input type="password" name="secret" aria-label="x" readOnly />;', 'x.tsx'),
    );
    const named = fieldsIn(codeOf("const a = <input name='password' />;", 'x.tsx'));
    const words = fieldsIn(
      codeOf('// <Input type="password" />\nconst a = "no type=password here";', 'x.tsx'),
    );

    expect(field).toEqual({ text: true, password: true });
    expect(named.password).toBe(true);
    expect(words).toEqual({ text: false, password: false });
  });

  // Break caught (the review of f6cf02b): a reader that does not read JSX as JSX. An apostrophe in the text of an element is taken for the start of a string, which swallows the rest of the
  // line; a `//` in it, for the start of a comment. Each of these hides, from such a reader, what is written after it, and each must be found.
  it('finds a credential name, a text field and a password field written after an apostrophe or a // in the text of an element', () => {
    const afterAnApostrophe = codeOf(
      `const a = <p>The person's profile</p>; const b = answer.setup_token; const c = <Input type="password" />; const d = <PasswordInput />;`,
      'x.tsx',
    );
    expect(credentialNamesIn(afterAnApostrophe)).toEqual(
      expect.arrayContaining(['setup_token', 'PasswordInput']),
    );
    expect(fieldsIn(afterAnApostrophe)).toEqual({ text: true, password: true });

    const afterSlashes = codeOf(
      `const a = <p>See https://example.test/ // and then</p>; const b = <Input name="password" />; const c = useTransientSecret();`,
      'x.tsx',
    );
    expect(credentialNamesIn(afterSlashes)).toEqual(['useTransientSecret']);
    expect(fieldsIn(afterSlashes)).toEqual({ text: true, password: true });

    // Several elements on one line, the text of each with its own apostrophe; and a template with a quote in it.
    const crowded = codeOf(
      "const a = <div><p>Don't</p><p>Won't</p><Input type=\"password\" /></div>; const b = `it's ${x} 'quoted'`; const c = <QrCode payload={x} />;",
      'x.tsx',
    );
    expect(fieldsIn(crowded)).toEqual({ text: true, password: true });
    expect(credentialNamesIn(crowded)).toEqual(['QrCode']);
  });

  // Break caught: a reader that takes the words of an element for a credential being named, which would fail a screen for what it says.
  it('does not take the words of an element, or of a comment, for a credential being named', () => {
    const code = codeOf(
      `// setup_token is never shown\nconst a = <p>The setup_token and the password_hash are never drawn. Use the PasswordInput elsewhere.</p>;`,
      'x.tsx',
    );

    expect(credentialNamesIn(code)).toEqual([]);
    expect(fieldsIn(code)).toEqual({ text: false, password: false });
  });
});

describe('the identity screens and a credential', () => {
  // Break caught: an import of anything that draws, holds or reads a credential into a screen that must not be able to show one.
  it('import nothing that draws, holds or reads a credential', () => {
    const offending = files.flatMap((file) =>
      moduleSpecifiers(file.text, file.path)
        .filter((specifier) => CREDENTIAL_MODULES.some((pattern) => pattern.test(specifier)))
        .map((specifier) => `${file.path}: ${specifier}`),
    );

    expect(offending).toEqual([]);
  });

  // Break caught: a field of an answer that carries a credential being read, or a component that shows one being drawn.
  it('name nothing a credential is called, in code', () => {
    const offending = files.flatMap((file) =>
      credentialNamesIn(file.code).map((name) => `${file.path}: ${name}`),
    );

    expect(offending).toEqual([]);
  });

  // Break caught: a text field or a password field on a screen that is not a form for one.
  it('draw no password field and no field named for a credential', () => {
    const offending = files
      .filter((file) => !/StaffCreatePage|StaffListPage|VendorListPage/.test(file.path))
      .filter((file) => file.path.endsWith('.tsx'))
      .flatMap((file) => {
        const fields = fieldsIn(file.code);
        return fields.text || fields.password ? [file.path] : [];
      });

    // The reset, the profile, the sessions and the landing have no field at all: the reason dialog's note is the only text the person writes.
    expect(offending).toEqual([]);
  });

  it('draw no password field on the three screens that are forms either', () => {
    for (const file of files.filter((candidate) =>
      /StaffCreatePage|StaffListPage|VendorListPage/.test(candidate.path),
    )) {
      expect(fieldsIn(file.code).password, file.path).toBe(false);
    }
  });
});
