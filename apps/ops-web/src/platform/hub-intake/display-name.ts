const MAX_NAME = 120;

/**
 * A display name: one line of text, bounded, with no control character, and **never a number that could be dialled**. A name is told by what the screens draw of a person, and a telephone number
 * in its place would be a number drawn (OB-S1-106: no phone number on the receiving side), so an answer whose name carries seven digits in a run, separators allowed, is refused. It lives apart from the
 * shapes that use it (the receiving screens' and the intake's) so that neither has to import the other.
 */
export function nameOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '' || text.length > MAX_NAME) return undefined;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return undefined;
  }
  if (/(?:\+?\d[\s().-]?){7,}/.test(text)) return undefined;
  return text;
}
