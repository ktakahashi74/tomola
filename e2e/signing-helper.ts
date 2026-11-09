import { expect, type CDPSession, type Page } from "@playwright/test";
import { enMessages, jaMessages } from "./helpers";

const authenticators = new WeakMap<Page, { client: CDPSession; authenticatorId: string }>();

// Chromium's real WebAuthn implementation signs the server challenge; the server verifier is never mocked.
export async function enableSigningAuthenticator(page: Page) {
  const previous = authenticators.get(page);
  if (previous) return previous;
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const current = { client, authenticatorId };
  authenticators.set(page, current);
  return current;
}

// Existing posting scenarios explicitly accept their own prepared text after opening the approval screen.
export async function acceptSignedWrite(page: Page) {
  await enableSigningAuthenticator(page);
  const messages = await page.locator("html").getAttribute("lang") === "ja" ? jaMessages : enMessages;
  const dialog = page.getByRole("dialog", { name: messages.signing_heading, exact: true });
  await expect(dialog).toBeVisible();
  const accept = dialog.getByRole("button", { name: new RegExp(`^(?:${[messages.signing_accept_post, messages.signing_accept_reply, messages.signing_accept_publish, messages.signing_accept_save, messages.signing_accept_remove].join("|")})$`) });
  await accept.click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}
