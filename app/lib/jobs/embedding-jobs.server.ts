import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "~/lib/db/client.server";
import { EMBEDDING_DIM, entries, entryEmbeddings } from "~/lib/db/schema";
import { embeddingInput } from "~/lib/embeddings.server";
import { embed, jobLlmOptions, resolveEmbeddingEngine, type LlmOptions } from "~/lib/llm/index.server";
import { LlmError } from "~/lib/llm/errors.server";
import { entryStillCurrent } from "./translation-jobs.server";
import type { JobContext, JobHandler, JobHandlers, JobRow } from "./queue.server";

// embed_entry embeds the current source revision of an undeleted, unhidden entry and saves entry_embeddings.
// - Do nothing if this model's current-revision row already exists, covering retries/backfill overlaps.
// - On stopped budget, throw BudgetPausedError (DeferJob); keep queued without failure until budget recovers.
// - Save after locking the entry with FOR SHARE and rechecking revision, deletion, and hidden state, like translation saves.
//   Edits/deletion/hiding during embedding cannot leave embeddings of stale or undisplayable content.

const payloadSchema = z.object({ entryId: z.number().int().positive(), sourceHash: z.string().min(1) });

function parsePayload(job: JobRow): z.infer<typeof payloadSchema> {
  const parsed = payloadSchema.safeParse(job.payload);
  if (!parsed.success) throw new Error(`Invalid ${job.kind} payload: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

export type EmbeddingJobDeps = { llm?: LlmOptions };

export function createEmbeddingHandlers(deps: EmbeddingJobDeps = {}): JobHandlers {
  const llm = (ctx: JobContext): LlmOptions => jobLlmOptions(ctx, deps.llm);

  const embedEntry: JobHandler = async (job, ctx) => {
    const { db } = ctx;
    const p = parsePayload(job);
    const [entry] = await db
      .select({ id: entries.id, title: entries.title, body: entries.body, sourceHash: entries.sourceHash, deletedAt: entries.deletedAt, hiddenAt: entries.hiddenAt })
      .from(entries)
      .where(eq(entries.id, p.entryId));
    if (!entry || entry.deletedAt || entry.hiddenAt || entry.sourceHash !== p.sourceHash) return;
    const options = llm(ctx);
    // Choose the engine here, matching embed's engine when determining the model saved.
    const engine = options.embeddingEngine ?? resolveEmbeddingEngine(options.env);
    if (await alreadyEmbedded(db, entry.id, engine.model, p.sourceHash)) return;
    const out = await embed(db, { ...embeddingInput(entry), task: "document" }, { ...options, embeddingEngine: engine });
    if (out.vector.length !== EMBEDDING_DIM || out.model !== engine.model) throw new LlmError("invalid_output", `embedding has ${out.vector.length} values (expected ${EMBEDDING_DIM})`);
    await db.transaction(async (tx) => {
      if (!(await entryStillCurrent(tx, entry.id, p.sourceHash))) return;
      const values = { model: out.model, dim: EMBEDDING_DIM, embedding: out.vector, sourceHash: p.sourceHash, createdAt: ctx.now };
      await tx
        .insert(entryEmbeddings)
        .values({ entryId: entry.id, ...values })
        .onConflictDoUpdate({ target: [entryEmbeddings.entryId, entryEmbeddings.model], set: values });
    });
  };

  return { embed_entry: embedEntry };
}

async function alreadyEmbedded(db: Db, entryId: number, model: string, sourceHash: string): Promise<boolean> {
  const [row] = await db
    .select({ sourceHash: entryEmbeddings.sourceHash })
    .from(entryEmbeddings)
    .where(and(eq(entryEmbeddings.entryId, entryId), eq(entryEmbeddings.model, model)));
  return row?.sourceHash === sourceHash;
}
