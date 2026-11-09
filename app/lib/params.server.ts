import { data } from "react-router";
import { parsePageParam } from "~/lib/pagination";
import type { TopicOrder } from "~/lib/entries.server";

// Validate decimal-positive URL ids. Number() alone accepts "1e0", "0x1" and "1.0", so require decimal integer notation.
export function parseId(raw: string | undefined): number {
  const id = parseIdOrNull(raw);
  if (id === null) throw data("Not found", { status: 404 });
  return id;
}

// Same validation as parseId, returning null instead of throwing 404 because twins return text responses.
export function parseIdOrNull(raw: string | undefined): number | null {
  if (!raw || !/^[1-9]\d{0,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

// Convert service not_found/forbidden results to HTTP errors.
export function failure(error: "not_found" | "forbidden"): never {
  throw data(error === "forbidden" ? "Forbidden" : "Not found", { status: error === "forbidden" ? 403 : 404 });
}

// URL ?page=, default 1; invalid gives 404.
export function parsePage(request: Request): number {
  const page = parsePageParam(new URL(request.url).searchParams.get("page"));
  if (page === null) throw data("Not found", { status: 404 });
  return page;
}

// List ?asks=1: stance-asking question topics only.
export function parseAsks(request: Request): boolean {
  return new URL(request.url).searchParams.get("asks") === "1";
}

// List ?long=1: long posts, i.e. titled topics only.
export function parseLong(request: Request): boolean {
  return new URL(request.url).searchParams.get("long") === "1";
}

// Home ?follow=1: only the posts of the villages the member follows or has joined.
export function parseFollowing(request: Request): boolean {
  return new URL(request.url).searchParams.get("follow") === "1";
}

// List ?order=created|activity|insightful. Absent/empty uses caller-defined default (home:created); other values give 400.
export function parseOrderParam(raw: string | null): TopicOrder | null | "invalid" {
  if (raw === null || raw === "") return null;
  return raw === "created" || raw === "activity" || raw === "insightful" ? raw : "invalid";
}

export function parseOrder(request: Request, fallback: TopicOrder = "created"): TopicOrder {
  const parsed = parseOrderParam(new URL(request.url).searchParams.get("order"));
  if (parsed === "invalid") throw data("Bad request", { status: 400 });
  return parsed ?? fallback;
}
