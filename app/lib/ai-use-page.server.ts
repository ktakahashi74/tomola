import { CHAT_NUSHI_PROMPT_VERSION, chatNushiEnabled } from "./chat-nushi-config.server";
import { NUSHI_PROMPT_VERSION, nushiEnabled } from "./nushi-config.server";
import { AI_USE_DEFINITIONS, PUBLIC_MODEL_NAME, readAiUseConfigurations, type AiUsePurpose } from "./ai-use-registry.server";
import { operatorConfig, type AiUseSettings } from "./operator-config.server";
import type { Lang } from "./languages";
import type { LlmEnv } from "./llm/types";
import { m } from "~/paraglide/messages.js";

export function aiUsePage(locale: Lang, env: LlmEnv = process.env, settings: AiUseSettings = operatorConfig().aiUse) {
  const options = { locale };
  const disabled = m.ai_use_disabled({}, options);
  const secretValues = new Set([
    "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "DATABASE_URL", "SMTP_URL",
    "GEMINI_BASE_URL", "SERVICE_CREDENTIALS",
    ...Object.keys(env).filter(name => name.startsWith("LLM_PRICE_")),
  ].map(name => env[name]).filter(value => value !== undefined && value !== ""));
  const publicModel = (model: string) => PUBLIC_MODEL_NAME.test(model) && !secretValues.has(model)
    ? model : m.ai_use_unknown_model({}, options);
  const latest = new Map<AiUsePurpose, AiUseSettings["history"][number]>();
  for (const change of settings.history) {
    const previous = latest.get(change.purpose);
    // Dates determine recency; the last entry wins when a use changes twice on one day.
    if (!previous || change.date >= previous.date) latest.set(change.purpose, change);
  }
  const titleFor = (purpose: AiUsePurpose) => m[AI_USE_DEFINITIONS[purpose].label]({}, options);
  const providers = { gemini: "Google", claude: "Anthropic", fake: m.ai_use_local({}, options) };
  const rows = readAiUseConfigurations(env).map(({ purpose, definition, config }) => {
    const recorded = latest.get(purpose);
    const details: string[] = [];
    if (config?.thinking) details.push(m.ai_use_thinking({ setting: config.thinking }, options));
    if (config?.dimensions !== undefined) details.push(m.ai_use_dimensions({ count: config.dimensions }, options));
    if (config?.sampleRate !== undefined) details.push(m.ai_use_sampling({ rate: new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 3 }).format(config.sampleRate) }, options));
    // Explicit projection: never spread an engine, the environment or an operator object into route data.
    return {
      purpose,
      title: titleFor(purpose),
      enabled: config !== null,
      status: config ? m.ai_use_enabled({}, options) : disabled,
      provider: config ? providers[config.id] : null,
      model: config ? publicModel(config.model) : null,
      settings: details,
      sent: m.ai_use_sent({ data: m[definition.sent]({}, options) }, options),
      unrecorded: recorded ? recorded.toModel !== (config?.model ?? null) : config !== null,
    };
  });
  return {
    locale,
    title: m.ai_use_title({}, options),
    opening: m.ai_use_opening({}, options),
    connectLabel: m.ai_use_connect({}, options),
    currentTitle: m.ai_use_current({}, options),
    configNote: m.ai_use_config_note({}, options),
    settingsNote: m.ai_use_settings_note({}, options),
    unrecorded: m.ai_use_unrecorded({}, options),
    rows,
    // Describe the village AI only while it is offered.
    nushi: nushiEnabled(env) || chatNushiEnabled(env) ? { title: m.nushi_name({}, options), text: [nushiEnabled(env) ? m.nushi_description({}, options) : "", chatNushiEnabled(env) ? m.chat_nushi_description({}, options) : ""].filter(Boolean).join(" "), versions: m.nushi_versions({ version: [nushiEnabled(env) ? NUSHI_PROMPT_VERSION : "", chatNushiEnabled(env) ? CHAT_NUSHI_PROMPT_VERSION : ""].filter(Boolean).join(" / ") }, options) } : null,
    searchTitle: m.ai_use_search({}, options),
    searchText: m.ai_use_search_text({}, options),
    historyTitle: m.ai_use_history({}, options),
    noHistory: m.ai_use_no_history({}, options),
    history: settings.history.filter(change => change.purpose !== "chat-nushi" || chatNushiEnabled(env)).map((change, index) => ({ change, index }))
      .sort((a, b) => b.change.date.localeCompare(a.change.date) || b.index - a.index)
      .map(({ change }) => ({
        date: change.date,
        purpose: change.purpose,
        title: titleFor(change.purpose),
        fromModel: change.fromModel === null ? disabled : publicModel(change.fromModel),
        toModel: change.toModel === null ? disabled : publicModel(change.toModel),
        reason: change.reason[locale] ?? change.reason.en,
        evidenceUrl: change.evidenceUrl,
      })),
    evidenceLabel: m.ai_use_evidence({}, options),
    reviewTitle: m.ai_use_human_review({}, options),
    reviewText: settings.humanReview ? settings.humanReview[locale] ?? settings.humanReview.en : m.ai_use_no_human_review({}, options),
    objectionsTitle: m.ai_use_objections({}, options),
    objectionsText: m.ai_use_objections_text({}, options),
    objectionsUrl: settings.objectionsUrl,
    objectionsLabel: m.ai_use_objections_link({}, options),
    links: [
      { href: "/privacy", label: m.footer_privacy({}, options) },
      { href: "/principles", label: m.footer_principles({}, options) },
      { href: "/stats", label: m.stats_title({}, options) },
    ],
  };
}

type Page = ReturnType<typeof aiUsePage>;
const markdownText = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/[\\`*_[\]<>#!]/g, "\\$&");
const markdownLink = (label: string, href: string) => `[${markdownText(label)}](${href.replace(/[()[\]<>]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)})`;

// The same projected values and selected copy serve both representations. Operator prose stays plain text.
export function aiUseMarkdown(page: Page): string {
  return [
    `# ${markdownText(page.title)}`,
    `${markdownText(page.opening)} ${markdownLink(page.connectLabel, "/connect")}`,
    ...(page.nushi ? [`## ${markdownText(page.nushi.title)}`, markdownText(page.nushi.text), markdownText(page.nushi.versions)] : []),
    `## ${markdownText(page.currentTitle)}`,
    markdownText(page.configNote),
    markdownText(page.settingsNote),
    ...page.rows.flatMap(row => [
      `### ${markdownText(row.title)} — ${markdownText(row.status)}`,
      [row.provider, row.model, ...row.settings].filter((value): value is string => value !== null).map(markdownText).join(" · "),
      markdownText(row.sent),
      ...(row.unrecorded ? [markdownText(page.unrecorded)] : []),
    ]),
    `## ${markdownText(page.searchTitle)}`,
    markdownText(page.searchText),
    `## ${markdownText(page.historyTitle)}`,
    ...(page.history.length ? page.history.flatMap(change => [
      `### ${change.date} — ${markdownText(change.title)}`,
      `${markdownText(change.fromModel)} → ${markdownText(change.toModel)}`,
      markdownText(change.reason),
      ...(change.evidenceUrl ? [markdownLink(page.evidenceLabel, change.evidenceUrl)] : []),
    ]) : [markdownText(page.noHistory)]),
    `## ${markdownText(page.reviewTitle)}`,
    markdownText(page.reviewText),
    `## ${markdownText(page.objectionsTitle)}`,
    markdownText(page.objectionsText),
    ...(page.objectionsUrl ? [markdownLink(page.objectionsLabel, page.objectionsUrl)] : []),
    page.links.map(link => markdownLink(link.label, link.href)).join(" · "),
  ].filter(Boolean).join("\n\n") + "\n";
}
