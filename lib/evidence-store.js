'use strict';

// Task-scoped evidence is deliberately separate from browser telemetry. A
// source appears in the user-facing answer only after the host intentionally
// fetched, downloaded, or rendered that exact URL as evidence.

function canonicalHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return /^https?:$/.test(url.protocol) ? url.toString() : '';
  } catch { return ''; }
}

class EvidenceStore {
  constructor() {
    this.entries = [];
    this.sourcesByUrl = new Map();
    this.downloads = new Map();
  }

  record(kind, url, title = '', metadata = {}) {
    const canonical = canonicalHttpUrl(url);
    if (!canonical) return undefined;
    const entry = { id: `evidence-${this.entries.length + 1}`, kind: String(kind || 'unknown'), url: canonical, title: String(title || ''), metadata: { ...metadata }, at: new Date().toISOString() };
    this.entries.push(entry);
    let source = this.sourcesByUrl.get(canonical);
    if (!source) {
      source = { title: entry.title || new URL(canonical).hostname, url: canonical, favicon: '' };
      this.sourcesByUrl.set(canonical, source);
    } else if (!source.title && entry.title) source.title = entry.title;
    return { entry, source, isNewSource: this.entries.filter(item => item.url === canonical).length === 1 };
  }

  setFavicon(url, favicon) {
    const source = this.sourcesByUrl.get(canonicalHttpUrl(url));
    if (source) source.favicon = String(favicon || '');
    return source;
  }

  sources() { return [...this.sourcesByUrl.values()].map(item => ({ ...item })); }

  recordDownload(item) {
    if (!item?.id) return undefined;
    const value = { ...item, url: canonicalHttpUrl(item.url) || String(item.url || '') };
    this.downloads.set(String(item.id), value);
    return value;
  }

  getDownload(id) { return this.downloads.get(String(id || '')); }
}

module.exports = { EvidenceStore, canonicalHttpUrl };
