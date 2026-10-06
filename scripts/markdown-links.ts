/**
 * Relative links between the repository's Markdown documents: the file a link names exists, and so does the heading
 * an anchor names. `agent-docs.ts` holds the `CLAUDE.md` files to their own links; the specifications, the runbook and
 * the design documents link each other far more, and a link to a section that was renamed fails without a sound.
 *
 * Absolute URLs are not followed, and neither is anything inside a code span or a fenced block. A heading's anchor is
 * made the way GitHub makes it: lower case, markup and punctuation removed, spaces as hyphens, and `-1`, `-2` for a
 * heading that repeats.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface MarkdownFile {
  /** Path from the repository root, with `/`. */
  readonly path: string;
  readonly text: string;
}

export interface BrokenLink {
  readonly file: string;
  readonly target: string;
  readonly problem: string;
}

/** The text with fenced blocks and code spans removed: a link written there is an example, not a link. */
function withoutCode(text: string): string {
  return text.replaceAll(/```[\s\S]*?```/g, '').replaceAll(/`[^`\n]*`/g, '');
}

/** GitHub's anchor for a heading's text. */
export function anchorOf(heading: string): string {
  return heading
    .toLowerCase()
    .replaceAll(/<[^>]+>/g, '')
    .replaceAll(/[`*_~]/g, '')
    .replaceAll(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replaceAll(/\s/g, '-');
}

/** Every anchor the headings of a document make, repeated headings numbered as GitHub numbers them. */
export function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const match of markdown
    .replaceAll(/```[\s\S]*?```/g, '')
    .matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const anchor = anchorOf(match[1] ?? '');
    const count = seen.get(anchor) ?? 0;
    seen.set(anchor, count + 1);
    anchors.add(count === 0 ? anchor : `${anchor}-${String(count)}`);
  }
  return anchors;
}

/**
 * The broken relative links of the given documents. `read` answers for a file that is not among them (a target that
 * is not Markdown is only checked for existing), `exists` for any path.
 */
export function brokenLinks(
  files: readonly MarkdownFile[],
  exists: (path: string) => boolean,
  read: (path: string) => string | undefined,
): BrokenLink[] {
  const documents = new Map(files.map((file) => [file.path, file.text]));
  const broken: BrokenLink[] = [];

  for (const file of files) {
    for (const match of withoutCode(file.text).matchAll(
      /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    )) {
      const target = match[1] ?? '';
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;

      const [pathPart = '', anchor] = target.split('#');
      const resolved =
        pathPart === ''
          ? file.path
          : join(dirname(file.path), decodeURIComponent(pathPart)).replaceAll('\\', '/');
      if (pathPart !== '' && !exists(resolved)) {
        broken.push({ file: file.path, target, problem: `${resolved} does not exist` });
        continue;
      }
      if (anchor === undefined || anchor === '' || !resolved.endsWith('.md')) continue;
      const text = documents.get(resolved) ?? read(resolved);
      if (text !== undefined && !anchorsOf(text).has(decodeURIComponent(anchor))) {
        broken.push({
          file: file.path,
          target,
          problem: `${resolved} has no heading for #${anchor}`,
        });
      }
    }
  }
  return broken;
}

/** The same, for a checkout: `files` are the tracked Markdown files, read from `root`. */
export function brokenLinksInCheckout(root: string, files: readonly string[]): BrokenLink[] {
  return brokenLinks(
    files.map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') })),
    (path) => existsSync(resolve(root, path)),
    (path) => {
      const full = resolve(root, path);
      return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
    },
  );
}
