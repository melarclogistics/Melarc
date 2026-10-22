/**
 * The inspection of the access control list of a custody bundle on Windows (MIGRATION_AND_SEEDING.md §3.2: "on Windows it inspects
 * the resulting access control list and refuses broad or inherited access, because a POSIX mode alone is not access control there";
 * S0.30). Pure: it reads the security descriptor in SDDL form, which `icacls /save` writes and which names principals by SID or by a
 * two-letter alias and so does not depend on the language of the machine, and says whether the file is private to the custodian's
 * operator.
 *
 * **What it accepts, and nothing more.** The DACL is protected (it takes nothing from the folder, now or when the folder changes),
 * no entry of it is inherited, every entry allows the user who runs the command, the local system or the built-in administrators and
 * nobody else, and the user holds an entry of their own. A broad principal (Everyone, Users, Authenticated Users, Guests, Anonymous,
 * Interactive, Network and the like), any other user or group, a deny entry whose reach this reader does not follow, a missing DACL
 * (which grants everyone everything) and anything it cannot parse are refused: **an inspection that did not say is not a clean
 * bill**.
 */

/** Why an access control list is refused. */
export type AclProblem =
  | 'UNPARSEABLE'
  | 'NO_DACL'
  | 'NOT_PROTECTED'
  | 'INHERITED'
  | 'BROAD'
  | 'OTHER_PRINCIPAL'
  | 'NO_ACCESS_FOR_USER';

export type AclFinding =
  { readonly ok: true } | { readonly ok: false; readonly problem: AclProblem };

/** The SDDL aliases of the principals that name everyone or nearly: no file that holds a secret is open to them. */
const BROAD_ALIASES = new Set([
  'WD', // Everyone
  'BU', // BUILTIN\Users
  'AU', // Authenticated Users
  'BG', // BUILTIN\Guests
  'AN', // Anonymous
  'IU', // Interactive
  'NU', // Network
  'RC', // Restricted code
  'AC', // All application packages
  'LG', // Guest
  'DU', // Domain users
  'DG', // Domain guests
  'DC', // Domain computers
  'DD', // Domain controllers
  'PU', // Power users
  'CO', // Creator owner (becomes the owner of a file made in the folder: not the user alone)
  'CG', // Creator group
]);
const BROAD_SIDS = new Set([
  'S-1-1-0',
  'S-1-5-2',
  'S-1-5-4',
  'S-1-5-7',
  'S-1-5-11',
  'S-1-5-32-545',
  'S-1-5-32-546',
  'S-1-5-32-547',
  'S-1-3-0',
  'S-1-3-1',
]);

/** The two system principals a private file may also list: the local system and the built-in administrators. */
const SYSTEM_ALIASES = new Set(['SY', 'BA']);
const SYSTEM_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544']);

const ACE_TYPES_FOLLOWED = new Set(['A']);

/** The security descriptor out of the text `icacls /save` wrote: the first line that is a descriptor, and `undefined` for none. */
export function descriptorOf(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replaceAll('\u0000', '').trim();
    if (/^(O|G|D|S):/.test(line)) return line;
  }
  return undefined;
}

/**
 * The flags and the entries of the DACL of a descriptor, or why it cannot be read or is no list at all (a null DACL grants everyone
 * everything). Shared by the judgement of a file and of a folder.
 */
function daclOf(
  descriptor: string,
  userSid: string,
):
  | { readonly flags: string; readonly entries: readonly string[] }
  | { readonly problem: AclProblem } {
  if (typeof descriptor !== 'string' || descriptor.length === 0 || !/^S-1-[0-9-]+$/.test(userSid)) {
    return { problem: 'UNPARSEABLE' };
  }
  // The DACL section runs to the end of the descriptor or to a SACL after it. It is found from the end so that an owner or a group
  // whose alias ends in a D (`O:BAG:BAD:`) is not read as the start of it.
  const dacl = /D:([A-Z_]*)((?:\([^()]*\))*)(?:S:.*)?$/.exec(descriptor);
  if (dacl === null) return { problem: 'UNPARSEABLE' };
  const flags = dacl[1] ?? '';
  const entries = [...(dacl[2] ?? '').matchAll(/\(([^()]*)\)/g)].map((match) => match[1] ?? '');
  // A null DACL grants everyone everything.
  if (flags.includes('NO_ACCESS_CONTROL')) return { problem: 'NO_DACL' };
  return { flags, entries };
}

/**
 * Judges a security descriptor in SDDL form for the user whose SID is `userSid`.
 *
 * SDDL is `O:<owner>G:<group>D:<flags>(<ace>)(<ace>)...S:...`. The DACL is the `D:` section up to the next section; each entry is
 * six `;`-separated fields, `type;flags;rights;object;inherit-object;sid`.
 */
export function inspectSddl(descriptor: string, userSid: string): AclFinding {
  const read = daclOf(descriptor, userSid);
  if ('problem' in read) return { ok: false, problem: read.problem };
  const { flags, entries } = read;
  if (!flags.includes('P')) return { ok: false, problem: 'NOT_PROTECTED' };
  if (entries.length === 0) return { ok: false, problem: 'NO_ACCESS_FOR_USER' };

  const wanted = userSid.toUpperCase();
  let userEntry = false;
  for (const entry of entries) {
    const fields = entry.split(';');
    if (fields.length !== 6) return { ok: false, problem: 'UNPARSEABLE' };
    const [type = '', aceFlags = '', , , , sidField = ''] = fields;
    const sid = sidField.toUpperCase();
    if (aceFlags.toUpperCase().includes('ID')) return { ok: false, problem: 'INHERITED' };
    if (!ACE_TYPES_FOLLOWED.has(type.toUpperCase())) return { ok: false, problem: 'UNPARSEABLE' };
    if (BROAD_ALIASES.has(sid) || BROAD_SIDS.has(sid)) return { ok: false, problem: 'BROAD' };
    if (sid === wanted) {
      userEntry = true;
    } else if (!SYSTEM_ALIASES.has(sid) && !SYSTEM_SIDS.has(sid)) {
      return { ok: false, problem: 'OTHER_PRINCIPAL' };
    }
  }
  return userEntry ? { ok: true } : { ok: false, problem: 'NO_ACCESS_FOR_USER' };
}

/** The flags of an entry, as the two-letter words they are (`OI`, `CI`, `IO`, `NP`, `ID`, ...): `OICIIOID` is four of them, not a text. */
const flagWords = (flags: string): string[] => flags.toUpperCase().match(/.{1,2}/g) ?? [];

/**
 * Judges the access list of the **folder** the bundles go in, for the user whose SID is `userSid`, before any file is made in it
 * (S0.30, the review of 21 October 2026). A file takes its first access list from its folder and is made private only after it has
 * been created, and a handle that another account opened in between keeps the access it was given when the list changes: so the
 * folder must not give any account but the user's, the local system's and the administrators' a way into the files made in it.
 *
 * It is not the judgement of a file: a folder inherits from its parent as a matter of course (the profile of the user is such a folder),
 * so a list that is not protected, or holds inherited entries, is accepted; what it refuses is **any entry for a principal that is not
 * the user, the local system or the built-in administrators, whether or not the entry is inherited or reaches the files**. The one
 * exception is the creator owner and creator group of an entry that is inherit-only: it is a placeholder that stands for whoever
 * makes the file, which is the user. A deny entry, an entry of the wrong shape and anything it cannot parse are refused, and so is
 * a list that gives the user no entry of their own (`inspect` says nothing for an inspection that did not say).
 */
export function inspectDirectorySddl(descriptor: string, userSid: string): AclFinding {
  const read = daclOf(descriptor, userSid);
  if ('problem' in read) return { ok: false, problem: read.problem };
  if (read.entries.length === 0) return { ok: false, problem: 'NO_ACCESS_FOR_USER' };

  const wanted = userSid.toUpperCase();
  let userEntry = false;
  for (const entry of read.entries) {
    const fields = entry.split(';');
    if (fields.length !== 6) return { ok: false, problem: 'UNPARSEABLE' };
    const [type = '', aceFlags = '', , , , sidField = ''] = fields;
    const sid = sidField.toUpperCase();
    if (!ACE_TYPES_FOLLOWED.has(type.toUpperCase())) return { ok: false, problem: 'UNPARSEABLE' };
    const placeholder =
      (sid === 'CO' || sid === 'CG' || sid === 'S-1-3-0' || sid === 'S-1-3-1') &&
      flagWords(aceFlags).includes('IO');
    if (placeholder) continue;
    if (BROAD_ALIASES.has(sid) || BROAD_SIDS.has(sid)) return { ok: false, problem: 'BROAD' };
    if (sid === wanted) {
      userEntry = true;
    } else if (!SYSTEM_ALIASES.has(sid) && !SYSTEM_SIDS.has(sid)) {
      return { ok: false, problem: 'OTHER_PRINCIPAL' };
    }
  }
  return userEntry ? { ok: true } : { ok: false, problem: 'NO_ACCESS_FOR_USER' };
}
