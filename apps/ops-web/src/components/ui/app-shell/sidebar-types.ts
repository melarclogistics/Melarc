import type { IconName } from '../icon/icons';

/** One entry of the sidebar, as it is drawn. The shell decides which entries a session has and what their counts are; the sidebar draws them. */
export interface SidebarEntry {
  readonly to: string;
  readonly label: string;
  readonly icon: IconName;
  /**
   * The count of the work waiting at this entry, when the server stated one: the number, and what it counts, said after it. Left out when there is
   * none to draw: a count that is still being read, was not given or could not be read is never drawn as `0`.
   */
  readonly badge?: { readonly count: number; readonly meaning: string };
}

/** A group of entries under a heading (Today, Pickups, …). A group with no entry is not given to the sidebar. */
export interface SidebarGroup {
  readonly id: string;
  readonly label: string;
  readonly entries: readonly SidebarEntry[];
}

/** Who is signed in, as the foot of the sidebar says it. Both are labels from the session; neither grants anything. */
export interface SidebarAccount {
  /** The person's display name, or null when the principal has none. */
  readonly name: string | null;
  /** One short line under the name: where they act (a hub's name, or how many hubs), or null when the session lists none. */
  readonly detail: string | null;
}
