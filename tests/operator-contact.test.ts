import { createElement } from "react";
import { UNSAFE_ErrorResponseImpl } from "react-router";
import { expect, it, vi } from "vitest";
import { RouteError } from "~/components/route-error";
import DeleteAccount from "~/routes/settings-delete-account";
import { OperatorSettingsContext } from "~/lib/operator-context";
import { testOperator } from "./helpers/operator";
import { jsonMessages } from "./helpers/messages-json";
import { renderInRouter } from "./helpers/render-in-router";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

it("keeps the configured contact on an early error even when root loader data is unavailable", async () => {
  const settings = { ...testOperator, contactEmail: "help@community.example" };
  const markup = await renderInRouter(() => createElement(OperatorSettingsContext.Provider, { value: settings },
    createElement(RouteError, { error: new UNSAFE_ErrorResponseImpl(500, "Internal Server Error", "failure") })), "/", undefined, { operator: undefined });
  expect(markup).toContain(settings.contactEmail);
});

it("uses the privacy contact for a failed account deletion", async () => {
  const settings = { ...testOperator, privacyEmail: "privacy@community.example" };
  const markup = await renderInRouter(() => createElement(DeleteAccount, { loaderData: { handle: "test", signPosts: false, completionKey: "fixture", villages: [] }, actionData: { error: "failed" } } as never), "/", undefined, { operator: settings });
  expect(markup).toContain(settings.privacyEmail);
});

it.each(["en", "ja", "fr", "ko", "zh-Hans", "zh-Hant"])("substitutes contact parameters in every maintained %s translation", locale => {
  const messages = jsonMessages();
  const email = "help@community.example";
  for (const key of ["account_delete_mail_body", "account_delete_error_failed", "error_body_unexpected"]) {
    const text = messages[key]({ email, posts: "" }, { locale });
    expect(text).toContain(email);
    expect(text).not.toContain("{email}");
  }
});
