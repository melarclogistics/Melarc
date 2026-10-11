import { isLoopbackHost, parseEndpoint, type ConfigKey } from './config-settings.js';

/** The delivery settings of a parsed environment: what the API and the delivery worker both read, by the same names. */
export interface DeliveryAdapterSettings {
  readonly APP_ENV: 'local' | 'staging' | 'production';
  readonly DELIVERY_EMAIL_ADAPTER: 'capture' | 'provider';
  readonly DELIVERY_EMAIL_ENDPOINT?: string | undefined;
  readonly DELIVERY_EMAIL_TIMEOUT_MS?: number | undefined;
  readonly DELIVERY_SMS_ADAPTER: 'capture' | 'provider';
  readonly DELIVERY_SMS_ENDPOINT?: string | undefined;
  readonly DELIVERY_SMS_TIMEOUT_MS?: number | undefined;
}

/** A provider or service endpoint: https, or plain http to a loopback host in a local run only. */
export function endpointNeedsHttps(
  text: string,
  appEnv: 'local' | 'staging' | 'production',
): boolean {
  const url = parseEndpoint(text);
  if (url === undefined) return true;
  return !(url.protocol === 'https:' || (appEnv === 'local' && isLoopbackHost(url)));
}

/**
 * The relations between the delivery settings of one channel and the next (SECURITY_DESIGN.md §13.9a): a real provider needs its
 * endpoint (https, or plain http to a loopback host in a local run) and its timeout, and the capture adapter has neither. Shared by
 * the API's loader and the delivery worker's, so that the two cannot disagree about what a channel's settings mean.
 *
 * **A local run, and CI, which runs as one, selects the capture adapter and nothing else** (SECURITY_DESIGN.md §13.9a; the owner's
 * decision of 11 October 2026, closing plan obligation OB-127): a real provider is refused there, whatever its endpoint, and there
 * is no local exception for a loopback stand-in. A real provider belongs to staging, inside the controlled window of
 * DEPLOYMENT_AND_ENVIRONMENTS.md §4.1, and to production. The composition judges the same rule again on the built configuration
 * (`adapterRefusals`, `WorkerConfig`'s refusals), so that a configuration made by hand meets it too.
 */
export function deliveryAdapterProblems(
  env: DeliveryAdapterSettings,
  invalid: (key: ConfigKey) => void,
  missing: (key: ConfigKey) => void,
): void {
  const channels = [
    [
      'EMAIL',
      env.DELIVERY_EMAIL_ADAPTER,
      env.DELIVERY_EMAIL_ENDPOINT,
      env.DELIVERY_EMAIL_TIMEOUT_MS,
    ],
    ['SMS', env.DELIVERY_SMS_ADAPTER, env.DELIVERY_SMS_ENDPOINT, env.DELIVERY_SMS_TIMEOUT_MS],
  ] as const;
  for (const [channel, adapter, endpoint, timeout] of channels) {
    const endpointKey = `DELIVERY_${channel}_ENDPOINT` as const;
    const timeoutKey = `DELIVERY_${channel}_TIMEOUT_MS` as const;
    if (adapter === 'provider' && env.APP_ENV === 'local') {
      invalid(`DELIVERY_${channel}_ADAPTER` as const);
    }
    if (adapter === 'provider') {
      if (endpoint === undefined) missing(endpointKey);
      else if (endpointNeedsHttps(endpoint, env.APP_ENV)) invalid(endpointKey);
      if (timeout === undefined) missing(timeoutKey);
    } else {
      if (endpoint !== undefined) invalid(endpointKey);
      if (timeout !== undefined) invalid(timeoutKey);
    }
  }
}
