import type { StackConnection } from '../connection.ts';
import { Inbox } from '../messages.ts';
import { ADMINISTRATORS, type Person } from '../personas.ts';
import type { Authenticator } from '../totp.ts';
import type { VendorBrowser } from './vendor-browser.ts';

/**
 * Who the journeys of one run have made, and what each of them holds. The journeys of S0.46 are one story told in order: the two
 * bootstrap administrators first, then the people they create, approve and reset. A journey is a test, a test gets a browser of its own,
 * and nothing is stored in a browser (the Ops Portal keeps nothing in web storage), so what carries from one journey to the next is
 * here, in the memory of the worker that runs them, and it is keyed by the run's database so that a second run never reads the first's.
 *
 * A password is a constant of the run, chosen here and never generated: these accounts exist in a database that is dropped when the
 * run ends, and a failure is easier to read with a password you can see in the source than with one you cannot. It protects nothing real.
 */
export interface PersonState {
  readonly person: Person;
  password: string;
  /** The person's authenticator app, once they have set one up. */
  authenticator?: Authenticator;
  /** The identifier the API gave the profile, once a journey has read it. */
  id?: string;
}

/** The demonstration vendor once its journey has set it up: what its people know, and the one browser it signs in from. */
export interface VendorState {
  readonly identifier: string;
  readonly accountId: string;
  secret: string;
  browser: VendorBrowser;
}

export interface World {
  readonly inbox: Inbox;
  readonly people: Map<string, PersonState>;
  person(key: string): PersonState;
  /** Set by the vendor's first journey (rows 10a and 11), and continued by the next (rows 10b, 13 and 15). */
  vendor?: VendorState;
}

const worlds = new Map<string, World>();

/** The password of a person of the journeys: 12 to 128 characters, spaces allowed, nothing else required (AC-SLICE-000-87). */
const passwordOf = (key: string) => `${key} walks the long way home 2026`;

export function worldOf(stack: StackConnection): World {
  const existing = worlds.get(stack.database.name);
  if (existing !== undefined) return existing;
  if (stack.captureDirectory === undefined) {
    throw new Error('The journeys need the stack of the journeys: it has no capture folder.');
  }
  const people = new Map<string, PersonState>();
  ADMINISTRATORS.forEach((person, at) => {
    people.set(at === 0 ? 'ada' : 'bola', {
      person,
      password: passwordOf(at === 0 ? 'ada' : 'bola'),
    });
  });
  const world: World = {
    inbox: new Inbox(stack.captureDirectory),
    people,
    person(key) {
      const found = people.get(key);
      if (found === undefined) throw new Error(`The journeys have not made ${key} yet.`);
      return found;
    },
  };
  worlds.set(stack.database.name, world);
  return world;
}

/** A person a journey is about to make: their name, address and password are fixed by the key. */
export function introduce(world: World, key: string, fullName: string): PersonState {
  const state: PersonState = {
    person: { fullName, workEmail: `${key}@melarc.example` },
    password: passwordOf(key),
  };
  world.people.set(key, state);
  return state;
}
