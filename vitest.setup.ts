// ============================================================
// vitest.setup.ts — test environment repair.
//
// WHY THIS FILE EXISTS
// --------------------
// Node 25 ships a global `localStorage` (Web Storage) that is a bare object
// whose prototype chain goes straight to `Object.prototype`: it has NO
// getItem / setItem / removeItem / clear. Under vitest 1.6.1 the worker is
// started with `--localstorage-file` (passed by vitest itself, not by this
// repo), which switches Node's Web Storage globals ON. Those then shadow the
// working implementation jsdom would otherwise provide.
//
// Measured in this repo (vitest 1.6.1, jsdom env, Node v25.2.1):
//   window === globalThis            -> true
//   window.localStorage === globalThis.localStorage -> true
//   typeof localStorage.getItem      -> "undefined"
//   Object.getPrototypeOf(localStorage) === Object.prototype -> true
//
// So the shim cannot simply copy `window.localStorage` across — that IS the
// broken object. It has to install a working implementation.
//
// WHY IT MATTERS (this is not cosmetic)
// ------------------------------------
// 7 tests were failing in `beforeEach` on `localStorage.clear is not a
// function`, so their real assertions NEVER RAN — zero coverage presenting as
// coverage. Worse, every `localStorage` call inside src/ is wrapped in a
// silent `catch {}`:
//
//   src/content/index.ts:1003-1012   updateCache()      -> `catch { /* ignore */ }`
//   src/content/index.ts:959         earlyHideFromCache-> `catch { /* ... */ }`
//   src/content/index.ts:462         recoverStateFromCache -> `catch { /* fall through */ }`
//   src/content/preload.ts:103       cache read         -> `catch { /* ... */ }`
//
// which means the ENTIRE `_shh_cache` pre-paint layer — the mechanism that
// hides blocked results before first paint, and the whole degraded-mode state
// machine — was silently inert under test. That is precisely the code path
// where the show/hide intermittency lives, which is why it shipped.
//
// Restore it and those layers become testable again.
// ============================================================

/** Minimal spec-shaped in-memory Storage. */
function createMemoryStorage(): Storage {
  const map = new Map<string, string>();

  const api = {
    get length(): number {
      return map.size;
    },
    key(index: number): string | null {
      // Storage key() iterates in insertion order.
      const keys = Array.from(map.keys());
      return index >= 0 && index < keys.length ? (keys[index] as string) : null;
    },
    getItem(key: string): string | null {
      const v = map.get(String(key));
      return v === undefined ? null : v;
    },
    setItem(key: string, value: string): void {
      map.set(String(key), String(value));
    },
    removeItem(key: string): void {
      map.delete(String(key));
    },
    clear(): void {
      map.clear();
    },
  };

  return api as unknown as Storage;
}

/** True when `candidate` behaves like a real Storage (has the WebIDL methods). */
function isUsableStorage(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object") return false;
  const c = candidate as Record<string, unknown>;
  return (
    typeof c.getItem === "function" &&
    typeof c.setItem === "function" &&
    typeof c.removeItem === "function" &&
    typeof c.clear === "function"
  );
}

/**
 * Replace a global only when the existing one is unusable, so this stays a
 * no-op on Node versions / vitest versions where the real thing survives.
 */
function ensureStorage(name: "localStorage" | "sessionStorage"): void {
  const g = globalThis as unknown as Record<string, unknown>;

  if (isUsableStorage(g[name])) return;

  Object.defineProperty(globalThis, name, {
    value: createMemoryStorage(),
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

ensureStorage("localStorage");
ensureStorage("sessionStorage");
