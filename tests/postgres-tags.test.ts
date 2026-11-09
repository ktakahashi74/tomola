import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { missingPostgresTags } from "./helpers/postgres-tags";
it("detects PostgreSQL-only conditional tests missing their reporter tag", () => {
  expect(missingPostgresTags('describe.skipIf(!PG_MODE)("pg", () => {});')).toEqual([1]);
  expect(missingPostgresTags('it.runIf(REAL_PG_URL)("pg", () => {});')).toEqual([1]);
  expect(missingPostgresTags('describe.skipIf(!PG_MODE)("pg", { tags: ["postgres"] }, () => {});')).toEqual([]);
  expect(missingPostgresTags('// describe.skipIf(!PG_MODE)("comment", () => {});')).toEqual([]);
});
it("tags every PostgreSQL-only gate in the unit-test sources", () => {
  const root = path.join(process.cwd(), "tests");
  const missing = fs.readdirSync(root).filter(file => file.endsWith(".test.ts")).flatMap(file =>
    missingPostgresTags(fs.readFileSync(path.join(root, file), "utf8")).map(line => `${file}:${line}`));
  expect(missing).toEqual([]);
});
