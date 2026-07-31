'use strict';

import { store } from './state.js';
import { qs, debounce } from './utils.js';
import { libraryQuery, refreshLibrary } from './library.js';

/**
 * Owns the sidebar's #global-search-input and the "search" global shortcut.
 * List rendering and the rest of the query state (filters/sort/pagination)
 * belong to library.js — this module only ever mutates libraryQuery.search
 * and asks library.js to re-render.
 */
export function initSearch() {
  const input = qs('#global-search-input');

  const runSearch = debounce(() => {
    libraryQuery.search = input.value.trim();
    store.set('currentView', 'library');
    refreshLibrary();
  }, 300);

  input.addEventListener('input', runSearch);

  window.api.shortcuts.onSearch(() => {
    store.set('currentView', 'library');
    input.focus();
    input.select();
  });
}
