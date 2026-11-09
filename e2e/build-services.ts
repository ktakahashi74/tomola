import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { startFakeSmtp, type ReceivedMail } from "../e2e-prod/support/fake-smtp";
import { makeSelfSignedCert } from "../e2e-prod/support/tls-proxy";
import { assertPortFree } from "./support";

// Local services for running the ordinary fixture inventory against a build.
export async function startBuildServices({ dir, logFile, port }: { dir: string; logFile: string; port: number }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65533) throw new Error("E2E_PORT leaves no room for local build services");
  await assertPortFree(port + 1);
  await assertPortFree(port + 2);
  const mailFile = path.join(dir, "mails.jsonl");
  fs.writeFileSync(mailFile, "");
  const smtp = await startFakeSmtp({ port: port + 2, outFile: mailFile });
  // Keep the existing log-offset mail helpers. Only synthetic local SMTP mail
  // is mirrored; the product still uses its production SMTP transport.
  let offset = 0;
  const mirror = () => {
    const bytes = fs.readFileSync(mailFile);
    const text = bytes.subarray(offset).toString("utf8");
    offset = bytes.length;
    for (const line of text.split("\n").filter(Boolean)) {
      const mail = JSON.parse(line) as ReceivedMail;
      for (const to of mail.to) fs.appendFileSync(logFile, `[mail] to=${to} subject=${mail.subject}\n${mail.text.replace(/\r\n/g, "\n")}\n[/mail]\n`);
    }
  };
  const timer = setInterval(mirror, 25);
  timer.unref();
  let proxy: https.Server | undefined;
  const close = async () => {
    clearInterval(timer);
    mirror();
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise<void>(resolve => proxy!.close(() => resolve()));
    }
    await smtp.close();
  };
  try {
    const { key, cert } = makeSelfSignedCert(dir);
    proxy = https.createServer({ key, cert }, (req, res) => {
      // These tests supply distinct synthetic client addresses to exercise rate
      // limits. The proxy binds only to loopback and retains those addresses.
      const headers = { ...req.headers, "x-forwarded-for": req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "", "x-forwarded-proto": "https" };
      const upstream = http.request({ host: "127.0.0.1", port: port + 1, method: req.method, path: req.url, headers }, up => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    await new Promise<void>((resolve, reject) => {
      proxy!.once("error", reject);
      proxy!.listen(port, "127.0.0.1", resolve);
    });
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
