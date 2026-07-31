'use strict';

import { store } from './state.js';
import { storage } from './storage.js';
import { bindConfigurableHotkey } from './hotkeys.js';
import {
  qs, el, formatRelativeDate, formatDuration, showToast, openModal,
} from './utils.js';

const PAGE_SIZE = 20;

export const libraryQuery = { search: '', archived: false, sortBy: 'updated_at', sortDir: 'DESC' };
let currentPage = 0;

export function initLibrary() {
  qs('#filter-archived').addEventListener('change', (event) => {
    const value = event.target.value;
    libraryQuery.archived = value === 'active' ? false : value === 'archived' ? true : null;
    currentPage = 0;
    refreshLibrary();
  });
  qs('#sort-by').addEventListener('change', (event) => {
    libraryQuery.sortBy = event.target.value;
    refreshLibrary();
  });
  qs('#btn-sort-dir').addEventListener('click', (event) => {
    libraryQuery.sortDir = libraryQuery.sortDir === 'DESC' ? 'ASC' : 'DESC';
    event.target.textContent = libraryQuery.sortDir === 'DESC' ? '↓' : '↑';
    refreshLibrary();
  });

  qs('#btn-new-meeting').addEventListener('click', () => createNewMeeting());
  qs('#btn-empty-new-meeting').addEventListener('click', () => createNewMeeting());
  bindConfigurableHotkey(
    (cb) => { cb(store.get('settings')); store.subscribe('settings', cb); },
    (s) => s?.hotkeys?.newMeeting,
    () => createNewMeeting(),
  );

  store.subscribe('currentView', (view) => {
    if (view === 'library') { refreshLibrary(); refreshTagSidebar(); }
  });

  refreshLibrary();
  refreshTagSidebar();
}

async function createNewMeeting() {
  const settings = store.get('settings');
  const meeting = await storage.createMeeting({ quality: settings?.recordingQuality || 'standard' });
  store.set('currentMeeting', meeting);
  store.set('currentView', 'meeting');
}

export async function openMeetingById(id) {
  const meeting = await storage.getMeeting(id);
  if (!meeting) { showToast('That meeting could not be found — it may have been deleted.', 'error'); return; }
  store.set('currentMeeting', meeting);
  store.set('currentView', 'meeting');
}

export async function refreshLibrary() {
  const { items, total } = await storage.listMeetings({
    search: libraryQuery.search,
    archived: libraryQuery.archived,
    sortBy: libraryQuery.sortBy,
    sortDir: libraryQuery.sortDir,
    limit: PAGE_SIZE,
    offset: currentPage * PAGE_SIZE,
  });

  const listEl = qs('#meeting-list');
  const emptyEl = qs('#library-empty-state');
  listEl.innerHTML = '';

  if (!items.length) {
    emptyEl.classList.remove('hidden');
  } else {
    emptyEl.classList.add('hidden');
    items.forEach((meeting) => listEl.appendChild(buildMeetingCard(meeting)));
  }

  renderPagination(total);
}

function buildMeetingCard(meeting) {
  const card = el('div', { class: 'meeting-card', role: 'listitem', tabindex: '0' });
  card.addEventListener('click', () => openMeetingById(meeting.id));
  card.addEventListener('keydown', (event) => { if (event.key === 'Enter') openMeetingById(meeting.id); });

  card.appendChild(el('div', { class: 'meeting-card-title' }, meeting.title));

  const meta = el('div', { class: 'meeting-card-meta' }, [
    el('span', {}, formatRelativeDate(meeting.updated_at)),
    el('span', {}, formatDuration(meeting.duration_ms)),
    el('span', {}, meeting.status === 'recording' ? 'Recording in progress' : meeting.recording_path ? 'Recorded' : 'Not yet recorded'),
  ]);
  card.appendChild(meta);

  if (meeting.preview) {
    card.appendChild(el('div', { class: 'meeting-card-preview' }, meeting.preview));
  }

  const sideColumn = el('div', { class: 'meeting-card-tags' });

  const actionsRow = el('div', { class: 'meeting-card-actions' });
  const btnDuplicate = el('button', { class: 'btn btn-icon btn-small', type: 'button', title: 'Duplicate' }, '⧉');
  btnDuplicate.addEventListener('click', async (event) => {
    event.stopPropagation();
    await storage.duplicateMeeting(meeting.id);
    showToast('Meeting duplicated.', 'success');
    refreshLibrary();
  });
  const btnArchive = el('button', { class: 'btn btn-icon btn-small', type: 'button', title: meeting.archived ? 'Unarchive' : 'Archive' }, meeting.archived ? '⤴' : '🗄');
  btnArchive.addEventListener('click', async (event) => {
    event.stopPropagation();
    await storage.archiveMeeting(meeting.id, !meeting.archived);
    refreshLibrary();
  });
  const btnDelete = el('button', { class: 'btn btn-icon btn-small btn-danger', type: 'button', title: 'Delete' }, '🗑');
  btnDelete.addEventListener('click', (event) => {
    event.stopPropagation();
    confirmDeleteMeeting(meeting);
  });
  actionsRow.append(btnDuplicate, btnArchive, btnDelete);
  sideColumn.appendChild(actionsRow);

  if (meeting.archived) sideColumn.appendChild(el('span', { class: 'tag-chip archived-chip' }, 'Archived'));
  meeting.tags.forEach((tagName) => sideColumn.appendChild(el('span', { class: 'tag-chip' }, tagName)));
  card.appendChild(sideColumn);

  return card;
}

function confirmDeleteMeeting(meeting) {
  const body = el('div', {}, [
    el('h2', {}, 'Delete this meeting?'),
    el('p', {}, `"${meeting.title}" and its recording will be permanently deleted. This cannot be undone.`),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
      el('button', {
        class: 'btn btn-danger', type: 'button',
        onClick: async () => {
          await storage.deleteMeeting(meeting.id);
          showToast('Meeting deleted.', 'success');
          close();
          refreshLibrary();
        },
      }, 'Delete'),
    ]),
  ]);
  const close = openModal(body);
}

function renderPagination(total) {
  const container = qs('#pagination-controls');
  container.innerHTML = '';
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pageCount <= 1) return;

  const prev = el('button', { class: 'btn btn-small', type: 'button' }, '← Previous');
  prev.disabled = currentPage === 0;
  prev.addEventListener('click', () => { currentPage = Math.max(0, currentPage - 1); refreshLibrary(); });

  const next = el('button', { class: 'btn btn-small', type: 'button' }, 'Next →');
  next.disabled = currentPage >= pageCount - 1;
  next.addEventListener('click', () => { currentPage = Math.min(pageCount - 1, currentPage + 1); refreshLibrary(); });

  container.append(prev, el('span', {}, ` Page ${currentPage + 1} of ${pageCount} `), next);
}

async function refreshTagSidebar() {
  const tags = await storage.listAllTags();
  const container = qs('#sidebar-tag-list');
  container.innerHTML = '';
  tags.forEach((tag) => {
    const item = el('div', { class: 'sidebar-tag-item' }, [
      el('span', {}, tag.name),
      el('span', { class: 'count' }, String(tag.usage_count)),
    ]);
    item.addEventListener('click', () => {
      libraryQuery.search = tag.name;
      qs('#global-search-input').value = tag.name;
      currentPage = 0;
      store.set('currentView', 'library');
      refreshLibrary();
    });
    container.appendChild(item);
  });
}
