import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { moduleSpecifiers } from './support/wire-type-scan';

/**
 * **No page that acts on another principal's credential may have a field capable of displaying one** (surfaces/ops-portal.md section 7).
 * Recovery, re-issue and the reset of an authenticator re-establish a path for a person to set their own credential; a screen that could show
 * one turns an administrator into a person who knows a colleague's password or can enrol a factor on a colleague's account.
 *
 * The runtime tests of each screen plant a token in the answer and look for it. This is the structural half: the code of the identity screens
 * and of what they read reaches for nothing that draws, holds or reads a credential. It is by construction, so that a later change which
 * adds a "copy the link" button or a QR code to one of these screens fails here, before anyone has to notice it in review.
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

const files = SCREEN_CODE.flatMap(sourceFiles).map((path) => ({
  path: relative(SRC, path).split(sep).join('/'),
  text: readFileSync(path, 'utf8'),
}));

/**
 * A text field, and a field that is a password, as the code's tokens spell them. The tokens are joined with a space (`< Input type = "password"`), so each pattern allows the
 * space: a pattern written without it (`<Input`, `type="password"`) could never match and the checks below could never fail (found by the security review of run 5, Stage 5.1,
 * when the field of a mutation was not seen; the checks had read `<Input\b` and `type=["']password["']` since they were written).
 */
const TEXT_FIELD = /<\s*Input\b/;
const PASSWORD_FIELD = /type\s*=\s*["']password["']|name\s*=\s*["']password["']/;

/** The code of a file without its comments: a sentence that says "no token is shown" is not a token being shown. */
function codeTokens(text: string, fileName: string): string[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('x') ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    text,
  );
  const tokens: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    tokens.push(scanner.getTokenText());
  }
  return tokens;
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
    const tokens = codeTokens('// setup_token\nconst a = 1; /* otpauth_uri */', 'x.ts');

    expect(tokens.join(' ')).not.toMatch(/setup_token|otpauth_uri/);
  });

  // Break caught: a check for a field that cannot see one, because its pattern is spelled differently from the code it reads.
  it('sees a text field and a password field in code, and not in a comment or a string of words', () => {
    const field = codeTokens(
      'const a = <Input type="password" name="secret" aria-label="x" readOnly />;',
      'x.tsx',
    ).join(' ');
    const named = codeTokens("const a = <input name='password' />;", 'x.tsx').join(' ');
    const words = codeTokens(
      '// <Input type="password" />\nconst a = "no type=password here";',
      'x.tsx',
    ).join(' ');

    expect(field).toMatch(TEXT_FIELD);
    expect(field).toMatch(PASSWORD_FIELD);
    expect(named).toMatch(PASSWORD_FIELD);
    expect(words).not.toMatch(TEXT_FIELD);
    expect(words).not.toMatch(PASSWORD_FIELD);
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
    const offending = files.flatMap((file) => {
      const tokens = codeTokens(file.text, file.path);
      return CREDENTIAL_NAMES.filter((name) =>
        tokens.some((token) => token === name || token === `'${name}'` || token === `"${name}"`),
      ).map((name) => `${file.path}: ${name}`);
    });

    expect(offending).toEqual([]);
  });

  // Break caught: a text field or a password field on a screen that is not a form for one.
  it('draw no password field and no field named for a credential', () => {
    const offending = files
      .filter((file) => !/StaffCreatePage|StaffListPage|VendorListPage/.test(file.path))
      .filter((file) => file.path.endsWith('.tsx'))
      .flatMap((file) => {
        const tokens = codeTokens(file.text, file.path).join(' ');
        return TEXT_FIELD.test(tokens) || PASSWORD_FIELD.test(tokens) ? [file.path] : [];
      });

    // The reset, the profile, the sessions and the landing have no field at all: the reason dialog's note is the only text the person writes.
    expect(offending).toEqual([]);
  });

  it('draw no password field on the three screens that are forms either', () => {
    for (const file of files.filter((candidate) =>
      /StaffCreatePage|StaffListPage|VendorListPage/.test(candidate.path),
    )) {
      expect(codeTokens(file.text, file.path).join(' '), file.path).not.toMatch(PASSWORD_FIELD);
    }
  });
});
