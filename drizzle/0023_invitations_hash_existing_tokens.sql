-- Data migration (custom migration): 0022 renamed token to token_hash. Existing rows still contain plaintext tokens.
-- Replace them with hex SHA-256 of the token's UTF-8 bytes, matching hashInvitationToken in app/lib/invitations.server.ts.
-- Plaintext tokens are 43 characters (32 bytes in base64url); hashes are 64. Distinguish by length and leave already-hashed rows untouched.
UPDATE "invitations"
SET "token_hash" = encode(sha256(convert_to("token_hash", 'UTF8')), 'hex')
WHERE length("token_hash") <> 64;
