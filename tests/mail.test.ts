import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertMailConfigured, createMailer, mailConfigFromEnv, mailDecoyTo } from "~/lib/mail/mail.server";
import { magicLinkMail, mailLocale } from "~/lib/mail/magic-link.server";
import { createDevTransport, createMemoryMailbox, createSmtpTransport } from "~/lib/mail/transports.server";
import { notificationMail, digestMail } from "~/lib/mail/notification.server";
import { m } from "~/paraglide/messages.js";

// Check mail wording from the real messages, not stubs.
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

describe("test-site mail", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["ja", "en", "fr", "zh-Hans", "zh-Hant"] as const)("marks invitation, login, notification and digest subjects in %s at the shared sender", async locale => {
    const box = createMemoryMailbox();
    const mailer = createMailer(box.transport, "tomola <no-reply@example.org>");
    const login = { to: "member@example.org", url: "https://example.org/auth/confirm?token=fake", code: "123456", locale };
    const notification = { to: login.to, locale, settingsUrl: "https://example.org/settings", item: { kind: "mention" as const, url: "https://example.org/t/1" } };
    const messages = [magicLinkMail({ ...login, invitation: true }), magicLinkMail(login), notificationMail(notification), digestMail({ ...notification, items: [notification.item], more: 0, allUrl: "https://example.org/notifications" })];
    for (const stage of [undefined, "test", ""]) {
      vi.stubEnv("TOMOLA_SITE_STAGE", stage);
      box.clear();
      for (const message of messages) await mailer.send(message);
      expect(box.sent).toHaveLength(messages.length);
      for (const [index, sent] of box.sent.entries()) {
        const { locale: _locale, ...message } = messages[index];
        expect(sent).toEqual({ ...message, from: mailer.from, subject: stage === "test" ? `${m.mail_test_prefix({}, { locale })}${message.subject}` : message.subject });
        expect(sent).not.toHaveProperty("locale");
      }
    }
  });
});

describe("mail config", () => {
  it("uses SMTP when SMTP_URL is set, and then requires MAIL_FROM", () => {
    expect(mailConfigFromEnv({ NODE_ENV: "production", SMTP_URL: "smtps://user:pw@smtp.example.org:465", MAIL_FROM: "tomola <no-reply@example.org>" })).toEqual({
      kind: "smtp",
      smtpUrl: "smtps://user:pw@smtp.example.org:465",
      from: "tomola <no-reply@example.org>",
      requireTLS: false,
    });
    for (const NODE_ENV of ["production", "development", "test", undefined]) {
      expect(() => mailConfigFromEnv({ NODE_ENV, SMTP_URL: "smtp://smtp.example.org:587" })).toThrow("MAIL_FROM is required");
      expect(() => mailConfigFromEnv({ NODE_ENV, SMTP_URL: "smtp://smtp.example.org:587", MAIL_FROM: "  " })).toThrow("MAIL_FROM is required");
    }
  });

  it("requires STARTTLS in production for smtp:// to a host that is not local, unless the URL says requireTLS=false", () => {
    const from = "a@example.org";
    const requireTLS = (SMTP_URL: string, NODE_ENV: string | undefined = "production") => (mailConfigFromEnv({ NODE_ENV, SMTP_URL, MAIL_FROM: from }) as { requireTLS: boolean }).requireTLS;
    expect(requireTLS("smtp://u:p@smtp.example.org:587")).toBe(true);
    expect(requireTLS("smtp://u:p@smtp.example.org:587", undefined)).toBe(true);
    // smtps encrypts from the start; do not force it for local development or tests.
    expect(requireTLS("smtps://u:p@smtp.example.org:465")).toBe(false);
    for (const local of ["smtp://localhost:25", "smtp://127.0.0.1:1025", "smtp://[::1]:25", "smtp://mail.localhost:25"]) expect(requireTLS(local), local).toBe(false);
    expect(requireTLS("smtp://u:p@smtp.example.org:587", "development")).toBe(false);
    expect(requireTLS("smtp://u:p@smtp.example.org:587", "test")).toBe(false);
  });

  it("rejects an SMTP_URL that is not an smtp URL, without echoing the value (it can hold a password)", () => {
    for (const SMTP_URL of ["not a url", "http://smtp.example.org", "https://user:secret-pw@smtp.example.org"]) {
      const error = (() => {
        try {
          mailConfigFromEnv({ NODE_ENV: "production", SMTP_URL, MAIL_FROM: "a@example.org" });
        } catch (e) {
          return e as Error;
        }
      })();
      expect(error, SMTP_URL).toBeInstanceOf(Error);
      expect(error!.message).not.toContain("secret-pw");
    }
  });

  it("writes to stdout (dev transport) only in development and test", () => {
    expect(mailConfigFromEnv({ NODE_ENV: "development" })).toMatchObject({ kind: "dev" });
    expect(mailConfigFromEnv({ NODE_ENV: "test", MAIL_FROM: "x@example.org" })).toEqual({ kind: "dev", from: "x@example.org" });
  });

  it("is an error without any sending config in production, and when NODE_ENV is unset", () => {
    expect(() => mailConfigFromEnv({ NODE_ENV: "production" })).toThrow("SMTP_URL and MAIL_FROM are required");
    expect(() => mailConfigFromEnv({})).toThrow("SMTP_URL and MAIL_FROM are required");
    expect(() => mailConfigFromEnv({ NODE_ENV: "production", MAIL_FROM: "a@example.org" })).toThrow("SMTP_URL and MAIL_FROM are required");
  });

  it("checks the config at startup", () => {
    expect(() => assertMailConfigured({ NODE_ENV: "production" })).toThrow("SMTP_URL and MAIL_FROM are required");
    expect(() => assertMailConfigured({ NODE_ENV: "production", SMTP_URL: "smtp://h:25", MAIL_FROM: "a@example.org", MAIL_DECOY_TO: "test@blackhole.postmarkapp.com" })).not.toThrow();
    expect(() => assertMailConfigured({ NODE_ENV: "development" })).not.toThrow();
  });

  it("requires a valid decoy recipient whenever SMTP is configured, and defaults to the black hole address only without SMTP", () => {
    const smtp = { NODE_ENV: "production", SMTP_URL: "smtp://h:25", MAIL_FROM: "a@example.org" };
    expect(() => assertMailConfigured(smtp)).toThrow("MAIL_DECOY_TO is required");
    expect(() => assertMailConfigured({ ...smtp, MAIL_DECOY_TO: "  " })).toThrow("MAIL_DECOY_TO is required");
    expect(() => assertMailConfigured({ ...smtp, MAIL_DECOY_TO: "not an address" })).toThrow("MAIL_DECOY_TO is not a valid");
    expect(mailDecoyTo({ ...smtp, MAIL_DECOY_TO: " sink@example.org " })).toBe("sink@example.org");
    expect(mailDecoyTo(smtp)).toBeNull();
    expect(mailDecoyTo({ NODE_ENV: "development" })).toBe("test@blackhole.postmarkapp.com");
  });
});

describe("transports", () => {
  it("the dev transport prints a block the e2e log scraper understands", async () => {
    const lines: string[] = [];
    const mailer = createMailer(createDevTransport((line) => lines.push(line)), "tomola <noreply@localhost>");
    await mailer.send({ to: "a@example.org", subject: "Hello", text: "line 1\nhttp://localhost:5173/auth/confirm?token=abc" });
    expect(lines).toEqual(["[mail] to=a@example.org subject=Hello\nline 1\nhttp://localhost:5173/auth/confirm?token=abc\n[/mail]"]);
  });

  it("the memory mailbox keeps what was sent, with the sender", async () => {
    const box = createMemoryMailbox();
    const mailer = createMailer(box.transport, "tomola <no-reply@example.org>");
    await mailer.send({ to: "a@example.org", subject: "s", text: "t" });
    expect(mailer.kind).toBe("memory");
    expect(box.sent).toEqual([{ from: "tomola <no-reply@example.org>", to: "a@example.org", subject: "s", text: "t" }]);
    box.clear();
    expect(box.sent).toEqual([]);
  });

  it("the SMTP transport with requireTLS refuses to send in the clear (a server without STARTTLS)", async () => {
    const received: string[] = [];
    const server = net.createServer((socket) => {
      socket.write("220 localhost ESMTP test\r\n");
      socket.on("data", (chunk) => {
        received.push(chunk.toString("utf8"));
        const line = chunk.toString("utf8").toUpperCase();
        if (line.startsWith("EHLO")) socket.write("250 localhost\r\n");
        else if (line.startsWith("QUIT")) socket.end("221 bye\r\n");
        else socket.write("250 OK\r\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as net.AddressInfo).port;
      const strict = createMailer(createSmtpTransport(`smtp://127.0.0.1:${port}`, { requireTLS: true }), "a@example.org");
      await expect(strict.send({ to: "m@example.org", subject: "s", text: "secret link" })).rejects.toThrow();
      expect(received.join("")).not.toMatch(/secret link|RCPT|DATA/i);
      // An explicit URL may disable this for local testing.
      const lax = createMailer(createSmtpTransport(`smtp://127.0.0.1:${port}?requireTLS=false`, { requireTLS: true }), "a@example.org");
      await expect(lax.send({ to: "m@example.org", subject: "s", text: "link" })).resolves.toBeUndefined();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("the SMTP transport delivers through nodemailer (checked against a minimal local SMTP server)", async () => {
    const received: string[] = [];
    const server = net.createServer((socket) => {
      let inData = false;
      let data = "";
      let buffer = "";
      socket.write("220 localhost ESMTP test\r\n");
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          if (inData) {
            const end = buffer.indexOf("\r\n.\r\n");
            if (end === -1) return;
            data += buffer.slice(0, end);
            buffer = buffer.slice(end + 5);
            inData = false;
            received.push(data);
            socket.write("250 OK queued\r\n");
            continue;
          }
          const eol = buffer.indexOf("\r\n");
          if (eol === -1) return;
          const line = buffer.slice(0, eol);
          buffer = buffer.slice(eol + 2);
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === "EHLO" || cmd === "HELO") socket.write("250 localhost\r\n");
          else if (cmd === "DATA") {
            inData = true;
            data = "";
            socket.write("354 go ahead\r\n");
          } else if (cmd === "QUIT") socket.end("221 bye\r\n");
          else socket.write("250 OK\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as net.AddressInfo).port;
      const mailer = createMailer(createSmtpTransport(`smtp://127.0.0.1:${port}`), "tomola <no-reply@example.org>");
      await mailer.send({ to: "member@example.org", subject: "Login link", text: "https://example.org/auth/confirm?token=abc" });
      expect(received).toHaveLength(1);
      expect(received[0]).toMatch(/^From: tomola <no-reply@example\.org>/m);
      expect(received[0]).toMatch(/^To: member@example\.org/m);
      expect(received[0]).toMatch(/^Subject: Login link/m);
      expect(received[0]).toContain("https://example.org/auth/confirm?token=abc");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("magic link mail", () => {
  const url = "http://localhost:5173/auth/confirm?token=abc";

  it("is plain text in the requester's language, with the link and the expiry", () => {
    const en = magicLinkMail({ to: "a@example.org", url, code: "123456", locale: "en" });
    expect(en).toMatchObject({ to: "a@example.org", subject: "Your tomola login" });
    expect(en.html).toBeUndefined();
    expect(en.text).toContain(url);
    expect(en.text).toContain("15 minutes");
    const ja = magicLinkMail({ to: "a@example.org", url, code: "123456", locale: "ja" });
    expect(ja.subject).toBe("tomolaのログイン");
    expect(ja.text).toContain(url);
    expect(ja.text).toContain("15分");
    expect(ja.text).not.toMatch(/[A-Za-z]{4,} [A-Za-z]{4,} [A-Za-z]{4,}/);
  });

  it("speaks of signing up, not of logging in, when asked for from an invitation page", () => {
    const en = magicLinkMail({ to: "a@example.org", url, code: "123456", locale: "en", invitation: true });
    expect(en.subject).toBe("Signing up for tomola");
    expect(en.text).toContain(url);
    expect(en.text).toContain("123 456");
    expect(en.text).not.toMatch(/log in/i);
    const ja = magicLinkMail({ to: "a@example.org", url, code: "123456", locale: "ja", invitation: true });
    expect(ja.subject).toBe("tomola への登録");
    expect(ja.text).toContain("15分");
  });

  it("only accepts the supported locales", () => {
    expect(mailLocale("ja")).toBe("ja");
    expect(mailLocale("en")).toBe("en");
    // The nine supported languages; reject other and case variants.
    for (const locale of ["fr", "de", "zh-Hant", "zh-Hans", "ko", "th", "vi"]) expect(mailLocale(locale), locale).toBe(locale);
    for (const bad of ["xx", "zh", "zh-hant", "", null, undefined, 1, "JA"]) expect(mailLocale(bad), String(bad)).toBeNull();
  });
});
