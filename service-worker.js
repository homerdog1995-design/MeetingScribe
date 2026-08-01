'use strict';

/**
 * service-worker.js — the piece that makes "offline use" and "installable"
 * actually true for a browser, neither of which Electron ever needed
 * (file:// loading already worked with no network, and Electron apps don't
 * need a manifest to be "installed" — they're already a native app).
 *
 * STRATEGY: cache-first for every file this app ships. Once installed, the
 * whole UI should load with the network completely off. Anything NOT
 * same-origin (a local Ollama/llama.cpp request, for instance) is left
 * alone entirely — intercepting or caching those would be wrong, since an
 * LLM server's response should never be served stale from a cache.
 */

// IMPORTANT: bump this on every deploy that changes any cached file's
// content. Browsers only re-check this script byte-for-byte; if this exact
// string doesn't change, the old cache (and therefore old, stale JS) keeps
// being served indefinitely even after new code is pushed to the server.
const CACHE_VERSION = 'meetingscribe-v20';

const PRECACHE_URLS = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './js/renderer.js',
  './js/state.js',
  './js/utils.js',
  './js/hotkeys.js',
  './js/db.js',
  './js/storage.js',
  './js/settingsStore.js',
  './js/backup.js',
  './js/logger.js',
  './js/modelDetection.js',
  './js/summaryEngine.js',
  './js/heuristicSummarizer.js',
  './js/audio.js',
  './js/recording.js',
  './js/transcription.js',
  './js/transcription/providerBase.js',
  './js/transcription/sherpaAsr.js',
  './js/transcription/sherpaAsrWorker.js',
  './js/transcription/webSpeech.js',
  './js/editor.js',
  './js/speakers.js',
  './js/summary.js',
  './js/library.js',
  './js/search.js',
  './js/timeline.js',
  './js/playback.js',
  './js/export.js',
  './js/exportEngine.js',
  './js/exporters/shared.js',
  './js/exporters/txt.js',
  './js/exporters/markdown.js',
  './js/exporters/csv.js',
  './js/exporters/json.js',
  './js/exporters/html.js',
  './js/exporters/rtf.js',
  './js/settings.js',
  './js/diarization.js',
  './js/diarizationWorker.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin requests (local LLM servers, etc.)

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((response) => {
          // Opportunistically cache anything fetched successfully — this
          // covers optional, user-supplied assets (e.g. assets/whisper-wasm/*)
          // that aren't in the precache list because they may not exist.
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          if (request.mode === 'navigate') return caches.match('./index.html');
          throw new Error('Offline and not cached');
        });
    }),
  );
});
