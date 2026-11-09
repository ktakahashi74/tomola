import { noPreloadSmoke } from "./support/no-preload-smoke";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FullConfig } from "@playwright/test";
import { cleanupOnSignals, removeStaleDirs } from "../e2e/support";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "../tests/helpers/pg-real";
import { startFakeSmtp } from "./support/fake-smtp";
import { freePort, makeSelfSignedCert, startTlsProxy } from "./support/tls-proxy";

// Setup and cleanup for browser tests of a production build with production settings (playwright.prod.config.ts).
// 1. pnpm build (skip if E2E_PROD_SKIP_BUILD=1).
// 2. Database: temporary PGlite by default. With E2E_PROD_PG=1 and TEST_DATABASE_URL, create a disposable PostgreSQL database and
// run pnpm db:migrate, the same migration procedure as production.
// 3. A fake SMTP server appends received mail to a file; node server.ts runs with NODE_ENV=production and real startup checks, allowing fake engines via TOMOLA_ALLOW_FAKE_ENGINES=1;
// a self-signed TLS proxy sits in front (BETTER_AUTH_URL must use https).
// 4. On completion, send SIGTERM, check graceful shutdown (exit code 0 and stopped in the log), then clean up.
// Choose free ports (E2E_PROD_PORT can pin one, with a clear error if occupied). Signal interruption also stops the server and removes the directory.
export type ProdState = {
  dir: string;
  baseURL: string;
  serverLog: string;
  mailFile: string;
  invites: Record<string, string>;
  usePostgres: boolean;
  noPreload: Awaited<ReturnType<typeof noPreloadSmoke>>;
};

const EMAILS = ["boss@example.com", "mika@example.com", "pat@example.com", "kai@example.com", "reading_type@example.com", "editor_default_prod@example.com", "media_prod@example.com", "language_fallback_prod@example.com"];

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, what: string): string {
  const res = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`${what} failed (exit ${res.status}):\n${res.stdout}\n${res.stderr}`);
  return res.stdout;
}

export default async function globalSetup(config: FullConfig) {
  const root = config.configFile ? path.dirname(config.configFile) : process.cwd();
  const dataRoot = process.env.E2E_PROD_DATA_ROOT ?? process.env.E2E_DATA_ROOT ?? path.join(root, ".data");
  fs.mkdirSync(dataRoot, { recursive: true });
  // Clean directories left by previous runs, such as forced termination. E2E_KEEP directories have .keep and are retained. No port check is needed because free ports are chosen.
  removeStaleDirs(dataRoot, "e2e-");
  const dir = fs.mkdtempSync(path.join(dataRoot, "e2e-prod-"));
  fs.writeFileSync(path.join(dir, "owner.pid"), String(process.pid));
  const serverLog = path.join(dir, "server.log");
  const mailFile = path.join(dir, "mails.jsonl");
  fs.writeFileSync(mailFile, "");

  let server: ChildProcess | undefined;
  let proxy: { close(): Promise<void> } | undefined;
  let smtp: { port: number; close(): Promise<void> } | undefined;
  let scratch: ScratchDb | undefined;
  let cleaned = false;

  const killServer = () => {
    if (server?.pid !== undefined && server.exitCode === null && server.signalCode === null) {
      try {
        process.kill(server.pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    }
  };
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    killServer();
    await proxy?.close().catch(() => {});
    await smtp?.close().catch(() => {});
    await scratch?.drop().catch(() => {});
    if (!process.env.E2E_KEEP) fs.rmSync(dir, { recursive: true, force: true });
    else {
      fs.writeFileSync(path.join(dir, ".keep"), "");
      console.log(`e2e-prod data kept in ${dir}`);
    }
  };
  // On Ctrl-C (SIGINT) or kill (SIGTERM), stop the server, remove the directory, then terminate with the same signal.
  const releaseSignals = cleanupOnSignals(cleanup);
  process.once("exit", killServer);

  try {
    if (!process.env.E2E_PROD_SKIP_BUILD) run("pnpm", ["build"], process.env, root, "pnpm build");

    const usePostgres = process.env.E2E_PROD_PG === "1";
    if (usePostgres && !REAL_PG_URL) throw new Error("E2E_PROD_PG=1 needs TEST_DATABASE_URL (a postgres:// URL that may create databases)");
    const appPort = process.env.E2E_PROD_APP_PORT ? Number(process.env.E2E_PROD_APP_PORT) : await freePort();
    const tlsPort = process.env.E2E_PROD_PORT ? Number(process.env.E2E_PROD_PORT) : await freePort();
    const baseURL = `https://localhost:${tlsPort}`;

    smtp = await startFakeSmtp({ port: process.env.E2E_PROD_SMTP_PORT ? Number(process.env.E2E_PROD_SMTP_PORT) : undefined, outFile: mailFile });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR || path.join(root, "tests/fixtures/operator"),
      VILLAGES: "",
      NODE_ENV: "production",
      PORT: String(appPort),
      HOST: "127.0.0.1",
      BETTER_AUTH_SECRET: randomBytes(24).toString("hex"),
      BETTER_AUTH_URL: baseURL,
      E2E_SEED_DIR: dir,
      SMTP_URL: `smtp://127.0.0.1:${smtp.port}`,
      MAIL_FROM: "tomola <no-reply@localhost>",
      MAIL_DECOY_TO: "decoy@example.invalid",
      // Fake engines only: no keys or network calls. Production startup checks refuse to start unless this is explicitly enabled.
      TOMOLA_ALLOW_FAKE_ENGINES: "1",
      GEMINI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      TRANSLATION_PRIMARY: "",
      TRANSLATION_SECONDARY: "none",
      DIVERGENCE_JUDGE: "none",
      EMBEDDING_ENGINE: "",
      OPERATOR_EMAILS: "boss@example.com",
      // The enabled languages (production needs them explicitly). The startup check refuses fr and Chinese until a native speaker has checked their interface strings,
      // so the tests run with ja,en.
      ENABLED_LANGS: "ja,en",
      WORKER_ENABLED: "true",
      NOTIFICATION_EMAIL_DELAY_SECONDS: "1",
      TRUSTED_PROXY_HOPS: "1",
    };
    delete env.DATABASE_URL;
    delete env.PGLITE_DATA_DIR;
    if (usePostgres) {
      scratch = await createScratchDb({ migrate: false });
      env.DATABASE_URL = scratch.url;
      run("pnpm", ["db:migrate"], env, root, "pnpm db:migrate");
    } else {
      env.PGLITE_DATA_DIR = path.join(dir, "pglite");
    }
    const invites = run("pnpm", ["exec", "tsx", "e2e-prod/seed.ts", ...EMAILS], env, root, "e2e-prod/seed.ts").trim().split("\n").slice(-EMAILS.length);

    const noPreload = await noPreloadSmoke(root, env, dir, appPort);
    console.log(`Production without preload: ${noPreload.durationMs} ms`);
    const out = fs.openSync(serverLog, "a");
    server = spawn("node", ["--import", path.join(root, "e2e/markdown-runtime.mjs"), "server.ts"], { cwd: root, env, stdio: ["ignore", out, out] });
    if (server.pid !== undefined) fs.writeFileSync(path.join(dir, "server.pid"), String(server.pid));
    let starting = true;
    const exited = new Promise<never>((_, reject) =>
      server!.once("exit", (code) => {
        if (starting) reject(new Error(`the server exited early (code ${code}):\n${fs.readFileSync(serverLog, "utf8")}`));
      }),
    );
    const healthy = (async () => {
      const deadline = Date.now() + 120_000;
      for (;;) {
        try {
          const res = await fetch(`http://127.0.0.1:${appPort}/healthz`, { signal: AbortSignal.timeout(5_000) });
          if (res.ok) return;
        } catch {
          // Not ready yet.
        }
        if (Date.now() > deadline) throw new Error(`the server did not start:\n${fs.readFileSync(serverLog, "utf8")}`);
        await new Promise((r) => setTimeout(r, 300));
      }
    })();
    try {
      await Promise.race([healthy, exited]);
    } finally {
      starting = false;
    }

    const { key, cert } = makeSelfSignedCert(dir);
    proxy = await startTlsProxy({ port: tlsPort, targetPort: appPort, key, cert });

    const state: ProdState = { noPreload, dir, baseURL, serverLog, mailFile, invites: Object.fromEntries(EMAILS.map((e, i) => [e, invites[i]])), usePostgres };
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
    process.env.E2E_PROD_STATE = path.join(dir, "state.json");
  } catch (error) {
    releaseSignals();
    await cleanup();
    throw error;
  }

  return async () => {
    releaseSignals();
    // Verify graceful shutdown: SIGTERM must stop the server with exit code 0 within the timeout.
    const stopped = new Promise<number | null>((resolve) => {
      if (!server || server.exitCode !== null || server.signalCode !== null) return resolve(server?.exitCode ?? null);
      server.once("exit", (code) => resolve(code));
    });
    server?.kill("SIGTERM");
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 30_000));
    const result = await Promise.race([stopped, timeout]);
    const log = fs.existsSync(serverLog) ? fs.readFileSync(serverLog, "utf8") : "";
    await cleanup();
    if (result !== 0) throw new Error(`the production server did not stop cleanly on SIGTERM (${result}):\n${log}`);
    if (!/\[server\] stopped/.test(log)) throw new Error(`the production server's log does not say it stopped:\n${log}`);
  };
}
