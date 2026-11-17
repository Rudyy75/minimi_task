CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);
CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  seq INTEGER NOT NULL,
  client_message_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  time_zone TEXT NOT NULL,
  local_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('committed', 'partial', 'cancelled')),
  run_id TEXT,
  model TEXT,
  content_sha256 TEXT NOT NULL,
  UNIQUE (conversation_id, seq),
  UNIQUE (conversation_id, client_message_id)
);
CREATE INDEX turns_conversation_time ON turns(conversation_id, created_at_ms, seq);
CREATE INDEX turns_conversation_local_date ON turns(conversation_id, local_date, role);
CREATE VIRTUAL TABLE turn_fts USING fts5(turn_id UNINDEXED, content, tokenize = 'unicode61');
CREATE TABLE temporal_anchors (
  id TEXT PRIMARY KEY,
  request_turn_id TEXT NOT NULL REFERENCES turns(id),
  raw_text TEXT NOT NULL,
  resolver_version TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  start_utc TEXT NOT NULL,
  end_utc_exclusive TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms_exclusive INTEGER NOT NULL,
  policy TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  ambiguous INTEGER NOT NULL CHECK (ambiguous IN (0, 1))
);
CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  opened_turn_id TEXT NOT NULL REFERENCES turns(id),
  answer_turn_id TEXT REFERENCES turns(id),
  occurred_at_utc TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX episodes_opened_time ON episodes(conversation_id, occurred_at_ms);
CREATE TABLE episode_turns (
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  turn_id TEXT NOT NULL REFERENCES turns(id),
  relation TEXT NOT NULL,
  PRIMARY KEY (episode_id, turn_id, relation)
);
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
  official_domains_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  UNIQUE (kind, canonical_name)
);
CREATE TABLE episode_entities (
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  ordinal INTEGER NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (episode_id, entity_id, role)
);
CREATE TABLE search_calls (
  id TEXT PRIMARY KEY,
  request_turn_id TEXT NOT NULL REFERENCES turns(id),
  wave INTEGER NOT NULL,
  query TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  attempt_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  provider_latency_ms INTEGER,
  error_code TEXT
);
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  episode_id TEXT REFERENCES episodes(id),
  answer_turn_id TEXT REFERENCES turns(id),
  captured_at_utc TEXT NOT NULL,
  captured_at_ms INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  answer_sha256 TEXT
);
CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  search_call_id TEXT REFERENCES search_calls(id),
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  domain TEXT NOT NULL,
  title TEXT NOT NULL,
  snippet TEXT NOT NULL,
  published_at_utc TEXT,
  published_precision TEXT CHECK (published_precision IS NULL OR published_precision IN ('second', 'day', 'month', 'unknown')),
  retrieved_at_utc TEXT NOT NULL,
  retrieved_at_ms INTEGER NOT NULL,
  result_rank INTEGER,
  content_sha256 TEXT NOT NULL,
  raw_payload_json TEXT NOT NULL
);
CREATE INDEX evidence_search_call ON evidence(search_call_id, result_rank);
CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  entity_id TEXT REFERENCES entities(id),
  predicate TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  identity_key TEXT NOT NULL,
  comparability_key TEXT NOT NULL,
  observed_at_utc TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  effective_at_utc TEXT,
  effective_precision TEXT,
  extraction_method TEXT NOT NULL,
  extraction_confidence REAL NOT NULL,
  normalization_version TEXT NOT NULL,
  claim_hash TEXT NOT NULL
);
CREATE INDEX claims_snapshot_entity ON claims(snapshot_id, entity_id, predicate);
CREATE TABLE claim_evidence (
  claim_id TEXT NOT NULL REFERENCES claims(id),
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  stance TEXT NOT NULL CHECK (stance IN ('supports', 'contradicts')),
  quote TEXT NOT NULL,
  quote_start INTEGER,
  quote_end INTEGER,
  PRIMARY KEY (claim_id, evidence_id, stance)
);
CREATE TABLE verifications (
  id TEXT PRIMARY KEY,
  request_turn_id TEXT NOT NULL REFERENCES turns(id),
  baseline_claim_id TEXT REFERENCES claims(id),
  current_claim_id TEXT REFERENCES claims(id),
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  materiality TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);
CREATE TABLE verification_evidence (
  verification_id TEXT NOT NULL REFERENCES verifications(id),
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  PRIMARY KEY (verification_id, evidence_id)
);
CREATE TABLE run_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at_ms INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  duration_ms INTEGER,
  event_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
