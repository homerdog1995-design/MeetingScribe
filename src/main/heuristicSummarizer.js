'use strict';

/**
 * A genuine extractive summarizer with zero external dependencies and zero
 * network calls, used whenever no local LLM (Ollama/llama.cpp) is detected.
 *
 * Method:
 *  - Each transcript segment is treated as the atomic unit (whisper-style
 *    engines already emit punctuated, sentence-like segments, and keeping
 *    the segment as the unit means every extracted sentence has an exact,
 *    correct timestamp — re-splitting into finer sentences and trying to
 *    re-derive timestamps would be guesswork).
 *  - TF-IDF vectors are computed over the segment set restricted to the
 *    N most informative terms (by document frequency, excluding very rare
 *    and near-universal terms) to keep the vector space small and the
 *    clustering/ranking fast even for a multi-hour meeting.
 *  - "Executive Summary" / "Meeting Overview" sentences are chosen by a
 *    TextRank-style graph centrality score: build a similarity graph
 *    (cosine similarity between segment TF-IDF vectors) and run power
 *    iteration to convergence, exactly as in the original TextRank paper
 *    applied to sentences instead of a lexical graph.
 *  - "Discussion Topics" are produced by k-means clustering the same
 *    vectors; each cluster is labelled with its top terms and its most
 *    central segment is kept as a representative excerpt.
 *  - Decisions / Risks / Questions / Action items / Follow-ups / Open issues
 *    are produced by curated keyword and light-grammar pattern matching.
 *    These are heuristics, not a language model, and are presented to the
 *    user labelled as such (`source: 'heuristic'`).
 */

const STOPWORDS = new Set([
  'a','about','above','after','again','against','all','am','an','and','any','are',
  "aren't",'as','at','be','because','been','before','being','below','between','both',
  'but','by','can','cannot','could',"couldn't",'did',"didn't",'do','does',"doesn't",
  'doing','down','during','each','few','for','from','further','had',"hadn't",'has',
  "hasn't",'have',"haven't",'having','he',"he'd","he'll","he's",'her','here',"here's",
  'hers','herself','him','himself','his','how',"how's",'i',"i'd","i'll","i'm","i've",
  'if','in','into','is',"isn't",'it',"it's",'its','itself',"let's",'me','more','most',
  "mustn't",'my','myself','no','nor','not','of','off','on','once','only','or','other',
  'ought','our','ours','ourselves','out','over','own','same',"shan't",'she',"she'd",
  "she'll","she's",'should',"shouldn't",'so','some','such','than','that',"that's",
  'the','their','theirs','them','themselves','then','there',"there's",'these','they',
  "they'd","they'll","they're","they've",'this','those','through','to','too','under',
  'until','up','very','was',"wasn't",'we',"we'd","we'll","we're","we've",'were',
  "weren't",'what',"what's",'when',"when's",'where',"where's",'which','while','who',
  "who's",'whom','why',"why's",'with',"won't",'would',"wouldn't",'you',"you'd",
  "you'll","you're","you've",'your','yours','yourself','yourselves','yeah','okay',
  'ok','um','uh','like','just','really','gonna','kind','sort','actually','basically',
]);

const DECISION_PATTERNS = /\b(we(?:'ve| have)? decided|we agreed|let's go with|we'll go with|decision(?: is)?:|we are going with|final(?:ly)? decided|settled on|approved)\b/i;
const RISK_PATTERNS = /\b(risk|concern|worried|problem|issue|blocker|bottleneck|challenge|might fail|could delay|dependency)\b/i;
const FOLLOW_UP_PATTERNS = /\b(follow up|follow-up|circle back|revisit|next (?:time|meeting|week)|later on|come back to)\b/i;
const OPEN_ISSUE_PATTERNS = /\b(still need to|not sure yet|unresolved|open question|to be determined|tbd|haven't decided|pending decision|unclear)\b/i;
const ACTION_VERB_PATTERNS = /\b(will|should|needs? to|has to|is going to|are going to|to-do|todo|action item|please)\b/i;
const OWNER_PATTERN = /^([A-Z][a-zA-Z'.-]{1,20})\s*,?\s+(?:will|should|to|needs? to|is going to|can you|could you)\b/;
const DEADLINE_HINT_PATTERN = /\b(by (?:end of |)(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week|[a-z]+ \d{1,2}(?:st|nd|rd|th)?)|end of (?:day|week|month|quarter)|eod|eow|before the next meeting)\b/i;

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) || []).filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function splitIntoSentences(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parts = trimmed.match(/[^.!?]+[.!?]*/g) || [trimmed];
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Builds TF-IDF vectors over a restricted, informative vocabulary. */
function buildTfIdfVectors(segments, { maxVocabSize = 400 } = {}) {
  const docTermCounts = segments.map((seg) => {
    const counts = new Map();
    for (const term of tokenize(seg.text)) counts.set(term, (counts.get(term) || 0) + 1);
    return counts;
  });

  const documentFrequency = new Map();
  for (const counts of docTermCounts) {
    for (const term of counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
  }

  const n = segments.length;
  const maxDf = Math.max(2, Math.floor(n * 0.85)); // drop near-universal filler terms
  const candidateTerms = [...documentFrequency.entries()]
    .filter(([, df]) => df >= 1 && df <= maxDf)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxVocabSize)
    .map(([term]) => term);

  const termIndex = new Map(candidateTerms.map((t, i) => [t, i]));
  const idf = candidateTerms.map((term) => Math.log((n + 1) / (1 + documentFrequency.get(term))) + 1);

  const vectors = docTermCounts.map((counts) => {
    const vec = new Float64Array(candidateTerms.length);
    let totalTerms = 0;
    for (const c of counts.values()) totalTerms += c;
    for (const [term, count] of counts.entries()) {
      const idx = termIndex.get(term);
      if (idx === undefined) continue;
      const tf = count / Math.max(1, totalTerms);
      vec[idx] = tf * idf[idx];
    }
    return normalize(vec);
  });

  return { vectors, vocabulary: candidateTerms };
}

function normalize(vec) {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return vec;
  const out = new Float64Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** TextRank-style centrality score via power iteration on a cosine-similarity graph. */
function rankSentences(vectors, { damping = 0.85, iterations = 40 } = {}) {
  const n = vectors.length;
  if (n === 0) return [];
  if (n === 1) return [1];

  const similarity = Array.from({ length: n }, () => new Float64Array(n));
  const outWeightSum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const sim = Math.max(0, dot(vectors[i], vectors[j]));
      similarity[i][j] = sim;
      outWeightSum[i] += sim;
    }
  }

  let scores = new Float64Array(n).fill(1 / n);
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Float64Array(n).fill((1 - damping) / n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j || outWeightSum[j] === 0) continue;
        next[i] += damping * (similarity[j][i] / outWeightSum[j]) * scores[j];
      }
    }
    scores = next;
  }
  return Array.from(scores);
}

/** Simple k-means over TF-IDF vectors using cosine similarity (dot product of normalized vectors). */
function kMeansCluster(vectors, k, { iterations = 30, seed = 42 } = {}) {
  const n = vectors.length;
  if (n === 0) return [];
  if (k >= n) return vectors.map((_, i) => i);

  const rng = mulberry32(seed);
  const centroidIdx = new Set();
  while (centroidIdx.size < k) centroidIdx.add(Math.floor(rng() * n));
  let centroids = [...centroidIdx].map((i) => vectors[i].slice());

  let assignments = new Array(n).fill(0);
  for (let iter = 0; iter < iterations; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestScore = -Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const score = dot(vectors[i], centroids[c]);
        if (score > bestScore) { bestScore = score; best = c; }
      }
      if (assignments[i] !== best) changed = true;
      assignments[i] = best;
    }

    const dim = vectors[0].length;
    const sums = Array.from({ length: k }, () => new Float64Array(dim));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      counts[c]++;
      for (let d = 0; d < dim; d++) sums[c][d] += vectors[i][d];
    }
    centroids = sums.map((sum, c) => (counts[c] > 0 ? normalize(sum.map((v) => v / counts[c])) : centroids[c]));

    if (!changed) break;
  }
  return assignments;
}

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chooseClusterCount(n) {
  return Math.max(1, Math.min(8, Math.round(Math.sqrt(n / 2))));
}

function extractByPattern(segments, pattern) {
  return segments
    .filter((seg) => pattern.test(seg.text))
    .map((seg) => ({ text: seg.text.trim(), startMs: seg.startMs, speakerId: seg.speakerId || null }));
}

function extractActionItems(segments) {
  const items = [];
  for (const seg of segments) {
    for (const sentence of splitIntoSentences(seg.text)) {
      if (!ACTION_VERB_PATTERNS.test(sentence)) continue;
      const ownerMatch = sentence.match(OWNER_PATTERN);
      const deadlineMatch = sentence.match(DEADLINE_HINT_PATTERN);
      items.push({
        text: sentence,
        owner: ownerMatch ? ownerMatch[1] : null,
        dueHint: deadlineMatch ? deadlineMatch[0] : null,
        startMs: seg.startMs,
        speakerId: seg.speakerId || null,
      });
    }
  }
  return items;
}

function extractQuestions(segments) {
  const questions = [];
  for (const seg of segments) {
    for (const sentence of splitIntoSentences(seg.text)) {
      if (sentence.trim().endsWith('?')) {
        questions.push({ text: sentence, startMs: seg.startMs, speakerId: seg.speakerId || null });
      }
    }
  }
  return questions;
}

/**
 * @param {{id:string,text:string,startMs:number,endMs:number,speakerId:?string}[]} segments
 * @returns {object} structured summary sections (see ARCHITECTURE.md §6)
 */
function summarize(segments) {
  const cleanSegments = segments.filter((s) => s.text && s.text.trim().length > 0);
  if (cleanSegments.length === 0) {
    return emptySummary();
  }

  const { vectors } = buildTfIdfVectors(cleanSegments);
  const scores = rankSentences(vectors);

  const ranked = cleanSegments
    .map((seg, i) => ({ seg, score: scores[i] }))
    .sort((a, b) => b.score - a.score);

  const executiveSummarySentences = ranked.slice(0, Math.min(3, ranked.length))
    .sort((a, b) => a.seg.startMs - b.seg.startMs)
    .map((r) => r.seg.text.trim());

  const overviewCount = Math.min(8, Math.max(3, Math.round(cleanSegments.length * 0.12)));
  const overviewSentences = ranked.slice(0, overviewCount)
    .sort((a, b) => a.seg.startMs - b.seg.startMs)
    .map((r) => r.seg.text.trim());

  const k = chooseClusterCount(cleanSegments.length);
  const assignments = kMeansCluster(vectors, k);
  const topics = buildTopics(cleanSegments, vectors, assignments, k, scores);

  return {
    executiveSummary: executiveSummarySentences.join(' '),
    overview: overviewSentences.join(' '),
    topics,
    decisions: extractByPattern(cleanSegments, DECISION_PATTERNS),
    risks: extractByPattern(cleanSegments, RISK_PATTERNS),
    questionsRaised: extractQuestions(cleanSegments),
    actionItems: extractActionItems(cleanSegments),
    followUps: extractByPattern(cleanSegments, FOLLOW_UP_PATTERNS),
    openIssues: extractByPattern(cleanSegments, OPEN_ISSUE_PATTERNS),
  };
}

function buildTopics(segments, vectors, assignments, k, scores) {
  const clusters = Array.from({ length: k }, () => ({ indices: [] }));
  assignments.forEach((clusterIdx, i) => clusters[clusterIdx].indices.push(i));

  return clusters
    .filter((c) => c.indices.length > 0)
    .map((cluster) => {
      const termWeights = new Map();
      for (const i of cluster.indices) {
        tokenize(segments[i].text).forEach((term) => termWeights.set(term, (termWeights.get(term) || 0) + 1));
      }
      const topTerms = [...termWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);

      const best = cluster.indices.reduce((a, b) => (scores[a] >= scores[b] ? a : b));
      return {
        label: topTerms.length ? topTerms.join(', ') : 'General discussion',
        representativeText: segments[best].text.trim(),
        startMs: segments[best].startMs,
        segmentCount: cluster.indices.length,
      };
    })
    .sort((a, b) => a.startMs - b.startMs);
}

function emptySummary() {
  return {
    executiveSummary: '',
    overview: '',
    topics: [],
    decisions: [],
    risks: [],
    questionsRaised: [],
    actionItems: [],
    followUps: [],
    openIssues: [],
  };
}

module.exports = { summarize, tokenize, buildTfIdfVectors, rankSentences };
