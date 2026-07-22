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
  constructor({ getWorkers, getAuthorization, log }) {
    this.getWorkers = getWorkers;
    this.getAuthorization = getAuthorization;
    this.log = log || (() => {});
  }

  workers() { return normalizeWorkers(this.getWorkers()); }

  client(worker) {
    return new OllamaClient({ getEndpoint: () => worker.endpoint, getAuthorization: () => this.getAuthorization?.(worker) });
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
    const health = context.health || await this.health();
    const available = health.filter(worker => worker.status === 'available');
    if (!available.length) return { health, results: [] };
    const assignments = new Map((context.assignments || []).map(item => [item.workerId, { role: String(item.role || 'specialist').trim(), task: String(item.task || '').trim() }]));
    const system = [
      'You are a read-only auxiliary worker for a VS Code coding agent.',
      'Analyze only the supplied task. You may use only the supplied read-only tools to search/read local chat history, list/read/search the open project, and search/fetch public web pages when enabled.',
      'You have no shell, Git, write, install, image, or destructive capabilities. Never claim an action or observation that your tool results do not support.',
      'Use English for all reasoning, tool requests, source notes, and the final report, regardless of the user-facing language. Return one complete, concise Markdown report under 6,000 characters. State evidence, assumptions, risks, and concrete next steps for the master. For factual claims, use a source whose authority matches the claim: an official specification or standards body for protocol semantics, official project documentation or registry metadata for package facts, and an official publisher or register for legal/service facts. A vendor blog can support only what that vendor says or does, not universal protocol behavior. Include an exact fetched URL next to every externally sourced factual claim. Search-result snippets, model memory, and third-party summaries are leads only, never verification. Present architectural tradeoffs as conditional analysis with their assumptions, not universal facts. Put unsupported claims in a clearly labelled “Unverified leads” section; do not guess or infer a date/version. Do not end mid-sentence or promise a continuation.'
    ].filter(Boolean).join(' ');
    const results = await Promise.all(available.filter(worker => assignments.get(worker.id)).map(async worker => {
      try {
        const assignment = assignments.get(worker.id); const assignedTask = assignment.task;
        const messages = [{ role: 'system', content: system }, ...(context.initialMessages || []), { role: 'user', content: `Overall user task:\n${task}\n\nYour expert role: ${assignment.role}\nYour distinct assigned subtask:\n${assignedTask}` }];
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
          if (!calls.length) return { worker, role: assignment.role, task: assignedTask, text: String(message.content || '').trim() };
          for (const call of calls) {
            const result = await context.executeTool(call);
            messages.push({ role: 'tool', tool_name: call.function.name, content: String(result) });
          }
        }
        return { worker, role: assignment.role, task: assignedTask, error: 'Read-only worker reached its 10-step research limit.' };
      } catch (error) {
        const assignment = assignments.get(worker.id); return { worker, role: assignment?.role, task: assignment?.task, error: String(error.message || error) };
      }
    }));
    return { health, results };
  }
}

module.exports = { WorkerPool, normalizeWorkers };
