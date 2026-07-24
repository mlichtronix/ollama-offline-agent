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

  async version(signal) {
    const response = await this.fetch('/api/version', { signal });
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  }

  async listModels(signal) {
    const response = await this.fetch('/api/tags', { signal });
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

  async modelProfile(model, signal) {
    const response = await this.fetch('/api/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ model }) });
    if (!response.ok) throw new Error(`Ollama returned ${response.status} while reading model profile`);
    const data = await response.json();
    const contexts = Object.entries(data.model_info || {}).filter(([key]) => /context_length$/i.test(key)).map(([, value]) => Number(value)).filter(Number.isFinite);
    return {
      capabilities: Array.isArray(data.capabilities) ? data.capabilities.map(item => String(item)) : [],
      contextLength: contexts.length ? Math.max(...contexts) : 0,
      parameterSize: String(data.details?.parameter_size || ''),
      quantization: String(data.details?.quantization_level || ''),
      family: String(data.details?.family || '')
    };
  }

  async benchmark(model, signal) {
    const started = Date.now();
    const response = await this.fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ model, prompt: 'Reply with exactly: OK', stream: false, options: { num_predict: 4, temperature: 0 } }) });
    if (!response.ok) throw new Error(`Ollama returned ${response.status} while benchmarking`);
    const data = await response.json();
    const evalCount = Number(data.eval_count || 0); const evalDuration = Number(data.eval_duration || 0);
    return { tokensPerSecond: evalCount && evalDuration ? Math.round(evalCount / (evalDuration / 1e9) * 10) / 10 : 0, totalMilliseconds: Number(data.total_duration || 0) ? Math.round(Number(data.total_duration) / 1e6) : Date.now() - started, measuredAt: new Date().toISOString() };
  }

  async chat({ model, messages, tools, temperature, contextWindow, format, signal, onChunk, onThinkingUnsupported, onThinkingDisabledForTools }) {
    const request = body => this.fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify(body) });
    const toolCalling = Array.isArray(tools) && tools.length > 0;
    // Tool turns should be short and decisive. The cap prevents a malformed
    // template or weak local model from streaming the same prose indefinitely.
    const base = { model, messages, tools, stream: true, options: { temperature, num_predict: toolCalling ? 1600 : 4096, ...(contextWindow > 0 ? { num_ctx: contextWindow } : {}) } };
    const run = async requestBase => {
      // Several local Qwen templates serialize the tool schema into their
      // reasoning stream when think:true is combined with tools. That leaves
      // no actual tool call. Tool reliability takes precedence for an agent.
      const requestHasTools = Array.isArray(requestBase.tools) && requestBase.tools.length > 0;
      if (requestHasTools) onThinkingDisabledForTools?.(model);
      let response = await request({ ...requestBase, think: requestHasTools ? false : true });
      if (response.ok) return { response, errorText: '' };
      let errorText = await response.text();
      if (response.status === 400 && /does not support thinking/i.test(errorText)) {
        onThinkingUnsupported?.(model);
        response = await request(requestBase);
        if (response.ok) return { response, errorText: '' };
        errorText = await response.text();
      }
      return { response, errorText };
    };
    let requestBase = format ? { ...base, format } : base;
    let attempt = await run(requestBase);
    if (!attempt.response.ok && format && /structured output|json schema|format/i.test(attempt.errorText)) {
      requestBase = base;
      attempt = await run(requestBase);
    }
    const response = attempt.response;
    if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${attempt.errorText}`);
    if (!response.body) throw new Error('Ollama returned an empty stream.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const message = { role: 'assistant', content: '', thinking: '', tool_calls: [] };
    let buffer = '';
    const repeatedContent = () => {
      const normalized = message.content.replace(/\s+/g, ' ').trim();
      if (normalized.length > 18000) return 'Model generation exceeded the 18,000-character safety limit before returning a tool call or final answer.';
      if (normalized.length < 1400) return '';
      const tail = normalized.slice(-700);
      return normalized.slice(0, -700).includes(tail) ? 'Model generation loop detected: it repeated a long response segment without completing the turn.' : '';
    };
    const accept = chunk => {
      if (chunk.error) throw new Error(chunk.error);
      const partial = chunk.message || {};
      if (partial.content) message.content += partial.content;
      if (partial.thinking) message.thinking += partial.thinking;
      if (Array.isArray(partial.tool_calls) && partial.tool_calls.length) message.tool_calls.push(...partial.tool_calls);
      const loop = repeatedContent();
      if (loop) { void reader.cancel(loop); throw new Error(loop); }
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
