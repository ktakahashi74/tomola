import { operatorConfig } from "~/lib/operator-config.server";
import { operatorName } from "~/lib/operator-settings";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";
import type { Lang } from "./languages";
import { SHELL_LABEL_KEYS, type ShellLabels } from "./shell-labels";

export function shellLabels(locale: Lang = getLocale()): ShellLabels {
  const labels = {} as ShellLabels;
  for (const key of SHELL_LABEL_KEYS) labels[key] = key === "footer_operator" ? m.footer_operator({ operator: operatorName(operatorConfig(), locale) }, { locale }) : m[key]({}, { locale });
  return labels;
}
