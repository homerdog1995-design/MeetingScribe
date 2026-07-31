'use strict';

/**
 * SQLite-backed storage layer (better-sqlite3).
 *
 * Chosen over a JSON-file store because the brief requires scaling to
 * thousands of meetings and hundreds of hours of recordings with low memory
 * use — that needs indexed queries and full-text search, not "parse the
 * whole file on every read." better-sqlite3 is synchronous, which keeps the
 * concurrency story simple (no torn reads/writes between two async calls),
 * and is fast enough that synchronous calls from IPC handlers never block
 * the UI noticeably even for large meetings.
 *
 * Only this module (and backup.js, which needs the raw file for snapshotting)
 * imports better-sqlite3. Everything else in the app talks to storage
 * through the functions exported here.
 */

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const logger = require('./logger');

let db = null;
let dbFilePath = null;

const SCHEMA_STATEMENTS = `
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Untitled meeting',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  archived INTEGER NOT NULL DEFAULT 0,
  recording_path TEXT,
  recording_format TEXT,
  quality TEXT DEFAULT 'standard',
  recording_mode TEXT DEFAULT 'microphone',
  notes TEXT DEFAULT '',
  transcript_cache TEXT NOT NULL DEFAULT '',
  tags_cache TEXT NOT NULL DEFAULT '',
  speakers_cache TEXT NOT NULL DEFAULT '',
  summary_cache TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS speakers (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  display_name TEXT,
  color TEXT NOT NULL DEFAULT '#4f7cff',
  total_speaking_ms INTEGER NOT NULL DEFAULT 0,
  sort_index INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_speakers_meeting ON speakers(meeting_id);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  speaker_id TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  confidence REAL,
  paragraph_break INTEGER NOT NULL DEFAULT 0,
  edited INTEGER NOT NULL DEFAULT 0,
  sequence INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segments_meeting_seq ON transcript_segments(meeting_id, sequence);
CREATE INDEX IF NOT EXISTS idx_segments_meeting_start ON transcript_segments(meeting_id, start_ms);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS meeting_tags (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, tag_id)
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  time_ms INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_meeting ON bookmarks(meeting_id);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  segment_id TEXT,
  text TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_meeting ON comments(meeting_id);

CREATE TABLE IF NOT EXISTS transcript_versions (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  note TEXT DEFAULT '',
  segment_count INTEGER NOT NULL DEFAULT 0,
  snapshot_gzip BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_meeting ON transcript_versions(meeting_id, created_at);

CREATE TABLE IF NOT EXISTS summaries (
  meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  generated_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  model TEXT,
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recording_sessions (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'recording',
  started_at INTEGER NOT NULL,
  last_chunk_index INTEGER NOT NULL DEFAULT -1,
  last_heartbeat_at INTEGER NOT NULL,
  chunk_dir TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON recording_sessions(status);

CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts USING fts5 (
  meeting_id UNINDEXED,
  title,
  transcript_cache,
  tags_cache,
  speakers_cache,
  summary_cache,
  content='meetings',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS meetings_ai AFTER INSERT ON meetings BEGIN
  INSERT INTO meetings_fts(rowid, meeting_id, title, transcript_cache, tags_cache, speakers_cache, summary_cache)
  VALUES (new.rowid, new.id, new.title, new.transcript_cache, new.tags_cache, new.speakers_cache, new.summary_cache);
END;

CREATE TRIGGER IF NOT EXISTS meetings_ad AFTER DELETE ON meetings BEGIN
  INSERT INTO meetings_fts(meetings_fts, rowid, meeting_id, title, transcript_cache, tags_cache, speakers_cache, summary_cache)
  VALUES ('delete', old.rowid, old.meeting_id, old.title, old.transcript_cache, old.tags_cache, old.speakers_cache, old.summary_cache);
END;

CREATE TRIGGER IF NOT EXISTS meetings_au AFTER UPDATE ON meetings BEGIN
  INSERT INTO meetings_fts(meetings_fts, rowid, meeting_id, title, transcript_cache, tags_cache, speakers_cache, summary_cache)
  VALUES ('delete', old.rowid, old.id, old.title, old.transcript_cache, old.tags_cache, old.speakers_cache, old.summary_cache);
  INSERT INTO meetings_fts(rowid, meeting_id, title, transcript_cache, tags_cache, speakers_cache, summary_cache)
  VALUES (new.rowid, new.id, new.title, new.transcript_cache, new.tags_cache, new.speakers_cache, new.summary_cache);
END;
`;

// Ordered, additive migrations keyed by target user_version. Each function
// receives the open database and must be idempotent-safe if re-run against
// a partially-migrated file (defensive against a crash mid-migration).
const MIGRATIONS = [
  { version: 1, up: (d) => d.exec(SCHEMA_STATEMENTS) },
  {
    version: 2,
    // Backs the transcript editor's highlight toggle. Added as its own
    // migration (rather than baked into v1's CREATE TABLE) so upgrading an
    // existing installation never loses data — MIGRATIONS is additive-only.
    up: (d) => {
      const columns = d.prepare("PRAGMA table_info(transcript_segments)").all();
      if (!columns.some((c) => c.name === 'highlighted')) {
        d.exec('ALTER TABLE transcript_segments ADD COLUMN highlighted INTEGER NOT NULL DEFAULT 0;');
      }
    },
  },
];

function open(userDataPath) {
  const dataDir = path.join(userDataPath, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  dbFilePath = path.join(dataDir, 'meetingscribe.db');

  db = new Database(dbFilePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  const currentVersion = db.pragma('user_version', { simple: true });
  const pending = MIGRATIONS.filter((m) => m.version > currentVersion).sort((a, b) => a.version - b.version);
  for (const migration of pending) {
    const apply = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    apply();
    logger.info('storage', `Applied migration ${migration.version}`);
  }

  logger.info('storage', 'Database opened', { path: dbFilePath, version: currentVersion });
  return dbFilePath;
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

function getDbPath() {
  return dbFilePath;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function now() {
  return Date.now();
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

function createMeeting({ title, quality = 'standard', recordingMode = 'microphone' } = {}) {
  const id = newId('mtg');
  const ts = now();
  db.prepare(`
    INSERT INTO meetings (id, title, created_at, updated_at, started_at, duration_ms, status, archived, quality, recording_mode, transcript_cache, tags_cache, speakers_cache, summary_cache)
    VALUES (@id, @title, @ts, @ts, @ts, 0, 'recording', 0, @quality, @recordingMode, '', '', '', '')
  `).run({ id, title: title || `Meeting — ${new Date(ts).toLocaleString()}`, ts, quality, recordingMode });
  return getMeeting(id);
}

function updateMeeting(id, patch) {
  const allowed = ['title', 'duration_ms', 'status', 'archived', 'recording_path', 'recording_format', 'quality', 'recording_mode', 'notes', 'started_at'];
  const fields = Object.keys(patch).filter((k) => allowed.includes(k));
  if (fields.length === 0) return getMeeting(id);

  const setClause = fields.map((f) => `${f} = @${f}`).join(', ');
  db.prepare(`UPDATE meetings SET ${setClause}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...patch, updated_at: now(), id });
  return getMeeting(id);
}

function getMeeting(id) {
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  if (!meeting) return null;

  meeting.speakers = db.prepare('SELECT * FROM speakers WHERE meeting_id = ? ORDER BY sort_index').all(id);
  meeting.segments = db.prepare('SELECT * FROM transcript_segments WHERE meeting_id = ? ORDER BY sequence').all(id);
  meeting.bookmarks = db.prepare('SELECT * FROM bookmarks WHERE meeting_id = ? ORDER BY time_ms').all(id);
  meeting.comments = db.prepare('SELECT * FROM comments WHERE meeting_id = ? ORDER BY created_at').all(id);
  meeting.tags = db.prepare(`
    SELECT t.id, t.name FROM tags t
    JOIN meeting_tags mt ON mt.tag_id = t.id
    WHERE mt.meeting_id = ? ORDER BY t.name
  `).all(id);
  const summaryRow = db.prepare('SELECT * FROM summaries WHERE meeting_id = ?').get(id);
  meeting.summary = summaryRow ? { ...summaryRow, sections: JSON.parse(summaryRow.raw_json) } : null;
  meeting.archived = !!meeting.archived;
  return meeting;
}

function listMeetings({ search = '', tags = [], dateFrom = null, dateTo = null, archived = null, sortBy = 'updated_at', sortDir = 'DESC', limit = 50, offset = 0 } = {}) {
  const clauses = [];
  const params = {};

  if (archived !== null) {
    clauses.push('m.archived = @archived');
    params.archived = archived ? 1 : 0;
  }
  if (dateFrom) {
    clauses.push('m.created_at >= @dateFrom');
    params.dateFrom = dateFrom;
  }
  if (dateTo) {
    clauses.push('m.created_at <= @dateTo');
    params.dateTo = dateTo;
  }

  let baseFrom = 'meetings m';
  if (search && search.trim()) {
    baseFrom = `meetings_fts f JOIN meetings m ON m.rowid = f.rowid`;
    clauses.push('meetings_fts MATCH @searchQuery');
    params.searchQuery = buildFtsQuery(search);
  }

  if (tags.length > 0) {
    const tagPlaceholders = tags.map((_, i) => `@tag${i}`).join(', ');
    tags.forEach((t, i) => { params[`tag${i}`] = t; });
    clauses.push(`m.id IN (
      SELECT mt.meeting_id FROM meeting_tags mt JOIN tags t ON t.id = mt.tag_id
      WHERE t.name IN (${tagPlaceholders})
      GROUP BY mt.meeting_id HAVING COUNT(DISTINCT t.name) = ${tags.length}
    )`);
  }

  const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const validSort = new Set(['updated_at', 'created_at', 'title', 'duration_ms']);
  const sortColumn = validSort.has(sortBy) ? sortBy : 'updated_at';
  const direction = sortDir.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM ${baseFrom} ${whereClause}`).get(params);
  const rows = db.prepare(`
    SELECT m.* FROM ${baseFrom}
    ${whereClause}
    ORDER BY m.${sortColumn} ${direction}
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset });

  const items = rows.map((m) => ({
    ...m,
    archived: !!m.archived,
    tags: db.prepare(`SELECT t.name FROM tags t JOIN meeting_tags mt ON mt.tag_id = t.id WHERE mt.meeting_id = ?`).all(m.id).map((r) => r.name),
    preview: buildSearchPreview(m.transcript_cache, search),
  }));

  return { items, total: totalRow.total };
}

function buildFtsQuery(rawQuery) {
  // Escape FTS5 special characters and quote each term so punctuation in a
  // user's search (e.g. "Q3 budget?") does not throw a syntax error.
  const terms = rawQuery.trim().split(/\s+/).filter(Boolean);
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

function buildSearchPreview(transcript, search, contextChars = 80) {
  if (!search || !transcript) return transcript ? transcript.slice(0, 160) : '';
  const idx = transcript.toLowerCase().indexOf(search.trim().toLowerCase());
  if (idx === -1) return transcript.slice(0, 160);
  const start = Math.max(0, idx - contextChars);
  const end = Math.min(transcript.length, idx + search.length + contextChars);
  return (start > 0 ? '…' : '') + transcript.slice(start, end) + (end < transcript.length ? '…' : '');
}

function deleteMeeting(id) {
  const meeting = getMeeting(id);
  db.prepare('DELETE FROM meetings WHERE id = ?').run(id);
  return meeting;
}

function archiveMeeting(id, archived) {
  return updateMeeting(id, { archived: archived ? 1 : 0 });
}

function duplicateMeeting(id) {
  const source = getMeeting(id);
  if (!source) return null;

  const newMeeting = createMeeting({ title: `${source.title} (copy)`, quality: source.quality, recordingMode: source.recording_mode });
  updateMeeting(newMeeting.id, { status: source.status, notes: source.notes });

  const speakerIdMap = new Map();
  const insertSpeaker = db.prepare(`
    INSERT INTO speakers (id, meeting_id, label, display_name, color, total_speaking_ms, sort_index)
    VALUES (@id, @meeting_id, @label, @display_name, @color, @total_speaking_ms, @sort_index)
  `);
  source.speakers.forEach((s, i) => {
    const newSpeakerId = newId('spk');
    speakerIdMap.set(s.id, newSpeakerId);
    insertSpeaker.run({ ...s, id: newSpeakerId, meeting_id: newMeeting.id, sort_index: i });
  });

  const insertSegment = db.prepare(`
    INSERT INTO transcript_segments (id, meeting_id, speaker_id, start_ms, end_ms, text, confidence, paragraph_break, edited, sequence, created_at, highlighted)
    VALUES (@id, @meeting_id, @speaker_id, @start_ms, @end_ms, @text, @confidence, @paragraph_break, @edited, @sequence, @created_at, @highlighted)
  `);
  source.segments.forEach((seg) => {
    insertSegment.run({
      ...seg,
      id: newId('seg'),
      meeting_id: newMeeting.id,
      speaker_id: seg.speaker_id ? speakerIdMap.get(seg.speaker_id) || null : null,
      created_at: now(),
    });
  });

  if (source.tags.length) setTags(newMeeting.id, source.tags.map((t) => t.name));

  refreshMeetingCaches(newMeeting.id);
  return getMeeting(newMeeting.id);
}

// ---------------------------------------------------------------------------
// Transcript segments
// ---------------------------------------------------------------------------

function addTranscriptSegments(meetingId, segments) {
  const maxSeqRow = db.prepare('SELECT MAX(sequence) AS maxSeq FROM transcript_segments WHERE meeting_id = ?').get(meetingId);
  let sequence = (maxSeqRow.maxSeq ?? -1) + 1;

  const insert = db.prepare(`
    INSERT INTO transcript_segments (id, meeting_id, speaker_id, start_ms, end_ms, text, confidence, paragraph_break, edited, sequence, created_at)
    VALUES (@id, @meeting_id, @speaker_id, @start_ms, @end_ms, @text, @confidence, @paragraph_break, 0, @sequence, @created_at)
  `);

  const insertMany = db.transaction((segs) => {
    const inserted = [];
    for (const seg of segs) {
      const row = {
        id: newId('seg'),
        meeting_id: meetingId,
        speaker_id: seg.speakerId || null,
        start_ms: seg.startMs,
        end_ms: seg.endMs,
        text: seg.text,
        confidence: seg.confidence ?? null,
        paragraph_break: seg.paragraphBreak ? 1 : 0,
        sequence: sequence++,
        created_at: now(),
      };
      insert.run(row);
      inserted.push(row);
    }
    return inserted;
  });

  const result = insertMany(segments);
  refreshMeetingCaches(meetingId);
  return result;
}

function updateTranscriptSegment(meetingId, segmentId, patch) {
  const allowed = ['speaker_id', 'text', 'start_ms', 'end_ms', 'paragraph_break', 'highlighted'];
  const fields = Object.keys(patch).filter((k) => allowed.includes(k));
  if (fields.length === 0) return;
  const setClause = fields.map((f) => `${f} = @${f}`).join(', ');
  db.prepare(`UPDATE transcript_segments SET ${setClause}, edited = 1 WHERE id = @id AND meeting_id = @meeting_id`)
    .run({ ...patch, id: segmentId, meeting_id: meetingId });
  refreshMeetingCaches(meetingId);
}

function deleteTranscriptSegment(meetingId, segmentId) {
  db.prepare('DELETE FROM transcript_segments WHERE id = ? AND meeting_id = ?').run(segmentId, meetingId);
  refreshMeetingCaches(meetingId);
}

function mergeSegments(meetingId, segmentIdA, segmentIdB) {
  const a = db.prepare('SELECT * FROM transcript_segments WHERE id = ? AND meeting_id = ?').get(segmentIdA, meetingId);
  const b = db.prepare('SELECT * FROM transcript_segments WHERE id = ? AND meeting_id = ?').get(segmentIdB, meetingId);
  if (!a || !b) throw new Error('Segment not found for merge');

  const [first, second] = a.sequence < b.sequence ? [a, b] : [b, a];
  db.prepare('UPDATE transcript_segments SET text = ?, end_ms = ?, edited = 1 WHERE id = ?')
    .run(`${first.text} ${second.text}`.trim(), second.end_ms, first.id);
  db.prepare('DELETE FROM transcript_segments WHERE id = ?').run(second.id);
  refreshMeetingCaches(meetingId);
}

function splitSegment(meetingId, segmentId, splitAtCharIndex, splitTimeMs) {
  const seg = db.prepare('SELECT * FROM transcript_segments WHERE id = ? AND meeting_id = ?').get(segmentId, meetingId);
  if (!seg) throw new Error('Segment not found for split');

  const before = seg.text.slice(0, splitAtCharIndex).trim();
  const after = seg.text.slice(splitAtCharIndex).trim();
  const midpoint = splitTimeMs ?? Math.round((seg.start_ms + seg.end_ms) / 2);

  const shiftSequences = db.prepare('UPDATE transcript_segments SET sequence = sequence + 1 WHERE meeting_id = ? AND sequence > ?');
  const run = db.transaction(() => {
    shiftSequences.run(meetingId, seg.sequence);
    db.prepare('UPDATE transcript_segments SET text = ?, end_ms = ?, edited = 1 WHERE id = ?').run(before, midpoint, seg.id);
    db.prepare(`
      INSERT INTO transcript_segments (id, meeting_id, speaker_id, start_ms, end_ms, text, confidence, paragraph_break, edited, sequence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)
    `).run(newId('seg'), meetingId, seg.speaker_id, midpoint, seg.end_ms, after, seg.paragraph_break, seg.sequence + 1, now());
  });
  run();
  refreshMeetingCaches(meetingId);
}

// ---------------------------------------------------------------------------
// Speakers
// ---------------------------------------------------------------------------

function upsertSpeaker(meetingId, speaker) {
  if (speaker.id) {
    db.prepare('UPDATE speakers SET label = @label, display_name = @display_name, color = @color WHERE id = @id AND meeting_id = @meeting_id')
      .run({ ...speaker, meeting_id: meetingId });
  } else {
    const countRow = db.prepare('SELECT COUNT(*) AS c FROM speakers WHERE meeting_id = ?').get(meetingId);
    speaker.id = newId('spk');
    db.prepare(`
      INSERT INTO speakers (id, meeting_id, label, display_name, color, total_speaking_ms, sort_index)
      VALUES (@id, @meeting_id, @label, @display_name, @color, 0, @sort_index)
    `).run({ ...speaker, meeting_id: meetingId, sort_index: countRow.c });
  }
  refreshMeetingCaches(meetingId);
  return db.prepare('SELECT * FROM speakers WHERE id = ?').get(speaker.id);
}

function getSpeakerStats(meetingId) {
  const rows = db.prepare(`
    SELECT s.id, s.label, s.display_name, s.color,
           COALESCE(SUM(t.end_ms - t.start_ms), 0) AS total_speaking_ms,
           COUNT(t.id) AS segment_count
    FROM speakers s
    LEFT JOIN transcript_segments t ON t.speaker_id = s.id
    WHERE s.meeting_id = ?
    GROUP BY s.id
    ORDER BY s.sort_index
  `).all(meetingId);

  const update = db.prepare('UPDATE speakers SET total_speaking_ms = ? WHERE id = ?');
  const tx = db.transaction(() => rows.forEach((r) => update.run(r.total_speaking_ms, r.id)));
  tx();
  return rows;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

function setTags(meetingId, tagNames) {
  const normalized = [...new Set(tagNames.map((t) => t.trim()).filter(Boolean))];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM meeting_tags WHERE meeting_id = ?').run(meetingId);
    for (const name of normalized) {
      let tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
      if (!tag) {
        const id = newId('tag');
        db.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(id, name);
        tag = { id };
      }
      db.prepare('INSERT OR IGNORE INTO meeting_tags (meeting_id, tag_id) VALUES (?, ?)').run(meetingId, tag.id);
    }
  });
  tx();
  refreshMeetingCaches(meetingId);
}

function listAllTags() {
  return db.prepare(`
    SELECT t.name, COUNT(mt.meeting_id) AS usage_count
    FROM tags t LEFT JOIN meeting_tags mt ON mt.tag_id = t.id
    GROUP BY t.id ORDER BY usage_count DESC, t.name ASC
  `).all();
}

// ---------------------------------------------------------------------------
// Bookmarks & comments
// ---------------------------------------------------------------------------

function addBookmark(meetingId, { timeMs, label = '' }) {
  const id = newId('bkm');
  db.prepare('INSERT INTO bookmarks (id, meeting_id, time_ms, label, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, meetingId, timeMs, label, now());
  return db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
}

function deleteBookmark(meetingId, bookmarkId) {
  db.prepare('DELETE FROM bookmarks WHERE id = ? AND meeting_id = ?').run(bookmarkId, meetingId);
}

function addComment(meetingId, { segmentId = null, text }) {
  const id = newId('cmt');
  db.prepare('INSERT INTO comments (id, meeting_id, segment_id, text, resolved, created_at) VALUES (?, ?, ?, ?, 0, ?)')
    .run(id, meetingId, segmentId, text, now());
  return db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
}

function resolveComment(meetingId, commentId, resolved) {
  db.prepare('UPDATE comments SET resolved = ? WHERE id = ? AND meeting_id = ?').run(resolved ? 1 : 0, commentId, meetingId);
}

function deleteComment(meetingId, commentId) {
  db.prepare('DELETE FROM comments WHERE id = ? AND meeting_id = ?').run(commentId, meetingId);
}

// ---------------------------------------------------------------------------
// Version history (gzip-compressed full snapshots — see ARCHITECTURE.md §3.1)
// ---------------------------------------------------------------------------

function saveTranscriptSnapshot(meetingId, note = '') {
  const segments = db.prepare('SELECT * FROM transcript_segments WHERE meeting_id = ? ORDER BY sequence').all(meetingId);
  const payload = Buffer.from(JSON.stringify(segments), 'utf8');
  const gzipped = zlib.gzipSync(payload);
  const id = newId('ver');
  db.prepare(`
    INSERT INTO transcript_versions (id, meeting_id, created_at, note, segment_count, snapshot_gzip)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, meetingId, now(), note, segments.length, gzipped);
  return { id, meetingId, createdAt: now(), note, segmentCount: segments.length };
}

function listTranscriptVersions(meetingId) {
  return db.prepare(`
    SELECT id, meeting_id, created_at, note, segment_count FROM transcript_versions
    WHERE meeting_id = ? ORDER BY created_at DESC
  `).all(meetingId);
}

function restoreTranscriptVersion(meetingId, versionId) {
  const row = db.prepare('SELECT * FROM transcript_versions WHERE id = ? AND meeting_id = ?').get(versionId, meetingId);
  if (!row) throw new Error('Version not found');

  const segments = JSON.parse(zlib.gunzipSync(row.snapshot_gzip).toString('utf8'));
  const tx = db.transaction(() => {
    saveTranscriptSnapshot(meetingId, 'Auto-saved before restore');
    db.prepare('DELETE FROM transcript_segments WHERE meeting_id = ?').run(meetingId);
    const insert = db.prepare(`
      INSERT INTO transcript_segments (id, meeting_id, speaker_id, start_ms, end_ms, text, confidence, paragraph_break, edited, sequence, created_at)
      VALUES (@id, @meeting_id, @speaker_id, @start_ms, @end_ms, @text, @confidence, @paragraph_break, @edited, @sequence, @created_at)
    `);
    segments.forEach((s) => insert.run({ ...s, meeting_id: meetingId }));
  });
  tx();
  refreshMeetingCaches(meetingId);
  return getMeeting(meetingId);
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function saveSummary(meetingId, sections, { source, model = null } = {}) {
  db.prepare(`
    INSERT INTO summaries (meeting_id, generated_at, source, model, raw_json)
    VALUES (@meeting_id, @generated_at, @source, @model, @raw_json)
    ON CONFLICT(meeting_id) DO UPDATE SET generated_at = @generated_at, source = @source, model = @model, raw_json = @raw_json
  `).run({ meeting_id: meetingId, generated_at: now(), source, model, raw_json: JSON.stringify(sections) });
  refreshMeetingCaches(meetingId);
  return getMeeting(meetingId).summary;
}

// ---------------------------------------------------------------------------
// Recording sessions (crash recovery)
// ---------------------------------------------------------------------------

function createRecordingSession(meetingId, chunkDir) {
  const id = newId('rec');
  db.prepare(`
    INSERT INTO recording_sessions (id, meeting_id, status, started_at, last_chunk_index, last_heartbeat_at, chunk_dir)
    VALUES (?, ?, 'recording', ?, -1, ?, ?)
  `).run(id, meetingId, now(), now(), chunkDir);
  return id;
}

function heartbeatRecordingSession(sessionId, lastChunkIndex, status = 'recording') {
  db.prepare('UPDATE recording_sessions SET last_chunk_index = ?, last_heartbeat_at = ?, status = ? WHERE id = ?')
    .run(lastChunkIndex, now(), status, sessionId);
}

function finalizeRecordingSession(sessionId) {
  db.prepare(`UPDATE recording_sessions SET status = 'stopped', last_heartbeat_at = ? WHERE id = ?`).run(now(), sessionId);
}

function getUnfinishedSessions() {
  return db.prepare(`SELECT * FROM recording_sessions WHERE status IN ('recording', 'paused')`).all();
}

function discardSession(sessionId) {
  db.prepare(`UPDATE recording_sessions SET status = 'discarded' WHERE id = ?`).run(sessionId);
}

// ---------------------------------------------------------------------------
// Cache maintenance (keeps meetings_fts fast and simple — see storage schema)
// ---------------------------------------------------------------------------

/**
 * Summary sections come in two shapes: plain strings (executiveSummary,
 * overview) and arrays of structured objects (decisions, risks, actionItems,
 * topics, etc.). A naive Object.values(...).flat().filter(string) would
 * silently drop every array-of-object section, which would make full-text
 * search miss decisions, risks, and action items entirely — this instead
 * pulls the actual searchable text out of each shape.
 */
function flattenSummaryText(sections) {
  const parts = [];
  for (const value of Object.values(sections)) {
    if (typeof value === 'string') {
      if (value.trim()) parts.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') {
          parts.push(item);
        } else if (item && typeof item === 'object') {
          if (item.text) parts.push(item.text);
          if (item.label) parts.push(item.label);
          if (item.representativeText) parts.push(item.representativeText);
          if (item.owner) parts.push(item.owner);
        }
      }
    }
  }
  return parts.join(' ');
}

function refreshMeetingCaches(meetingId) {
  const segments = db.prepare('SELECT text FROM transcript_segments WHERE meeting_id = ? ORDER BY sequence').all(meetingId);
  const speakers = db.prepare('SELECT label, display_name FROM speakers WHERE meeting_id = ?').all(meetingId);
  const tags = db.prepare(`SELECT t.name FROM tags t JOIN meeting_tags mt ON mt.tag_id = t.id WHERE mt.meeting_id = ?`).all(meetingId);
  const summary = db.prepare('SELECT raw_json FROM summaries WHERE meeting_id = ?').get(meetingId);

  const transcriptCache = segments.map((s) => s.text).join(' ');
  const speakersCache = speakers.map((s) => s.display_name || s.label).join(' ');
  const tagsCache = tags.map((t) => t.name).join(' ');
  let summaryCache = '';
  if (summary) {
    try {
      summaryCache = flattenSummaryText(JSON.parse(summary.raw_json));
    } catch { /* leave summaryCache empty if the stored JSON is unreadable */ }
  }

  db.prepare(`
    UPDATE meetings SET transcript_cache = ?, speakers_cache = ?, tags_cache = ?, summary_cache = ?, updated_at = ?
    WHERE id = ?
  `).run(transcriptCache, speakersCache, tagsCache, summaryCache, now(), meetingId);
}

// ---------------------------------------------------------------------------
// Aggregate stats (for Settings → Storage panel)
// ---------------------------------------------------------------------------

function getStorageStats(recordingsDir) {
  const meetingCount = db.prepare('SELECT COUNT(*) AS c FROM meetings').get().c;
  const totalDuration = db.prepare('SELECT COALESCE(SUM(duration_ms), 0) AS d FROM meetings').get().d;
  const dbSizeBytes = fs.existsSync(dbFilePath) ? fs.statSync(dbFilePath).size : 0;

  let recordingsSizeBytes = 0;
  if (recordingsDir && fs.existsSync(recordingsDir)) {
    recordingsSizeBytes = walkDirSize(recordingsDir);
  }

  return { meetingCount, totalDurationMs: totalDuration, dbSizeBytes, recordingsSizeBytes };
}

/**
 * Uses SQLite's native online backup API (exposed by better-sqlite3 as
 * `db.backup()`) rather than a raw file copy, so a backup taken while the
 * app is actively writing (e.g. mid-recording) is always transactionally
 * consistent instead of a torn read of the WAL file.
 */
async function backupDatabaseTo(destinationPath) {
  await db.backup(destinationPath);
}

function walkDirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    total += entry.isDirectory() ? walkDirSize(fullPath) : fs.statSync(fullPath).size;
  }
  return total;
}

module.exports = {
  open,
  close,
  getDbPath,
  createMeeting,
  updateMeeting,
  getMeeting,
  listMeetings,
  deleteMeeting,
  archiveMeeting,
  duplicateMeeting,
  addTranscriptSegments,
  updateTranscriptSegment,
  deleteTranscriptSegment,
  mergeSegments,
  splitSegment,
  upsertSpeaker,
  getSpeakerStats,
  setTags,
  listAllTags,
  addBookmark,
  deleteBookmark,
  addComment,
  resolveComment,
  deleteComment,
  saveTranscriptSnapshot,
  listTranscriptVersions,
  restoreTranscriptVersion,
  saveSummary,
  createRecordingSession,
  heartbeatRecordingSession,
  finalizeRecordingSession,
  getUnfinishedSessions,
  discardSession,
  refreshMeetingCaches,
  getStorageStats,
  backupDatabaseTo,
};
