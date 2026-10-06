import ts from 'typescript';

function parse(sourceText: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
}

/**
 * The name of every interface, type alias, class and enum a file declares, wherever it is declared (nested
 * in a function or a namespace too). Imports, references and values are not declarations of a type.
 */
export function declaredTypeNames(sourceText: string, fileName = 'file.ts'): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      if (node.name !== undefined) names.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(sourceText, fileName));
  return names;
}

/** Every module specifier a file imports or re-exports, in source order, including dynamic and type imports. */
export function moduleSpecifiers(sourceText: string, fileName = 'file.ts'): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isStringLiteral(argument)) specifiers.push(argument.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(sourceText, fileName));
  return specifiers;
}
