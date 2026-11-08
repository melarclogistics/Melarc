import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';

/**
 * What the attestation verifier's supply chain must keep (apps/attestation-verifier, S0.55). The vendored library is checked here too, on
 * every machine and without a JDK, besides the Gradle task that checks it where the build runs: the sources that decide whether a device is
 * genuine cannot change unseen.
 */
const root = resolve(import.meta.dirname, '..');
const verifier = join(root, 'apps', 'attestation-verifier');
const library = join(verifier, 'third_party', 'keyattestation');

const read = (path: string): string => readFileSync(path, 'utf8');
const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
const posix = (path: string): string => path.split(sep).join('/');

function filesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

describe('the vendored library', () => {
  const listed = new Map(
    read(join(library, 'FILES.sha256'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const [hash, path] = line.split('  ');
        assert.ok(hash !== undefined && path !== undefined && /^[0-9a-f]{64}$/.test(hash), line);
        return [path, hash] as const;
      }),
  );

  it('is byte for byte what FILES.sha256 says', () => {
    for (const [path, hash] of listed)
      assert.equal(sha256(join(library, path)), hash, `${path} changed`);
  });

  it('holds no file the list does not name', () => {
    const present = [
      ...filesBelow(join(library, 'src')),
      join(library, 'LICENSE'),
      join(library, 'roots.json'),
    ].map((path) => posix(relative(library, path)));
    assert.deepEqual(present.sort(), [...listed.keys()].sort());
  });

  it('is the pinned release, and says so', () => {
    const provenance = read(join(library, 'PROVENANCE.md'));
    assert.match(provenance, /621149c4ebaeeea844d6f43098687c73c4d370a3/);
    assert.match(provenance, /tag `v0\.4`/);
    assert.match(read(join(library, 'LICENSE')), /Apache License\s+Version 2\.0/);
    for (const [path] of listed) {
      if (path.endsWith('.kt'))
        assert.match(
          read(join(library, path)),
          /Apache License, Version 2\.0/,
          `${path} lost its header`,
        );
    }
  });
});

describe('the build', () => {
  const properties = read(join(verifier, 'gradle', 'wrapper', 'gradle-wrapper.properties'));
  const property = (name: string): string | undefined =>
    properties
      .split('\n')
      .map((line) => line.split('='))
      .find(([key]) => key === name)
      ?.slice(1)
      .join('=');

  it('starts from the Gradle distribution it pins, by checksum, from Gradle', () => {
    const url = property('distributionUrl') ?? '';
    assert.match(
      url,
      /^https\\:\/\/services\.gradle\.org\/distributions\/gradle-\d+\.\d+(?:\.\d+)?-bin\.zip$/,
    );
    assert.match(
      property('distributionSha256Sum') ?? '',
      /^[0-9a-f]{64}$/,
      'the distribution is not held to a checksum',
    );
    assert.equal(property('validateDistributionUrl'), 'true');
  });

  it('holds the wrapper itself to the checksum Gradle publishes for it', () => {
    // https://services.gradle.org/distributions/gradle-8.14.5-wrapper.jar.sha256 : change it with the version in gradle-wrapper.properties.
    assert.match(property('distributionUrl') ?? '', /gradle-8\.14\.5-bin\.zip$/);
    assert.equal(
      sha256(join(verifier, 'gradle', 'wrapper', 'gradle-wrapper.jar')),
      '7d3a4ac4de1c32b59bc6a4eb8ecb8e612ccd0cf1ae1e99f66902da64df296172',
    );
  });

  const metadata = read(join(verifier, 'gradle', 'verification-metadata.xml'));
  const catalogue = read(join(verifier, 'gradle', 'libs.versions.toml'));
  const versions = new Map(
    [...catalogue.matchAll(/^([a-z0-9-]+) = "([^"]+)"$/gm)].map(
      (match) => [match[1] ?? '', match[2] ?? ''] as const,
    ),
  );

  it('checks the checksum of every artifact it resolves, and trusts none by name', () => {
    assert.match(metadata, /<verify-metadata>true<\/verify-metadata>/);
    assert.doesNotMatch(metadata, /<trusted-artifacts>|<trust\s|<ignored-keys>|<ignored-key\s/);
    assert.doesNotMatch(metadata, /<md5\s/);
  });

  it('has an entry for every library of the catalogue', () => {
    const libraries = [
      ...catalogue.matchAll(
        /^[a-z0-9-]+ = \{ module = "([^:"]+):([^"]+)", version\.ref = "([^"]+)" \}$/gm,
      ),
    ];
    assert.ok(libraries.length >= 10, 'the catalogue was not read');
    for (const [, group, name, ref] of libraries) {
      const version = versions.get(ref ?? '');
      assert.ok(version !== undefined, `${ref ?? ''} has no version`);
      assert.ok(
        metadata.includes(
          `<component group="${group ?? ''}" name="${name ?? ''}" version="${version}">`,
        ),
        `${group ?? ''}:${name ?? ''}:${version} has no checksum in verification-metadata.xml`,
      );
    }
  });

  const atLeast = (actual: string, floor: string): boolean => {
    const a = actual.split('.').map(Number);
    const f = floor.split('.').map(Number);
    for (let index = 0; index < f.length; index += 1) {
      if ((a[index] ?? 0) !== (f[index] ?? 0)) return (a[index] ?? 0) > (f[index] ?? 0);
    }
    return true;
  };

  it('does not go back to a version with a known advisory that reaches this service', () => {
    // BouncyCastle before 1.85 resets the nesting guard of its ASN.1 parser (GHSA-qp49-qgx5-5m26), and this service parses the ASN.1 of
    // certificates a caller sent before it has proved the chain; Kotlin before 2.4.20 deserializes build-cache metadata (GHSA-r937-wjx7-w2jp).
    assert.ok(
      atLeast(versions.get('bouncycastle') ?? '0', '1.85'),
      `BouncyCastle ${versions.get('bouncycastle') ?? ''}`,
    );
    assert.ok(
      atLeast(versions.get('kotlin') ?? '0', '2.4.20'),
      `Kotlin ${versions.get('kotlin') ?? ''}`,
    );
  });

  it('uses the JDK .java-version pins, in both builds that name a toolchain', () => {
    const major = /^(\d+)\./.exec(read(join(root, '.java-version')))?.[1];
    assert.ok(major !== undefined);
    for (const build of [
      join(verifier, 'service', 'build.gradle.kts'),
      join(library, 'build.gradle.kts'),
    ]) {
      assert.match(read(build), new RegExp(`jvmToolchain\\(${major}\\)`), build);
    }
  });

  it('keeps the build cache off, which is what the Kotlin advisory needs', () => {
    assert.match(read(join(verifier, 'gradle.properties')), /^org\.gradle\.caching=false$/m);
  });
});

describe('the settings', () => {
  // The service's own test holds .env.example to the settings the service reads (VerifierConfigTest); this holds the document that owns the
  // table (DEPLOYMENT_AND_ENVIRONMENTS.md section 12.6) to the same file, so the three agree or a build fails.
  const example = new Map(
    [...read(join(verifier, '.env.example')).matchAll(/^(VERIFIER_[A-Z_]+)=(.*)$/gm)].map(
      (match) => [match[1] ?? '', (match[2] ?? '').trim()] as const,
    ),
  );
  const deployment = read(join(root, 'architecture', 'DEPLOYMENT_AND_ENVIRONMENTS.md')).replaceAll(
    '\r',
    '',
  );
  const section = /^### 12\.6 [^\n]*\n([\s\S]*?)^## 13\. /m.exec(deployment)?.[1] ?? '';
  const rows = [...section.matchAll(/^\| `(VERIFIER_[A-Z_]+)`\|[^|\n]*\| ([^|\n]*)\|/gm)].map(
    (match) => ({ key: match[1] ?? '', fallback: (match[2] ?? '').trim() }),
  );

  it('are the same in .env.example and in the table of DEPLOYMENT_AND_ENVIRONMENTS.md section 12.6', () => {
    assert.ok(example.size >= 17, 'the example was not read');
    assert.ok(rows.length >= 17, 'the table was not read');
    assert.deepEqual(rows.map((row) => row.key).sort(), [...example.keys()].sort());
    assert.equal(
      new Set(rows.map((row) => row.key)).size,
      rows.length,
      'a setting is listed twice',
    );
  });

  it('have the default the table states, and the example holds no secret or release input', () => {
    for (const { key, fallback } of rows) {
      const value = example.get(key);
      assert.ok(value !== undefined, `${key} is not in .env.example`);
      if (fallback === 'none') {
        // A path to the public list the pinned library ships is not a release input's value; every other setting without a default is a
        // secret or a G3 input, and the example leaves it empty.
        if (key !== 'VERIFIER_ACCEPTED_ROOTS_FILE')
          assert.equal(value, '', `${key} has no default, so the example must leave it empty`);
      } else {
        assert.equal(`\`${value}\``, fallback, `${key}: the example and the table disagree`);
      }
    }
  });
});
