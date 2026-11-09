import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("sanitizes an executable's database failure after connecting successfully", () => {
  // Inject only the DB adapter. Run the real invitation executable and its real
  // INSERT so this also detects a missing catch around post-connection work.
  const result = spawnSync(process.execPath, ["--import", "tsx", "--import", pathToFileURL(path.resolve("tests/helpers/cli-db-error.mjs")).href, "scripts/create-invite.ts", "private-cli-recipient@example.com"], {
    env: { PATH: process.env.PATH, NODE_ENV: "test", BETTER_AUTH_URL: "http://localhost:5173", GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "", SMTP_URL: "" }, encoding: "utf8", timeout: 15_000,
  });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("insert into invitations");
  expect(result.stderr).toContain("23505");
  expect(result.stderr).not.toContain("private-cli-recipient@example.com");
  expect(result.stderr).not.toContain("params:");
  expect(result.stderr).not.toContain("private database detail");
});
