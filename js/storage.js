'use strict';

/**
 * storage.js — IndexedDB-backed replacement for the old Electron main-process
 * storage.js (which used better-sqlite3). This is the single biggest change
 * in the PWA conversion, so a few design notes up front:
 *
 * WHY INDEXEDDB: it's the only browser-native database capable of storing
 * large binary data (recordings, as Blobs) and structured records at the
 * scale this app needs ("thousands of meetings, hundreds of hours of
 * recordings"). localStorage is string-only, synchronous, and capped at a
 * few MB — a non-starter for audio.
 *
 * WHY THE SAME FUNCTION NAMES: every other module (editor.js, library.js,
 * recording.js, summary.js, speakers.js, settings.js) was written against
 * the old storage:* IPC contract. Keeping createMeeting/getMeeting/
 * listMeetings/addTranscriptSegments/etc. with the same signatures and
 * return shapes means those modules only need their `window.api.storage.X()`
 * calls changed to `storage.X()` direct calls — the data shapes they already
 * destructure (snake_case segment/speaker fields, etc.) are unchanged.
 *
 * NO FULL-TEXT SEARCH ENGINE: SQLite's FTS5 has no browser equivalent.
 * Instead, each meeting record carries a denormalized `search_text` field
 * (title + transcript + speaker names + tags + summary), rebuilt whenever
 * any of those change, and listMeetings() does a plain substring scan over
 * it. This is a real performance trade-off versus FTS5 — for a few thousand
 * meetings a linear scan is still fast (each record is small; only text
 * fields are scanned, not audio), but it will not scale as gracefully as a
 * real index into the tens of thousands.
 *
 * `recording_path` FIELD NAME KEPT ON PURPOSE: there is no filesystem
 * anymore, so this field no longer holds a path — it holds the id of a Blob
 * stored in the `recordings` object store. The name is kept unchanged
 * because playback.js/timeline.js/library.js already check it for
 * truthiness ("has this meeting been recorded?"); only the two places that
 * actually dereference it (playback.js, timeline.js) needed to change, via
 * the new getRecordingUrl() export below.
 */

import { openDatabase } from './db.js';

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(storeName, mode, fn) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result;
    let failed = false;
    Promise.resolve(fn(store)).then((r) => { result = r; }).catch((err) => { failed = true; reject(err); });
    transaction.oncomplete = () => { if (!failed) resolve(result); };
    transaction.onerror = () => { failed = true; reject(transaction.error); };
  });
}

const getAll = (storeName) => withStore(storeName, 'readonly', (s) => reqToPromise(s.getAll()));
const getAllByIndex = (storeName, indexName, value) => withStore(storeName, 'readonly', (s) => reqToPromise(s.index(indexName).getAll(value)));
const getOne = (storeName, key) => withStore(storeName, 'readonly', (s) => reqToPromise(s.get(key)));
const putOne = (storeName, value) => withStore(storeName, 'readwrite', async (s) => { await reqToPromise(s.put(value)); return value; });
const deleteOne = (storeName, key) => withStore(storeName, 'readwrite', (s) => reqToPromise(s.delete(key)));

async function deleteAllByIndex(storeName, indexName, value) {
  return withStore(storeName, 'readwrite', async (store) => {
    const keys = await reqToPromise(store.index(indexName).getAllKeys(value));
    for (const key of keys) await reqToPromise(store.delete(key));
  });
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

async function createMeeting({ title, quality = 'standard' } = {}) {
  const now = Date.now();
  const meeting = {
    id: newId('mtg'),
    title: title || 'Untitled meeting',
    created_at: now,
    updated_at: now,
    started_at: null,
    duration_ms: 0,
    status: 'draft',
    archived: false,
    recording_path: null, // see file header note: this is a recordings-store id, not a filesystem path
    recording_format: null,
    quality,
    recording_mode: 'microphone',
    notes: '',
    search_text: (title || 'Untitled meeting').toLowerCase(),
  };
  await putOne('meetings', meeting);
  return getMeeting(meeting.id);
}

async function updateMeeting(id, patch) {
  const existing = await getOne('meetings', id);
  if (!existing) throw new Error(`Meeting not found: ${id}`);
  const allowed = ['title', 'status', 'archived', 'recording_path', 'recording_format', 'quality', 'recording_mode', 'notes', 'started_at', 'duration_ms'];
  const next = { ...existing };
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }
  next.updated_at = Date.now();
  await putOne('meetings', next);
  if (patch.title !== undefined) await refreshMeetingSearchCache(id);
  return getMeeting(id);
}

async function getMeeting(id) {
  const meeting = await getOne('meetings', id);
  if (!meeting) return null;

  const [speakers, segments, bookmarks, comments, summaryRow, meetingTagLinks] = await Promise.all([
    getAllByIndex('speakers', 'meeting_id', id),
    getAllByIndex('segments', 'meeting_id', id),
    getAllByIndex('bookmarks', 'meeting_id', id),
    getAllByIndex('comments', 'meeting_id', id),
    getOne('summaries', id),
    getAllByIndex('meeting_tags', 'meeting_id', id),
  ]);

  speakers.sort((a, b) => a.sort_index - b.sort_index);
  segments.sort((a, b) => a.sequence - b.sequence);

  return {
    ...meeting,
    speakers,
    segments,
    bookmarks,
    comments,
    tags: meetingTagLinks.map((link) => ({ id: link.tag_name, name: link.tag_name })),
    summary: summaryRow || null,
  };
}

async function deleteMeeting(id) {
  const meeting = await getOne('meetings', id);
  if (!meeting) return;
  await Promise.all([
    deleteAllByIndex('speakers', 'meeting_id', id),
    deleteAllByIndex('segments', 'meeting_id', id),
    deleteAllByIndex('bookmarks', 'meeting_id', id),
    deleteAllByIndex('comments', 'meeting_id', id),
    deleteAllByIndex('meeting_tags', 'meeting_id', id),
    deleteAllByIndex('transcript_versions', 'meeting_id', id),
    deleteOne('summaries', id).catch(() => {}),
    deleteOrphanedSessionsForMeeting(id),
  ]);
  if (meeting.recording_path) await deleteOne('recordings', meeting.recording_path).catch(() => {});
  await deleteOne('meetings', id);
  await refreshTagUsageCounts();
}

/**
 * recording_sessions has no meeting_id index (it's a small, short-lived
 * table — only ever holds in-progress or crashed sessions, never
 * accumulates meaningfully), so a full scan + filter is fine here and
 * avoids a schema migration just for this. Previously these were never
 * cleaned up on delete, which could leave a crash-recovery prompt
 * referencing a meeting that no longer exists.
 */
async function deleteOrphanedSessionsForMeeting(meetingId) {
  const sessions = await getAll('recording_sessions');
  for (const session of sessions.filter((s) => s.meeting_id === meetingId)) {
    const chunks = await getAllByIndex('recording_chunks', 'session_id', session.id);
    for (const chunk of chunks) await deleteOne('recording_chunks', chunk.id);
    await deleteOne('recording_sessions', session.id);
  }
}

async function archiveMeeting(id, archived) {
  return updateMeeting(id, { archived: Boolean(archived) });
}

async function duplicateMeeting(id) {
  const source = await getMeeting(id);
  if (!source) throw new Error(`Meeting not found: ${id}`);

  const now = Date.now();
  const newMeetingId = newId('mtg');
  const speakerIdMap = new Map();

  const duplicated = {
    ...source,
    id: newMeetingId,
    title: `${source.title} (copy)`,
    created_at: now,
    updated_at: now,
    status: 'draft',
    // A duplicate is metadata + transcript, not the original audio — copying
    // the recording Blob byte-for-byte would double storage for no benefit,
    // and re-recording over a "copy" is the expected product behavior.
    recording_path: null,
    recording_format: null,
  };
  delete duplicated.speakers;
  delete duplicated.segments;
  delete duplicated.bookmarks;
  delete duplicated.comments;
  delete duplicated.tags;
  delete duplicated.summary;
  await putOne('meetings', duplicated);

  for (const speaker of source.speakers) {
    const newSpeakerId = newId('spk');
    speakerIdMap.set(speaker.id, newSpeakerId);
    await putOne('speakers', { ...speaker, id: newSpeakerId, meeting_id: newMeetingId });
  }
  for (const segment of source.segments) {
    await putOne('segments', {
      ...segment,
      id: newId('seg'),
      meeting_id: newMeetingId,
      speaker_id: segment.speaker_id ? speakerIdMap.get(segment.speaker_id) || null : null,
      created_at: now,
    });
  }
  for (const tagLink of source.tags) {
    await putOne('meeting_tags', { id: `${newMeetingId}::${tagLink.name}`, meeting_id: newMeetingId, tag_name: tagLink.name });
  }
  await refreshTagUsageCounts();
  await refreshMeetingSearchCache(newMeetingId);
  return getMeeting(newMeetingId);
}

async function listMeetings({ search = '', archived = false, sortBy = 'updated_at', sortDir = 'DESC', limit = 20, offset = 0 } = {}) {
  let items = await getAll('meetings');

  if (archived !== null && archived !== undefined) {
    items = items.filter((m) => Boolean(m.archived) === Boolean(archived));
  }
  if (search && search.trim()) {
    const needle = search.trim().toLowerCase();
    items = items.filter((m) => (m.search_text || '').includes(needle));
  }

  items.sort((a, b) => {
    const dir = sortDir === 'ASC' ? 1 : -1;
    const av = a[sortBy];
    const bv = b[sortBy];
    if (typeof av === 'string') return av.localeCompare(bv) * dir;
    return ((av ?? 0) - (bv ?? 0)) * dir;
  });

  const total = items.length;
  const page = items.slice(offset, offset + limit);

  const enriched = await Promise.all(page.map(async (meeting) => {
    const [tagLinks, segments] = await Promise.all([
      getAllByIndex('meeting_tags', 'meeting_id', meeting.id),
      getAllByIndex('segments', 'meeting_id', meeting.id),
    ]);
    segments.sort((a, b) => a.sequence - b.sequence);
    const preview = segments.slice(0, 3).map((s) => s.text).join(' ').slice(0, 220);
    return { ...meeting, tags: tagLinks.map((l) => l.tag_name), preview };
  }));

  return { items: enriched, total };
}

// ---------------------------------------------------------------------------
// Transcript segments
// ---------------------------------------------------------------------------

async function addTranscriptSegments(meetingId, segments) {
  const existing = await getAllByIndex('segments', 'meeting_id', meetingId);
  let sequence = existing.length ? Math.max(...existing.map((s) => s.sequence)) + 1 : 0;
  const now = Date.now();
  const inserted = [];

  for (const segment of segments) {
    const row = {
      id: newId('seg'),
      meeting_id: meetingId,
      speaker_id: segment.speakerId ?? null,
      start_ms: segment.startMs,
      end_ms: segment.endMs,
      text: segment.text,
      confidence: segment.confidence ?? null,
      paragraph_break: Boolean(segment.paragraphBreak),
      edited: false,
      sequence: sequence++,
      created_at: now,
      highlighted: false,
    };
    await putOne('segments', row);
    inserted.push(row);
  }

  if (inserted.length) {
    const lastSpeakerId = inserted[inserted.length - 1].speaker_id;
    if (lastSpeakerId) await recomputeSpeakerSpeakingTime(lastSpeakerId, meetingId);
  }
  await refreshMeetingSearchCache(meetingId);
  return inserted;
}

async function updateTranscriptSegment(meetingId, segmentId, patch) {
  const existing = await getOne('segments', segmentId);
  if (!existing || existing.meeting_id !== meetingId) throw new Error('Segment not found');
  const allowed = ['speaker_id', 'text', 'start_ms', 'end_ms', 'paragraph_break', 'highlighted'];
  const next = { ...existing, edited: true };
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }
  await putOne('segments', next);

  const affectedSpeakers = new Set([existing.speaker_id, next.speaker_id].filter(Boolean));
  for (const speakerId of affectedSpeakers) await recomputeSpeakerSpeakingTime(speakerId, meetingId);
  await refreshMeetingSearchCache(meetingId);
  return next;
}

async function deleteTranscriptSegment(meetingId, segmentId) {
  const existing = await getOne('segments', segmentId);
  await deleteOne('segments', segmentId);
  if (existing?.speaker_id) await recomputeSpeakerSpeakingTime(existing.speaker_id, meetingId);
  await refreshMeetingSearchCache(meetingId);
}

// ---------------------------------------------------------------------------
// Speakers
// ---------------------------------------------------------------------------

async function upsertSpeaker(meetingId, speaker) {
  if (speaker.id) {
    const existing = await getOne('speakers', speaker.id);
    const next = { ...existing, label: speaker.label, display_name: speaker.display_name, color: speaker.color };
    await putOne('speakers', next);
    await refreshMeetingSearchCache(meetingId);
    return next;
  }
  const siblings = await getAllByIndex('speakers', 'meeting_id', meetingId);
  const row = {
    id: newId('spk'),
    meeting_id: meetingId,
    label: speaker.label,
    display_name: speaker.display_name,
    color: speaker.color,
    total_speaking_ms: 0,
    sort_index: siblings.length,
  };
  await putOne('speakers', row);
  return row;
}

async function recomputeSpeakerSpeakingTime(speakerId, meetingId) {
  const segments = await getAllByIndex('segments', 'meeting_id', meetingId);
  const totalMs = segments.filter((s) => s.speaker_id === speakerId).reduce((sum, s) => sum + Math.max(0, s.end_ms - s.start_ms), 0);
  const speaker = await getOne('speakers', speakerId);
  if (speaker) await putOne('speakers', { ...speaker, total_speaking_ms: totalMs });
}

async function getSpeakerStats(meetingId) {
  const [speakers, segments] = await Promise.all([
    getAllByIndex('speakers', 'meeting_id', meetingId),
    getAllByIndex('segments', 'meeting_id', meetingId),
  ]);
  return speakers
    .sort((a, b) => a.sort_index - b.sort_index)
    .map((speaker) => ({
      ...speaker,
      segment_count: segments.filter((s) => s.speaker_id === speaker.id).length,
    }));
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

async function setTags(meetingId, tagNames) {
  await deleteAllByIndex('meeting_tags', 'meeting_id', meetingId);
  const unique = [...new Set(tagNames.map((t) => t.trim()).filter(Boolean))];
  for (const name of unique) {
    await putOne('meeting_tags', { id: `${meetingId}::${name}`, meeting_id: meetingId, tag_name: name });
  }
  await refreshTagUsageCounts();
  await refreshMeetingSearchCache(meetingId);
}

async function refreshTagUsageCounts() {
  const links = await getAll('meeting_tags');
  const counts = new Map();
  for (const link of links) counts.set(link.tag_name, (counts.get(link.tag_name) || 0) + 1);
  const existingTags = await getAll('tags');
  const seen = new Set();
  for (const [name, usage_count] of counts) {
    seen.add(name);
    await putOne('tags', { name, usage_count });
  }
  for (const tag of existingTags) {
    if (!seen.has(tag.name)) await deleteOne('tags', tag.name);
  }
}

async function listAllTags() {
  const tags = await getAll('tags');
  return tags.sort((a, b) => b.usage_count - a.usage_count);
}

// ---------------------------------------------------------------------------
// Bookmarks & comments
// ---------------------------------------------------------------------------

async function addBookmark(meetingId, { timeMs, label = '' }) {
  const row = { id: newId('bkm'), meeting_id: meetingId, time_ms: timeMs, label, created_at: Date.now() };
  await putOne('bookmarks', row);
  return row;
}

async function deleteBookmark(meetingId, bookmarkId) {
  await deleteOne('bookmarks', bookmarkId);
}

async function addComment(meetingId, { segmentId, text }) {
  const row = { id: newId('cmt'), meeting_id: meetingId, segment_id: segmentId, text, resolved: false, created_at: Date.now() };
  await putOne('comments', row);
  return row;
}

async function resolveComment(meetingId, commentId, resolved) {
  const existing = await getOne('comments', commentId);
  if (!existing) return null;
  const next = { ...existing, resolved: Boolean(resolved) };
  await putOne('comments', next);
  return next;
}

async function deleteComment(meetingId, commentId) {
  await deleteOne('comments', commentId);
}

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

async function saveTranscriptSnapshot(meetingId, note = '') {
  const segments = await getAllByIndex('segments', 'meeting_id', meetingId);
  const row = {
    id: newId('ver'),
    meeting_id: meetingId,
    created_at: Date.now(),
    note,
    segment_count: segments.length,
    snapshot: segments, // full segment rows, so restore can recreate them exactly
  };
  await putOne('transcript_versions', row);
  return { id: row.id, meetingId, createdAt: row.created_at, note, segmentCount: row.segment_count };
}

async function listTranscriptVersions(meetingId) {
  const versions = await getAllByIndex('transcript_versions', 'meeting_id', meetingId);
  return versions
    .sort((a, b) => b.created_at - a.created_at)
    .map((v) => ({ id: v.id, meeting_id: v.meeting_id, created_at: v.created_at, note: v.note, segment_count: v.segment_count }));
}

async function restoreTranscriptVersion(meetingId, versionId) {
  const version = await getOne('transcript_versions', versionId);
  if (!version) throw new Error('Version not found');
  // Safety snapshot of the current state before overwriting it, mirroring
  // the old SQLite implementation's behavior.
  await saveTranscriptSnapshot(meetingId, 'Before restore');
  await deleteAllByIndex('segments', 'meeting_id', meetingId);
  for (const segment of version.snapshot) {
    await putOne('segments', { ...segment, id: newId('seg') });
  }
  await refreshMeetingSearchCache(meetingId);
  return getMeeting(meetingId);
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

async function saveSummary(meetingId, sections, { source, model = null } = {}) {
  const row = { meeting_id: meetingId, generated_at: Date.now(), source, model, raw_json: JSON.stringify(sections), sections };
  await putOne('summaries', row);
  await refreshMeetingSearchCache(meetingId);
  return row;
}

// ---------------------------------------------------------------------------
// Search cache (see file header note on why this exists)
// ---------------------------------------------------------------------------

function flattenSummaryText(sections) {
  const parts = [];
  for (const value of Object.values(sections || {})) {
    if (typeof value === 'string') {
      if (value.trim()) parts.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') parts.push(item);
        else if (item && typeof item === 'object') {
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

async function refreshMeetingSearchCache(meetingId) {
  const meeting = await getOne('meetings', meetingId);
  if (!meeting) return;
  const [segments, speakers, tagLinks, summary] = await Promise.all([
    getAllByIndex('segments', 'meeting_id', meetingId),
    getAllByIndex('speakers', 'meeting_id', meetingId),
    getAllByIndex('meeting_tags', 'meeting_id', meetingId),
    getOne('summaries', meetingId),
  ]);
  const parts = [
    meeting.title,
    segments.map((s) => s.text).join(' '),
    speakers.map((s) => s.display_name || s.label).join(' '),
    tagLinks.map((l) => l.tag_name).join(' '),
    summary ? flattenSummaryText(summary.sections) : '',
  ];
  await putOne('meetings', { ...meeting, search_text: parts.join(' ').toLowerCase() });
}

// ---------------------------------------------------------------------------
// Recordings (Blobs) & recording sessions (crash recovery)
// ---------------------------------------------------------------------------

async function createRecordingSession(meetingId) {
  const session = { id: newId('rsess'), meeting_id: meetingId, status: 'recording', started_at: Date.now(), last_chunk_index: -1, last_heartbeat_at: Date.now() };
  await putOne('recording_sessions', session);
  return { sessionId: session.id };
}

async function saveMasterChunk(sessionId, meetingId, chunkIndex, blob) {
  await putOne('recording_chunks', { id: `${sessionId}::${chunkIndex}`, session_id: sessionId, meeting_id: meetingId, chunk_index: chunkIndex, blob });
  const session = await getOne('recording_sessions', sessionId);
  if (session) await putOne('recording_sessions', { ...session, last_chunk_index: chunkIndex, last_heartbeat_at: Date.now() });
  return { ok: true };
}

async function setSessionStatus(sessionId, lastChunkIndex, status) {
  const session = await getOne('recording_sessions', sessionId);
  if (!session) return;
  await putOne('recording_sessions', { ...session, status, last_chunk_index: lastChunkIndex, last_heartbeat_at: Date.now() });
}

async function combineSessionChunks(sessionId) {
  const chunks = await getAllByIndex('recording_chunks', 'session_id', sessionId);
  chunks.sort((a, b) => a.chunk_index - b.chunk_index);
  const mimeType = chunks[0]?.blob?.type || 'audio/webm';
  return { blob: new Blob(chunks.map((c) => c.blob), { type: mimeType }), mimeType, chunkIds: chunks.map((c) => c.id) };
}

async function finalizeRecording(sessionId, meetingId, durationMs) {
  const meeting = await getOne('meetings', meetingId);
  if (!meeting) {
    // The meeting was deleted (e.g. while a crash-recovery prompt was
    // still pending) — discard the orphaned session/chunks rather than
    // throwing partway through and leaving a wasted recording Blob behind.
    await discardSession(sessionId);
    return { recordingId: null, discarded: true };
  }

  const { blob, mimeType, chunkIds } = await combineSessionChunks(sessionId);
  const recordingId = newId('rec');
  await putOne('recordings', { id: recordingId, meeting_id: meetingId, blob, mime_type: mimeType, created_at: Date.now() });
  for (const chunkId of chunkIds) await deleteOne('recording_chunks', chunkId);
  await deleteOne('recording_sessions', sessionId);
  await updateMeeting(meetingId, { recording_path: recordingId, recording_format: mimeType, duration_ms: durationMs, status: 'recorded' });
  return { recordingId };
}

async function getUnfinishedSessions() {
  const sessions = await getAll('recording_sessions');
  return sessions.filter((s) => s.status !== 'finalized');
}

async function discardSession(sessionId) {
  const chunks = await getAllByIndex('recording_chunks', 'session_id', sessionId);
  for (const chunk of chunks) await deleteOne('recording_chunks', chunk.id);
  await deleteOne('recording_sessions', sessionId);
}

async function recoverSession(session) {
  return finalizeRecording(session.id, session.meeting_id, Date.now() - session.started_at);
}

/** Returns a playable/exportable object URL for a meeting's recording, or null if it has none. Caller is responsible for revoking it when done (URL.revokeObjectURL). */
async function getRecordingUrl(meeting) {
  if (!meeting?.recording_path) return null;
  const record = await getOne('recordings', meeting.recording_path);
  if (!record) return null;
  return URL.createObjectURL(record.blob);
}

async function getRecordingBlob(meeting) {
  if (!meeting?.recording_path) return null;
  const record = await getOne('recordings', meeting.recording_path);
  return record ? record.blob : null;
}

// ---------------------------------------------------------------------------
// Storage stats & whole-database export/import (used by backup.js)
// ---------------------------------------------------------------------------

async function getStorageStats() {
  const [meetings, recordings] = await Promise.all([getAll('meetings'), getAll('recordings')]);
  return {
    meetingCount: meetings.length,
    totalDurationMs: meetings.reduce((sum, m) => sum + (m.duration_ms || 0), 0),
    dbSizeBytes: null, // IndexedDB doesn't expose a direct size query; see settings.js's use of navigator.storage.estimate() instead
    recordingsSizeBytes: recordings.reduce((sum, r) => sum + (r.blob?.size || 0), 0),
  };
}

const ALL_STORE_NAMES = ['meetings', 'speakers', 'segments', 'bookmarks', 'comments', 'tags', 'meeting_tags', 'summaries', 'transcript_versions', 'recordings', 'settings'];

/** Exports every store as one object, with recording Blobs inlined as base64 — used by backup.js to produce a single downloadable JSON file. */
async function exportAllData() {
  const dump = {};
  for (const storeName of ALL_STORE_NAMES) {
    const rows = await getAll(storeName);
    if (storeName === 'recordings') {
      dump[storeName] = await Promise.all(rows.map(async (r) => ({ ...r, blob: await blobToBase64(r.blob) })));
    } else {
      dump[storeName] = rows;
    }
  }
  return dump;
}

async function importAllData(dump) {
  for (const storeName of ALL_STORE_NAMES) {
    const rows = dump[storeName] || [];
    await withStore(storeName, 'readwrite', async (store) => {
      await reqToPromise(store.clear());
      for (const row of rows) {
        const value = storeName === 'recordings' ? { ...row, blob: base64ToBlob(row.blob, row.mime_type) } : row;
        await reqToPromise(store.put(value));
      }
    });
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(dataUrl, mimeType) {
  const [, base64] = dataUrl.split(',');
  const bytes = atob(base64);
  const array = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) array[i] = bytes.charCodeAt(i);
  return new Blob([array], { type: mimeType || 'application/octet-stream' });
}

export const storage = {
  createMeeting, updateMeeting, getMeeting, deleteMeeting, archiveMeeting, duplicateMeeting, listMeetings,
  addTranscriptSegments, updateTranscriptSegment, deleteTranscriptSegment,
  upsertSpeaker, getSpeakerStats,
  setTags, listAllTags,
  addBookmark, deleteBookmark, addComment, resolveComment, deleteComment,
  saveTranscriptSnapshot, listTranscriptVersions, restoreTranscriptVersion,
  saveSummary,
  createRecordingSession, saveMasterChunk, setSessionStatus, finalizeRecording, getUnfinishedSessions, discardSession, recoverSession,
  getRecordingUrl, getRecordingBlob,
  getStorageStats, exportAllData, importAllData,
};
