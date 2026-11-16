/**
 * The body of the first rule whose selector list contains `selector` exactly (a rule written as `a, b { … }` counts for both), with its comments taken out. The stylesheets of the kit are flat
 * (no nesting), so a rule ends at the first closing brace. A rule inside an `@media` block is found too, as the rule of its own braces; `after` is the way to ask for the one in the block.
 */
export function ruleOf(text: string, selector: string): string | undefined {
  return rulesOf(text, selector)[0];
}

/** The bodies of every rule whose selector list contains `selector` exactly, in the order they are written: a selector that is styled in a shared rule and again in its own has both. */
export function rulesOf(text: string, selector: string): string[] {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const bodies: string[] = [];
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? '').split(',').map((part) => part.trim());
    if (selectors.includes(selector)) bodies.push(match[2] ?? '');
  }
  return bodies;
}

/** What follows the first `marker` in a stylesheet (an `@media` line, as it is written), or `undefined` if the marker is not there: the place to look for a rule that only that block holds. */
export function after(text: string, marker: string): string | undefined {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = clean.indexOf(marker);
  return at === -1 ? undefined : clean.slice(at + marker.length);
}
