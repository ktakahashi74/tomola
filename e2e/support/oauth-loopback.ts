import http from "node:http";
import type { AddressInfo } from "node:net";

// Native OAuth uses a real HTTP loopback listener independently of the site's
// HTTPS origin. It never asks the app to serve a client callback route.
export async function oauthLoopback() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end("<title>OAuth callback fixture</title>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    redirectURI: `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
