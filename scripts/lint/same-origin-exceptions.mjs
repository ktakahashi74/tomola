export const SAME_ORIGIN_EXCEPTIONS = {
  'api.auth.ts': 'Passkey and OAuth endpoints authenticate their own credentials in the auth handler.',
  'api.drafts.ts': 'Draft writes authenticate a Bearer token instead of a browser session.',
  'mcp.ts': 'Member tools authenticate Bearer or OAuth credentials in the MCP handler.',
  'mcp-public.ts': 'Anonymous read-only MCP tools never change member content.',
  'home.tsx': 'The action always returns 405 and writes no data.',
  'villages.tsx': 'The action only returns 404 or 405 and writes no data.',
  'not-found.tsx': 'The action always throws 404 and writes no data.',
  'villages-md.ts': 'Re-exports the not-found action, which always throws 404.',
  'push.ts': 'handlePushRequest checks the exact origin before authentication or writes.',
};
