type AuthenticationModule = Pick<typeof import("@simplewebauthn/browser"), "startAuthentication">;

export function createSigningAuthenticationLoader(load: () => Promise<AuthenticationModule> = () => import("@simplewebauthn/browser")) {
  let pending: Promise<AuthenticationModule["startAuthentication"]> | undefined;
  return () => pending ??= load().then(module => module.startAuthentication).catch(error => {
    pending = undefined;
    throw error;
  });
}

export const loadSigningAuthentication = createSigningAuthenticationLoader();
