import { m } from "~/paraglide/messages.js";

// What a login request that sent nothing says. Two causes only; no reason is given for "later" (a limit, a failed delivery), and the two look alike apart from the words.
// The id lets the address field point at it.
export const LOGIN_REQUEST_NOTICE_ID = "login-request-notice";
export function loginRequestNoticeShown(status: string | undefined): boolean {
  return status === "unregistered" || status === "later";
}
// mcp: the screen is part of connecting an AI, whose side stops waiting after a few minutes; a "later" answer then says so.
export function LoginRequestNotice({ status, mcp = false }: { status: string | undefined; mcp?: boolean }) {
  if (status === "unregistered") return <p id={LOGIN_REQUEST_NOTICE_ID} role="alert" className="text-destructive">{m.login_not_registered()}</p>;
  if (status === "later") return <><p id={LOGIN_REQUEST_NOTICE_ID} role="alert" className="text-destructive">{m.login_try_later()}</p>{mcp && <p className="ui-help text-muted-foreground">{m.mcp_login_later_note()}</p>}</>;
  return null;
}
