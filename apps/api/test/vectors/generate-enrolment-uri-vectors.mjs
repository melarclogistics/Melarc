// Generates `enrolment-uri.v1.json`, the published vectors of the version-1 enrolment URI (SECURITY_DESIGN.md section 13.6):
//
//   node generate-enrolment-uri-vectors.mjs > enrolment-uri.v1.json
//
// The file is consumed by the Node tests of the strict reader (`apps/api/src/platform/auth/rider/enrolment-uri.test.ts`) and, when it exists,
// by the Android app's tests, which must accept the valid payloads and refuse every other one without a network call. It is deterministic
// (every token and challenge is the SHA-256 of a label) and it holds no secret: the tokens are of no grant.
import { createHash } from 'node:crypto';
import process from 'node:process';

const b64url = (label) => createHash('sha256').update(label).digest('base64url');
const T = b64url('token:one');
const C = b64url('challenge:one');
const T2 = b64url('token:two');
const C2 = b64url('challenge:two');
const base = (token = T, challenge = C) =>
  `melarc-rider://enrol/v1#token=${token}&challenge=${challenge}`;
const good = base();

const vectors = [];
const add = (name, payload, valid, why) => vectors.push({ name, payload, valid, why });

add('the valid payload', good, true);
add('another valid payload', base(T2, C2), true);

// Another version, scheme, host or path, or a case variant of any of them.
add('another version', good.replace('/v1#', '/v2#'), false, 'only version 1');
add('version zero', good.replace('/v1#', '/v0#'), false, 'only version 1');
add('an upper-case version', good.replace('/v1#', '/V1#'), false, 'compared case-sensitively');
add('a dotted version', good.replace('/v1#', '/v1.0#'), false, 'the path is exactly v1');
add('another scheme', good.replace('melarc-rider', 'melarc-vendor'), false, 'the exact scheme');
add('a shorter scheme', good.replace('melarc-rider', 'melarc'), false, 'the exact scheme');
add(
  'an HTTPS URL',
  good.replace('melarc-rider', 'https'),
  false,
  'the exact scheme: the URI never names a host to call',
);
add(
  'an upper-case scheme',
  good.replace('melarc-rider', 'MELARC-RIDER'),
  false,
  'compared case-sensitively',
);
add(
  'a mixed-case scheme',
  good.replace('melarc-rider', 'Melarc-Rider'),
  false,
  'compared case-sensitively',
);
add('one slash after the scheme', good.replace('://', ':/'), false, 'the authority form');
add('no slashes after the scheme', good.replace('://', ':'), false, 'the authority form');
add('another host', good.replace('//enrol/', '//enroll/'), false, 'the host is exactly enrol');
add('an upper-case host', good.replace('//enrol/', '//ENROL/'), false, 'compared case-sensitively');
add('a capitalised host', good.replace('//enrol/', '//Enrol/'), false, 'compared case-sensitively');
add(
  'a host with a domain',
  good.replace('//enrol/', '//enrol.example.test/'),
  false,
  'the host is exactly enrol',
);
add(
  'an API origin as the host',
  good.replace('//enrol/', '//api.example.test/'),
  false,
  'the URI never tells the app which host to call',
);
add(
  'a double slash before the version',
  good.replace('/v1#', '//v1#'),
  false,
  'the path is exactly /v1',
);
add(
  'a trailing slash after the version',
  good.replace('/v1#', '/v1/#'),
  false,
  'the path is exactly /v1',
);
add('a further path segment', good.replace('/v1#', '/v1/x#'), false, 'the path is exactly /v1');
add('no version', good.replace('/v1#', '#'), false, 'the path is exactly /v1');

// User-info and a port.
add('user-info', good.replace('//enrol', '//user@enrol'), false, 'no user-info');
add(
  'user-info with a password',
  good.replace('//enrol', '//user:secret@enrol'),
  false,
  'no user-info',
);
add('a port', good.replace('//enrol', '//enrol:443'), false, 'no port');
add('a high port', good.replace('//enrol', '//enrol:8443'), false, 'no port');

// A query instead of a fragment, and other shapes of the fragment.
add(
  'a query instead of the fragment',
  good.replace('/v1#', '/v1?'),
  false,
  'a fragment, never a query',
);
add(
  'a query before the fragment',
  good.replace('/v1#', '/v1?x=1#'),
  false,
  'a fragment, never a query',
);
add('a trailing ampersand', `${good}&`, false, 'exactly two parameters');
add('a leading ampersand', good.replace('#token', '#&token'), false, 'exactly two parameters');
add('a space after the fragment mark', good.replace('#token', '# token'), false, 'whitespace');
add('no parameters', 'melarc-rider://enrol/v1#', false, 'both parameters are required');
add('no fragment', 'melarc-rider://enrol/v1', false, 'both parameters are required');

// A missing, duplicate, extra or reordered parameter.
add(
  'a missing challenge',
  `melarc-rider://enrol/v1#token=${T}`,
  false,
  'both parameters are required',
);
add(
  'a missing token',
  `melarc-rider://enrol/v1#challenge=${C}`,
  false,
  'both parameters are required',
);
add(
  'a token with an empty challenge',
  `melarc-rider://enrol/v1#token=${T}&challenge=`,
  false,
  'both parameters are required',
);
add(
  'a duplicate token',
  `melarc-rider://enrol/v1#token=${T}&token=${T2}&challenge=${C}`,
  false,
  'exactly one token',
);
add(
  'a duplicate challenge',
  `melarc-rider://enrol/v1#token=${T}&challenge=${C}&challenge=${C2}`,
  false,
  'exactly one challenge',
);
add(
  'the parameters reordered',
  `melarc-rider://enrol/v1#challenge=${C}&token=${T}`,
  false,
  'the token first',
);
add('an extra parameter', `${good}&extra=1`, false, 'no extra field');
add('a callback parameter', `${good}&callback=https://api.example.test/cb`, false, 'no callback');
add('a redirect parameter', `${good}&redirect=https://api.example.test/`, false, 'no redirect');
add('an API origin parameter', `${good}&api=https://api.example.test`, false, 'no API origin');
// The same length as the right separator: only the comparison of the separator itself refuses these.
add(
  'another separator of the same length',
  good.replace('&challenge=', ';challenge='),
  false,
  'the parameters are joined by an ampersand',
);
add(
  'a separator in another case',
  good.replace('&challenge=', '&Challenge='),
  false,
  'compared case-sensitively',
);
add(
  'a separator that does not assign',
  good.replace('&challenge=', '&challenge:'),
  false,
  'the name and the value are joined by an equals sign',
);
add(
  'a second fragment mark as the separator',
  good.replace('&challenge=', '#challenge='),
  false,
  'exactly one fragment',
);
add('a space as the separator', good.replace('&challenge=', ' challenge='), false, 'no whitespace');
add('a renamed token', good.replace('token=', 'tok='), false, 'the parameter names');
add('a renamed challenge', good.replace('challenge=', 'chal='), false, 'the parameter names');
add(
  'an upper-case parameter name',
  good.replace('token=', 'TOKEN='),
  false,
  'compared case-sensitively',
);

// A token or challenge one character short or long.
add('a token one character short', good.replace(T, T.slice(0, -1)), false, 'exactly 43 characters');
add('a token one character long', good.replace(T, `${T}A`), false, 'exactly 43 characters');
add(
  'a challenge one character short',
  good.replace(C, C.slice(0, -1)),
  false,
  'exactly 43 characters',
);
add('a challenge one character long', good.replace(C, `${C}A`), false, 'exactly 43 characters');

// Padding, the standard alphabet and a non-zero spare bit.
add('padding on the token', good.replace(T, `${T.slice(0, 42)}=`), false, 'unpadded');
add('padding after the challenge', `${good}=`, false, 'unpadded');
add(
  'a plus sign in the token',
  good.replace(T, `${T.slice(0, 20)}+${T.slice(21)}`),
  false,
  'base64url, not standard base64',
);
add(
  'a slash in the token',
  good.replace(T, `${T.slice(0, 20)}/${T.slice(21)}`),
  false,
  'base64url, not standard base64',
);
add(
  'a plus sign in the challenge',
  good.replace(C, `${C.slice(0, 20)}+${C.slice(21)}`),
  false,
  'base64url, not standard base64',
);
add(
  'a slash in the challenge',
  good.replace(C, `${C.slice(0, 20)}/${C.slice(21)}`),
  false,
  'base64url, not standard base64',
);
add(
  'a non-zero spare bit in the token',
  good.replace(T, `${T.slice(0, 42)}B`),
  false,
  'one value, one spelling: the last character carries two spare bits that must be zero',
);
add(
  'a non-zero spare bit in the challenge',
  good.replace(C, `${C.slice(0, 42)}B`),
  false,
  'one value, one spelling: the last character carries two spare bits that must be zero',
);

// Percent-encoding, whitespace and non-ASCII characters.
add(
  'a percent-encoded character in the token',
  good.replace(T, `%41${T.slice(3)}`),
  false,
  'no percent-encoding',
);
add(
  'a percent-encoded character in the challenge',
  good.replace(C, `${C.slice(0, 40)}%41`),
  false,
  'no percent-encoding',
);
add('a leading space', ` ${good}`, false, 'trims nothing');
add('a trailing space', `${good} `, false, 'trims nothing');
add(
  'a space inside the token',
  good.replace(T, `${T.slice(0, 20)} ${T.slice(21)}`),
  false,
  'no whitespace',
);
add(
  'a tab inside the challenge',
  good.replace(C, `${C.slice(0, 20)}\t${C.slice(21)}`),
  false,
  'no whitespace',
);
add(
  'a newline inside the token',
  good.replace(T, `${T.slice(0, 20)}\n${T.slice(21)}`),
  false,
  'no whitespace',
);
add('a trailing newline', `${good}\n`, false, 'no whitespace');
add('a trailing carriage return and line feed', `${good}\r\n`, false, 'no whitespace');
add(
  'a non-ASCII letter in the token',
  good.replace(T, `${T.slice(0, 20)}é${T.slice(21)}`),
  false,
  'ASCII only',
);
add(
  'a zero-width space inside the challenge',
  good.replace(C, `${C.slice(0, 20)}\u200b${C.slice(21)}`),
  false,
  'ASCII only',
);
add('a full-width letter in the scheme', good.replace('melarc', 'ｍelarc'), false, 'ASCII only');

// A bounded read: one character over, and a very long input.
add(
  '128 characters',
  `${good}A`,
  false,
  'no more than 127 characters are read before it is refused',
);
add('a very long input', good + 'A'.repeat(5000), false, 'refused after a bounded read');
add('a very long token', good.replace(T, T.repeat(100)), false, 'refused after a bounded read');

// A value that looks like a callback or an API origin.
add(
  'a callback as the challenge',
  `melarc-rider://enrol/v1#token=${T}&challenge=https://api.example.test/cb`,
  false,
  'the URI never names a host to call',
);
add(
  'an API origin as the token',
  `melarc-rider://enrol/v1#token=https://api.example.test/x&challenge=${C}`,
  false,
  'the URI never names a host to call',
);
add(
  'only an API origin',
  'https://api.example.test/v1/auth/rider/device/enrol',
  false,
  'not the form',
);

// Nothing, and text that is not a payload.
add('an empty text', '', false, 'nothing is a payload');
add('the word null', 'null', false, 'not the form');
add('a JSON object', JSON.stringify({ token: T, challenge: C }), false, 'not the form');

const lengths = new Set(
  vectors.filter((vector) => vector.valid).map((vector) => vector.payload.length),
);
if (lengths.size !== 1 || !lengths.has(127))
  throw new Error('A valid payload is exactly 127 characters');
const names = new Set(vectors.map((vector) => vector.name));
if (names.size !== vectors.length) throw new Error('A vector name is used twice');

process.stdout.write(
  `${JSON.stringify(
    {
      format: 'melarc.enrolment-uri-vectors.v1',
      source: 'generate-enrolment-uri-vectors.mjs; deterministic, see the README',
      payload:
        'melarc-rider://enrol/v1#token=<43 characters of base64url>&challenge=<43 characters of base64url>, exactly 127 ASCII characters',
      vectors,
    },
    null,
    2,
  )}\n`,
);
