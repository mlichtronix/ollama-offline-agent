'use strict';

// Completion is decided from host-observed task state, not from a model saying
// "done". This deliberately stays small and deterministic so policy can be
// tested independently from the orchestration loop.

function verifyCompletion(ui = {}, { requirePlan = false } = {}) {
  if (ui.mode !== 'execute') return { ok: true };
  if (requirePlan && !(ui.plan || []).length) return { ok: false, reason: 'missing_plan', phase: 'analyze', message: 'This execute task requires a host-accepted task plan before completion.' };
  const pending = (ui.plan || []).filter(item => item.status === 'pending');
  if (pending.length) return { ok: false, reason: 'pending_plan', phase: 'work', message: `${pending.length} accepted plan step(s) remain.` };
  const files = ui.files || [];
  if (!files.length) return { ok: true };
  const checks = ui.checks || [];
  const failed = checks.filter(check => !check.passed);
  if (failed.length) return { ok: false, reason: 'failed_checks', phase: 'implement', message: `${failed.length} verification check(s) failed.` };
  if (!checks.length && !ui.verification?.blocker) return { ok: false, reason: 'missing_validation', phase: 'verify', message: 'Workspace files changed but no verification command or recorded blocker exists.' };
  return { ok: true, verification: ui.verification?.blocker ? 'blocked' : 'passed' };
}

module.exports = { verifyCompletion };
