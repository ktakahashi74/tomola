import { addMember, createTestDb } from './db';

export async function createMemberDb(members: Array<{ id: string; handle: string; options?: Parameters<typeof addMember>[3] }>) {
  const db = await createTestDb();
  for (const { id, handle, options } of members) await addMember(db, id, handle, options);
  return db;
}
