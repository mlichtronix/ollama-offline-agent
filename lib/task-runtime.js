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
const phaseTransitions = Object.freeze({
  prepare: ['understand'],
  understand: ['research', 'analyze', 'implement', 'review'],
  research: ['analyze', 'implement', 'review'],
  analyze: ['work', 'implement', 'review'],
  work: ['implement', 'verify', 'review'],
  implement: ['verify', 'review', 'work'],
  verify: ['implement', 'review', 'work'],
  review: ['implement', 'verify', 'work', 'complete'],
  complete: []
});
const plannablePhases = new Set(['research', 'analyze', 'work', 'implement', 'verify', 'review']);

function normalizePhase(value) {
  const phase = String(value || 'work');
  return phaseAliases[phase] || (phaseOrder.includes(phase) ? phase : 'work');
}

class TaskRuntime {
  constructor({ mode = 'execute', startedAt = new Date().toISOString() } = {}) {
    this.ui = { mode, state: 'running', startedAt, timeline: [], activity: [], plan: [], workers: { active: 0, total: 0 }, files: [], checks: [], canRestore: false };
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
    if (status === 'active') this.activatePlanPhase(normalized);
    if (detail) {
      const previous = this.ui.activity.at(-1);
      if (!previous || previous.phase !== normalized || previous.status !== status || previous.detail !== detail) this.ui.activity.push({ phase: normalized, status, detail, at: new Date().toISOString() });
      if (this.ui.activity.length > 30) this.ui.activity.splice(0, this.ui.activity.length - 30);
    }
    return this.ui;
  }

  activatePlanPhase(phase) {
    const plan = this.ui.plan || [];
    const next = plan.find(item => item.phase === phase && item.status === 'pending');
    if (!next) return;
    for (const item of plan) if (item.status === 'active' && item.id !== next.id) item.status = 'complete';
    next.status = 'active';
  }

  setPlan(steps) {
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 8) return { ok: false, message: 'A task plan must contain between 1 and 8 steps.' };
    const plan = [];
    let previous = this.activePhase();
    for (const raw of steps) {
      const title = String(raw?.title || '').replace(/\s+/g, ' ').trim();
      const phase = normalizePhase(raw?.phase);
      if (title.length < 3 || title.length > 140) return { ok: false, message: 'Every plan step needs a title between 3 and 140 characters.' };
      if (!plannablePhases.has(phase)) return { ok: false, message: `Plan phase ${phase} is not allowed.` };
      if (plan.length && phase === previous) return { ok: false, message: `Plan cannot repeat the ${phase} phase; combine related work into one concise step.` };
      if (phase !== previous && !phaseTransitions[previous]?.includes(phase)) return { ok: false, message: `Plan cannot move from ${previous} to ${phase}.` };
      plan.push({ id: `step-${plan.length + 1}`, title, phase, status: 'pending' });
      previous = phase;
    }
    this.ui.plan = plan;
    this.activatePlanPhase(this.activePhase());
    return { ok: true, ui: this.ui };
  }

  incompletePlan() {
    return (this.ui.plan || []).filter(item => item.status !== 'complete');
  }

  activePhase() {
    return this.ui.timeline.find(item => item.status === 'active')?.phase || 'understand';
  }

  advance(target, detail = '') {
    const from = this.activePhase(); const next = normalizePhase(target);
    if (next === from) return { ok: true, from, to: next, ui: this.ui };
    if (!phaseTransitions[from]?.includes(next)) return { ok: false, from, to: next, message: `Cannot advance task from ${from} to ${next}.` };
    this.transition(next, 'active', detail || `Advanced from ${from} to ${next}.`);
    return { ok: true, from, to: next, ui: this.ui };
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
    if (terminal === 'complete') for (const item of this.ui.plan || []) if (item.status === 'active') item.status = 'complete';
    this.transition('complete', terminal === 'complete' ? 'complete' : terminal, detail);
    return this.ui;
  }
}

module.exports = { TaskRuntime, normalizePhase, phaseOrder, terminalStates, phaseTransitions, plannablePhases };
