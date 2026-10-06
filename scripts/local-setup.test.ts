import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parseEnv } from 'node:util';

import { parse } from 'yaml';

import { fencedCommandLines, pnpmCommandProblem, workspaceScripts } from './doc-commands.ts';
import { isRecord } from './workflow-shapes.ts';

/**
 * Developer setup is documented in DEVELOPMENT.md. A document that names a command that does not exist, or sends a
 * developer to a file that only one machine has, is the undocumented machine state this task exists to remove, so
 * the document is held to the repository: every command it shows is real, every path it names is there, and none of
 * it needs a git-ignored helper.
 */
const root = resolve(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const document = read('DEVELOPMENT.md');

const commands = fencedCommandLines(document);
const packages = workspaceScripts(root);

/** The level-2 headings of a Markdown document in order, outside code blocks, as written after the `## `. */
function headingsOf(markdown: string): string[] {
  const found: string[] = [];
  let inside = false;
  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) inside = !inside;
    else if (!inside && line.startsWith('## ')) found.push(line.slice(3).trimEnd());
  }
  return found;
}

/** The text of the section under a level-2 heading, up to the next one; undefined when the heading is not there. */
function sectionOf(markdown: string, heading: string): string | undefined {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  if (start === -1) return undefined;
  const from = start + 1;
  const next = markdown.indexOf('\n## ', from + 1);
  return markdown.slice(from, next === -1 ? undefined : next);
}

/** The sections the page has, in its order; other documents and tests link to them by these names. */
const SECTIONS = [
  'Prerequisites',
  '1. Install dependencies',
  '2. Create the local settings',
  '3. Start the database',
  '4. Build and migrate',
  '5. Run the applications',
  '6. Run the checks and the smoke tests',
  '7. Stop safely',
  '8. Reset to a known state',
  '9. Package the source for review',
  'Windows, WSL2 and Linux',
  'When something goes wrong',
  'Not provided yet',
];

/**
 * What each topic of the setup must show, as lines of a code block (a command in running text would not be
 * copied): the section it sits in and the commands that make it what its heading says.
 */
const TOPICS: [topic: string, heading: string, commands: string[]][] = [
  [
    'dependency installation',
    '1. Install dependencies',
    [
      'pnpm install --frozen-lockfile',
      'pnpm --filter @melarc/e2e exec playwright install chromium',
    ],
  ],
  ['local settings', '2. Create the local settings', ['pnpm run setup:env']],
  [
    'infrastructure startup',
    '3. Start the database',
    ['pnpm run infra:up', 'pnpm run infra:status', 'pnpm run infra:check'],
  ],
  [
    'migration',
    '4. Build and migrate',
    [
      'pnpm run build',
      'pnpm --filter @melarc/api run db:bootstrap',
      'pnpm --filter @melarc/api run db:migrate',
    ],
  ],
  [
    'development startup',
    '5. Run the applications',
    [
      'pnpm --filter @melarc/api run start:local',
      'pnpm --filter @melarc/ops-web run dev',
      'curl http://127.0.0.1:3000/livez',
      'curl http://127.0.0.1:3000/readyz',
    ],
  ],
  [
    'tests and smoke checks',
    '6. Run the checks and the smoke tests',
    ['pnpm test', 'pnpm run test:db', 'pnpm run test:browser', 'pnpm run test:e2e'],
  ],
  ['safe shutdown', '7. Stop safely', ['pnpm run infra:stop']],
  [
    'disposable local reset',
    '8. Reset to a known state',
    [
      'pnpm --filter @melarc/api run db:reset',
      'pnpm --filter @melarc/api run db:orphans',
      'docker compose -f infrastructure/postgres/compose.yaml --env-file infrastructure/postgres/.env down --volumes',
      'pnpm run infra:up',
      'pnpm --filter @melarc/api run db:bootstrap',
      'pnpm --filter @melarc/api run db:migrate',
    ],
  ],
  ['source packaging for review', '9. Package the source for review', ['pnpm run package:source']],
  ['the WSL2 database check', 'Windows, WSL2 and Linux', ['pnpm run infra:check']],
];

/** The checks the table of the checks section lists, by name. */
const TABLE_COMMANDS = [
  'pnpm run format:check',
  'pnpm run lint',
  'pnpm run typecheck',
  'pnpm test',
  'pnpm run contract:check',
  'pnpm run api-client:check',
  'pnpm run test:db',
  'pnpm run test:browser',
  'pnpm run test:e2e',
];

const PLATFORM_LABELS = ['**Windows.**', '**Linux and CI.**', '**WSL2.**'];
const PREREQUISITES = ['Git', 'Node.js', 'pnpm', 'Docker'];

/** Why a document is not the setup page: its sections, the commands of each topic, the table, the platforms. */
function structureProblems(markdown: string): string[] {
  const problems: string[] = [];
  const headings = headingsOf(markdown);
  if (headings.join('\n') !== SECTIONS.join('\n')) {
    const missing = SECTIONS.filter((heading) => !headings.includes(heading));
    problems.push(
      missing.length > 0
        ? `sections missing or renamed: ${missing.join('; ')}`
        : 'the sections are not in the order of the setup',
    );
  }
  for (const [topic, heading, expected] of TOPICS) {
    const section = sectionOf(markdown, heading);
    if (section === undefined) continue;
    const shown = fencedCommandLines(section);
    for (const command of expected.filter((candidate) => !shown.includes(candidate))) {
      problems.push(`${topic}: "${command}" is not a line of a code block under "${heading}"`);
    }
  }
  const checks = sectionOf(markdown, '6. Run the checks and the smoke tests') ?? '';
  for (const command of TABLE_COMMANDS.filter(
    (candidate) => !checks.includes(`\`${candidate}\``),
  )) {
    problems.push(`the checks table does not list ${command}`);
  }
  const platforms = sectionOf(markdown, 'Windows, WSL2 and Linux') ?? '';
  for (const label of PLATFORM_LABELS) {
    if (!platforms.split('\n').some((line) => line.startsWith(`- ${label}`))) {
      problems.push(`the platform section has no bullet ${label}`);
    }
  }
  const prerequisites = sectionOf(markdown, 'Prerequisites') ?? '';
  const rows = prerequisites.split('\n');
  for (const need of PREREQUISITES.filter(
    (candidate) => !rows.some((row) => row.startsWith(`| ${candidate} `)),
  )) {
    problems.push(`the prerequisites table has no row for ${need}`);
  }
  return problems;
}

describe('DEVELOPMENT.md', () => {
  // Break caught: a section renamed, dropped, split or moved, a topic kept as a heading with its commands gone,
  // or a platform named in passing (this page says "Linux" in a table cell) and given no paragraph of its own: the
  // page then no longer walks a developer from a clean checkout to a running system, in order.
  it('has the sections, commands, table and platforms of the setup', () => {
    assert.deepEqual(structureProblems(document), []);
  });

  it('has exactly these sections, in this order', () => {
    assert.deepEqual(headingsOf(document), SECTIONS);
  });

  // Break caught: a `## ` line inside a code block (a shell comment, a config file) read as a section.
  it('reads the sections outside code blocks only, and only those of the second level', () => {
    assert.deepEqual(headingsOf('# T\n## A\n```text\n## B\n```\n## C \n### D\n'), ['A', 'C']);
  });

  // The same check on the page with one thing broken: each break must be reported, by name. (Edits of a copy in
  // memory; the page is not touched.)
  const breaks: [label: string, change: (text: string) => string, reported: RegExp][] = [
    [
      'a section renamed, as its old name still matches a loose pattern',
      (text) => text.replace('## 3. Start the database', '## 3. Start the services'),
      /3\. Start the database/,
    ],
    [
      'a section dropped',
      (text) => text.replace('## 7. Stop safely', '### 7. Stop safely'),
      /7\. Stop safely/,
    ],
    [
      'two sections swapped',
      (text) =>
        text
          .replace('## 4. Build and migrate', '## @@')
          .replace('## 5. Run the applications', '## 4. Build and migrate')
          .replace('## @@', '## 5. Run the applications'),
      /not in the order/,
    ],
    [
      'a command removed from its code block',
      (text) =>
        text.replace('pnpm run infra:up\npnpm run infra:status\n', 'pnpm run infra:status\n'),
      /infrastructure startup: "pnpm run infra:up"/,
    ],
    [
      'a command moved out of its code block into running text',
      (text) => text.replace('```text\npnpm run setup:env\n```', 'Run `pnpm run setup:env`.'),
      /local settings: "pnpm run setup:env"/,
    ],
    [
      'the packaging command removed',
      (text) => text.replace('pnpm run package:source\n', ''),
      /source packaging for review: "pnpm run package:source"/,
    ],
    [
      'a check removed from the table',
      (text) => text.replace('`pnpm run api-client:check`', '`pnpm run api-client:other`'),
      /the checks table does not list pnpm run api-client:check/,
    ],
    [
      'a platform bullet removed',
      (text) => text.replace('- **WSL2.**', '- WSL2.'),
      /no bullet \*\*WSL2\.\*\*/,
    ],
    [
      'a prerequisite removed',
      (text) => text.replace('| Docker ', '| Podman '),
      /no row for Docker/,
    ],
  ];
  for (const [label, change, reported] of breaks) {
    it(`reports ${label}`, () => {
      const changed = change(document);
      assert.notEqual(changed, document, 'the change did not apply to the page');
      const found = structureProblems(changed);
      assert.ok(
        found.some((problem) => reported.test(problem)),
        `not reported: ${found.join(' | ') || '(nothing)'}`,
      );
    });
  }

  // Break caught (audit B-03): WSL2 told that it reaches a database running on Windows at 127.0.0.1 without
  // saying when. In WSL2's default (NAT) networking 127.0.0.1 is the WSL2 virtual machine, so that holds only
  // with mirrored networking; the supported setups, how to check, and what is not verified are written down.
  describe('the WSL2 section', () => {
    const section = (): string => {
      const start = document.indexOf('## Windows, WSL2 and Linux');
      assert.notEqual(start, -1, 'the section is missing');
      const next = document.indexOf('\n## ', start + 1);
      return document.slice(start, next === -1 ? undefined : next);
    };

    it('does not promise that WSL2 reaches a database on Windows at 127.0.0.1', () => {
      assert.doesNotMatch(section(), /WSL2 reaches that same server/i);
      assert.doesNotMatch(section(), /do not start a second one/i);
    });

    it('names both ways to get a database that WSL2 can reach, and the check', () => {
      const text = section();
      assert.match(text, /pnpm run infra:check/);
      assert.match(text, /networkingMode=mirrored/);
      assert.match(text, /\.wslconfig/);
      assert.match(text, /wsl --shutdown/);
      assert.match(text, /inside WSL2/i);
    });

    // Break caught: a workaround that makes the instruction work by exposing the database or by pointing the
    // tools at another machine, which the tools refuse and which the database must never allow.
    it('keeps the database on this machine only', () => {
      assert.match(section(), /never (?:bind|publish|expose)[^.]*(?:all interfaces|network)/i);
      assert.doesNotMatch(section(), /MELARC_PG_HOST=(?!127\.|localhost)/);
    });

    it('says what has not been verified', () => {
      assert.match(section(), /not (?:yet )?verified/i);
    });
  });

  // Break caught (audit B-04): a review archive made by zipping the folder, which carries the populated settings
  // files, the dependencies and the build output that .gitignore does not keep out of an archive.
  it('sends a developer to the packaging command, and says what it refuses and never prints', () => {
    const start = document.indexOf('## 9. Package the source for review');
    assert.notEqual(start, -1);
    const next = document.indexOf('\n## ', start + 1);
    const section = document.slice(start, next === -1 ? undefined : next);
    assert.match(section, /pnpm run package:source/);
    assert.match(section, /never as a ZIP of the folder/i);
    assert.match(section, /\.env\.example/);
    assert.match(section, /never a value/i);
    assert.match(section, /never changes or deletes a file in your working tree/i);
    assert.match(section, /SOURCE_PACKAGE\.json/);
  });

  // Break caught (audit B-03): saying a reset is the only way to change the database passwords, which sends a
  // developer to delete their data to rotate a credential. The two identities the tools provision are set again
  // on every `db:bootstrap` (apps/api provisioning.db.test.ts proves the runtime one rotates); only the cluster
  // superuser's password is fixed at the volume's creation.
  it('does not say a volume reset is the only way to change a password', () => {
    assert.doesNotMatch(document, /only way to change the database passwords/i);
    assert.match(document, /MELARC_PG_RUNTIME_PASSWORD/);
    assert.match(document, /MELARC_PG_ADMIN_PASSWORD/);
  });

  // Break caught (audit B-03): a longer connection timeout offered as the fix for a download that dies after a
  // few seconds, which it cannot fix: Node applies that timeout only once the socket has connected.
  it('keeps the generic download advice apart from the IPv6 failure it does not fix', () => {
    assert.match(document, /PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT/);
    assert.match(document, /IPv6/);
    assert.match(document, /does not help|cannot help|will not help/i);
  });

  // Break caught: a renamed or removed script that the document still tells a developer to run.
  it('shows only pnpm commands that exist', () => {
    const pnpmLines = commands.filter((line) => line.startsWith('pnpm '));
    assert.ok(pnpmLines.length >= 15, 'the document should show its pnpm commands in code blocks');
    for (const line of pnpmLines) assert.equal(pnpmCommandProblem(line, packages), undefined);
  });

  it('shows only node scripts and files that exist', () => {
    for (const line of commands) {
      const script = /\bnode (?:--[\w-]+(?:=\S+)? )*(scripts\/\S+)/.exec(line)?.[1];
      if (script !== undefined)
        assert.ok(existsSync(join(root, script)), `${line}: ${script} is missing`);
    }
  });

  // Break caught: a link that goes nowhere after a file is moved.
  it('links only to files that exist', () => {
    const links = [...document.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map(
      (match) => match[1] ?? '',
    );
    const local = links.filter((link) => !/^[a-z]+:/i.test(link));
    assert.ok(local.length > 0);
    for (const link of local)
      assert.ok(existsSync(resolve(dirname(join(root, 'DEVELOPMENT.md')), link)), link);
  });

  // Break caught: an instruction that works on one machine because of a git-ignored helper in tmp/.
  it('does not depend on anything in the git-ignored tmp folder', () => {
    assert.doesNotMatch(document, /\btmp[\\/]/i);
  });

  it('names the ports and addresses the settings examples use', () => {
    const api = parseEnv(read('apps/api/.env.example'));
    const pg = parseEnv(read('infrastructure/postgres/.env.example'));
    assert.ok(document.includes(`127.0.0.1:${api.HTTP_PORT ?? '?'}`), 'the API address');
    assert.ok(document.includes(`127.0.0.1:${pg.MELARC_PG_PORT ?? '?'}`), 'the database address');
  });
});

describe('the committed files a developer is sent to', () => {
  // The same rule for every file that tells a developer what to run.
  const files = [
    'README.md',
    'infrastructure/postgres/compose.yaml',
    'infrastructure/postgres/.env.example',
    'apps/api/.env.example',
    'apps/ops-web/.env.example',
    'e2e/README.md',
  ];
  for (const file of files) {
    it(`${file} does not send a developer to the git-ignored tmp folder`, () => {
      assert.doesNotMatch(read(file), /\btmp[\\/]\w/i);
    });
  }
});

describe('the infrastructure commands', () => {
  const scripts = (): Record<string, string> => {
    const parsed: unknown = JSON.parse(read('package.json'));
    const found = isRecord(parsed) && isRecord(parsed.scripts) ? parsed.scripts : {};
    return Object.fromEntries(
      Object.entries(found).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>;
  };

  // Break caught: a start command that names a compose file or settings file that moved.
  for (const name of ['infra:up', 'infra:status', 'infra:stop']) {
    it(`${name} runs the committed compose file with the settings file it is generated into`, () => {
      const command = scripts()[name] ?? '';
      assert.match(
        command,
        /^docker compose -f infrastructure\/postgres\/compose\.yaml --env-file infrastructure\/postgres\/\.env /,
      );
      assert.ok(existsSync(join(root, 'infrastructure/postgres/compose.yaml')));
    });
  }

  it('infra:up waits for the database to be healthy', () => {
    assert.match(scripts()['infra:up'] ?? '', / up -d --wait$/);
    const compose: unknown = parse(read('infrastructure/postgres/compose.yaml'));
    const services = isRecord(compose) && isRecord(compose.services) ? compose.services : {};
    const postgres = isRecord(services.postgres) ? services.postgres : {};
    assert.ok(isRecord(postgres.healthcheck), '--wait needs a health check to wait for');
  });

  it('infra:stop stops the container and keeps its data', () => {
    const command = scripts()['infra:stop'] ?? '';
    assert.match(command, / stop$/);
    assert.doesNotMatch(command, /\bdown\b|\s-v\b|--volumes/);
  });

  it("the API's local start reads the settings file the setup command creates", () => {
    const parsed: unknown = JSON.parse(read('apps/api/package.json'));
    const start =
      isRecord(parsed) && isRecord(parsed.scripts) ? parsed.scripts['start:local'] : undefined;
    assert.equal(start, 'node --env-file=.env dist/main.js');
    assert.ok(existsSync(join(root, 'apps/api/.env.example')));
  });

  it('setup:env runs the script that is tested', () => {
    assert.equal(scripts()['setup:env'], 'node scripts/setup-env.ts');
    assert.ok(existsSync(join(root, 'scripts/setup-env.ts')));
  });

  it('package:source runs the script that is tested', () => {
    assert.equal(scripts()['package:source'], 'node scripts/package-source.ts');
    assert.ok(existsSync(join(root, 'scripts/package-source.ts')));
    assert.ok(existsSync(join(root, 'scripts/package-source.test.ts')));
  });

  it('infra:check runs the script that is tested', () => {
    assert.equal(scripts()['infra:check'], 'node scripts/infra-check.ts');
    assert.ok(existsSync(join(root, 'scripts/infra-check.ts')));
    assert.ok(existsSync(join(root, 'scripts/infra-check.test.ts')));
  });

  // Break caught: the check's advice pointing at a section that was renamed.
  it('the section infra:check sends a developer to exists', () => {
    const named = /"([^"]+)" in DEVELOPMENT\.md/.exec(read('scripts/infra-check.ts'))?.[1];
    assert.equal(named, 'Windows, WSL2 and Linux');
    assert.ok(document.includes(`## ${named}`));
  });
});
