// Pin the test clock near a fixed date using installClock, imported first by tests/setup.ts through tests/helpers/install-clock.ts.
// Many tests pass fixed October 2026 dates as now to runDueJobs or aggregates, while DB defaults such as jobs.run_at and llm_usage.created_at
// use defaultNow(), the actual clock (PGlite now() follows JavaScript Date.now()). After real time passes the fixed dates, queued jobs are not yet due
// and cost rows fall outside the test month, failing many tests (62 after 2026-10-05). Add a constant offset to real time for argumentless new Date() and Date.now()
// so the clock advances from the pinned date with elapsed real time instead of freezing. Leave new Date(x), Date.parse, Date.UTC and other explicit-date operations unchanged.
// PIN matches when tests were written, 2026-09-30, before midnight 2026-10-01. Preserve the original assumption that fixed test dates from 2026-10-01T00:00:00Z onward
// are later than database defaults, with enough margin as the clock advances during a run.
// Playwright E2E tests use real servers and do not use this clock.
export const PINNED_NOW = Date.parse("2026-09-30T12:00:00Z");

type G = typeof globalThis & { __tomolaClockInstalled?: boolean; __tomolaClockOffsetMs?: number };

// Current offset from wall time in milliseconds, 0 before installClock. Real PostgreSQL tests (pnpm test:pg) use it to shift DB now() equally (tests/helpers/pg-test.ts).
export function clockOffsetMs(): number {
  return (globalThis as G).__tomolaClockOffsetMs ?? 0;
}

export function installClock(): void {
  const g = globalThis as G;
  if (g.__tomolaClockInstalled) return;
  g.__tomolaClockInstalled = true;
  const RealDate = Date;
  const offset = PINNED_NOW - RealDate.now();
  g.__tomolaClockOffsetMs = offset;
  const shifted = () => RealDate.now() + offset;
  const Shifted = new Proxy(RealDate, {
    // new Date() without arguments uses shifted time; explicit arguments are unchanged.
    construct(target, args, newTarget) {
      return args.length === 0 ? Reflect.construct(target, [shifted()], newTarget) : Reflect.construct(target, args, newTarget);
    },
    // Date() without new returns the current-time string.
    apply() {
      return new RealDate(shifted()).toString();
    },
    get(target, prop) {
      if (prop === "now") return shifted;
      return Reflect.get(target, prop, target);
    },
  });
  // Preserve date.constructor === Date.
  Object.defineProperty(RealDate.prototype, "constructor", { value: Shifted, writable: true, configurable: true });
  globalThis.Date = Shifted as DateConstructor;
}

