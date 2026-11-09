// Checks and preparation run once when the server process starts (when the server build is loaded); imported by app/entry.server.tsx.
// Fail startup on invalid configuration before the first request. The development server loads this module on the first request.
import { installSocketAddressHook } from "~/lib/http/client-ip.server";
import { assertStartupConfig } from "~/lib/startup-checks.server";

// Mail configuration, TRUSTED_PROXY_HOPS, and, in production, the signing secret and site URL.
assertStartupConfig();
// Attach the directly connected peer address to the request (app/lib/http/client-ip.server.ts).
installSocketAddressHook();
