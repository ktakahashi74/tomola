import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { PG_MODE } from "./helpers/pg-test";
import { setupRouteHarness } from "./helpers/route-harness";
import { completeAccountDeletion, deleteAccount, requestAccountDeletion } from "~/lib/account-delete.server";
import { withCredentialSession } from "~/lib/auth/credential-session.server";
import { createApiToken } from "~/lib/tokens.server";
import { accountDeletions, apiTokens, entries, jobs, user } from "~/lib/db/schema";
import { SEND_ACCOUNT_DELETED_JOB } from "~/lib/jobs/mail-kinds";
import { addMember, createTestDb } from "./helpers/db";

it.skipIf(!PG_MODE)("prevents a request authenticated before deletion from minting credentials after its commit", { tags: ["postgres"] }, async () => {
  const h = await setupRouteHarness();
  const id = await h.signIn("quit_concurrent");
  const request = h.request("/settings/tokens", { as: "quit_concurrent", form: { intent: "create", name: "Stale request", kind: "read" } });
  let ready!: () => void, release!: () => void;
  const inside = new Promise<void>(r => { ready = r; }), gate = new Promise<void>(r => { release = r; });
  const deletion = deleteAccount(h.db, id, { confirmation: "quit_concurrent" }, { execute: mutate => h.db.transaction(async tx => {
    const result = await mutate(tx); ready(); await gate; return result;
  }) });
  await inside;
  const mint = h.outcome(() => withCredentialSession(h.db, id, request, "/settings/tokens", tx => createApiToken(tx, id, { name: "Stale request", kind: "read" })));
  try {
    await expect.poll(async () => {
      const { rows } = await h.db.execute(sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0`) as { rows: { waiting: number }[] };
      return rows[0].waiting;
    }).toBeGreaterThan(0);
  } finally { release(); }
  try {
    await deletion;
    expect((await mint).status).toBe(302);
    expect(await h.db.select().from(apiTokens).where(eq(apiTokens.userId, id))).toEqual([]);
  } finally { h.restore(); }
});

it.skipIf(!PG_MODE)("rejects an obsolete in-flight plan after a pending request is revised", { tags: ["postgres"] }, async () => {
  const db = await createTestDb();
  await addMember(db, "quit-revised", "quit_revised");
  const [post] = await db.insert(entries).values({ kind: "topic", authorId: "quit-revised", body: "Revised post choice", lang: "en" }).returning();
  const id = await requestAccountDeletion(db, "quit-revised", { confirmation: "quit_revised", posts: "keep" });
  let ready!: () => void, release!: () => void;
  const inside = new Promise<void>(r => { ready = r; }), gate = new Promise<void>(r => { release = r; });
  const obsolete = completeAccountDeletion(db, id, { execute: async mutate => { ready(); await gate; return db.transaction(mutate); } });
  const outcome = obsolete.then(() => null, error => error);
  await inside;
  try {
    expect(await requestAccountDeletion(db, "quit-revised", { confirmation: "quit_revised", posts: "delete" })).toBe(id);
  } finally { release(); }
  expect(await outcome).toMatchObject({ code: "invalid" });
  expect(await db.select().from(user).where(eq(user.id, "quit-revised"))).toHaveLength(1);
  expect((await db.select().from(entries).where(eq(entries.id, post.id)))[0].deletedAt).toBeNull();
  await completeAccountDeletion(db, id);
  expect((await db.select().from(entries).where(eq(entries.id, post.id)))[0].deletedAt).not.toBeNull();
  expect(await db.select().from(accountDeletions)).toMatchObject([{ id, state: "completed", posts: "delete" }]);
});

it.skipIf(!PG_MODE)("serializes two completion workers for a revised pending request", { tags: ["postgres"] }, async () => {
  const db = await createTestDb();
  await addMember(db, "quit-workers", "quit_workers");
  const id = await requestAccountDeletion(db, "quit-workers", { confirmation: "quit_workers", posts: "keep" });
  await requestAccountDeletion(db, "quit-workers", { confirmation: "quit_workers", posts: "delete" });
  let ready!: () => void, release!: () => void;
  const inside = new Promise<void>(r => { ready = r; }), gate = new Promise<void>(r => { release = r; });
  const first = completeAccountDeletion(db, id, { execute: mutate => db.transaction(async tx => {
    const result = await mutate(tx); ready(); await gate; return result;
  }) });
  await inside;
  const second = completeAccountDeletion(db, id);
  try {
    await expect.poll(async () => {
      const { rows } = await db.execute(sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0`) as { rows: { waiting: number }[] };
      return rows[0].waiting;
    }).toBeGreaterThan(0);
  } finally { release(); }
  expect(await Promise.all([first, second])).toEqual([{ ok: true, requestId: id }, { ok: true, requestId: id }]);
  expect(await db.select().from(accountDeletions)).toMatchObject([{ id, state: "completed", posts: "delete" }]);
  expect(await db.select().from(jobs).where(eq(jobs.kind, SEND_ACCOUNT_DELETED_JOB))).toHaveLength(1);
});

it.skipIf(!PG_MODE)("takes simultaneous native submissions and a repeated completed receipt to the same completion page",{tags:["postgres"]},async()=>{
 const h=await setupRouteHarness();
 try {
  const id=await h.signIn("quit_double");
  const {action}=await import("~/routes/settings-delete-account");
  const {accountDeletionKey}=await import("~/lib/account-delete.server");
  const form={intent:"delete-account",confirmation:"quit_double","completion-key":accountDeletionKey(id)};
  await h.db.execute(sql`create function hold_account_delete() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(937510); return old; end $$`);
  await h.db.execute(sql`create trigger hold_account_delete before delete on "user" for each row execute function hold_account_delete()`);
  let first!:Promise<Awaited<ReturnType<typeof h.outcome>>>,second!:typeof first;
  await h.db.transaction(async gate=>{
   await gate.execute(sql`select pg_advisory_xact_lock(937510)`);
   const send=()=>h.outcome(()=>action(h.args(h.request("/settings/delete-account",{as:"quit_double",form}))));
   first=send();
   const waiting=async()=>{
    const r=await h.db.execute(sql`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0`) as {rows:{n:number}[]};return r.rows[0].n;
   };
   await expect.poll(waiting).toBeGreaterThanOrEqual(1);second=send();await expect.poll(waiting).toBeGreaterThanOrEqual(2);
  });
  for(const result of await Promise.all([first,second])) expect(result).toMatchObject({status:302,location:"/login?account-deleted=1"});
  const repeated=await h.outcome(()=>action(h.args(h.request("/settings/delete-account",{as:"quit_double",form}))));
  expect(repeated).toMatchObject({status:302,location:"/login?account-deleted=1"});
 } finally {h.restore();}
});
