'use strict';

/**
 * summaryEngine.js — browser reconstruction of the deleted main-process
 * summaryEngine.js. The core idea is unchanged: try a local LLM server
 * (Ollama or llama.cpp's server mode) first, fall back to the pure-JS
 * heuristic summarizer if neither is reachable.
 *
 * A REAL NEW LIMITATION, NOT PRESENT IN THE ELECTRON VERSION: the old code
 * ran in the main process, where Node's HTTP client has no concept of CORS
 * at all — it could always reach http://127.0.0.1:11434 (Ollama) or :8080
 * (llama.cpp). A browser page's `fetch()` to those same local ports IS
 * subject to CORS, and neither server allows arbitrary origins by default.
 * Concretely: Ollama needs `OLLAMA_ORIGINS` set to include this app's exact
 * origin before a summary request will succeed; llama.cpp's server needs to
 * be started with `--cors` (or "Access-Control-Allow-Origin" enabled some
 * other way). Detection (checkOllama/checkLlamaCpp below) will report
 * "not available" if this isn't configured, and generate() falls back to
 * the heuristic summarizer automatically — this degrades gracefully rather
 * than failing outright, but it's worth knowing this is a browser-specific
 * hurdle. Documented in docs/MODEL_SETUP.md.
 */

import { summarize } from './heuristicSummarizer.js';
import { settingsStore } from './settingsStore.js';
import { storage } from './storage.js';

const REQUEST_TIMEOUT_MS = 1500;

async function checkOllama(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/tags`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) return { available: false, models: [] };
    const data = await response.json();
    return { available: true, models: (data.models || []).map((m) => m.name) };
  } catch {
    return { available: false, models: [] };
  }
}

async function checkLlamaCpp(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return { available: response.ok };
  } catch {
    return { available: false };
  }
}

function buildPrompt(segments) {
  const transcriptText = segments.map((s) => s.text).join(' ').slice(0, 12000); // keep prompts a reasonable size
  return `You are summarizing a meeting transcript. Respond ONLY with JSON matching this exact shape — no prose, no markdown fences:
{"executiveSummary":string,"overview":string,"topics":[{"label":string,"representativeText":string}],"decisions":[{"text":string}],"risks":[{"text":string}],"questionsRaised":[{"text":string}],"actionItems":[{"text":string,"owner":string|null,"dueHint":string|null}],"followUps":[{"text":string}],"openIssues":[{"text":string}]}

Transcript:
${transcriptText}`;
}

async function callOllama(port, model, prompt) {
  const response = await fetch(`http://127.0.0.1:${port}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, format: 'json' }),
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
  const data = await response.json();
  return JSON.parse(data.response);
}

async function callLlamaCpp(port, prompt) {
  const response = await fetch(`http://127.0.0.1:${port}/completion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, n_predict: 800 }),
  });
  if (!response.ok) throw new Error(`llama.cpp server returned HTTP ${response.status}`);
  const data = await response.json();
  return JSON.parse(data.content);
}

const EXPECTED_KEYS = ['executiveSummary', 'overview', 'topics', 'decisions', 'risks', 'questionsRaised', 'actionItems', 'followUps', 'openIssues'];

function normalizeLlmSections(parsed) {
  const sections = {};
  for (const key of EXPECTED_KEYS) {
    sections[key] = parsed[key] ?? (key === 'executiveSummary' || key === 'overview' ? '' : []);
  }
  return sections;
}

export async function generate(meetingId) {
  const meeting = await storage.getMeeting(meetingId);
  if (!meeting) throw new Error('Meeting not found');
  const settings = await settingsStore.get();
  const preferred = settings.summaryPreferences.preferredEngine;

  let sections = null;
  let source = 'heuristic';
  let model = null;

  if (preferred === 'auto' || preferred === 'ollama') {
    const status = await checkOllama(settings.engines.ollama.port);
    if (status.available && status.models.length) {
      try {
        model = settings.summaryPreferences.preferredModel || status.models[0];
        sections = normalizeLlmSections(await callOllama(settings.engines.ollama.port, model, buildPrompt(meeting.segments)));
        source = 'ollama';
      } catch (error) {
        console.warn('Ollama summary attempt failed, falling back:', error);
      }
    }
  }

  if (!sections && (preferred === 'auto' || preferred === 'llamacpp')) {
    const status = await checkLlamaCpp(settings.engines.llamaCpp.port);
    if (status.available) {
      try {
        sections = normalizeLlmSections(await callLlamaCpp(settings.engines.llamaCpp.port, buildPrompt(meeting.segments)));
        source = 'llamacpp';
      } catch (error) {
        console.warn('llama.cpp summary attempt failed, falling back:', error);
      }
    }
  }

  if (!sections) {
    sections = summarize(meeting.segments, meeting.speakers);
    source = 'heuristic';
  }

  return storage.saveSummary(meetingId, sections, { source, model });
}

export async function detectAvailableLlm() {
  const settings = await settingsStore.get();
  const [ollama, llamaCpp] = await Promise.all([
    checkOllama(settings.engines.ollama.port),
    checkLlamaCpp(settings.engines.llamaCpp.port),
  ]);
  return { ollama, llamaCpp };
}
