/**
 * **The runtime half of "a permission key is on no screen"** (PRODUCT_DESIGN_DIRECTION section 6.5): the guard that reads the source (`no-permission-key-on-screen.test.ts`)
 * cannot see a key that is put together at run time (a name built from a variable, a value that arrives in an answer, a word the table gets wrong), so this watches
 * what is drawn. It looks at every text and every attribute of the document, as the document is built and as it changes, and notes each key of the catalogue it finds.
 *
 * It is one function that names nothing outside itself, because the browser tests send its source into the page (Playwright's `addInitScript`) and the component tests
 * call it in jsdom: the same code looks in both. A script and a style are not screens, so their text is not read.
 */
export interface PermissionKeyWatch {
  /** Every key found so far, each with where it was: the text of an element, or an attribute of one. */
  readonly hits: string[];
  /** Reads the changes the browser has noted and not yet handed over, stops watching, and gives the hits. */
  finish(): string[];
}

export interface PermissionKeyWatchOptions {
  /** The pattern of {@link keyPatternSource}, and its flags (global). */
  readonly source: string;
  readonly flags: string;
  /** Whether to write each hit to the console as an error: the browser tests' page watcher turns a console error into a failure. */
  readonly log: boolean;
}

/**
 * What the watch writes to the console before each hit (the browser tests' guard listens for it). The function below is sent into the page as source and names nothing outside itself, so the
 * text is written in it too, and `watch-page.test.ts` holds the two to each other.
 */
export const PERMISSION_KEY_LOG_PREFIX = 'A permission key is on the screen: ';

export function watchForPermissionKeys(options: PermissionKeyWatchOptions): PermissionKeyWatch {
  const pattern = new RegExp(options.source, options.flags);
  const hits: string[] = [];
  const seen = new Set<string>();

  const describe = (element: Element | null): string => {
    if (element === null) return 'the document';
    const name = element.getAttribute('aria-label') ?? element.getAttribute('data-testid');
    return name === null
      ? `<${element.tagName.toLowerCase()}>`
      : `<${element.tagName.toLowerCase()}> "${name}"`;
  };

  const note = (key: string, place: string): void => {
    const line = `${key} in ${place}`;
    if (seen.has(line)) return;
    seen.add(line);
    hits.push(line);
    if (options.log) console.error(`A permission key is on the screen: ${line}`);
  };

  const look = (text: string, place: string): void => {
    for (const found of text.matchAll(pattern)) note(found[0], place);
  };

  /** A script or a style is code and not a screen. */
  const isCode = (element: Element | null): boolean => {
    const tag = element?.tagName;
    return tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT';
  };

  const lookAt = (node: Node): void => {
    if (node.nodeType === 3) {
      if (!isCode(node.parentElement)) {
        look(node.nodeValue ?? '', `the text of ${describe(node.parentElement)}`);
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (isCode(element)) return;
    for (const attribute of element.getAttributeNames()) {
      look(
        element.getAttribute(attribute) ?? '',
        `the ${attribute} attribute of ${describe(element)}`,
      );
    }
    for (const child of element.childNodes) lookAt(child);
  };

  const handle = (records: readonly MutationRecord[]): void => {
    for (const record of records) {
      if (record.type === 'childList') {
        for (const added of record.addedNodes) lookAt(added);
      } else if (record.type === 'characterData') {
        lookAt(record.target);
      } else if (record.target.nodeType === 1 && record.attributeName !== null) {
        const element = record.target as Element;
        look(
          element.getAttribute(record.attributeName) ?? '',
          `the ${record.attributeName} attribute of ${describe(element)}`,
        );
      }
    }
  };

  const observer = new MutationObserver(handle);
  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  // What is already drawn when the watch starts (a component test may have rendered). In a browser the watch starts before the parser has made the root element, which is `null` then
  // (the type says it never is), and the observer sees everything the parser makes after it.
  const root = document.documentElement as HTMLElement | null;
  if (root !== null) lookAt(root);

  return {
    hits,
    finish: () => {
      handle(observer.takeRecords());
      observer.disconnect();
      return hits;
    },
  };
}
