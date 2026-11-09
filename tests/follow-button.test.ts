import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { FollowButton } from "~/components/follow-button";

const fetcher = vi.hoisted(() => ({ Form: "form", formData: undefined as FormData | undefined, data: undefined as { ok: true; threadId: number; state: "following" | "unfollowed" } | undefined }));
vi.mock("react-router", () => ({ useFetcher: () => fetcher }));
afterEach(() => { fetcher.data = undefined; fetcher.formData = undefined; });
const render = () => renderToStaticMarkup(createElement(FollowButton, { threadId: 2, state: null, returnTo: "/t/2" }));

it("ignores a completed response retained from another topic after navigation", () => {
  fetcher.data = { ok: true, threadId: 1, state: "following" };
  expect(render()).toContain('name="follow" value="1"');
  fetcher.data.threadId = 2;
  expect(render()).toContain('name="follow" value="0"');
});

it("ignores an in-flight action of the previous topic but shows the optimistic state for this topic", () => {
  fetcher.formData = new FormData();
  fetcher.formData.set("threadId", "1");
  fetcher.formData.set("follow", "1");
  expect(render()).toContain('name="follow" value="1"');
  fetcher.formData.set("threadId", "2");
  expect(render()).toContain('name="follow" value="0"');
});
