'use strict';

import { store } from './state.js';
import { storage } from './storage.js';
import { transcriptionManager } from './transcription.js';
import {
  qs, qsa, el, formatTimestamp, debounce, showToast, openModal, colorForSpeakerIndex,
} from './utils.js';

/**
 * Editing model
 * -------------
 * #transcript-editor is a single contenteditable region containing one
 * `.segment` block per transcript segment. Raw text typing is left to the
 * browser's native contenteditable behavior (including its own undo/redo via
 * Ctrl+Z, which works automatically with no code here) — we reconcile the
 * DOM back into segment rows on a debounced `input` handler. Everything
 * else the toolbar exposes (highlight, comment, bookmark, speaker
 * reassignment, timestamp edits) is a discrete, storage-backed action that
 * goes through a small command-pattern undo stack (`runAction`), because
 * those are data-model operations the browser's native undo has no
 * knowledge of. There is no non-deprecated API to trigger the browser's own
 * contenteditable undo from a toolbar button (that would require
 * `document.execCommand`), so the Undo/Redo toolbar buttons intentionally
 * cover structural actions only — a disclosed, deliberate scope boundary.
 *
 * Highlighting operates at the segment granularity (the schema stores one
 * `highlighted` flag per segment) rather than arbitrary sub-string ranges.
 */

let currentMeetingId = null;
const editorState = { segments: [], speakers: [], comments: [], bookmarks: [] };
const undoStack = { past: [], future: [] };
const findState = { query: '', total: 0, currentPosition: 0 };

let autosaveIntervalHandle = null;
let dirtySinceLastSnapshot = false;

export function initEditor() {
  wireToolbarButtons();
  initTextEditingHandlers();
  initFindReplace();
  initKeyboardShortcuts();

  store.subscribe('currentMeeting', (meeting) => {
    if (meeting) renderTranscript(meeting);
  });
  store.subscribe('settings', (settings) => restartAutosaveTimer(settings));

  transcriptionManager.addEventListener('segment', ({ detail }) => {
    if (currentMeetingId) handleLiveSegment(currentMeetingId, detail);
  });

  document.addEventListener('speakers-updated', () => {
    const meeting = store.get('currentMeeting');
    if (meeting) refreshSpeakerLabelsInDom(meeting);
  });

  restartAutosaveTimer(store.get('settings'));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTranscript(meeting) {
  currentMeetingId = meeting.id;
  editorState.segments = meeting.segments;
  editorState.speakers = meeting.speakers;
  editorState.comments = meeting.comments;
  editorState.bookmarks = meeting.bookmarks;

  const editorEl = qs('#transcript-editor');
  editorEl.innerHTML = '';

  if (!meeting.segments.length) {
    editorEl.appendChild(el('p', { class: 'settings-help', contenteditable: 'false' },
      'The transcript will appear here once recording starts, or you can type notes directly.'));
  } else {
    meeting.segments.forEach((segment) => editorEl.appendChild(buildSegmentNode(segment, meeting)));
  }

  renderCommentsPanel(meeting);
  markAutosaveState('saved');
}

function buildSegmentNode(segment, meeting) {
  const speaker = meeting.speakers.find((s) => s.id === segment.speaker_id);
  const bookmarked = meeting.bookmarks.some((b) => segment.start_ms <= b.time_ms && b.time_ms < segment.end_ms);
  const commented = meeting.comments.some((c) => c.segment_id === segment.id && !c.resolved);

  const wrapper = el('div', { class: 'segment', dataset: { segmentId: segment.id } });
  if (segment.paragraph_break) wrapper.classList.add('paragraph-break');
  if (bookmarked) wrapper.classList.add('bookmarked');
  if (commented) wrapper.classList.add('commented');

  const timestampNode = el('span', { class: 'segment-timestamp', contenteditable: 'false' }, formatTimestamp(segment.start_ms));
  timestampNode.title = 'Click to edit this timestamp';
  timestampNode.addEventListener('click', (event) => {
    event.stopPropagation();
    startTimestampEdit(segment, timestampNode);
  });

  const speakerNode = el('span', { class: 'segment-speaker', contenteditable: 'false' },
    speaker ? (speaker.display_name || speaker.label) : 'Unassigned');
  speakerNode.style.color = speaker ? speaker.color : 'var(--color-ink-faint)';
  speakerNode.title = 'Click to reassign speaker';
  speakerNode.addEventListener('click', (event) => {
    event.stopPropagation();
    openSpeakerMenu(segment);
  });

  const textNode = el('span', { class: `segment-text${segment.highlighted ? ' highlighted' : ''}`, dataset: { segmentId: segment.id } }, segment.text);

  wrapper.append(timestampNode, ' ', speakerNode, ' ', textNode, ' ');
  return wrapper;
}

function refreshSpeakerLabelsInDom(meeting) {
  qsa('.segment', qs('#transcript-editor')).forEach((wrapper) => {
    const segmentId = wrapper.dataset.segmentId;
    const segment = getSegmentById(segmentId);
    const speakerNode = wrapper.querySelector('.segment-speaker');
    if (!segment || !speakerNode) return;
    const speaker = meeting.speakers.find((s) => s.id === segment.speaker_id);
    speakerNode.textContent = speaker ? (speaker.display_name || speaker.label) : 'Unassigned';
    speakerNode.style.color = speaker ? speaker.color : 'var(--color-ink-faint)';
  });
}

function getSegmentById(segmentId) {
  return editorState.segments.find((s) => s.id === segmentId);
}

function setSegmentCacheField(segmentId, field, value) {
  const segment = getSegmentById(segmentId);
  if (segment) segment[field] = value;
}

// ---------------------------------------------------------------------------
// Undo / redo (structural actions)
// ---------------------------------------------------------------------------

async function runAction(action) {
  await action.do();
  undoStack.past.push(action);
  undoStack.future = [];
  dirtySinceLastSnapshot = true;
}

async function undo() {
  const action = undoStack.past.pop();
  if (!action) return;
  await action.undo();
  undoStack.future.push(action);
}

async function redo() {
  const action = undoStack.future.pop();
  if (!action) return;
  await action.do();
  undoStack.past.push(action);
}

// ---------------------------------------------------------------------------
// Live transcription -> persisted segments
// ---------------------------------------------------------------------------

const MAX_AUTO_SPEAKERS = 4;
let speakerRoundRobin = [];
let currentSpeakerSlot = -1;
let lastSegmentEndMs = null;

let lastCommittedText = null;
let lastCommittedAtPerfMs = 0;

async function handleLiveSegment(meetingId, detail) {
  const text = detail.text.trim();
  if (!text) return;

  // Belt-and-braces dedup: regardless of exactly where a duplicate
  // delivery originates (a browser-level quirk in continuous speech
  // recognition, or any other source), the same text should never be
  // committed twice in a row within a short window — that's what an
  // "echo" in the transcript actually looks like from the user's side.
  const nowPerf = performance.now();
  if (text === lastCommittedText && nowPerf - lastCommittedAtPerfMs < 4000) {
    return;
  }
  lastCommittedText = text;
  lastCommittedAtPerfMs = nowPerf;

  const settings = store.get('settings');
  // Web Speech only ever reports the instant a result arrived (both start
  // and end are the same timestamp — it has no real acoustic boundaries
  // the way Whisper does), and its delivery is bursty: results often
  // arrive in clumps after each internal session restart (roughly every
  // 5-7 seconds). The configured speaker-change threshold (default 700ms)
  // is tuned for real timestamps and was almost certainly misfiring
  // constantly for a single continuous speaker under Web Speech. Use a
  // much longer, less trigger-happy threshold specifically for it.
  const silenceThresholdMs = transcriptionManager.isWebSpeech
    ? 3500
    : (settings?.transcriptionPreferences?.speakerChangeSilenceMs ?? 700);
  const isTurn = detail.speakerTurn || lastSegmentEndMs === null || (detail.startMs - lastSegmentEndMs >= silenceThresholdMs);

  if (isTurn) await advanceSpeakerSlot(meetingId);
  lastSegmentEndMs = detail.endMs;

  const speakerId = speakerRoundRobin[currentSpeakerSlot] || null;

  await storage.addTranscriptSegments(meetingId, [{
    speakerId,
    startMs: Math.round(detail.startMs),
    endMs: Math.round(detail.endMs),
    text,
    confidence: detail.confidence,
    paragraphBreak: isTurn,
  }]);

  const refreshed = await storage.getMeeting(meetingId);
  store.set('currentMeeting', refreshed);
  dirtySinceLastSnapshot = true;
  scrollTranscriptToBottom();
}

async function advanceSpeakerSlot(meetingId) {
  if (speakerRoundRobin.length < MAX_AUTO_SPEAKERS) {
    const index = speakerRoundRobin.length;
    const speaker = await storage.upsertSpeaker(meetingId, {
      label: `Speaker ${index + 1}`,
      display_name: null,
      color: colorForSpeakerIndex(index),
    });
    speakerRoundRobin.push(speaker.id);
    currentSpeakerSlot = index;
  } else {
    currentSpeakerSlot = (currentSpeakerSlot + 1) % speakerRoundRobin.length;
  }
}

function resetSpeakerRotation(meeting) {
  lastCommittedText = null;
  lastCommittedAtPerfMs = 0;
  speakerRoundRobin = meeting.speakers.slice().sort((a, b) => a.sort_index - b.sort_index).map((s) => s.id);
  currentSpeakerSlot = speakerRoundRobin.length - 1;
  lastSegmentEndMs = meeting.segments.length ? meeting.segments[meeting.segments.length - 1].end_ms : null;
}

function scrollTranscriptToBottom() {
  const editorEl = qs('#transcript-editor');
  editorEl.scrollTop = editorEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// Direct text editing (contenteditable reconciliation)
// ---------------------------------------------------------------------------

const reconcileDebounced = debounce(() => reconcileEditorText(), 700);

function initTextEditingHandlers() {
  const editorEl = qs('#transcript-editor');
  editorEl.addEventListener('input', () => {
    markAutosaveState('unsaved');
    reconcileDebounced();
  });
  editorEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      insertLineBreakAtCursor();
    }
  });
}

function insertLineBreakAtCursor() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const br = document.createElement('br');
  range.insertNode(br);
  range.setStartAfter(br);
  range.setEndAfter(br);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function reconcileEditorText() {
  if (!currentMeetingId) return;
  markAutosaveState('saving');
  const editorEl = qs('#transcript-editor');
  const seen = new Set();

  for (const node of qsa('.segment-text', editorEl)) {
    const segmentId = node.dataset.segmentId;
    seen.add(segmentId);
    const newText = node.textContent.replace(/\u00a0/g, ' ');
    const segment = getSegmentById(segmentId);
    if (segment && segment.text !== newText) {
      await storage.updateTranscriptSegment(currentMeetingId, segmentId, { text: newText });
      setSegmentCacheField(segmentId, 'text', newText);
      dirtySinceLastSnapshot = true;
    }
  }

  // A segment's DOM node can disappear entirely in rare contenteditable
  // edge cases (selecting across segment boundaries and deleting). Treat
  // that as the text being cleared rather than silently discarding it.
  for (const segment of editorState.segments) {
    if (!seen.has(segment.id) && segment.text !== '') {
      await storage.updateTranscriptSegment(currentMeetingId, segment.id, { text: '' });
      setSegmentCacheField(segment.id, 'text', '');
      dirtySinceLastSnapshot = true;
    }
  }

  markAutosaveState('saved');
}

async function persistSegmentText(segmentId, text) {
  await storage.updateTranscriptSegment(currentMeetingId, segmentId, { text });
  setSegmentCacheField(segmentId, 'text', text);
  const node = qs(`.segment-text[data-segment-id="${segmentId}"]`);
  if (node) node.textContent = text;
  markAutosaveState('saved');
}

// ---------------------------------------------------------------------------
// Toolbar wiring
// ---------------------------------------------------------------------------

function wireToolbarButtons() {
  qs('#btn-undo').addEventListener('click', () => undo());
  qs('#btn-redo').addEventListener('click', () => redo());
  qs('#btn-highlight').addEventListener('click', () => toggleHighlight());
  qs('#btn-comment').addEventListener('click', () => {
    const ids = getSelectedSegmentIds();
    const segment = ids.length ? getSegmentById(ids[0]) : null;
    if (!segment) { showToast('Select some transcript text to comment on.', 'info'); return; }
    openAddCommentPrompt(segment);
  });
  qs('#btn-bookmark-editor').addEventListener('click', () => addBookmarkFromEditorSelection());
  qs('#btn-find-replace').addEventListener('click', () => toggleFindBar());
  qs('#btn-version-history').addEventListener('click', () => openVersionHistory());
}

function initKeyboardShortcuts() {
  document.addEventListener('keydown', (event) => {
    const transcriptActive = qs('#panel-transcript')?.classList.contains('active');
    if (!transcriptActive) return;

    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      openFindBar();
      return;
    }

    // Let the browser's own contenteditable undo/redo handle Ctrl+Z while
    // focus is actually inside the transcript text; only intercept it for
    // our structural-action stack when focus is elsewhere in the panel.
    const focusInsideEditor = document.activeElement?.closest?.('#transcript-editor');
    if (focusInsideEditor) return;

    if (mod && !event.shiftKey && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undo();
    } else if (mod && (event.key.toLowerCase() === 'y' || (event.shiftKey && event.key.toLowerCase() === 'z'))) {
      event.preventDefault();
      redo();
    }
  });
}

function getSelectedSegmentIds() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return [];
  const range = selection.getRangeAt(0);
  const editorEl = qs('#transcript-editor');
  if (!editorEl.contains(range.commonAncestorContainer)) return [];

  const ids = [];
  qsa('.segment-text', editorEl).forEach((node) => {
    if (range.intersectsNode(node) && !ids.includes(node.dataset.segmentId)) ids.push(node.dataset.segmentId);
  });
  return ids;
}

// ---------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------

async function toggleHighlight() {
  const ids = getSelectedSegmentIds();
  if (!ids.length) { showToast('Select some transcript text to highlight first.', 'info'); return; }

  const newState = ids.some((id) => !getSegmentById(id)?.highlighted);
  const previous = ids.map((id) => ({ id, was: Boolean(getSegmentById(id)?.highlighted) }));

  await runAction({
    description: 'Toggle highlight',
    do: async () => {
      for (const id of ids) {
        await storage.updateTranscriptSegment(currentMeetingId, id, { highlighted: newState ? 1 : 0 });
        setSegmentCacheField(id, 'highlighted', newState);
        updateSegmentHighlightDom(id, newState);
      }
    },
    undo: async () => {
      for (const { id, was } of previous) {
        await storage.updateTranscriptSegment(currentMeetingId, id, { highlighted: was ? 1 : 0 });
        setSegmentCacheField(id, 'highlighted', was);
        updateSegmentHighlightDom(id, was);
      }
    },
  });
}

function updateSegmentHighlightDom(segmentId, highlighted) {
  const node = qs(`.segment-text[data-segment-id="${segmentId}"]`);
  node?.classList.toggle('highlighted', Boolean(highlighted));
}

// ---------------------------------------------------------------------------
// Timestamp editing
// ---------------------------------------------------------------------------

function startTimestampEdit(segment, timestampNode) {
  const input = el('input', { type: 'text', value: formatTimestamp(segment.start_ms), contenteditable: 'false' });
  input.style.cssText = 'width:80px;font-family:var(--font-mono);font-size:11.5px;padding:1px 4px;';
  timestampNode.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const parsedMs = parseTimestampInput(input.value);
    if (parsedMs === null) {
      showToast('Enter a timestamp as hh:mm:ss.', 'error');
      restoreTimestampNode(segment, input);
      return;
    }
    const oldStart = segment.start_ms;
    await runAction({
      description: 'Edit timestamp',
      do: async () => {
        await storage.updateTranscriptSegment(currentMeetingId, segment.id, { start_ms: parsedMs });
        setSegmentCacheField(segment.id, 'start_ms', parsedMs);
      },
      undo: async () => {
        await storage.updateTranscriptSegment(currentMeetingId, segment.id, { start_ms: oldStart });
        setSegmentCacheField(segment.id, 'start_ms', oldStart);
      },
    });
    restoreTimestampNode(segment, input);
  };

  input.addEventListener('blur', commit, { once: true });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
    if (event.key === 'Escape') { input.removeEventListener('blur', commit); restoreTimestampNode(segment, input); }
  });
}

function restoreTimestampNode(segment, input) {
  const replacement = el('span', { class: 'segment-timestamp', contenteditable: 'false' }, formatTimestamp(segment.start_ms));
  replacement.title = 'Click to edit this timestamp';
  replacement.addEventListener('click', (event) => { event.stopPropagation(); startTimestampEdit(segment, replacement); });
  input.replaceWith(replacement);
}

function parseTimestampInput(value) {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, h, m, s] = match;
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000;
}

// ---------------------------------------------------------------------------
// Speaker reassignment
// ---------------------------------------------------------------------------

function openSpeakerMenu(segment) {
  const meeting = store.get('currentMeeting');
  const list = el('div', { class: 'speaker-list' });

  meeting.speakers.forEach((speaker) => {
    const row = el('button', { class: 'btn btn-block', type: 'button', onClick: async () => { await reassignSpeaker(segment, speaker.id); close(); } }, [
      el('span', { class: 'speaker-color-dot' }),
      ` ${speaker.display_name || speaker.label}`,
    ]);
    row.querySelector('.speaker-color-dot').style.background = speaker.color;
    row.style.marginBottom = '6px';
    list.appendChild(row);
  });

  const addNewButton = el('button', { class: 'btn btn-block btn-primary', type: 'button', onClick: async () => {
    const index = meeting.speakers.length;
    const created = await storage.upsertSpeaker(meeting.id, {
      label: `Speaker ${index + 1}`, display_name: null, color: colorForSpeakerIndex(index),
    });
    await reassignSpeaker(segment, created.id);
    close();
  } }, '+ New speaker');

  const body = el('div', {}, [el('h2', {}, 'Reassign speaker'), list, addNewButton]);
  const close = openModal(body);
}

async function reassignSpeaker(segment, newSpeakerId) {
  const oldSpeakerId = segment.speaker_id;
  await runAction({
    description: 'Reassign speaker',
    do: async () => {
      await storage.updateTranscriptSegment(currentMeetingId, segment.id, { speaker_id: newSpeakerId });
      setSegmentCacheField(segment.id, 'speaker_id', newSpeakerId);
    },
    undo: async () => {
      await storage.updateTranscriptSegment(currentMeetingId, segment.id, { speaker_id: oldSpeakerId });
      setSegmentCacheField(segment.id, 'speaker_id', oldSpeakerId);
    },
  });
  const refreshed = await storage.getMeeting(currentMeetingId);
  store.set('currentMeeting', refreshed);
  document.dispatchEvent(new CustomEvent('speakers-updated', { detail: { meetingId: currentMeetingId } }));
}

// ---------------------------------------------------------------------------
// Bookmarks & comments
// ---------------------------------------------------------------------------

async function addBookmarkFromEditorSelection() {
  const ids = getSelectedSegmentIds();
  let segment = ids.length ? getSegmentById(ids[0]) : null;

  if (!segment) {
    const anchorNode = window.getSelection()?.anchorNode;
    const container = anchorNode?.nodeType === Node.TEXT_NODE ? anchorNode.parentElement : anchorNode;
    const segmentTextNode = container?.closest?.('.segment-text');
    segment = segmentTextNode ? getSegmentById(segmentTextNode.dataset.segmentId) : editorState.segments[0];
  }
  if (!segment) { showToast('Click inside the transcript first.', 'info'); return; }

  await storage.addBookmark(currentMeetingId, { timeMs: segment.start_ms, label: '' });
  const refreshed = await storage.getMeeting(currentMeetingId);
  store.set('currentMeeting', refreshed);
  showToast('Bookmark added.', 'success');
}

function openAddCommentPrompt(segment) {
  const textarea = el('textarea', { rows: '3', placeholder: 'Add a comment…' });
  textarea.style.cssText = 'width:100%;padding:8px;border:1px solid var(--color-border);border-radius:6px;font-family:inherit;font-size:13px;';

  const body = el('div', {}, [
    el('h2', {}, 'Add comment'),
    textarea,
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
      el('button', { class: 'btn btn-primary', type: 'button', onClick: async () => {
        const text = textarea.value.trim();
        if (!text) return;
        await storage.addComment(currentMeetingId, { segmentId: segment.id, text });
        const refreshed = await storage.getMeeting(currentMeetingId);
        store.set('currentMeeting', refreshed);
        close();
      } }, 'Add comment'),
    ]),
  ]);
  const close = openModal(body);
  textarea.focus();
}

function renderCommentsPanel(meeting) {
  const panel = qs('#comments-panel');
  panel.innerHTML = '';

  if (!meeting.comments.length) {
    panel.appendChild(el('p', { class: 'settings-help' }, 'No comments yet. Select transcript text and click the comment icon to add one.'));
    return;
  }

  meeting.comments.forEach((comment) => {
    const segment = meeting.segments.find((s) => s.id === comment.segment_id);
    const card = el('div', { class: `comment-card${comment.resolved ? ' resolved' : ''}` }, [
      el('div', { class: 'comment-meta' }, segment ? formatTimestamp(segment.start_ms) : 'General'),
      el('p', {}, comment.text),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn-small', type: 'button', onClick: async () => {
          await storage.resolveComment(currentMeetingId, comment.id, !comment.resolved);
          const refreshed = await storage.getMeeting(currentMeetingId);
          store.set('currentMeeting', refreshed);
        } }, comment.resolved ? 'Reopen' : 'Resolve'),
        el('button', { class: 'btn btn-small btn-danger', type: 'button', onClick: async () => {
          await storage.deleteComment(currentMeetingId, comment.id);
          const refreshed = await storage.getMeeting(currentMeetingId);
          store.set('currentMeeting', refreshed);
        } }, 'Delete'),
      ]),
    ]);
    panel.appendChild(card);
  });
}

// ---------------------------------------------------------------------------
// Find & replace
// ---------------------------------------------------------------------------

function initFindReplace() {
  qs('#find-input').addEventListener('input', () => performFind());
  qs('#find-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') findNext(); });
  qs('#btn-find-next').addEventListener('click', () => findNext());
  qs('#btn-replace-one').addEventListener('click', () => replaceCurrentMatch());
  qs('#btn-replace-all').addEventListener('click', () => replaceAllMatches());
  qs('#btn-close-find').addEventListener('click', () => closeFindBar());
}

function openFindBar() {
  qs('#find-replace-bar').classList.remove('hidden');
  const input = qs('#find-input');
  input.focus();
  input.select();
}

function closeFindBar() {
  qs('#find-replace-bar').classList.add('hidden');
}

function toggleFindBar() {
  qs('#find-replace-bar').classList.contains('hidden') ? openFindBar() : closeFindBar();
}

function performFind() {
  const query = qs('#find-input').value.trim();
  findState.query = query;
  findState.total = query ? countOccurrences(query) : 0;
  findState.currentPosition = 0;
  updateFindMatchCount();
}

function countOccurrences(query) {
  const lower = query.toLowerCase();
  let count = 0;
  for (const segment of editorState.segments) {
    const text = segment.text.toLowerCase();
    let idx = 0;
    for (;;) {
      const found = text.indexOf(lower, idx);
      if (found === -1) break;
      count++;
      idx = found + lower.length;
    }
  }
  return count;
}

function findNext() {
  if (!findState.query) return;
  const found = window.find(findState.query, false, false, true, false, false, false);
  findState.currentPosition = found && findState.total ? (findState.currentPosition % findState.total) + 1 : 0;
  updateFindMatchCount();
}

function updateFindMatchCount() {
  const label = qs('#find-match-count');
  if (!findState.query) { label.textContent = ''; return; }
  label.textContent = findState.total ? `${findState.currentPosition || '–'} of ${findState.total}` : 'No matches';
}

async function replaceCurrentMatch() {
  const replacement = qs('#replace-input').value;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    showToast('Use "Next" to select a match before replacing.', 'info');
    return;
  }

  const range = selection.getRangeAt(0);
  const segmentTextNode = (range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer)
    ?.closest?.('.segment-text');
  if (!segmentTextNode) { showToast('The current selection is not inside the transcript.', 'info'); return; }

  const segment = getSegmentById(segmentTextNode.dataset.segmentId);
  if (!segment) return;

  const preRange = document.createRange();
  preRange.selectNodeContents(segmentTextNode);
  preRange.setEnd(range.startContainer, range.startOffset);
  const startOffset = preRange.toString().length;
  const matchedLength = selection.toString().length;
  const oldText = segment.text;
  const newText = oldText.slice(0, startOffset) + replacement + oldText.slice(startOffset + matchedLength);

  await runAction({
    description: 'Replace text',
    do: async () => persistSegmentText(segment.id, newText),
    undo: async () => persistSegmentText(segment.id, oldText),
  });
  performFind();
  findNext();
}

async function replaceAllMatches() {
  const query = qs('#find-input').value.trim();
  const replacement = qs('#replace-input').value;
  if (!query) return;

  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped, 'gi');
  const changes = [];
  for (const segment of editorState.segments) {
    const newText = segment.text.replace(pattern, replacement);
    if (newText !== segment.text) changes.push({ id: segment.id, oldText: segment.text, newText });
  }
  if (!changes.length) { showToast('No matches to replace.', 'info'); return; }

  await runAction({
    description: 'Replace all',
    do: async () => { for (const c of changes) await persistSegmentText(c.id, c.newText); },
    undo: async () => { for (const c of changes) await persistSegmentText(c.id, c.oldText); },
  });
  showToast(`Replaced text in ${changes.length} segment(s).`, 'success');
  performFind();
}

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

async function openVersionHistory() {
  const versions = await storage.listTranscriptVersions(currentMeetingId);

  const listNodes = versions.length
    ? versions.map((version) => el('div', { class: 'backup-row' }, [
      el('span', {}, `${new Date(version.created_at).toLocaleString()} — ${version.segment_count} segments${version.note ? ` (${version.note})` : ''}`),
      el('button', { class: 'btn btn-small', type: 'button', onClick: async () => {
        await storage.restoreTranscriptVersion(currentMeetingId, version.id);
        const refreshed = await storage.getMeeting(currentMeetingId);
        store.set('currentMeeting', refreshed);
        showToast('Transcript restored from version history.', 'success');
        close();
      } }, 'Restore'),
    ]))
    : [el('p', { class: 'settings-help' }, 'No saved versions yet — MeetingScribe saves one automatically as you edit.')];

  const body = el('div', {}, [
    el('h2', {}, 'Version history'),
    el('p', { class: 'settings-help' }, 'Restoring a version replaces the current transcript. A safety snapshot of the current state is always taken first.'),
    el('div', {}, listNodes),
  ]);
  const close = openModal(body);
}

// ---------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------

function markAutosaveState(state) {
  const indicator = qs('#autosave-indicator');
  if (!indicator) return;
  indicator.classList.remove('saving', 'unsaved');
  if (state === 'saving') { indicator.textContent = 'Saving…'; indicator.classList.add('saving'); }
  else if (state === 'unsaved') { indicator.textContent = 'Unsaved changes'; indicator.classList.add('unsaved'); }
  else { indicator.textContent = 'Saved'; }
}

function restartAutosaveTimer(settings) {
  if (autosaveIntervalHandle) clearInterval(autosaveIntervalHandle);
  const seconds = Math.max(5, settings?.autosaveIntervalSeconds || 30);
  autosaveIntervalHandle = setInterval(async () => {
    if (dirtySinceLastSnapshot && currentMeetingId) {
      await storage.saveTranscriptSnapshot(currentMeetingId, 'Autosave');
      dirtySinceLastSnapshot = false;
    }
  }, seconds * 1000);
}

// Re-derive the live speaker rotation whenever a fresh meeting is loaded so
// a resumed recording continues the round-robin sensibly rather than
// restarting from Speaker 1.
store.subscribe('currentMeeting', (meeting) => {
  if (meeting) resetSpeakerRotation(meeting);
});
