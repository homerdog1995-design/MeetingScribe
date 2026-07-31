'use strict';

/**
 * Orchestrates meeting summarization. Tries a local LLM first (Ollama or
 * llama.cpp server, both reached only over 127.0.0.1 — see security.js for
 * the network allow-list that makes this the only reachable destination),
 * validates the model's JSON response against an expected shape, and falls
 * back to the always-available heuristic summarizer (heuristicSummarizer.js)
 * if no engine is available or the LLM response fails validation.
 */

const logger = require('./logger');
const heuristicSummarizer = require('./heuristicSummarizer');
const modelDetection = require('./modelDetection');

const EXPECTED_KEYS = [
  'executiveSummary', 'overview', 'topics', 'decisions', 'risks',
  'questionsRaised', 'actionItems', 'followUps', 'openIssues',
];

const SYSTEM_PROMPT = `You summarize meeting transcripts. Respond with ONLY a single JSON object (no markdown fences, no commentary) with exactly these keys:
{
  "executiveSummary": "2-4 sentence high-level summary",
  "overview": "one paragraph describing what the meeting covered",
  "topics": [{"label": "short topic name", "representativeText": "a representative sentence"}],
  "decisions": [{"text": "decision made"}],
  "risks": [{"text": "risk or concern raised"}],
  "questionsRaised": [{"text": "a question that was asked"}],
  "actionItems": [{"text": "the action", "owner": "person or null", "dueHint": "deadline mentioned or null"}],
  "followUps": [{"text": "follow-up item"}],
  "openIssues": [{"text": "unresolved issue"}]
}
Use an empty array for any section with nothing relevant. Do not invent information not present in the transcript.`;

function chunkTranscript(transcriptText, maxChars) {
  if (transcriptText.length <= maxChars) return [transcriptText];
  const chunks = [];
  let start = 0;
  while (start < transcriptText.length) {
    chunks.push(transcriptText.slice(start, start + maxChars));
    start += maxChars;
  }
  return chunks;
}

function buildTranscriptText(segments) {
  return segments.map((s) => `[${formatTimestamp(s.startMs)}] ${s.text}`).join('\n');
}

function formatTimestamp(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

async function callOllama({ port, model, prompt }) {
  const response = await fetch(`http://127.0.0.1:${port}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, system: SYSTEM_PROMPT, prompt, stream: false, format: 'json' }),
  });
  if (!response.ok) throw new Error(`Ollama responded with status ${response.status}`);
  const data = await response.json();
  return data.response;
}

async function callLlamaCpp({ port, prompt }) {
  const response = await fetch(`http://127.0.0.1:${port}/completion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: `${SYSTEM_PROMPT}\n\n${prompt}`, n_predict: 1024, temperature: 0.2 }),
  });
  if (!response.ok) throw new Error(`llama.cpp server responded with status ${response.status}`);
  const data = await response.json();
  return data.content;
}

function tryParseJson(rawText) {
  // Models occasionally wrap JSON in a markdown fence despite instructions;
  // strip that defensively before parsing.
  const cleaned = rawText.trim().replace(/^```json\s*/i, '').replace(/```$/i, '');
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) return null;
  try {
    return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

function validateShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  return EXPECTED_KEYS.every((key) => key in parsed);
}

function normalizeLlmSections(parsed, segments) {
  // The model only sees text, not our internal segment IDs/timestamps, so we
  // best-effort match each extracted sentence back to a segment for a
  // timestamp; if no match is found the item still displays, just without a
  // clickable timestamp.
  const findTimestamp = (text) => {
    if (!text) return null;
    const needle = text.slice(0, 40).toLowerCase();
    const match = segments.find((s) => s.text.toLowerCase().includes(needle.slice(0, 20)));
    return match ? match.startMs : null;
  };

  const withTimestamps = (arr) => (Array.isArray(arr) ? arr.map((item) => ({ ...item, startMs: findTimestamp(item.text) })) : []);

  return {
    executiveSummary: parsed.executiveSummary || '',
    overview: parsed.overview || '',
    topics: withTimestamps(parsed.topics),
    decisions: withTimestamps(parsed.decisions),
    risks: withTimestamps(parsed.risks),
    questionsRaised: withTimestamps(parsed.questionsRaised),
    actionItems: withTimestamps(parsed.actionItems),
    followUps: withTimestamps(parsed.followUps),
    openIssues: withTimestamps(parsed.openIssues),
  };
}

/**
 * @param {{segments: object[]}} meeting
 * @param {object} settings full app settings (for engine preference + ports)
 * @returns {{sections: object, source: string, model: ?string}}
 */
async function generateSummary(meeting, settings) {
  const segments = meeting.segments.filter((s) => s.text && s.text.trim());
  const preference = settings.summaryPreferences.preferredEngine;

  if (segments.length === 0) {
    return { sections: heuristicSummarizer.summarize([]), source: 'heuristic', model: null };
  }

  const transcriptText = buildTranscriptText(segments);
  const maxCharsPerChunk = 12000; // conservative context budget for a local 7-8B model
  const chunks = chunkTranscript(transcriptText, maxCharsPerChunk);
  const prompt = chunks.length === 1
    ? chunks[0]
    : `${chunks[0]}\n\n[Note: transcript truncated to the first portion due to length; summarize what is present.]`;

  if (preference !== 'heuristic') {
    const attempted = [];

    if (preference === 'auto' || preference === 'ollama') {
      const ollamaStatus = await modelDetection.detectOllama(settings.engines.ollama.port);
      if (ollamaStatus.available) {
        const model = settings.summaryPreferences.preferredModel || ollamaStatus.models[0];
        attempted.push('ollama');
        try {
          const raw = await callOllama({ port: settings.engines.ollama.port, model, prompt });
          const parsed = tryParseJson(raw);
          if (validateShape(parsed)) {
            return { sections: normalizeLlmSections(parsed, segments), source: 'ollama', model };
          }
          logger.warn('summaryEngine', 'Ollama response failed shape validation; falling back');
        } catch (err) {
          logger.warn('summaryEngine', 'Ollama call failed; falling back', { error: err.message });
        }
      }
    }

    if (preference === 'auto' || preference === 'llamacpp') {
      const llamaStatus = await modelDetection.detectLlamaCpp(settings.engines.llamaCpp.port);
      if (llamaStatus.available) {
        attempted.push('llamacpp');
        try {
          const raw = await callLlamaCpp({ port: settings.engines.llamaCpp.port, prompt });
          const parsed = tryParseJson(raw);
          if (validateShape(parsed)) {
            return { sections: normalizeLlmSections(parsed, segments), source: 'llamacpp', model: 'llama.cpp-server' };
          }
          logger.warn('summaryEngine', 'llama.cpp response failed shape validation; falling back');
        } catch (err) {
          logger.warn('summaryEngine', 'llama.cpp call failed; falling back', { error: err.message });
        }
      }
    }

    logger.info('summaryEngine', 'No usable local LLM; using heuristic summarizer', { attempted });
  }

  return { sections: heuristicSummarizer.summarize(segments.map(toHeuristicSegment)), source: 'heuristic', model: null };
}

function toHeuristicSegment(s) {
  return { id: s.id, text: s.text, startMs: s.start_ms ?? s.startMs, endMs: s.end_ms ?? s.endMs, speakerId: s.speaker_id ?? s.speakerId };
}

module.exports = { generateSummary };
