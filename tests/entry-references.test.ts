import { expect, it } from "vitest";
import { parseEntryReferences } from "~/lib/entry-references.server";

const base = "https://forum.example.org";
it("uses Markdown links, used definitions and autolinks, ignoring duplicate destinations and URL queries", async () => {
  expect((await parseEntryReferences([
    "[topic](/t/12?lang=ja&page=2&k=secret#p-12)",
    "[reply][ref] and [ref]",
    "[ref]: /t/13.md?page=2#c-20",
    "[unused]: /t/99",
    "<https://forum.example.org/t/14.txt>",
    "https://forum.example.org/t/15",
  ].join("\n\n"), base))).toEqual([
    { topicId: 12, entryId: 12, kind: "topic" }, { topicId: 13, entryId: 20, kind: "reply" },
    { topicId: 14, entryId: 14, kind: "topic" }, { topicId: 15, entryId: 15, kind: "topic" },
  ]);
});
it("excludes quotes, code, HTML, images and unused definitions but includes the same link outside a quote", async () => {
  const body = "> [quoted](/t/12)\n\n`[inline](/t/13)`\n\n```md\n[code](/t/14)\n```\n\n<a href=\"/t/15\">HTML</a>\n\n![image](/t/16)\n\n![ref][image]\n\n[image]: /t/17\n\n[unused]: /t/18\n\n[outside](/t/12)";
  expect((await parseEntryReferences(body, base))).toEqual([{ topicId: 12, entryId: 12, kind: "topic" }]);
});
it("uses the renderer's math syntax so formula literals are not links", async () => {
  expect((await parseEntryReferences("$[formula](/t/12)$\n\n$$\n[formula](/t/13)\n$$", base))).toEqual([]);
});
it.each([
  "https://other.example.org/t/12", "https://forum.example.org.evil.test/t/12", "http://forum.example.org/t/12",
  "https://forum.example.org:444/t/12", "https://user:password@forum.example.org/t/12", "//forum.example.org/t/12",
  "https://@forum.example.org/t/12",
  "t/12", "javascript:/t/12", "/t/0", "/t/-1", "/t/01", "/t/1.2", "/t/9007199254740992", "/t/12/#c-20",
  "/t/12#p-13", "/t/12#c-0", "/t/12#c-9007199254740992", "/t/12#unknown", "/t/12/related", "/t/12.json",
])("rejects an invalid or external target: %s", async url => {
  expect((await parseEntryReferences(`[link](<${url}>)`, base))).toEqual([]);
});
