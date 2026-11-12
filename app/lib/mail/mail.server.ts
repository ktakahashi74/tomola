import { isDevOrTest } from "~/lib/env.server";
import { testSiteEnabled } from "~/lib/site-stage.server";
import { defaultUiLocale } from "~/lib/enabled-langs.server";
import type { Locale } from "~/paraglide/runtime.js";
import { createDevTransport, createSmtpTransport, type MailTransport } from "./transports.server";

// Shared mail interface with SMTP (SMTP_URL, nodemailer) and development stdout transports.
// Tests pass createMemoryMailbox from transports.server.ts to createMailer.
// Plain-text body, optional HTML. Callers supply validated recipient emails.

export type MailMessage = { to: string; subject: string; text: string; html?: string; locale?: Locale; sensitive?: boolean };

export type Mailer = {
  // Active transport: "smtp" | "dev" | "memory".
  readonly kind: MailTransport["kind"];
  readonly from: string;
  send(message: MailMessage): Promise<void>;
};

export function createMailer(transport: MailTransport, from: string): Mailer {
  return {
    kind: transport.kind,
    from,
    send: async ({ locale = defaultUiLocale(), ...message }) => {
      // Startup checks load this module before generated messages are present.
      const prefix = testSiteEnabled() ? (await import("~/paraglide/messages.js")).m.mail_test_prefix({}, { locale }) : null;
      await transport.send({ ...message, from, subject: prefix ? `${prefix}${message.subject}` : message.subject });
    },
  };
}

// Default sender without MAIL_FROM in development/tests: stdout only, never actually delivered.
const DEV_FROM = "tomola <noreply@localhost>";

export type MailConfig = { kind: "smtp"; smtpUrl: string; from: string; requireTLS: boolean } | { kind: "dev"; from: string };

// Local SMTP destination, e.g. a development mailbox, where encryption is not forced.
function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

// Select mail configuration from environment variables.
// - SMTP_URL enables SMTP and requires MAIL_FROM; most SMTP servers reject missing senders.
// - Otherwise, development/test NODE_ENV permits stdout delivery and optional MAIL_FROM.
// - All other environments, including unset NODE_ENV, error without mail configuration. Magic links are credentials and must not be logged.
// Never include SMTP_URL in errors: it may contain a password.
export function mailConfigFromEnv(env: Record<string, string | undefined> = process.env): MailConfig {
  const smtpUrl = env.SMTP_URL?.trim();
  const from = env.MAIL_FROM?.trim();
  if (smtpUrl) {
    if (!from) throw new Error("MAIL_FROM is required when SMTP_URL is set (for example: MAIL_FROM='tomola <no-reply@example.org>')");
    let parsed: URL;
    try {
      parsed = new URL(smtpUrl);
    } catch {
      throw new Error("SMTP_URL is not a valid URL (expected smtp://user:password@host:587 or smtps://user:password@host:465)");
    }
    if (parsed.protocol !== "smtp:" && parsed.protocol !== "smtps:") throw new Error("SMTP_URL must start with smtp:// or smtps://");
    // Production requires encryption for non-local smtp:// STARTTLS destinations; refuse plaintext delivery.
    // Disable only via SMTP_URL ?requireTLS=false for local verification, as documented in README. smtps:// is encrypted from the start.
    const requireTLS = parsed.protocol === "smtp:" && !isDevOrTest(env) && !isLocalHost(parsed.hostname);
    return { kind: "smtp", smtpUrl, from, requireTLS };
  }
  if (isDevOrTest(env)) return { kind: "dev", from: from || DEV_FROM };
  throw new Error("SMTP_URL and MAIL_FROM are required unless NODE_ENV is development or test (no way to send login links)");
}

export function mailerFromConfig(config: MailConfig): Mailer {
  return createMailer(config.kind === "smtp" ? createSmtpTransport(config.smtpUrl, { requireTLS: config.requireTLS }) : createDevTransport(), config.from);
}

const g = globalThis as { __tomolaMailer?: Mailer };

// One transport per process, reused across development hot reloads. Invalid configuration throws; failures are not cached.
export function getMailer(): Mailer {
  return (g.__tomolaMailer ??= mailerFromConfig(mailConfigFromEnv()));
}

export function sendMail(message: MailMessage): Promise<void> {
  return getMailer().send(message);
}

// The decoy recipient: an address the mail provider accepts and does not deliver (Postmark's black hole address test@blackhole.postmarkapp.com). A login request for an address that
// must never receive mail still sends one ordinary-looking message here, so the request takes the same path and the same time as any other. Set MAIL_DECOY_TO when SMTP is
// configured. Without SMTP (development, tests) nothing leaves the process, so the black hole address is the default.
export const DEFAULT_MAIL_DECOY_TO = "test@blackhole.postmarkapp.com";
const DECOY_PATTERN = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export function mailDecoyTo(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.MAIL_DECOY_TO?.trim();
  if (value) return value;
  return env.SMTP_URL?.trim() ? null : DEFAULT_MAIL_DECOY_TO;
}

// Startup check (app/lib/startup.server.ts): missing production mail configuration throws and prevents server startup.
// With SMTP, the decoy recipient is required too: without it the login screens would tell a held address apart.
export function assertMailConfigured(env: Record<string, string | undefined> = process.env): void {
  mailConfigFromEnv(env);
  if (!env.SMTP_URL?.trim()) return;
  const decoy = env.MAIL_DECOY_TO?.trim();
  if (!decoy) {
    throw new Error("MAIL_DECOY_TO is required when SMTP_URL is set: an address the mail provider accepts without delivering (for Postmark: test@blackhole.postmarkapp.com). See docs/deploy.md");
  }
  if (!DECOY_PATTERN.test(decoy)) throw new Error("MAIL_DECOY_TO is not a valid email address");
}
