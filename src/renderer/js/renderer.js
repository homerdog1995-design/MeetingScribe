'use strict';

import { store } from './state.js';
import {
  qs, qsa, el, formatDuration, debounce, showToast, openModal,
} from './utils.js';

import { initRecording } from './recording.js';
import { initEditor } from './editor.js';
import { initSpeakers, renderSpeakers } from './speakers.js';
import { initSummary } from './summary.js';
import { initLibrary } from './library.js';
import { initSearch } from './search.js';
import { initTimeline } from './timeline.js';
import { initPlayback } from './playback.js';
import { initExport } from './export.js';
import { initSettings } from './settings.js';

async function bootstrap() {
  // Settings must be loaded before anything else reads store.get('settings')
  // for things like theme, autosave interval, or speaker-change threshold.
  await initSettings();

  initRecording();
  initEditor();
  initSpeakers();
  initSummary();
  initLibrary();
  initSearch();
  initTimeline();
  initPlayback();
  initExport();

  wireNavigation();
  wireMeetingTabs();
  wireMeetingHeaderActions();
  wireBackToLibrary();

  store.subscribe('currentMeeting', (meeting) => {
    if (meeting) renderMeetingHeader(meeting);
  });

  store.set('currentView', 'library');
}

// ---------------------------------------------------------------------------
// View routing (sidebar Library/Settings + the meeting workspace)
// ---------------------------------------------------------------------------

function wireNavigation() {
  qsa('.nav-item').forEach((item) => {
    item.addEventListener('click', () => store.set('currentView', item.dataset.view));
  });

  qs('#engine-status-badge').addEventListener('click', () => store.set('currentView', 'settings'));

  store.subscribe('currentView', (view) => {
    qsa('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
    qsa('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  });
}

function wireBackToLibrary() {
  qs('#btn-back-to-library').addEventListener('click', () => {
    if (store.get('recording.status') !== 'idle') {
      showToast('Stop the recording before leaving this meeting.', 'info');
      return;
    }
    store.set('currentView', 'library');
  });
}

// ---------------------------------------------------------------------------
// Meeting tabs (Transcript / Summary / Speakers / Playback / Export)
// ---------------------------------------------------------------------------

let lastOpenedMeetingId = null;

function wireMeetingTabs() {
  qsa('.meeting-tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });
}

function activateTab(tabName) {
  qsa('.meeting-tabs .tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabName));
  qsa('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === `panel-${tabName}`));

  const meeting = store.get('currentMeeting');
  if (meeting && tabName === 'speakers') renderSpeakers(meeting.id);
}

// ---------------------------------------------------------------------------
// Meeting header: title, metadata, tags, workspace-level actions
// ---------------------------------------------------------------------------

const persistTitle = debounce(async (meetingId, value) => {
  const updated = await window.api.storage.updateMeeting(meetingId, { title: value.trim() || 'Untitled meeting' });
  store.patch('currentMeeting', { title: updated.title, updated_at: updated.updated_at });
}, 500);

function wireMeetingHeaderActions() {
  qs('#meeting-title-input').addEventListener('input', (event) => {
    const meeting = store.get('currentMeeting');
    if (meeting) persistTitle(meeting.id, event.target.value);
  });

  qs('#btn-duplicate-meeting').addEventListener('click', async () => {
    const meeting = store.get('currentMeeting');
    if (!meeting) return;
    const duplicate = await window.api.storage.duplicateMeeting(meeting.id);
    showToast('Meeting duplicated.', 'success');
    store.set('currentMeeting', duplicate);
  });

  qs('#btn-archive-meeting').addEventListener('click', async () => {
    const meeting = store.get('currentMeeting');
    if (!meeting) return;
    const updated = await window.api.storage.archiveMeeting(meeting.id, !meeting.archived);
    store.set('currentMeeting', updated);
    showToast(updated.archived ? 'Meeting archived.' : 'Meeting unarchived.', 'success');
  });

  qs('#btn-delete-meeting').addEventListener('click', () => {
    const meeting = store.get('currentMeeting');
    if (!meeting) return;
    if (store.get('recording.status') !== 'idle') {
      showToast('Stop the recording before deleting this meeting.', 'info');
      return;
    }
    confirmDeleteCurrentMeeting(meeting);
  });
}

function confirmDeleteCurrentMeeting(meeting) {
  const body = el('div', {}, [
    el('h2', {}, 'Delete this meeting?'),
    el('p', {}, `"${meeting.title}" and its recording will be permanently deleted. This cannot be undone.`),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
      el('button', {
        class: 'btn btn-danger', type: 'button',
        onClick: async () => {
          await window.api.storage.deleteMeeting(meeting.id);
          close();
          store.set('currentView', 'library');
          showToast('Meeting deleted.', 'success');
        },
      }, 'Delete'),
    ]),
  ]);
  const close = openModal(body);
}

function renderMeetingHeader(meeting) {
  const titleInput = qs('#meeting-title-input');
  if (document.activeElement !== titleInput) titleInput.value = meeting.title;

  const meta = qs('#meeting-meta');
  meta.innerHTML = '';
  meta.appendChild(el('span', {}, `Created ${new Date(meeting.created_at).toLocaleString()}`));
  meta.appendChild(el('span', {}, formatDuration(meeting.duration_ms)));
  meta.appendChild(el('span', {}, `${meeting.speakers.length} speaker${meeting.speakers.length === 1 ? '' : 's'}`));
  meta.appendChild(buildTagEditor(meeting));

  if (meeting.id !== lastOpenedMeetingId) {
    lastOpenedMeetingId = meeting.id;
    activateTab('transcript');
  }
}

function buildTagEditor(meeting) {
  const chipsContainer = el('div', { class: 'tag-editor-chips' });

  meeting.tags.forEach((tag) => {
    const removeButton = el('button', { type: 'button', class: 'tag-chip-remove', title: `Remove tag "${tag.name}"` }, '×');
    removeButton.addEventListener('click', async () => {
      const remaining = meeting.tags.map((t) => t.name).filter((name) => name !== tag.name);
      await window.api.storage.setTags(meeting.id, remaining);
      const refreshed = await window.api.storage.getMeeting(meeting.id);
      store.set('currentMeeting', refreshed);
    });
    chipsContainer.appendChild(el('span', { class: 'tag-chip removable' }, [tag.name, removeButton]));
  });

  const input = el('input', { type: 'text', class: 'tag-editor-input', placeholder: 'Add tag…' });
  input.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    const value = input.value.trim();
    if (!value) return;
    const nextTags = [...new Set([...meeting.tags.map((t) => t.name), value])];
    await window.api.storage.setTags(meeting.id, nextTags);
    const refreshed = await window.api.storage.getMeeting(meeting.id);
    store.set('currentMeeting', refreshed);
  });

  const wrapper = el('div', { class: 'tag-editor' });
  wrapper.append(chipsContainer, input);
  return wrapper;
}

bootstrap().catch((error) => {
  console.error('Failed to start MeetingScribe:', error);
  document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif;color:#b3261e;">
    <h1>MeetingScribe failed to start</h1>
    <p>${escapeForDisplay(error.message)}</p>
  </div>`;
});

function escapeForDisplay(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
