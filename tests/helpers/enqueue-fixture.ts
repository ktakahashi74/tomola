import type { Db } from "~/lib/db/client.server";
import { enqueue, type EnqueueOptions } from "~/lib/jobs/queue.server";

// Queue mechanics and corrupt-row tests need synthetic kinds and payloads.
const enqueueRaw = enqueue as (db: Db, kind: string, payload: unknown, opts?: EnqueueOptions) => ReturnType<typeof enqueue>;

export function enqueueFixture(db: Db, kind: string, payload: unknown = {}, opts?: EnqueueOptions) {
  return enqueueRaw(db, kind, payload, opts);
}
