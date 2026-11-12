/** The methods of an act: a call that can change something. A read (`GET`, `HEAD`, `OPTIONS`, `TRACE`) is not observed. */
export type ActMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** What an observer is told of an act the API answered with success: the method and the path **as the call named it** (`/pickup-requests/{id}/confirm`, never an address with an identifier in it). */
export interface ActAnswer {
  readonly method: ActMethod;
  readonly path: string;
}

type Verb = (
  ...args: never[]
) => Promise<{ readonly response: Response; readonly error?: unknown }>;

const ACT_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];
const isActMethod = (method: unknown): method is ActMethod =>
  typeof method === 'string' && ACT_METHODS.includes(method);

/**
 * The client, telling `onAct` each time one of its acts (a call that can change something) is answered with success. It is how the portal
 * learns, in **one place**, that something it did may have changed what a queue holds, without a page having to say so: the answer is judged
 * here and nowhere else (D11 of the Product Owner's decisions of 6 November 2026; `queue-changing-acts.ts` says which acts matter).
 *
 * It wraps the client the session boundary has scoped (any client whose verbs are `GET`, `POST` and so on, and `request`; it names no transport, so the browser transport is imported where it was), so an answer to a request sent for a session that has since ended is a
 * `StaleSessionError` that never reaches it (a late success of a gone session is not an act of this one), and a call that fails or is refused
 * is not told. It changes nothing about the call: the same arguments, the same result, the same failures. **A fault in the observer is not the
 * act's failure**: an act that was done must never read as one that was not (it would be tried again), so what the observer throws is dropped.
 */
export function observeActs<Client extends object>(
  client: Client,
  onAct: (answer: ActAnswer) => void,
): Client {
  const original = client as unknown as Record<string, Verb>;
  const observed: Record<string, Verb> = {};
  for (const name of Object.keys(original)) {
    const verb = original[name];
    if (verb === undefined) continue;
    observed[name] = async (...args: never[]) => {
      const result = await verb(...args);
      if (!result.response.ok) return result;
      // `request(method, path, init)` names the method first; every other verb is its own method and names the path first.
      const method: unknown = name === 'request' ? args[0] : name;
      const path: unknown = args[name === 'request' ? 1 : 0];
      if (isActMethod(method) && typeof path === 'string') {
        try {
          onAct({ method, path });
        } catch {
          // The act was done; what the portal does about it next is not part of it.
        }
      }
      return result;
    };
  }
  return Object.freeze(observed) as unknown as Client;
}
