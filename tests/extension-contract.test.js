const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { OllamaClient, normalizeEndpoint, isLocalEndpoint } = require('../lib/ollama-client');
const { ChatStore } = require('../lib/chat-store');
const { normalizeWorkers, modelAvailable, normalizeWorkerReport, reportRepairReasons, workerReportMarkdown } = require('../lib/worker-pool');
const { classifyModelMessage } = require('../lib/model-adapter');
const { TaskRuntime } = require('../lib/task-runtime');
const { EvidenceStore } = require('../lib/evidence-store');
const { prepareToolCall, toolResult, serializeToolResult, parseToolResult } = require('../lib/tool-broker');
const { ipv4ToUint32, uint32ToIpv4, netmaskToPrefixLength, isPrivateIpv4, localIpv4Interfaces, subnetHosts } = require('../lib/worker-discovery');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
const ollamaClientSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ollama-client.js'), 'utf8');
const workerPoolSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'worker-pool.js'), 'utf8');
const modelAdapterSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'model-adapter.js'), 'utf8');
const taskRuntimeSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'task-runtime.js'), 'utf8');
const evidenceStoreSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'evidence-store.js'), 'utf8');
const toolBrokerSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tool-broker.js'), 'utf8');
const workerDiscoverySource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'worker-discovery.js'), 'utf8');
const browserSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'headless-browser.js'), 'utf8');

test('Ollama client normalizes endpoints and sends scoped bearer authorization', async () => {
  assert.equal(normalizeEndpoint(' http://127.0.0.1:11434/// '), 'http://127.0.0.1:11434');
  assert.equal(isLocalEndpoint('http://127.0.0.1:11434'), true);
  assert.equal(isLocalEndpoint('https://ollama.example.test'), false);
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, init) => { request = { url, init }; return { ok: true }; };
  try {
    const client = new OllamaClient({ getEndpoint: () => 'http://server.local:11434/', getAuthorization: async () => 'Bearer test-token' });
    await client.fetch('/api/tags', { headers: { Accept: 'application/json' } });
    assert.equal(request.url, 'http://server.local:11434/api/tags');
    assert.deepEqual(request.init.headers, { Accept: 'application/json', Authorization: 'Bearer test-token' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('worker definitions accept only complete HTTP read-only endpoints', () => {
  const workers = normalizeWorkers([
    { id: 'one', name: 'LAN worker', endpoint: 'http://192.168.1.20:11434/', model: 'qwen3:8b' },
    { id: 'bad', name: 'Bad', endpoint: 'file:///tmp/ollama', model: 'qwen3:8b' },
    { id: 'missing-model', name: 'Incomplete', endpoint: 'http://192.168.1.21:11434' }
  ]);
  assert.deepEqual(workers, [{ id: 'one', name: 'LAN worker', endpoint: 'http://192.168.1.20:11434', model: 'qwen3:8b', enabled: true }]);
});

test('model adapter accepts only native or complete fallback tool calls', () => {
  const tools = [{ function: { name: 'list_files' } }, { function: { name: 'read_file' } }];
  assert.deepEqual(classifyModelMessage({ tool_calls: [{ function: { name: 'list_files', arguments: { directory: '.' } } }] }, tools), { kind: 'tool_call', calls: [{ function: { name: 'list_files', arguments: '{"directory":"."}' } }], source: 'native' });
  assert.deepEqual(classifyModelMessage({ content: 'list_files {"directory":"."}' }, tools), { kind: 'tool_call', calls: [{ function: { name: 'list_files', arguments: '{"directory":"."}' } }], source: 'plain-fallback' });
  assert.equal(classifyModelMessage({ content: 'For each function call, return a json object with function name and arguments within' }, tools).kind, 'invalid_model_output');
  const unavailable = classifyModelMessage({ tool_calls: [{ function: { name: 'write_file', arguments: { path: 'x.txt', content: 'x' } } }] }, tools);
  assert.equal(unavailable.kind, 'invalid_model_output');
  assert.equal(unavailable.reason, 'unavailable_tool:write_file');
  assert.equal(classifyModelMessage({ content: 'Use list_files {"directory":"."} and then explain the result.' }, tools).kind, 'final_answer');
});

test('task runtime owns ordered progress and terminal state', () => {
  const runtime = new TaskRuntime({ mode: 'execute', startedAt: '2026-07-24T10:00:00.000Z' });
  runtime.transition('understand', 'active', 'Inspecting request.');
  runtime.transition('tools', 'active', 'Reading files.');
  assert.deepEqual(runtime.ui.timeline.map(item => [item.phase, item.status]), [['understand', 'complete'], ['work', 'active']]);
  assert.equal(runtime.activePhase(), 'work');
  assert.equal(runtime.advance('implement', 'Evidence is sufficient.').ok, true);
  assert.equal(runtime.activePhase(), 'implement');
  assert.equal(runtime.advance('research').ok, false);
  runtime.recordFile('src/example.py', { snapshot: 'checkpoint', existed: true }, { added: 3, removed: 1 });
  runtime.recordCheck('python -m pytest', 'passed', true);
  runtime.finish('complete', 'Verified.');
  assert.equal(runtime.ui.state, 'complete');
  assert.equal(runtime.ui.files[0].added, 3);
  assert.equal(runtime.ui.checks[0].passed, true);
  assert.equal(runtime.ui.finishedAt !== undefined, true);
});

test('evidence store cites only deliberate host evidence, not browser telemetry', () => {
  const evidence = new EvidenceStore();
  const page = evidence.record('browser_open', 'https://dev.example.test/', 'Example IDE');
  evidence.record('web_download', 'https://dev.example.test/static/app.js', 'app.js');
  evidence.recordDownload({ id: 'web-1', url: 'https://dev.example.test/static/app.js', name: 'app.js', data: Buffer.from('source'), text: true });
  assert.equal(page.isNewSource, true);
  assert.deepEqual(evidence.sources().map(item => item.url), ['https://dev.example.test/', 'https://dev.example.test/static/app.js']);
  assert.equal(evidence.getDownload('web-1').name, 'app.js');
  assert.equal(evidenceStoreSource.includes('separate from browser telemetry'), true);
});

test('tool broker validates task-visible calls and serializes structured results', () => {
  const tools = [{ function: { name: 'list_files' } }];
  const allowed = prepareToolCall({ function: { name: 'list_files', arguments: '{"directory":"."}' } }, tools);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.phase, 'work');
  const blocked = prepareToolCall({ function: { name: 'write_file', arguments: '{}' } }, tools);
  assert.deepEqual(blocked, { ok: false, tool: 'write_file', kind: 'blocked', content: 'Tool write_file is not available in the current task state.' });
  const result = parseToolResult(serializeToolResult(toolResult(allowed, 'one.txt')));
  assert.deepEqual(result, { ok: true, tool: 'list_files', kind: 'success', phase: 'work', content: 'one.txt' });
  assert.equal(toolBrokerSource.includes('untrusted model response'), true);
});

test('worker preflight requires the configured model on its endpoint', () => {
  assert.equal(modelAvailable([{ name: 'qwen3:8b' }], 'qwen3:8b'), true);
  assert.equal(modelAvailable([{ name: 'qwen3:latest' }], 'qwen3'), true);
  assert.equal(modelAvailable([{ name: 'qwen2.5:7b' }], 'qwen3:8b'), false);
  assert.match(workerPoolSource, /status: 'model-missing'/);
});

test('worker reports preserve structured claims and distinguish host-fetched evidence', () => {
  const fetched = new Set(['https://registry.npmjs.org/example']);
  const report = normalizeWorkerReport(JSON.stringify({
    summary: 'Checked package metadata.',
    findings: [
      { claim: 'The package version is 1.2.3.', confidence: 'verified', evidence: [{ url: 'https://registry.npmjs.org/example', note: 'Registry metadata.' }] },
      { claim: 'A blog repeats the version.', confidence: 'verified', evidence: [{ url: 'https://example.com/blog', note: 'Not fetched.' }] }
    ],
    risks: ['Release dates may change.'], nextSteps: ['Master should inspect the registry response.'], unverified: []
  }), fetched);
  assert.equal(report.format, 'structured');
  assert.equal(report.findings[0].confidence, 'verified');
  assert.equal(report.findings[0].evidence[0].fetched, true);
  assert.equal(report.findings[1].confidence, 'unverified');
  assert.match(workerReportMarkdown(report), /Host-fetched evidence/);
  assert.match(workerReportMarkdown(report), /Host evidence audit/);
  assert.deepEqual(reportRepairReasons(report), ['a claim was labelled verified without a source fetched through the host']);
});

test('chat store persists UTF-8 history and matching conversation context', async () => {
  const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ollama-agent-test-'));
  let nextId = 0;
  const options = { getWorkspace: () => workspace, createId: () => `id-${++nextId}` };
  try {
    const first = new ChatStore(options);
    await first.ensureWorkspace();
    const user = first.rememberUser('Zadanie: over UTF-8', 'Zadanie: over UTF-8');
    first.rememberAssistant('Výsledok je správny.', 'assistant-1');
    await first.save();

    const restored = new ChatStore(options);
    await restored.ensureWorkspace();
    assert.equal(restored.history.length, 2);
    assert.equal(restored.history[0].id, user.id);
    assert.equal(restored.history[0].text, 'Zadanie: over UTF-8');
    assert.equal(restored.latestUser().content, 'Zadanie: over UTF-8');
    assert.equal(restored.latestAssistant().content, 'Výsledok je správny.');
    assert.equal(restored.removeFrom(user.id).length, 2);
    assert.equal(restored.history.length, 0);
    await restored.save();
  } finally {
    await fs.promises.rm(workspace, { recursive: true, force: true });
  }
});

test('shared file excerpts persist as display-only chat events', async () => {
  const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ollama-agent-excerpt-'));
  let nextId = 0;
  try {
    const store = new ChatStore({ getWorkspace: () => workspace, createId: () => `excerpt-${++nextId}` });
    await store.ensureWorkspace();
    store.append('fileExcerpt', '# Heading\n\n```python\nprint(1)\n```', { fileExcerpt: { path: 'docs/example.md', startLine: 1, endLine: 5, totalLines: 8, language: 'markdown' } });
    await store.save();
    const restored = new ChatStore({ getWorkspace: () => workspace, createId: () => `restored-${++nextId}` });
    await restored.ensureWorkspace();
    assert.equal(restored.history[0].kind, 'fileExcerpt');
    assert.deepEqual(restored.history[0].fileExcerpt, { path: 'docs/example.md', startLine: 1, endLine: 5, totalLines: 8, language: 'markdown' });
    assert.equal(restored.conversation.length, 0);
  } finally { await fs.promises.rm(workspace, { recursive: true, force: true }); }
});

test('security controls remain present', () => {
  assert.match(source, /realpathSync\.native/);
  assert.match(source, /isSensitiveTarget/);
  assert.match(source, /stopProcessTree/);
  assert.match(source, /rollback_last_change/);
  assert.match(source, /Allow for this task/);
  assert.match(source, /approvedCommands\.clear\(\)/);
});

test('Ollama context and streaming remain configured', () => {
  const packageJson = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
  assert.match(packageJson, /"ollamaOffline\.webEnabled"[^\n]+"default": true/);
  assert.match(source, /function webEnabled\(\) \{ return config\(\)\.get\('webEnabled', true\); \}/);
  assert.match(ollamaClientSource, /num_ctx/);
  assert.match(ollamaClientSource, /stream: true/);
  assert.match(ollamaClientSource, /format/);
  assert.match(workerPoolSource, /format: 'json'/);
  assert.match(ollamaClientSource, /api\/chat/);
  assert.match(source, /describeExecutionEnvironment/);
  assert.match(source, /configured VS Code integrated-terminal profile/);
  assert.match(source, /search_chat_history/);
  assert.match(source, /read_chat_messages/);
  assert.match(source, /most recent assistant answer is always supplied as candidate context/);
  assert.match(source, /latestAssistantContext/);
  assert.match(source, /latestUserContext/);
  assert.match(source, /benchmark: true/);
  assert.match(source, /Candidate previous user request/);
  assert.match(source, /function steer\(/);
  assert.match(source, /function queueAgentRequest/);
  assert.match(source, /Steering accepted at the completed subtask boundary/);
  assert.doesNotMatch(source, /Steering requested: \$\{task\}\); requestStop\(\)/);
  assert.match(source, /setPromptState\(id, 'waiting'\)/);
  assert.match(source, /setPromptState\(id, 'queued'\)/);
  assert.match(source, /setPromptState\(promptId, 'delivered'\)/);
  assert.match(source, /setPromptState\(promptId, 'read'\)/);
  assert.match(source, /queuedAgentRequests/);
  const chatSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
  assert.match(chatSource, /function formatShortTime/);
  assert.match(chatSource, /class="user-message-meta"/);
  assert.match(chatSource, /element\.querySelector\('\.user-message-meta'\)/);
  assert.match(chatSource, /let editingMessageId/);
  assert.match(chatSource, /const editId = editingMessageId/);
  assert.doesNotMatch(chatSource, /type: 'editMessage'/);
  assert.match(source, /function replaceChatBranch/);
  assert.match(source, /message\.editId/);
  assert.match(source, /if \(replacedBranch\) chatProvider\?\.replay\(\)/);
  assert.match(source, /function resolveWindowsCommandShell/);
  assert.match(source, /function resolvePosixCommandShell/);
  assert.match(source, /function detectExecutionEnvironment/);
  assert.match(source, /executionEnvironment = detectExecutionEnvironment\(\)/);
  assert.match(source, /cp\.execFile\(runner\.executable/);
  assert.match(source, /command working directory does not exist or is inaccessible/);
  assert.match(source, /command cwd is not a directory/);
  assert.match(source, /cached runner can become stale/);
  assert.match(source, /Before write_file, base the complete replacement only on the actual, complete content returned by read_file/);
  assert.match(source, /'-NoProfile', '-NonInteractive'/);
  assert.match(chatSource, /data-steering-mode/);
  assert.match(chatSource, /Queue follow-up/);
  assert.match(source, /class="composer-hint"/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.css'), 'utf8'), /@media \(max-width: 440px\).*composer-hint/s);
  assert.match(source, /workerToolNames/);
  assert.match(source, /executeWorkerTool/);
  assert.match(source, /planWorkerAssignments/);
  assert.match(source, /dispatchWorkerPlan/);
  assert.match(source, /hasDependencyCycle/);
  assert.match(source, /dependsOn/);
  assert.match(source, /const maxWorkerTasks = available\.length/);
  assert.match(source, /delegationReason/);
  assert.match(source, /An explicit user maximum is an upper bound/);
  assert.match(source, /Do not substitute a generic workspace inventory/);
  assert.match(source, /workerDispatchContext/);
  assert.match(source, /Planning distinct expert assignments/);
  assert.match(source, /fallbackWorkerPlan/);
  assert.match(source, /rememberWorkerReports/);
  assert.match(source, /event\.internal/);
  assert.match(source, /Worker delegation is host-managed/);
  assert.match(workerPoolSource, /source whose authority matches the claim/);
  assert.match(workerPoolSource, /Use English for all reasoning, tool requests, source notes, and the final report/);
  assert.match(source, /Write masterFocus, role, task, and requires in English/);
  assert.match(source, /workerRuntimeCapabilities/);
  assert.match(source, /workerSupportsRequirements/);
  assert.match(source, /function preferredWorkerModel/);
  assert.match(source, /function workerRuntimeForAssignment/);
  assert.match(source, /function readOnlyWorkerViolation/);
  assert.match(source, /function workerResultUsable/);
  assert.match(source, /function isDirectAgentQuestion/);
  assert.match(source, /Worker delegation skipped: this is a direct question/);
  assert.match(source, /workerIdleTimeoutMs/);
  assert.match(source, /The master will continue without this expert report/);
  assert.match(source, /Retrying \$\{assignment\.role\} on compatible worker/);
  assert.match(source, /No compatible worker could complete/);
  assert.match(source, /No safe compatible installed model for this assignment/);
  assert.match(source, /Empty-response recovery guard/);
  assert.match(source, /const workerBenchmarks = new Map\(\)/);
  assert.match(source, /cached\?\.key === key/);
  assert.match(source, /const needsBenchmark = configuredWorkers\(\)\.some/);
  assert.match(source, /item\.requires\.every\(capability => workerRequirementNames\.has\(capability\)\)/);
  assert.match(ollamaClientSource, /async modelProfile\(model, signal\)/);
  assert.match(ollamaClientSource, /async benchmark\(model, signal\)/);
  assert.match(workerPoolSource, /async health\(\{ benchmark = false, signal \} = \{\}\)/);
  assert.match(workerPoolSource, /modelProfiles/);
  assert.match(workerPoolSource, /function chatWithIdleTimeout/);
  assert.match(workerPoolSource, /Worker timed out after/);
  assert.match(workerPoolSource, /requires: Array\.isArray\(item\.requires\)/);
  assert.match(source, /const activeAbortControllers = new Set\(\)/);
  assert.match(source, /Stop requested: aborting active Ollama and worker requests/);
  assert.match(taskRuntimeSource, /startedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(chatSource, /function formatTaskDuration\(/);
  assert.match(source, /function exportChatPdf\(/);
  assert.match(source, /--print-to-pdf=/);
  assert.match(source, /function waitForPdfOutput\(/);
  assert.match(chatSource, /checkCheckSvg/);
  assert.match(chatSource, /taskUi = undefined; renderTaskUi\(\)/);
  assert.match(chatSource, /out\.push\('<hr>'\)/);
  assert.match(chatSource, /task-item/);
  assert.match(chatSource, /math-block/);
  assert.match(chatSource, /~~\(\.\+\?\)~~/);
  assert.match(source, /function exportMarkdown\(/);
  assert.match(source, /function exportCodeLanguage\(/);
  assert.match(source, /highlightElement\(block\)/);
  assert.match(source, /exportMarkdown\(event\.text\)/);
  assert.match(source, /parseDelegationPlan\(response\.message\?\.content, workers, maxTasks\)/);
  assert.doesNotMatch(workerPoolSource, /Reply in \$\{context\.language\}/);
  assert.match(source, /search-result snippet, model memory, or a secondary summary is not verification/i);
  assert.match(source, /cite a URL as a source only after web_fetch successfully returned that exact page/i);
  assert.match(source, /Public web access is ON \(the Globe setting is enabled\)/);
  assert.match(source, /function workerFailureReason/);
  assert.match(source, /name: 'web_download'/);
  assert.match(source, /name: 'read_downloaded_web_file'/);
  assert.match(source, /name: 'search_downloaded_web_file'/);
  assert.match(source, /JavaScript-required SPA page/);
  assert.match(source, /name: 'list_browsers'/);
  assert.match(source, /name: 'browser_open'/);
  assert.match(source, /controlled browser tools/);
  assert.match(source, /Prefer Chrome when it is installed/);
  assert.match(source, /no installed headless browser produced a usable DOM/);
  assert.match(source, /produced no usable DOM, so the host retried/);
  assert.match(source, /automatically rendered it with the controlled browser/);
  assert.match(source, /function browserStaticResources/);
  assert.match(source, /function prefetchExplicitWebSources/);
  assert.match(source, /Host prefetching explicit public source/);
  assert.match(source, /explicitWebContext = !continuationMessages \? await prefetchExplicitWebSources\(task\)/);
  assert.match(source, /also downloaded the primary JavaScript bundle/);
  assert.match(source, /onThinkingDisabledForTools/);
  assert.match(modelAdapterSource, /<tool_call>/);
  assert.match(source, /classifyModelMessage/);
  assert.match(source, /Model adapter rejected invalid output/);
  assert.match(modelAdapterSource, /unavailable_tool:/);
  assert.match(source, /name: 'advance_task_phase'/);
  assert.match(source, /function toolsForTaskPhase/);
  assert.match(source, /activeTaskTools = toolsForTaskPhase\(taskTools\)/);
  assert.match(taskRuntimeSource, /const phaseTransitions/);
  assert.match(source, /function normalizeWorkspaceAlias/);
  assert.match(source, /\^\\\/workspace\(\?:\\\/\|\$\)/);
  assert.match(source, /function normalizeToolArguments/);
  assert.match(workerPoolSource, /invalid_model_output/);
  assert.match(source, /Agent repeated the same failing/);
  assert.match(source, /throwIfCancelled\(\);/);
  assert.match(workerPoolSource, /call list_browsers then browser_open/);
  assert.match(browserSource, /function createFilteringProxy/);
  assert.match(browserSource, /async function publicAddress/);
  assert.match(browserSource, /--proxy-server=http:\/\/127\.0\.0\.1/);
  assert.match(browserSource, /Private browser destination is blocked/);
  assert.match(source, /activeEvidenceStore = new EvidenceStore\(\)/);
  assert.match(source, /await rememberWebEvidence\(target, target\.hostname, 'web_fetch'\)/);
  assert.doesNotMatch(source, /for \(const observed of sources\.slice/);
  assert.match(source, /const rendered = await browserOpen\(target\.toString\(\), 'chrome', 8000\)/);
  assert.match(source, /vendor blog supports its own claims but not universal protocol semantics/i);
  assert.match(source, /Present REST\/GraphQL-style tradeoffs as conditional analysis/i);
  assert.match(source, /workerTokenKey/);
  assert.match(source, /setWorkerToken/);
  assert.match(source, /loadWorkerModels/);
  assert.match(source, /probeWorkerModels/);
  assert.match(chatSource, /serverPlusSvg/);
  assert.match(chatSource, /workersMenu/);
  assert.match(chatSource, /composer\.before\(workersDialog\)/);
  assert.match(chatSource, /<table class="worker-table">/);
  assert.match(chatSource, /closeWorkersDialog/);
  assert.match(chatSource, /openWorkersDialog/);
  assert.match(chatSource, /Optional Bearer token — stored securely/);
  assert.match(chatSource, /Loading installed models/);
  assert.match(chatSource, /scheduleWorkerSave/);
  assert.match(chatSource, /addWorkerRow/);
  assert.match(chatSource, /workerTokenPopover/);
  assert.match(chatSource, /keyRoundSvg/);
  assert.match(chatSource, /data-load-worker-models/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.css'), 'utf8'), /Worker manager is an in-flow panel above the composer/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.css'), 'utf8'), /\.worker-table-wrap[^}]*overflow-x: auto/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.css'), 'utf8'), /\.worker-token-popover/);
});

test('task modes enforce read-only planning and expose timeline review state', () => {
  const chatSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
  const chatStyles = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.css'), 'utf8');
  assert.match(source, /requestedMode = 'execute'/);
  assert.match(source, /Plan mode is read-only/);
  assert.match(source, /const taskTools = taskMode === 'execute'/);
  assert.match(source, /function updateTaskUi/);
  assert.match(taskRuntimeSource, /this\.ui\.activity/);
  assert.match(source, /new TaskRuntime/);
  assert.match(source, /function updateTaskWorkers/);
  assert.match(source, /updateTaskWorkers\(assignments\.length/);
  assert.match(source, /recordTaskFile/);
  assert.match(source, /recordTaskCheck/);
  assert.match(source, /function diffLineStats/);
  assert.match(source, /function readFileContent/);
  assert.match(source, /function shareFileExcerpt/);
  assert.match(source, /name: 'share_file_excerpt'/);
  assert.match(source, /function openSharedFileExcerpt/);
  assert.match(source, /Shared \$\{relative\}, lines/);
  assert.match(source, /startLine/);
  assert.match(source, /pattern: \{ type: 'string'/);
  assert.match(source, /Regex filter rejected/);
  assert.match(source, /function openTaskFileDiff/);
  assert.match(source, /executeCommand\('vscode\.diff'/);
  assert.match(source, /showTextDocument\(document, \{ preview: true \}\)/);
  assert.match(source, /if \(!fullSystem\(\) && !approvedCommands\.has\(approvalKey\)\)/);
  assert.match(source, /name: 'delete_file'/);
  assert.match(source, /Deletion is limited to a file inside the current workspace/);
  assert.match(source, /function canAutonomouslyMutateWorkspace/);
  assert.match(source, /if \(!canAutonomouslyMutateWorkspace\(target, args\.path\)\)/);
  assert.match(source, /function isFilesystemRoot/);
  assert.match(source, /current workspace is the filesystem root/);
  assert.match(source, /Unix-style \/workspace paths are not valid project paths on Windows/);
  assert.match(source, /function isEndpointLimitError/);
  assert.match(source, /function fallbackMasterCandidates/);
  assert.match(source, /chatWithMasterFailover/);
  assert.match(source, /Master endpoint limit detected/);
  assert.match(source, /type: 'taskUi'/);
  assert.match(chatSource, /data-task-mode/);
  assert.match(chatSource, /message-receipt/);
  assert.match(chatSource, /receiptInfo/);
  assert.match(chatSource, /id = 'taskPanel'/);
  assert.match(chatSource, /Restore latest checkpoint/);
  assert.match(chatSource, /data-task-diff/);
  assert.match(chatSource, /review-summary/);
  assert.match(chatSource, /<details class="review-checks"/);
  assert.match(chatSource, /<details class="review-files"/);
  assert.match(chatSource, /<details class="task-activity"/);
  assert.doesNotMatch(chatSource, /<ol>\$\{timeline\}<\/ol>/);
  assert.match(chatSource, /<i aria-hidden="true"><\/i><strong>/);
  assert.match(chatSource, /worker\$\{activeWorkers/);
  assert.match(chatSource, /const undoSvg/);
  assert.match(chatSource, /class="task-undo"/);
  assert.match(chatStyles, /\.task-panel/);
  assert.match(chatStyles, /\.task-review/);
  assert.match(chatStyles, /\.task-activity/);
});

test('remote Ollama configuration keeps credentials out of workspace settings', () => {
  const chatSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
  assert.match(source, /new OllamaClient/);
  assert.match(source, /`Bearer \$\{endpointToken\}`/);
  assert.match(ollamaClientSource, /Authorization: authorization/);
  assert.match(source, /context\.secrets\.get\('ollamaEndpointToken'\)/);
  assert.match(source, /function setEndpoint/);
  assert.match(source, /Use Remote Endpoint/);
  assert.match(chatSource, /id="endpoint"/);
  assert.match(chatSource, /id="endpointToken"/);
  assert.match(chatSource, /type: 'setEndpoint'/);
});

test('a recreated chat receives an ordered streaming snapshot', () => {
  const chatSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
  assert.match(source, /const activeStreams = new Map\(\)/);
  assert.match(source, /this\.messageQueues = new WeakMap\(\)/);
  assert.match(source, /type: 'historySnapshot'/);
  assert.match(source, /isReady\(view\)/);
  assert.match(chatSource, /message\.type === 'historySnapshot'/);
  assert.match(chatSource, /chat\.replaceChildren\(\)/);
  assert.match(chatSource, /stickToBottom/);
  assert.match(source, /new ChatStore/);
});

test('chat rendering preserves inline-code table pipes and exposes copy/reply actions', () => {
  const chatSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
  const chatStyles = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.css'), 'utf8');
  assert.match(chatSource, /function tableCells/);
  assert.match(chatSource, /function renderFileExcerpt/);
  assert.match(chatSource, /file-excerpt-markdown/);
  assert.match(chatSource, /data-open-file-excerpt/);
  assert.match(chatSource, /data-copy-table/);
  assert.match(chatSource, /copySvg/);
  assert.match(chatSource, /pencilSvg/);
  assert.match(chatSource, /replySvg/);
  assert.match(chatSource, /source-fallback-icon/);
  assert.match(chatStyles, /\.source-fallback-icon/);
  assert.match(chatSource, /selectedExcerpt/);
  assert.match(chatSource, /getFullYear\(\).*getMonth\(\).*getSeconds\(\)/s);
  assert.match(chatSource, /renderAbout/);
  assert.match(chatSource, /globalThis\.hljs/);
  assert.match(chatSource, /languageAliases/);
  assert.doesNotMatch(chatSource, /lang === 'lua'/);
  assert.match(source, /highlight\.min\.js/);
  assert.match(chatStyles, /\.hljs-keyword/);
  const highlighter = require(path.join(__dirname, '..', 'media', 'highlight.min.js'));
  for (const language of ['lua', 'python', 'csharp', 'cpp', 'powershell', 'yaml']) assert.equal(Boolean(highlighter.getLanguage(language)), true);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'media', 'HIGHLIGHTJS-LICENSE'), 'utf8'), /BSD/);
  assert.match(chatStyles, /\.composer-actions\s*\{\s*display:\s*flex/);
});

test('about exposes the installed extension version', () => {
  assert.match(source, /function showAbout/);
  assert.match(source, /context\.extension\?\.packageJSON\?\.version/);
  assert.match(source, /ollamaOffline\.about/);
  const chatSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
  assert.match(chatSource, /aboutPanel/);
});

test('clearing chat history remains explicit and confirmed', () => {
  assert.match(source, /Clear this workspace chat history/);
  assert.match(source, /Clear Chat History/);
  assert.match(source, /postUi\('historyCleared'\)/);
});

test('webview controls do not reference removed header actions', () => {
  const chatSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
  const chatStyles = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.css'), 'utf8');
  assert.doesNotMatch(chatSource, /getElementById\('new'\)/);
  assert.match(chatSource, /mode-\$\{value\}/);
  assert.match(chatSource, /document\.addEventListener\('drop'/);
  assert.match(chatSource, /hasDroppedFiles/);
  assert.match(chatSource, /No files were received from the drop operation/);
  assert.match(chatSource, /addEventListener\('paste'/);
  assert.match(source, /Shift\+drop/);
  assert.match(chatSource, /data-remove-attachment/);
  assert.match(source, /function cancelResource/);
  assert.match(chatSource, /function openImageViewer/);
  assert.match(chatSource, /imageViewer/);
  assert.match(chatSource, /id="steeringMenu" class="setting-menu steering-menu"/);
  assert.match(chatStyles, /\.steering-menu\s*\{\s*left:\s*50%;\s*width:\s*112px;\s*min-width:\s*0;\s*transform:\s*translateX\(-68%\)/);
});

test('the chat view has one current HTML renderer', () => {
  assert.match(source, /renderHtml\(webview\)/);
  assert.doesNotMatch(source, /renderHtmlV2/);
  assert.doesNotMatch(source, /renderHtmlV3/);
  assert.match(source, /html\(webview\)\s*\{\s*return this\.renderHtml\(webview\);\s*\}/s);
});

test('the package script derives a unique VSIX version from Git history', () => {
  const packageScript = fs.readFileSync(path.join(__dirname, '..', 'package-vsix.ps1'), 'utf8');
  assert.match(packageScript, /git -C \$root rev-list --count HEAD/);
  assert.match(packageScript, /versionBaseRevision/);
  assert.match(packageScript, /\$revision - \$baseRevision/);
  assert.match(packageScript, /ollama-offline-agent-\$version\.vsix/);
  assert.match(packageScript, /Join-Path \$root 'lib'/);
  assert.match(packageScript, /UTF8Encoding\(\$false\)/);
});

test('release workflow publishes a stable latest-download VSIX asset', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /ollama-offline-agent\.vsix/);
});

test('worker autodetect is limited to small private IPv4 subnets', () => {
  assert.equal(ipv4ToUint32('192.168.1.1'), 3232235777);
  assert.equal(uint32ToIpv4(3232235777), '192.168.1.1');
  assert.equal(netmaskToPrefixLength('255.255.255.0'), 24);
  assert.throws(() => netmaskToPrefixLength('255.0.255.0'), /Non-contiguous/);
  assert.equal(isPrivateIpv4('192.168.1.5'), true);
  assert.equal(isPrivateIpv4('172.16.1.5'), true);
  assert.equal(isPrivateIpv4('172.32.1.5'), false);
  assert.equal(isPrivateIpv4('127.0.0.1'), false);
  const hosts = subnetHosts('192.168.1.10', 24, 254);
  assert.equal(hosts.length, 253);
  assert.equal(hosts.includes('192.168.1.10'), false);
  assert.throws(() => subnetHosts('10.0.0.10', 16, 254), /safe discovery limit/);
  assert.deepEqual(localIpv4Interfaces({
    ethernet: [{ family: 'IPv4', internal: false, address: '192.168.1.10', netmask: '255.255.255.0' }],
    loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
    public: [{ family: 'IPv4', internal: false, address: '203.0.113.5', netmask: '255.255.255.0' }]
  }).map(item => item.address), ['192.168.1.10']);
  assert.match(source, /async function autodetectWorkers/);
  assert.match(source, /discoverOllamaHosts/);
  assert.match(source, /const discoveredModels = new Map\(\)/);
  assert.match(source, /postUi\('workerModels', \{ id: worker\.id, models: discoveredModels\.get\(worker\.id\)/);
  assert.match(workerDiscoverySource, /maxHostsPerSubnet: 254/);
});
