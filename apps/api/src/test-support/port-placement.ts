import ts from 'typescript';

import type { SourceFile } from './platform-boundary.js';

/**
 * Where the ports of `platform/auth` live and how their placement is checked (SOLUTION_ARCHITECTURE.md §5, plan task S0.1).
 * Platform owns the ports; domains own persistence adapters; the composition root binds them. These functions return the
 * violations as sentences, so a test can show each one failing on a deliberately broken input.
 *
 * Which type a name stands for is the compiler's to say, not a pattern's: a port reached through an import under another
 * name, a namespace import, a re-export, a type alias or an interface that extends it is still that port, and a local
 * interface that only shares a port's name is not. The tool is the TypeScript compiler API the repository already depends on,
 * used on the syntax and symbols alone (no type checking, no library, no package resolution), not an architecture framework.
 */
export const PORTS_DIRECTORY = 'platform/auth/ports';

const TRANSACTION_REQUIREMENTS = [
  'inside-callers-transaction',
  'outside-any-transaction',
  'independent',
];
const SCREAMING_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const ADAPTER_SPECIFIER = /\.adapter(?:\.js|\.ts)?$/;
const HANDLE_FILE = `${PORTS_DIRECTORY}/unit-of-work.port.ts`;

/** `SecretCipher` -> `secret-cipher.port.ts`. */
export const portFileName = (name: string): string =>
  `${name.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}.port.ts`;

/** `SecretCipher` -> `SECRET_CIPHER`: the token's name, and the prefix of its descriptor's. */
export const portConstant = (name: string): string =>
  name.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

/** Text with comments removed and strings kept, so a sentence in a comment is never read as code. */
export function stripComments(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);
    if (char === '/' && next === '/') {
      while (index < text.length && text.charAt(index) !== '\n') index++;
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
      out += ' ';
    } else if (char === "'" || char === '"' || char === '`') {
      out += char;
      index++;
      while (index < text.length && text.charAt(index) !== char) {
        if (text.charAt(index) === '\\') {
          out += text.charAt(index);
          index++;
        }
        out += text.charAt(index);
        index++;
      }
      out += char;
      index++;
    } else {
      out += char;
      index++;
    }
  }
  return out;
}

const isTest = (path: string): boolean => path.endsWith('.test.ts');
const isExempt = (path: string): boolean => isTest(path) || path.startsWith('test-support/');

/**
 * Every listed port has one file under `platform/auth/ports/` that exports its interface, its injection token (a `Symbol`
 * named for the port) and its descriptor typed `PortDescriptor<Port>`; and no port file exists that is not listed.
 */
export function findPortSourceProblems(
  files: readonly SourceFile[],
  names: readonly string[],
): string[] {
  const problems: string[] = [];
  const expected = new Set<string>();
  for (const name of names) {
    const path = `${PORTS_DIRECTORY}/${portFileName(name)}`;
    expected.add(path);
    const file = files.find((candidate) => candidate.path === path);
    if (file === undefined) {
      problems.push(`${path} is missing: the port ${name} has no file`);
      continue;
    }
    const text = stripComments(file.text);
    const constant = portConstant(name);
    if (!new RegExp(String.raw`\bexport\s+interface\s+${name}\b`).test(text)) {
      problems.push(`${path} does not export the interface ${name}`);
    }
    if (
      !new RegExp(
        String.raw`\bexport\s+const\s+${constant}\s*=\s*Symbol\(\s*'${constant}'\s*\)`,
      ).test(text)
    ) {
      problems.push(
        `${path} does not export the token ${constant}, which must be Symbol('${constant}')`,
      );
    }
    if (
      !new RegExp(
        String.raw`\bexport\s+const\s+${constant}_DESCRIPTOR\s*:\s*PortDescriptor<\s*${name}\s*>\s*=`,
      ).test(text)
    ) {
      problems.push(
        `${path} does not export the descriptor ${constant}_DESCRIPTOR: PortDescriptor<${name}>`,
      );
    }
  }
  for (const file of files) {
    if (
      file.path.startsWith(`${PORTS_DIRECTORY}/`) &&
      file.path.endsWith('.port.ts') &&
      !isTest(file.path) &&
      !expected.has(file.path)
    ) {
      problems.push(`${file.path} is a port file that is not in the list of ports`);
    }
  }
  return problems;
}

/** A registry entry as the checks see it: nothing is assumed about its shape, so a broken one can be described. */
export interface DescribedPort {
  readonly name: string;
  readonly token: unknown;
  readonly descriptor: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isBlank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

function ownerIsValid(owner: unknown): boolean {
  if (!isRecord(owner)) return false;
  if (owner.kind === 'platform') return !isBlank(owner.area);
  if (owner.kind === 'domain') {
    return (
      Array.isArray(owner.domains) &&
      owner.domains.length > 0 &&
      owner.domains.every((domain) => !isBlank(domain))
    );
  }
  return false;
}

/** `'none'`, or a non-empty list of SCREAMING_SNAKE names. */
const namedConditions = (value: unknown): string[] | 'invalid' | 'none' => {
  if (value === 'none') return 'none';
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((name) => typeof name === 'string' && SCREAMING_SNAKE.test(name))
  ) {
    return value as string[];
  }
  return 'invalid';
};

/**
 * Every listed port is registered once with its own symbol token and a descriptor that names it, its owner, and, for each
 * operation, its inputs, outputs, the outcomes it returns, the conditions it raises and its transaction requirement. Whether
 * the operations are the port's methods is the compiler's to check (`PortDescriptor<P>`) and `findTransactionCategoryProblems`
 * checks again from the source; this checks that nothing is blank.
 */
export function findPortDescriptorProblems(
  entries: readonly DescribedPort[],
  names: readonly string[],
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const name of names) {
    if (!entries.some((entry) => entry.name === name))
      problems.push(`${name}: is not in the registry`);
  }

  for (const entry of entries) {
    const { name } = entry;
    if (!names.includes(name))
      problems.push(`${name}: is registered but is not in the list of ports`);
    if (seen.has(name)) {
      if (!problems.includes(`${name}: is registered twice`))
        problems.push(`${name}: is registered twice`);
      continue;
    }
    seen.add(name);

    const constant = portConstant(name);
    // A symbol described as the port's own name is the port's own: two ports cannot share a token and both pass this.
    if (typeof entry.token !== 'symbol' || entry.token.description !== constant) {
      problems.push(`${name}: the token must be a Symbol described as '${constant}'`);
    }

    const descriptor = entry.descriptor;
    if (!isRecord(descriptor)) {
      problems.push(`${name}: has no descriptor`);
      continue;
    }
    if (descriptor.port !== name) {
      problems.push(`${name}: the descriptor names the port '${String(descriptor.port)}'`);
    }
    if (!ownerIsValid(descriptor.owner)) {
      problems.push(`${name}: the owner is not a platform area or a list of domains`);
    }

    const operations = descriptor.operations;
    if (!isRecord(operations) || Object.keys(operations).length === 0) {
      problems.push(`${name}: the descriptor has no operations`);
      continue;
    }
    for (const [operation, value] of Object.entries(operations)) {
      const where = `${name}.${operation}`;
      if (!isRecord(value)) {
        problems.push(`${where}: has no description`);
        continue;
      }
      if (isBlank(value.inputs)) problems.push(`${where}: inputs is empty`);
      if (isBlank(value.outputs)) problems.push(`${where}: outputs is empty`);
      const outcomes = namedConditions(value.outcomes);
      const raises = namedConditions(value.raises);
      if (outcomes === 'invalid') {
        problems.push(`${where}: outcomes must be 'none' or a list of SCREAMING_SNAKE names`);
      }
      if (raises === 'invalid') {
        problems.push(`${where}: raises must be 'none' or a list of SCREAMING_SNAKE names`);
      }
      if (Array.isArray(outcomes) && Array.isArray(raises)) {
        for (const both of outcomes.filter((condition) => raises.includes(condition))) {
          problems.push(`${where}: ${both} is listed both as an outcome and as a raise`);
        }
      }
      if (
        typeof value.transaction !== 'string' ||
        !TRANSACTION_REQUIREMENTS.includes(value.transaction)
      ) {
        problems.push(
          `${where}: transaction must be ${TRANSACTION_REQUIREMENTS.join(', ').replace(/, ([^,]*)$/, ' or $1')}`,
        );
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The source model: the compiler's view of a set of files, held in memory.

const ROOT = '/virtual/src/';
const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  // Syntax and symbols only: no library, no package types, and no file added because something imports it. Every file of the
  // model is a root, so a relative import resolves; a package import stays unresolved and costs nothing.
  noLib: true,
  noResolve: true,
  types: [],
  noEmit: true,
  experimentalDecorators: true,
};

/** A set of files as the compiler sees them: path relative to `src/` in, symbols and syntax out. */
export interface SourceModel {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly host: ts.CompilerHost;
  /** The paths of the files, relative to `src/` with forward slashes, in the order given. */
  readonly paths: readonly string[];
}

export function sourceModelOf(files: readonly SourceFile[]): SourceModel {
  const contents = new Map(files.map((file) => [`${ROOT}${file.path}`, file.text]));
  const directories = new Set<string>([ROOT.slice(0, -1)]);
  for (const name of contents.keys()) {
    for (let at = name.lastIndexOf('/'); at > ROOT.length; at = name.lastIndexOf('/', at - 1)) {
      directories.add(name.slice(0, at));
    }
  }
  const host: ts.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const text = contents.get(fileName);
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true);
    },
    getDefaultLibFileName: () => `${ROOT}lib.d.ts`,
    writeFile: () => undefined,
    getCurrentDirectory: () => ROOT.slice(0, -1),
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (fileName) => contents.has(fileName),
    readFile: (fileName) => contents.get(fileName),
    directoryExists: (directory) => directories.has(directory.replace(/\/$/, '')),
    getDirectories: () => [],
  };
  const program = ts.createProgram({ rootNames: [...contents.keys()], options: OPTIONS, host });
  return {
    program,
    checker: program.getTypeChecker(),
    host,
    paths: files.map((file) => file.path),
  };
}

const relativePath = (fileName: string): string =>
  fileName.startsWith(ROOT) ? fileName.slice(ROOT.length) : fileName;

function sourcesOf(model: SourceModel): { path: string; node: ts.SourceFile }[] {
  return model.paths.flatMap((path) => {
    const node = model.program.getSourceFile(`${ROOT}${path}`);
    return node === undefined ? [] : [{ path, node }];
  });
}

/** The ports a type is, or stands on: the port itself, an alias of it, an interface that extends it, an intersection with it. */
function portsOfType(
  model: SourceModel,
  type: ts.Type,
  names: readonly string[],
  found: Set<string>,
  seen = new Set<ts.Type>(),
): void {
  if (seen.has(type)) return;
  seen.add(type);
  if (type.isUnionOrIntersection()) {
    for (const member of type.types) portsOfType(model, member, names, found, seen);
    return;
  }
  const symbol = type.getSymbol();
  if (
    symbol !== undefined &&
    names.includes(symbol.name) &&
    (symbol.declarations ?? []).some(
      (declaration) =>
        relativePath(declaration.getSourceFile().fileName) ===
        `${PORTS_DIRECTORY}/${portFileName(symbol.name)}`,
    )
  ) {
    found.add(symbol.name);
  }
  const target =
    type.flags & ts.TypeFlags.Object &&
    (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference
      ? (type as ts.TypeReference).target
      : type;
  if (target.isClassOrInterface()) {
    for (const base of model.checker.getBaseTypes(target))
      portsOfType(model, base, names, found, seen);
  }
}

const withoutParentheses = (expression: ts.Expression): ts.Expression => {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
};
const isLiteralLike = (expression: ts.Expression): boolean => {
  const inner = withoutParentheses(expression);
  return ts.isObjectLiteralExpression(inner) || ts.isClassExpression(inner);
};

/** Whether a function body returns an object literal or class expression, not counting a function nested inside it. */
function returnsLiteral(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found || ts.isFunctionLike(child) || ts.isClassLike(child)) return;
    if (
      ts.isReturnStatement(child) &&
      child.expression !== undefined &&
      isLiteralLike(child.expression)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

/**
 * The ports each production file implements, by any of the ways a file can be an adapter: a class (declaration or expression)
 * with an `implements` clause, an object literal or class expression given a port type by an annotation, `satisfies` or `as`,
 * or returned from a function whose return type is the port.
 */
function portImplementations(
  model: SourceModel,
  names: readonly string[],
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const { path, node } of sourcesOf(model)) {
    if (isExempt(path)) continue;
    const found = new Set<string>();
    const typed = (type: ts.TypeNode): void => {
      portsOfType(model, model.checker.getTypeFromTypeNode(type), names, found);
    };
    const visit = (child: ts.Node): void => {
      if (ts.isClassLike(child)) {
        for (const clause of child.heritageClauses ?? []) {
          if (clause.token === ts.SyntaxKind.ImplementsKeyword) clause.types.forEach(typed);
        }
      } else if (ts.isVariableDeclaration(child) && child.type && child.initializer) {
        if (isLiteralLike(child.initializer)) typed(child.type);
      } else if (
        ts.isSatisfiesExpression(child) ||
        ts.isAsExpression(child) ||
        ts.isTypeAssertionExpression(child)
      ) {
        if (isLiteralLike(child.expression)) typed(child.type);
      } else if (ts.isFunctionLike(child) && child.type && 'body' in child && child.body) {
        const body = child.body;
        if (ts.isBlock(body) ? returnsLiteral(body) : isLiteralLike(body)) typed(child.type);
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    if (found.size > 0) result.set(path, found);
  }
  return result;
}

/** Every module a file names: static imports and re-exports, `import()`, `require()`, `import x = require()` and `import('x').T`. */
function moduleSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const [argument] = node.arguments;
      const callsImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require');
      if (callsImport && argument !== undefined && ts.isStringLiteralLike(argument)) {
        specifiers.push(argument.text);
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/**
 * An adapter is a file that implements a port, whatever it is called, or is named `*.adapter.ts`. Only the files of the
 * composition root, which `compositionRoot` lists, may import one, because that is where an adapter is bound to its token; a
 * service, a controller, a barrel or a module that is not on the list asks for the token. Tests and test support build the whole
 * application and are exempt.
 */
export function findAdapterImportViolations(
  model: SourceModel,
  names: readonly string[],
  compositionRoot: readonly string[],
): string[] {
  const adapters = new Set<string>([
    ...model.paths.filter((path) => path.endsWith('.adapter.ts') && !isExempt(path)),
    ...portImplementations(model, names).keys(),
  ]);
  const violations: string[] = [];
  for (const { path, node } of sourcesOf(model)) {
    if (isExempt(path) || compositionRoot.includes(path)) continue;
    for (const specifier of moduleSpecifiers(node)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = ts.resolveModuleName(
        specifier,
        node.fileName,
        OPTIONS,
        model.host,
      ).resolvedModule;
      const isAdapter =
        resolved === undefined
          ? ADAPTER_SPECIFIER.test(specifier)
          : adapters.has(relativePath(resolved.resolvedFileName));
      if (isAdapter) {
        violations.push(
          `${path} imports the adapter ${specifier}; only a composition-root file may import an adapter`,
        );
      }
    }
  }
  return violations;
}

/**
 * Inside `platform/` nothing implements a port until the task that builds the adapter lists its file in `allowed`: S0.1 adds no
 * adapter, inert or otherwise. Anywhere, a file that implements a port is named `*.adapter.ts`, so that the import rule above
 * can recognise it by name as well as by what it does.
 */
export function findPortImplementationViolations(
  model: SourceModel,
  names: readonly string[],
  allowed: readonly string[],
): string[] {
  const violations: string[] = [];
  for (const [path, found] of portImplementations(model, names)) {
    for (const name of names.filter((candidate) => found.has(candidate))) {
      if (path.startsWith('platform/') && !allowed.includes(path)) {
        violations.push(
          `${path} implements the port ${name} inside platform/; a port has no adapter there until the task that builds it lists the file`,
        );
      } else if (!path.endsWith('.adapter.ts')) {
        violations.push(
          `${path} implements the port ${name} in a file that is not named *.adapter.ts; an adapter is named so that only the composition root can import it`,
        );
      }
    }
  }
  return violations;
}

/**
 * The transaction requirement of each operation agrees with the signature it describes. An operation that takes the caller's
 * `TransactionHandle` is `inside-callers-transaction`, and only such an operation is. `independent` is reserved for the safe
 * local operations `localOperations` lists (`Port.method`): an operation that opens its own database transaction or calls out is
 * `outside-any-transaction`, not independent. The operations of the descriptor and the methods of the interface are the same set.
 */
export function findTransactionCategoryProblems(
  model: SourceModel,
  entries: readonly DescribedPort[],
  localOperations: readonly string[],
): string[] {
  const problems: string[] = [];
  const handle = (parameter: ts.ParameterDeclaration): boolean => {
    if (parameter.type === undefined) return false;
    const symbol = model.checker.getTypeFromTypeNode(parameter.type).getSymbol();
    return (
      symbol?.name === 'TransactionHandle' &&
      (symbol.declarations ?? []).some(
        (declaration) => relativePath(declaration.getSourceFile().fileName) === HANDLE_FILE,
      )
    );
  };

  for (const entry of entries) {
    const { name } = entry;
    const descriptor = isRecord(entry.descriptor) ? entry.descriptor : {};
    const operations = isRecord(descriptor.operations) ? descriptor.operations : {};
    const source = model.program.getSourceFile(`${ROOT}${PORTS_DIRECTORY}/${portFileName(name)}`);
    const declaration = source?.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === name,
    );
    if (declaration === undefined) {
      problems.push(
        `${name}: the interface was not found in ${PORTS_DIRECTORY}/${portFileName(name)}`,
      );
      continue;
    }
    const methods = new Map<string, boolean>();
    for (const member of declaration.members) {
      if (ts.isMethodSignature(member) && ts.isIdentifier(member.name)) {
        methods.set(member.name.text, member.parameters.some(handle));
      }
    }

    for (const method of methods.keys()) {
      if (!(method in operations)) {
        problems.push(`${name}.${method}: is a method of the interface with no description`);
      }
    }
    for (const [operation, value] of Object.entries(operations)) {
      const where = `${name}.${operation}`;
      const takesHandle = methods.get(operation);
      if (takesHandle === undefined) {
        problems.push(`${where}: is described but the interface has no such method`);
        continue;
      }
      const category = isRecord(value) ? value.transaction : undefined;
      if (takesHandle && category !== 'inside-callers-transaction') {
        problems.push(
          `${where}: takes the caller's TransactionHandle, so it must be described as inside-callers-transaction, not ${String(category)}`,
        );
      } else if (!takesHandle && category === 'inside-callers-transaction') {
        problems.push(
          `${where}: is described as inside-callers-transaction but takes no TransactionHandle`,
        );
      }
      const listed = localOperations.includes(where);
      if (category === 'independent' && !listed) {
        problems.push(
          `${where}: is described as independent, which is reserved for the listed safe local operations, and is not one of them`,
        );
      } else if (category !== 'independent' && listed) {
        problems.push(
          `${where}: is on the list of safe local operations but is described as ${String(category)}`,
        );
      }
    }
  }
  for (const listed of localOperations) {
    const [port = '', method = ''] = listed.split('.');
    const entry = entries.find((candidate) => candidate.name === port);
    const operations =
      entry !== undefined && isRecord(entry.descriptor) && isRecord(entry.descriptor.operations)
        ? entry.descriptor.operations
        : undefined;
    if (operations !== undefined && !(method in operations)) {
      problems.push(`${listed}: is on the list of safe local operations but no port describes it`);
    }
  }
  return problems;
}
