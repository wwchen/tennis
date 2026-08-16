import '@testing-library/jest-dom/vitest';

// Vitest 4's jsdom environment does not surface `localStorage` as a global,
// even though jsdom itself implements it — so anything exercising persistence
// sees `undefined` rather than a Storage. This installs a spec-shaped
// in-memory Storage once, before any test module loads.
//
// It is deliberately a real object rather than a mock: the persistence layer's
// contract is "whatever survives a reload", and a hand-rolled stub with only
// getItem/setItem would let a `key()`/`length` regression through.
class MemoryStorage implements Storage {
  #entries = new Map<string, string>();

  get length(): number {
    return this.#entries.size;
  }

  key(index: number): string | null {
    return [...this.#entries.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.#entries.get(String(key)) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#entries.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.#entries.delete(String(key));
  }

  clear(): void {
    this.#entries.clear();
  }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  if (typeof globalThis[name] === 'undefined') {
    Object.defineProperty(globalThis, name, {
      value: new MemoryStorage(),
      configurable: true,
      writable: true,
    });
  }
}
