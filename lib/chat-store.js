'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

class ChatStore {
  constructor({ getWorkspace, createId, onError }) {
    this.getWorkspace = getWorkspace;
    this.createId = createId;
    this.onError = onError || (() => undefined);
    this.history = [];
    this.conversation = [];
    this.stateFile = undefined;
    this.ready = Promise.resolve();
    this.write = Promise.resolve();
  }

  fileForWorkspace(workspace) {
    return path.join(workspace, '.ollama-agent', 'chat-history.json');
  }

  async ensureWorkspace() {
    const workspace = this.getWorkspace();
    if (!workspace) throw new Error('Open a folder workspace before using the agent.');
    const nextFile = this.fileForWorkspace(workspace);
    if (this.stateFile === nextFile) return this.ready;
    this.stateFile = nextFile;
    this.history.length = 0;
    this.conversation.length = 0;
    this.ready = this.load();
    return this.ready;
  }

  async load() {
    try {
      const state = JSON.parse(await fsp.readFile(this.stateFile, 'utf8'));
      let migrated = false;
      const hideResourceNote = value => String(value || '').replace(/\n\nAttached local resources \(inspect them when relevant\):\n(?:- .*\n?)+/gi, '').trim();
      if (Array.isArray(state.chatHistory)) {
        this.history.push(...state.chatHistory.slice(-200).map(event => {
          const text = event.kind === 'user' ? hideResourceNote(event.text) : event.text;
          if (text !== event.text) migrated = true;
          return { ...event, text, id: event.id || this.createId(), createdAt: event.createdAt || new Date().toISOString() };
        }));
      }
      if (Array.isArray(state.conversation)) {
        this.conversation.push(...state.conversation.slice(-40).map(item => {
          const content = item.role === 'user' ? hideResourceNote(item.content) : item.content;
          if (content !== item.content) migrated = true;
          return { ...item, content, id: item.id || this.createId() };
        }));
      }
      if (migrated) await this.save();
    } catch (error) {
      if (error.code !== 'ENOENT') this.onError(`Could not load chat state: ${error.message}`);
    }
  }

  save() {
    if (!this.stateFile) return Promise.resolve();
    const target = this.stateFile;
    const state = { chatHistory: this.history.slice(-200), conversation: this.conversation.slice(-40) };
    this.write = this.write.catch(() => undefined)
      .then(() => fsp.mkdir(path.dirname(target), { recursive: true }))
      .then(() => fsp.writeFile(target, JSON.stringify(state), 'utf8'))
      .catch(error => this.onError(`Could not save chat state: ${error.message}`));
    return this.write;
  }

  append(kind, text, { id = this.createId(), attachments = [], sources = [], replyTo, createdAt = new Date().toISOString(), internal = false } = {}) {
    const event = { id, kind, text: String(text), createdAt, replyTo, internal: Boolean(internal), attachments: attachments.map(item => ({ name: item.name, mime: item.mime, path: item.path })), sources: sources.map(item => ({ title: String(item.title || ''), url: String(item.url || ''), favicon: String(item.favicon || '') })).filter(item => item.url) };
    this.history.push(event);
    if (this.history.length > 200) this.history.shift();
    this.save();
    return event;
  }

  rememberUser(contextText, visibleText = contextText, id, attachments = [], replyTo) {
    const messageId = id || this.createId();
    this.conversation.push({ id: messageId, role: 'user', content: contextText });
    if (this.conversation.length > 40) this.conversation.shift();
    return this.append('user', visibleText, { id: messageId, attachments, replyTo });
  }

  rememberAssistant(text, id = this.createId(), createdAt, sources = []) {
    this.conversation.push({ id, role: 'assistant', content: text });
    if (this.conversation.length > 40) this.conversation.shift();
    return this.append('assistant', text, { id, createdAt, sources });
  }

  remove(id) {
    const index = this.history.findIndex(event => event.id === id);
    if (index < 0) return undefined;
    const [removed] = this.history.splice(index, 1);
    const conversationIndex = this.conversation.findIndex(item => item.id === id);
    if (conversationIndex >= 0) this.conversation.splice(conversationIndex, 1);
    else {
      const fallback = this.conversation.findIndex(item => item.role === (removed.kind === 'assistant' ? 'assistant' : 'user') && item.content === removed.text);
      if (fallback >= 0) this.conversation.splice(fallback, 1);
    }
    this.save();
    return removed;
  }

  removeFrom(id) {
    const index = this.history.findIndex(event => event.id === id);
    if (index < 0) return [];
    const removed = this.history.splice(index);
    const removedIds = new Set(removed.map(event => event.id));
    this.conversation.splice(0, this.conversation.length, ...this.conversation.filter(item => !removedIds.has(item.id)));
    this.save();
    return removed;
  }

  clear() {
    this.history.length = 0;
    this.conversation.length = 0;
    return this.save();
  }

  latestAssistant() {
    for (let index = this.conversation.length - 1; index >= 0; index--) {
      if (this.conversation[index].role === 'assistant') return this.conversation[index];
    }
    return undefined;
  }

  latestUser() {
    for (let index = this.conversation.length - 1; index >= 0; index--) {
      if (this.conversation[index].role === 'user') return this.conversation[index];
    }
    return undefined;
  }
}

module.exports = { ChatStore };
