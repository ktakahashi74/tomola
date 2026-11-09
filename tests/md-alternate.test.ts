import { expect, it } from "vitest";
import { listAlternateQuery } from "~/lib/md/alternate";

it("keeps the same page, language and supported filters without leaking transient controls", () => {
  expect(listAlternateQuery("?page=2&lang=ja&asks=1&long=1&order=activity&peek=7&stance_msg=chosen&k=secret"))
    .toBe("?lang=ja&asks=1&long=1&order=activity&page=2");
  expect(listAlternateQuery("?page=2&lang=ja&asks=1&long=1&order=created", { streamFilters: false }))
    .toBe("?lang=ja&asks=1&page=2");
});

it("omits default and malformed page values", () => {
  for (const page of ["1", "0", "-1", "1e2", "2.0", "10001", "999999999999999999", ""]) {
    expect(listAlternateQuery(`?page=${page}&lang=unknown&order=bad`)).toBe("");
  }
  expect(listAlternateQuery("?page=10000")).toBe("?page=10000");
});

it("carries Insightful ordering to the Markdown twin", () => {
  expect(listAlternateQuery("?order=insightful&page=2&lang=en")).toBe("?lang=en&order=insightful&page=2");
  expect(listAlternateQuery("?order=insightful", { streamFilters: false })).toBe("");
});

it("carries all posts only for the following collection and ignores old village paging", () => {
  expect(listAlternateQuery("?page=2&vpage=1", { streamFilters: false })).toBe("?page=2");
  expect(listAlternateQuery("?page=2", { streamFilters: false })).toBe("?page=2");
  expect(listAlternateQuery("?vpage=2&lang=en", { streamFilters: false })).toBe("?lang=en");
  expect(listAlternateQuery("?vpage=2&lang=en")).toBe("?lang=en");
  expect(listAlternateQuery("?vpage=10001", { streamFilters: false })).toBe("");
  expect(listAlternateQuery("?all=1&asks=1&lang=en&page=2", { streamFilters: false })).toBe("?lang=en&asks=1&all=1&page=2");
  expect(listAlternateQuery("?all=1")).toBe("");
});
