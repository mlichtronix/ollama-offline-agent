'use strict';

// The task runtime owns progress and terminal state. Models can suggest an
// action, but they cannot mutate this state directly. The UI receives a plain
// snapshot (`ui`) so it stays independent from the execution engine.

const phaseAliases = Object.freeze({
  tools: 'work',
  continue: 'work',
  plan: 'review'
});
const phaseOrder = Object.freeze(['prepare', 'understand', 'research', 'analyze', 'work', 'implement', 'verify', 'review', 'complete']);
const terminalStates = new Set(['complete', 'failed', 'stopped', 'blocked']);

function normalizePhase(value) {
  const phase = String(value || 'work');
  return phaseAliases[phase] || (phaseOrder.includes(phase) ? phase : 'work');
}

class TaskRuntime {
  constructor({ mode = 'execute', startedAt = new Date().toISOString() } = {}) {
    this.ui = { mode, state: 'running', startedAt, timeline: [], activity: [], workers: { active: 0, total: 0 }, files: [], checks: [], canRestore: false };
  }

  transition(phase, status = 'active', detail = '') {
    if (terminalStates.has(this.ui.state) && status === 'active') return this.ui;
    const normalized = normalizePhase(phase);
    if (status === 'active') {
      for (const item of this.ui.timeline) if (item.phase !== normalized && item.status === 'active') item.status = 'complete';
    }
    const existing = this.ui.timeline.find(item => item.phase === normalized);
    const item = existing || { phase: normalized, status, detail };
    item.status = status;
    if (detail) item.detail = detail;
    if (!existing) this.ui.timeline.push(item);
    if (detail) {
      const previous = this.ui.activity.at(-1);
      if (!previous || previous.phase !== normalized || previous.status !== status || previous.detail !== detail) this.ui.activity.push({ phase: normalized, status, detail, at: new Date().toISOString() });
      if (this.ui.activity.length > 30) this.ui.activity.splice(0, this.ui.activity.length - 30);
    }
    return this.ui;
  }

  setWorkers(active, total = active) {
    this.ui.workers = { active: Math.max(0, Number(active) || 0), total: Math.max(0, Number(total) || 0) };
    return this.ui;
  }

  recordFile(file, checkpoint, stats, state = {}) {
    const existing = this.ui.files.find(item => item.path === file);
    if (existing) Object.assign(existing, { ...stats, ...state });
    else this.ui.files.push({ path: file, snapshot: checkpoint?.snapshot, existed: checkpoint?.existed, ...stats, ...state });
    this.ui.canRestore ||= Boolean(checkpoint);
    return this.ui;
  }

  recordCheck(command, result, passed) {
    this.ui.checks.push({ command, passed: Boolean(passed), result });
    return this.ui;
  }

  finish(state = 'complete', detail = '') {
    const terminal = terminalStates.has(state) ? state : 'failed';
    this.ui.state = terminal;
    this.ui.finishedAt ||= new Date().toISOString();
    this.transition('complete', terminal === 'complete' ? 'complete' : terminal, detail);
    return this.ui;
  }
}

module.exports = { TaskRuntime, normalizePhase, phaseOrder, terminalStates };
