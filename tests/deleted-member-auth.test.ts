import { eq } from "drizzle-orm";
import { expect,it,vi } from "vitest";
import { createAuth,createAppAuth } from "~/lib/auth/auth.server";
import { isKnownAddress,settleMagicLinkMail } from "~/lib/auth/magic-link.server";
import { createProfile } from "~/lib/profiles.server";
import { createInvitation } from "~/lib/invitations.server";
import { DELETED_MEMBER_ID } from "~/lib/deleted-member";
import { user,profiles,session } from "~/lib/db/schema";
import { createMailer } from "~/lib/mail/mail.server";
import { createMemoryMailbox } from "~/lib/mail/transports.server";
import { createTestDb,addMember } from "./helpers/db";
vi.mock("~/paraglide/messages.js",async()=>({m:(await import("./helpers/messages-json")).jsonMessages()}));
const EMAIL="deleted-member@invalid.invalid",BASE="http://localhost:5173",SECRET="test-secret-0123456789abcdef0123456789abcdef";
it("keeps malformed login input as a client error",async()=>{
 const db=await createTestDb();const auth=createAuth(db,{baseURL:BASE,secret:SECRET,sendMagicLink:async()=>{}});
 const response=await auth.handler(new Request(`${BASE}/api/auth/sign-in/magic-link`,{method:"POST",headers:{"content-type":"application/json",origin:BASE},body:JSON.stringify({email:17})}));
 expect(response.status).toBe(400);
});
it("does not send mail or accept profile creation for the shared identity, preserving normal onboarding",async()=>{
 const db=await createTestDb();await db.insert(user).values({id:DELETED_MEMBER_ID,email:EMAIL,name:""});
 expect(await isKnownAddress(db," DELETED-MEMBER@INVALID.INVALID ")).toBe(false);
 const box=createMemoryMailbox();const auth=createAppAuth(db,{baseURL:BASE,secret:SECRET,mailer:()=>createMailer(box.transport,"noreply@example.com"),isKnown:async()=>true});
 expect(await auth.api.signInMagicLink({body:{email:EMAIL},headers:new Headers()})).toEqual({status:true});await settleMagicLinkMail();expect(box.sent).toHaveLength(0);
 expect((await createProfile(db,DELETED_MEMBER_ID,{handle:"quit_hijack",homeArea:"en",readLangs:["en"]})).ok).toBe(false);
 expect(await db.select().from(profiles)).toEqual([]);
 await expect(createInvitation(db,{email:EMAIL.toUpperCase()})).rejects.toThrow();
 await db.insert(user).values({id:"ordinary-onboarding",email:"new@example.com",name:""});
 expect((await createProfile(db,"ordinary-onboarding",{handle:"quit_normal",homeArea:"en",readLangs:["en"]})).ok).toBe(true);
});
it("refuses existing reserved-user magic tokens at session creation even after the ID email changes",async()=>{
 const db=await createTestDb();await db.insert(user).values({id:DELETED_MEMBER_ID,email:"changed@example.com",name:""});
 const sent:string[]=[];const auth=createAuth(db,{baseURL:BASE,secret:SECRET,sendMagicLink:async({token})=>{sent.push(token);}});
 await auth.api.signInMagicLink({body:{email:"changed@example.com"},headers:new Headers()});
 const result=await auth.api.magicLinkVerify({query:{token:sent[0]},headers:new Headers(),asResponse:true});
 expect(result.status).not.toBe(200);expect(await db.select().from(session)).toHaveLength(0);
});

it.each([true,false])("rejects valid UV passkeys for a reserved ID or normalized address (%s), with a legitimate control",async reservedId=>{
 const db=await createTestDb();const id=reservedId?DELETED_MEMBER_ID:"poisoned-address";
 await db.insert(user).values({id,email:reservedId?"changed@example.com":"DELETED-MEMBER@INVALID.INVALID",name:""});
 const {signingCredential}=await import("./helpers/signing");const key=await signingCredential(db,id);
 const auth=createAuth(db,{baseURL:BASE,secret:SECRET,sendMagicLink:async()=>{}});
 const attempt=async(credential:typeof key)=>{
  const {response:options,headers}=await auth.api.generatePasskeyAuthenticationOptions({headers:new Headers(),returnHeaders:true});
  const cookie=headers.getSetCookie().map(c=>c.split(";")[0]).join("; ");
  return auth.api.verifyPasskeyAuthentication({headers:new Headers({cookie}),body:{response:credential.assert(options.challenge)}});
 };
 await expect(attempt(key)).rejects.toBeDefined();expect(await db.select().from(session)).toHaveLength(0);
 expect((await createProfile(db,id,{handle:"quit_bad",homeArea:"en",readLangs:["en"]})).ok).toBe(false);
 await addMember(db,"valid-passkey","quit_valid");const ordinary=await signingCredential(db,"valid-passkey");
 await attempt(ordinary);expect(await db.select().from(session).where(eq(session.userId,"valid-passkey"))).toHaveLength(1);
});

it("rejects old cookies after their user's address becomes reserved",async()=>{
 const {setupRouteHarness}=await import("./helpers/route-harness");const h=await setupRouteHarness();
 try { const id=await h.signIn("quit_poisoned");const {getAuth}=await import("~/lib/auth/auth.server");const auth=await getAuth();
  const request=()=>h.request("/settings",{as:"quit_poisoned"});expect(await auth.api.getSession({headers:request().headers})).not.toBeNull();
  await h.db.update(user).set({email:EMAIL}).where(eq(user.id,id));
  expect(await auth.api.getSession({headers:request().headers})).toBeNull();
 } finally {h.restore();}
});

it("rejects stored reserved-address magic tokens and code verification, including legacy invitations",async()=>{
 const db=await createTestDb();await db.insert(user).values({id:DELETED_MEMBER_ID,email:EMAIL,name:""});
 const {randomBytes}=await import("node:crypto");const {hashMagicLinkToken}=await import("~/lib/auth/plugins");
 const {verification,invitations}=await import("~/lib/db/schema");const {issueLoginCode,decodeLoginCode}=await import("~/lib/auth/login-code.server");
 const {findValidInvitationByToken,markInvitationUsed,hashInvitationToken}=await import("~/lib/invitations.server");
 const {parseEmail}=await import("~/lib/email");
 const token="old-reserved-token",nonce=randomBytes(32).toString("base64url"),id=randomBytes(32).toString("base64url");
 await db.insert(verification).values({id:"old-reserved",identifier:`magic-link:${hashMagicLinkToken(token)}`,value:JSON.stringify({type:"magic-link",email:EMAIL}),expiresAt:new Date(Date.now()+600000)});
 const code=await issueLoginCode(db,{id,email:"previous@example.com",token,nonce,secret:SECRET});
 expect(await decodeLoginCode(db,{id,code,nonce,ip:null})).toBeNull();
 await expect(issueLoginCode(db,{id:"unused",email:EMAIL,token,nonce,secret:SECRET})).rejects.toThrow();
 const auth=createAuth(db,{baseURL:BASE,secret:SECRET,sendMagicLink:async()=>{}});
 expect((await auth.api.magicLinkVerify({query:{token},headers:new Headers(),asResponse:true})).status).not.toBe(200);
 expect(await db.select().from(session)).toHaveLength(0);
 await db.insert(invitations).values({id:"old-reserved-invite",email:EMAIL.toUpperCase(),tokenHash:hashInvitationToken("reserved-invite"),expiresAt:new Date(Date.now()+86400000)});
 expect(await findValidInvitationByToken(db,"reserved-invite")).toBeNull();expect(await markInvitationUsed(db,EMAIL)).toBe(0);
 expect(parseEmail(` ${EMAIL.toUpperCase()} `)).toBeNull();
});
