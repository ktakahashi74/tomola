import { describe, expect, it } from "vitest";
import { user } from "~/lib/db/schema";
import { createProfile, getProfile, setDisplayLang } from "~/lib/profiles.server";
import type { Db } from "~/lib/db/client.server";
import { createTestDb } from "./helpers/db";

async function addUser(db: Db, id: string) {
  await db.insert(user).values({ id, name: "", email: `${id}@example.com`, emailVerified: true });
}

const valid = { handle: "hana", homeArea: "ja", readLangs: ["ja", "en"] };

describe("profiles", () => {
  it("creates and reads a profile", async () => {
    const db = await createTestDb();
    await addUser(db, "u1");
    const res = await createProfile(db, "u1", valid);
    const expected = { userId: "u1", handle: "hana", handleChangedAt: null, displayName: null, displayNameLatin: null, homeArea: "ja", readLangs: ["ja", "en"], displayLang: null, openInAiGeneration: 0, suspendedUntil: null, suspendedReason: null, suspendedActionId: null, reactionsExcludedAt: null, reactionsExcludedActionId: null, emailPref: "auto", uiLocale: null, colorScheme: null, signPosts: false, residenceCountry: null, adultConfirmedAt: null, trialConsentVersion: null, trialConsentAt: null, stanceConsentVersion: null, stanceConsentAt: null, introEntryId: null };
    // Null if the language area has never changed; the first change is always allowed.
    expect(res).toEqual({ ok: true, profile: { ...expected, homeAreaChangedAt: null } });
    const p = await getProfile(db, "u1");
    expect(p).toEqual({ ...expected, homeAreaChangedAt: null });
  });

  it("stores the display language separately from the read languages", async () => {
    const db = await createTestDb();
    await addUser(db, "u1");
    await createProfile(db, "u1", valid);
    await setDisplayLang(db, "u1", "th");
    expect((await getProfile(db, "u1"))?.displayLang).toBe("th");
    expect((await getProfile(db, "u1"))?.readLangs).toEqual(["ja", "en"]);
    await setDisplayLang(db, "u1", null);
    expect((await getProfile(db, "u1"))?.displayLang).toBeNull();
  });

  it("returns null when there is no profile", async () => {
    const db = await createTestDb();
    expect(await getProfile(db, "nobody")).toBeNull();
  });

  it("accepts an ASCII username and the other area", async () => {
    const db = await createTestDb();
    await addUser(db, "u2");
    const res = await createProfile(db, "u2", { ...valid, handle: "hana_other", homeArea: "other" });
    expect(res).toMatchObject({ ok: true, profile: { handle: "hana_other", homeArea: "other" } });
  });

  it("rejects invalid handles", async () => {
    const db = await createTestDb();
    await addUser(db, "u3");
    expect(await createProfile(db, "u3", { ...valid, handle: "a" })).toEqual({ ok: false, error: "invalid_handle" });
    expect(await createProfile(db, "u3", { ...valid, handle: "has space" })).toEqual({
      ok: false,
      error: "invalid_handle",
    });
  });

  it("accepts lowercase letters, digits, underscores and hyphens", async () => {
    const db = await createTestDb();
    for (const [i, handle] of ["hana-san", "hana_2026", "42hana"].entries()) {
      await addUser(db, `m${i}`);
      const res = await createProfile(db, `m${i}`, { ...valid, handle });
      expect(res).toMatchObject({ ok: true, profile: { handle } });
    }
  });

  it("normalizes width and case before storing and checking uniqueness", async () => {
    const db = await createTestDb();
    await addUser(db, "n1");
    await addUser(db, "n2");
    const first = await createProfile(db, "n1", { ...valid, handle: "Ｈａｎａ" });
    expect(first.ok && first.profile.handle).toBe("hana");
    expect((await getProfile(db, "n1"))?.handle).toBe("hana");
    expect(await createProfile(db, "n2", { ...valid, handle: "HANA" })).toEqual({ ok: false, error: "handle_taken" });
  });

  it("normalizes compatibility letters to an ASCII username", async () => {
    const db = await createTestDb();
    await addUser(db, "n3");
    const res = await createProfile(db, "n3", { ...valid, handle: "ℂat" });
    expect(res.ok).toBe(true);
    expect((await getProfile(db, "n3"))?.handle).toBe("cat");
  });

  it("rejects reserved usernames after normalizing width and case", async () => {
    const db = await createTestDb();
    await addUser(db, "reserved");
    for (const handle of ["admin", "ADMIN", "ａｄｍｉｎ"]) {
      expect(await createProfile(db, "reserved", { ...valid, handle })).toEqual({ ok: false, error: "handle_reserved" });
    }
    expect(await getProfile(db, "reserved")).toBeNull();
  });

  it("rejects invisible-letter and punctuation-only handles", async () => {
    const db = await createTestDb();
    await addUser(db, "i1");
    expect(await createProfile(db, "i1", { ...valid, handle: "\u3164\u3164" })).toEqual({
      ok: false,
      error: "invalid_handle",
    });
    expect(await createProfile(db, "i1", { ...valid, handle: "ha\u115Fna" })).toEqual({
      ok: false,
      error: "invalid_handle",
    });
    expect(await createProfile(db, "i1", { ...valid, handle: ".." })).toEqual({ ok: false, error: "invalid_handle" });
  });

  it("rejects invisible combining characters and stacked marks", async () => {
    const db = await createTestDb();
    await addUser(db, "v1");
    for (const handle of ["hana\uFE0F", "hana\u034F", "hana\u180B", "hana\u17B4", "hana\u{E0100}", "a" + "\u0301".repeat(5)]) {
      expect(await createProfile(db, "v1", { ...valid, handle }), JSON.stringify(handle)).toEqual({
        ok: false,
        error: "invalid_handle",
      });
    }
    expect(await getProfile(db, "v1")).toBeNull();
  });

  it("limits handle length to 30 characters and trims surrounding spaces", async () => {
    const db = await createTestDb();
    await addUser(db, "l1");
    expect(await createProfile(db, "l1", { ...valid, handle: "a".repeat(31) })).toEqual({
      ok: false,
      error: "invalid_handle",
    });
    const res = await createProfile(db, "l1", { ...valid, handle: "  hana  " });
    expect(res.ok && res.profile.handle).toBe("hana");
    expect((await getProfile(db, "l1"))?.handle).toBe("hana");
  });

  it("removes duplicate languages, keeping first-seen order", async () => {
    const db = await createTestDb();
    await addUser(db, "d1");
    const res = await createProfile(db, "d1", { ...valid, readLangs: ["ja", "ja", "en"] });
    expect(res.ok && res.profile.readLangs).toEqual(["ja", "en"]);
    expect((await getProfile(db, "d1"))?.readLangs).toEqual(["ja", "en"]);
  });

  it("does not report handle_taken when the user already has a profile", async () => {
    const db = await createTestDb();
    await addUser(db, "x1");
    expect((await createProfile(db, "x1", valid)).ok).toBe(true);
    const err = await createProfile(db, "x1", { ...valid, handle: "other" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeDefined();
    expect((err as { cause?: { constraint?: string } }).cause?.constraint).toBe("profiles_pkey");
  });

  it("accepts empty read languages and rejects unknown languages and areas", async () => {
    const db = await createTestDb();
    await addUser(db, "u4");
    expect(await createProfile(db, "u4", { ...valid, readLangs: ["es"] })).toEqual({
      ok: false,
      error: "invalid_langs",
    });
    expect(await createProfile(db, "u4", { ...valid, homeArea: "es" })).toEqual({ ok: false, error: "invalid_area" });
    expect(await createProfile(db, "u4", { ...valid, readLangs: [] })).toMatchObject({ ok: true, profile: { readLangs: [] } });
  });

  it("rejects a taken handle", async () => {
    const db = await createTestDb();
    await addUser(db, "u5");
    await addUser(db, "u6");
    await createProfile(db, "u5", valid);
    expect(await createProfile(db, "u6", valid)).toEqual({ ok: false, error: "handle_taken" });
  });
});
