import type { JsonObject } from '../platform/contract/json.js';

export type JsonPath = readonly (string | number)[];

type Container = Record<string | number, unknown>;

/**
 * An editable copy of a JSON document, for tests that change one thing in a document and expect the
 * change to be noticed. A path that is not there is a mistake in the test and not something to work
 * around, so every operation throws on one.
 */
export class JsonEditor {
  readonly document: JsonObject;

  constructor(source: JsonObject) {
    this.document = structuredClone(source);
  }

  private parentOf(path: JsonPath): { parent: Container; key: string | number } {
    const key = path.at(-1);
    if (key === undefined) throw new Error('A path needs at least one step.');
    let node: unknown = this.document;
    for (const step of path.slice(0, -1)) {
      if (typeof node !== 'object' || node === null) {
        throw new Error(`Nothing at ${path.join(' > ')}`);
      }
      node = (node as Container)[step];
    }
    if (typeof node !== 'object' || node === null) {
      throw new Error(`Nothing at ${path.join(' > ')}`);
    }
    return { parent: node as Container, key };
  }

  /** What is at the path. The caller says what it expects it to be. */
  get(path: JsonPath): unknown {
    const { parent, key } = this.parentOf(path);
    if (!(key in parent)) throw new Error(`Nothing at ${path.join(' > ')}`);
    return parent[key];
  }

  /** Sets a value; the container it goes in has to exist, the value need not. */
  set(path: JsonPath, value: unknown): void {
    const { parent, key } = this.parentOf(path);
    parent[key] = value;
  }

  remove(path: JsonPath): void {
    const { parent, key } = this.parentOf(path);
    if (!(key in parent)) throw new Error(`Nothing at ${path.join(' > ')}`);
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else Reflect.deleteProperty(parent, key);
  }

  update<T>(path: JsonPath, change: (current: T) => T): void {
    this.set(path, change(this.get(path) as T));
  }

  push(path: JsonPath, ...values: unknown[]): void {
    (this.get(path) as unknown[]).push(...values);
  }
}
