/** Up to two letters for an avatar: the first of the first and of the last word of the name. Nothing when the name has no letter. */
export function initialsOf(name: string | null): string {
  const words = (name ?? '').split(/\s+/).filter((word) => /\p{L}/u.test(word));
  const first = words[0]?.match(/\p{L}/u)?.[0] ?? '';
  const last = words.length > 1 ? (words.at(-1)?.match(/\p{L}/u)?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}
