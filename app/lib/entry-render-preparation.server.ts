import { withMarkdownScope } from "./markdown-budget.server";
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import type { SavedMentionBinding } from "./db/schema";
import { bindMentionSpellings, targetsForBindings } from "./mentions.server";
import { renderEntryHtml } from "./entries.server";
import type { RenderedEntry } from "./markdown.server";

type Input = { kind: "topic" | "reply"; body: string; lang: string; id?: number; previous?: readonly SavedMentionBinding[] };
export type PreparedEntryRender = Input & { id: number; bindings: SavedMentionBinding[]; targets: Awaited<ReturnType<typeof targetsForBindings>>; rendered: RenderedEntry };
const preparation = new AsyncLocalStorage<{ render: PreparedEntryRender; consumed: boolean }>();

// A sequence reservation holds no row lock or connection during worker admission.
// Unused ids after validation failure are ordinary PostgreSQL sequence gaps.
export async function prepareEntryRender(db: Db, input: Input): Promise<PreparedEntryRender> {
  const bindings = await bindMentionSpellings(db, input.body, input.previous);
  const mentions = await targetsForBindings(db, bindings);
  const id = input.id ?? Number((await db.execute(sql`select nextval(pg_get_serial_sequence('entries', 'id')) as id`) as { rows: { id: string | number }[] }).rows[0].id);
  const rendered = await renderEntryHtml(input.kind, id, input.body, input.lang, mentions);
  return { ...input, id, bindings, targets: mentions, rendered };
}
function pendingEntryRender(input: Pick<Input, "kind" | "id">) {
  const ready = preparation.getStore();
  return ready && !ready.consumed && ready.render.kind === input.kind && (input.id === undefined || input.id === ready.render.id) ? ready : undefined;
}
export async function withEntryRender<T>(db: Db, input: Input, run: () => Promise<T>, member?: string): Promise<T> {
  if (pendingEntryRender(input)) return run();
  return withMarkdownScope("write", member, async () => preparation.run({ render: await prepareEntryRender(db, input), consumed: false }, run));
}
export function sameMentionRender(prepared: PreparedEntryRender, bindings: readonly SavedMentionBinding[], targets: PreparedEntryRender["targets"]): boolean {
  // jsonb can change object key order without changing the saved binding.
  return isDeepStrictEqual(prepared.bindings, bindings) && isDeepStrictEqual(prepared.targets, targets);
}

export async function renderEntryForWrite(prepared: PreparedEntryRender, input: Input & { id: number }, bindings: readonly SavedMentionBinding[], mentions: PreparedEntryRender["targets"]): Promise<RenderedEntry> {
  if (prepared.id === input.id && prepared.kind === input.kind && prepared.body === input.body && prepared.lang === input.lang && sameMentionRender(prepared, bindings, mentions)) return prepared.rendered;
  // A concurrent write can change the source language or mention bindings.
  // Only this exceptional path renders under the write lock, using its snapshot.
  return renderEntryHtml(input.kind, input.id, input.body, input.lang, mentions);
}

// An outer signing/draft transaction may observe a newer draft than preparation.
// Reuse its reserved id once for the same kind, but discard stale render caches.
// Timers and other callbacks retain the scope after the original write completes.
export function activeEntryRender(input: Pick<Input, "kind" | "id">): PreparedEntryRender | undefined {
  const ready = pendingEntryRender(input);
  if (!ready) return undefined;
  ready.consumed = true;
  return ready.render;
}
