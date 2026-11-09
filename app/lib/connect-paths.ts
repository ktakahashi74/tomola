// Where the guide for AI tools lives, the page for people, and where a person cancels a connection. Shared by the server (the steps) and the pages.
export const CONNECT_PATH = "/connect";
export const CONNECT_MD_PATH = "/connect.md";
export const CONNECTIONS_SETTINGS_PATH = "/settings/connections";

// Consent and authorization-server scopes include refresh permission. Protected resources advertise only the scopes needed to use their tools.
export const MCP_SCOPES = ["read", "draft", "offline_access"] as const;

export const MCP_RESOURCE_SCOPES = ["read", "draft"] as const;
