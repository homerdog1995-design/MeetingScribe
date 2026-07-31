'use strict';

export const SPEAKER_PALETTE = [
  'var(--speaker-color-1)', 'var(--speaker-color-2)', 'var(--speaker-color-3)',
  'var(--speaker-color-4)', 'var(--speaker-color-5)', 'var(--speaker-color-6)',
];

const SPEAKER_PALETTE_HEX = ['#3a5ce0', '#b8760a', '#1e9e6b', '#c23b8f', '#2a9bb0', '#7a5cf0'];

export function formatTimestamp(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '--:--:--';
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return '< 1m';
}

export function formatRelativeDate(timestampMs) {
  const diffMs = Date.now() - timestampMs;
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.round(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestampMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function debounce(fn, waitMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}

export function throttle(fn, waitMs) {
  let last = 0;
  let pendingArgs = null;
  let timer = null;
  return (...args) => {
    const now = performance.now();
    const remaining = waitMs - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else {
      pendingArgs = args;
      if (!timer) {
        timer = setTimeout(() => {
          last = performance.now();
          timer = null;
          fn(...pendingArgs);
        }, remaining);
      }
    }
  };
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function colorForSpeakerIndex(index) {
  return SPEAKER_PALETTE_HEX[index % SPEAKER_PALETTE_HEX.length];
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function qs(selector, root = document) {
  return root.querySelector(selector);
}

export function qsa(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function uuid() {
  return crypto.randomUUID();
}

/**
 * Opens a modal dialog hosting `cardContent` inside #modal-root. Returns a
 * `close()` function. Closes on Escape or a click on the dimmed overlay
 * (but not on clicks inside the card itself).
 */
export function openModal(cardContent, { onClose = null } = {}) {
  const root = qs('#modal-root');
  const overlay = el('div', { class: 'modal-overlay' });
  const card = el('div', { class: 'modal-card' }, [cardContent]);
  overlay.appendChild(card);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
    onClose?.();
  }
  function onKeydown(event) {
    if (event.key === 'Escape') close();
  }

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKeydown);

  root.appendChild(overlay);
  return close;
}

export function showToast(message, kind = 'info') {
  const container = qs('#toast-container');
  if (!container) return;
  const toast = el('div', { class: `toast ${kind === 'info' ? '' : kind}`.trim() }, [message]);
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 200ms ease';
    setTimeout(() => toast.remove(), 220);
  }, 3400);
}
