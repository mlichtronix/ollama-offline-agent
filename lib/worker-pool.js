'use strict';

const { OllamaClient, normalizeEndpoint } = require('./ollama-client');

function workerId() { return `worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

function normalizeWorkers(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map(item => {
    const endpoint = normalizeEndpoint(item?.endpoint);
    const model = String(item?.model || '').trim();
    const name = String(item?.name || '').trim();
    if (!endpoint || !model || !name) return undefined;
    try {
      const url = new URL(endpoint);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined;
    } catch { return undefined; }
    const id = String(item?.id || workerId());
    if (seen.has(id)) return undefined;
    seen.add(id);
    return { id, name: name.slice(0, 80), endpoint, model: model.slice(0, 200), enabled: item?.enabled !== false };
  }).filter(Boolean).slice(0, 8);
}

class WorkerPool {
  constructor({ getWorkers, log }) {
    this.getWorkers = getWorkers;
    this.log = log || (() => {});
  }

  workers() { return normalizeWorkers(this.getWorkers()); }

  client(worker) {
    return new OllamaClient({ getEndpoint: () => worker.endpoint });
  }

  async health() {
    const workers = this.workers();
    return Promise.all(workers.map(async worker => {
      if (!worker.enabled) return { ...worker, status: 'disabled' };
      try {
        const version = await this.client(worker).version();
        return { ...worker, status: 'available', version: version.version || '' };
      } catch (error) {
        return { ...worker, status: 'unavailable', error: String(error.message || error) };
      }
    }));
  }

  async delegate(task, context = {}) {
    const health = await this.health();
    const available = health.filter(worker => worker.status === 'available');
    if (!available.length) return { health, results: [] };
    const system = [
      'You are a read-only auxiliary worker for a VS Code coding agent.',
      'Analyze only the supplied task. You may use only the supplied read-only tools to search/read local chat history, list/read/search the open project, and search/fetch public web pages when enabled.',
      'You have no shell, Git, write, install, image, or destructive capabilities. Never claim an action or observation that your tool results do not support.',
      'Return concise, concrete findings, assumptions, risks, and suggested next steps for the master agent.',
      context.language ? `Reply in ${context.language}.` : ''
    ].filter(Boolean).join(' ');
    const results = await Promise.all(available.map(async worker => {
      try {
        const messages = [{ role: 'system', content: system }, ...(context.initialMessages || []), { role: 'user', content: task }];
        for (let step = 0; step < 10; step++) {
          const response = await this.client(worker).chat({
            model: worker.model,
            messages,
            tools: context.tools || [],
            temperature: 0.2,
            contextWindow: 0,
            onThinkingUnsupported: () => {}
          });
          const message = response.message || { role: 'assistant', content: '' };
          messages.push(message);
          const calls = context.extractCalls ? context.extractCalls(message) : (message.tool_calls || []);
          if (!calls.length) return { worker, text: String(message.content || '').trim() };
          for (const call of calls) {
            const result = await context.executeTool(call);
            messages.push({ role: 'tool', tool_name: call.function.name, content: String(result) });
          }
        }
        return { worker, error: 'Read-only worker reached its 10-step research limit.' };
      } catch (error) {
        return { worker, error: String(error.message || error) };
      }
    }));
    return { health, results };
  }
}

module.exports = { WorkerPool, normalizeWorkers };
