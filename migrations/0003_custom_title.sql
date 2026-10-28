-- Per-user display name for a paper in the library (NULL = the paper's own title).
ALTER TABLE library ADD COLUMN custom_title TEXT;
