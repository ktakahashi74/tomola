# Rebuild topic listing statistics

Use the configured, migrated database. Stop a PGlite web/worker process before opening its directory with this command.

Preview missing, stale and unexpected derived rows without changing data:

```sh
pnpm exec tsx scripts/rebuild-topic-listing-stats.ts
```

Apply the repair explicitly:

```sh
pnpm exec tsx scripts/rebuild-topic-listing-stats.ts --write
```

The JSON result reports the differences found before repair. Posts and votes are preserved, including votes excluded from counted totals. A write briefly blocks changes to posts, votes, profiles and their listing statistics, and commits the repair atomically. Run during a quiet period; lock acquisition fails after five seconds, allowing a later retry. Preview again after applying to confirm all three difference counts are zero.
