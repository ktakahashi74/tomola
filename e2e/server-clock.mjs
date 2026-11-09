import fs from "node:fs";

// Test-server preload only. Advance server time without exposing a fixture API
// or opening a second process against the same PGlite directory.
const file = process.env.E2E_SERVER_CLOCK;
if (file) {
  const RealDate = Date;
  const now = () => RealDate.now() + Number(fs.readFileSync(file, "utf8"));
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length ? args : [now()], newTarget);
    },
    apply() { return new RealDate(now()).toString(); },
    get(target, key) { return key === "now" ? now : Reflect.get(target, key, target); },
  });
}
