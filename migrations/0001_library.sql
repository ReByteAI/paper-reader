-- One row per (user, paper): the user's library entry plus their reading state as JSON.
CREATE TABLE IF NOT EXISTS library (
  user_id     TEXT NOT NULL,
  key         TEXT NOT NULL,
  title       TEXT,
  authors     TEXT,     -- JSON array
  state       TEXT,     -- JSON: highlights, explanations, comments, notes, chat, ...
  last_opened INTEGER,
  last_page   INTEGER,
  highlights  INTEGER,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS library_recent ON library (user_id, last_opened DESC);
