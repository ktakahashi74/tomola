import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { describe, expect, it } from 'vitest';
import { migrationsFolder } from '~/lib/db/client.server';
import { migrateDatabase } from '~/lib/db/migrate.server';
import { createScratchDb, REAL_PG_URL } from './helpers/pg-real';

// A fixed historical checkpoint keeps backfills and changed constraints in the upgrade path.
const CHECKPOINT = '0073_translation_retry_fields';
describe.skipIf(!REAL_PG_URL)('upgrade a populated historical PostgreSQL database', { tags: ['postgres'] }, () => {
  it('preserves authored data, backfills derived rows and priorities, and is idempotent', { timeout: 60_000 }, async () => {
    const scratch = await createScratchDb({ migrate: false });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tomola-old-migrations-'));
    const pool = new pg.Pool({ connectionString: scratch.url, max: 2 });
    try {
      const folder = migrationsFolder();
      const journal = JSON.parse(fs.readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8'));
      const last = journal.entries.findIndex((entry: {tag: string}) => entry.tag === CHECKPOINT);
      expect(last).toBeGreaterThan(0);
      expect(last).toBeLessThan(journal.entries.length - 1);
      const entries = journal.entries.slice(0, last + 1);
      fs.mkdirSync(path.join(directory, 'meta'));
      fs.writeFileSync(path.join(directory, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
      for (const entry of entries) fs.copyFileSync(path.join(folder, `${entry.tag}.sql`), path.join(directory, `${entry.tag}.sql`));
      await migrate(drizzle(pool), { migrationsFolder: directory });
      const mediaId = 'a'.repeat(64);
      await pool.query(`INSERT INTO "user" (id, name, email, email_verified) VALUES ('upgrade-author', 'Fixture', 'upgrade@example.invalid', true)`);
      await pool.query(`INSERT INTO profiles (user_id, handle, handle_key, home_area) VALUES ('upgrade-author', 'upgrade_author', 'upgrade_author', 'ja')`);
      await pool.query(`INSERT INTO media (id, bytes, mime, width, height, byte_size, uploaded_by) VALUES ($1, $2, 'image/webp', 1, 1, 1, 'upgrade-author')`, [mediaId, Buffer.from([0])]);
      const body = `Original fixture ![image](/media/${mediaId}-1x1.webp)`;
      const topic = (await pool.query(`INSERT INTO entries (kind, author_id, lang, title, body, source_hash) VALUES ('topic', 'upgrade-author', 'ja', 'Historical topic', $1, 'fixture-hash') RETURNING id`, [body])).rows[0].id;
      await pool.query(`INSERT INTO entries (kind, author_id, lang, body, thread_id, source_hash) VALUES ('reply', 'upgrade-author', 'en', 'Historical reply', $1, 'reply-hash')`, [topic]);
      await pool.query(`INSERT INTO drafts (author_id, kind, lang, body) VALUES ('upgrade-author', 'topic', 'ja', 'Unpublished fixture')`);
      await pool.query(`INSERT INTO translations (entry_id, field, lang, kind, text) VALUES ($1, 'body', 'en', 'primary', 'Historical translation')`, [topic]);
      await pool.query(`INSERT INTO jobs (kind, payload) VALUES ('send_notification_email', '{"fixture":1}'), ('translate_title', '{"fixture":2}'), ('embed_entry', '{"fixture":3}')`);
      const before = (await pool.query(`SELECT id, kind, thread_id, title, body, author_id FROM entries ORDER BY id`)).rows;
      const started = performance.now();
      await migrateDatabase({ kind: 'pg', url: scratch.url });
      expect((await pool.query(`SELECT id, kind, thread_id, title, body, author_id FROM entries ORDER BY id`)).rows).toEqual(before);
      expect((await pool.query(`SELECT body FROM drafts`)).rows).toEqual([{ body: 'Unpublished fixture' }]);
      expect((await pool.query(`SELECT text FROM translations`)).rows).toEqual([{ text: 'Historical translation' }]);
      expect((await pool.query(`SELECT kind, priority FROM jobs ORDER BY id`)).rows).toEqual([
        { kind: 'send_notification_email', priority: 0 }, { kind: 'translate_title', priority: 1 }, { kind: 'embed_entry', priority: 2 },
      ]);
      expect((await pool.query(`SELECT entry_id, media_id FROM entry_media`)).rows).toEqual([{ entry_id: topic, media_id: mediaId }]);
      const count = Number((await pool.query(`SELECT count(*) FROM drizzle.__drizzle_migrations`)).rows[0].count);
      expect(count).toBe(journal.entries.length);
      await migrateDatabase({ kind: 'pg', url: scratch.url });
      expect(Number((await pool.query(`SELECT count(*) FROM drizzle.__drizzle_migrations`)).rows[0].count)).toBe(count);
      console.log(`Populated upgrade and idempotence: ${Math.round(performance.now() - started)} ms`);
    } finally {
      await pool.end();
      await scratch.drop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
