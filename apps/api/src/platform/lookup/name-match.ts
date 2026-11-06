import { sql, type SQL } from 'drizzle-orm';

import { wordPrefixPatterns } from './lookup-query.js';

/**
 * The condition of a word-prefix search of one column of names (`features/operations/global-lookup.md` section 5): the text at the start of the
 * name, or at the start of any word of it, whatever the case, with `%`, `_` and the escape itself taken as the characters of a name. `column` is a
 * fragment of the source's own statement (a constant it wrote), never request input; the text is bound.
 */
export function nameMatches(column: string, text: string): SQL {
  const [start, word] = wordPrefixPatterns(text);
  const name = sql.raw(column);
  return sql`(${name} ilike ${start}::text escape '\\' or ${name} ilike ${word}::text escape '\\')`;
}
