import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { profiles } from "~/lib/db/schema";
import { noticesAvailable, trialParticipationRequired } from "~/lib/notice-sources.server";
import { saveTrialConsent } from "~/lib/trial-consent.server";
import { requireWriter } from "~/lib/auth/session.server";
import { getProfile } from "~/lib/profiles.server";
import { setupRouteHarness } from "./helpers/route-harness";

it("disables participation declarations only for an explicit unrestricted policy, with notices still published", async () => {
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "operator-policy-"));
  fs.cpSync("tests/fixtures/operator", directory, { recursive: true });
  const file = path.join(directory, "operator.json");
  const settings = JSON.parse(fs.readFileSync(file, "utf8"));
  Object.assign(settings.participation, { minimumAge: 0, excludedResidenceCountries: [], requireTrialConsent: false });
  fs.writeFileSync(file, JSON.stringify(settings));
  const h = await setupRouteHarness();
  vi.stubEnv("TOMOLA_OPERATOR_DIR", directory);
  try {
    expect(noticesAvailable()).toEqual({ privacy: true, terms: true });
    expect(trialParticipationRequired()).toBe(false);
    await h.signIn("unrestricted_existing");
    await h.db.update(profiles).set({ residenceCountry: null, adultConfirmedAt: null, trialConsentVersion: null, trialConsentAt: null }).where(eq(profiles.userId, h.ids.unrestricted_existing));
    expect(await requireWriter(h.request("/", { as: "unrestricted_existing", form: { body: "Allowed" } }))).toMatchObject({ user: { id: h.ids.unrestricted_existing } });
    expect(await saveTrialConsent(h.db, h.ids.unrestricted_existing, { residenceCountry: "JP", adult: false, agree: false, version: settings.participation.trialConsentVersion })).toMatchObject({ ok: false, error: "unavailable" });
    await h.signIn("unrestricted_new", { profile: false });
    const route = await import("~/routes/onboarding");
    expect(await route.loader(h.args(h.request("/onboarding", { as: "unrestricted_new" })))).toMatchObject({ trialRequired: false, countries: [] });
    expect(await h.outcome(() => route.action(h.args(h.request("/onboarding", { as: "unrestricted_new", form: { handle: "unrestricted_new", homeArea: "en" } }))))).toMatchObject({ status: 302 });
    expect(await getProfile(h.db, h.ids.unrestricted_new)).toMatchObject({ residenceCountry: null, adultConfirmedAt: null, trialConsentVersion: null, trialConsentAt: null });
  } finally {
    vi.unstubAllEnvs(); h.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
