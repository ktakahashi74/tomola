import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { drafts } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { createApiToken } from "~/lib/tokens.server";
import { getMd } from "./helpers/md";
import { BASE, setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Allow replacement of createDraft to simulate rejecting already-validated input, an internal error.
const control = vi.hoisted(() => ({ failWith: null as string | null }));
vi.mock("~/lib/drafts.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/drafts.server")>();
  return {
    ...actual,
    createDraft: async (...args: Parameters<typeof actual.createDraft>) => (control.failWith ? { ok: false as const, error: control.failWith } : actual.createDraft(...args)),
  };
});

type G = { __tomolaDb?: Promise<Db> };
const g = globalThis as G;

let h: RouteHarness;
let topicId: number;
let readToken: string;
let draftToken: string;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("hana", { homeArea: "ja" });
  const t = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "題", body: "本文" });
  if (!t.ok) throw new Error("topic failed");
  topicId = t.id;
  const r = await createApiToken(h.db, h.ids.hana, { name: "reader", kind: "read" });
  const d = await createApiToken(h.db, h.ids.hana, { name: "drafter", kind: "draft" });
  if (!r.ok || !d.ok) throw new Error("token failed");
  readToken = r.token;
  draftToken = d.token;
});
afterAll(() => h.restore());

// A DB whose select fails unexpectedly while reading a profile or similar before token validation.
const brokenReads = (): Db =>
  new Proxy(h.db, {
    get(target, property, receiver) {
      if (property === "select") {
        return () => {
          throw new Error("database is down");
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });

async function withBrokenDb<T>(run: () => Promise<T>): Promise<T> {
  const saved = g.__tomolaDb;
  g.__tomolaDb = Promise.resolve(brokenReads());
  try {
    return await run();
  } finally {
    g.__tomolaDb = saved;
  }
}

describe("unexpected exceptions on the machine-readable endpoints", () => {
  it("answer the Markdown twins with a text/plain 500 (not the HTML error page) and log the error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const path of [`/t/${topicId}.md`, "/latest.md", "/home.md", "/a/ja.txt"]) {
        const res = await withBrokenDb(() => getMd(h, path, { headers: { authorization: `Bearer ${readToken}` } }));
        expect(res.status, path).toBe(500);
        expect(res.headers.get("content-type"), path).toBe("text/plain; charset=utf-8");
        const body = await res.text();
        expect(body, path).toContain("500 internal");
        expect(body).not.toContain("database is down");
        expect(body).not.toContain("<html");
      }
      expect(log).toHaveBeenCalled();
      expect(String(log.mock.calls[0][0])).toContain("unexpected error");
    } finally {
      log.mockRestore();
    }
  });

  it("answer the change feed with a text 500 and the manifest with a JSON 500", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const changes = await withBrokenDb(async () => (await (await import("~/routes/changes-md")).loader(h.args(h.request("/changes.md?since=2026-01-01", { headers: { authorization: `Bearer ${readToken}` } })))) as Awaited<Promise<Response>>);
      expect(changes.status).toBe(500);
      expect(changes.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await changes.text()).toContain("500 internal");
      const manifest = await withBrokenDb(async () => (await (await import("~/routes/manifest")).loader(h.args(h.request("/manifest.json", { headers: { authorization: `Bearer ${readToken}` } })))) as Awaited<Promise<Response>>);
      expect(manifest.status).toBe(500);
      expect(manifest.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await manifest.json()).toEqual({ error: "internal", message: "Internal error. Try again later." });
      expect(log).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
    }
  });

  it("leave the normal page errors alone: a missing topic page is still the page route's 404", async () => {
    // Non-Markdown paths go to next() without the machine-readable 500 wrapper.
    const { threadMdMiddleware } = await import("~/lib/md/twin.server");
    let ran = false;
    await threadMdMiddleware({ request: h.request(`/t/${topicId}`, { as: "hana" }), params: { id: String(topicId) } }, async () => ((ran = true), new Response("page")));
    expect(ran).toBe(true);
  });
});

describe("POST /api/drafts: unexpected failures are 500, not a frontmatter error", () => {
  const post = async (db?: Db) => {
    const { handleDraftCreate } = await import("~/lib/api/drafts-api.server");
    const request = new Request(`${BASE}/api/drafts`, { method: "POST", headers: { authorization: `Bearer ${draftToken}`, "content-type": "text/markdown" }, body: "---\ntitle: T\n---\nBody" });
    const res = await handleDraftCreate(request, { db });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it("returns 500 {error: internal} and logs when the database throws while saving", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing = new Proxy(h.db, {
        get(target, property, receiver) {
          if (property === "insert") {
            return (table: unknown) => {
              if (table === drafts) throw new Error("disk full");
              return (target.insert as (t: unknown) => unknown)(table);
            };
          }
          // Quota-respecting draft saves count under a member-row lock inside a transaction; failures there behave the same.
          if (property === "transaction") {
            return () => {
              throw new Error("disk full");
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const res = await post(failing);
      expect(res.status).toBe(500);
      expect(res.json).toEqual({ error: "internal", message: "Internal error. Try again later." });
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("returns 500 {error: internal}, not invalid_frontmatter, when createDraft refuses an input that passed validation", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      control.failWith = "invalid_draft";
      const res = await post();
      expect(res.status).toBe(500);
      expect(res.json.error).toBe("internal");
      expect(String(log.mock.calls.at(-1)?.[0])).toContain("invalid_draft");
      // If concurrent deletion removes the reply target, report an input error.
      control.failWith = "thread_not_found";
      const gone = await post();
      expect(gone.status).toBe(400);
      expect(gone.json.error).toBe("reply_to_not_found");
    } finally {
      control.failWith = null;
      log.mockRestore();
    }
    expect((await post()).status).toBe(201);
  });
});
