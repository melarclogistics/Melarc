import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_LIMIT_SIGNATURE,
  DAEMON_DEFAULT_MAX_RECURSION,
  NESTED_ARCHIVE_DEPTH,
  NESTED_ARCHIVE_TEST_FILE,
  archiveNestingOf,
  nestedArchiveOf,
} from './nested-archive-test-file.js';

/**
 * The test file for the scanner's limits (Run D, Part 2, finding F3 of the review of Run B): an archive inside an archive, deeper than the daemon's default `MaxRecursion`, so that a
 * daemon configured with `AlertExceedsMax no` says `stream: OK` for a file it stopped reading, and one with `yes` flags it. These tests hold the file to what the smoke command and the
 * stand-in scanner rely on: it is a real chain of archives, as deep as it says, and small.
 */
describe('the nested archive test file', () => {
  // Break caught: a file that is not deeper than the daemon's default limit (it would be scanned to its end and the setting never asked), or one whose depth is not what it says.
  it('is deeper than the daemon’s default limit of 17 levels, and says how deep it is', () => {
    expect(DAEMON_DEFAULT_MAX_RECURSION).toBe(17);
    expect(NESTED_ARCHIVE_DEPTH).toBeGreaterThan(DAEMON_DEFAULT_MAX_RECURSION);
    expect(archiveNestingOf(NESTED_ARCHIVE_TEST_FILE)).toBe(NESTED_ARCHIVE_DEPTH);
  });

  // Break caught: a file the owner would not want in a bucket (large), or one that is not an archive by its signature (the platform's own signature check would then be what refuses it).
  it('is a few kilobytes, and begins as a ZIP archive does', () => {
    expect(NESTED_ARCHIVE_TEST_FILE.length).toBeLessThan(16 * 1024);
    expect(NESTED_ARCHIVE_TEST_FILE.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(NESTED_ARCHIVE_TEST_FILE.subarray(-22, -18).toString('hex')).toBe('504b0506');
  });

  // Break caught: a depth that the builder ignores, or a count that reads one layer too many or too few.
  it('is built to the depth it is asked for, and the depth is read back from the file itself', () => {
    for (const depth of [1, 2, 5, 17, 18, 40]) {
      expect(archiveNestingOf(nestedArchiveOf(depth)), String(depth)).toBe(depth);
    }
    expect(archiveNestingOf(Buffer.from('not an archive'))).toBe(0);
    expect(archiveNestingOf(Buffer.alloc(0))).toBe(0);
    // A file that only begins like an archive is no deeper than the layers it really has.
    expect(archiveNestingOf(Buffer.from('504b0304', 'hex'))).toBe(0);
  });

  // Break caught: a made-up signature name that ClamAV does not use, so that a real run and a dry run would not read the same word.
  it('is flagged, by a daemon that is asked to, as an exceeded limit', () => {
    expect(ARCHIVE_LIMIT_SIGNATURE).toBe('Heuristics.Limits.Exceeded');
  });
});
