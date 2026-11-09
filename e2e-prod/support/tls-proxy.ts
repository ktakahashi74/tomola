import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";

// A small local reproduction of production (TLS-terminating reverse proxy such as Caddy, then app): accept HTTPS with a self-signed certificate and forward HTTP to the app.
// Preserve Host, replace X-Forwarded-For with the single connecting peer address (Caddy default; TRUSTED_PROXY_HOPS=1), and add X-Forwarded-Proto: https.
// Production requires an https BETTER_AUTH_URL, so browser testing of the production build needs this proxy. Chromium accepts it with ignoreHTTPSErrors; localhost is a secure context and passkeys work.

export function makeSelfSignedCert(dir: string): { key: string; cert: string } {
  const keyFile = path.join(dir, "key.pem");
  const certFile = path.join(dir, "cert.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
    { stdio: "ignore" },
  );
  return { key: fs.readFileSync(keyFile, "utf8"), cert: fs.readFileSync(certFile, "utf8") };
}

export async function startTlsProxy(opts: { port: number; targetPort: number; key: string; cert: string }): Promise<{ close(): Promise<void> }> {
  const server = https.createServer({ key: opts.key, cert: opts.cert }, (req, res) => {
    const headers = { ...req.headers, "x-forwarded-for": req.socket.remoteAddress ?? "", "x-forwarded-proto": "https" };
    const upstream = http.request({ host: "127.0.0.1", port: opts.targetPort, method: req.method, path: req.url, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", resolve);
  });
  return { close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

// Choose a free port: listen on 0 and return the assigned number.
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}
