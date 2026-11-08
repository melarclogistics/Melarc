import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';

import { SHOWS_SECRET, isSecretSpec } from './evidence-policy.ts';

/**
 * The check of the sources that goes with the evidence policy (`evidence-policy.ts`; the audit of 11 October 2026, F06). It does not
 * prove that evidence is off: the project configuration and the fixture of `secret-test.ts` do, on what is resolved. This refuses
 * what they cannot see, reading the **syntax** of a file and not its text, so that a string, a comment or a name that merely looks
 * like the call is not taken for it:
 *
 * - a file that declares a secret (`@shows-secret`) and is not named `<name>.secret.test.ts` would run in the project that records;
 * - a secret spec must import `test` from the secret base (and not from Playwright), must not call `.use(...)` (a file may not
 *   change its own options), must not load a module dynamically (a way round the import), and may not name anything that attaches,
 *   records or compares a picture of the page: `attach`, `screenshot`, `tracing`, `video`, `pdf`, `ariaSnapshot`, and the like.
 */
export interface SpecFile {
  readonly path: string;
  readonly text: string;
}

/** Names a secret spec may not use at all: each keeps or compares a picture or a recording of the page, by hand. */
const RECORDING_NAMES: ReadonlySet<string> = new Set([
  'attach',
  'screenshot',
  'tracing',
  'video',
  'pdf',
  'ariaSnapshot',
  'toHaveScreenshot',
  'toMatchSnapshot',
  'toMatchAriaSnapshot',
  'recordVideo',
  'recordHar',
  'harPath',
]);

const PLAYWRIGHT_MODULE = /^(?:@playwright\/test|playwright|playwright-core)(?:\/|$)/;
const SECRET_BASE_MODULE = /(?:^|\/)secret-test(?:\.ts)?$/;

function problemsOfSecretSpec(file: SpecFile): string[] {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
  const problems = new Set<string>();
  const imports = { secretTest: false };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const from = node.moduleSpecifier.text;
      const bindings = node.importClause?.namedBindings;
      const named =
        bindings !== undefined && ts.isNamedImports(bindings)
          ? bindings.elements.map((element) => (element.propertyName ?? element.name).text)
          : [];
      if (SECRET_BASE_MODULE.test(from) && named.includes('test')) imports.secretTest = true;
      if (PLAYWRIGHT_MODULE.test(from)) {
        const wholeModule =
          node.importClause?.name !== undefined ||
          (bindings !== undefined && ts.isNamespaceImport(bindings));
        if (named.includes('test') || wholeModule) {
          problems.add(
            'imports test from Playwright, not from the secret base (harness/secret-test.ts)',
          );
        }
      }
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        problems.add('loads a module dynamically');
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        problems.add('loads a module with require');
      }
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'use') {
        problems.add('calls .use(...): a secret spec does not change its own options');
      }
    }
    if (ts.isIdentifier(node) && RECORDING_NAMES.has(node.text)) {
      problems.add(`names ${node.text}, which keeps or compares a recording of the page`);
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      (RECORDING_NAMES.has(node.argumentExpression.text) || node.argumentExpression.text === 'use')
    ) {
      problems.add(`reaches ${node.argumentExpression.text} by a string`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (!imports.secretTest) {
    problems.add('does not import test from the secret base (harness/secret-test.ts)');
  }
  return [...problems].toSorted();
}

export function findSecretEvidenceViolations(files: readonly SpecFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const path = file.path.replaceAll('\\', '/');
    if (isSecretSpec(path)) {
      for (const problem of problemsOfSecretSpec({ path, text: file.text })) {
        violations.push(`${path} shows a secret and ${problem}`);
      }
    } else if (file.text.includes(SHOWS_SECRET)) {
      violations.push(
        `${path} declares a secret (${SHOWS_SECRET}) and is not named <name>.secret.test.ts: it would run in the project that records evidence`,
      );
    }
  }
  return violations;
}

/** Every TypeScript file under `directory`, at any depth, with its path relative to `base` and forward slashes. */
export function typeScriptFilesUnder(directory: string, base: string = directory): SpecFile[] {
  const found: SpecFile[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...typeScriptFilesUnder(path, base));
    else if (entry.name.endsWith('.ts')) {
      found.push({
        path: path.slice(base.length + 1).replaceAll('\\', '/'),
        text: readFileSync(path, 'utf8'),
      });
    }
  }
  return found;
}
