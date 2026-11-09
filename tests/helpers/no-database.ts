import { vi } from "vitest";
const refuse = vi.hoisted(() => () => { throw new Error("Fast tests must not open a database. Move this file out of tests/fast-files.ts and run it with the database configuration."); });
vi.mock("@electric-sql/pglite", async (original) => {
  const exports = await original<typeof import("@electric-sql/pglite")>();
  return { ...exports, PGlite: new Proxy(exports.PGlite, { construct: refuse, get(target, key, receiver) { return key === "create" ? refuse : Reflect.get(target, key, receiver); } }) };
});
vi.mock("pg", async (original) => {
  const exports = await original<typeof import("pg")>();
  const guarded = { ...exports.default, Pool: new Proxy(exports.default.Pool, { construct: refuse }), Client: new Proxy(exports.default.Client, { construct: refuse }) };
  return { ...exports, ...guarded, default: guarded };
});
