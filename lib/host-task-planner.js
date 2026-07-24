'use strict';

// Task sequencing is host-owned. Small local models are good at deciding the
// next concrete action, but asking them to first serialize administrative plan
// metadata is an avoidable point of failure. This gives every Execute task a
// valid, inspectable route before the model receives its first tool schema.
function bootstrapTaskPlan({ task, hasPublicSource = false } = {}) {
  const request = String(task || '').toLowerCase();
  const mentionsWeb = hasPublicSource || /https?:\/\/|\b(web|website|api|url|online|internet|download|source code)\b/i.test(request);
  const changeRequested = /\b(implement|create|write|add|change|modify|fix|refactor|delete|update|build|document|library|script)\b/i.test(request)
    || /\b(implementuj|vytvor|zap[ií]š|pridaj|zme[nň]|oprav|uprav|vymaž|aktualizuj|knižnicu|skript|dokumentuj)\b/i.test(request);
  const steps = [];
  if (mentionsWeb) steps.push({ phase: 'research', title: 'Gather public source evidence' });
  steps.push({ phase: 'analyze', title: 'Analyze requirements and available evidence' });
  if (changeRequested) {
    steps.push({ phase: 'work', title: 'Prepare the focused implementation approach' });
    steps.push({ phase: 'implement', title: 'Implement the requested workspace changes' });
    steps.push({ phase: 'verify', title: 'Verify the implemented result' });
  }
  steps.push({ phase: 'review', title: 'Review the result and report evidence' });
  return steps;
}

module.exports = { bootstrapTaskPlan };
