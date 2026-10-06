/**
 * Reading commands out of Markdown and checking them against the repository. Shared by the tests that hold the
 * developer documentation (DEVELOPMENT.md) and the agent documentation (CLAUDE.md files) to what exists: a
 * document that tells a reader to run a script that is not there is wrong the moment it is written.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

import { isRecord } from './workflow-shapes.ts';

/** pnpm's own commands, which are not package scripts. */
export const PNPM_COMMANDS: ReadonlySet<string> = new Set([
  'install',
  'exec',
  'audit',
  'run',
  'dlx',
]);

/** The key the root package's scripts are also stored under, whatever the root package is called. */
export const ROOT_PACKAGE = '<root>';

/** Package name to the names of its scripts, for the root package and every workspace package. */
export function workspaceScripts(root: string): Map<string, Set<string>> {
  const manifests = ['package.json', ...workspaceManifests(root)];
  const found = new Map<string, Set<string>>();
  for (const manifest of manifests) {
    const path = join(root, manifest);
    if (!existsSync(path)) continue;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed) || typeof parsed.name !== 'string') continue;
    const scripts = new Set(isRecord(parsed.scripts) ? Object.keys(parsed.scripts) : []);
    found.set(parsed.name, scripts);
    if (manifest === 'package.json') found.set(ROOT_PACKAGE, scripts);
  }
  return found;
}

/** The package.json of every workspace package, from the globs in pnpm-workspace.yaml (`dir/*` or a directory). */
function workspaceManifests(root: string): string[] {
  const file = join(root, 'pnpm-workspace.yaml');
  if (!existsSync(file)) return [];
  const workspace: unknown = parse(readFileSync(file, 'utf8'));
  const globs = isRecord(workspace) && Array.isArray(workspace.packages) ? workspace.packages : [];
  const manifests: string[] = [];
  for (const glob of globs) {
    if (typeof glob !== 'string') continue;
    if (glob.endsWith('/*')) {
      const parent = glob.slice(0, -2);
      for (const name of directoriesIn(join(root, parent)))
        manifests.push(`${parent}/${name}/package.json`);
    } else {
      manifests.push(`${glob}/package.json`);
    }
  }
  return manifests;
}

function directoriesIn(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** The lines of every fenced code block, trailing ` # comment` removed, blank and comment-only lines dropped. */
export function fencedCommandLines(markdown: string): string[] {
  const lines: string[] = [];
  let inside = false;
  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inside = !inside;
      continue;
    }
    if (inside) lines.push(line.replace(/\s+#\s.*$/, '').trim());
  }
  return lines.filter((line) => line !== '' && !line.startsWith('#'));
}

/** The text of every inline code span (`like this`) outside fenced blocks. */
export function inlineCodeSpans(markdown: string): string[] {
  const outside: string[] = [];
  let inside = false;
  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inside = !inside;
      continue;
    }
    if (!inside) outside.push(line);
  }
  return [...outside.join('\n').matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? '');
}

/**
 * Why a command that starts with `pnpm` is not a real one, or undefined when it is (or is not a pnpm command).
 * `pnpm run <script>`, `pnpm <script>` and `pnpm --filter <package> run <script>` must name a script that exists
 * in the root package or the named workspace package; pnpm's own commands are accepted as they are.
 */
export function pnpmCommandProblem(
  command: string,
  packages: ReadonlyMap<string, ReadonlySet<string>>,
): string | undefined {
  if (!command.startsWith('pnpm ')) return undefined;
  const tokens = command.split(/\s+/).slice(1);
  let scripts = packages.get(ROOT_PACKAGE) ?? new Set<string>();
  if (tokens[0] === '--filter') {
    const name = tokens[1] ?? '';
    const target = packages.get(name);
    if (target === undefined) return `${command}: no workspace package named ${name}`;
    scripts = target;
    tokens.splice(0, 2);
  }
  const [first, second] = tokens;
  if (first === 'run') {
    return second !== undefined && scripts.has(second) ? undefined : `${command}: no such script`;
  }
  if (first !== undefined && !PNPM_COMMANDS.has(first) && !scripts.has(first)) {
    return `${command}: no such script`;
  }
  return undefined;
}
