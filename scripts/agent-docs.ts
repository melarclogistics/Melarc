/**
 * Holds the agent documentation to the repository. `CLAUDE.md` is the entry point for every AI agent and for a
 * developer who has been away: it must say where everything is, stay short enough to be read, and never be wrong.
 * It stays short by linking to the owning documents and by delegating area-specific rules to small `CLAUDE.md`
 * files in the folders they apply to (Claude Code loads those only when it works there). This check fails when:
 *
 *   - the root file is missing, over its line budget, or has lost one of its required sections;
 *   - an area file is over its (smaller) budget, or the root file never links it;
 *   - a link or a path in a code span points at something that does not exist, or at a heading that is not there;
 *   - a pnpm command names a script that does not exist;
 *   - a top-level folder is not mapped from the root file;
 *   - any Markdown document in the repository cannot be reached by following links from a `CLAUDE.md`;
 *   - a `CLAUDE.md` sends the reader to the git-ignored `tmp/` folder, which exists on one machine only.
 *
 * It reads files and nothing else. The long detail lives in the documents it links; this keeps the map true.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import {
  fencedCommandLines,
  inlineCodeSpans,
  pnpmCommandProblem,
  workspaceScripts,
} from './doc-commands.ts';

export const ROOT_LINE_BUDGET = 90;
export const NESTED_LINE_BUDGET = 40;
export const REQUIRED_ROOT_SECTIONS: readonly string[] = [
  'Start here',
  'Working rules',
  'Where things are',
  'Commands',
  'Never',
];

export type AgentDocProblemCode =
  | 'ROOT_MISSING'
  | 'OVER_BUDGET'
  | 'SECTION_MISSING'
  | 'NESTED_NOT_LINKED'
  | 'BROKEN_LINK'
  | 'BROKEN_PATH'
  | 'UNKNOWN_COMMAND'
  | 'DIRECTORY_NOT_MAPPED'
  | 'ORPHAN_DOCUMENT'
  | 'IGNORED_FOLDER';

export interface AgentDocProblem {
  code: AgentDocProblemCode;
  message: string;
}

/** Folders that hold generated, installed or machine-local files, never documents a reader is sent to. */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'tmp',
  'temp',
  'test-results',
  'playwright-report',
  'blob-report',
]);

const isSkipped = (name: string): boolean => name.startsWith('.') || SKIPPED_FOLDERS.has(name);
const posix = (path: string): string => path.split(sep).join('/');
const isWebLink = (target: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(target);
const lineCount = (text: string): number => text.replace(/\n+$/, '').split('\n').length;

/** Every file under `root` outside the skipped and hidden folders, as absolute paths. */
function filesUnder(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (isSkipped(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else found.push(path);
    }
  };
  visit(root);
  return found;
}

/** The anchors GitHub gives the headings of a Markdown file, including the suffix a repeated heading gets. */
function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const text = (match[1] ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_~]/g, '');
    const slug = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${String(count)}`);
  }
  return anchors;
}

interface Link {
  /** The link target as written, anchor included. */
  raw: string;
  /** The file or folder it points to, absolute. */
  target: string;
  anchor: string | undefined;
}

/** The relative links of a Markdown text, resolved from the folder of the file that holds them. */
function linksIn(markdown: string, file: string): Link[] {
  const links: Link[] = [];
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const raw = match[1] ?? '';
    if (isWebLink(raw)) continue;
    const [path, anchor] = raw.split('#');
    links.push({
      raw,
      target: path === '' || path === undefined ? file : resolve(dirname(file), path),
      anchor: anchor === undefined || anchor === '' ? undefined : anchor.toLowerCase(),
    });
  }
  return links;
}

const DOCUMENT_EXTENSION = /\.(?:md|ya?ml|json|tsx?|mjs|sql|cmd)$/;

/**
 * A code span that could name a path in the repository: it has a folder part, and no space, placeholder or glob,
 * and it does not start with a slash (`/api/v1` is a URL path) or an `@` (a package name).
 */
function pathTokens(markdown: string): string[] {
  return inlineCodeSpans(markdown).filter(
    (span) => /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?$/.test(span) && span.includes('/'),
  );
}

function pathExists(root: string, file: string, token: string): boolean {
  return existsSync(resolve(root, token)) || existsSync(resolve(dirname(file), token));
}

/** Whether a path-like token is meant as a path in this repository (and so must exist). */
function meantAsPath(root: string, file: string, token: string): boolean {
  const first = token.split('/')[0] ?? '';
  return (
    DOCUMENT_EXTENSION.test(token) ||
    existsSync(join(root, first)) ||
    existsSync(join(dirname(file), first))
  );
}

/** Every rule the agent documents of the repository at `root` must keep; empty means it keeps them all. */
export function findAgentDocProblems(root: string): AgentDocProblem[] {
  const rootDocument = join(root, 'CLAUDE.md');
  if (!existsSync(rootDocument)) {
    return [{ code: 'ROOT_MISSING', message: 'CLAUDE.md is missing from the repository root.' }];
  }

  const problems: AgentDocProblem[] = [];
  const rel = (path: string): string => posix(relative(root, path));
  const files = filesUnder(root);
  const claudeFiles = files.filter((file) => file.endsWith(`${sep}CLAUDE.md`));
  const markdown = files.filter((file) => file.endsWith('.md'));
  const packages = workspaceScripts(root);
  const anchors = new Map<string, Set<string>>();
  const anchorsFor = (file: string): Set<string> => {
    const known = anchors.get(file);
    if (known !== undefined) return known;
    const computed = anchorsOf(readFileSync(file, 'utf8'));
    anchors.set(file, computed);
    return computed;
  };

  for (const file of claudeFiles) {
    const text = readFileSync(file, 'utf8');
    const name = rel(file);
    const budget = file === rootDocument ? ROOT_LINE_BUDGET : NESTED_LINE_BUDGET;
    if (lineCount(text) > budget) {
      problems.push({
        code: 'OVER_BUDGET',
        message: `${name} has ${String(lineCount(text))} lines; the budget is ${String(budget)}. Move detail into the document it links.`,
      });
    }

    for (const link of linksIn(text, file)) {
      if (!existsSync(link.target)) {
        problems.push({
          code: 'BROKEN_LINK',
          message: `${name} links ${link.raw}, which does not exist.`,
        });
      } else if (
        link.anchor !== undefined &&
        statSync(link.target).isFile() &&
        link.target.endsWith('.md') &&
        !anchorsFor(link.target).has(link.anchor)
      ) {
        problems.push({
          code: 'BROKEN_LINK',
          message: `${name} links ${link.raw}, but that file has no such heading.`,
        });
      }
    }

    for (const token of pathTokens(text)) {
      if (meantAsPath(root, file, token) && !pathExists(root, file, token)) {
        problems.push({
          code: 'BROKEN_PATH',
          message: `${name} names \`${token}\`, which does not exist.`,
        });
      }
    }

    const commands = [...fencedCommandLines(text), ...inlineCodeSpans(text)];
    for (const command of commands) {
      const problem = pnpmCommandProblem(command, packages);
      if (problem !== undefined)
        problems.push({ code: 'UNKNOWN_COMMAND', message: `${name}: ${problem}.` });
    }

    // A path into the folder (tmp/db-up.cmd) sends the reader to a file only one machine has; naming the folder
    // itself, as a warning, is fine.
    if (/\btmp[\\/]\w/i.test(text)) {
      problems.push({
        code: 'IGNORED_FOLDER',
        message: `${name} points into the git-ignored tmp folder, which exists on one machine only.`,
      });
    }
  }

  const rootText = readFileSync(rootDocument, 'utf8');
  const headings = new Set(
    [...rootText.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1] ?? ''),
  );
  for (const section of REQUIRED_ROOT_SECTIONS) {
    if (!headings.has(section)) {
      problems.push({
        code: 'SECTION_MISSING',
        message: `CLAUDE.md has no "## ${section}" section.`,
      });
    }
  }

  const rootTargets = linksIn(rootText, rootDocument).map((link) => link.target);
  for (const file of claudeFiles.filter((candidate) => candidate !== rootDocument)) {
    const linked = rootTargets.some((target) => target === file || target === dirname(file));
    if (!linked) {
      problems.push({
        code: 'NESTED_NOT_LINKED',
        message: `CLAUDE.md does not link ${rel(file)}; the root file must tell a reader that the area file exists.`,
      });
    }
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || isSkipped(entry.name)) continue;
    const folder = join(root, entry.name);
    const mapped = rootTargets.some(
      (target) => target === folder || target.startsWith(`${folder}${sep}`),
    );
    if (!mapped) {
      problems.push({
        code: 'DIRECTORY_NOT_MAPPED',
        message: `The folder ${entry.name}/ is not mapped from CLAUDE.md: link it, or a document in it, in "Where things are".`,
      });
    }
  }

  const reached = new Set<string>();
  const queue = [...claudeFiles];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || reached.has(file) || !existsSync(file) || !file.endsWith('.md'))
      continue;
    reached.add(file);
    for (const link of linksIn(readFileSync(file, 'utf8'), file)) queue.push(link.target);
  }
  for (const file of markdown.filter((candidate) => !reached.has(candidate))) {
    problems.push({
      code: 'ORPHAN_DOCUMENT',
      message: `${rel(file)} cannot be reached by following links from a CLAUDE.md. Link it from the document that owns its subject.`,
    });
  }

  return problems;
}
