-- 2026-11-28: 撮影済み flag; new 今日撮影 section at the top; rename Waylon -> 時間があれば; tags.
-- Run once: npx wrangler d1 execute maedori --remote --file migrations/2026-11-28-done-sections.sql
ALTER TABLE items ADD COLUMN done INTEGER NOT NULL DEFAULT 0;

-- rename (items reference sections(name), so add the new name, repoint items, then drop the old one)
INSERT OR IGNORE INTO sections (name, pos) SELECT '時間があれば', pos FROM sections WHERE name = 'Waylon';
UPDATE items SET section = '時間があれば' WHERE section = 'Waylon';
DELETE FROM sections WHERE name = 'Waylon';

-- 今日撮影 first
UPDATE sections SET pos = pos + 1;
INSERT OR IGNORE INTO sections (name, pos) VALUES ('今日撮影', 0);

-- tags (e.g. 顔アップ, 足元): a shared list, attached to items
CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  pos  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS item_tags (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);
INSERT OR IGNORE INTO tags (name, pos) VALUES ('顔アップ', 0), ('足元', 1);
