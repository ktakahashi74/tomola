import nodemailer from "nodemailer";

// Mail transports, called by Mailer in mail.server.ts after adding the sender.
export type OutgoingMail = { from: string; to: string; subject: string; text: string; html?: string; sensitive?: boolean };
export type MailTransport = { readonly kind: "smtp" | "dev" | "memory"; send(mail: OutgoingMail): Promise<void> };

// SMTP via nodemailer, with timeouts so a stuck connection cannot indefinitely hold a login request.
// requireTLS mandates STARTTLS and fails rather than sending plaintext credentials. SMTP_URL
// ?requireTLS=false takes precedence: nodemailer overrides this configuration with URL values.
export function createSmtpTransport(smtpUrl: string, opts: { requireTLS?: boolean } = {}): MailTransport {
  const transporter = nodemailer.createTransport({
    url: smtpUrl,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    ...(opts.requireTLS ? { requireTLS: true } : {}),
  });
  return {
    kind: "smtp",
    async send(mail) {
      await transporter.sendMail({ from: mail.from, to: mail.to, subject: mail.subject, text: mail.text, ...(mail.html ? { html: mail.html } : {}) });
    },
  };
}

// Development stdout only, never delivery. E2E reads magic links from this log in e2e/helpers.ts; update that parser if changing the format:
//   [mail] to=<recipient> subject=<subject>
//   <body>
//   [/mail]
// Forbidden in production because magic links are credentials; mailConfigFromEnv in mail.server.ts never selects this in production.
export function createDevTransport(log: (line: string) => void = (line) => console.info(line)): MailTransport {
  return {
    kind: "dev",
    async send(mail) {
      // Invitation credentials and personal notes must not enter development logs.
      if (mail.sensitive) { log("[mail] Sensitive content omitted (development transport; no delivery)."); return; }
      log(`[mail] to=${mail.to} subject=${mail.subject}\n${mail.text}\n[/mail]`);
    },
  };
}

// Test transport: accumulate sent mail in memory.
export type SentMail = OutgoingMail;
export function createMemoryMailbox(): { transport: MailTransport; sent: SentMail[]; clear(): void } {
  const sent: SentMail[] = [];
  return {
    transport: {
      kind: "memory",
      async send(mail) {
        sent.push(mail);
      },
    },
    sent,
    clear: () => {
      sent.length = 0;
    },
  };
}
