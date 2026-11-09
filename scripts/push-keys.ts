import { generateVapidKeys } from "../app/lib/push/config.server";

// Run only for an operator choosing a new environment-specific VAPID pair.
// This tool does not read environment files, contact providers or change config.
const keys = generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log("# Set VAPID_SUBJECT to a public mailto: or https: operator contact.");
