import { describe, expect, it } from 'vitest';

import { descriptorOf, inspectDirectorySddl, inspectSddl, type AclProblem } from './custody-acl.js';

const USER = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const OTHER = 'S-1-5-21-1111111111-2222222222-3333333333-1002';

const refused = (descriptor: string, problem: AclProblem, user = USER): void => {
  expect(inspectSddl(descriptor, user), descriptor).toEqual({ ok: false, problem });
};

describe('inspecting the access control list of a custody bundle on Windows (S0.30, OB-25)', () => {
  // Break caught: a file the user alone can open being refused, which would make the command unusable on Windows.
  it.each([
    ['the user alone', `D:P(A;;FA;;;${USER})`],
    [
      'the user, the local system and the administrators',
      `D:P(A;;FA;;;${USER})(A;;FA;;;SY)(A;;FA;;;BA)`,
    ],
    [
      'the same by their well-known SIDs',
      `D:P(A;;FA;;;${USER})(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)`,
    ],
    ['the flags icacls writes beside the protection', `D:PAI(A;;FA;;;${USER})`],
    [
      'an owner and a group before it',
      `O:${USER}G:S-1-5-21-1111111111-2222222222-3333333333-513D:P(A;;FA;;;${USER})`,
    ],
    ['an owner and a group whose aliases end in D', `O:BAG:BAD:P(A;;FA;;;BA)(A;;FA;;;${USER})`],
    ['a SACL after it', `D:P(A;;FA;;;${USER})S:AI(AU;SA;FA;;;WD)`],
    ['the user in lower case', `D:P(A;;FA;;;${USER.toLowerCase()})`],
  ])('accepts %s', (_name, descriptor) => {
    expect(inspectSddl(descriptor, USER)).toEqual({ ok: true });
  });

  // Break caught: access that a folder grants to a broad group passing as private, which is what a file made in a profile or a
  // temporary folder carries when nothing removes the inheritance.
  it.each([
    ['Everyone', 'WD'],
    ['Users', 'BU'],
    ['Authenticated Users', 'AU'],
    ['Guests', 'BG'],
    ['Anonymous', 'AN'],
    ['Interactive', 'IU'],
    ['Network', 'NU'],
    ['Power users', 'PU'],
    ['Domain users', 'DU'],
    ['Creator owner', 'CO'],
    ['Everyone by SID', 'S-1-1-0'],
    ['Users by SID', 'S-1-5-32-545'],
    ['Authenticated Users by SID', 'S-1-5-11'],
  ])('refuses access held by %s, even beside the user', (_name, sid) => {
    refused(`D:P(A;;FA;;;${USER})(A;;FR;;;${sid})`, 'BROAD');
    refused(`D:P(A;;FR;;;${sid})(A;;FA;;;${USER})`, 'BROAD');
  });

  it('refuses another user or group, a domain group among them, as a principal that is not the user', () => {
    refused(`D:P(A;;FA;;;${USER})(A;;FR;;;${OTHER})`, 'OTHER_PRINCIPAL');
    refused(
      `D:P(A;;FA;;;${USER})(A;;FR;;;S-1-5-21-1111111111-2222222222-3333333333-513)`,
      'OTHER_PRINCIPAL',
    );
    refused(`D:P(A;;FA;;;${USER})(A;;FR;;;LA)`, 'OTHER_PRINCIPAL');
  });

  // Break caught: an entry that comes from the folder and returns when the folder's list changes.
  it('refuses an inherited entry, protected or not, and a list that is not protected at all', () => {
    refused(`D:P(A;ID;FA;;;${USER})`, 'INHERITED');
    refused(`D:P(A;;FA;;;${USER})(A;OICIID;FA;;;SY)`, 'INHERITED');
    refused(`D:PAI(A;ID;FA;;;${USER})(A;ID;FA;;;SY)`, 'INHERITED');
    refused(`D:AI(A;;FA;;;${USER})`, 'NOT_PROTECTED');
    refused(`D:(A;;FA;;;${USER})`, 'NOT_PROTECTED');
  });

  it('refuses a missing list, which grants everyone everything, and a list nobody can open', () => {
    refused('D:NO_ACCESS_CONTROL', 'NO_DACL');
    refused('D:PNO_ACCESS_CONTROL', 'NO_DACL');
    refused('D:P', 'NO_ACCESS_FOR_USER');
    refused('D:P(A;;FA;;;SY)(A;;FA;;;BA)', 'NO_ACCESS_FOR_USER');
  });

  // Break caught: a SID compared by prefix, so that the account 1001 is taken for 10011 or 100.
  it('holds the user to their own SID and no prefix of it', () => {
    refused(`D:P(A;;FA;;;${USER}1)`, 'OTHER_PRINCIPAL');
    refused(`D:P(A;;FA;;;${USER.slice(0, -1)})`, 'OTHER_PRINCIPAL');
    expect(inspectSddl(`D:P(A;;FA;;;${USER}1)`, `${USER}1`)).toEqual({ ok: true });
  });

  // Break caught: an inspection that did not understand the list, passing it.
  it('refuses what it cannot read: a deny entry, an entry of the wrong shape, text that is no descriptor, a user that is no SID', () => {
    refused(`D:P(D;;FA;;;${OTHER})(A;;FA;;;${USER})`, 'UNPARSEABLE');
    refused(`D:P(A;;FA;;${USER})`, 'UNPARSEABLE');
    refused(`D:P(A;;FA;;;${USER};extra)`, 'UNPARSEABLE');
    refused('hello', 'UNPARSEABLE');
    refused('', 'UNPARSEABLE');
    refused(`D:P(A;;FA;;;${USER})junk`, 'UNPARSEABLE');
    refused(`D:P(A;;FA;;;${USER})`, 'UNPARSEABLE', 'not-a-sid');
    refused(`D:P(A;;FA;;;${USER})`, 'UNPARSEABLE', '');
  });

  describe('the folder the bundles go in (the review of 21 October 2026)', () => {
    const folderRefused = (descriptor: string, problem: AclProblem): void => {
      expect(inspectDirectorySddl(descriptor, USER), descriptor).toEqual({ ok: false, problem });
    };

    // Break caught: a folder that is private in every way that matters being refused, which would make the command unusable in the
    // places an operator naturally keeps it. The first two are what `icacls /save` wrote for real folders: one under the user's
    // profile, whose list is inherited, and one the user made private.
    it.each([
      [
        'a folder in the profile of the user, whose list is inherited',
        `D:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})`,
      ],
      ['a folder that was made private to the user', `D:P(A;OICI;FA;;;${USER})`],
      [
        'the creator owner as an inherit-only placeholder, which stands for the user who makes the file',
        `D:AI(A;OICIIOID;FA;;;CO)(A;OICIID;FA;;;SY)(A;ID;FA;;;${USER})`,
      ],
      [
        'the same by well-known SIDs',
        `D:(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)(A;;FA;;;${USER})`,
      ],
    ])('accepts %s', (_name, descriptor) => {
      expect(inspectDirectorySddl(descriptor, USER)).toEqual({ ok: true });
    });

    // Break caught: a folder that lets a broad group in passing as private. This is what a folder directly under a data drive carries
    // (the entries are those `icacls /save` wrote for a folder of this repository): Authenticated Users with modify rights and Users
    // with read, which is the way another account opens a file the moment it is made.
    it('refuses what a folder under a data drive carries, and any entry for a broad group, inherited or not', () => {
      folderRefused(
        `D:(A;ID;FA;;;BA)(A;OICIIOID;GA;;;BA)(A;ID;FA;;;SY)(A;OICIIOID;GA;;;SY)(A;ID;0x1301bf;;;AU)(A;OICIIOID;SDGXGWGR;;;AU)(A;ID;0x1200a9;;;BU)(A;OICIIOID;GXGR;;;BU)(A;ID;FA;;;${USER})`,
        'BROAD',
      );
      for (const sid of ['WD', 'BU', 'AU', 'BG', 'AN', 'IU', 'S-1-1-0', 'S-1-5-32-545']) {
        folderRefused(`D:P(A;OICI;FA;;;${USER})(A;;FR;;;${sid})`, 'BROAD');
        folderRefused(`D:(A;OICIID;FR;;;${sid})(A;OICIID;FA;;;${USER})`, 'BROAD');
      }
    });

    // Break caught: the creator owner excused whenever it appears, which it may not be: an entry for it that applies to the folder
    // itself, or to the files without being inherit-only, is not a placeholder.
    it('excuses the creator owner and the creator group only as inherit-only placeholders', () => {
      folderRefused(`D:P(A;;FA;;;${USER})(A;;FA;;;CO)`, 'BROAD');
      folderRefused(`D:P(A;;FA;;;${USER})(A;OICI;FA;;;CO)`, 'BROAD');
      folderRefused(`D:P(A;;FA;;;${USER})(A;OICI;FA;;;CG)`, 'BROAD');
      folderRefused(`D:P(A;;FA;;;${USER})(A;OICI;FA;;;S-1-3-0)`, 'BROAD');
      expect(inspectDirectorySddl(`D:P(A;;FA;;;${USER})(A;OICIIO;FA;;;CG)`, USER)).toEqual({
        ok: true,
      });
    });

    it('refuses another user or group, and a list that gives the user no entry of their own', () => {
      folderRefused(`D:P(A;OICI;FA;;;${USER})(A;OICI;FR;;;${OTHER})`, 'OTHER_PRINCIPAL');
      folderRefused(`D:P(A;OICI;FA;;;${USER})(A;OICI;FR;;;LA)`, 'OTHER_PRINCIPAL');
      folderRefused('D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)', 'NO_ACCESS_FOR_USER');
      folderRefused('D:P', 'NO_ACCESS_FOR_USER');
      folderRefused(`D:P(A;OICI;FA;;;${USER}1)`, 'OTHER_PRINCIPAL');
    });

    // Break caught: an inspection that did not understand the list, or that found none, passing the folder.
    it('refuses a missing list and what it cannot read', () => {
      folderRefused('D:NO_ACCESS_CONTROL', 'NO_DACL');
      folderRefused(`D:P(D;;FA;;;${OTHER})(A;;FA;;;${USER})`, 'UNPARSEABLE');
      folderRefused(`D:P(A;;FA;;;${USER})junk`, 'UNPARSEABLE');
      folderRefused(`D:P(A;;FA;;${USER})`, 'UNPARSEABLE');
      folderRefused('hello', 'UNPARSEABLE');
      folderRefused('', 'UNPARSEABLE');
      expect(inspectDirectorySddl(`D:P(A;;FA;;;${USER})`, 'not-a-sid')).toEqual({
        ok: false,
        problem: 'UNPARSEABLE',
      });
    });

    // The one thing that separates a folder from a file: inheritance is how a folder gets its list, so it is not a reason to refuse.
    it('does not refuse a list for being unprotected or inherited, which the judgement of a file does', () => {
      const inherited = `D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;${USER})`;
      expect(inspectDirectorySddl(inherited, USER)).toEqual({ ok: true });
      expect(inspectSddl(inherited, USER)).toEqual({ ok: false, problem: 'NOT_PROTECTED' });
    });
  });

  describe('reading the text icacls /save writes', () => {
    it('finds the descriptor after the name of the file, as UTF-8', () => {
      expect(descriptorOf(`bundle.bundle\r\nD:PAI(A;;FA;;;${USER})\r\n`)).toBe(
        `D:PAI(A;;FA;;;${USER})`,
      );
    });

    it('finds it in text that was UTF-16, whose characters arrive with a NUL between them', () => {
      const wide = `bundle.bundle\nD:P(A;;FA;;;${USER})\n`.split('').join('\u0000');
      expect(descriptorOf(wide)).toBe(`D:P(A;;FA;;;${USER})`);
    });

    it('finds nothing in text that holds no descriptor', () => {
      expect(descriptorOf('bundle.bundle\nAccess is denied.\n')).toBeUndefined();
      expect(descriptorOf('')).toBeUndefined();
    });
  });
});
