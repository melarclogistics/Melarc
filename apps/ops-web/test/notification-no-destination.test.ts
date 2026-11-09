import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  NOTIFICATION_FIELDS,
  SUBJECT_FIELDS,
} from '../src/platform/notifications/notification-shape';
import { moduleSpecifiers } from './support/wire-type-scan';

/**
 * **The message log never shows, asks for, copies or builds a number in clear, a message's text or a code** (surfaces/ops-portal.md section 7,
 * `/messages`). An entry has none (the contract), so the runtime tests of the page plant some in fields the contract does not name and look for
 * them. This is the structural half: the code of the log reads no field a number in clear, a text or a code could arrive in, imports nothing
 * that draws or holds a credential, and offers no way to copy, dial or text anything. It is by construction, so that a later change which adds
 * a "copy the number" button, a `tel:` link or a read of `entry.text` fails here, before anyone has to notice it in review.
 */
const SRC = resolve(import.meta.dirname, '../src');

/** The code of the message log: its page and its words, and the platform code it reads through. */
const SCREEN_CODE = [
  'app/pages/messages',
  'platform/notifications',
  'platform/problem/notification-copy.ts',
];

/** The modules that draw, hold or read a credential, or put something on the clipboard: nothing of the log imports one. */
const FORBIDDEN_MODULES = [
  /one-time-secret/,
  /qr-code/,
  /qr-matrix/,
  /use-transient-secret/,
  /password-input/,
  /code-input/,
  /secrets\/otpauth/,
  /auth\/use-grant-token/,
  /clipboard/,
];

/** What a number in clear, a message's words and a code are called in code and on a wire, and what copies or sends one. */
const FORBIDDEN_NAMES = [
  'destination',
  'destination_digest',
  'destinationDigest',
  'recipient_phone',
  'recipientPhone',
  'phone',
  'primary_phone',
  'msisdn',
  'message_text',
  'messageText',
  'rendered_text',
  'renderedText',
  'handshake_code',
  'handshakeCode',
  'provider_message_ref',
  'providerMessageRef',
  'otp',
  'clipboard',
  'writeText',
  'readText',
  'execCommand',
  'share',
];

/** The fields of an entry the screen reads: the view of the guard, every one of them a field of the contract. */
const ENTRY_VIEW_FIELDS = [
  'id',
  'message_kind',
  'template_version',
  'audience',
  'channel',
  'state',
  'suppression_reason',
  'outcome_class',
  'provider_outcome_class',
  'destination_hint',
  'attempt_count',
  'subject',
  'created_at',
] as const;

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

const fileNamed = (name: string) => {
  const file = files.find((candidate) => candidate.path.endsWith(name));
  if (file === undefined) throw new Error(`No file ${name} is scanned.`);
  return file;
};

/** The code of a file without its comments: a sentence that says "no number is shown" is not a number being shown. */
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

/** The name of every property read from one of these objects (`row.destination_hint`), in a file, comments and strings aside. */
function propertiesRead(text: string, fileName: string, objects: readonly string[]): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      objects.includes(node.expression.text)
    ) {
      names.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

describe('what is scanned', () => {
  // Break caught: a scan over nothing, which would pass whatever the code contains.
  it('is the page, its words and the platform code of the message log', () => {
    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'app/pages/messages/MessageLogPage.tsx',
        'app/pages/messages/message-presentation.ts',
        'platform/notifications/notification-shape.ts',
        'platform/notifications/use-notification-queries.ts',
        'platform/problem/notification-copy.ts',
      ]),
    );
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it('reads a file without its comments', () => {
    const tokens = codeTokens('// destination\nconst a = 1; /* clipboard */', 'x.ts');

    expect(tokens.join(' ')).not.toMatch(/destination|clipboard/);
  });

  it('finds a property read, and not a mention', () => {
    expect(
      propertiesRead("row.destination; other.text; const a = 'row.phone'; // row.code", 'x.ts', [
        'row',
      ]),
    ).toEqual(['destination']);
  });
});

describe('the message log and a number, a text and a code', () => {
  // Break caught: an import of anything that draws, holds or copies a credential into a screen that must not be able to show one.
  it('imports nothing that draws, holds or reads a credential, or touches the clipboard', () => {
    const offending = files.flatMap((file) =>
      moduleSpecifiers(file.text, file.path)
        .filter((specifier) => FORBIDDEN_MODULES.some((pattern) => pattern.test(specifier)))
        .map((specifier) => `${file.path}: ${specifier}`),
    );

    expect(offending).toEqual([]);
  });

  // Break caught: a field of an answer that carries a number or a text being read, or a control that copies or sends one being drawn.
  it('names nothing a number in clear, a text or a code is called, in code', () => {
    const offending = files.flatMap((file) => {
      const tokens = codeTokens(file.text, file.path);
      return FORBIDDEN_NAMES.filter((name) =>
        tokens.some((token) => token === name || token === `'${name}'` || token === `"${name}"`),
      ).map((name) => `${file.path}: ${name}`);
    });

    expect(offending).toEqual([]);
  });

  // Break caught: a link that dials, texts or writes to a number, which is a number built into an address.
  it('builds no address that dials, texts or writes to anyone', () => {
    const offending = files.flatMap((file) =>
      codeTokens(file.text, file.path)
        .filter((token) => /(?:^|[\s'"`])(tel|sms|mailto|whatsapp|callto):/i.test(token))
        .map((token) => `${file.path}: ${token}`),
    );

    expect(offending).toEqual([]);
  });

  // Break caught: a read of a field the contract does not name, which is how a number in clear or a message's text would get onto a screen.
  it('reads from the answer only the fields the guard lists, and the guard lists only those of the contract', () => {
    const shape = fileNamed('notification-shape.ts');
    const known = new Set<string>([
      ...NOTIFICATION_FIELDS.NotificationLogEntry.required,
      ...NOTIFICATION_FIELDS.NotificationLogEntry.optional,
      ...SUBJECT_FIELDS.required,
      'items',
      'next_page_token',
      'length',
    ]);
    const read = propertiesRead(shape.text, shape.path, ['body', 'entry']);

    expect(read.length).toBeGreaterThan(15);
    expect(read.filter((name) => !known.has(name))).toEqual([]);
    // The one number there is, and nothing named like another.
    expect(read).toContain('destination_hint');
  });

  it('reads from an entry on the screen only the fields of its view', () => {
    const known = new Set<string>([...ENTRY_VIEW_FIELDS, 'type']);
    for (const name of [
      'MessageLogPage.tsx',
      'message-presentation.ts',
      'use-notification-queries.ts',
    ]) {
      const file = fileNamed(name);
      const read = propertiesRead(file.text, file.path, ['row', 'entry', 'message', 'subject']);

      expect(
        read.filter((property) => !known.has(property)),
        file.path,
      ).toEqual([]);
    }
    // The masked hint is read where the page draws it: from the entry a cell or a card is given (the scan is not vacuous).
    expect(
      propertiesRead(fileNamed('MessageLogPage.tsx').text, 'MessageLogPage.tsx', ['row', 'entry']),
    ).toContain('destination_hint');
  });

  it('reads from a call’s answer only its data and its status', () => {
    const hook = fileNamed('use-notification-queries.ts');

    expect([...new Set(propertiesRead(hook.text, hook.path, ['answer']))].toSorted()).toEqual([
      'data',
      'status',
    ]);
  });
});
