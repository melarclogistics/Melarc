// Makes `real-chains.v1.json`, the real device chains the pinned release of android/keyattestation ships as test data, in the form the
// service's qualification test reads (S0.55a): each chain as the base64 DER of its certificates, leaf first, with the instant it was made.
//
//   node convert-real-chains.mjs <the unpacked release directory> > real-chains.v1.json
//
// The release's own tests verify each chain at the instant the key was created (the factory and the remotely provisioned intermediates
// of older devices have since expired), against the roots Google publishes (`third_party/keyattestation/roots.json`). Only elliptic-curve
// chains are taken: the device key of this slice is an EC P-256 key. Nothing here is a secret: these are public certificates.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const root = process.argv[2];
if (root === undefined)
  throw new Error('usage: node convert-real-chains.mjs <the unpacked release directory>');

const CHAINS = [
  ['walleye/sdk27/TEE_EC_NONE', 'Pixel 2, Android 8.1, factory provisioned, TEE'],
  ['blueline/sdk28/TEE_EC_NONE', 'Pixel 3, Android 9, factory provisioned, TEE'],
  ['marlin/sdk29/TEE_EC_NONE', 'Pixel, Android 10, factory provisioned, TEE'],
  ['sony-xperia10-iii/sdk33/TEE_EC', 'Xperia 10 III, Android 13, factory provisioned, TEE'],
  ['akita/sdk34/TEE_EC_NONE', 'Pixel 8a, Android 14, remotely provisioned, TEE'],
  ['caiman/sdk36/TEE_EC_RKP', 'Pixel 9 Pro, Android 16, remotely provisioned, TEE'],
  ['caiman/sdk36/SB_EC_RKP', 'Pixel 9 Pro, Android 16, remotely provisioned, StrongBox'],
  ['tegu/sdk36/TEE_EC_2026_ROOT', 'Pixel 9a, Android 16, the 2026 root, TEE'],
  ['tegu/sdk36/SB_EC_2026_ROOT', 'Pixel 9a, Android 16, the 2026 root, StrongBox'],
  ['frankel/sdk37/TEE_EC_2026', 'Android 17, the 2026 root, TEE'],
];

const chains = CHAINS.map(([path, description]) => {
  const pem = readFileSync(join(root, 'testdata', `${path}.pem`), 'utf8');
  // A few of the release's files begin with comment lines.
  const json = readFileSync(join(root, 'testdata', `${path}.json`), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  const description_ = JSON.parse(json);
  const certificates = [
    ...pem.matchAll(/-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/g),
  ].map((match) => (match[1] ?? '').replace(/\s+/g, ''));
  const created =
    description_.softwareEnforced?.creationDateTime ??
    description_.hardwareEnforced?.creationDateTime;
  if (certificates.length < 3 || created === undefined)
    throw new Error(`${path}: not a chain with a creation time`);
  return {
    name: path,
    description,
    chain: certificates,
    // The instant the key was created: the time at which the release's tests judge the chain's validity.
    at: new Date(Number(created)).toISOString(),
    attestation_security_level: description_.attestationSecurityLevel,
    // The challenge the release's test app used (base64), and the application identity it reported.
    challenge_base64: description_.attestationChallenge,
    package_name:
      description_.softwareEnforced?.attestationApplicationId?.packages?.[0]?.name ?? null,
  };
});

process.stdout.write(
  `${JSON.stringify(
    {
      format: 'melarc.real-chains.v1',
      source:
        'android/keyattestation v0.4 (621149c) testdata, converted by convert-real-chains.mjs',
      chains,
    },
    null,
    2,
  )}\n`,
);
