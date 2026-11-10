import ts from 'typescript';

/**
 * What a source file says **in code**, read from its syntax tree: its names, its strings, the elements it draws and the attributes it gives them, and the property of an object that a name is
 * read from. A comment is not a node, and the text of an element is not code: a sentence that says "the PIN is never shown" is not a PIN being shown, and an apostrophe or `//` in the text of an
 * element hides nothing after it (a scanner of tokens, which does not read JSX as JSX, took the apostrophe for the start of a string and the `//` for the start of a comment, and went blind
 * to the rest of the line: the review of f6cf02b). The structural guards of the credential screens (`rider-no-credential-display.test.ts`, `staff-no-credential-display.test.ts`) read through it.
 */
export interface Code {
  readonly names: ReadonlySet<string>;
  readonly strings: ReadonlySet<string>;
  readonly elements: ReadonlySet<string>;
  /** `Element.attribute=text` for an attribute given a string, `Element.attribute={expression}` for one given an expression, else `Element.attribute`. */
  readonly attributes: ReadonlySet<string>;
  /** The property of an object that a name is read from: `grant.enrolmentUri` is `grant.enrolmentUri`. */
  readonly accesses: readonly string[];
}

export function codeOf(text: string, fileName: string): Code {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const names = new Set<string>();
  const strings = new Set<string>();
  const elements = new Set<string>();
  const attributes = new Set<string>();
  const accesses: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) names.add(node.text);
    if (ts.isStringLiteralLike(node)) strings.add(node.text);
    if (ts.isTemplateExpression(node)) {
      strings.add(node.head.text);
      for (const span of node.templateSpans) strings.add(span.literal.text);
    }
    if (ts.isPropertyAccessExpression(node)) {
      accesses.push(`${node.expression.getText(source)}.${node.name.text}`);
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      elements.add(tag);
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        const initializer = attribute.initializer;
        const name = `${tag}.${attribute.name.getText(source)}`;
        if (initializer !== undefined && ts.isStringLiteral(initializer)) {
          attributes.add(`${name}=${initializer.text}`);
        } else if (initializer !== undefined && ts.isJsxExpression(initializer)) {
          attributes.add(`${name}={${initializer.expression?.getText(source) ?? ''}}`);
        } else {
          attributes.add(name);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { names, strings, elements, attributes, accesses };
}
