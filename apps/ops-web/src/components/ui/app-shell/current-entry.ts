/**
 * The entry that is current at an address: the most specific one the address is at or under. An entry is at or under a path when the path is its
 * own or begins with it and a slash (so `/admin/staffing` is not under `/admin/staff`), and the root entry is current only on the root page.
 * Where one entry lies under another the deeper one wins, and a page that belongs to an entry without being one (a person's profile, under
 * "Staff"; the form that books a pickup, under "Requests") keeps that entry current.
 */
export function currentEntry<Entry extends { readonly to: string }>(
  entries: readonly Entry[],
  pathname: string,
): Entry | undefined {
  let best: Entry | undefined;
  for (const entry of entries) {
    const at = pathname === entry.to;
    const under = entry.to !== '/' && pathname.startsWith(`${entry.to}/`);
    if ((at || under) && (best === undefined || entry.to.length > best.to.length)) best = entry;
  }
  return best;
}
