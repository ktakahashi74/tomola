// For subprocess script tests of pnpm glossary:import/export, create one member in PGLITE_DATA_DIR. Arguments: user ID, email and handle.
import { getDb } from "../../app/lib/db/client.server";
import { user } from "../../app/lib/db/schema";
import { createProfile } from "../../app/lib/profiles.server";

const [id, email, handle] = process.argv.slice(2);
const db = await getDb();
await db.insert(user).values({ id, name: "", email, emailVerified: true });
const created = await createProfile(db, id, { handle, homeArea: "ja", readLangs: ["ja"] });
if (!created.ok) throw new Error(`profile failed: ${created.error}`);
process.exit(0);
