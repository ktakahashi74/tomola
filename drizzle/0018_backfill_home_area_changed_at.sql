-- Data migration (custom migration): 0017 made home_area_changed_at nullable and removed its default.
-- At signup it was set to created_at (there was no area-change screen, so no rows differ yet). This means never changed; replace it with null.
UPDATE "profiles" SET "home_area_changed_at" = NULL WHERE "home_area_changed_at" = "created_at";
