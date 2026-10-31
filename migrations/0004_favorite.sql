-- Papers the user starred; the library's Favorites tab lists them.
ALTER TABLE library ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
