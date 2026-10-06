import { describe, expect, it, vi } from 'vitest';

import { CliUsageError } from './cli.js';
import { formatListing, parseOrphanArguments, removeNamed } from './orphans.js';
import {
  DISPOSABLE_MARKER,
  type LocalAdmin,
  type SqlClient,
  type TestDatabaseListing,
} from './provisioning.js';
import { UnsafeTargetError } from './safety.js';

describe('parseOrphanArguments', () => {
  // Break caught: the default doing anything but looking. No argument is a listing.
  it('reads no argument as a listing', () => {
    expect(parseOrphanArguments([])).toEqual({ drop: [], disconnect: false });
  });

  it('reads the databases named after --drop, once each, and the flag that disconnects', () => {
    expect(parseOrphanArguments(['--drop', 'melarc_test_aaaa1111'])).toEqual({
      drop: ['melarc_test_aaaa1111'],
      disconnect: false,
    });
    expect(
      parseOrphanArguments([
        '--drop',
        'melarc_test_aaaa1111',
        'melarc_test_bbbb2222',
        'melarc_test_aaaa1111',
        '--disconnect',
      ]),
    ).toEqual({ drop: ['melarc_test_aaaa1111', 'melarc_test_bbbb2222'], disconnect: true });
  });

  // Break caught: a deletion that nobody asked for by name. Each of these is a usage error, and none selects
  // a database.
  it.each([
    ['a name with no --drop', ['melarc_test_aaaa1111']],
    ['names with no --drop', ['melarc_test_aaaa1111', 'melarc_test_bbbb2222']],
    ['a flag and then a name, with no --drop', ['--disconnect', 'melarc_test_aaaa1111']],
    ['--drop with no name', ['--drop']],
    ['--drop followed only by a flag', ['--drop', '--disconnect']],
    ['--disconnect on its own', ['--disconnect']],
    ['--all', ['--all']],
    ['--force', ['--drop', 'melarc_test_aaaa1111', '--force']],
    ['--drop twice', ['--drop', 'melarc_test_aaaa1111', '--drop', 'melarc_test_bbbb2222']],
    ['an empty argument', ['--drop', '']],
  ])('refuses %s as a usage error', (_label, argv) => {
    expect(() => parseOrphanArguments(argv)).toThrow(CliUsageError);
  });
});

describe('formatListing', () => {
  it('says there is nothing when there is nothing', () => {
    expect(formatListing([])).toMatch(/no test databases/i);
  });

  // Break caught: a listing that claims to know what is abandoned. It states a fact about now, and says that
  // no session is not proof that a database is not in use.
  it('lists each database with its sessions and says that nothing was changed', () => {
    const text = formatListing([
      { name: 'melarc_test_0a1b2c3d', sessions: 0 },
      { name: 'melarc_test_9f8e7d6c', sessions: 3 },
    ]);

    expect(text).toContain('melarc_test_0a1b2c3d');
    expect(text).toMatch(/melarc_test_0a1b2c3d\s+no session connected/);
    expect(text).toMatch(/3 sessions/);
    expect(text).toMatch(/nothing was changed/i);
    expect(text).toMatch(/between steps/);
    expect(text).toContain('--drop');
  });

  it('writes one session in the singular', () => {
    expect(formatListing([{ name: 'melarc_test_0a1b2c3d', sessions: 1 }])).toMatch(/1 session\b/);
  });
});

/** A server holding the given databases. It records every statement it is sent. */
function server(
  databases: TestDatabaseListing[],
  options: { busy?: string[]; broken?: string[] } = {},
) {
  const sent: string[] = [];
  const dropped: string[] = [];
  const query = vi.fn<SqlClient['query']>((text, values) => {
    sent.push(text);
    if (text.includes('from pg_database d'))
      return Promise.resolve({ rows: databases.map((d) => ({ ...d })) });
    if (text.includes('shobj_description')) {
      const name = String((values as string[])[0]);
      const known = databases.some((d) => d.name === name);
      return Promise.resolve({ rows: known ? [{ comment: DISPOSABLE_MARKER }] : [] });
    }
    if (text.startsWith('select format(')) {
      const [template, args] = values as [string, string[]];
      return Promise.resolve({
        rows: [{ statement: template.replace('%I', `"${String(args[0])}"`) }],
      });
    }
    const match = /^DROP DATABASE "([^"]+)"/.exec(text);
    if (match !== null) {
      const name = match[1] ?? '';
      if (options.busy?.includes(name) === true) {
        return Promise.reject(Object.assign(new Error('in use'), { code: '55006' }));
      }
      if (options.broken?.includes(name) === true) {
        return Promise.reject(
          Object.assign(new Error('terminating connection due to administrator command'), {
            code: '57P01',
          }),
        );
      }
      dropped.push(name);
    }
    return Promise.resolve({ rows: [] });
  });
  const admin: LocalAdmin = {
    client: { query },
    host: '127.0.0.1',
    close: () => Promise.resolve(),
  };
  return { admin, sent, dropped };
}

describe('removeNamed', () => {
  const IDLE = { name: 'melarc_test_aaaa1111', sessions: 0 };
  const BUSY = { name: 'melarc_test_bbbb2222', sessions: 2 };

  // Break caught: the removal choosing for itself. Only a database that was named is touched, and the idle
  // one next to it stays.
  it('drops the one it was told to, and no other', async () => {
    const { admin, dropped } = server([IDLE, BUSY]);

    const result = await removeNamed(admin, [IDLE.name], { disconnect: false });

    expect(result).toEqual({ dropped: [IDLE.name], refused: [] });
    expect(dropped).toEqual([IDLE.name]);
  });

  // Break caught: a database in use being dropped without the person saying to end its sessions. The server's
  // own refusal is reported, the database stays, and nobody's session is ended.
  it('does not drop a database with sessions connected unless told to disconnect', async () => {
    const { admin, sent, dropped } = server([IDLE, BUSY], { busy: [BUSY.name] });

    const result = await removeNamed(admin, [BUSY.name, IDLE.name], { disconnect: false });

    expect(dropped).toEqual([IDLE.name]);
    expect(result.dropped).toEqual([IDLE.name]);
    expect(result.refused).toEqual([
      { name: BUSY.name, reason: expect.stringMatching(/sessions are connected/) as string },
    ]);
    expect(sent.join('\n')).not.toMatch(/pg_terminate_backend/i);
  });

  // Break caught: a failure that is not the server saying "in use" being listed as a refusal. The command would
  // then print it as one database among others and go on, hiding a server that is going away.
  it('does not turn any other failure into a refusal', async () => {
    const { admin } = server([IDLE, BUSY], { broken: [IDLE.name] });

    await expect(removeNamed(admin, [IDLE.name, BUSY.name], { disconnect: false })).rejects.toThrow(
      /terminating connection/,
    );
  });

  it('ends the sessions and forces the drop when told to disconnect', async () => {
    const { admin, sent } = server([BUSY]);

    await removeNamed(admin, [BUSY.name], { disconnect: true });

    expect(sent.join('\n')).toMatch(/pg_terminate_backend/i);
    expect(sent.join('\n')).toMatch(/WITH \(FORCE\)/);
  });

  // Break caught: a name that is not a test database reaching the server at all. Every name is checked before
  // any database is touched, so one bad name stops the whole removal.
  it.each(['melarc_dev', 'postgres', 'melarc_test_ab12"; DROP DATABASE postgres; --'])(
    'refuses the name %j before touching any database',
    async (bad) => {
      const { admin, sent, dropped } = server([IDLE]);

      await expect(removeNamed(admin, [IDLE.name, bad], { disconnect: false })).rejects.toThrow(
        UnsafeTargetError,
      );

      expect(dropped).toEqual([]);
      expect(sent).toEqual([]);
    },
  );

  // Break caught: a name that is not on the server, or is there without the marker, being dropped or ignored
  // quietly. A typo is told as one, and an unmarked database is not touched.
  it('refuses a name the server does not list as a marked test database, and drops nothing', async () => {
    const { admin, dropped } = server([IDLE]);

    await expect(
      removeNamed(admin, [IDLE.name, 'melarc_test_cccc3333'], { disconnect: false }),
    ).rejects.toThrow(/melarc_test_cccc3333[\s\S]*marker/);

    expect(dropped).toEqual([]);
  });

  it('refuses a server that is not on this machine, without a statement', async () => {
    const { admin, sent } = server([IDLE]);
    const remote: LocalAdmin = { ...admin, host: 'db.internal' };

    await expect(removeNamed(remote, [IDLE.name], { disconnect: false })).rejects.toThrow(
      UnsafeTargetError,
    );

    expect(sent).toEqual([]);
  });
});
