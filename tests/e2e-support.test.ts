import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPortFree, commandLineOf, isLeftoverServer, isProcessGroupLeader, removeStaleDirs } from "../e2e/support";

// Browser-test setup and cleanup helpers (e2e/support.ts): occupied-port detection and cleanup of previous-run leftovers.
const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      if (c.pid !== undefined) process.kill(c.pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const aliveNow = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const exited = async (pid: number) => {
  for (let i = 0; i < 50; i++) {
    // A zombie, killed but not waited on by its parent, has /proc state Z and is not considered alive.
    if (!aliveNow(pid) || (fs.existsSync(`/proc/${pid}/stat`) && fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z"))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
// A long-lived unrelated sleep process and an E2E-server lookalike with react-router in its command line.
const unrelated = () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  children.push(child);
  return child;
};
const fakeServer = (opts: { detached?: boolean } = {}) => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "react-router", "dev"], { stdio: "ignore", detached: opts.detached ?? false });
  children.push(child);
  return child;
};
const tmp = () => {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "e2e-support-"));
  dirs.push(d);
  return d;
};

describe("assertPortFree", () => {
  it("passes for a free port and says which port is in use otherwise", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      await expect(assertPortFree(port)).rejects.toThrow(new RegExp(`port ${port} is already in use`));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    await expect(assertPortFree(port)).resolves.toBeUndefined();
  });
});

describe("removeStaleDirs", () => {
  function make(root: string, name: string, files: Record<string, string> = {}) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
    return dir;
  }

  it("removes directories of runs that are gone, and leaves other names, kept ones and those of a live run", () => {
    const root = tmp();
    const stale = make(root, "e2e-aaa", { "owner.pid": "999999999" });
    const noPid = make(root, "e2e-bbb");
    const kept = make(root, "e2e-ccc", { "owner.pid": "999999999", ".keep": "" });
    const live = make(root, "e2e-ddd", { "owner.pid": String(process.ppid) });
    const other = make(root, "pglite");
    const removed = removeStaleDirs(root, "e2e-");
    expect(removed.sort()).toEqual(["e2e-aaa", "e2e-bbb"]);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(noPid)).toBe(false);
    for (const dir of [kept, live, other]) expect(fs.existsSync(dir)).toBe(true);
  });

  it("kills a leftover server of an earlier run, but never an unrelated process whose number was reused: it only removes the directory", async () => {
    const root = tmp();
    const bystander = unrelated();
    const server = fakeServer();
    await new Promise((r) => setTimeout(r, 200));
    const other = make(root, "e2e-eee", { "owner.pid": "999999999", "server.pid": String(bystander.pid) });
    const mine = make(root, "e2e-fff", { "owner.pid": "999999999", "server.pid": String(server.pid) });
    expect(removeStaleDirs(root, "e2e-").sort()).toEqual(["e2e-eee", "e2e-fff"]);
    expect(fs.existsSync(other)).toBe(false);
    expect(fs.existsSync(mine)).toBe(false);
    // Unrelated sleep survives; the E2E server stops.
    expect(aliveNow(bystander.pid!)).toBe(true);
    expect(await exited(server.pid!)).toBe(true);
  });

  it("kills the whole group of a leftover server only when that process leads its group, and only the process itself otherwise", async () => {
    const root = tmp();
    // A group leader started detached and a child in its group.
    const leader = fakeServer({ detached: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(isProcessGroupLeader(leader.pid!)).toBe(true);
    // The child remains in the leader's group but is not its leader; its command line resembles an E2E server.
    const member = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "react-router", "child"], { stdio: "ignore", detached: false });
    children.push(member);
    await new Promise((r) => setTimeout(r, 200));
    expect(isProcessGroupLeader(member.pid!)).toBe(false);
    make(root, "e2e-ggg", { "owner.pid": "999999999", "server.pid": String(member.pid) });
    removeStaleDirs(root, "e2e-");
    // Stop only the non-leader process, not its entire group, which would include this test process.
    expect(await exited(member.pid!)).toBe(true);
    expect(aliveNow(process.pid)).toBe(true);
    make(root, "e2e-hhh", { "owner.pid": "999999999", "server.pid": String(leader.pid) });
    removeStaleDirs(root, "e2e-");
    expect(await exited(leader.pid!)).toBe(true);
  });

  it("recognizes an e2e server by its command line (the work directory, server.ts or react-router), and nothing else", () => {
    const dir = "/repo/.data/e2e-abc";
    expect(commandLineOf(process.pid)).toContain("node");
    const sleeper = unrelated();
    expect(isLeftoverServer(sleeper.pid!, dir)).toBe(false);
    expect(isLeftoverServer(999999999, dir)).toBe(false);
    expect(commandLineOf(999999999)).toBeNull();
  });

  it("does nothing when the directory does not exist", () => {
    expect(removeStaleDirs(path.join(tmp(), "nope"), "e2e-")).toEqual([]);
  });
});

describe("fake translation hold", () => {
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  function runtime(root: string, overrides: Partial<typeof fs> = {}) {
    const hooks: { __tomolaFakeBeforeTranslate?: (request: { chat: boolean; text: string }) => Promise<void> } = {};
    const source = fs.readFileSync(new URL("../e2e/fake-translation-runtime.mjs", import.meta.url), "utf8").replace(/^import .*;$/gm, "");
    // A deleted file can become the native watcher's initial missing baseline,
    // producing no change event. Exercise the preload with that notification lost.
    new Function("fs", "path", "process", "globalThis", "setInterval", "clearInterval", source)(
      { ...fs, watchFile() {}, ...overrides }, path, { env: { E2E_SERVER_CLOCK: path.join(root, "clock.txt") } }, hooks, setInterval, clearInterval,
    );
    return hooks.__tomolaFakeBeforeTranslate!;
  }

  it("releases held work after deletion even when no file watcher notification arrives", async () => {
    vi.useFakeTimers();
    const root = tmp(), file = path.join(root, "fake-chat-translation-hold");
    fs.writeFileSync(file, "A held message");
    let finished = false;
    const pending = runtime(root)({ chat: true, text: "A held message" }).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(50);
    expect(finished).toBe(false);
    fs.rmSync(file);
    await vi.advanceTimersByTimeAsync(50);
    expect(finished).toBe(true);
    await pending;
  });

  it.each(["ENOENT", "EACCES"])("handles a hold-file read failure (%s) without hiding other errors", async code => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "fake-chat-translation-hold"), "A held message");
    const error = Object.assign(new Error("hold-file read failed"), { code });
    const pending = runtime(root, { readFileSync: (() => { throw error; }) as typeof fs.readFileSync })({ chat: true, text: "A held message" });
    if (code === "ENOENT") await expect(pending).resolves.toBeUndefined();
    else await expect(pending).rejects.toBe(error);
  });
});
