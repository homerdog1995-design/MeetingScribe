'use strict';

/**
 * heuristicSummarizer.js — produces a structured meeting summary from
 * transcript segments using word-frequency scoring, keyword clustering, and
 * pattern matching, with NO machine learning model and NO network call.
 * This is the fallback used whenever no local LLM (Ollama/llama.cpp) is
 * reachable — see summaryEngine.js.
 *
 * This file has no Node-specific APIs (no fs, no child_process) — it always
 * operated on a plain array of segment objects and returned a plain object.
 * It was accidentally deleted along with the rest of the old main-process
 * during the PWA conversion's directory flatten and is reconstructed here
 * unchanged in spirit: same section shape (executiveSummary, overview,
 * topics, decisions, risks, questionsRaised, actionItems, followUps,
 * openIssues) that summary.js's rendering code already expects.
 */

const STOPWORDS = new Set('a an the and or but if then else when while of to in on for with as at by is are was were be been being this that these those it its it\'s i you he she we they them his her our your their not no do does did have has had can could will would should may might must so very just also than'.split(' '));

function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) || []).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function wordFrequencies(segments) {
  const freq = new Map();
  for (const segment of segments) {
    for (const word of tokenize(segment.text)) {
      freq.set(word, (freq.get(word) || 0) + 1);
    }
  }
  return freq;
}

function scoreSentence(sentence, freq) {
  const words = tokenize(sentence);
  if (!words.length) return 0;
  const total = words.reduce((sum, w) => sum + (freq.get(w) || 0), 0);
  return total / words.length;
}

function buildExecutiveSummary(segments, freq) {
  const sentences = segments.flatMap((s) => splitSentences(s.text).map((text) => ({ text, startMs: s.start_ms, speakerId: s.speaker_id })));
  if (!sentences.length) return '';
  const ranked = [...sentences].sort((a, b) => scoreSentence(b.text, freq) - scoreSentence(a.text, freq));
  const top = ranked.slice(0, 3).sort((a, b) => a.startMs - b.startMs);
  return top.map((s) => s.text).join(' ');
}

function buildOverview(segments) {
  if (!segments.length) return '';
  const durationMs = segments[segments.length - 1].end_ms - segments[0].start_ms;
  const minutes = Math.max(1, Math.round(durationMs / 60000));
  const speakerCount = new Set(segments.map((s) => s.speaker_id).filter(Boolean)).size;
  return `This meeting ran approximately ${minutes} minute${minutes === 1 ? '' : 's'} across ${segments.length} transcribed segment${segments.length === 1 ? '' : 's'}${speakerCount ? ` with ${speakerCount} identified speaker${speakerCount === 1 ? '' : 's'}` : ''}.`;
}

/** Groups segments into rough topic clusters by keyword co-occurrence (a lightweight stand-in for real topic modeling). */
function buildTopics(segments, freq) {
  if (!segments.length) return [];
  const topWords = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w]) => w);
  const clusters = [];
  let current = null;

  for (const segment of segments) {
    const words = new Set(tokenize(segment.text));
    const matchedKeyword = topWords.find((w) => words.has(w));
    if (!current || segment.paragraph_break || (matchedKeyword && matchedKeyword !== current.keyword)) {
      current = { keyword: matchedKeyword || null, segments: [], startMs: segment.start_ms };
      clusters.push(current);
    }
    current.segments.push(segment);
  }

  return clusters
    .filter((c) => c.segments.length >= 1)
    .slice(0, 8)
    .map((cluster) => ({
      label: cluster.keyword ? capitalize(cluster.keyword) : 'General discussion',
      representativeText: cluster.segments[0].text.slice(0, 160),
      startMs: cluster.startMs,
      segmentCount: cluster.segments.length,
    }));
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

const PATTERNS = {
  decisions: /\b(we('ll| will)? (decided|agreed|go with)|let's go with|decision is|final answer|we're going to)\b/i,
  risks: /\b(risk|concern|worried|blocker|problem|issue is|might fail|could delay)\b/i,
  questionsRaised: /\?\s*$/,
  followUps: /\b(follow[- ]?up|circle back|revisit|check in|touch base)\b/i,
  openIssues: /\b(open issue|unresolved|still (need|unclear)|tbd|to be determined|pending)\b/i,
};
const ACTION_VERB_PATTERNS = /\b(will|should|needs? to|has to|is going to|are going to|to-do|todo|action item|please)\b/i;
const OWNER_PATTERN = /\b([A-Z][a-z]+)\s+(?:will|should|needs? to|has to|is going to|to)\b/;
const DUE_HINT_PATTERN = /\b(today|tomorrow|tonight|this week|next week|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|end of day|eod|end of week|eow)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2})\b/i;

function extractByPattern(segments, pattern) {
  const results = [];
  for (const segment of segments) {
    for (const sentence of splitSentences(segment.text)) {
      if (pattern.test(sentence)) {
        results.push({ text: sentence, startMs: segment.start_ms, speakerId: segment.speaker_id });
      }
    }
  }
  return results;
}

function extractActionItems(segments, speakerLabelById) {
  const items = [];
  for (const segment of segments) {
    for (const sentence of splitSentences(segment.text)) {
      if (!ACTION_VERB_PATTERNS.test(sentence)) continue;
      const ownerMatch = OWNER_PATTERN.exec(sentence);
      const dueMatch = DUE_HINT_PATTERN.exec(sentence);
      items.push({
        text: sentence,
        owner: ownerMatch ? ownerMatch[1] : (speakerLabelById.get(segment.speaker_id) || null),
        dueHint: dueMatch ? dueMatch[0] : null,
        startMs: segment.start_ms,
        speakerId: segment.speaker_id,
      });
    }
  }
  return items;
}

/**
 * @param {Array} segments - transcript segment rows (snake_case fields, as stored)
 * @param {Array} speakers - speaker rows for this meeting
 * @returns the full summary sections object
 */
export function summarize(segments, speakers = []) {
  const speakerLabelById = new Map(speakers.map((s) => [s.id, s.display_name || s.label]));
  const freq = wordFrequencies(segments);

  return {
    executiveSummary: buildExecutiveSummary(segments, freq),
    overview: buildOverview(segments),
    topics: buildTopics(segments, freq),
    decisions: extractByPattern(segments, PATTERNS.decisions),
    risks: extractByPattern(segments, PATTERNS.risks),
    questionsRaised: extractByPattern(segments, PATTERNS.questionsRaised),
    actionItems: extractActionItems(segments, speakerLabelById),
    followUps: extractByPattern(segments, PATTERNS.followUps),
    openIssues: extractByPattern(segments, PATTERNS.openIssues),
  };
}
