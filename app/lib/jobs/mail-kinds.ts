export const SEND_ACCOUNT_DELETED_JOB = "send_account_deleted";
export const SEND_NOTIFICATION_EMAIL_JOB = "send_notification_email";
export const SEND_MEMBER_DIGEST_JOB = "send_member_digest";
export const SEND_DIGEST_JOB = "send_digest";
export const SEND_PASSKEY_NOTICE_JOB = "send_passkey_notice";

// Mail precedes translation and other queued work.
export const MAIL_JOB_KINDS = [SEND_ACCOUNT_DELETED_JOB, SEND_NOTIFICATION_EMAIL_JOB, SEND_DIGEST_JOB, SEND_MEMBER_DIGEST_JOB, SEND_PASSKEY_NOTICE_JOB] as const;
