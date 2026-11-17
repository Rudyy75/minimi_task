import type Database from "better-sqlite3";
import type { TemporalInterval } from "../time/resolve-anchor.js";

interface TurnRow {
  id: string;
  role: string;
  content: string;
  created_at_ms: number;
  seq: number;
}

interface EpisodeRow {
  id: string;
  title: string;
  kind: string;
  occurred_at_ms: number;
  payload_json: string;
}

interface EntityRow {
  id: string;
  kind: string;
  canonical_name: string;
  display_name: string;
  aliases_json: string;
  ordinal: number;
  role: string;
}

function ftsQuery(text: string): string {
  return [...new Set(text.match(/[\p{L}\p{N}]+/gu) ?? [])].map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

function episodeEntities(db: Database.Database, episodeId: string, expectedCount?: number): EntityRow[] {
  const entities = db.prepare(`SELECT e.id, e.kind, e.canonical_name, e.display_name, e.aliases_json,
      ee.ordinal, ee.role
    FROM episode_entities ee JOIN entities e ON e.id = ee.entity_id
    WHERE ee.episode_id = ? ORDER BY ee.ordinal, e.canonical_name`).all(episodeId) as EntityRow[];
  if (expectedCount !== undefined && entities.length !== expectedCount) {
    throw new Error(`Episode ${episodeId} expected ${expectedCount} entities, found ${entities.length}`);
  }
  return entities;
}

export function recallByInterval(
  db: Database.Database,
  conversationId: string,
  interval: TemporalInterval,
  query: string,
  queryVector?: { model: string; values: Float32Array },
) {
  const turns = db.prepare(`SELECT id, role, content, created_at_ms, seq FROM turns
    WHERE conversation_id = ? AND status = 'committed' AND role = 'user'
      AND created_at_ms >= ? AND created_at_ms < ? ORDER BY created_at_ms, seq`)
    .all(conversationId, interval.startMs, interval.endMsExclusive) as TurnRow[];
  const episodes = db.prepare(`SELECT id, title, kind, occurred_at_ms, payload_json FROM episodes
    WHERE conversation_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ? ORDER BY occurred_at_ms, id`)
    .all(conversationId, interval.startMs, interval.endMsExclusive) as EpisodeRow[];

  const terms = ftsQuery(query);
  let rankedIds: string[] = [];
  if (terms && episodes.length) {
    const matching = db.prepare(`SELECT et.episode_id, bm25(turn_fts) AS rank
      FROM turn_fts JOIN episode_turns et ON et.turn_id = turn_fts.turn_id
      JOIN episodes ep ON ep.id = et.episode_id
      WHERE turn_fts MATCH ? AND ep.conversation_id = ?
        AND ep.occurred_at_ms >= ? AND ep.occurred_at_ms < ?
      ORDER BY rank`).all(terms, conversationId, interval.startMs, interval.endMsExclusive) as { episode_id: string }[];
    rankedIds = [...new Set(matching.map(({ episode_id }) => episode_id))];
  }

  const entitiesByEpisode = new Map(episodes.map((episode) => {
    const payload = JSON.parse(episode.payload_json) as { expectedEntityCount?: number };
    return [episode.id, episodeEntities(db, episode.id, payload.expectedEntityCount)];
  }));
  const queryTerms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const entityMatches = episodes.map((episode) => {
    const entities = entitiesByEpisode.get(episode.id) ?? [];
    const names = entities.flatMap((entity) => [entity.canonical_name, entity.display_name, ...JSON.parse(entity.aliases_json) as string[]]);
    return { id: episode.id, score: queryTerms.filter((term) => names.some((name) => name.toLowerCase().includes(term))).length };
  }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).map(({ id }) => id);
  rankedIds = [...rankedIds, ...entityMatches.filter((id) => !rankedIds.includes(id))];

  if (!rankedIds.length && queryVector && episodes.length) {
    const rows = db.prepare(`SELECT owner_id, dimensions, vector_blob FROM embeddings
      WHERE owner_type = 'episode' AND model = ?`).all(queryVector.model) as { owner_id: string; dimensions: number; vector_blob: Buffer }[];
    const candidates = new Set(episodes.map(({ id }) => id));
    rankedIds = rows.filter((row) => candidates.has(row.owner_id) && row.dimensions === queryVector.values.length)
      .map((row) => {
        const values = new Float32Array(row.vector_blob.buffer, row.vector_blob.byteOffset, row.dimensions);
        let dot = 0, left = 0, right = 0;
        for (let index = 0; index < row.dimensions; index++) {
          dot += values[index] * queryVector.values[index];
          left += values[index] ** 2;
          right += queryVector.values[index] ** 2;
        }
        return { id: row.owner_id, score: left && right ? dot / Math.sqrt(left * right) : 0 };
      }).sort((a, b) => b.score - a.score).map(({ id }) => id);
  }
  const ranks = new Map(rankedIds.map((id, index) => [id, index]));

  return {
    turns,
    episodes: episodes.sort((left, right) => (ranks.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      || left.occurred_at_ms - right.occurred_at_ms).map((episode) => ({ ...episode, entities: entitiesByEpisode.get(episode.id) ?? [] })),
  };
}
