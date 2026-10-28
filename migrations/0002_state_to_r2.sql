-- Reading state moved to R2 (users/<uid>/<key>.json); the table keeps library metadata only.
ALTER TABLE library DROP COLUMN state;
