import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

import { describe, expect, it } from 'vitest';

import { API_RUNTIME_ROLE, CONFIG_KEYS, loadConfig } from './load-config.js';

const exampleText = readFileSync(resolve(import.meta.dirname, '../../../.env.example'), 'utf8');
const example = parseEnv(exampleText);

/** Tracked, so it is held to the same rule: it is where the local passwords are named. */
const postgresText = readFileSync(
  resolve(import.meta.dirname, '../../../../../infrastructure/postgres/.env.example'),
  'utf8',
);
const postgresExample = parseEnv(postgresText);

/** What a credential in an example file must say. It is a placeholder to replace, never a value to keep. */
const PLACEHOLDER = 'CHANGE_ME';

/**
 * The one form each setting may take: a pattern for a plain value, or a URL whose user is named and whose
 * password is the placeholder or absent. A key with no entry has no allowed form and is refused, so a new
 * setting cannot reach a tracked example without someone saying here what its value looks like.
 */
type Form = RegExp | { readonly url: { readonly user: string } };

const LOOPBACK = /^(127(\.\d{1,3}){3}|localhost|::1)$/;

const API_FORMS: Readonly<Record<string, Form>> = {
  NODE_ENV: /^(development|test|production)$/,
  APP_ENV: /^(local|staging|production)$/,
  HTTP_HOST: LOOPBACK,
  HTTP_PORT: /^\d{1,5}$/,
  LOG_LEVEL: /^(fatal|error|warn|info|debug|trace|silent)$/,
  DATABASE_URL: { url: { user: API_RUNTIME_ROLE } },
  DATABASE_POOL_MAX: /^\d{1,3}$/,
  SHUTDOWN_TIMEOUT_MS: /^\d{1,6}$/,
  SHUTDOWN_DRAIN_DELAY_MS: /^\d{1,5}$/,
};

const POSTGRES_FORMS: Readonly<Record<string, Form>> = {
  MELARC_PG_HOST: LOOPBACK,
  MELARC_PG_PORT: /^\d{1,5}$/,
  MELARC_PG_ADMIN_PASSWORD: new RegExp(`^${PLACEHOLDER}$`),
  MELARC_PG_MIGRATION_PASSWORD: new RegExp(`^${PLACEHOLDER}$`),
  MELARC_PG_RUNTIME_PASSWORD: new RegExp(`^${PLACEHOLDER}$`),
};

/** A percent-escape a URL cannot decode is left as written: it is then not the placeholder either. */
function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * Every line is blank, a whole-line comment or a plain `NAME=value`. The loader drops whatever follows a
 * `#` in an unquoted value and unquotes a quoted one, so a token written after a value, or inside quotes,
 * would sit in the tracked file while the parsed value looks clean.
 */
function lineProblems(text: string): string[] {
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '' || line.startsWith('#')) return;
    if (!/^[A-Z][A-Z0-9_]*=[^\s#'"`]*$/.test(line)) {
      const name = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
      problems.push(
        `${name ?? `line ${String(index + 1)}`} is not written as a plain NAME=value (no comment, space or quote after the =)`,
      );
    }
  });
  return problems;
}

/**
 * Everything wrong with an example, each reason naming the setting and never quoting its value: a failure
 * that printed a real credential would put it in the log of the run that found it.
 */
function problemsWith(text: string, forms: Readonly<Record<string, Form>>): string[] {
  const values = parseEnv(text);
  const problems = lineProblems(text);
  for (const name of Object.keys(forms)) {
    if (!(name in values)) problems.push(`${name} has an allowed form and the example lacks it`);
  }
  for (const [name, raw] of Object.entries(values)) {
    const value = raw ?? '';
    const form = forms[name];
    if (form === undefined) {
      problems.push(`${name} has no allowed form: declare what its value may look like`);
    } else if (form instanceof RegExp) {
      if (!form.test(value)) problems.push(`${name} has a value outside the form allowed for it`);
    } else {
      const url = URL.canParse(value) ? new URL(value) : undefined;
      if (url === undefined) {
        problems.push(`${name} is not a URL`);
        continue;
      }
      if (decode(url.username) !== form.url.user) {
        problems.push(`${name} names a user other than ${form.url.user}`);
      }
      const password = decode(url.password);
      if (password !== '' && password !== PLACEHOLDER) {
        problems.push(`${name} carries a password that is not ${PLACEHOLDER}`);
      }
      if (url.search !== '' || url.hash !== '') {
        problems.push(`${name} carries a query string or fragment, where a credential could hide`);
      }
    }
  }
  return problems;
}

describe('apps/api/.env.example', () => {
  // Break caught: an example that does not actually start the API, so the first thing a new developer
  // copies fails.
  it('is a configuration the API accepts', () => {
    expect(loadConfig(example).ok).toBe(true);
  });

  // Break caught: a configuration key added to the code and never documented.
  it('documents every key the configuration reads, and no other', () => {
    expect(Object.keys(example).toSorted()).toEqual([...CONFIG_KEYS].toSorted());
  });

  // Break caught: a real credential committed in the example, since .env.example is tracked by git.
  it('holds no secret-looking value', () => {
    for (const [name, value] of Object.entries(example)) {
      expect(`${name}=${value ?? ''}`).not.toMatch(/password|secret|token|key|credential/i);
    }
  });

  // Break caught: the same, where a scan for the words cannot see it. A password inside DATABASE_URL, or a
  // token under a setting called something innocent, contains none of "password", "secret", "token", "key"
  // or "credential". So every value has one allowed form, and the password of a URL is the placeholder or
  // nothing.
  it('holds no credential: every value has an allowed form and the URL password is a placeholder', () => {
    expect(problemsWith(exampleText, API_FORMS)).toEqual([]);
  });
});

describe('infrastructure/postgres/.env.example', () => {
  // Break caught: a real local password committed in the tracked example, which `setup:env` is there to
  // generate into the untracked .env instead.
  it('holds only the placeholder where a password goes', () => {
    expect(problemsWith(postgresText, POSTGRES_FORMS)).toEqual([]);
  });
});

describe('the rule that refuses a credential in an example', () => {
  /** The real example's text with one line replaced, as a developer who pasted a real value would leave it. */
  function exampleWith(name: string, value: string): string {
    const lines = exampleText.split(/\r?\n/);
    // A line that is not there would leave the real text untouched and the test proving nothing.
    expect(lines.some((line) => line.startsWith(`${name}=`))).toBe(true);
    return lines
      .map((line) => (line.startsWith(`${name}=`) ? `${name}=${value}` : line))
      .join('\n');
  }

  /** A realistic credential: long, random-looking and containing none of the words a keyword scan looks for. */
  const PASSWORD = 'Zk3vQ9mT7xLp2WnR8sBd4HcY';
  const ENCODED = encodeURIComponent('p@ss/w:rd?9');
  const urlWith = (userinfo: string, rest = '') =>
    `postgres://${userinfo}@127.0.0.1:5432/melarc_dev${rest}`;
  const runtime = (password: string) => `${API_RUNTIME_ROLE}:${password}`;

  // Break caught: the rule passing a realistic password in DATABASE_URL (the case a scan for the words
  // "password" or "secret" cannot see), however it is written into the URL.
  it.each([
    ['a password in the userinfo', urlWith(runtime(PASSWORD))],
    ['a percent-encoded password', urlWith(runtime(ENCODED))],
    ['the placeholder with something after it', urlWith(runtime(`${PLACEHOLDER}2`))],
    ['a lower-case placeholder', urlWith(runtime('change_me'))],
    ['a token as the user, no password', urlWith(PASSWORD)],
    ['a password in the query string', urlWith(runtime(PLACEHOLDER), `?password=${PASSWORD}`)],
    ['a password in the fragment', urlWith(runtime(PLACEHOLDER), `#${PASSWORD}`)],
    ['another user', urlWith(`postgres:${PLACEHOLDER}`)],
  ])('refuses %s', (_label, value) => {
    const problems = problemsWith(exampleWith('DATABASE_URL', value), API_FORMS);

    expect(problems.length).toBeGreaterThan(0);
    // The reasons name the setting and never repeat the value.
    expect(problems.join('\n')).not.toContain(PASSWORD);
    expect(problems.join('\n')).not.toContain(ENCODED);
  });

  it.each([
    ['the placeholder', urlWith(runtime(PLACEHOLDER))],
    ['no password at all', urlWith(API_RUNTIME_ROLE)],
    ['an empty password', urlWith(runtime(''))],
  ])('accepts %s', (_label, value) => {
    expect(problemsWith(exampleWith('DATABASE_URL', value), API_FORMS)).toEqual([]);
  });

  // Break caught: a random-looking token under a setting that has a plain form, or under a setting nobody
  // wrote a form for. Neither is a password or a "key" by name, so a keyword scan passes both.
  it('refuses a token as the value of a known setting and as the value of an unknown one', () => {
    const known = problemsWith(exampleWith('LOG_LEVEL', PASSWORD), API_FORMS);
    const unknown = problemsWith(`${exampleText}\nSESSION_SIGNING=${PASSWORD}\n`, API_FORMS);

    expect(known).toEqual(['LOG_LEVEL has a value outside the form allowed for it']);
    expect(unknown).toEqual([
      'SESSION_SIGNING has no allowed form: declare what its value may look like',
    ]);
    expect(`${known.join()}${unknown.join()}`).not.toContain(PASSWORD);
  });

  // Break caught: a token kept where the loader does not read it, so the parsed value is clean and the
  // tracked text is not: after the value as a comment, inside quotes, or on a line that is not NAME=value.
  it.each([
    ['an inline comment', `info # ${PASSWORD}`, 'LOG_LEVEL is not written as a plain NAME=value'],
    ['quotes', `"${PASSWORD}"`, 'LOG_LEVEL is not written as a plain NAME=value'],
    ['a space', `info ${PASSWORD}`, 'LOG_LEVEL is not written as a plain NAME=value'],
  ])('refuses a value written with %s', (_label, value, expected) => {
    const problems = problemsWith(exampleWith('LOG_LEVEL', value), API_FORMS);

    expect(problems.some((problem) => problem.startsWith(expected))).toBe(true);
    expect(problems.join('\n')).not.toContain(PASSWORD);
  });

  it('refuses a line that is not a comment, a blank or NAME=value, without quoting it', () => {
    const problems = problemsWith(`${exampleText}\n${PASSWORD}\n`, API_FORMS);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^line \d+ is not written as a plain NAME=value/);
    expect(problems.join('\n')).not.toContain(PASSWORD);
  });

  it('refuses a real password where the Postgres example holds the placeholder', () => {
    const replaced = postgresText.replace(
      /^MELARC_PG_ADMIN_PASSWORD=.*$/m,
      `MELARC_PG_ADMIN_PASSWORD=${PASSWORD}`,
    );

    expect(replaced).not.toBe(postgresText);
    expect(problemsWith(replaced, POSTGRES_FORMS)).toEqual([
      'MELARC_PG_ADMIN_PASSWORD has a value outside the form allowed for it',
    ]);
  });

  // Break caught: the forms drifting from the example, so that a setting dropped from the example keeps a
  // form nobody checks, or a new one is left without.
  it('has a form for every setting of each example and for nothing else', () => {
    expect(Object.keys(API_FORMS).toSorted()).toEqual(Object.keys(example).toSorted());
    expect(Object.keys(POSTGRES_FORMS).toSorted()).toEqual(Object.keys(postgresExample).toSorted());
    expect(problemsWith('', API_FORMS)).toHaveLength(Object.keys(API_FORMS).length);
  });
});
