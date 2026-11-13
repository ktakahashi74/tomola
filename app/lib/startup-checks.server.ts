import { pushConfig } from "./push/config.server";
import { loadOperatorConfig } from "~/lib/operator-config.server";
import { createFigureReader, figureTranslationEnabled } from "./figure-reading.server";
import { translationEagerConfig } from "./translation-eager-config.server";
import { assertVillageChatConfig, villageChatEnabled } from "./village-chat-enabled.server";
import { chatMonthlyBudgetMicro, monthlyBudgetMicro } from "./llm/usage.server";
import { chatThinking, chatTranslationConcurrency, resolveChatEngine, modelMatchesProvider, primaryEngineId } from "./llm/config.server";
import { databasePoolMax, resolveDbConfig } from "~/lib/db/config.server";
import { translationConcurrency } from "~/lib/jobs/translation-config.server";
import { assertEnabledLangsConfigured, assertEnabledLangsReviewed, type ReviewCounts } from "~/lib/enabled-langs.server";
import { isDevOrTest } from "~/lib/env.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { publicReading } from "~/lib/public-reading.server";
import { operatorOnlyInvitations } from "~/lib/invitation-permissions.server";
import { trustedProxyHops } from "~/lib/http/client-ip.server";
import { divergenceDetectionEnabled, judgeThinking, primaryModelOf, resolveEmbeddingEngine, resolveEngines, retryModelOf, translationThinking } from "~/lib/llm/config.server";
import { divergenceSampleRate } from "~/lib/llm/divergence-sample.server";
import { retryCaps } from "~/lib/llm/retry-caps.server";
import { assertMailConfigured } from "~/lib/mail/mail.server";
import { sourceUrl } from "~/lib/source-url";
import { homeTrialEnabled } from "~/lib/home-trial.server";
import { testSiteEnabled } from "~/lib/site-stage.server";
import { assertAiQuestionConfig, postAskAiEnabled } from "./ai-question-config.server";
import { questionModel } from "./ai-question-answer.server";

// Startup configuration checks, called by app/lib/startup.server.ts. Reject invalid configuration before starting the server instead of waiting for the first request.
// In production (NODE_ENV is neither development nor test, including unset), also validate the signing secret and site URL:
//     - BETTER_AUTH_SECRET: required, at least 32 characters (session signatures and the key source for signed 「AIで開く」 links; production must not use the development default).
//     - BETTER_AUTH_URL: required, https (source for magic links, passkey origins, and rpID; http also prevents Secure cookies from working).
//     - Database: require a postgres:// DATABASE_URL. Without DATABASE_URL, startup creates ./.data/pglite using PGlite (an embedded development/test DB that permits only one process and cannot be backed up
//         with pg_dump), silently running production on a development DB if configuration is omitted. Allow production PGlite only with an explicit PGLITE_DATA_DIR
//         (staging or production-build checks; e2e-prod/). Reject the legacy path-based DATABASE_URL form in production too.
//     - Translation engines (primary, secondary, and judge) and the embedding engine must not be fake: missing keys default to fake, translating member posts as 「[ja] 原文」
//         and searching meaningless embeddings. Skip this guard only with TOMOLA_ALLOW_FAKE_ENGINES=1 (test environments, never a production site with members).
export const MIN_SECRET_LENGTH = 32;

// Throw in production unless the database configuration specifies PostgreSQL or explicit PGlite.
export function assertDatabaseConfigured(env: Record<string, string | undefined> = process.env): void {
  const config = resolveDbConfig(env);
  if (config.kind === "pg") return;
  if (config.legacy) {
    throw new Error("DATABASE_URL must be a postgres:// or postgresql:// URL in production (a plain path as DATABASE_URL is the old PGlite form; set PGLITE_DATA_DIR instead if PGlite is really intended)");
  }
  if (!env.PGLITE_DATA_DIR?.trim()) {
    throw new Error(
      "DATABASE_URL (postgres://…) is required in production: without it the server would use PGlite, the embedded development database. " +
        "Set DATABASE_URL, or set PGLITE_DATA_DIR explicitly if PGlite is really intended (a staging site).",
    );
  }
}

export function allowFakeEngines(env: Record<string, string | undefined> = process.env): boolean {
  return env.TOMOLA_ALLOW_FAKE_ENGINES?.trim() === "1";
}

// Throw if production uses fake engines. Also reject invalid engine configuration, such as a missing key for an explicitly selected engine, before the first job.
export function assertNoFakeEngines(env: Record<string, string | undefined> = process.env): void {
  // The thinking settings are checked first, whether or not fake engines are allowed: a typo in GEMINI_TRANSLATION_THINKING or DIVERGENCE_JUDGE_THINKING stops the server at the
  // start, instead of the first translation job (resolveEngines checks them only for the Gemini engines that are actually built).
  translationThinking(env);
  judgeThinking(env);
  if (allowFakeEngines(env)) return;
  const fake: string[] = [];
  const engines = resolveEngines(env);
  if (engines.primary.id === "fake") fake.push("the primary translation engine (TRANSLATION_PRIMARY)");
  if (engines.secondary?.id === "fake") fake.push("the secondary translation engine (TRANSLATION_SECONDARY)");
  if (engines.judge?.id === "fake") fake.push("the divergence judge (DIVERGENCE_JUDGE)");
  if (engines.retry?.id === "fake") fake.push("the retry translation engine (TRANSLATION_RETRY_MODEL)");
  if (engines.chat?.id === "fake") fake.push("the chat translation engine (CHAT_TRANSLATION_MODEL)");
  if (resolveEmbeddingEngine(env).id === "fake") fake.push("the embedding engine (EMBEDDING_ENGINE)");
  if (fake.length === 0) return;
  throw new Error(
    `Refusing to start in production: ${fake.join(", ")} would be the fake engine, which writes placeholder translations and meaningless search vectors. ` +
      "Set GEMINI_API_KEY (and optionally ANTHROPIC_API_KEY), or set TOMOLA_ALLOW_FAKE_ENGINES=1 for a staging site that has no real members.",
  );
}

// Warn in production when TRANSLATION_RETRY_MODEL is unset (not an error): reports go directly to moderators because automatic retranslation with a stronger model is unavailable.
// Setting it is recommended (a model name from the primary provider; docs/deploy.md). Return true when a warning is emitted.
export const RETRY_MODEL_WARNING =
  "[startup] WARNING: TRANSLATION_RETRY_MODEL is not set. A mistranslation report will not trigger the one automatic re-translation with a higher model, so every report goes straight to the moderators. " +
  "Setting it is recommended: use a model of the same provider as TRANSLATION_PRIMARY (docs/deploy.md).";

export function warnIfNoRetryModel(env: Record<string, string | undefined> = process.env, log: (message: string) => void = (m) => console.warn(m)): boolean {
  if (retryModelOf(env) !== undefined) return false;
  log(RETRY_MODEL_WARNING);
  return true;
}

// Warn when TRANSLATION_RETRY_MODEL matches the primary model (retranslation with the same model adds no stronger-model benefit). Not an error; return true if warned.
export const RETRY_MODEL_SAME_AS_PRIMARY_WARNING =
  "[startup] WARNING: TRANSLATION_RETRY_MODEL is the same model as the primary translation model, so the automatic re-translation after a report uses no higher model and will usually repeat the mistake. Pick a higher model of the same provider (docs/deploy.md).";

export function warnIfRetryModelIsPrimary(env: Record<string, string | undefined> = process.env, log: (message: string) => void = (m) => console.warn(m)): boolean {
  const retry = retryModelOf(env);
  if (retry === undefined) return false;
  let primary: string;
  try {
    primary = primaryModelOf(env);
  } catch {
    return false;
  }
  if (retry.toLowerCase() !== primary.toLowerCase()) return false;
  log(RETRY_MODEL_SAME_AS_PRIMARY_WARNING);
  return true;
}

// In production, warn if secondary and judge engines are configured but DIVERGENCE_SAMPLE_RATE is 0: divergence detection compares no translations. Not an error; return true if warned.
export const SAMPLE_RATE_ZERO_WARNING =
  "[startup] WARNING: TRANSLATION_SECONDARY and DIVERGENCE_JUDGE are set but DIVERGENCE_SAMPLE_RATE is 0 (the default), so no translation is compared. Set a rate from 0 to 1 (docs/deploy.md).";

export function warnIfSampleRateZero(env: Record<string, string | undefined> = process.env, log: (message: string) => void = (m) => console.warn(m)): boolean {
  if (!divergenceDetectionEnabled(env) || divergenceSampleRate(env) > 0) return false;
  log(SAMPLE_RATE_ZERO_WARNING);
  return true;
}

// deps.reviewCounts: the review state of the UI strings (by default what the build embedded; tests pass their own).
export function assertStartupConfig(
  env: Record<string, string | undefined> = process.env,
  log: (message: string) => void = (m) => console.warn(m),
  deps: { reviewCounts?: ReviewCounts | null } = {},
): void {
  pushConfig(env);
  testSiteEnabled(env);
  if (figureTranslationEnabled(env)) createFigureReader(env);
  // Throw in production without SMTP_URL and MAIL_FROM; do not run a server that cannot send magic links.
  assertMailConfigured(env);
  // Throw for invalid TRUSTED_PROXY_HOPS so IP-based limits do not keep applying to incorrect addresses.
  trustedProxyHops(env);
  databasePoolMax(env);
  translationConcurrency(env);
  translationEagerConfig(env);
  // SOURCE_URL (the footer's link to the source code) must be an http(s) URL when it is set.
  sourceUrl(env);
  // ENABLED_LANGS: a malformed value stops startup everywhere; production must set it explicitly (app/lib/enabled-langs.server.ts).
  assertEnabledLangsConfigured(env);
  publicReading(env);
  assertAiQuestionConfig(env);
  if (postAskAiEnabled(env)) questionModel(env);
  operatorOnlyInvitations(env);
  villagesEnabled(env);
  assertVillageChatConfig(env);
  for (const name of ["MODERATION_SPAM_ENABLED", "MODERATION_AI_SPAM_ENABLED", "MODERATION_AI_TRIAGE_ENABLED"]) {
    const value = env[name];
    if (value !== undefined && value !== "" && value !== "1") throw new Error(`${name} must be 1 or empty`);
  }
  const moderationModel = env.MODERATION_AI_MODEL?.trim();
  if (moderationModel && !modelMatchesProvider(primaryEngineId(env), moderationModel)) throw new Error("MODERATION_AI_MODEL must match the translation provider");
  if (villageChatEnabled(env)) {
    chatThinking(env);
    chatTranslationConcurrency(env);
    chatMonthlyBudgetMicro(env);
    resolveChatEngine(env);
  }
  homeTrialEnabled(env);
  loadOperatorConfig(env);
  if (isDevOrTest(env)) return;
  monthlyBudgetMicro(env);
  const secret = env.BETTER_AUTH_SECRET?.trim();
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required unless NODE_ENV is development or test");
  if (secret.length < MIN_SECRET_LENGTH) throw new Error(`BETTER_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters (use a random string)`);
  const url = env.BETTER_AUTH_URL?.trim();
  if (!url) throw new Error("BETTER_AUTH_URL is required unless NODE_ENV is development or test");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("BETTER_AUTH_URL is not a valid URL (expected https://forum.example.org)");
  }
  if (parsed.protocol !== "https:") throw new Error("BETTER_AUTH_URL must be an https:// URL unless NODE_ENV is development or test");
  assertDatabaseConfigured(env);
  assertNoFakeEngines(env);
  // No enabled language may still have pending or unchecked UI strings (production only; reads the counts the build embedded).
  if ("reviewCounts" in deps) assertEnabledLangsReviewed(env, deps.reviewCounts ?? null);
  else assertEnabledLangsReviewed(env);
  // Divergence sample rate: reject startup unless within 0 to 1 (development and tests treat invalid values as 0 at runtime and warn).
  divergenceSampleRate(env);
  // Daily automatic retranslation limits, per member and site-wide: reject startup unless nonnegative integers.
  retryCaps(env);
  warnIfNoRetryModel(env, log);
  warnIfRetryModelIsPrimary(env, log);
  warnIfSampleRateZero(env, log);
}
