'use strict';

/**
 * db.js — the one place the IndexedDB schema is defined. Both storage.js
 * (meetings/segments/recordings/etc.) and settingsStore.js (the `settings`
 * store) need a connection to the same database; extracting this avoids a
 * real bug where whichever module happened to open the database *first*
 * would be the one whose `onupgradeneeded` ran — if that had been
 * settingsStore.js alone, none of storage.js's object stores would exist.
 */

const DB_NAME = 'meetingscribe';
const DB_VERSION = 1;
let dbPromise = null;

export function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;

      const meetings = db.createObjectStore('meetings', { keyPath: 'id' });
      meetings.createIndex('updated_at', 'updated_at');
      meetings.createIndex('created_at', 'created_at');
      meetings.createIndex('archived', 'archived');

      const speakers = db.createObjectStore('speakers', { keyPath: 'id' });
      speakers.createIndex('meeting_id', 'meeting_id');

      const segments = db.createObjectStore('segments', { keyPath: 'id' });
      segments.createIndex('meeting_id', 'meeting_id');

      const bookmarks = db.createObjectStore('bookmarks', { keyPath: 'id' });
      bookmarks.createIndex('meeting_id', 'meeting_id');

      const comments = db.createObjectStore('comments', { keyPath: 'id' });
      comments.createIndex('meeting_id', 'meeting_id');

      db.createObjectStore('tags', { keyPath: 'name' });

      const meetingTags = db.createObjectStore('meeting_tags', { keyPath: 'id' });
      meetingTags.createIndex('meeting_id', 'meeting_id');
      meetingTags.createIndex('tag_name', 'tag_name');

      db.createObjectStore('summaries', { keyPath: 'meeting_id' });

      const versions = db.createObjectStore('transcript_versions', { keyPath: 'id' });
      versions.createIndex('meeting_id', 'meeting_id');

      db.createObjectStore('recordings', { keyPath: 'id' });

      const chunks = db.createObjectStore('recording_chunks', { keyPath: 'id' });
      chunks.createIndex('session_id', 'session_id');

      db.createObjectStore('recording_sessions', { keyPath: 'id' });
      db.createObjectStore('settings', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}
