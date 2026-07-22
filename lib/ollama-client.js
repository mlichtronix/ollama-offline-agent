'use strict';

function normalizeEndpoint(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isLocalEndpoint(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'localhost' || host === '::1' || host === '127.0.0.1';
  } catch {
    return false;
  }
}

class OllamaClient {
  constructor({ getEndpoint, getAuthorization }) {
    this.getEndpoint = getEndpoint;
    this.getAuthorization = getAuthorization;
  }

  endpoint() {
    return normalizeEndpoint(this.getEndpoint());
  }

  async fetch(route, init = {}) {
    const endpoint = this.endpoint();
    const authorization = await this.getAuthorization?.(endpoint);
    const headers = { ...(init.headers || {}), ...(authorization ? { Authorization: authorization } : {}) };
    return fetch(endpoint + route, { ...init, headers });
  }

  async version() {
    const response = await this.fetch('/api/version');
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  }

  async listModels() {
    const response = await this.fetch('/api/tags');
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const data = await response.json();
    return (data.models || []).map(model => ({ name: model.name, size: Math.round((model.size || 0) / 1024 / 1024 / 1024 * 10) / 10 }));
  }

  async modelContextLimit(model) {
    try {
      const response = await this.fetch('/api/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
      if (!response.ok) return 0;
      const data = await response.json();
      const values = Object.entries(data.model_info || {}).filter(([key]) => /context_length$/i.test(key)).map(([, value]) => Number(value)).filter(Number.isFinite);
      return values.length ? Math.max(...values) : 0;
    } catch {
      return 0;
    }
  }

  async chat({ model, messages, tools, temperature, contextWindow, signal, onChunk, onThinkingUnsupported }) {
    const request = body => this.fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify(body) });
    const base = { model, messages, tools, stream: true, options: { temperature, ...(contextWindow > 0 ? { num_ctx: contextWindow } : {}) } };
    let response = await request({ ...base, think: true });
    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 400 && /does not support thinking/i.test(errorText)) {
        onThinkingUnsupported?.(model);
        response = await request(base);
      } else {
        throw new Error(`Ollama returned ${response.status}: ${errorText}`);
      }
    }
    if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
    if (!response.body) throw new Error('Ollama returned an empty stream.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const message = { role: 'assistant', content: '', thinking: '', tool_calls: [] };
    let buffer = '';
    const accept = chunk => {
      if (chunk.error) throw new Error(chunk.error);
      const partial = chunk.message || {};
      if (partial.content) message.content += partial.content;
      if (partial.thinking) message.thinking += partial.thinking;
      if (Array.isArray(partial.tool_calls) && partial.tool_calls.length) message.tool_calls.push(...partial.tool_calls);
      onChunk?.(partial);
    };
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) if (line.trim()) accept(JSON.parse(line));
      if (done) break;
    }
    if (buffer.trim()) accept(JSON.parse(buffer));
    return { message };
  }

  async pullModel(name, onStatus, signal) {
    const response = await this.fetch('/api/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ name, stream: true }) });
    if (!response.ok) throw new Error(await response.text());
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (reader) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const item = JSON.parse(line);
        if (item.error) throw new Error(item.error);
        if (item.status) onStatus?.(item.status);
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const item = JSON.parse(buffer);
      if (item.error) throw new Error(item.error);
      if (item.status) onStatus?.(item.status);
    }
  }
}

module.exports = { OllamaClient, normalizeEndpoint, isLocalEndpoint };
