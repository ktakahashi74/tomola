import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { checkDraftIssues } from "~/lib/draft-issues.server";
import { DRAFT_ISSUES_NOTICE, MAX_DRAFT_ISSUES } from "~/lib/draft-issues";
import { mediaPath, MEDIA_LIMITS } from "~/lib/media";
import { putMedia } from "~/lib/media-store.server";
import { createTopic } from "~/lib/entries.server";
import { MENTION_NOTIFY_LIMIT } from "~/lib/mention-notifications";
import * as markdownBudget from "~/lib/markdown-budget.server";
import { addMember, createTestDb } from "./helpers/db";

let db: Db;
let ownImage: string;
let privateImage: string;
let publicImage: string;
const english = "This is a place for people to share their ideas and to learn from each other.";
const inspect = (body: string, title: string | null = null, lang = "en") => checkDraftIssues(db, { kind: "topic", body, title, lang, authorId: "writer" });

beforeAll(async () => {
  db = await createTestDb();
  await addMember(db, "writer", "writer");
  for (let i = 0; i <= MENTION_NOTIFY_LIMIT; i++) await addMember(db, `reader${i}`, `reader${i}`);
  ownImage = (await putMedia(db, "writer", { bytes: Buffer.from("own"), width: 10, height: 10 })).url;
  privateImage = (await putMedia(db, "reader0", { bytes: Buffer.from("private"), width: 10, height: 10 })).url;
  publicImage = (await putMedia(db, "reader0", { bytes: Buffer.from("public"), width: 10, height: 10 })).url;
  expect((await createTopic(db, "reader0", { lang: "en", body: `![public](${publicImage})` })).ok).toBe(true);
});

describe("draft diagnostics from publishing rules", () => {
  it("reports unresolved mentions at their body line, respecting prefixes, quotes and Markdown exclusions", async () => {
    const result = await inspect("@reader0-san @writer\n\n@missing\n\n> @quoted\n\n`@code` [@link](https://example.org) \\@escaped &#64;entity");
    expect(result.issues).toMatchObject([{ kind: "unknown_mention", location: { field: "body", line: 3 }, excerpt: "@missing" }]);
    expect(result.issuesNotice).toBe(DRAFT_ISSUES_NOTICE);
    expect((await inspect("> @missing\n\n@reader0")).issues).toEqual([]);
    expect((await inspect("＠missing")).issues).toMatchObject([{ kind: "unknown_mention", excerpt: "＠missing" }]);
    expect((await inspect("Plain text without mentions")).issues).toEqual([]);
  });

  it("marks unexpected diagnostic failures as unavailable instead of a clean check", async () => {
    const failure = new Error("Diagnostic failure");
    const task = vi.spyOn(markdownBudget, "markdownTask").mockRejectedValue(failure);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await inspect("Plain draft")).toEqual({ issues: [], issuesTruncated: false, issuesUnavailable: true });
      expect(logged).toHaveBeenCalledWith("[draft-issues] Diagnostics unavailable", failure);
    } finally { task.mockRestore(); logged.mockRestore(); }
  });

  it("reports members beyond the shared notification quota, excluding quotes and oneself", async () => {
    const body = "> @quoted\n\n@writer " + Array.from({ length: MENTION_NOTIFY_LIMIT + 1 }, (_, i) => `@reader${i}`).join(" ");
    expect((await inspect(body)).issues).toMatchObject([{ kind: "unknown_mention", excerpt: `@reader${MENTION_NOTIFY_LIMIT}`, location: { field: "body", line: 3 } }]);
    // A target first seen in a quote and later called retains matchMentions' publication order.
    const quotedFirst = body.replace("@quoted", `@reader${MENTION_NOTIFY_LIMIT}`);
    expect((await inspect(quotedFirst)).issues).toMatchObject([{ kind: "unknown_mention", excerpt: `@reader${MENTION_NOTIFY_LIMIT - 1}` }]);
  });

  it("observes removed destinations and external images, including references and dangerous schemes", async () => {
    const result = await inspect("[ordinary](https://example.org)\n\n[bad](javascript:alert)\n\n![external][picture]\n\n[picture]: https://example.org/a.webp\n\n![data](data:image/png;base64,abc)");
    expect(result.issues.map(issue => [issue.kind, issue.location])).toEqual([
      ["link_removed", { field: "body", line: 3 }], ["image_not_rendered", { field: "body", line: 5 }], ["image_not_rendered", { field: "body", line: 9 }],
    ]);
    expect((await inspect("`[bad](javascript:alert)`\n\n[ordinary](https://example.org)")).issues).toEqual([]);
  });

  it("allows available managed images and warns about unserved uploads and excess images", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://tomola.example");
    expect((await inspect(`![own](${ownImage}) ![public](${publicImage}) ![absolute](https://tomola.example${ownImage})`)).issues).toEqual([]);
    for (const path of [privateImage, mediaPath("a".repeat(64), 10, 10), ownImage.replace("10x10", "11x10")]) {
      expect((await inspect(`![unavailable](${path})`)).issues).toMatchObject([{ kind: "image_not_rendered", location: { field: "body", line: 1 } }]);
    }
    const inactiveAvatar = await putMedia(db, "writer", { bytes: Buffer.from("avatar"), width: 10, height: 10 }, { avatar: true });
    expect((await inspect(`![avatar](${inactiveAvatar.url})`)).issues).toMatchObject([{ kind: "image_not_rendered" }]);
    expect((await inspect(Array.from({ length: MEDIA_LIMITS.perPost + 1 }, () => `![own](${ownImage})`).join("\n"))).issues).toMatchObject([{ kind: "image_not_rendered", location: { field: "body", line: MEDIA_LIMITS.perPost + 1 } }]);
  });

  it("reports Unicode review candidates in titles and body lines without treating ordinary format characters as issues", async () => {
    const result = await inspect("ordinary\n\nformat \u2066text", "title \u202e");
    expect(result.issues.map(issue => [issue.kind, issue.location])).toEqual([["unicode_review", { field: "title" }], ["unicode_review", { field: "body", line: 3 }]]);
    expect((await inspect("emoji 👩‍💻 word\u200bbreak", "plain")).issues).toEqual([]);
    expect((await inspect(`tag ${String.fromCodePoint(0xe0061)}`)).issues[0].kind).toBe("unicode_review");
  });

  it("reports language mismatches only for conclusive prose", async () => {
    const first = await inspect(english, null, "ja");
    expect(first.issues).toMatchObject([{ kind: "lang_mismatch", location: { field: "body", line: 1 } }]);
    expect(await inspect(english, null, "ja")).toEqual(first);
    expect((await inspect(english)).issues).toEqual([]);
    expect((await inspect("OK", null, "ja")).issues).toEqual([]);
  });

  it("bounds issues and Unicode excerpts and distinguishes exact capacity from truncation", async () => {
    for (const [count, truncated] of [[MAX_DRAFT_ISSUES, false], [MAX_DRAFT_ISSUES + 1, true]] as const) {
      const result = await inspect(Array.from({ length: count }, (_, i) => `@missing${i}`).join("\n"));
      expect(result.issues).toHaveLength(MAX_DRAFT_ISSUES);
      expect(result.issuesTruncated).toBe(truncated);
    }
    const result = await inspect(`[${"😀".repeat(100)}](javascript:alert)`);
    expect(Array.from(result.issues[0].excerpt)).toHaveLength(80);
  });
});
