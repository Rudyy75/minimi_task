CREATE TABLE embeddings (
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  vector_blob BLOB NOT NULL,
  content_sha256 TEXT NOT NULL,
  PRIMARY KEY (owner_type, owner_id, model)
);
