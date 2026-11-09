import { describe, expect, it } from "vitest";
import { isWorkerEnabled } from "~/lib/jobs/worker.server";
import { describeBackground, workerDisabledByEnv } from "../server/background.ts";
import { HSTS } from "~/lib/http/security-headers.server";
import { STATIC_HSTS, staticSecurityHeaders } from "../server/static-headers.ts";

// Startup logs (server/background.ts) must distinguish why the worker is not running.
describe("describeBackground (the start-up log about the job worker)", () => {
  const worker = { stop: async () => {} };

  it("says the worker is running when it is", () => {
    expect(describeBackground({ hasStarter: true, worker, env: {} })).toEqual({ level: "info", message: "the job worker is running in this process" });
  });

  it("blames WORKER_ENABLED=false only when it is false", () => {
    for (const value of ["false", "FALSE", " 0 ", "no", "off"]) {
      const status = describeBackground({ hasStarter: true, worker: null, env: { WORKER_ENABLED: value } });
      expect(status.level).toBe("info");
      expect(status.message).toBe("the job worker is not running in this process (WORKER_ENABLED=false)");
    }
  });

  it("warns, without blaming WORKER_ENABLED=false, when the build has no startBackgroundServices", () => {
    const status = describeBackground({ hasStarter: false, worker: null, env: {} });
    expect(status.level).toBe("warn");
    expect(status.message).toContain("no startBackgroundServices");
    expect(status.message).not.toContain("WORKER_ENABLED=false");
    // Even with WORKER_ENABLED=false, report the missing startup function first.
    expect(describeBackground({ hasStarter: false, worker: null, env: { WORKER_ENABLED: "false" } }).message).toContain("no startBackgroundServices");
  });

  it("warns, without blaming WORKER_ENABLED=false, when the worker failed to start although it is enabled", () => {
    for (const env of [{}, { WORKER_ENABLED: "true" }, { WORKER_ENABLED: "" }]) {
      const status = describeBackground({ hasStarter: true, worker: null, env });
      expect(status.level).toBe("warn");
      expect(status.message).toContain("failed to start");
      expect(status.message).not.toContain("(WORKER_ENABLED=false)");
    }
  });

  it("reads WORKER_ENABLED the way the worker does", () => {
    for (const value of [undefined, "", "true", "1", "yes", "on", "false", "FALSE", " false ", "0", "no", "off", "nope", "disabled"]) {
      const env = value === undefined ? {} : { WORKER_ENABLED: value };
      expect(workerDisabledByEnv(env), String(value)).toBe(!isWorkerEnabled(env));
    }
  });
});

// Static-file headers (server/static-headers.ts): add HSTS in production using the same predicate as the app.
describe("staticSecurityHeaders", () => {
  it("adds HSTS and nosniff outside development and test, whatever the NODE_ENV is called (the app's predicate)", () => {
    for (const NODE_ENV of ["production", "staging", "preview", "", undefined]) {
      expect(staticSecurityHeaders({ NODE_ENV }), String(NODE_ENV)).toEqual({ "X-Content-Type-Options": "nosniff", "Strict-Transport-Security": STATIC_HSTS });
    }
    expect(STATIC_HSTS).toBe(HSTS);
  });

  it("sends only nosniff in development and test, and never a CSP or the other document headers", () => {
    for (const NODE_ENV of ["development", "test"]) expect(staticSecurityHeaders({ NODE_ENV })).toEqual({ "X-Content-Type-Options": "nosniff" });
    for (const NODE_ENV of ["production", "development"]) {
      const names = Object.keys(staticSecurityHeaders({ NODE_ENV }));
      for (const absent of ["Content-Security-Policy", "Referrer-Policy", "Permissions-Policy"]) expect(names).not.toContain(absent);
    }
  });
});
