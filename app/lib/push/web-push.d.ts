// Only the library surface used by the isolated sender. No additional runtime or
// development dependency is needed for this untyped upstream package.
declare module "web-push" {
  export function generateRequestDetails(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, options: {
    TTL: number; urgency: "normal"; topic: string; contentEncoding: "aes128gcm";
    vapidDetails: { subject: string; publicKey: string; privateKey: string };
  }): { headers: Record<string, string | number>; body: Buffer };
}
