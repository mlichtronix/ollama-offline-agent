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

function modelAvailable(models, requested) {
  const name = String(requested || '').trim();
  const alternatives = name.endsWith(':latest') ? [name, name.slice(0, -7)] : [name, name + ':latest'];
  return models.some(model => alternatives.includes(String(model?.name || '').trim()));
}
function text(value, limit = 1200) { return String(value || '').trim().slice(0, limit); }
function canonicalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return /^https?:$/.test(url.protocol) ? url.toString() : '';
  } catch { return ''; }
}
function parseReportJson(content) {
  const source = String(content || '').replace(/\`\`\`(?:json)?/gi, '').replace(/\`\`\`/g, '').trim();
  const candidate = source.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return undefined;
  try { return JSON.parse(candidate); } catch { return undefined; }
}
function normalizeWorkerReport(content, fetchedUrls = new Set()) {
  const raw = String(content || '').trim();
  const value = parseReportJson(raw);
  if (!value || Array.isArray(value)) {
    return { format: 'legacy', summary: text(raw, 6000) || 'Worker returned no report.', findings: [], risks: [], nextSteps: [], unverified: ['The worker did not return the required structured report. Treat all claims as unverified.'], fetchedUrls: [...fetchedUrls] };
  }
  const findings = (Array.isArray(value.findings) ? value.findings : []).slice(0, 12).map(item => {
    const evidence = (Array.isArray(item?.evidence) ? item.evidence : []).slice(0, 6).map(source => {
      const url = canonicalUrl(source?.url);
      return { url, note: text(source?.note, 500), fetched: Boolean(url && fetchedUrls.has(url)) };
    }).filter(item => item.url);
    const reportedConfidence = ['verified', 'conditional', 'unverified'].includes(item?.confidence) ? item.confidence : 'unverified';
    let confidence = reportedConfidence;
    if (confidence === 'verified' && !evidence.some(item => item.fetched)) confidence = 'unverified';
    return { claim: text(item?.claim, 1400), reportedConfidence, confidence, evidence };
  }).filter(item => item.claim);
  return {
    format: 'structured',
    summary: text(value.summary, 1600) || 'Worker returned no summary.',
    findings,
    risks: (Array.isArray(value.risks) ? value.risks : []).slice(0, 10).map(item => text(item, 700)).filter(Boolean),
    nextSteps: (Array.isArray(value.nextSteps) ? value.nextSteps : []).slice(0, 10).map(item => text(item, 700)).filter(Boolean),
    unverified: (Array.isArray(value.unverified) ? value.unverified : []).slice(0, 10).map(item => text(item, 700)).filter(Boolean),
    fetchedUrls: [...fetchedUrls]
  };
}
function reportRepairReasons(report) {
  const reasons = [];
  if (report.format !== 'structured') reasons.push('the response was not valid structured JSON');
  if (!report.findings.length && !report.unverified.length && !report.risks.length) reasons.push('the handoff contains no findings, risks, or explicit unknowns');
  if (report.findings.some(item => item.reportedConfidence === 'verified' && item.confidence !== 'verified')) reasons.push('a claim was labelled verified without a source fetched through the host');
  return reasons;
}
function workerReportMarkdown(report) {
  const lines = ['## Summary', report.summary];
  if (report.findings.length) {
    lines.push('', '## Findings');
    for (const finding of report.findings) {
      lines.push('- **' + finding.confidence + '** — ' + finding.claim);
      for (const evidence of finding.evidence) lines.push('  - ' + (evidence.fetched ? 'Host-fetched evidence' : 'Unverified citation') + ': ' + evidence.url + (evidence.note ? ' — ' + evidence.note : ''));
    }
  }
  if (report.risks.length) lines.push('', '## Risks', ...report.risks.map(item => '- ' + item));
  if (report.nextSteps.length) lines.push('', '## Recommended next steps', ...report.nextSteps.map(item => '- ' + item));
  if (report.unverified.length) lines.push('', '## Unverified', ...report.unverified.map(item => '- ' + item));
  lines.push('', '## Host evidence audit', '- Structured report: ' + (report.format === 'structured' ? 'yes' : 'no'), '- URLs fetched through the host: ' + report.fetchedUrls.length);
  return lines.join('\n');
}

async function chatWithIdleTimeout(client, options, parentSignal, timeoutMs) {
  const milliseconds = Math.max(0, Number(timeoutMs) || 0);
  if (!milliseconds) return client.chat({ ...options, signal: parentSignal });
  const controller = new AbortController(); let timedOut = false; let timer;
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const resetTimer = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; controller.abort(); }, milliseconds); };
  resetTimer();
  try {
    return await client.chat({ ...options, signal: controller.signal, onChunk: partial => { resetTimer(); options.onChunk?.(partial); } });
  } catch (error) {
    if (timedOut) throw new Error(`Worker timed out after ${Math.round(milliseconds / 1000)} seconds without a response.`);
    throw error;
  } finally { clearTimeout(timer); parentSignal?.removeEventListener('abort', abortFromParent); }
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

  async health({ benchmark = false, signal } = {}) {
    const workers = this.workers();
    return Promise.all(workers.map(async worker => {
      if (!worker.enabled) return { ...worker, status: 'disabled' };
      try {
        const client = this.client(worker); const [version, models] = await Promise.all([client.version(signal), client.listModels(signal)]);
        if (!modelAvailable(models, worker.model)) return { ...worker, status: 'model-missing', version: version.version || '', error: 'Configured model is not installed on this worker endpoint: ' + worker.model };
        const modelProfiles = [];
        for (const model of models.slice(0, 16)) {
          try { modelProfiles.push({ ...model, profile: await client.modelProfile(model.name, signal) }); }
          catch (error) { modelProfiles.push({ ...model, profileError: String(error.message || error) }); }
        }
        const configured = modelProfiles.find(item => modelAvailable([{ name: item.name }], worker.model)) || { name: worker.model };
        let profile = configured.profile; let profileError = configured.profileError || '';
        try { if (benchmark && profile) profile.benchmark = await client.benchmark(configured.name, signal); }
        catch (error) { profileError = String(error.message || error); }
        return { ...worker, model: configured.name, status: 'available', version: version.version || '', models, modelProfiles, profile, profileError };
      } catch (error) {
        return { ...worker, status: 'unavailable', error: String(error.message || error) };
      }
    }));
  }

  async delegate(task, context = {}) {
    const health = context.health || await this.health({ signal: context.signal });
    const available = health.filter(worker => worker.status === 'available');
    if (!available.length) return { health, results: [] };
    const assignments = new Map((context.assignments || []).map(item => [item.workerId, { role: String(item.role || 'specialist').trim(), task: String(item.task || '').trim(), requires: Array.isArray(item.requires) ? item.requires.map(value => String(value)) : [] }]));
    const publicWebEnabled = (context.tools || []).some(tool => ['web_search', 'web_fetch', 'web_download'].includes(tool?.function?.name));
    const system = [
      'You are a read-only auxiliary worker for a VS Code coding agent.',
      'Analyze only the supplied task. You may use only the supplied read-only tools to search/read local chat history, list/read/search the open project, and search/fetch public web pages when enabled.',
      'You have no shell, Git, write, install, image, or destructive capabilities. Never claim an action or observation that your tool results do not support.',
      publicWebEnabled ? 'Public web tools are enabled for this assignment. The host and user have already authorized public HTTP(S) research: use web_search and web_fetch for pages, and web_download followed by read_downloaded_web_file for source files. A JavaScript-required SPA page is not a blocker: download its raw HTML, identify referenced static bundles or source maps, then download/search those files. Downloaded files are task-scoped, read-only memory: never claim to write, execute, or retain them. Do not ask for another approval or say that web access is unavailable. If retrieval fails, state the exact tool result and do not invent a source or protocol.' : 'Public web tools are disabled for this assignment. Do not claim to have accessed an external source.',
      'Use English for all reasoning, tool requests, source notes, and the final report, regardless of the user-facing language. For factual claims, use a source whose authority matches the claim: an official specification or standards body for protocol semantics, official project documentation or registry metadata for package facts, and an official publisher or register for legal/service facts. A vendor blog can support only what that vendor says or does, not universal protocol behavior. Search-result snippets, model memory, and third-party summaries are leads only, never verification. Present architectural tradeoffs as conditional analysis with their assumptions, not universal facts. Return only one JSON object, without Markdown fences or any text outside it: {"summary":"...","findings":[{"claim":"...","confidence":"verified|conditional|unverified","evidence":[{"url":"exact URL fetched with web_fetch in this task","note":"why this source supports the claim"}]}],"risks":["..."],"nextSteps":["..."],"unverified":["..."]}. Keep it below 6,000 characters. A claim is verified only if its cited URL was fetched with web_fetch during this task; otherwise use conditional or unverified. Do not guess or infer a date/version. Do not end mid-sentence or promise a continuation.'
    ].filter(Boolean).join(' ');
    const results = await Promise.all(available.filter(worker => assignments.get(worker.id)).map(async worker => {
      try {
        const assignment = assignments.get(worker.id); const assignedTask = assignment.task; const fetchedUrls = new Set(); const repairReasons = []; let repairAttempted = false;
        const messages = [{ role: 'system', content: system }, ...(context.initialMessages || []), { role: 'user', content: `Overall user task:\n${task}\n\nYour expert role: ${assignment.role}\nYour distinct assigned subtask:\n${assignedTask}` }];
        for (let step = 0; step < 10; step++) {
          if (context.signal?.aborted) throw Object.assign(new Error('Worker delegation stopped by user.'), { name: 'AbortError' });
          const response = await chatWithIdleTimeout(this.client(worker), {
            model: worker.model,
            messages,
            tools: context.tools || [],
            temperature: 0.2,
            contextWindow: 0,
            format: 'json', signal: context.signal,
            onThinkingUnsupported: () => {}
          }, context.signal, context.workerTimeoutMs);
          const message = response.message || { role: 'assistant', content: '' };
          messages.push(message);
          const calls = context.extractCalls ? context.extractCalls(message) : (message.tool_calls || []);
          if (!calls.length) {
            const report = normalizeWorkerReport(message.content, fetchedUrls);
            const reasons = reportRepairReasons(report);
            if (reasons.length && !repairAttempted && step < 9) {
              repairAttempted = true; repairReasons.push(...reasons);
              messages.push({ role: 'user', content: 'Host handoff check failed because ' + reasons.join('; ') + '. Correct the report now. Fetch any source you want to call verified, otherwise mark it conditional or unverified. Return only the required JSON object.' });
              continue;
            }
            return { worker, role: assignment.role, task: assignedTask, requires: assignment.requires, text: workerReportMarkdown(report), report, quality: { repairAttempted, repairReasons, accepted: !reasons.length } };
          }
          for (const call of calls) {
            const result = await context.executeTool(call);
            if (['web_fetch', 'web_download'].includes(call.function?.name) && !/^Tool error:|^Web access is disabled\./i.test(String(result))) {
              try {
                const args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : call.function.arguments || {};
                const url = canonicalUrl(args.url); if (url) fetchedUrls.add(url);
              } catch {}
            }
            messages.push({ role: 'tool', tool_name: call.function.name, content: String(result) });
          }
        }
        return { worker, role: assignment.role, task: assignedTask, requires: assignment.requires, error: 'Read-only worker reached its 10-step research limit.' };
      } catch (error) {
        const assignment = assignments.get(worker.id); return { worker, role: assignment?.role, task: assignment?.task, requires: assignment?.requires, error: String(error.message || error) };
      }
    }));
    return { health, results };
  }
}

module.exports = { WorkerPool, normalizeWorkers, modelAvailable, normalizeWorkerReport, reportRepairReasons, workerReportMarkdown };
