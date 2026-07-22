// Tiny zero-dependency assertion helpers, standing in for jsr:@std/assert.
// This sandbox has no network access to jsr.io/deno.land/esm.sh (only npm
// is reachable), and Edge Functions themselves don't ship this file, it
// exists purely so mpesa-logic.test.ts can run with `deno test` right here.

export function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertEquals<T>(actual: T, expected: T, message?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(message ?? `Expected ${e} but got ${a}`);
  }
}

export function assertThrows(fn: () => unknown, message = 'Expected function to throw'): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(message);
}
