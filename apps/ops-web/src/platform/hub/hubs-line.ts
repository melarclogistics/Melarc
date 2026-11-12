/**
 * Where a person acts, in a few words: the hub's name when the session lists one, how many hubs when it lists more, and nothing when it lists none.
 * The foot of the sidebar, the account menu and My work all say it, so it is written once. It reads the hubs the session lists, not the hub chosen in
 * the switcher (`useActiveHub`): it says where the person *may* act.
 */
export function hubsLine(hubs: readonly { readonly display_name: string }[]): string | null {
  const [only] = hubs;
  if (only === undefined) return null;
  return hubs.length === 1 ? only.display_name : `${String(hubs.length)} hubs`;
}
