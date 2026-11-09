import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";

// Browser-side Better Auth client, used only for passkey registration and login. Calls /api/auth/passkey/*; see the allowlist in endpoints.server.ts.
// Load dynamically when the button is pressed, excluding it from the initial page load. Omit baseURL to use /api/auth on the current origin.
export const authClient = createAuthClient({ plugins: [passkeyClient()] });
