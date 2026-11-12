import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { createHash } from "node:crypto";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { signingCredential, type TestSigningCredential } from "./helpers/signing";
import { createTopic } from "~/lib/entries.server";
import { createDraft, updateDraft } from "~/lib/drafts.server";
import { drafts, entries, memberSignatures, passkey, profiles, signingChallenges } from "~/lib/db/schema";
import { canonicalSigningJson, issueSignedWrite, previewSignedWrite, signingViewToken, withSignedWrite } from "~/lib/signing.server";
import { buildMemberExport } from "~/lib/exports.server";

let h: RouteHarness; let credential: TestSigningCredential; let other: TestSigningCredential;
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("hana"); await h.signIn("kim"); await h.db.update(profiles).set({ signPosts: true }).where(eq(profiles.userId, h.ids.hana)); credential = await signingCredential(h.db, h.ids.hana); other = await signingCredential(h.db, h.ids.kim); });
afterAll(() => h.restore());
const formFor = (body = "Accepted text") => { const f = new FormData(); f.set("body", body); f.set("lang", "ja"); return f; };
async function issue(form: FormData, path = "/t/new") { const preview = await previewSignedWrite(h.db, h.ids.hana, path, form); return issueSignedWrite(h.db, h.ids.hana, path, form, preview.payloadHash); }
function signed(form: FormData, options: Awaited<ReturnType<typeof issue>>, key = credential, uv = true) { form.set("signatureChallenge", options.challenge); form.set("signatureAssertion", JSON.stringify(key.assert(options.options.challenge, { uv }))); return form; }
const run = (form: FormData, path = "/t/new") => withSignedWrite(h.db, h.ids.hana, h.request(path, { as: "hana" }), form, tx => createTopic(tx, h.ids.hana, { body: String(form.get("body")), lang: "ja" }));

describe("signed acceptance", () => {
  it("uses the draft language as a hint when previewing ambiguous Han text", async () => {
    const created = await createDraft(h.db, h.ids.hana, { kind: "topic", body: "確認", lang: "ja" });
    if (!created.ok) throw new Error(created.error);
    const form = formFor("確認"); form.set("intent", "publish");
    const preview = await previewSignedWrite(h.db, h.ids.hana, `/drafts/${created.id}`, form);
    expect(preview.language).toEqual({ source: "explicit", detected: "ja" });
  });
  it("requires UV and binds all input into the challenge, then records independently verifiable evidence", async () => {
    const form = formFor(); const options = await issue(form);
    expect(options.options.userVerification).toBe("required");
    const result = await run(signed(form, options)); expect(result.ok).toBe(true);
    const [record] = await h.db.select().from(memberSignatures).where(eq(memberSignatures.challenge, options.challenge));
    expect(createHash("sha256").update(record.payload).digest("hex")).toBe(record.payloadHash);
    expect(Buffer.from(record.challenge, "base64url").toString()).toMatch(new RegExp(`^tomola:v1:[a-f0-9]{64}:${record.payloadHash}$`));
    expect(record.publicKey).toBe(credential.publicKey.toString("base64"));
    expect(JSON.parse(record.payload).input).toMatchObject({ lang: "ja", body: "Accepted text", asksStance: false, aiAssistance: null, stanceTag: null });
    expect(record.assertion).toMatchObject({ id: credential.id });
    expect(record.authenticatorData).toBeTruthy(); expect(record.clientDataJson).toBeTruthy();
    expect((await h.db.select().from(signingChallenges).where(eq(signingChallenges.challenge, options.challenge)))[0].usedAt).not.toBeNull();
    expect((await buildMemberExport(h.db, h.ids.hana)).signatures.some(s => s.challenge === options.challenge)).toBe(true);
  });
  it("rejects missing proof without calling the publishing callback", async () => {
    let called = false;
    await expect(withSignedWrite(h.db, h.ids.hana, h.request("/t/new"), formFor(), async () => { called = true; return { ok: true }; })).rejects.toMatchObject({ status: 403 });
    expect(called).toBe(false);
  });
  it("binds a hydrated data submission to its public route without accepting a doubled suffix", async () => {
    const form = formFor("Hydrated submission"); const options = await issue(form);
    expect((await run(signed(form, options), "/t/new.data")).ok).toBe(true);
    await expect(issue(formFor(), "/")).rejects.toMatchObject({ status: 400 });
    const home = formFor(); const homeOptions = await issue(home);
    await expect(run(signed(home, homeOptions), "/_.data?index")).rejects.toMatchObject({ status: 400 });
    const doubled = formFor(); const second = await issue(doubled);
    await expect(run(signed(doubled, second), "/t/new.data.data")).rejects.toMatchObject({ status: 400 });
  });
  it("rejects assertions without user verification", async () => { const f = formFor(); const o = await issue(f); await expect(run(signed(f, o, credential, false))).rejects.toMatchObject({ status: 403 }); });
  it("rejects another member's credential", async () => { const f = formFor(); const o = await issue(f); await expect(run(signed(f, o, other))).rejects.toMatchObject({ status: 403 }); });
  it("rejects a different challenge", async () => { const f = formFor(); const o = await issue(f); f.set("signatureChallenge", o.challenge); f.set("signatureAssertion", JSON.stringify(credential.assert("wrong"))); await expect(run(f)).rejects.toMatchObject({ status: 403 }); });
  it("rejects expired challenges", async () => { const f = formFor(); const o = await issue(f); await h.db.update(signingChallenges).set({ createdAt: new Date(Date.now() - 180000), expiresAt: new Date(Date.now() - 1000) }).where(eq(signingChallenges.challenge, o.challenge)); await expect(run(signed(f, o))).rejects.toMatchObject({ status: 403 }); });
  it("rejects reuse and simultaneous sends even when the authenticator counter is zero", async () => {
    const zero = await signingCredential(h.db, h.ids.hana, { counterZero: true });
    const f = formFor("Counter-zero text"); const o = await issue(f); signed(f, o, zero);
    const results = await Promise.allSettled([run(f), run(f)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect((await h.db.select().from(memberSignatures).where(eq(memberSignatures.challenge, o.challenge)))).toHaveLength(1);
  });
  it.each(["body", "lang", "title", "asksStance", "altOf"])("rejects changed %s after approval", async field => { const f = formFor(); const o = await issue(f); signed(f, o); f.set(field, field === "asksStance" ? "1" : field === "altOf" ? "999" : "changed"); await expect(run(f)).rejects.toMatchObject({ status: 409 }); });
  it("rejects use on another HTTP operation", async () => {
    const topic = await createTopic(h.db, h.ids.hana, { body: "Reply target", lang: "ja" });
    if (!topic.ok) throw new Error(topic.error);
    const f = formFor(); const o = await issue(f); signed(f, o);
    await expect(run(f, `/t/${topic.id}`)).rejects.toMatchObject({ status: 409 });
  });
  it("rolls back publication, consumption and the counter together if storage differs from the accepted content", async () => {
    const f = formFor("Exact content"); const o = await issue(f); signed(f, o);
    const [before] = await h.db.select().from(passkey).where(eq(passkey.id, credential.id));
    await expect(withSignedWrite(h.db, h.ids.hana, h.request("/t/new"), f, tx => createTopic(tx, h.ids.hana, { body: "Different content", lang: "ja" }))).rejects.toMatchObject({ status: 409 });
    expect((await h.db.select().from(entries).where(eq(entries.body, "Different content")))).toHaveLength(0);
    expect((await h.db.select().from(signingChallenges).where(eq(signingChallenges.challenge, o.challenge)))[0].usedAt).toBeNull();
    expect((await h.db.select().from(passkey).where(eq(passkey.id, credential.id)))[0].counter).toBe(before.counter);
  });
  it("shows the full draft and signed previous view, and rejects an AI edit while approval is pending", async () => {
    const created = await createDraft(h.db, h.ids.hana, { kind: "topic", body: "Initial draft", lang: "ja" }); if (!created.ok) throw new Error(created.error);
    const path = `/drafts/${created.id}`; const f = formFor("Initial draft"); f.set("intent", "publish");
    f.set("signingView", signingViewToken({ userId: h.ids.hana, kind: "draft", id: created.id, version: "1", title: null, body: "Initial draft", lang: "ja" }));
    const o = await issue(f, path); signed(f, o);
    await updateDraft(h.db, h.ids.hana, created.id, { body: "AI replaced the draft", lang: "ja" });
    const preview = await previewSignedWrite(h.db, h.ids.hana, path, f);
    expect(preview.current?.body).toBe("AI replaced the draft"); expect(preview.viewed?.body).toBe("Initial draft");
    expect((await h.db.select().from(drafts).where(eq(drafts.id, created.id)))[0].version).toBe(2);
    await expect(run(f, path)).rejects.toMatchObject({ status: 409 });
  });
  it("verifies saved evidence after its original passkey is removed", async () => {
    const key = await signingCredential(h.db, h.ids.hana);
    const form = formFor("Durable acceptance evidence"); const options = await issue(form);
    expect((await run(signed(form, options, key))).ok).toBe(true);
    await h.db.delete(passkey).where(eq(passkey.id, key.id));
    const [record] = await h.db.select().from(memberSignatures).where(eq(memberSignatures.challenge, options.challenge));
    const verified = await verifyAuthenticationResponse({
      response: record.assertion as never, expectedChallenge: record.challenge, expectedOrigin: record.origin, expectedRPID: record.rpId,
      requireUserVerification: true, credential: { id: record.credentialId, publicKey: new Uint8Array(Buffer.from(record.publicKey, "base64")), counter: 0 },
    });
    expect(verified.verified).toBe(true);
    expect(verified.authenticationInfo.userVerified).toBe(true);
  });
  it("serializes login and signing counters on separate real PG connections without regression", async () => {
    const key = await signingCredential(h.db, h.ids.hana);
    const authRoute = await import("~/routes/api.auth");
    const optionsResponse = await authRoute.loader(h.args(h.request("/api/auth/passkey/generate-authenticate-options")));
    const loginOptions = await optionsResponse.json();
    const cookie = optionsResponse.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
    const login = new Request("http://localhost:5173/api/auth/passkey/verify-authentication", { method: "POST", headers: { origin: "http://localhost:5173", "content-type": "application/json", cookie }, body: JSON.stringify({ response: key.assert(loginOptions.challenge, { counter: 20 }) }) });
    const form = formFor("Concurrent login and acceptance"); const options = await issue(form);
    form.set("signatureChallenge", options.challenge);
    form.set("signatureAssertion", JSON.stringify(key.assert(options.options.challenge, { counter: 21 })));
    const outcomes = await Promise.allSettled([authRoute.action(h.args(login)), run(form)]);
    expect(outcomes[1].status).toBe("fulfilled");
    const [stored] = await h.db.select().from(passkey).where(eq(passkey.id, key.id));
    expect(stored.counter).toBe(21);
    expect(await h.db.select().from(memberSignatures).where(eq(memberSignatures.challenge, options.challenge))).toHaveLength(1);
    const loginResult = outcomes[0];
    expect(loginResult.status).toBe("fulfilled");
    if (loginResult.status === "fulfilled") expect([200, 400, 401]).toContain((loginResult.value as Response).status);
  });

  it("preserves the canonical AI client identity and edit time separately from its claimed name and website", async () => {
    const now = new Date();
    const created = await createDraft(h.db, h.ids.hana, { kind: "topic", body: "Complete AI draft", lang: "ja" }, { via: "api", now, client: { key: "oauth:test-client", id: "https://identity.example/client.json", name: "Claimed assistant", uri: "https://claimed.example" } });
    if (!created.ok) throw new Error(created.error);
    const form = formFor("Complete AI draft"); form.set("intent", "publish");
    const preview = await previewSignedWrite(h.db, h.ids.hana, `/drafts/${created.id}`, form);
    expect(preview.lastEditor).toEqual({ id: "https://identity.example/client.json", name: "Claimed assistant", uri: "https://claimed.example", at: now.toISOString() });
    expect(preview.content.body).toBe("Complete AI draft");
  });

});
