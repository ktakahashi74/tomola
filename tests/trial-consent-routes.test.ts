import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { profiles, stanceChanges, stances } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { requireMember, requireWriter } from "~/lib/auth/session.server";
import { getProfile } from "~/lib/profiles.server";
import { EXCLUDED_RESIDENCE_COUNTRIES, STANCE_CONSENT_VERSION, TRIAL_CONSENT_VERSION } from "./helpers/operator";
import { setupRouteHarness } from "./helpers/route-harness";
import { trialForm } from "./helpers/trial";


it("requires country, adult confirmation and agreement on direct signup POSTs", async () => {
  const h = await setupRouteHarness();
  try {
    await h.signIn("trial_signup", { profile: false });
    const { action } = await import("~/routes/onboarding");
    const submit = (over: Record<string, string>) => action(h.args(h.request("/onboarding", { as: "trial_signup", form: { handle: "trial_signup", homeArea: "en", ...trialForm, ...over } })));
    for (const country of EXCLUDED_RESIDENCE_COUNTRIES) expect(await submit({ residenceCountry: country })).toMatchObject({ error: "country_excluded" });
    expect(await submit({ residenceCountry: "XX" })).toMatchObject({ error: "invalid_country" });
    expect(await submit({ adult: "0" })).toMatchObject({ error: "adult_required" });
    expect(await submit({ trialAgree: "0" })).toMatchObject({ error: "trial_consent_required" });
    expect(await getProfile(h.db, h.ids.trial_signup)).toBeNull();
    expect(await h.outcome(() => submit({ residenceCountry: "KR" }))).toMatchObject({ status: 302, location: "/" });
    expect(await getProfile(h.db, h.ids.trial_signup)).toMatchObject({ residenceCountry: "KR", adultConfirmedAt: expect.any(Date) });
  } finally { h.restore(); }
});

it("asks existing members once, enforces version changes, and lets excluded members read", async () => {
  const h = await setupRouteHarness();
  try {
    await h.signIn("trial_existing");
    await h.db.update(profiles).set({ residenceCountry: null, adultConfirmedAt: null, trialConsentVersion: null, trialConsentAt: null }).where(eq(profiles.userId, h.ids.trial_existing));
    expect(await requireMember(h.request("/t/7", { as: "trial_existing" }))).toMatchObject({ user: { id: h.ids.trial_existing } });
    expect(await h.outcome(() => requireMember(h.request("/_.data?_routes=root", { as: "trial_existing" })))).toMatchObject({ status: 302, location: "/onboarding?next=%2F" });
    expect(await requireMember(h.request("/follow", { as: "trial_existing", form: { threadId: "1" } }))).toMatchObject({ user: { id: h.ids.trial_existing } });
    const route = await import("~/routes/onboarding");
    expect(await route.loader(h.args(h.request("/onboarding", { as: "trial_existing" })))).toMatchObject({ existing: true });
    const post = (country: string) => route.action(h.args(h.request("/onboarding", { as: "trial_existing", form: { ...trialForm, residenceCountry: country } })));
    expect(await post(EXCLUDED_RESIDENCE_COUNTRIES[0])).toMatchObject({ error: "country_excluded" });
    expect((await requireMember(h.request("/", { as: "trial_existing" }))).profile.residenceCountry).toBe(EXCLUDED_RESIDENCE_COUNTRIES[0]);
    expect(await h.outcome(() => requireWriter(h.request("/", { as: "trial_existing", form: { body: "blocked" } })))).toMatchObject({ status: 302, location: "/onboarding" });
    expect(await h.outcome(() => post("JP"))).toMatchObject({ status: 302 });
    expect(await requireMember(h.request("/", { as: "trial_existing" }))).toMatchObject({ profile: { residenceCountry: "JP" } });
    await h.db.update(profiles).set({ trialConsentVersion: TRIAL_CONSENT_VERSION - 1 }).where(eq(profiles.userId, h.ids.trial_existing));
    expect(await h.outcome(() => requireMember(h.request("/", { as: "trial_existing" })))).toMatchObject({ status: 302 });
  } finally { h.restore(); }
});

it("requires separate stance agreement, preserves records on revocation and still allows withdrawal", async () => {
  const h = await setupRouteHarness();
  try {
    await h.signIn("trial_stance");
    const question = await createTopic(h.db, h.ids.trial_stance, { title: "A consent question", body: "A question.", lang: "en", asksStance: true });
    if (!question.ok) throw new Error(question.error);
    await h.db.update(profiles).set({ stanceConsentVersion: null, stanceConsentAt: null }).where(eq(profiles.userId, h.ids.trial_stance));
    const { action } = await import("~/routes/stance");
    const settings = await import("~/routes/settings-stances");
    const choose = (position: string, version: string) => action(h.args(h.request("/stance", { as: "trial_stance", form: { questionId: String(question.id), position, version, returnTo: `/t/${question.id}` } })));
    expect(await h.outcome(() => choose("agree", "0"))).toMatchObject({ status: 307, location: expect.stringContaining("/settings/stances?") });
    expect(await h.db.select().from(stances)).toHaveLength(0);
    const consent = (intent: string, version = String(STANCE_CONSENT_VERSION)) => settings.action(h.args(h.request("/settings/stances", { as: "trial_stance", form: { intent, version, agree: "1", next: `/t/${question.id}` } })));
    expect(await h.outcome(() => consent("consent", "0"))).toMatchObject({ status: 400 });
    expect(await h.outcome(() => consent("consent"))).toMatchObject({ status: 302, location: `/t/${question.id}` });
    expect(await h.outcome(() => choose("agree", "0"))).toMatchObject({ status: 200 });
    expect(await h.outcome(() => consent("revoke-consent"))).toMatchObject({ status: 302 });
    expect(await h.db.select().from(stances)).toHaveLength(1);
    expect(await h.db.select().from(stanceChanges)).toHaveLength(1);
    expect(await h.outcome(() => choose("disagree", "1"))).toMatchObject({ status: 307 });
    expect(await h.outcome(() => choose("none", "1"))).toMatchObject({ status: 200 });
    expect(await h.db.select().from(stances)).toHaveLength(0);
    expect(await h.db.select().from(stanceChanges)).toHaveLength(2);
  } finally { h.restore(); }
});

it.each(["agree", "disagree", "neither"])("carries the intended %s choice through consent without URLs or automatic recording", async position => {
  const h = await setupRouteHarness();
  try {
    await h.signIn("consent_return");
    await h.signIn("consent_other");
    const question = await createTopic(h.db, h.ids.consent_return, { title: "Resume a choice", body: "Consent precedes a choice.", lang: "en", asksStance: true });
    const otherQuestion = await createTopic(h.db, h.ids.consent_return, { title: "Another question", body: "No carried choice.", lang: "en", asksStance: true });
    if (!question.ok || !otherQuestion.ok) throw new Error("Question creation failed");
    await h.db.update(profiles).set({ stanceConsentVersion: null, stanceConsentAt: null }).where(eq(profiles.userId, h.ids.consent_return));
    const { action } = await import("~/routes/stance");
    const settings = await import("~/routes/settings-stances");
    const fields = { questionId: String(question.id), position, version: "0", returnTo: `/t/${question.id}?lang=en#stance` };
    const redirected = await h.outcome(() => action(h.args(h.request("/stance", { as: "consent_return", form: fields }))));
    expect(redirected.status).toBe(307);
    expect(redirected.location).not.toMatch(/stance_(?:choice|q|msg)/);
    const consentUrl = new URL(redirected.location!, "http://localhost");
    const next = consentUrl.searchParams.get("next")!;
    expect(next).toBe(`/t/${question.id}?lang=en#stance`);
    const prepared = await settings.action(h.args(h.request(consentUrl.pathname + consentUrl.search, { as: "consent_return", form: fields })));
    expect(prepared).toMatchObject({ pending: { questionId: question.id, position } });
    expect(prepared).not.toHaveProperty("init.headers");
    expect((await getProfile(h.db, h.ids.consent_return))?.stanceConsentAt).toBeNull();
    expect(await h.db.select().from(stances)).toHaveLength(0);
    const consent = await settings.action(h.args(h.request("/settings/stances", { as: "consent_return", form: {
      intent: "consent", version: String(STANCE_CONSENT_VERSION), agree: "1", next, questionId: String(question.id), position,
    } }))).catch(error => error);
    expect(consent).toBeInstanceOf(Response);
    expect(consent.headers.get("Location")).toBe(next);
    expect(consent.headers.get("X-Remix-Reload-Document")).toBe("true");
    const cookie = consent.headers.getSetCookie().find((value: string) => value.startsWith("tomola.stance-resume="));
    expect(cookie).toContain(`Path=/t/${question.id}; HttpOnly; SameSite=Lax; Max-Age=180`);
    const topic = await import("~/routes/topic");
    const { sessionCookieMiddleware } = await import("~/lib/auth/session-cookies.server");
    const { stanceResumeMiddleware } = await import("~/lib/stance-resume.server");
    const read = async (as: string, id = question.id, carry = true, query = "") => {
      const request = h.request(`/t/${id}${query}`, { as });
      if (carry) request.headers.append("cookie", cookie.split(";")[0]);
      let result: unknown;
      const response = await sessionCookieMiddleware(h.args(request), async () => stanceResumeMiddleware(h.args(request), async () => {
        result = await topic.loader(h.args(request, { id: String(id) }));
        return new Response("page");
      })) as Response;
      const wrapped = result as { data?: unknown; init?: { headers?: unknown } };
      return { page: (wrapped.data ?? result) as { stanceResume: string | null }, response, init: wrapped.init };
    };
    const resumed = await read("consent_return");
    expect(resumed.page.stanceResume).toBe(position);
    expect(resumed.response.headers.getSetCookie()).toEqual(expect.arrayContaining([expect.stringContaining("Max-Age=0")]));
    expect(resumed.response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await read("consent_return", otherQuestion.id)).page.stanceResume).toBeNull();
    expect((await read("consent_other")).page.stanceResume).toBeNull();
    expect((await read("consent_return", question.id, false, `?stance_msg=consented&stance_choice=${position}&stance_q=${question.id}`)).page.stanceResume).toBeNull();
    await h.db.update(profiles).set({ stanceConsentVersion: null, stanceConsentAt: null }).where(eq(profiles.userId, h.ids.consent_return));
    expect((await read("consent_return")).page.stanceResume).toBeNull();
    expect(await h.db.select().from(stances)).toHaveLength(0);
    expect(await h.db.select().from(stanceChanges)).toHaveLength(0);
  } finally { h.restore(); }
});

it.each([
  ["/?page=2&asks=1&order=old&long=1&lang=en", "?lang=en"],
  ["/following?page=2", ""],
  ["/latest?page=2&asks=1&lang=ja", "?lang=ja"],
  ["/a/en?page=2&order=activity&lang=en", "?lang=en"],
  ["/v/example?page=2&long=1&lang=ja", "?lang=ja"],
  ["/t/QUESTION?page=2&lang=en&tag=objection", "?page=2&lang=en&tag=objection"],
  ["/t/999999?page=2&lang=en", "?lang=en"],
])("keeps only the question's own paging when consent starts from %s", async (source, search) => {
  const h = await setupRouteHarness();
  try {
    await h.signIn("paging_consent");
    const question = await createTopic(h.db, h.ids.paging_consent, { title: "Consent after paging", body: "The destination must remain readable.", lang: "en", asksStance: true });
    if (!question.ok) throw new Error(question.error);
    await h.db.update(profiles).set({ stanceConsentVersion: null, stanceConsentAt: null }).where(eq(profiles.userId, h.ids.paging_consent));
    const { action } = await import("~/routes/stance");
    const result = await h.outcome(() => action(h.args(h.request("/stance", { as: "paging_consent", form: {
      questionId: String(question.id), position: "agree", version: "0", returnTo: source.replace("QUESTION", String(question.id)),
    } }))));
    expect(result.status).toBe(307);
    expect(new URL(result.location!, "http://localhost").searchParams.get("next")).toBe(`/t/${question.id}${search}#stance`);
    expect(await h.db.select().from(stances)).toHaveLength(0);
    expect(await h.db.select().from(stanceChanges)).toHaveLength(0);
  } finally { h.restore(); }
});

it("applies the participation gate to draft API writes without affecting member reads or exports", async () => {
  const h = await setupRouteHarness();
  try {
    await h.signIn("trial_api");
    const { createApiToken } = await import("~/lib/tokens.server");
    const token = await createApiToken(h.db, h.ids.trial_api, { name: "Consent boundary", kind: "draft" });
    if (!token.ok) throw new Error(token.error);
    const { action } = await import("~/routes/api.drafts");
    const post = () => action(h.args(new Request("http://localhost:5173/api/drafts", { method: "POST", headers: { authorization: `Bearer ${token.token}`, "Content-Type": "text/markdown" }, body: "---\ntitle: Example\n---\nA draft." })));
    await h.db.update(profiles).set({ residenceCountry: "CN" }).where(eq(profiles.userId, h.ids.trial_api));
    const restricted = await post();
    expect(restricted.status).toBe(403);
    expect(await restricted.json()).toMatchObject({ error: "trial_restricted" });
    await h.db.update(profiles).set({ residenceCountry: "JP", trialConsentVersion: 0 }).where(eq(profiles.userId, h.ids.trial_api));
    const stale = await post();
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ error: "trial_consent_required" });
  } finally { h.restore(); }
});
