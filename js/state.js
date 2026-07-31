'use strict';

/**
 * A deliberately small state container. MeetingScribe does not need a
 * reactive framework's dependency tracking — a handful of named topics with
 * plain subscribe/publish covers every cross-module update in this app
 * (current meeting changed, recording status changed, settings changed).
 */
class Store {
  constructor() {
    this._state = {
      currentView: 'library',
      currentMeeting: null,
      settings: null,
      engineDetection: null,
      recording: {
        status: 'idle', // idle | recording | paused
        mode: 'microphone', // microphone | system | mixed
        startedAt: null,
        elapsedMs: 0,
        sessionId: null,
      },
    };
    this._listeners = new Map(); // topic -> Set<fn>
  }

  get(path) {
    return path.split('.').reduce((obj, key) => (obj == null ? undefined : obj[key]), this._state);
  }

  set(path, value) {
    const keys = path.split('.');
    let obj = this._state;
    for (let i = 0; i < keys.length - 1; i++) {
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
    this._emit(path, value);
  }

  patch(path, partial) {
    const current = this.get(path) || {};
    this.set(path, { ...current, ...partial });
  }

  subscribe(topic, callback) {
    if (!this._listeners.has(topic)) this._listeners.set(topic, new Set());
    this._listeners.get(topic).add(callback);
    return () => this._listeners.get(topic)?.delete(callback);
  }

  _emit(topic, value) {
    this._listeners.get(topic)?.forEach((cb) => cb(value));
    // Also notify wildcard subscribers listening to a parent path, e.g. a
    // subscriber to 'recording' should hear about changes to 'recording.status'.
    const parts = topic.split('.');
    while (parts.length > 1) {
      parts.pop();
      const parentTopic = parts.join('.');
      this._listeners.get(parentTopic)?.forEach((cb) => cb(this.get(parentTopic)));
    }
  }
}

export const store = new Store();
