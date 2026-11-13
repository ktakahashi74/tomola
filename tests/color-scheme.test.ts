import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { profiles } from "~/lib/db/schema";
import { getSessionProfile } from "~/lib/auth/session.server";
import { memberColorScheme } from "~/lib/member-appearance.server";
import { getProfile, updatePreferences } from "~/lib/profiles.server";
import { buildMemberExport } from "~/lib/exports.server";
import { action as save } from "~/routes/settings-save";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("palette_member"); });
afterAll(() => h.restore());

const send = (colorScheme: string, as = "palette_member", headers = {}) => h.outcome(() => save(h.args(h.request("/settings/save", {
  as, headers, form: { intent: "preferences", field: "colorScheme", autosave: "1", colorScheme, readLangs: ["en"], homeArea: "en" },
}))));

it("saves and clears only appearance, reuses the request profile and exports the account preference", async () => {
  const original = await getProfile(h.db, h.ids.palette_member);
  expect(original?.colorScheme).toBeNull();
  for (const value of ["dark", "light", ""]) {
    const result = await send(value);
    expect(result.status).toBe(200);
    expect(await (result.value as Response).json()).toEqual({ ok: true, value });
    expect(await getProfile(h.db, h.ids.palette_member)).toEqual({ ...original, colorScheme: value || null });
    const request = h.request("/", { as: "palette_member" });
    await getSessionProfile(request);
    const select = vi.spyOn(h.db, "select");
    try {
      expect(await memberColorScheme(request)).toBe(value || null);
      expect(select).not.toHaveBeenCalled();
    } finally { select.mockRestore(); }
    expect((await buildMemberExport(h.db, h.ids.palette_member)).profile?.color_scheme).toBe(value || null);
  }
});

it("rejects unknown values, missing values, cross-origin writes and anonymous saves without changing the account", async () => {
  expect((await send("dark")).status).toBe(200);
  const original = await getProfile(h.db, h.ids.palette_member);
  for (const value of ["system", "sepia", "DARK", " light "]) expect((await send(value)).status).toBe(400);
  for (const value of [undefined, 1, {}, ["dark"]]) {
    expect(await updatePreferences(h.db, h.ids.palette_member, { colorScheme: value })).toEqual({ ok: false, error: "invalid_color_scheme" });
  }
  expect((await send("light", "palette_member", { origin: "https://outside.example" })).status).toBe(403);
  expect((await send("light", "")).status).toBe(302);
  expect(await getProfile(h.db, h.ids.palette_member)).toEqual(original);
});

it("does not look up guest sessions or apply member appearance to unfinished accounts", async () => {
  const select = vi.spyOn(h.db, "select");
  try {
    expect(await memberColorScheme(h.request("/"))).toBeNull();
    expect(select).not.toHaveBeenCalled();
  } finally { select.mockRestore(); }
  await h.signIn("palette_unfinished", { profile: false });
  expect(await memberColorScheme(h.request("/", { as: "palette_unfinished" }))).toBeNull();
});

it("enforces the allowed appearance values in the database too", async () => {
  await expect(h.db.update(profiles).set({ colorScheme: "sepia" }).where(eq(profiles.userId, h.ids.palette_member)))
    .rejects.toThrow();
  expect((await getProfile(h.db, h.ids.palette_member))?.colorScheme).toBe("dark");
});
