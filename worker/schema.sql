-- maedori D1 schema
CREATE TABLE IF NOT EXISTS sections (
  name TEXT PRIMARY KEY,
  pos  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id         TEXT PRIMARY KEY,           -- s01… (cut from sample.mp4), w01… (added stills), u… (uploads)
  kind       TEXT NOT NULL CHECK (kind IN ('video', 'image')),
  section    TEXT NOT NULL REFERENCES sections(name),
  pos        INTEGER NOT NULL,           -- order within the whole page (sorted, then grouped by section)
  note       TEXT NOT NULL DEFAULT '',
  done       INTEGER NOT NULL DEFAULT 0, -- 1 = 撮影済み
  w          INTEGER,
  h          INTEGER,
  src_start  REAL,                       -- seconds in sample.mp4 (clips only)
  src_end    REAL,
  media      TEXT NOT NULL,              -- R2 key
  poster     TEXT,                       -- R2 key of a still (videos) or the image itself
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS items_section_pos ON items (section, pos);

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
