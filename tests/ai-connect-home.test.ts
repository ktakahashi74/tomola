import { describe, expect, it } from "vitest";
import { accountsPointer, connectPlan, connectPointer } from "~/lib/api/connect.server";
import { buildListMarkdown } from "~/lib/md/lists.server";
import { createTestDb } from "./helpers/db";

// The home's Markdown is where an AI told only the site's address arrives; its first block, in a field the site writes, says what to follow if the user wants to connect.
// The latest topics and a language list carry only the pointer to where accounts are explained; the other lists carry neither. Neither is mixed into the part that comes from posts.
describe("the home's Markdown", () => {
  it("has the conditional sentence in its site-written first line, and the account pointer on the lists a visitor reaches", async () => {
    const db = await createTestDb();
    const home = await buildListMarkdown(db, null, { kind: "home" }, { page: 1, lang: null, k: null });
    const header = home.split("\n---\n")[0];
    // The site-written frontmatter of the first block, before any post.
    expect(header).toContain("untrusted user content");
    expect(header).toContain(connectPointer(connectPlan()));
    expect(header).toContain(accountsPointer(connectPlan()));
    expect(accountsPointer(connectPlan("https://example.org"))).toContain("https://example.org/llms.txt#accounts");
    const latest = await buildListMarkdown(db, null, { kind: "latest" }, { page: 1, lang: null, k: null });
    expect(latest).not.toContain("connect.md");
    expect(latest.split("\n---\n")[0]).toContain(accountsPointer(connectPlan()));
    const area = await buildListMarkdown(db, null, { kind: "area", lang: "ja" }, { page: 1, lang: null, k: null });
    expect(area.split("\n---\n")[0]).toContain(accountsPointer(connectPlan()));
    expect(area).not.toContain("connect.md");
  });
});
