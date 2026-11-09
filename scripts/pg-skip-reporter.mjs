import fs from "node:fs";
import { metadataText, relativeTestFile } from "./check-metadata.ts";

export const FAILURE_LIMIT = 200;

export default class PostgresSkipReporter {
  onInit(vitest) { this.root = vitest.config.root; }
  onTestRunEnd(modules) {
    if (!process.env.TOMOLA_CHECK_PG_REPORT) return;
    let postgresSkipped = 0;
    const unit = { failures: [], failureCount: 0, collectionFailures: [], collectionFailureCount: 0, files: [] };
    for (const module of modules) {
      const file = relativeTestFile(this.root ?? process.cwd(), module.moduleId);
      let skippedCount = 0, pendingCount = 0;
      for (const test of module.children.allTests()) {
        const status = test.result().state;
        if (test.tags.includes("postgres") && status === "skipped") postgresSkipped++;
        if (status === "skipped") skippedCount++;
        if (status === "pending") pendingCount++;
        if (status !== "failed") continue;
        unit.failureCount++;
        if (unit.failures.length < FAILURE_LIMIT) unit.failures.push({ file, title: metadataText(test.fullName, this.root), status, durationMs: test.diagnostic()?.duration ?? 0 });
      }
      if (module.errors().length) {
        unit.collectionFailureCount++;
        if (unit.collectionFailures.length < FAILURE_LIMIT) unit.collectionFailures.push({ file, status: "collection-failed", durationMs: module.diagnostic().duration ?? 0 });
      }
      unit.files.push({ file, status: module.state(), skippedCount, pendingCount });
    }
    fs.writeFileSync(process.env.TOMOLA_CHECK_PG_REPORT, JSON.stringify({ postgresSkipped, unit }));
  }
}
