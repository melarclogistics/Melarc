import { crc32 } from 'node:zlib';

/**
 * An archive inside an archive, deeper than the daemon's default limit, for the one thing a scanner's default configuration gets wrong about its own limits (Run D, Part 2, finding F3 of the
 * review of Run B). ClamAV stops scanning a file when it crosses one of its limits (`MaxRecursion`, `MaxFiles`, `MaxFileSize`, `MaxScanSize`) and, with the default `AlertExceedsMax no`,
 * answers `stream: OK` for a file it did not finish reading: a file nobody called clean, stored as clean. With the setting the daemon answers `FOUND` (the heuristic signature
 * `Heuristics.Limits.Exceeded`), which the platform refuses as malicious content and removes. Nothing proved that setting before this file: `evidence:smoke` puts it through the real daemon, and the
 * in-process stand-in recognises it, so that a dry run and a real run ask the same question.
 *
 * The file is made here from code, so that nothing binary is kept in the repository. It is a chain of ZIP archives, each holding the next as its one entry, **stored and not compressed** (so it
 * stays a few kilobytes and a scanner that unpacks it does no work to speak of); the innermost holds one harmless byte. It carries no script, no link and nothing that does anything. It is deeper
 * than the daemon's default `MaxRecursion` (17); a daemon configured with a limit above the depth of this file is not asked the question, and the command says so.
 */
export const DAEMON_DEFAULT_MAX_RECURSION = 17;

/** How many archives deep the test file goes: more than the default limit, and few enough to stay small (108 bytes a level). */
export const NESTED_ARCHIVE_DEPTH = 32;

/** The name ClamAV gives a file that crossed a limit it is told to alert on, which the stand-in gives too, so that a test reads the same word. */
export const ARCHIVE_LIMIT_SIGNATURE = 'Heuristics.Limits.Exceeded';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
const LOCAL_HEADER_BYTES = 30;
const ENTRY_NAME = Buffer.from('a.zip', 'latin1');

/** A ZIP archive of one stored entry: the local header, the bytes, the central directory and its end, written as the format defines them (no extra fields, no comment, no compression). */
function storedArchiveOf(inner: Uint8Array): Buffer {
  const data = Buffer.from(inner);
  const crc = crc32(data) >>> 0;
  const local = Buffer.alloc(LOCAL_HEADER_BYTES);
  local.writeUInt32LE(LOCAL_HEADER, 0);
  local.writeUInt16LE(10, 4); // version needed to extract
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method: stored
  local.writeUInt16LE(0, 10); // modification time
  local.writeUInt16LE(0x21, 12); // modification date: 1 January 1980
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); // compressed size
  local.writeUInt32LE(data.length, 22); // uncompressed size
  local.writeUInt16LE(ENTRY_NAME.length, 26);
  local.writeUInt16LE(0, 28); // extra field length
  const central = Buffer.alloc(46);
  central.writeUInt32LE(CENTRAL_HEADER, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(10, 6); // version needed to extract
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(ENTRY_NAME.length, 28);
  // extra field, comment, disk number, internal and external attributes: zero (the buffer is zeroed); the entry begins at offset 0.
  central.writeUInt32LE(0, 42);
  const directoryOffset = LOCAL_HEADER_BYTES + ENTRY_NAME.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_DIRECTORY, 0);
  end.writeUInt16LE(1, 8); // entries on this disk
  end.writeUInt16LE(1, 10); // entries in all
  end.writeUInt32LE(central.length + ENTRY_NAME.length, 12); // size of the central directory
  end.writeUInt32LE(directoryOffset, 16);
  return Buffer.concat([local, ENTRY_NAME, data, central, ENTRY_NAME, end]);
}

/** A chain of `depth` stored archives, each holding the next, around one harmless byte. */
export function nestedArchiveOf(depth: number): Buffer {
  let bytes: Buffer = Buffer.from('x', 'latin1');
  for (let level = 0; level < depth; level += 1) bytes = storedArchiveOf(bytes);
  return bytes;
}

export const NESTED_ARCHIVE_TEST_FILE: Buffer = nestedArchiveOf(NESTED_ARCHIVE_DEPTH);

/**
 * How many archives deep a file goes, read from its own headers: the file begins as a ZIP archive whose first entry is stored and begins as one, and so on. A file that only begins like an archive,
 * with no whole header, is no deeper than the layers it really has. Reads the head of the file only (the headers of each level follow one another), so it is fit for the first bytes of a stream.
 */
export function archiveNestingOf(bytes: Uint8Array): number {
  let held = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let depth = 0;
  for (;;) {
    if (held.length < LOCAL_HEADER_BYTES || held.readUInt32LE(0) !== LOCAL_HEADER) return depth;
    const method = held.readUInt16LE(8);
    const size = held.readUInt32LE(18);
    const start = LOCAL_HEADER_BYTES + held.readUInt16LE(26) + held.readUInt16LE(28);
    if (method !== 0) return depth + 1;
    depth += 1;
    // The entry is read as far as the bytes held go: a stream that was cut short still shows the layers it began.
    held = held.subarray(start, start + size);
  }
}
