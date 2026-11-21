import { afterEach, expect, it, vi } from "vitest";
import { createReply, createTopic, listTopics, type TopicScope } from "~/lib/entries.server";
import { listIntroductions } from "~/lib/introductions.server";
import { loadMemberPageContent, resolveMemberPage } from "~/lib/member-pages.server";
import { listObjections } from "~/lib/objections.server";
import { listRelatedDiscussions } from "~/lib/related-discussions.server";
import { readReadingRequest, readingHref, type ReadingPage } from "~/lib/reading-page";
import { personalVillage } from "~/lib/personal-villages.server";
import { setMemberFollow } from "~/lib/member-follows.server";
import { ensureLanguageVillages } from "~/lib/villages.server";
import { addMember, createTestDb } from "./helpers/db";

afterEach(() => vi.unstubAllEnvs());
const request = (order = "created", query = "", param = "list") => readReadingRequest(new Request(`http://localhost/${query}`), order, 1, param);
const next = (page: ReadingPage) => readingHref("?lang=en&long=1", page, true);
const must = <T extends { ok: boolean }>(value: T): Extract<T, { ok: true }> => { if (!value.ok) throw new Error(JSON.stringify(value)); return value as Extract<T, { ok: true }>; };

it("keeps village and following-home scopes and both member sections independent", async () => {
  vi.stubEnv("VILLAGES", "1");
  const db = await createTestDb();
  await ensureLanguageVillages(db);
  await addMember(db, "section-author", "section_author", { homeArea: "en" });
  await addMember(db, "section-reader", "section_reader", { homeArea: "en" });
  const personal = (await personalVillage(db, "section-author"))!;
  const own: number[] = [], elsewhere: number[] = [];
  for (let i = 0; i < 31; i++) {
    own.push(must(await createTopic(db, "section-author", { lang: "en", title: `Own ${i}`, body: "Own fixture" })).id);
    elsewhere.push(must(await createTopic(db, "section-author", { lang: "en", title: `Elsewhere ${i}`, body: "Elsewhere fixture", village: "en" })).id);
  }
  expect((await setMemberFollow(db, "section-reader", "section-author", true)).ok).toBe(true);
  for (const order of ["created", "activity", "insightful"] as const) for (const scope of [
    { kind: "village", villageId: personal.id },
    { kind: "following-home", userId: "section-reader" },
  ] satisfies TopicScope[]) {
    const first = await listTopics(db, scope, { order, titledOnly: true, reading: request(order) });
    const second = await listTopics(db, scope, { order, titledOnly: true, reading: request(order, next(first.list!)) });
    const expected = await listTopics(db, scope, { order, titledOnly: true, limit: 100 });
    const third = second.hasNext ? await listTopics(db, scope, { order, titledOnly: true, reading: request(order, next(second.list!)) }) : { topics: [] };
    expect([...first.topics, ...second.topics, ...third.topics].map(topic => topic.id)).toEqual(expected.topics.map(topic => topic.id));
  }
  const member = (await resolveMemberPage(db, "section_author"))!;
  const opts = { page: 1, viewerId: "section-reader", readLangs: ["en"] as const, displayLang: "en" as const };
  const first = await loadMemberPageContent(db, member, { ...opts, reading: request(), personalReading: request("created", "", "vlist") });
  expect(first.topics.map(topic => topic.id)).toEqual([...elsewhere].reverse().slice(0, 30));
  expect(first.personal!.topics.map(topic => topic.id)).toEqual([...own].reverse().slice(0, 30));
  const second = await loadMemberPageContent(db, member, { ...opts, reading: request("created", next(first.list!)), personalReading: request("created", next(first.personal!.list!), "vlist") });
  expect(second.topics.map(topic => topic.id)).toEqual(elsewhere.slice(0, 1));
  expect(second.personal!.topics.map(topic => topic.id)).toEqual(own.slice(0, 1));
  expect(second.list!.next).toBeNull();
  expect(second.personal!.list!.next).toBeNull();
});

it("seeks through introductions at tied timestamps instead of repeating the first batch", async () => {
  const db = await createTestDb(), ids: number[] = [];
  for (let i = 0; i < 31; i++) {
    const author = `intro_cursor_${i}`;
    await addMember(db, author, author, { homeArea: "en" });
    ids.push(must(await createTopic(db, author, { lang: "en", title: `Introduction ${i}`, body: "Introduction fixture" }, { asIntroduction: true, now: new Date("2026-01-01T00:00:00Z") })).id);
  }
  const first = await listIntroductions(db, { reading: request() });
  const second = await listIntroductions(db, { reading: request("created", next(first.list!)) });
  expect([...first.topics, ...second.topics].map(topic => topic.id)).toEqual([...ids].reverse());
  expect(second.list!.next).toBeNull();
});

it("seeks grouped related discussions and independently pages alternative questions and objections", async () => {
  const db = await createTestDb();
  await addMember(db, "adjacent-author", "adjacent_author", { homeArea: "en" });
  const hub = must(await createTopic(db, "adjacent-author", { lang: "en", title: "Hub", body: "Question", asksStance: true })).id;
  for (let i = 0; i < 31; i++) {
    must(await createTopic(db, "adjacent-author", { lang: "en", title: `Alternative ${i}`, body: `[Hub](/t/${hub})`, asksStance: true, altOf: hub }));
    must(await createReply(db, "adjacent-author", hub, { lang: "en", body: `Objection ${i}`, stanceTag: "objection" }));
  }
  const display = { readLangs: ["en"] as const, displayLang: "en" as const };
  const first = await listRelatedDiscussions(db, hub, { ...display, reading: request("related") });
  const second = await listRelatedDiscussions(db, hub, { ...display, reading: request("related", next(first.list!)) });
  expect(first.rows).toHaveLength(30);
  expect(second.rows).toHaveLength(1);
  expect(new Set([...first.rows, ...second.rows].map(row => row.id)).size).toBe(31);
  const initial = await listObjections(db, hub, { ...display, page: 1, reading: request(), objectionReading: request("created", "", "vlist") });
  const continued = await listObjections(db, hub, { ...display, page: 1, reading: request("created", next(initial.alternativesList!.list)), objectionReading: request("created", next(initial.objectionsList!.list), "vlist") });
  for (const key of ["alternativesList", "objectionsList"] as const) {
    expect(initial[key]!.topics).toHaveLength(30);
    expect(continued[key]!.topics).toHaveLength(1);
    expect(new Set([...initial[key]!.topics, ...continued[key]!.topics].map(row => row.id)).size).toBe(31);
    expect(continued[key]!.list.next).toBeNull();
  }
});

it("retains grouped related ordering when several targets share the same source", async () => {
  const db = await createTestDb();
  await addMember(db, "reference-author", "reference_author", { homeArea: "en" });
  const hub = must(await createTopic(db, "reference-author", { lang: "en", title: "Reference hub", body: "Hub" })).id;
  const targets: number[] = [];
  for (let i = 0; i < 31; i++) targets.push(must(await createTopic(db, "reference-author", { lang: "en", title: `Target ${i}`, body: "Target" })).id);
  // Reply targets reverse the relationship between target-entry and topic IDs.
  const replies: number[] = [];
  for (const id of [...targets].reverse()) replies.push(must(await createReply(db, "reference-author", id, { lang: "en", body: "Target reply" })).id);
  must(await createReply(db, "reference-author", hub, { lang: "en", body: replies.map((id, index) => `[ref](/t/${[...targets].reverse()[index]}#c-${id})`).join(" ") }));
  const display = { readLangs: ["en"] as const, displayLang: "en" as const };
  const first = await listRelatedDiscussions(db, hub, { ...display, reading: request("related") });
  const second = await listRelatedDiscussions(db, hub, { ...display, reading: request("related", next(first.list!)) });
  expect([...first.rows, ...second.rows].map(row => row.id)).toEqual([...targets].reverse());
  expect(second.list!.next).toBeNull();
});
