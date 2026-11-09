import fs from "node:fs";
import net from "node:net";

// Local fake SMTP for production-build tests; never sends externally. Append received messages as JSON lines:
//   { to: [recipients...], from, subject, text }
// Used to verify production startup: SMTP_URL and MAIL_FROM are required, and development stdout delivery is not allowed in production.
// No authentication or STARTTLS: local connections only. SMTP_URL=smtp://127.0.0.1:<port> does not require encryption for a local peer.
export type ReceivedMail = { to: string[]; from: string; subject: string; text: string };

function decodeQuotedPrintable(input: string): Buffer {
  const joined = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...Buffer.from(joined[i], "utf8"));
  }
  return Buffer.from(bytes);
}

// RFC 2047 subjects (=?UTF-8?B?...?= and =?UTF-8?Q?...?=).
export function decodeHeader(value: string): string {
  return value
    .replace(/\r?\n[ \t]+/g, " ")
    // RFC 2047: whitespace separating adjacent encoded words is not content.
    .replace(/(=\?utf-8\?[bq]\?[^?]*\?=)\s+(?==\?utf-8\?[bq]\?)/gi, "$1")
    .replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_m, kind: string, data: string) =>
      kind.toLowerCase() === "b" ? Buffer.from(data, "base64").toString("utf8") : decodeQuotedPrintable(data.replace(/_/g, " ")).toString("utf8"),
    );
}

export function parseMessage(raw: string): { headers: Record<string, string>; text: string } {
  const split = raw.indexOf("\r\n\r\n");
  const head = split >= 0 ? raw.slice(0, split) : raw;
  const body = split >= 0 ? raw.slice(split + 4) : "";
  const headers: Record<string, string> = {};
  for (const block of head.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const colon = block.indexOf(":");
    if (colon > 0) headers[block.slice(0, colon).toLowerCase()] = block.slice(colon + 1).trim();
  }
  const encoding = (headers["content-transfer-encoding"] ?? "7bit").toLowerCase();
  const text =
    encoding === "base64"
      ? Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8")
      : encoding === "quoted-printable"
        ? decodeQuotedPrintable(body).toString("utf8")
        : body;
  return { headers, text };
}

export async function startFakeSmtp(opts: { port?: number; outFile: string }): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((socket) => {
    let inData = false;
    let data = "";
    let buffer = "";
    let from = "";
    let to: string[] = [];
    socket.on("error", () => {});
    socket.write("220 localhost ESMTP fake\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          const { headers, text } = parseMessage(data.replace(/\r\n\.\./g, "\r\n."));
          const mail: ReceivedMail = { to, from, subject: decodeHeader(headers.subject ?? ""), text };
          fs.appendFileSync(opts.outFile, `${JSON.stringify(mail)}\n`);
          socket.write("250 OK queued\r\n");
          continue;
        }
        const eol = buffer.indexOf("\r\n");
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") socket.write("250 localhost\r\n");
        else if (cmd === "MAIL") {
          from = /<([^>]*)>/.exec(line)?.[1] ?? "";
          to = [];
          socket.write("250 OK\r\n");
        } else if (cmd === "RCPT") {
          to.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
          socket.write("250 OK\r\n");
        } else if (cmd === "DATA") {
          inData = true;
          data = "";
          socket.write("354 go ahead\r\n");
        } else if (cmd === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Standalone: pnpm exec tsx e2e-prod/support/fake-smtp.ts [port] [output-file].
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 2525);
  const outFile = process.argv[3] ?? "mails.jsonl";
  const smtp = await startFakeSmtp({ port, outFile });
  console.log(`fake SMTP on 127.0.0.1:${smtp.port}, appending received mail to ${outFile}`);
}
