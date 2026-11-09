// Import the fixed clock in tests/helpers/clock.ts before anything else; imports are evaluated in written order.
import "./helpers/install-clock";
import "./helpers/install-markdown";
import { afterAll } from "vitest";
import { closeHookDbs } from "./helpers/db";
import { closeAdminPool } from "./helpers/pg-test";

// Close test databases created outside tests, such as in beforeAll, at file teardown.
afterAll(async () => {
  await closeHookDbs();
  await closeAdminPool();
});
