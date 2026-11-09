import { acceptTrialFixture } from "./trial-fixture";
import fs from "node:fs";
import path from "node:path";
import { createAuth } from "../app/lib/auth/auth.server";
import { authSecret } from "../app/lib/auth/secret.server";
import type { Db } from "../app/lib/db/client.server";
import { createInvitation } from "../app/lib/invitations.server";
import { createProfile } from "../app/lib/profiles.server";
import { MEMBER_FIXTURES, VILLAGE_MEMBER_FIXTURES, type SeedMember } from "./member-fixtures";
import { villagesEnabled } from "../app/lib/villages-enabled.server";

export async function seedMembers(db: Db, dir: string, baseURL: string, members: readonly SeedMember[] = MEMBER_FIXTURES.filter(member => villagesEnabled() || !VILLAGE_MEMBER_FIXTURES.includes(member))) {
  const destination = path.join(dir, "members");
  fs.mkdirSync(destination, { recursive: true });
  let token = "";
  const auth = createAuth(db, { baseURL, secret: authSecret(), sendMagicLink: async args => { token = args.token; } });
  for (const member of members) {
    await createInvitation(db, { email: member.email });
    await auth.api.signInMagicLink({ body: { email: member.email }, headers: new Headers() });
    const response = await auth.api.magicLinkVerify({ query: { token, callbackURL: "/" }, headers: new Headers(), asResponse: true });
    if (response.status !== 302) throw new Error(`Seed login failed for ${member.email}`);
    const cookies = response.headers.getSetCookie().map(header => {
      const [pair, ...attributes] = header.split(";").map(value => value.trim());
      const split = pair.indexOf("=");
      const maxAge = attributes.find(value => value.toLowerCase().startsWith("max-age="));
      return { name: pair.slice(0, split), value: pair.slice(split + 1), domain: new URL(baseURL).hostname, path: "/", expires: maxAge ? Math.floor(Date.now() / 1000) + Number(maxAge.slice(8)) : -1, httpOnly: attributes.includes("HttpOnly"), secure: attributes.includes("Secure"), sameSite: "Lax" };
    });
    const current = await auth.api.getSession({ headers: new Headers({ Cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ") }) });
    if (!current) throw new Error(`Seed session missing for ${member.email}`);
    const profile = await createProfile(db, current.user.id, { handle: member.handle, homeArea: member.homeArea, ...(member.readLangs ? { readLangs: member.readLangs } : {}) }, { uiLocale: member.uiLocale });
    if (!profile.ok) throw new Error(`Seed profile failed for ${member.email}: ${profile.error}`);
    await acceptTrialFixture(db, current.user.id);
    fs.writeFileSync(path.join(destination, `${member.email}.json`), JSON.stringify({ cookies, origins: [] }));
  }
}
