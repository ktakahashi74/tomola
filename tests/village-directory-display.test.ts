import { createElement } from "react";
import { expect, it, vi } from "vitest";
import Villages from "~/routes/villages";
import { renderInRouter } from "./helpers/render-in-router";
import { m } from "~/paraglide/messages.js";
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
const villages = [
  { slug: "en", language: "en", name: null, description: "", kind: "open", joined: true },
  { slug: "joined-club", language: null, name: "Joined club", description: "", kind: "open", joined: true },
  { slug: "ja", language: "ja", name: null, description: "", kind: "open", joined: false },
  { slug: "another-club", language: null, name: "Another club", description: "", kind: "open", joined: false },
];
it("lists joined villages first and the rest under one heading, villages people made before language villages, without duplicate destinations", async () => {
  const html = await renderInRouter(() => createElement(Villages, { loaderData: { member: true, invites: [], villages } } as never));
  const joined = html.indexOf(m.villages_joined_heading());
  const others = html.indexOf(m.villages_others_heading());
  expect(joined).toBeGreaterThan(0); expect(others).toBeGreaterThan(joined);
  expect(html.indexOf('href="/v/joined-club"')).toBeLessThan(html.indexOf('href="/v/en"'));
  expect(html.indexOf('href="/v/en"')).toBeLessThan(others);
  expect(html.indexOf('href="/v/joined-club"')).toBeLessThan(others);
  expect(html.indexOf('href="/v/another-club"')).toBeGreaterThan(others);
  expect(html.indexOf('href="/v/another-club"')).toBeLessThan(html.indexOf('href="/v/ja"'));
  for (const village of villages) expect(html.split(`href="/v/${village.slug}"`)).toHaveLength(2);
});
it("puts human villages before language villages for guests, under the heading of the screen alone and without membership controls", async () => {
  const html = await renderInRouter(() => createElement(Villages, { loaderData: { member: false, invites: [], villages: villages.map(({ joined, ...village }) => village) } } as never));
  expect(html).not.toContain(`>${m.villages_joined_heading()}</h2>`);
  expect(html).not.toContain(`>${m.villages_others_heading()}</h2>`);
  expect(html.indexOf('href="/v/another-club"')).toBeLessThan(html.indexOf('href="/v/ja"'));
  expect(html).not.toContain('href="/villages/new"');
});
it("describes a language village by the sentence an operator wrote, and by nothing when only its name would be repeated", async () => {
  const written = "A sentence an operator wrote for this village.";
  const html = await renderInRouter(() => createElement(Villages, { loaderData: { member: false, invites: [], villages: villages.map(({ joined, ...village }) => village.slug === "ja" ? { ...village, description: written } : village) } } as never));
  expect(html).toContain(written);
  // The made-up description of the other language village (none written) is not drawn: the name says it.
  const language = (await import("~/lib/village-description")).villageDescription({ language: "en", description: "" });
  expect(language).not.toBe("");
  expect(html).not.toContain(language);
});
it("puts the way to make a village on the row of the first heading", async () => {
  const html = await renderInRouter(() => createElement(Villages, { loaderData: { member: true, invites: [], villages } } as never));
  const heading = html.indexOf(`>${m.villages_joined_heading()}</h2>`);
  const create = html.indexOf('href="/villages/new"');
  expect(heading).toBeGreaterThan(0);
  expect(create).toBeGreaterThan(heading);
  expect(create).toBeLessThan(html.indexOf('href="/v/joined-club"'));
});
