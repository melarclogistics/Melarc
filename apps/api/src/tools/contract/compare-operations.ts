import { compareSchemas } from './compare-schemas.js';
import type { Finding, FindingCode } from './findings.js';
import { canonicalJson, type Json } from '../../platform/contract/json.js';
import type {
  HeaderDescription,
  OperationDescription,
  ParameterDescription,
  ResponseDescription,
  Serialization,
} from './operation-description.js';
import type { NormSchema } from './schema-normalizer.js';

const same = (a: unknown, b: unknown): boolean =>
  canonicalJson(a as Json) === canonicalJson(b as Json);
const show = (value: unknown): string => (value === undefined ? 'nothing' : JSON.stringify(value));
const union = (a: readonly string[], b: readonly string[]): string[] =>
  [...new Set([...a, ...b])].toSorted();

function statusOrder(a: string, b: string): number {
  const numeric = (status: string) =>
    /^\d+$/.test(status) ? Number(status) : Number.POSITIVE_INFINITY;
  return numeric(a) - numeric(b) || a.localeCompare(b);
}

/** A 4xx or 5xx answer, or the catch-all `default`, which is for failures. */
function isErrorStatus(status: string): boolean {
  return status === 'default' || Number(status) >= 400;
}

/** The members of each list that the other lacks. */
function setDifference(contract: readonly string[], code: readonly string[]) {
  return {
    onlyContract: contract.filter((value) => !code.includes(value)),
    onlyCode: code.filter((value) => !contract.includes(value)),
  };
}

function describeSet(
  prefix: string,
  difference: ReturnType<typeof setDifference>,
  noun: string,
): string {
  return [
    prefix,
    difference.onlyContract.length > 0
      ? `Only the contract has ${noun} ${difference.onlyContract.map(show).join(', ')}.`
      : undefined,
    difference.onlyCode.length > 0
      ? `Only the code has ${noun} ${difference.onlyCode.map(show).join(', ')}.`
      : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(' ');
}

function parameterCode(location: string): FindingCode {
  if (location === 'header') return 'HEADER_DRIFT';
  if (location === 'cookie') return 'COOKIE_DRIFT';
  return 'PARAMETER_DRIFT';
}

/** How a parameter is written, in words: `form, explode true`, or `as application/json content`. */
function sayHowWritten(serialization: Serialization): string {
  if (serialization.content !== undefined) return `as ${serialization.content} content`;
  return [
    `style ${serialization.style ?? 'unspecified'}`,
    `explode ${String(serialization.explode ?? false)}`,
    serialization.allowReserved === true ? 'reserved characters allowed' : undefined,
    serialization.allowEmptyValue === true ? 'empty value allowed' : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(', ');
}

function compareParameters(
  label: string,
  expected: OperationDescription,
  actual: OperationDescription,
  out: Finding[],
): void {
  for (const key of union(Object.keys(expected.parameters), Object.keys(actual.parameters))) {
    const contract: ParameterDescription | undefined = expected.parameters[key];
    const code: ParameterDescription | undefined = actual.parameters[key];
    const at = `${label} > parameter ${key}`;
    const noun = (parameter: ParameterDescription) =>
      `${parameter.in} parameter ${parameter.name}${parameter.required ? ' (required)' : ''}`;

    if (contract !== undefined && code === undefined) {
      out.push({
        code: parameterCode(contract.in),
        at,
        message: `The contract declares the ${noun(contract)} and the code does not.`,
      });
    } else if (contract === undefined && code !== undefined) {
      out.push({
        code: parameterCode(code.in),
        at,
        message: `The code declares the ${noun(code)} and the contract does not.`,
      });
    } else if (contract !== undefined && code !== undefined) {
      if (contract.required !== code.required) {
        out.push({
          code: parameterCode(contract.in),
          at,
          message: `The ${contract.in} parameter ${contract.name} is ${contract.required ? 'required' : 'optional'} in the contract and ${code.required ? 'required' : 'optional'} in the code.`,
        });
      }
      if (!same(contract.serialization, code.serialization)) {
        out.push({
          code: parameterCode(contract.in),
          at,
          message: `The ${contract.in} parameter ${contract.name} is written ${sayHowWritten(contract.serialization)} in the contract and ${sayHowWritten(code.serialization)} in the code.`,
          expected: asJson(contract.serialization),
          actual: asJson(code.serialization),
        });
      }
      if (contract.deprecated !== code.deprecated) {
        out.push({
          code: parameterCode(contract.in),
          at,
          message: `The ${contract.in} parameter ${contract.name} is ${contract.deprecated ? 'deprecated' : 'not deprecated'} in the contract and ${code.deprecated ? 'deprecated' : 'not deprecated'} in the code.`,
        });
      }
      out.push(...compareSchemas(contract.schema, code.schema, at));
    }
  }
}

/** Every statement the description does not read, reported when only one side makes it or the two differ. */
function compareUnmodelled(
  label: string,
  expected: OperationDescription,
  actual: OperationDescription,
  out: Finding[],
): void {
  for (const key of union(Object.keys(expected.unmodelled), Object.keys(actual.unmodelled))) {
    const contract = expected.unmodelled[key];
    const code = actual.unmodelled[key];
    if (contract !== undefined && code !== undefined && same(contract, code)) continue;
    out.push({
      code: 'OPERATION_UNMODELLED',
      at: `${label} > ${key}`,
      message:
        code === undefined
          ? `The contract states ${show(key)} and the code does not. This comparison does not model it, so it is reported rather than ignored.`
          : contract === undefined
            ? `The code states ${show(key)} and the contract does not. This comparison does not model it, so it is reported rather than ignored.`
            : `${show(key)} differs between the contract and the code. This comparison does not model it, so it is reported rather than ignored.`,
      ...(contract === undefined ? {} : { expected: contract }),
      ...(code === undefined ? {} : { actual: code }),
    });
  }
}

const asJson = (value: unknown): Json => value as Json;

function compareContent(
  label: string,
  kind: FindingCode,
  expected: Readonly<Record<string, NormSchema>>,
  actual: Readonly<Record<string, NormSchema>>,
  out: Finding[],
): void {
  const difference = setDifference(Object.keys(expected), Object.keys(actual));
  if (difference.onlyContract.length > 0 || difference.onlyCode.length > 0) {
    out.push({
      code: kind,
      at: label,
      message: describeSet('The media types differ.', difference, 'the media type'),
    });
  }
  for (const media of Object.keys(expected).filter((name) => name in actual)) {
    const contract = expected[media];
    const code = actual[media];
    if (contract !== undefined && code !== undefined) {
      out.push(...compareSchemas(contract, code, `${label} > ${media}`));
    }
  }
}

function compareResponse(
  label: string,
  status: string,
  expected: ResponseDescription,
  actual: ResponseDescription,
  out: Finding[],
): void {
  const at = `${label} > response ${status}`;
  compareContent(
    at,
    isErrorStatus(status) ? 'ERROR_RESPONSE_DRIFT' : 'RESPONSE_DRIFT',
    expected.content,
    actual.content,
    out,
  );

  for (const name of union(Object.keys(expected.headers), Object.keys(actual.headers))) {
    const contract: HeaderDescription | undefined = expected.headers[name];
    const code: HeaderDescription | undefined = actual.headers[name];
    if (contract !== undefined && code === undefined) {
      out.push({
        code: 'HEADER_DRIFT',
        at,
        message: `The contract has the response header ${contract.name} and the code does not.`,
      });
    } else if (contract === undefined && code !== undefined) {
      out.push({
        code: 'HEADER_DRIFT',
        at,
        message: `The code has the response header ${code.name} and the contract does not.`,
      });
    } else if (contract !== undefined && code !== undefined) {
      if (contract.required !== code.required) {
        out.push({
          code: 'HEADER_DRIFT',
          at,
          message: `The response header ${contract.name} is ${contract.required ? 'always' : 'not always'} sent in the contract and ${code.required ? 'always' : 'not always'} in the code.`,
        });
      }
      out.push(...compareSchemas(contract.schema, code.schema, `${at} > header ${contract.name}`));
    }
  }

  const cookies = setDifference(expected.setCookies, actual.setCookies);
  if (cookies.onlyContract.length > 0 || cookies.onlyCode.length > 0) {
    out.push({
      code: 'COOKIE_DRIFT',
      at,
      message: describeSet('The cookies this response sets differ.', cookies, 'the cookie'),
      expected: [...expected.setCookies],
      actual: [...actual.setCookies],
    });
  }
  if (expected.setCookiesFor !== actual.setCookiesFor) {
    const who = (scheme: string | undefined) =>
      scheme === undefined ? 'every caller' : `a request that presented ${scheme}`;
    out.push({
      code: 'COOKIE_DRIFT',
      at,
      message: `Who is owed this response's cookies differs: the contract says ${who(expected.setCookiesFor)} and the code says ${who(actual.setCookiesFor)}.`,
      expected: expected.setCookiesFor ?? null,
      actual: actual.setCookiesFor ?? null,
    });
  }
  if (expected.setCookiesWhen !== actual.setCookiesWhen) {
    const whose = (type: string | undefined) =>
      type === undefined ? 'every principal' : `an answer for a ${type}`;
    out.push({
      code: 'COOKIE_DRIFT',
      at,
      message: `Whose answer is owed this response's cookies differs: the contract says ${whose(expected.setCookiesWhen)} and the code says ${whose(actual.setCookiesWhen)}.`,
      expected: expected.setCookiesWhen ?? null,
      actual: actual.setCookiesWhen ?? null,
    });
  }
}

function compareSecurity(
  label: string,
  expected: OperationDescription,
  actual: OperationDescription,
  out: Finding[],
): void {
  const name = (alternative: readonly string[]) => alternative.join(' + ');
  const difference = setDifference(
    expected.security.alternatives.map(name),
    actual.security.alternatives.map(name),
  );
  if (difference.onlyContract.length > 0 || difference.onlyCode.length > 0) {
    out.push({
      code: 'SECURITY_DRIFT',
      at: `${label} > security`,
      message: describeSet('The ways to authenticate differ.', difference, 'the requirement'),
      expected: expected.security.alternatives.map((alternative) => [...alternative]),
      actual: actual.security.alternatives.map((alternative) => [...alternative]),
    });
  }

  // Only a scheme both sides use can be compared; one that only a side names is already reported above.
  for (const scheme of Object.keys(expected.security.schemes).filter(
    (candidate) => candidate in actual.security.schemes,
  )) {
    if (!same(expected.security.schemes[scheme], actual.security.schemes[scheme])) {
      out.push({
        code: 'SECURITY_DRIFT',
        at: `${label} > security > ${scheme}`,
        message: `The definition of the security scheme ${scheme} differs between the contract and the code.`,
        expected: expected.security.schemes[scheme] ?? null,
        actual: actual.security.schemes[scheme] ?? null,
      });
    }
  }
}

/**
 * Every way the code's description of one operation differs from the contract's: its route, its
 * parameters and headers, its request body, each response (success and error), the cookies a response
 * sets, how it authenticates, and the permission and error codes it states. All of them are reported;
 * none stops the others.
 */
export function compareOperations(
  expected: OperationDescription,
  actual: OperationDescription,
): Finding[] {
  const label = `${expected.method} ${expected.path}`;
  const out: Finding[] = [];

  if (expected.method !== actual.method || expected.path !== actual.path) {
    out.push({
      code: 'OPERATION_ROUTE_DRIFT',
      at: label,
      message: `The contract puts this operation at ${label} and the code puts it at ${actual.method} ${actual.path}.`,
    });
  }

  if (!same(expected.servers ?? null, actual.servers ?? null)) {
    const urls = (servers: OperationDescription['servers']) =>
      servers === undefined
        ? 'the servers of the document'
        : servers.map((server) => (server as { url: string }).url).join(', ');
    out.push({
      code: 'OPERATION_ROUTE_DRIFT',
      at: `${label} > servers`,
      message: `The contract serves this operation from ${urls(expected.servers)} and the code from ${urls(actual.servers)}.`,
      ...(expected.servers === undefined ? {} : { expected: [...expected.servers] }),
      ...(actual.servers === undefined ? {} : { actual: [...actual.servers] }),
    });
  }
  if (expected.deprecated !== actual.deprecated) {
    out.push({
      code: 'OPERATION_DRIFT',
      at: `${label} > deprecated`,
      message: `The operation is ${expected.deprecated ? 'deprecated' : 'not deprecated'} in the contract and ${actual.deprecated ? 'deprecated' : 'not deprecated'} in the code.`,
    });
  }

  compareParameters(label, expected, actual, out);

  if (expected.requestBody !== undefined || actual.requestBody !== undefined) {
    const at = `${label} > request body`;
    if (expected.requestBody === undefined || actual.requestBody === undefined) {
      out.push({
        code: 'REQUEST_BODY_DRIFT',
        at,
        message:
          expected.requestBody === undefined
            ? 'The code takes a request body and the contract does not.'
            : 'The contract takes a request body and the code does not.',
      });
    } else {
      if (expected.requestBody.required !== actual.requestBody.required) {
        out.push({
          code: 'REQUEST_BODY_DRIFT',
          at,
          message: `The request body is ${expected.requestBody.required ? 'required' : 'optional'} in the contract and ${actual.requestBody.required ? 'required' : 'optional'} in the code.`,
        });
      }
      compareContent(
        at,
        'REQUEST_BODY_DRIFT',
        expected.requestBody.content,
        actual.requestBody.content,
        out,
      );
    }
  }

  for (const status of union(
    Object.keys(expected.responses),
    Object.keys(actual.responses),
  ).toSorted(statusOrder)) {
    const contract = expected.responses[status];
    const code = actual.responses[status];
    const kind: FindingCode = isErrorStatus(status) ? 'ERROR_RESPONSE_DRIFT' : 'RESPONSE_DRIFT';
    if (contract !== undefined && code === undefined) {
      out.push({
        code: kind,
        at: `${label} > response ${status}`,
        message: `The contract answers ${status} and the code does not.`,
      });
    } else if (contract === undefined && code !== undefined) {
      out.push({
        code: kind,
        at: `${label} > response ${status}`,
        message: `The code answers ${status} and the contract does not.`,
      });
    } else if (contract !== undefined && code !== undefined) {
      compareResponse(label, status, contract, code, out);
    }
  }

  compareSecurity(label, expected, actual, out);

  if (expected.permission !== actual.permission) {
    out.push({
      code: 'EXTENSION_DRIFT',
      at: `${label} > x-permission`,
      message: `x-permission is ${show(expected.permission)} in the contract and ${show(actual.permission)} in the code.`,
    });
  }
  const errors = setDifference(expected.errorCodes, actual.errorCodes);
  if (errors.onlyContract.length > 0 || errors.onlyCode.length > 0) {
    out.push({
      code: 'EXTENSION_DRIFT',
      at: `${label} > x-error-codes`,
      message: describeSet('x-error-codes differs.', errors, 'the code'),
      expected: [...expected.errorCodes],
      actual: [...actual.errorCodes],
    });
  }

  compareUnmodelled(label, expected, actual, out);

  return out;
}
