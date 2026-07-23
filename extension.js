'use strict';

const vscode = require('vscode');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const cp = require('child_process');
const { OllamaClient, normalizeEndpoint, isLocalEndpoint } = require('./lib/ollama-client');
const { ChatStore } = require('./lib/chat-store');
const { WorkerPool, normalizeWorkers } = require('./lib/worker-pool');
const { discoverOllamaHosts } = require('./lib/worker-discovery');

let cancelled = false;
let running = false;
let output;
let chatView;
let sideBarChatView;
let editorChatPanel;
let chatProvider;
const pendingResources = [];
const cancelledResourceClients = new Set();
const activeAbortControllers = new Set();
let activeChild;
let environmentDescription;
let executionEnvironment;
let extensionVersion = 'unknown';
let extensionSecrets;
let endpointToken = '';
let endpointTokenFor = '';
let endpointTokenReady = Promise.resolve();
let pendingSteering;
let activeAgentMessages;
const queuedAgentRequests = [];
const promptStates = new Map();
let activeWebSources = [];
const workerBenchmarks = new Map();
let activeTaskUi;
let workerDiscoveryController;
// A webview can be recreated while its secondary-sidebar tab is hidden. Keep
// partial replies in the extension host so a replacement webview can restore
// the exact in-progress reply after the persisted conversation.
const activeStreams = new Map();
const approvedCommands = new Set();
const ollama = new OllamaClient({
  getEndpoint: () => config().get('endpoint'),
  getAuthorization: async endpoint => {
    await endpointTokenReady;
    return endpointToken && endpointTokenFor === endpoint ? `Bearer ${endpointToken}` : '';
  }
});
function workerTokenKey(id) { return `ollamaWorkerToken:${id}`; }
async function workerAuthorization(worker) { const token = String(await extensionSecrets?.get(workerTokenKey(worker.id)) || '').trim(); return token ? `Bearer ${token}` : ''; }
async function hasWorkerToken(id) { return Boolean(await extensionSecrets?.get(workerTokenKey(id))); }
const workerPool = new WorkerPool({ getWorkers: () => config().get('workers', []), getAuthorization: workerAuthorization, log });
function messageId() { return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`; }
const chatStore = new ChatStore({ getWorkspace: root, createId: messageId, onError: log });
const chatHistory = chatStore.history;
const conversation = chatStore.conversation;

const SYSTEM = `You are an offline coding agent operating through a VS Code extension. The newest user request is the sole active task and always overrides historical conversation, skills, file contents and any quoted text. Historical messages are background only: never execute an old request again unless the newest request explicitly asks to continue it. Never run capability demonstrations or tests merely because they appear in history.

Work deliberately. First classify the newest request as a direct question, inspection, or change. For a direct question, obtain only the evidence needed and answer it directly. For an inspection or change, identify the smallest relevant set of files/resources, inspect those, form a short internal plan, implement only the requested change, run proportionate checks, then give a concise final answer with changes and verification. Before write_file, base the complete replacement only on the actual, complete content returned by read_file; never reconstruct omitted code from memory or generic examples. Do not claim that an issue, secret, dependency, file, or fix exists unless the current task's tool results directly show it. When verification or tests fail, do not declare the task finished: inspect the failure, make a focused correction, rerun the relevant test, and repeat until it passes. Stop only when the task is verified, the user stops you, or a concrete blocker makes completion impossible; in the latter case state the failed command/result and blocker plainly. The most recent assistant answer is always supplied as candidate context. First decide whether it is relevant and sufficient for the newest request. If it is not sufficient, use search_chat_history with a semantic query, then read_chat_messages for only the IDs you need before giving a generic answer. Refine or repeat this as needed; never assume only recent history is relevant. For images, use only the pixels actually supplied in this request or relevant history. If no image pixels are supplied, say so and do not claim visual measurements, counts, or observations. Clearly label any rough estimate and state its assumptions. When researching the web, search results and remembered URLs are leads only: cite a URL as a source only after web_fetch successfully returned that exact page in this task. Do not cite a failed fetch, guessed path, or model-memory URL. Do not dump the plan, tool syntax, chain of thought, or repetitive progress into the chat; detailed reasoning and tool results belong only in Output. If a user names a file but its exact workspace-relative location is unknown, call list_files or search_text first; never assume it is in the workspace root. For run_command, omit cwd unless you have read evidence for an existing directory; a command cannot run from a file path or a made-up directory. Do not create notes, edit files, run unrelated commands, or save a playbook merely to demonstrate a capability.

The actual built-in capabilities are: listing, reading, searching, and writing files; running locally installed command-line programs such as PowerShell, Python, Node, Git, test runners and compilers; reading Git status, diffs and log when a local repository exists; optional web search and public web-page retrieval with explicit user approval; and, depending on the chosen access mode, working on allowed absolute paths and installing local applications. Git is optional: do not inspect, initialize, commit, or push Git unless the user asks for version-control work or it is directly necessary for the task. A local-only repository is fully valid and never requires a remote. The product is offline-first: treat network access as optional, never assume it is available, and continue with local alternatives when a network action fails. Web tools are not available without network access and must never be used for private, local, or LAN addresses. A saved playbook is NOT a new capability: it is only reusable Markdown guidance for future tasks. If asked about capabilities, explain the built-in tools and the available local runtime programs, not the Markdown storage format. Never claim you ran a tool you did not call. In Full system mode, normal create, edit, and delete operations on non-sensitive files physically inside the open workspace proceed autonomously with checkpoints; writes outside it, sensitive files, and playbook saves still require approval. Destructive system commands remain blocked even in full system mode. Use native tool calling whenever it is available. Never output a tool call as plain text.`;

function log(text) { output.appendLine(text); }
function escapeExportHtml(value) { return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function exportInlineMarkdown(value) { let html = escapeExportHtml(value).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/(\*\*\*|___)(.+?)\1/g, '<strong><em>$2</em></strong>').replace(/(\*\*|__)(.+?)\1/g, '<strong>$2</strong>').replace(/~~(.+?)~~/g, '<del>$1</del>'); html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/(^|[^\w])_([^_]+)_(?!\w)/g, '$1<em>$2</em>').replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>'); return html.replace(/&lt;(https?:\/\/[^\s&]+(?:&amp;[^\s&]+)*)&gt;/g, '<a href="$1">$1</a>'); }
function exportTableCells(line) { return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|')); }
function exportMath(value) { return escapeExportHtml(value).replace(/\^\{([^}]+)\}|\^(\w)/g, (_, group, character) => `<sup>${group || character}</sup>`).replace(/_\{([^}]+)\}|_(\w)/g, (_, group, character) => `<sub>${group || character}</sub>`); }
function exportCodeLanguage(value) { const aliases = { 'c#': 'csharp', cs: 'csharp', 'c++': 'cpp', cxx: 'cpp', hpp: 'cpp', py: 'python', js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', sh: 'bash', shell: 'bash', pwsh: 'powershell', ps1: 'powershell', yml: 'yaml', html: 'xml', svg: 'xml', md: 'markdown', text: 'plaintext', plain: 'plaintext' }; const requested = String(value || '').trim().toLowerCase(); return aliases[requested] || requested || 'plaintext'; }
function exportMarkdown(value) {
  const lines = String(value || '').replace(/\r/g, '').split('\n'); const out = []; let code = []; let codeLanguage = ''; let inCode = false; let listStack = []; let inQuote = false; let math = [];
  const closeList = () => { while (listStack.length) out.push(`</${listStack.pop().type}>`); };
  const closeQuote = () => { if (inQuote) { out.push('</blockquote>'); inQuote = false; } };
  const openList = (type, level) => { while (listStack.length > level + 1) out.push(`</${listStack.pop().type}>`); if (listStack[level]?.type !== type) { while (listStack.length > level) out.push(`</${listStack.pop().type}>`); } while (listStack.length <= level) { listStack.push({ type }); out.push(`<${type}>`); } };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === '$$') { closeList(); closeQuote(); if (math.length) { out.push(`<div class="math-block">${exportMath(math.join('\n'))}</div>`); math = []; } else math = ['']; continue; }
    if (math.length) { math.push(line); continue; }
    if (/^\$\$.+\$\$$/.test(line.trim())) { closeList(); closeQuote(); out.push(`<div class="math-block">${exportMath(line.trim().slice(2, -2))}</div>`); continue; }
    if (line.startsWith('```')) { closeList(); closeQuote(); if (inCode) { const language = exportCodeLanguage(codeLanguage); out.push(`<pre><code class="hljs language-${escapeExportHtml(language)}">${escapeExportHtml(code.join('\n'))}</code></pre>`); code = []; codeLanguage = ''; } else codeLanguage = line.slice(3).trim().split(/\s+/)[0]; inCode = !inCode; continue; }
    if (inCode) { code.push(line); continue; }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { closeList(); if (!inQuote) { out.push('<blockquote>'); inQuote = true; } out.push(quote[1] ? `<p>${exportInlineMarkdown(quote[1])}</p>` : '<div class="spacer"></div>'); continue; }
    closeQuote();
    if (/^\s{0,3}(?:---+|\*\*\*+|___+)\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    if (/^\|?.+\|.+\|?$/.test(line) && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] || '')) {
      closeList(); const headers = exportTableCells(line); index += 2; const rows = [];
      while (index < lines.length && /^\|?.+\|.+\|?$/.test(lines[index])) { rows.push(exportTableCells(lines[index])); index++; }
      index--; out.push(`<div class="table-wrap"><table><thead><tr>${headers.map(cell => `<th>${exportInlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((_, cell) => `<td>${exportInlineMarkdown(row[cell] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/); const listItem = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
    if (heading) { closeList(); const level = heading[1].length; out.push(`<h${level}>${exportInlineMarkdown(heading[2])}</h${level}>`); continue; }
    if (listItem) { const level = Math.floor(listItem[1].replace(/\t/g, '  ').length / 2); const type = /\d+\./.test(listItem[2]) ? 'ol' : 'ul'; const task = listItem[3].match(/^\[([ xX])\]\s+(.+)$/); openList(type, level); out.push(`<li${task ? ' class="task-item"' : ''}>${task ? `<input type="checkbox" disabled${/[xX]/.test(task[1]) ? ' checked' : ''}> ${exportInlineMarkdown(task[2])}` : exportInlineMarkdown(listItem[3])}</li>`); continue; }
    closeList(); out.push(line ? `<p>${exportInlineMarkdown(line)}</p>` : '<div class="spacer"></div>');
  }
  closeList(); closeQuote(); if (math.length) out.push(`<div class="math-block">${exportMath(math.join('\n'))}</div>`); if (inCode) { const language = exportCodeLanguage(codeLanguage); out.push(`<pre><code class="hljs language-${escapeExportHtml(language)}">${escapeExportHtml(code.join('\n'))}</code></pre>`); } return out.join('');
}
function exportTimestamp(value) { try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value)); } catch { return String(value || ''); } }
function conversationExportHtml(events) {
  const highlighter = vscode.Uri.file(path.join(__dirname, 'media', 'highlight.min.js')).toString();
  const messages = `<style>.markdown del{opacity:.8}.markdown blockquote{margin:8px 0;padding:2px 0 2px 11px;border-left:3px solid #d0d7de;color:#57606a}.markdown .task-item{list-style:none;margin-left:-16px}.markdown .task-item input{margin:0 5px 0 0;vertical-align:middle}.markdown .math-block{margin:9px 0;padding:8px 10px;overflow-x:auto;background:#f6f8fa;border:1px solid #d0d7de;border-radius:5px;font-family:'Cambria Math',Cambria,serif;font-size:11pt;text-align:center}</style><script src="${escapeExportHtml(highlighter)}" defer></script><script defer>addEventListener('DOMContentLoaded',()=>document.querySelectorAll('pre code').forEach(block=>{try{hljs.highlightElement(block)}catch{}}))</script>` + events.map(event => {
    const role = event.kind === 'assistant' ? 'Agent' : 'User';
    const attachments = (event.attachments || []).length ? `<p class="attachments">Attachments: ${(event.attachments || []).map(item => escapeExportHtml(item.name || item.path)).join(', ')}</p>` : '';
    const sources = (event.sources || []).length ? `<p class="sources">Sources: ${(event.sources || []).map(item => `<a href="${escapeExportHtml(item.url)}">${escapeExportHtml(item.title || item.url)}</a>`).join(' · ')}</p>` : '';
    return `<article class="message ${event.kind === 'assistant' ? 'assistant' : 'user'}"><header><strong>${role}</strong><time>${escapeExportHtml(exportTimestamp(event.createdAt))}</time></header><div class="markdown">${exportMarkdown(event.text)}</div>${attachments}${sources}</article>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="UTF-8"><title>Ollama Agent Conversation</title><style>@page{size:A4;margin:16mm}*{box-sizing:border-box}body{font-family:Segoe UI,Arial,sans-serif;color:#1f2328;font-size:10.5pt;line-height:1.5}h1{font-size:18pt;margin:0 0 4px}.meta{margin:0 0 18px;color:#57606a}.message{break-inside:avoid;margin:0 0 12px;padding:12px 14px;border:1px solid #d0d7de;border-radius:8px}.message.user{margin-left:12%;background:#eaf3ff;border-color:#b6d4fe}.message.assistant{margin-right:5%;background:#fff}.message header{display:flex;justify-content:space-between;gap:16px;margin-bottom:8px}.message time,.attachments,.sources{color:#57606a;font-size:9pt}.markdown p{margin:0 0 7px}.markdown h1,.markdown h2,.markdown h3{margin:14px 0 7px;line-height:1.25}.markdown h1{font-size:15pt}.markdown h2{font-size:13pt}.markdown h3{font-size:11pt}.markdown ul,.markdown ol{margin:5px 0 8px;padding-left:22px}.markdown pre{break-inside:avoid;margin:8px 0;padding:9px 10px;overflow-wrap:anywhere;white-space:pre-wrap;color:#24292f;background:#f6f8fa;border:1px solid #d0d7de;border-radius:5px;font:9pt/1.45 Consolas,'Courier New',monospace}.markdown code{padding:1px 3px;background:#f6f8fa;border-radius:3px;font-family:Consolas,'Courier New',monospace}.markdown pre code{padding:0;background:transparent}.markdown hr{border:0;border-top:1px solid #d0d7de;margin:13px 0}.markdown .spacer{height:5px}.table-wrap{overflow:hidden;margin:8px 0;border:1px solid #d0d7de;border-radius:5px}.markdown table{width:100%;border-collapse:collapse;font-size:9pt}.markdown th,.markdown td{padding:5px 7px;text-align:left;vertical-align:top;border-right:1px solid #d0d7de;border-bottom:1px solid #d0d7de}.markdown th:last-child,.markdown td:last-child{border-right:0}.markdown tr:last-child td{border-bottom:0}.markdown th{background:#f6f8fa}.attachments,.sources{margin:8px 0 0}.sources a{color:#0969da;text-decoration:none}</style></head><body><h1>Ollama Agent Conversation</h1><p class="meta">Exported locally on ${escapeExportHtml(exportTimestamp(new Date()))}</p>${messages}</body></html>`;
}
function pdfBrowserExecutable() {
  const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const windows = programFiles.flatMap(base => [path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe')]);
  const mac = ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  const linux = ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser'];
  return [...windows, ...mac, ...linux].find(candidate => candidate.includes(path.sep) ? fs.existsSync(candidate) : true);
}
function runFile(command, args, options = {}) { return new Promise((resolve, reject) => cp.execFile(command, args, { windowsHide: true, timeout: 60000, ...options }, error => error ? reject(error) : resolve())); }
async function waitForPdfOutput(file, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs; let lastSize = -1;
  while (Date.now() < deadline) {
    try { const stat = await fsp.stat(file); if (stat.size > 100 && stat.size === lastSize) return; lastSize = stat.size; } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('The browser did not finish writing the PDF file.');
}
async function exportChatPdf() {
  const events = chatHistory.filter(event => !event.internal);
  if (!events.length) return vscode.window.showWarningMessage('There is no conversation to export.');
  const target = await vscode.window.showSaveDialog({ title: 'Export conversation to PDF', saveLabel: 'Export PDF', defaultUri: vscode.Uri.file(path.join(root() || os.homedir(), `ollama-conversation-${new Date().toISOString().replace(/[:.]/g, '-')}.pdf`)), filters: { PDF: ['pdf'] } });
  if (!target) return;
  const browser = pdfBrowserExecutable();
  if (!browser) return vscode.window.showErrorMessage('PDF export requires a locally installed Chromium browser such as Microsoft Edge or Google Chrome.');
  const temporaryHtml = path.join(os.tmpdir(), `ollama-conversation-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  try {
    await fsp.writeFile(temporaryHtml, conversationExportHtml(events), 'utf8');
    await runFile(browser, ['--headless=new', '--disable-gpu', '--allow-file-access-from-files', '--no-pdf-header-footer', `--print-to-pdf=${target.fsPath}`, vscode.Uri.file(temporaryHtml).toString()]);
    await waitForPdfOutput(target.fsPath);
    const action = await vscode.window.showInformationMessage(`Conversation exported to ${path.basename(target.fsPath)}.`, 'Reveal File');
    if (action === 'Reveal File') await vscode.commands.executeCommand('revealFileInOS', target);
  } catch (error) {
    vscode.window.showErrorMessage(`Could not export conversation to PDF: ${error.message}`);
  } finally { await fsp.unlink(temporaryHtml).catch(() => undefined); }
}
function postUi(type, data = {}) {
  // Do not send into a webview that has not completed its ready handshake.
  // Its snapshot will include all state accumulated while it was unavailable.
  const sources = type === 'message' ? (data.sources || []).map(item => ({ ...item, source: true })) : [];
  if (chatView) void chatProvider?.post(chatView, { type, ...data, ...(sources.length ? { attachments: [...(data.attachments || []), ...sources] } : {}) });
}
function setPromptState(id, state) {
  if (!id) return;
  promptStates.set(String(id), state);
  postUi('promptState', { id: String(id), state });
}
function updateTaskUi(phase, status = 'active', detail = '') {
  if (!activeTaskUi) return;
  if (status === 'active') {
    for (const previous of activeTaskUi.timeline) {
      if (previous.phase !== phase && previous.status === 'active') previous.status = 'complete';
    }
  }
  const existing = activeTaskUi.timeline.find(item => item.phase === phase);
  const item = existing || { phase, status, detail };
  item.status = status; if (detail) item.detail = detail;
  if (!existing) activeTaskUi.timeline.push(item);
  if (detail) {
    activeTaskUi.activity ||= [];
    const previous = activeTaskUi.activity.at(-1);
    if (!previous || previous.phase !== phase || previous.status !== status || previous.detail !== detail) activeTaskUi.activity.push({ phase, status, detail, at: new Date().toISOString() });
    if (activeTaskUi.activity.length > 30) activeTaskUi.activity.splice(0, activeTaskUi.activity.length - 30);
  }
  postUi('taskUi', activeTaskUi);
}
function updateTaskWorkers(active, total = active) {
  if (!activeTaskUi) return;
  activeTaskUi.workers = { active: Math.max(0, Number(active) || 0), total: Math.max(0, Number(total) || 0) };
  postUi('taskUi', activeTaskUi);
}
function diffLineStats(before, after) {
  const oldLines = String(before || '') ? String(before).split(/\r?\n/) : [];
  const newLines = String(after || '') ? String(after).split(/\r?\n/) : [];
  // The common-subsequence path gives familiar diff counts for normal source
  // files. For very large files, keep this bounded and use the same prefix /
  // suffix strategy used by the approval preview.
  if (oldLines.length * newLines.length <= 360000) {
    let previous = new Uint32Array(newLines.length + 1);
    for (let oldIndex = 1; oldIndex <= oldLines.length; oldIndex++) {
      const current = new Uint32Array(newLines.length + 1);
      for (let newIndex = 1; newIndex <= newLines.length; newIndex++) current[newIndex] = oldLines[oldIndex - 1] === newLines[newIndex - 1] ? previous[newIndex - 1] + 1 : Math.max(previous[newIndex], current[newIndex - 1]);
      previous = current;
    }
    const unchanged = previous[newLines.length];
    return { added: newLines.length - unchanged, removed: oldLines.length - unchanged };
  }
  let start = 0; while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length - 1; let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) { oldEnd--; newEnd--; }
  return { added: Math.max(0, newEnd - start + 1), removed: Math.max(0, oldEnd - start + 1) };
}
function recordTaskFile(file, checkpoint, stats, state = {}) {
  if (!activeTaskUi) return;
  const existing = activeTaskUi.files.find(item => item.path === file);
  if (existing) Object.assign(existing, { ...stats, ...state });
  else activeTaskUi.files.push({ path: file, snapshot: checkpoint.snapshot, existed: checkpoint.existed, ...stats, ...state });
  activeTaskUi.canRestore ||= Boolean(checkpoint); postUi('taskUi', activeTaskUi);
}
function recordTaskCheck(command, result) {
  if (!activeTaskUi) return;
  activeTaskUi.checks.push({ command: truncate(command, 180), passed: !testFailed(result), result: truncate(result, 600) }); postUi('taskUi', activeTaskUi);
}
function createActiveAbortController() { const controller = new AbortController(); activeAbortControllers.add(controller); return controller; }
function releaseActiveAbortController(controller) { activeAbortControllers.delete(controller); }
function throwIfCancelled() { if (cancelled) throw Object.assign(new Error('Stopped by user.'), { name: 'AbortError' }); }
function stopProcessTree(child = activeChild) { if (!child?.pid) return; if (process.platform === 'win32') cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); else child.kill('SIGTERM'); }
function requestStop() { cancelled = true; for (const controller of activeAbortControllers) controller.abort(); stopProcessTree(); log('Stop requested: aborting active Ollama and worker requests.'); }
function saveState() { return chatStore.save(); }
async function ensureWorkspaceState() { const previous = chatStore.stateFile; await chatStore.ensureWorkspace(); if (previous !== chatStore.stateFile) chatProvider?.replay(); }
function postChat(kind, text, display = true, id = messageId(), attachments = [], replyTo, createdAt = new Date().toISOString()) {
  const event = chatStore.append(kind, text, { id, attachments, replyTo, createdAt });
  if (display) postUi('message', event);
}
function rememberUser(contextText, visibleText = contextText, alreadyVisible = false, id, attachments = [], replyTo) { const event = chatStore.rememberUser(contextText, visibleText, id, attachments, replyTo); if (!alreadyVisible) postUi('message', event); return event; }
function rememberAssistant(text, id = messageId(), createdAt) { const event = chatStore.rememberAssistant(text, id, createdAt, activeWebSources); postUi('message', event); }
function deleteChatMessage(id) {
  if (chatStore.remove(id)) postUi('messageDeleted', { id });
}
function replaceChatBranch(id) {
  const message = chatStore.history.find(event => event.id === id);
  if (!message || message.kind !== 'user') return false;
  if (!chatStore.removeFrom(id).length) return false;
  return true;
}
async function saveResource(resource) {
  const workspace = root();
  if (!workspace) throw new Error('Open a folder workspace before adding resources.');
  const name = path.basename(String(resource.name || 'resource')).replace(/[^a-z0-9._-]/gi, '_').slice(0, 120) || 'resource';
  const data = Buffer.from(String(resource.data || ''), 'base64');
  if (!data.length || data.length > 12 * 1024 * 1024) throw new Error('Resource must be between 1 byte and 12 MB.');
  const directory = path.join(workspace, '.ollama-agent', 'resources');
  const target = path.join(directory, `${Date.now()}-${name}`);
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(target, data);
  if (cancelledResourceClients.delete(resource.clientId)) { await fsp.unlink(target).catch(() => undefined); return; }
  const item = { clientId: resource.clientId, path: path.relative(workspace, target).replace(/\\/g, '/'), name, mime: String(resource.mime || 'application/octet-stream'), data: String(resource.data || '') };
  pendingResources.push(item);
  log(`Attached resource: ${item.path} (${data.length} bytes)`);
  postUi('resourceSaved', { clientId: resource.clientId, name: item.name, path: item.path, mime: item.mime });
}
async function cancelResource(clientId) {
  const id = String(clientId || ''); if (!id) return;
  cancelledResourceClients.add(id);
  const index = pendingResources.findIndex(item => item.clientId === id);
  if (index < 0) return;
  const [item] = pendingResources.splice(index, 1); const workspace = root();
  if (workspace && item.path) await fsp.unlink(path.join(workspace, item.path)).catch(() => undefined);
}
function config() { return vscode.workspace.getConfiguration('ollamaOffline'); }
function endpointBase() { return ollama.endpoint(); }
function endpointIsLocal(value = endpointBase()) { return isLocalEndpoint(value); }
function commandExists(command) {
  const probeShell = process.platform === 'android' ? (process.env.SHELL || '/system/bin/sh') : '/bin/sh';
  const probe = process.platform === 'win32'
    ? cp.spawnSync('where.exe', [command], { windowsHide: true, stdio: 'ignore' })
    : cp.spawnSync(probeShell, ['-lc', `command -v -- ${command}`], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}
function resolveWindowsCommandShell() {
  if (process.platform !== 'win32') return undefined;
  for (const command of ['pwsh.exe', 'powershell.exe']) {
    const probe = cp.spawnSync('where.exe', [command], { windowsHide: true, encoding: 'utf8' });
    const candidate = String(probe.stdout || '').split(/\r?\n/).map(value => value.trim()).find(value => value && fs.existsSync(value));
    if (candidate) return { executable: candidate, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'], label: path.basename(candidate) };
  }
  const commandPrompt = String(process.env.ComSpec || '').trim();
  if (commandPrompt && fs.existsSync(commandPrompt)) return { executable: commandPrompt, args: ['/d', '/s', '/c'], label: path.basename(commandPrompt) };
  return undefined;
}
function isExecutableFile(candidate) {
  if (!candidate) return false;
  try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
}
function resolvePosixCommandShell() {
  const candidates = process.platform === 'android'
    ? [process.env.SHELL, '/system/bin/sh', '/bin/sh']
    : [process.env.SHELL, '/bin/sh', '/usr/bin/sh', '/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/zsh'];
  const executable = [...new Set(candidates.filter(Boolean).map(value => path.resolve(value)))].find(isExecutableFile);
  return executable ? { executable, args: ['-lc'], label: path.basename(executable) } : undefined;
}
function detectExecutionEnvironment() {
  const platformNames = { win32: 'Windows', darwin: 'macOS', linux: 'Linux', android: 'Android' };
  const runner = process.platform === 'win32' ? resolveWindowsCommandShell() : resolvePosixCommandShell();
  const profileKey = process.platform === 'win32' ? 'defaultProfile.windows' : process.platform === 'darwin' ? 'defaultProfile.osx' : 'defaultProfile.linux';
  const configuredProfile = vscode.workspace.getConfiguration('terminal.integrated').get(profileKey) || 'not configured';
  const installed = ['git', 'node', 'python', 'python3', 'pwsh', 'powershell', 'bash', 'zsh', 'sh', 'cmd'].filter(commandExists);
  const remote = vscode.env.remoteName ? `VS Code remote host: ${vscode.env.remoteName}` : 'VS Code local host';
  const shellCandidates = process.platform === 'win32'
    ? ['pwsh.exe', 'powershell.exe', String(process.env.ComSpec || '').trim()].filter(Boolean)
    : (process.platform === 'android' ? [process.env.SHELL, '/system/bin/sh', '/bin/sh'] : [process.env.SHELL, '/bin/sh', '/usr/bin/sh', '/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/zsh']).filter(Boolean);
  return { platform: platformNames[process.platform] || process.platform, runner, configuredProfile, installed, remote, shellCandidates: [...new Set(shellCandidates)] };
}
function detectedEnvironment() {
  if (!executionEnvironment) executionEnvironment = detectExecutionEnvironment();
  return executionEnvironment;
}
function describeExecutionEnvironment() {
  if (environmentDescription) return environmentDescription;
  const detected = detectedEnvironment();
  const runner = detected.runner ? `${detected.runner.label} (${detected.runner.executable})` : 'no usable command shell';
  environmentDescription = `Execution environment (authoritative, do not probe shell syntax first): ${detected.remote}; extension host OS: ${detected.platform} (${process.platform}, ${process.arch}, ${process.release.name || 'Node'} ${process.version}); run_command executes through detected ${runner}; configured VS Code integrated-terminal profile: ${detected.configuredProfile}; shell candidates: ${detected.shellCandidates.join(', ') || 'none detected'}. Detected command-line programs: ${detected.installed.join(', ') || 'none detected'}. Use commands and path syntax for this extension-host OS. The visible VS Code client may be on another device; it is not the command execution environment.`;
  return environmentDescription;
}
function languageInstruction() { const language = config().get('language', 'auto'); return language === 'auto' ? 'Reply in the language of the newest user message.' : `Reply in language code ${language}.`; }
let skillsDir;
function root() { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; }
function systemAccess() { return config().get('accessMode') !== 'workspace'; }
function guardedSystem() { return config().get('accessMode') === 'guardedSystem'; }
function fullSystem() { return config().get('accessMode') === 'fullSystem'; }
function isWorkspaceTarget(target) {
  const workspace = root(); if (!workspace || !target) return false;
  const relative = path.relative(workspace, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  try {
    const realWorkspace = fs.realpathSync.native(workspace); let probe = target;
    while (!fs.existsSync(probe)) { const parent = path.dirname(probe); if (parent === probe) break; probe = parent; }
    const realProbe = fs.realpathSync.native(probe); const prefix = realWorkspace.endsWith(path.sep) ? realWorkspace : realWorkspace + path.sep;
    return realProbe === realWorkspace || realProbe.startsWith(prefix);
  } catch { return false; }
}
function canAutonomouslyMutateWorkspace(target) { return fullSystem() && isWorkspaceTarget(target) && !isSensitiveTarget(target) && !matchesProtected(target); }
function resolveTarget(input) {
  const base = root();
  if (!base) throw new Error('Open a folder workspace before using the agent.');
  const candidate = path.resolve(path.isAbsolute(input || '') && systemAccess() ? input : base, path.isAbsolute(input || '') && systemAccess() ? '.' : (input || '.'));
  if (systemAccess()) return candidate;
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (candidate !== base && !candidate.startsWith(prefix)) throw new Error('Path is outside the workspace.');
  // Resolve the nearest existing parent to prevent a workspace symlink from
  // silently redirecting reads or writes outside the workspace.
  const realBase = fs.realpathSync.native(base); let probe = candidate;
  while (!fs.existsSync(probe)) { const parent = path.dirname(probe); if (parent === probe) break; probe = parent; }
  const realProbe = fs.realpathSync.native(probe);
  const realPrefix = realBase.endsWith(path.sep) ? realBase : realBase + path.sep;
  if (realProbe !== realBase && !realProbe.startsWith(realPrefix)) throw new Error('Path resolves outside the workspace through a symlink.');
  return candidate;
}
function isAgentInternal(target) { const workspace = root(); return Boolean(workspace) && (target === path.join(workspace, '.ollama-agent') || target.startsWith(path.join(workspace, '.ollama-agent') + path.sep)); }
function isSensitiveTarget(target) { const name = path.basename(target).toLowerCase(); return /^(\.env(?:\..*)?|id_(rsa|ed25519|ecdsa)|known_hosts|authorized_keys|credentials(?:\.json)?|.*\.(pem|pfx|p12|key))$/.test(name); }
function matchesProtected(target) {
  const normal = path.resolve(target).replace(/\\/g, '/').toLowerCase();
  return config().get('protectedPaths', []).some(pattern => {
    const escaped = String(pattern).replace(/\\/g, '/').toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+');
    return new RegExp('^' + escaped + '(?:/|$)').test(normal);
  });
}
function rejectDangerousCommand(command) {
  const lower = command.toLowerCase();
  if (/(?:\bformat\b|\bdiskpart\b|\bclear-disk\b|\breg\s+delete\b|\bshutdown\b|\bstop-computer\b|\brestart-computer\b|\bremove-item\b[^\n]*-recurse|\brmdir\b[^\n]*\/s|\bdel\b[^\n]*\/s|\bencodedcommand\b|\binvoke-expression\b|\biex\s*\()/i.test(lower)) return 'Blocked by guardrail: destructive or obfuscated system command.';
  if (!fullSystem() && config().get('protectedPaths', []).some(p => lower.includes(String(p).replace('*', '').toLowerCase()))) return 'Blocked by guardrail: command references a protected path.';
  return null;
}
function isPrivateWebHost(host) { const value = String(host || '').toLowerCase(); if (!value || value === 'localhost' || value.endsWith('.local') || value === '::1') return true; const parts = value.split('.').map(Number); if (parts.length !== 4 || parts.some(Number.isNaN)) return false; return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127); }
function safeWebUrl(value) { const url = new URL(String(value || '')); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isPrivateWebHost(url.hostname)) throw new Error('Only public HTTP(S) web addresses are allowed.'); return url; }
function webEnabled() { return config().get('webEnabled', true); }
function configuredWorkers() { return normalizeWorkers(config().get('workers', [])); }
async function setWorkers(value, tokens = {}) {
  const previous = configuredWorkers(); const next = normalizeWorkers(value);
  await config().update('workers', next, vscode.ConfigurationTarget.Global);
  await Promise.all(previous.filter(worker => !next.some(item => item.id === worker.id)).map(worker => extensionSecrets.delete(workerTokenKey(worker.id))));
  await Promise.all(next.map(worker => typeof tokens[worker.id] === 'string' && tokens[worker.id].trim() ? extensionSecrets.store(workerTokenKey(worker.id), tokens[worker.id].trim()) : undefined));
  await publishSettings();
}
async function setWorkerToken(id, value, clearToken) {
  if (!configuredWorkers().some(worker => worker.id === id)) return;
  const token = String(value || '').trim();
  if (token) await extensionSecrets.store(workerTokenKey(id), token);
  else if (clearToken) await extensionSecrets.delete(workerTokenKey(id));
  await publishSettings();
}
async function postWorkerModels(id, client) {
  try { postUi('workerModels', { id, models: await client.listModels() }); }
  catch (error) { postUi('workerModels', { id, models: [], error: String(error.message || error) }); }
}
async function loadWorkerModels(id) {
  const worker = configuredWorkers().find(item => item.id === id);
  if (!worker) return;
  await postWorkerModels(id, workerPool.client(worker));
}
async function probeWorkerModels(id, endpoint, token) {
  let parsed;
  try { parsed = new URL(String(endpoint || '').trim()); }
  catch { return postUi('workerModels', { id, models: [], error: 'Enter a valid worker endpoint URL first.' }); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return postUi('workerModels', { id, models: [], error: 'Worker endpoint must be an HTTP(S) URL without embedded credentials.' });
  const client = new OllamaClient({ getEndpoint: () => normalizeEndpoint(parsed.toString()), getAuthorization: () => String(token || '').trim() ? `Bearer ${String(token).trim()}` : '' });
  await postWorkerModels(id, client);
}
async function checkWorkers({ benchmark = false } = {}) {
  const needsBenchmark = configuredWorkers().some(worker => workerBenchmarks.get(worker.id)?.key !== `${worker.endpoint}|${worker.model}`);
  const health = await workerPool.health({ benchmark: benchmark || needsBenchmark });
  for (const worker of health) {
    if (!worker.profile) continue;
    const key = `${worker.endpoint}|${worker.model}`;
    if (benchmark && worker.profile.benchmark) workerBenchmarks.set(worker.id, { key, benchmark: worker.profile.benchmark });
    const cached = workerBenchmarks.get(worker.id);
    if (!worker.profile.benchmark && cached?.key === key) worker.profile.benchmark = cached.benchmark;
  }
  for (const worker of health) { const profile = worker.profile; const speed = profile?.benchmark?.tokensPerSecond ? `, ${profile.benchmark.tokensPerSecond} tok/s` : ''; const capabilities = profile?.capabilities?.length ? `, ${profile.capabilities.join('/')}` : ''; const context = profile?.contextLength ? `, ${Math.round(profile.contextLength / 1024)}K context` : ''; log(`Worker ${worker.name} (${worker.endpoint}): ${worker.status}${worker.version ? `, Ollama ${worker.version}` : worker.error ? ` (${worker.error})` : ''}${capabilities}${context}${speed}${worker.profileError ? ` (profile: ${worker.profileError})` : ''}`); }
  postUi('workerHealth', { workers: health });
  return health;
}
async function autodetectWorkers() {
  if (workerDiscoveryController) { workerDiscoveryController.abort(); return; }
  const controller = createActiveAbortController(); workerDiscoveryController = controller; postUi('workerDiscovery', { working: true }); output.show(true); log('Worker autodetect started: scanning small active private IPv4 networks.');
  try {
    const hosts = await discoverOllamaHosts({}, controller.signal, log);
    const existing = configuredWorkers(); const existingEndpoints = new Set(existing.map(worker => normalizeEndpoint(worker.endpoint))); const additions = []; const discoveredModels = new Map();
    for (const host of hosts) {
      if (controller.signal.aborted) throw Object.assign(new Error('Worker discovery stopped by user.'), { name: 'AbortError' });
      if (existing.length + additions.length >= 8) { log('Discovery found additional Ollama hosts, but the worker limit (8) has been reached.'); break; }
      const endpoint = `http://${host.ip}:11434`; if (existingEndpoints.has(endpoint)) continue;
      try {
        const models = await new OllamaClient({ getEndpoint: () => endpoint, getAuthorization: () => '' }).listModels(controller.signal);
        const model = models[0]?.name;
        if (!model) { log(`Discovery found Ollama on ${host.ip}, but it has no installed models; it was not added as a worker.`); continue; }
        const id = `worker-${messageId()}`;
        additions.push({ id, name: host.hostname || `Ollama ${host.ip}`, endpoint, model, enabled: true }); discoveredModels.set(id, models); existingEndpoints.add(endpoint);
      } catch (error) { if (controller.signal.aborted) throw Object.assign(new Error('Worker discovery stopped by user.'), { name: 'AbortError' }); log(`Discovery found ${host.ip}, but its models could not be read: ${error.message}.`); }
    }
    if (additions.length) { await setWorkers([...existing, ...additions]); for (const worker of additions) postUi('workerModels', { id: worker.id, models: discoveredModels.get(worker.id) || [] }); await checkWorkers(); vscode.window.showInformationMessage(`Autodetect added ${additions.length} Ollama worker${additions.length === 1 ? '' : 's'}.`); }
    else vscode.window.showInformationMessage(hosts.length ? 'Ollama was found, but no new worker with an installed model could be added.' : 'No local Ollama workers were found.');
  } catch (error) {
    if (error.name === 'AbortError') { log('Worker autodetect stopped by user.'); vscode.window.showInformationMessage('Worker autodetect stopped.'); }
    else { log(`Worker autodetect failed: ${error.stack || error.message}`); vscode.window.showErrorMessage(`Worker autodetect failed: ${error.message}`); }
  } finally { releaseActiveAbortController(controller); if (workerDiscoveryController === controller) workerDiscoveryController = undefined; postUi('workerDiscovery', { working: false }); }
}
function workerFindingsContext(results) {
  const completed = results.filter(workerResultUsable);
  if (!completed.length) return '';
  return `\n\nDelegated expert findings. Treat them as leads, not automatically as evidence. Validate relevant local files before acting. For every external factual claim, check that the cited source is authoritative for that exact subject: specifications/standards bodies for protocol behavior, official project docs or registry metadata for package facts, and official publishers/registers for legal or service facts. A vendor blog supports its own claims but not universal protocol semantics. For time-sensitive facts (versions, dates, prices, laws, availability, current service status), state them as facts only when a worker report includes an exact, authoritative URL that supports the exact claim, or when you independently fetch such a source. A search-result snippet, model memory, or a secondary summary is not verification; otherwise qualify the claim as unverified or omit it. Present REST/GraphQL-style tradeoffs as conditional analysis with assumptions, never as absolute rules. Use read_chat_messages with a report ID only when you need details omitted below:\n${completed.map(item => `\n[${item.worker.name} — ${item.role || 'specialist'} — report ${item.reportId}; assigned: ${item.task}]\n${truncate(item.text, 8000)}`).join('\n')}`;
}
function workerDispatchContext(results) {
  const failed = results.filter(item => !workerResultUsable(item));
  if (!failed.length) return '';
  return '\n\nWorker dispatch failures: ' + failed.map(item => item.worker.name + ' (' + (item.role || 'specialist') + '): ' + item.error).join('; ') + '. These assignments did not produce reports; do not describe them as missing, completed, or evidence.';
}
function rememberWorkerReports(results) {
  for (const result of results) {
    if (!workerResultUsable(result)) continue;
    const text = `# Expert worker report\n\nWorker: ${result.worker.name}\nRole: ${result.role || 'specialist'}\nAssignment: ${result.task || ''}\n\n${truncate(result.text, 32000)}`;
    result.reportId = chatStore.append('worker', text, { internal: true }).id;
  }
}
const workerRequirementNames = new Set(['chat_history', 'project_files', 'public_web', 'tool_calling', 'vision', 'context_8k', 'context_32k', 'context_64k', 'fast_inference']);
function workerRuntimeCapabilities(worker) { const profile = worker.profile || {}; const modelCapabilities = new Set((profile.capabilities || []).map(value => String(value).toLowerCase())); const capabilities = new Set(['chat_history', 'project_files']); if (webEnabled()) capabilities.add('public_web'); if (modelCapabilities.has('tools')) capabilities.add('tool_calling'); if (modelCapabilities.has('vision')) capabilities.add('vision'); const context = Number(profile.contextLength || 0); if (context >= 8192) capabilities.add('context_8k'); if (context >= 32768) capabilities.add('context_32k'); if (context >= 65536) capabilities.add('context_64k'); if (Number(profile.benchmark?.tokensPerSecond || 0) >= 12) capabilities.add('fast_inference'); return capabilities; }
function workerModelVariants(worker) {
  const configured = (worker.modelProfiles || []).find(item => item.name === worker.model);
  const variants = [{ name: worker.model, profile: worker.profile, size: Number(configured?.size || 0) }];
  for (const item of worker.modelProfiles || []) if (item.profile && !variants.some(variant => variant.name === item.name)) variants.push({ name: item.name, profile: item.profile, size: Number(item.size || 0) });
  return variants.map(variant => ({ ...worker, model: variant.name, profile: variant.profile, modelSize: variant.size }));
}
function workerModelScore(worker, requirements = []) {
  const profile = worker.profile || {}; const capabilities = workerRuntimeCapabilities(worker); const context = Number(profile.contextLength || 0); const speed = Number(profile.benchmark?.tokensPerSecond || 0);
  return requirements.length * 1000 + capabilities.size * 100 + Math.min(context / 1024, 999) + Math.min(speed, 99);
}
function preferredWorkerModel(worker, requirements = []) {
  const variants = workerModelVariants(worker); const configured = variants.find(variant => variant.model === worker.model);
  // The configured model is an explicit user choice. Keep it whenever it can
  // perform the assignment; probing a larger alternative can be slow or OOM.
  if (configured && workerSupportsRequirements(configured, requirements)) return configured;
  const configuredSize = Number(configured?.modelSize || 0);
  // A fallback model is allowed only when its profile is known and its stored
  // size is no greater than the user's configured model. This is deliberately
  // conservative: never auto-load an unknown, larger, or cloud-sized model.
  return variants.filter(variant => workerSupportsRequirements(variant, requirements)).filter(variant => configuredSize > 0 && variant.modelSize > 0 && variant.modelSize <= configuredSize).sort((left, right) => workerModelScore(right, requirements) - workerModelScore(left, requirements) || left.model.localeCompare(right.model))[0];
}
function workerCapabilityDescription(worker) { const selected = preferredWorkerModel(worker, []) || worker; const profile = selected.profile || {}; const capabilities = [...workerRuntimeCapabilities(selected)].join(', ') || 'none'; const speed = profile.benchmark?.tokensPerSecond ? `${profile.benchmark.tokensPerSecond} tok/s` : 'unmeasured'; const alternateModels = workerModelVariants(worker).map(variant => variant.model).join(', '); return `${capabilities}; context: ${profile.contextLength || 'unknown'} tokens; speed: ${speed}; selected model: ${selected.model}; installed model profiles: ${alternateModels || 'unknown'}`.trim(); }
function workerSupportsRequirements(worker, requirements) { const capabilities = workerRuntimeCapabilities(worker); return requirements.every(requirement => capabilities.has(requirement)); }
function readOnlyWorkerViolation(task) {
  const text = String(task || '');
  const patterns = [
    /\b(?:run|execute|launch|invoke)\b[\s\S]{0,48}\b(?:command|shell|terminal|bandit|ruff|pytest|tests?|lint|build|compile|pip|npm|git)\b/i,
    /\b(?:install|uninstall|write|create|modify|edit|delete|rename|move)\b[\s\S]{0,48}\b(?:files?|code|scripts?|scanner|skills?|playbook|packages?|dependenc)/i,
    /\b(?:git\s+(?:commit|push|pull|checkout|merge)|npm\s+(?:install|test|run)|pip\s+install)\b/i
  ];
  return patterns.find(pattern => pattern.test(text))?.source;
}
function workerSupportsAssignment(worker, assignment) { return Boolean(worker) && Boolean(preferredWorkerModel(worker, assignment.requires || [])) && !readOnlyWorkerViolation(assignment.task); }
function workerRuntimeForAssignment(worker, assignment) {
  if (!worker || worker.status !== 'available' || readOnlyWorkerViolation(assignment.task)) return undefined;
  return preferredWorkerModel(worker, assignment.requires || []);
}
function assignmentResult(results, workerId) {
  return results.find(result => (result.retryOf || result.worker.id) === workerId && workerResultUsable(result)) || results.find(result => (result.retryOf || result.worker.id) === workerId);
}
function workerResultUsable(result) {
  if (!result?.text || result.error || result.quality?.accepted === false) return false;
  return !/\b(?:i\s+(?:cannot|can't|am unable to)|unable to (?:complete|perform)|no (?:shell|write|command|tool) capability|cannot complete)\b/i.test(String(result.text));
}
function fallbackWorkerPlan(workers, maxTasks) {
  const specialities = [
    ['primary task analyst', 'Address the user-requested criteria directly. Inspect only relevant workspace context, then synthesize risks, compatibility, implementation, and validation considerations. Do not substitute a generic workspace inventory for the requested analysis.', ['chat_history', 'project_files', 'tool_calling']],
    ['test and quality specialist', 'Inspect existing tests and likely verification path. Identify edge cases and specific tests the master should run or add; do not run tests yourself.', ['project_files', 'tool_calling']],
    ['security reviewer', 'Review relevant implementation and configuration paths for security, privacy, reliability, and compatibility risks. Report only evidence-backed findings.', ['project_files', 'tool_calling']],
    ['domain researcher', 'Search relevant chat history and authoritative public sources for requirements, constraints, APIs, or domain facts needed for this task.', ['chat_history', 'public_web', 'tool_calling']]
  ];
  const assignments = workers.slice(0, maxTasks).map((worker, index) => ({ workerId: worker.id, role: specialities[index % specialities.length][0], task: specialities[index % specialities.length][1], requires: specialities[index % specialities.length][2], dependsOn: [] })).filter(item => workerSupportsAssignment(workers.find(worker => worker.id === item.workerId), item));
  return { masterFocus: 'Own implementation, integration, and validation. Use delegated evidence to avoid repeating independent research.', assignments, delegationReason: assignments.length ? 'Fallback plan for a complex task.' : 'No worker has the tool and runtime capabilities required for a safe fallback assignment.' };
}
function hasDependencyCycle(assignments) {
  const map = new Map(assignments.map(item => [item.workerId, item.dependsOn || []]));
  const visiting = new Set(); const visited = new Set();
  const visit = id => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const cycle = (map.get(id) || []).some(visit);
    visiting.delete(id); visited.add(id);
    return cycle;
  };
  return [...map.keys()].some(visit);
}
function parseDelegationPlan(content, workers, maxTasks) {
  const text = String(content || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim(); const candidate = text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return undefined;
  try {
    const value = JSON.parse(candidate); const allowed = new Set(workers.map(worker => worker.id)); const used = new Set();
    const delegationReason = truncate(String(value.delegationReason || '').trim(), 500);
    if (value.delegate === false) return { masterFocus: truncate(String(value.masterFocus || 'Answer directly without worker delegation.').trim(), 1200), assignments: [], delegationReason: delegationReason || 'The task is small or does not benefit from independent research.' };
    const assignments = (Array.isArray(value.assignments) ? value.assignments : []).map(item => ({ workerId: String(item.workerId || ''), role: String(item.role || 'specialist').trim(), task: String(item.task || '').trim(), requires: Array.isArray(item.requires) ? item.requires.map(capability => String(capability || '').trim()).filter(Boolean) : [], dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(id => String(id)).filter(id => allowed.has(id) && id !== String(item.workerId || '')) : [] })).filter(item => allowed.has(item.workerId) && !used.has(item.workerId) && item.task && item.requires.length && item.requires.every(capability => workerRequirementNames.has(capability)) && workerSupportsAssignment(workers.find(worker => worker.id === item.workerId), item)).filter(item => (used.add(item.workerId), true)).slice(0, maxTasks);
    if (!assignments.length || hasDependencyCycle(assignments)) return undefined;
    return { masterFocus: truncate(String(value.masterFocus || 'Implement, integrate, and validate the requested change.').trim(), 1200), assignments, delegationReason: delegationReason || 'Independent expert research is useful for this task.' };
  } catch { return undefined; }
}
async function dispatchWorkerPlan(task, health, plan, lastAssistant, signal) {
  const pending = new Map(plan.assignments.map(item => [item.workerId, item]));
  const results = [];
  const retryAttempts = new Set();
  const compatibleRetryWorkers = (assignment, excluded = new Set()) => health
    .filter(worker => !excluded.has(worker.id))
    .map(worker => workerRuntimeForAssignment(worker, assignment))
    .filter(Boolean)
    .sort((left, right) => workerSpeed(right) - workerSpeed(left) || left.name.localeCompare(right.name));
  const runtimeHealth = (assignments) => {
    const assignmentByWorker = new Map(assignments.map(assignment => [assignment.workerId, assignment]));
    return health.map(worker => {
      const assignment = assignmentByWorker.get(worker.id);
      return assignment ? (workerRuntimeForAssignment(worker, assignment) || { ...worker, status: 'unavailable', error: 'No safe compatible installed model for this assignment.' }) : worker;
    });
  };
  const retryAssignment = async (assignment, failedResult) => {
    const attempted = new Set([assignment.workerId]);
    for (const worker of compatibleRetryWorkers(assignment, attempted)) {
      const key = `${assignment.workerId}\n${worker.id}`; if (retryAttempts.has(key)) continue;
      retryAttempts.add(key); attempted.add(worker.id);
      log(`Retrying ${assignment.role} on compatible worker ${worker.name} (${worker.model}) after ${failedResult.worker.name} did not produce a usable report.`);
      updateTaskUi('research', 'active', `Retrying ${assignment.role} on ${worker.name}.`);
      updateTaskWorkers(1, plan.assignments.length);
      let retry;
      const retryAssignment = { ...assignment, workerId: worker.id };
      try { retry = await workerPool.delegate(task, { health: runtimeHealth([retryAssignment]), assignments: [retryAssignment], initialMessages: lastAssistant ? [lastAssistant] : [], tools: workerTools, extractCalls, executeTool: executeWorkerTool, signal }); }
      finally { updateTaskWorkers(0, plan.assignments.length); }
      const result = retry.results[0];
      if (!result) continue;
      result.retryOf = assignment.workerId; results.push(result);
      if (workerResultUsable(result)) return result;
    }
    return undefined;
  };
  while (pending.size) {
    const ready = [...pending.values()].filter(item => (item.dependsOn || []).every(id => workerResultUsable(assignmentResult(results, id))));
    if (!ready.length) throw new Error('Worker dependency plan contains an unresolved cycle.');
    const assignments = ready.map(item => {
      const dependencies = (item.dependsOn || []).map(id => assignmentResult(results, id)).filter(workerResultUsable);
      let remaining = 12000;
      const context = dependencies.length ? '\n\nCompleted dependency reports are available for this subtask. Reuse only relevant findings and validate them:\n' + dependencies.map(result => { const excerpt = truncate(result.text, Math.min(8000, remaining)); remaining -= excerpt.length; return '[' + result.worker.name + ' — ' + result.role + ']\n' + excerpt; }).join('\n\n') : '';
      return { ...item, task: item.task + context };
    });
    throwIfCancelled();
    const selectedHealth = runtimeHealth(assignments);
    for (const assignment of assignments) {
      const configured = health.find(worker => worker.id === assignment.workerId);
      const selected = selectedHealth.find(worker => worker.id === assignment.workerId);
      if (configured && selected?.status === 'available' && selected.model !== configured.model) log(`Selected safe compatible model ${selected.model} instead of ${configured.model} for ${assignment.role}.`);
      if (selected?.status !== 'available') throw new Error(`No safe compatible model is available on worker ${configured?.name || assignment.workerId} for ${assignment.role}. Add or enable a suitable worker, then retry.`);
    }
    updateTaskWorkers(assignments.length, plan.assignments.length);
    let dispatch;
    try { dispatch = await workerPool.delegate(task, { health: selectedHealth, assignments, initialMessages: lastAssistant ? [lastAssistant] : [], tools: workerTools, extractCalls, executeTool: executeWorkerTool, signal }); }
    finally { updateTaskWorkers(0, plan.assignments.length); }
    results.push(...dispatch.results);
    for (const item of ready) pending.delete(item.workerId);
    // Wait for the whole concurrent batch to settle before retrying. This keeps a
    // capable worker from being double-booked and never downgrades work to an
    // incompatible worker merely to keep the pipeline moving.
    for (const assignment of ready) {
      const result = dispatch.results.find(item => item.worker.id === assignment.workerId);
      if (workerResultUsable(result)) continue;
      // Preserve completed dependency findings when a dependent assignment is
      // retried on another worker.
      const dispatchedAssignment = assignments.find(item => item.workerId === assignment.workerId) || assignment;
      const replacement = await retryAssignment(dispatchedAssignment, result || { worker: { name: 'the assigned worker' } });
      if (!workerResultUsable(replacement)) {
        const requirements = (assignment.requires || []).join(', ') || 'read-only project analysis';
        throw new Error(`No compatible worker could complete the ${assignment.role} assignment after ${result?.worker?.name || 'the assigned worker'} failed or declined. Required capabilities: ${requirements}. Add or enable a suitable worker, then retry.`);
      }
    }
  }
  return { health, results };
}
async function planWorkerAssignments(task, workers, lastAssistant, lastUser, maxTasks, masterSession) {
  const fallback = fallbackWorkerPlan(workers, maxTasks);
  const roster = workers.map(worker => `- id: ${worker.id}; name: ${worker.name}; model: ${worker.model}; runtime profile: ${workerCapabilityDescription(worker)}`).join('\n');
  const plannerSystem = `You are the delegation planner for a coding-agent master. Produce distinct expert research assignments for available read-only workers. The master alone writes files, runs commands, installs tools, integrates changes, and tests. Give each worker a non-overlapping specialty and a concrete subtask relevant to the user's request. A worker task must be analytical and read-only: never ask it to run or invoke bandit, ruff, pytest, tests, a shell, a terminal, Git, npm, pip, build tools, installers, or to create/edit/delete files, scanners, skills, or playbooks. Ask it to inspect evidence and report what the master should run or change. Never assign image analysis without vision, tool-dependent research without tool_calling, large source/context analysis without an adequate context requirement, or latency-sensitive/long-running work without fast_inference. Write masterFocus, role, task, and requires in English so every worker receives an English assignment while preserving all user constraints. requires must contain every capability needed, selected only from: ${[...workerRequirementNames].join(', ')}. Return only JSON: {"masterFocus":"...","assignments":[{"workerId":"...","role":"...","task":"...","requires":["project_files","tool_calling"]}]}. Use at most one assignment per worker. Available workers:\n${roster}`;
  const plannerGraph = ' First decide whether delegation is worthwhile. For a direct, narrow, or low-risk task return delegate:false, a short delegationReason, and no assignments. Otherwise return delegate:true, a short delegationReason, and no more than ' + maxTasks + ' assignments. An explicit user maximum is an upper bound, not a requirement to use that many workers. When there are fewer workers than explicitly requested expert topics, consolidate those requested topics into the available worker assignments instead of substituting generic roles. Each assignment may include dependsOn as an array of earlier workerId values. Use dependencies only when the later expert genuinely needs the earlier report. Dependencies must form an acyclic graph.';
  try {
    const priorRequest = lastUser ? `\n\nCandidate previous user request: ${truncate(lastUser.content, 4000)}\nUse it only if it clarifies the newest task.` : '';
    const response = await chatWithMasterFailover([{ role: 'system', content: plannerSystem + plannerGraph + priorRequest }, ...(lastAssistant ? [lastAssistant] : []), { role: 'user', content: task }], undefined, [], masterSession);
    return parseDelegationPlan(response.message?.content, workers, maxTasks) || fallback;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    log(`Worker planner failed (${error.message}); using distinct fallback specialist roles.`);
    return fallback;
  }
}
async function fetchPublicWeb(url, limit = 180000) { const target = safeWebUrl(url); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000); try { const response = await fetch(target, { signal: controller.signal, redirect: 'error', headers: { Accept: 'text/html,text/plain;q=0.9', 'User-Agent': 'Ollama-Offline-Agent/1.0' } }); if (!response.ok) throw new Error(`HTTP ${response.status}`); const text = await response.text(); return truncate(text, limit); } finally { clearTimeout(timer); } }
function webText(html) { return String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim(); }
async function rememberWebSource(url, title) { try { const target = safeWebUrl(url); const existing = activeWebSources.find(item => item.url === target.toString()); if (existing) return existing; const source = { title: title || target.hostname, url: target.toString(), favicon: '' }; activeWebSources.push(source); try { const response = await fetch(new URL('/favicon.ico', target), { redirect: 'error', headers: { Accept: 'image/*', 'User-Agent': 'Ollama-Offline-Agent/1.0' } }); const data = Buffer.from(await response.arrayBuffer()); const type = response.headers.get('content-type') || 'image/x-icon'; if (response.ok && data.length && data.length <= 64 * 1024 && /^image\//i.test(type)) source.favicon = `data:${type};base64,${data.toString('base64')}`; } catch {} return source; } catch { return undefined; } }
async function webSearch(query, limit) { if (!webEnabled()) return 'Web access is disabled. The user can enable it with the Globe button.'; const text = String(query || '').trim(); if (!text) return 'Provide a search query.'; const address = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(text)}`; const html = await fetchPublicWeb(address); const results = []; const pattern = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a|class="result__snippet"[^>]*>([\s\S]*?)<\/div/gi; let match; while ((match = pattern.exec(html)) && results.length < Math.max(1, Math.min(10, Number(limit) || 5))) { const href = match[1]; const title = webText(match[2]); const snippet = webText(match[3] || match[4] || ''); if (href && title) results.push(`${title}\n${href}\n${snippet}`); } return results.length ? results.join('\n\n') : 'No search results were parsed.'; }
async function webFetch(url) { if (!webEnabled()) return 'Web access is disabled. The user can enable it with the Globe button.'; const target = safeWebUrl(url); const body = await fetchPublicWeb(target); await rememberWebSource(target, target.hostname); return truncate(webText(body), 14000); }
function truncate(value, limit = 14000) {
  const text = String(value ?? '');
  return text.length > limit ? text.slice(0, limit) + `\n[truncated at ${limit} characters]` : text;
}
function readFileContent(content, startLine, endLine, pattern, flags = '') {
  if (startLine === undefined && endLine === undefined && (pattern === undefined || pattern === '')) return truncate(content);
  const lines = String(content).split(/\r?\n/);
  const start = Math.max(1, Math.min(lines.length || 1, startLine === undefined ? 1 : Number(startLine) || 1));
  const end = Math.max(start, Math.min(lines.length || start, endLine === undefined ? lines.length : Number(endLine) || start));
  const selected = lines.slice(start - 1, end);
  if (pattern === undefined || pattern === '') return `[lines ${start}-${end} of ${lines.length}]\n${truncate(selected.join('\n'))}`;
  const expression = String(pattern);
  if (expression.length > 256 || /\((?:[^()]*[+*][^()]*)+\)[+*{]/.test(expression)) return 'Regex filter rejected: use a shorter expression without nested quantifiers.';
  let regex;
  try { regex = new RegExp(expression, String(flags || '').replace(/[^imsu]/g, '')); } catch (error) { return `Invalid regex filter: ${error.message}`; }
  const matches = selected.map((line, index) => ({ line, number: start + index })).filter(item => item.line.length <= 16000 && regex.test(item.line));
  return `[${matches.length} matching line${matches.length === 1 ? '' : 's'} in ${start}-${end} of ${lines.length} for /${expression}/${flags}]\n${truncate(matches.map(item => `${item.number}: ${item.line}`).join('\n') || '(no matches)')}`;
}
function writePreview(before, after) {
  const oldLines = String(before || '').split(/\r?\n/); const newLines = String(after || '').split(/\r?\n/); let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length - 1; let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) { oldEnd--; newEnd--; }
  const body = [`@@ lines ${start + 1} @@`, ...oldLines.slice(start, oldEnd + 1).map(line => `-${line}`), ...newLines.slice(start, newEnd + 1).map(line => `+${line}`)];
  return truncate(body.join('\n'), 6000);
}
async function createCheckpoint(target) {
  const workspace = root(); const directory = path.join(workspace, '.ollama-agent', 'checkpoints'); const stamp = `${Date.now()}-${path.basename(target).replace(/[^a-z0-9._-]/gi, '_')}`; const snapshot = path.join(directory, stamp);
  const existed = fs.existsSync(target); await fsp.mkdir(directory, { recursive: true }); if (existed) await fsp.copyFile(target, snapshot);
  const record = { target, snapshot: existed ? snapshot : null, existed, createdAt: new Date().toISOString() };
  await fsp.writeFile(path.join(directory, 'last-change.json'), JSON.stringify(record), 'utf8'); return record;
}
async function rollbackLastChange() {
  const workspace = root(); const file = path.join(workspace, '.ollama-agent', 'checkpoints', 'last-change.json'); let record;
  try { record = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return 'No rollback checkpoint is available.'; }
  const answer = await vscode.window.showWarningMessage(`Restore the last agent change to ${record.target}?`, { modal: true }, 'Restore'); if (answer !== 'Restore') return 'User denied rollback.';
  if (record.existed) await fsp.copyFile(record.snapshot, record.target); else if (fs.existsSync(record.target)) await fsp.unlink(record.target);
  return `Restored ${record.target}.`;
}
async function openTaskFileDiff(relativePath) {
  const item = activeTaskUi?.files.find(file => file.path === relativePath);
  if (!item) return;
  const target = resolveTarget(relativePath);
  if (item.deleted) {
    if (!item.snapshot || !fs.existsSync(item.snapshot)) return vscode.window.showWarningMessage(`The deleted file snapshot is no longer available: ${relativePath}`);
    if (!await isGitRepository()) { const document = await vscode.workspace.openTextDocument(vscode.Uri.file(item.snapshot)); await vscode.window.showTextDocument(document, { preview: true }); return; }
    const empty = (await vscode.workspace.openTextDocument({ content: '', language: path.extname(relativePath).slice(1) || 'plaintext' })).uri;
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(item.snapshot), empty, `${relativePath} — Deleted by agent`);
    return;
  }
  if (!fs.existsSync(target)) return vscode.window.showWarningMessage(`The changed file is no longer available: ${relativePath}`);
  if (!await isGitRepository()) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(document, { preview: true });
    return;
  }
  let left;
  if (item.existed && item.snapshot && fs.existsSync(item.snapshot)) left = vscode.Uri.file(item.snapshot);
  else left = (await vscode.workspace.openTextDocument({ content: '', language: path.extname(relativePath).slice(1) || 'plaintext' })).uri;
  await vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(target), `${relativePath} — Agent changes`);
}
function historySearchTerms(value) { return String(value || '').toLocaleLowerCase('sk').normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9_]{2,}/g) || []; }
function searchChatHistory(query, limit) {
  const needle = String(query || '').trim().toLocaleLowerCase('sk'); const terms = [...new Set(historySearchTerms(needle))];
  if (!needle || !terms.length) return 'Provide a meaningful search query.';
  const matches = chatHistory.map((event, index) => {
    const text = String(event.text || ''); const comparable = text.toLocaleLowerCase('sk').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const score = (comparable.includes(needle.normalize('NFD').replace(/[\u0300-\u036f]/g, '')) ? 20 : 0) + terms.reduce((total, term) => total + (comparable.includes(term) ? 1 : 0), 0);
    return { event, index, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.index - a.index).slice(0, Math.max(1, Math.min(50, Number(limit) || 8)));
  return matches.length ? matches.map(({ event, score }) => `[${event.id}] ${event.kind} ${event.createdAt || ''} (relevance ${score})\n${truncate(event.text, 700)}`).join('\n\n') : '(no matching chat messages)';
}
function readChatMessages(ids) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(String)); if (!wanted.size) return 'Provide one or more chat message IDs.';
  const messages = chatHistory.filter(event => wanted.has(String(event.id)));
  const limit = messages.length === 1 && messages[0].internal && messages[0].kind === 'worker' ? 32000 : 14000;
  return messages.length ? truncate(messages.map(event => `[${event.id}] ${event.kind} ${event.createdAt || ''}\n${event.text}`).join('\n\n'), limit) : '(no matching chat messages)';
}
function latestAssistantContext() { return chatStore.latestAssistant(); }
function latestUserContext() { return chatStore.latestUser(); }
async function loadSkills(task) {
  if (!skillsDir) return '';
  try {
    // A playbook is opt-in. Injecting every saved instruction into every
    // request made unrelated, old procedures look like active user commands.
    if (!/\b(skill|skills|schopnos(?:ť|ti)|playbook|postup|návod)\b/i.test(String(task || ''))) return '';
    const names = (await fsp.readdir(skillsDir)).filter(name => name.endsWith('.md')).slice(0, 20);
    const items = await Promise.all(names.map(async name => `## Skill: ${name.slice(0, -3)}\n${truncate(await fsp.readFile(path.join(skillsDir, name), 'utf8'), 5000)}`));
    return items.length ? `\n\nReusable local skills:\n${items.join('\n\n')}` : '';
  } catch { return ''; }
}

const tools = [
  { type: 'function', function: { name: 'search_chat_history', description: 'Search the complete local chat history for relevant earlier messages. Use this before relying on prior conversation; then use read_chat_messages for exact content.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'A semantic search phrase for the needed prior topic or decision.' }, maxResults: { type: 'number', minimum: 1, maximum: 50, description: 'How many candidate messages to return.' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'read_chat_messages', description: 'Read exact earlier chat messages by IDs returned from search_chat_history. Request only messages relevant to the current task.', parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 } }, required: ['ids'] } } },
  { type: 'function', function: { name: 'list_files', description: 'List files recursively. Paths are workspace-relative; guarded system mode also permits absolute paths.', parameters: { type: 'object', properties: { directory: { type: 'string' } } } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 text file or an inclusive line range. Optionally filter the selected range by a regular expression and return matching numbered lines. This read-only tool never requires approval. Guarded system mode also permits absolute paths.', parameters: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number', minimum: 1, description: 'Optional first line, inclusive.' }, endLine: { type: 'number', minimum: 1, description: 'Optional last line, inclusive. Use with startLine for a focused excerpt.' }, pattern: { type: 'string', maxLength: 256, description: 'Optional safe regex filter applied one line at a time.' }, flags: { type: 'string', description: 'Optional regex flags: i, m, s, u.' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'search_text', description: 'Search literal text in text files.', parameters: { type: 'object', properties: { query: { type: 'string' }, directory: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the public web for current information. Available only when the user enables web access with the Globe button; private and LAN addresses are blocked.', parameters: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number', minimum: 1, maximum: 10 } }, required: ['query'] } } },
  { type: 'function', function: { name: 'web_fetch', description: 'Read a public HTTP(S) web page by URL. Available only when the user enables web access with the Globe button; private and LAN addresses are blocked.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or replace a UTF-8 text file. In Full system mode, project-local non-sensitive changes proceed without confirmation; other writes require user approval. Protected system paths are blocked.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'delete_file', description: 'Delete one file in the current workspace. Available only in Full system mode. Project-local non-sensitive deletions proceed without confirmation and retain a rollback checkpoint.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'rollback_last_change', description: 'Restore the most recent file change made by the agent from a local checkpoint. Requires user approval.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'run_command', description: 'Run a command. Requires user approval; destructive system commands are blocked. In system access modes cwd can be an absolute path. Full system mode also permits user-accessible local application installers.', parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'git_status', description: 'Read the current Git branch and working-tree status. No changes are made.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'git_diff', description: 'Read uncommitted Git changes, optionally staged changes. No changes are made.', parameters: { type: 'object', properties: { staged: { type: 'boolean' } } } } },
  { type: 'function', function: { name: 'git_log', description: 'Read recent Git commits. No changes are made.', parameters: { type: 'object', properties: { count: { type: 'number', minimum: 1, maximum: 50 } } } } },
  { type: 'function', function: { name: 'save_skill', description: 'Save a reusable local playbook as Markdown guidance for future tasks. This does not add tools or system permissions. Requires user approval.', parameters: { type: 'object', properties: { name: { type: 'string' }, instructions: { type: 'string' } }, required: ['name', 'instructions'] } } }
];
const workerToolNames = new Set(['search_chat_history', 'read_chat_messages', 'list_files', 'read_file', 'search_text', 'web_search', 'web_fetch']);
const workerTools = tools.filter(tool => workerToolNames.has(tool.function.name));

async function filesRecursive(dir, base, result) {
  const ignored = new Set(['.git', '.ollama-agent', 'node_modules', '.next', 'dist', 'build', '.venv', '__pycache__']);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const item of entries) {
    if (ignored.has(item.name)) continue;
    const full = path.join(dir, item.name);
    if (isSensitiveTarget(full)) continue;
    if (item.isDirectory()) await filesRecursive(full, base, result);
    else if (item.isFile()) result.push(path.relative(base, full));
    if (result.length >= 500) return;
  }
}
async function executeTool(call) {
  let args;
  try { args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : call.function.arguments || {}; }
  catch { return 'Invalid tool arguments JSON.'; }
  try {
    if (activeTaskUi?.mode === 'plan' && new Set(['write_file', 'delete_file', 'rollback_last_change', 'run_command', 'save_skill']).has(call.function.name)) return 'Plan mode is read-only. Describe this action in the plan instead of executing it.';
    if (call.function.name === 'search_chat_history') return searchChatHistory(args.query, args.maxResults);
    if (call.function.name === 'read_chat_messages') return readChatMessages(args.ids);
    if (call.function.name === 'list_files') {
      const dir = resolveTarget(args.directory || '.'); if (isAgentInternal(dir)) return 'Agent internal state is not available as project context.'; const result = []; await filesRecursive(dir, dir, result);
      return truncate(result.sort().join('\n') || '(no files)');
    }
    if (call.function.name === 'read_file') { const target = resolveTarget(args.path); if (isAgentInternal(target)) return 'Agent internal state is not available as project context.'; if (isSensitiveTarget(target)) return 'Blocked by guardrail: sensitive file requires manual inspection outside the agent.'; return readFileContent(await fsp.readFile(target, 'utf8'), args.startLine, args.endLine, args.pattern, args.flags); }
    if (call.function.name === 'search_text') {
      const base = resolveTarget(args.directory || '.'); if (isAgentInternal(base)) return 'Agent internal state is not available as project context.'; if (isSensitiveTarget(base)) return 'Blocked by guardrail: sensitive file requires manual inspection outside the agent.'; const files = []; await filesRecursive(base, base, files); const hits = [];
      for (const relative of files) { try { const lines = (await fsp.readFile(path.join(base, relative), 'utf8')).split(/\r?\n/); lines.forEach((line, i) => { if (line.includes(args.query) && hits.length < 100) hits.push(`${relative}:${i + 1}: ${line}`); }); } catch {} }
      return truncate(hits.join('\n') || '(no matches)');
    }
    if (call.function.name === 'web_search') return await webSearch(args.query, args.maxResults);
    if (call.function.name === 'web_fetch') return await webFetch(args.url);
    if (call.function.name === 'write_file') {
      updateTaskUi('implement', 'active', 'Applying workspace change.');
      const target = resolveTarget(args.path); if (isSensitiveTarget(target)) return 'Blocked by guardrail: sensitive file requires manual editing outside the agent.'; if (!fullSystem() && matchesProtected(target)) return 'Blocked by guardrail: protected system path.';
      let before = ''; try { before = await fsp.readFile(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      log(`Proposed diff for ${args.path}:\n${writePreview(before, args.content)}`);
      if (!canAutonomouslyMutateWorkspace(target)) {
        const answer = await vscode.window.showWarningMessage(`Agent wants to write ${target}. Review the proposed diff in Output.`, { modal: true }, 'Allow');
        if (answer !== 'Allow') return 'User denied file write.';
      }
      const priorTaskFile = activeTaskUi?.files.find(item => item.path === args.path);
      let reviewBase = before;
      if (priorTaskFile?.existed && priorTaskFile.snapshot) { try { reviewBase = await fsp.readFile(priorTaskFile.snapshot, 'utf8'); } catch {} }
      const checkpoint = await createCheckpoint(target); await fsp.mkdir(path.dirname(target), { recursive: true }); await fsp.writeFile(target, args.content, 'utf8'); recordTaskFile(args.path, checkpoint, diffLineStats(reviewBase, args.content), { deleted: false });
      return `Wrote ${args.path} (${Buffer.byteLength(args.content, 'utf8')} bytes). Checkpoint: ${checkpoint.createdAt}.`;
    }
    if (call.function.name === 'delete_file') {
      if (!fullSystem()) return 'Deleting files requires Full system mode.';
      if (path.isAbsolute(String(args.path || ''))) return 'Deletion is limited to a file inside the current workspace.';
      const target = resolveTarget(args.path); const relative = path.relative(root(), target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return 'Deletion is limited to a file inside the current workspace.';
      if (isSensitiveTarget(target)) return 'Blocked by guardrail: sensitive files cannot be deleted.';
      const info = await fsp.stat(target).catch(error => error.code === 'ENOENT' ? undefined : Promise.reject(error));
      if (!info) return `File does not exist: ${args.path}`;
      if (!info.isFile()) return 'Deletion is limited to individual files; directories are not supported.';
      if (!canAutonomouslyMutateWorkspace(target)) {
        const answer = await vscode.window.showWarningMessage(`Agent wants to delete ${target}. A rollback checkpoint will be kept.`, { modal: true }, 'Delete file');
        if (answer !== 'Delete file') return 'User denied file deletion.';
      }
      const before = await fsp.readFile(target, 'utf8'); const checkpoint = await createCheckpoint(target); await fsp.unlink(target);
      recordTaskFile(args.path, checkpoint, diffLineStats(before, ''), { deleted: true });
      return `Deleted ${args.path}. Checkpoint: ${checkpoint.createdAt}.`;
    }
    if (call.function.name === 'rollback_last_change') return await rollbackLastChange();
    if (call.function.name === 'run_command') {
      if (isTestCommand(call)) updateTaskUi('verify', 'active', 'Running the requested verification.');
      const blocked = rejectDangerousCommand(args.command); if (blocked) return blocked;
      const commandCwd = args.cwd ? resolveTarget(args.cwd) : root();
      const approvalKey = `${commandCwd}\n${String(args.command)}`;
      if (!fullSystem() && !approvedCommands.has(approvalKey)) {
        const answer = await vscode.window.showWarningMessage(`Agent wants to run in ${commandCwd}:\n${args.command}`, { modal: true }, 'Allow once', 'Allow for this task');
        if (answer === 'Allow for this task') approvedCommands.add(approvalKey);
        else if (answer !== 'Allow once') return 'User denied command execution.';
      }
      const result = await runCommand(args.command, args.cwd); if (isTestCommand(call)) recordTaskCheck(args.command, result); return result;
    }
    if (call.function.name === 'git_status') { if (!await isGitRepository()) return 'This workspace is not a Git repository. Continue without Git.'; return await runCommand('git status --short --branch'); }
    if (call.function.name === 'git_diff') { if (!await isGitRepository()) return 'This workspace is not a Git repository. Continue without Git.'; return await runCommand(args.staged ? 'git diff --staged' : 'git diff'); }
    if (call.function.name === 'git_log') { if (!await isGitRepository()) return 'This workspace is not a Git repository. Continue without Git.'; return await runCommand(`git log --oneline -n ${Math.max(1, Math.min(50, Number(args.count) || 15))}`); }
    if (call.function.name === 'save_skill') {
      const name = String(args.name).replace(/[^a-z0-9_-]/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80);
      if (!name) return 'Skill name must contain letters or numbers.';
      const answer = await vscode.window.showWarningMessage(`Agent wants to save reusable playbook: ${name}.`, { modal: true }, 'Allow');
      if (answer !== 'Allow') return 'User denied saving playbook.';
      await fsp.mkdir(skillsDir, { recursive: true }); await fsp.writeFile(path.join(skillsDir, name + '.md'), String(args.instructions), 'utf8');
      return `Saved playbook ${name}; it will be included as guidance in later agent tasks.`;
    }
    return `Unknown tool: ${call.function.name}`;
  } catch (error) { return `Tool error: ${error.message}`; }
}
async function executeWorkerTool(call) {
  if (!workerToolNames.has(call?.function?.name)) return `Blocked: ${call?.function?.name || 'unknown'} is not available to read-only workers.`;
  return executeTool(call);
}
function runCommand(command, requestedCwd) {
  const configuredTimeout = config().get('commandTimeoutSeconds', 0);
  const timeout = configuredTimeout > 0 ? configuredTimeout * 1000 : 0;
  let cwd;
  try { cwd = requestedCwd ? resolveTarget(requestedCwd) : root(); } catch (error) { return Promise.resolve(`Tool error: ${error.message}`); }
  let cwdInfo;
  try { cwdInfo = fs.statSync(cwd); } catch { return Promise.resolve(`Tool error: command working directory does not exist or is inaccessible: ${cwd}. Omit cwd to use the workspace root, or first inspect an existing directory.`); }
  if (!cwdInfo.isDirectory()) return Promise.resolve(`Tool error: command cwd is not a directory: ${cwd}. Omit cwd to use the workspace root.`);
  let runner = detectedEnvironment().runner;
  // A cached runner can become stale after an OS/tooling update. Re-detect it
  // immediately before launching, so an ENOENT names the real cause instead
  // of being mistaken for a missing PowerShell installation.
  if (!runner?.executable || !fs.existsSync(runner.executable)) {
    executionEnvironment = detectExecutionEnvironment(); environmentDescription = undefined;
    runner = executionEnvironment.runner;
  }
  if (!runner) return Promise.resolve('Tool error: no usable command shell executable was found during environment detection.');
  if (!fs.existsSync(runner.executable)) return Promise.resolve(`Tool error: detected command shell is unavailable: ${runner.executable}.`);
  return new Promise(resolve => {
    const callback = (error, stdout, stderr) => {
      if (activeChild === child) activeChild = undefined;
      const status = error ? `Exit/error: ${error.message}` : 'Exit: 0';
      resolve(truncate(`${status}\nSTDOUT:\n${stdout || ''}\nSTDERR:\n${stderr || ''}`));
    };
    const options = { cwd, windowsHide: true, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' };
    const child = cp.execFile(runner.executable, [...runner.args, String(command)], options, callback);
    activeChild = child;
    if (cancelled) stopProcessTree(child);
  });
}
function isGitRepository(cwd = root()) { return new Promise(resolve => cp.execFile('git', ['rev-parse', '--is-inside-work-tree'], { cwd, windowsHide: true }, error => resolve(!error))); }
function isEndpointLimitError(error) { return /(?:\b429\b|usage limit|rate limit|quota|too many requests|credits? (?:have )?been exhausted)/i.test(String(error?.message || error)); }
function workerSpeed(worker) { return Number(worker?.profile?.benchmark?.tokensPerSecond || workerBenchmarks.get(worker?.id)?.benchmark?.tokensPerSecond || 0); }
function masterRuntimeKey(runtime = {}) { return `${normalizeEndpoint(runtime.endpoint || config().get('endpoint'))}\n${String(runtime.model || config().get('model') || '').trim()}`; }
function fallbackMasterCandidates(health, { needsVision = false } = {}) {
  const requestedContext = Number(config().get('contextWindow', 0)); const primaryEndpoint = normalizeEndpoint(config().get('endpoint')); const primaryModel = String(config().get('model') || '').trim();
  return health.filter(worker => worker.status === 'available').filter(worker => !(normalizeEndpoint(worker.endpoint) === primaryEndpoint && worker.model === primaryModel)).filter(worker => !needsVision || (worker.profile?.capabilities || []).map(value => String(value).toLowerCase()).includes('vision')).filter(worker => !requestedContext || !worker.profile?.contextLength || Number(worker.profile.contextLength) >= requestedContext).sort((left, right) => workerSpeed(right) - workerSpeed(left) || left.name.localeCompare(right.name));
}
function masterRuntimeForWorker(worker) { return { client: workerPool.client(worker), model: worker.model, name: worker.name, endpoint: worker.endpoint, contextWindow: Number(config().get('contextWindow', 0)) }; }
async function chatWithMasterFailover(messages, onChunk, taskTools, session) {
  let streamedContent = '';
  for (;;) {
    try { return await chat(messages, partial => { if (partial.content) streamedContent += partial.content; onChunk?.(partial); }, taskTools, session.current); }
    catch (error) {
      if (!isEndpointLimitError(error) || !session.fallbacks.length) throw error;
      session.limitedKeys.add(masterRuntimeKey(session.current));
      if (streamedContent) messages.push({ role: 'assistant', content: streamedContent });
      const worker = session.fallbacks.shift(); session.current = masterRuntimeForWorker(worker);
      const speed = workerSpeed(worker); const speedText = speed ? ` at ${speed} tok/s` : '';
      log(`Master endpoint limit detected (${error.message}). Continuing on worker ${worker.name} (${worker.model})${speedText}.`);
      updateTaskUi('continue', 'active', `Master limit reached; continuing on ${worker.name}.`);
      streamedContent = '';
    }
  }
}
async function chat(messages, onChunk, taskTools = tools, runtime = {}) {
  const controller = createActiveAbortController();
  try {
    return await (runtime.client || ollama).chat({
      model: runtime.model || config().get('model'), messages, tools: taskTools,
      temperature: Number(config().get('temperature', 0.2)),
      contextWindow: Number(runtime.contextWindow ?? config().get('contextWindow', 0)),
      signal: controller.signal, onChunk,
      onThinkingUnsupported: model => log(`Model ${model} does not support thinking; continuing without it.`)
    });
  } finally { releaseActiveAbortController(controller); }
}
function extractCalls(message) {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) return message.tool_calls;
  // Some otherwise capable local model templates emit the requested call as
  // JSON in content instead of Ollama's tool_calls field. Some emit several
  // calls as fenced JSON blocks. Accept only known tool names; the host still
  // performs all permission checks before any side effect.
  const raw = String(message.content || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const known = new Set(tools.map(tool => tool.function.name));
  const asCalls = value => (Array.isArray(value) ? value : [value]).filter(item => {
    const name = item?.function?.name || item?.name;
    return known.has(name);
  }).map(item => ({
    function: item.function ? { name: item.function.name, arguments: typeof item.function.arguments === 'string' ? item.function.arguments : JSON.stringify(item.function.arguments || {}) } : { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) }
  }));
  try { const calls = asCalls(JSON.parse(raw)); if (calls.length) return calls; } catch {}
  const calls = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fenced.exec(String(message.content || '')))) {
    try { calls.push(...asCalls(JSON.parse(match[1].trim()))); } catch {}
  }
  if (calls.length) return calls;
  // Qwen 2.5 Coder occasionally ignores the tool-call template and emits
  // `tool_name {"argument":"value"}` as ordinary content. Recognize only
  // a known name followed by one balanced JSON object; executeTool still
  // applies the same permission prompts and guardrails.
  const text = String(message.content || '');
  const plainCall = new RegExp(`\\b(${[...known].join('|')})\\s*` + '\\{', 'g');
  while ((match = plainCall.exec(text))) {
    const start = plainCall.lastIndex - 1; let depth = 0; let quoted = false; let escaped = false; let end = -1;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
      if (char === '"') { quoted = true; continue; }
      if (char === '{') depth++;
      if (char === '}' && --depth === 0) { end = index + 1; break; }
    }
    if (end < 0) continue;
    try { const argumentsObject = JSON.parse(text.slice(start, end)); calls.push({ function: { name: match[1], arguments: JSON.stringify(argumentsObject) } }); } catch {}
    plainCall.lastIndex = end;
  }
  return calls;
}
function isTestCommand(call) {
  if (call.function.name !== 'run_command') return false;
  try { const args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : call.function.arguments || {}; return /\b(test|tests|pytest|jest|vitest|mocha|ctest|dotnet\s+test|cargo\s+test|go\s+test)\b/i.test(args.command || ''); } catch { return false; }
}
function testFailed(result) { return /^Exit\/error:/m.test(String(result)); }
async function ask(initialTask, providedId, attachments = [], replyTo, continuationMessages, requestedMode = 'execute', editId) {
  if (running) return vscode.window.showInformationMessage('Ollama Offline Agent is already working.');
  activeWebSources = [];
  if (!root()) return vscode.window.showErrorMessage('Open a folder workspace first.');
  const task = initialTask || await vscode.window.showInputBox({ prompt: 'What should the offline coding agent do?', placeHolder: 'Example: Find why the tests fail and fix them.' });
  if (!task) return;
  await ensureWorkspaceState();
  const replacedBranch = !continuationMessages && editId ? replaceChatBranch(String(editId)) : false;
  const taskMode = ['ask', 'plan', 'execute'].includes(requestedMode) ? requestedMode : 'execute';
  activeTaskUi = { mode: taskMode, state: 'running', startedAt: new Date().toISOString(), timeline: [], activity: [], workers: { active: 0, total: 0 }, files: [], checks: [], canRestore: false };
  running = true; cancelled = false; if (!continuationMessages) approvedCommands.clear(); postUi('runState', { working: true }); updateTaskUi('understand', 'active', taskMode === 'plan' ? 'Researching and preparing a read-only plan.' : taskMode === 'ask' ? 'Inspecting the question and relevant context.' : 'Inspecting the request and relevant context.'); output.show(true); log(`\n=== ${continuationMessages ? 'Steering' : taskMode}: ${task} ===`);
  const mode = config().get('accessMode');
  const access = mode === 'fullSystem' ? 'Full system mode is enabled: safe commands and local installers run without repeated prompts. Create, edit, and delete operations for non-sensitive files physically inside the open workspace run autonomously with rollback checkpoints. Writes outside the workspace, sensitive files, restores, and playbook saves still require approval; destructive system commands remain blocked.' : guardedSystem() ? 'Guarded system mode is enabled: absolute paths are allowed when needed.' : 'Workspace mode is enabled: all file operations remain inside the open workspace.';
  const lastAssistant = latestAssistantContext(); const lastUser = latestUserContext();
  log(lastAssistant ? `Context: the previous assistant answer${lastUser ? ' and previous user request' : ''} were supplied as candidate context; older history is available on demand.` : 'Context: no previous assistant answer is available; complete local history is searchable on demand.');
  // Bind uploads to this exact prompt. A resource that is merely selected is
  // not silently carried into a later, unrelated request.
  const attachedPaths = new Set(attachments.map(item => item.path).filter(Boolean));
  const resources = pendingResources.filter(item => attachedPaths.has(item.path));
  for (let index = pendingResources.length - 1; index >= 0; index--) if (attachedPaths.has(pendingResources[index].path)) pendingResources.splice(index, 1);
  const resourceNote = resources.length ? `\n\nAttached local resources (inspect them when relevant):\n${resources.map(item => `- ${item.path} (${item.mime})`).join('\n')}` : '';
  const replyNote = replyTo?.quote ? `\n\nThe user is replying to this excerpt from your previous response:\n> ${String(replyTo.quote).replace(/\n/g, '\n> ')}\n\nAddress the user's newest request in that context.` : '';
  const taskWithResources = task + resourceNote + replyNote;
  // Resource paths are part of the model-only context. The persisted and
  // displayed user message intentionally contains only what the user wrote.
  const userEvent = rememberUser(taskWithResources, task, Boolean(initialTask), providedId, attachments, replyTo);
  if (replacedBranch) chatProvider?.replay();
  const promptId = String(providedId || userEvent.id);
  const userMessage = { role: 'user', content: taskWithResources };
  const images = resources.filter(item => item.mime.startsWith('image/')).map(item => item.data);
  if (images.length) userMessage.images = images;
  await configuredModel();
  let workerContext = ''; const masterSession = { current: {}, fallbacks: [], limitedKeys: new Set() };
  if (configuredWorkers().some(worker => worker.enabled)) {
    if (!continuationMessages) { updateTaskUi('research', 'active', 'Checking available expert workers.'); log('Checking configured read-only workers before starting the master task.'); }
    const workerController = createActiveAbortController();
    let health;
    try { health = await workerPool.health({ benchmark: true, signal: workerController.signal }); }
    finally { releaseActiveAbortController(workerController); }
    throwIfCancelled(); const available = health.filter(worker => worker.status === 'available');
    masterSession.fallbacks = fallbackMasterCandidates(health, { needsVision: images.length > 0 });
    if (masterSession.fallbacks.length) log(`Master failover candidates: ${masterSession.fallbacks.map(worker => `${worker.name} (${worker.model}${workerSpeed(worker) ? `, ${workerSpeed(worker)} tok/s` : ''})`).join(', ')}.`);
    if (!continuationMessages) for (const worker of health) log(`Worker ${worker.name}: ${worker.status}${worker.error ? ` (${worker.error})` : ''}`);
    if (!continuationMessages && available.length) {
      log(`Planning distinct expert assignments for ${available.length} available worker${available.length === 1 ? '' : 's'}.`);
      const maxWorkerTasks = available.length;
      const plan = await planWorkerAssignments(taskWithResources, available, lastAssistant, lastUser, maxWorkerTasks, masterSession);
      const skippedLimitedWorkers = plan.assignments.filter(assignment => { const worker = available.find(item => item.id === assignment.workerId); return worker && masterSession.limitedKeys.has(masterRuntimeKey(worker)); });
      if (skippedLimitedWorkers.length) {
        plan.assignments = plan.assignments.filter(assignment => !skippedLimitedWorkers.includes(assignment));
        log(`Skipping ${skippedLimitedWorkers.map(assignment => available.find(worker => worker.id === assignment.workerId)?.name).join(', ')} because its endpoint/model has already reported a usage limit.`);
      }
      for (const assignment of plan.assignments) { const worker = available.find(item => item.id === assignment.workerId); if (worker) log(`Assigned ${worker.name} as ${assignment.role}: ${assignment.task}`); }
      if (!plan.assignments.length) log('Worker delegation skipped: ' + plan.delegationReason);
      throwIfCancelled();
      const workerController = createActiveAbortController();
      let dispatch;
      try { dispatch = await dispatchWorkerPlan(taskWithResources, health, plan, lastAssistant, workerController.signal); }
      finally { releaseActiveAbortController(workerController); }
      throwIfCancelled();
      for (const result of dispatch.results) log(result.text ? `Worker ${result.worker.name} completed ${result.task}${result.quality?.repairAttempted ? result.quality.accepted ? ' after one host-requested report correction' : ' after one unsuccessful host-requested report correction' : ''}` : `Worker ${result.worker.name} did not return findings: ${result.error || 'empty response'}`);
      rememberWorkerReports(dispatch.results);
      const workerCapacity = '\n\nDelegation capacity: ' + plan.assignments.length + ' assignment(s) were selected from ' + available.length + ' available worker(s), with a configured maximum of ' + maxWorkerTasks + '. A requested maximum is an upper bound, not missing work. Do not claim that unassigned expert roles were required or missing.';
      if (dispatch.results.length) workerContext = workerCapacity + workerDispatchContext(dispatch.results) + `\n\nThe extension host already dispatched the worker assignments before this master turn. Worker delegation is host-managed, not a model-callable tool: do not claim that workers are unavailable merely because you do not see a delegate_task tool, and do not tell the user to assign work through another UI. Treat the reports below as the completed worker phase.\n\nMaster responsibility after delegation: ${plan.masterFocus}\nDo not repeat delegated research unless needed to validate it. Before repeating a worker’s time-sensitive factual claim, apply the evidence policy in the findings handoff.` + workerFindingsContext(dispatch.results);
    }
    if (!continuationMessages) { updateTaskUi('research', 'complete', 'Expert-worker research phase completed.'); postUi('workerHealth', { workers: health }); }
  }
  const modeInstruction = taskMode === 'plan' ? '\n\nYou are in Plan mode. Use only read-only evidence gathering. Do not write files, run commands, save skills, or request approvals. Return a concise implementation plan with scope, files, validation steps, risks, and open questions.' : taskMode === 'ask' ? '\n\nYou are in Ask mode. Answer or inspect with read-only tools only; do not write files, run commands, save skills, or request approvals.' : '\n\nYou are in Execute mode. After inspecting relevant context, implement the request, verify it, and summarize the result.';
  const taskTools = taskMode === 'execute' ? tools : tools.filter(tool => !new Set(['write_file', 'delete_file', 'rollback_last_change', 'run_command', 'save_skill']).has(tool.function.name));
  const priorRequestContext = lastUser ? `\n\nCandidate previous user request (use it only when it clarifies the newest task; otherwise ignore it):\n${truncate(lastUser.content, 4000)}` : '';
  const messages = continuationMessages ? [...continuationMessages, userMessage] : [{ role: 'system', content: SYSTEM + modeInstruction + '\n' + describeExecutionEnvironment() + '\n' + languageInstruction() + '\n' + access + await loadSkills(task) + workerContext + priorRequestContext }, ...(lastAssistant ? [lastAssistant] : []), userMessage]; activeAgentMessages = messages;
  const stepLimit = config().get('maxSteps', 0);
  let failingTest = '';
  let recoveryNudges = 0;
  let emptyResponseNudges = 0;
  let promptRead = false;
  try {
    for (let step = 1; !cancelled && (!stepLimit || step <= stepLimit); step++) {
      vscode.window.setStatusBarMessage(`Ollama agent: step ${step}`, 3000);
      const streamId = messageId(); let thinkingStarted = false;
      updateTaskUi(step === 1 ? 'analyze' : 'continue', 'active', step === 1 ? 'Analyzing evidence and choosing the next action.' : `Continuing agent work (step ${step}).`);
      throwIfCancelled(); if (!promptRead) setPromptState(promptId, 'delivered');
      const data = await chatWithMasterFailover(messages, partial => {
        if (!promptRead) { promptRead = true; setPromptState(promptId, 'read'); }
        if (partial.thinking) { if (!thinkingStarted) { output.appendLine('Thinking:'); thinkingStarted = true; } output.append(partial.thinking); }
        if (partial.content) {
          const stream = activeStreams.get(streamId) || { text: '', createdAt: new Date().toISOString() };
          stream.text += partial.content; activeStreams.set(streamId, stream);
          postUi('assistantDelta', { id: streamId, delta: partial.content, createdAt: stream.createdAt });
        }
      }, taskTools, masterSession);
      if (!promptRead) { promptRead = true; setPromptState(promptId, 'read'); }
      if (thinkingStarted) output.appendLine('');
      const message = data.message;
      messages.push(message);
      const calls = extractCalls(message);
      if (!calls.length) {
        const streamedResponse = activeStreams.get(streamId)?.text; const response = String(streamedResponse || message.content || '').trim();
        if (!response) {
          activeStreams.delete(streamId);
          postUi('assistantClear', { id: streamId });
          if (emptyResponseNudges < 1) {
            emptyResponseNudges++;
            messages.push({ role: 'user', content: 'You returned no final answer and made no tool call. Continue the active task now: either call the next necessary tool or provide a concise final answer with the actions actually completed and any blocker.' });
            log('Empty-response recovery guard: asking the agent to continue (1/1).');
            updateTaskUi('continue', 'active', 'Model returned no answer; requesting a concrete continuation.');
            continue;
          }
          throw new Error('Model returned no final answer after an automatic recovery attempt. Select a more capable model or retry the task.');
        }
        if (failingTest && recoveryNudges < 2) {
          recoveryNudges++;
          activeStreams.delete(streamId);
          postUi('assistantClear', { id: streamId });
          messages.push({ role: 'user', content: `Verification is still failing. Do not finish yet. Diagnose and correct it, then rerun the relevant test. If a concrete blocker prevents completion, explain that blocker and the failed result.\n\n${truncate(failingTest, 4000)}` });
          log(`Test recovery guard: asking the agent to continue (${recoveryNudges}/2).`);
          continue;
        }
        const createdAt = activeStreams.get(streamId)?.createdAt; activeStreams.delete(streamId); activeTaskUi.state = 'complete'; activeTaskUi.finishedAt ||= new Date().toISOString(); updateTaskUi(taskMode === 'plan' ? 'plan' : 'complete', 'complete', taskMode === 'plan' ? 'Plan is ready for review.' : 'Agent response is ready.'); postUi('taskUi', activeTaskUi); log(`Agent:\n${response}`); rememberAssistant(response, streamId, createdAt); return;
      }
      activeStreams.delete(streamId);
      postUi('assistantClear', { id: streamId });
      updateTaskUi('tools', 'active', calls.map(c => c.function.name).join(', ')); log(`Step ${step}: ${calls.map(c => c.function.name).join(', ')}`);
      for (const call of calls) {
        if (cancelled) break;
        const result = await executeTool(call);
        if (isTestCommand(call)) failingTest = testFailed(result) ? result : '';
        log(`${call.function.name}: ${truncate(result, 1200)}`);
        messages.push({ role: 'tool', tool_name: call.function.name, content: result });
        if (pendingSteering) break;
      }
      if (pendingSteering) { log('Steering accepted at the completed subtask boundary.'); break; }
    }
    if (!pendingSteering) vscode.window.showWarningMessage(cancelled ? 'Ollama agent stopped.' : `Ollama agent reached its ${stepLimit}-step limit.`);
  } catch (error) { if (cancelled && error.name === 'AbortError') { updateTaskUi('complete', 'stopped', 'Stopped by user.'); log('Agent generation aborted by user.'); } else { updateTaskUi('complete', 'failed', error.message); log(`ERROR: ${error.stack || error.message}`); rememberAssistant(`Error: ${error.message}`); vscode.window.showErrorMessage(`Ollama agent failed: ${error.message}`); } if (activeTaskUi) { activeTaskUi.state = cancelled ? 'stopped' : 'failed'; activeTaskUi.finishedAt ||= new Date().toISOString(); postUi('taskUi', activeTaskUi); } }
  finally {
    const steering = pendingSteering; pendingSteering = undefined;
    const continuation = activeAgentMessages ? [...activeAgentMessages] : undefined;
    for (const [id, stream] of activeStreams) { if (steering && stream.text) continuation?.push({ role: 'assistant', content: stream.text }); if (steering) postUi('assistantClear', { id }); }
    activeStreams.clear(); activeAgentMessages = undefined; if (activeTaskUi?.state === 'running') { activeTaskUi.state = cancelled ? 'stopped' : 'complete'; activeTaskUi.finishedAt ||= new Date().toISOString(); updateTaskUi('complete', cancelled ? 'stopped' : 'complete', cancelled ? 'Stopped by user.' : 'Finished.'); postUi('taskUi', activeTaskUi); } running = false; postUi('runState', { working: false });
    if (steering) await ask(steering.text, steering.id, steering.attachments, steering.replyTo, continuation, steering.mode);
    else if (queuedAgentRequests.length) { const next = queuedAgentRequests.shift(); await ask(next.text, next.id, next.attachments, next.replyTo, undefined, next.mode); }
  }
}
function steer(task, id, attachments = [], replyTo, mode = 'execute') {
  if (!running) return ask(task, id, attachments, replyTo, undefined, mode);
  if (pendingSteering?.id) setPromptState(pendingSteering.id, 'superseded');
  pendingSteering = { text: task, id, attachments, replyTo, mode }; setPromptState(id, 'waiting'); log(`Steering requested; it will apply after the current subtask: ${task}`);
}
function queueAgentRequest(task, id, attachments = [], replyTo, mode = 'execute') { if (!running) return ask(task, id, attachments, replyTo, undefined, mode); queuedAgentRequests.push({ text: task, id, attachments, replyTo, mode }); setPromptState(id, 'queued'); log(`Queued follow-up: ${task}`); }
async function health() {
  try { const info = await ollama.version(); vscode.window.showInformationMessage(`Ollama endpoint is ready (version ${info.version}).`); }
  catch (error) { vscode.window.showErrorMessage(`Ollama endpoint is unavailable: ${error.message}.`); }
}
async function installedModels() {
  return ollama.listModels();
}
async function configuredModel() {
  const existing = config().get('model');
  if (existing) return existing;
  const first = (await installedModels())[0]?.name;
  if (!first) throw new Error('No locally installed Ollama models were found.');
  await config().update('model', first, vscode.ConfigurationTarget.Global);
  return first;
}
async function publishSettings(view = chatView) {
  if (!view) return;
  const configuredLanguage = config().get('language', 'auto'); let models = []; let endpointStatus = 'connected';
  try { models = await installedModels(); }
  catch (error) { endpointStatus = 'unavailable'; log(`Could not list models from ${endpointBase()}: ${error.message}`); }
  const selected = config().get('model') || models[0]?.name || '';
  if (!config().get('model') && selected) await config().update('model', selected, vscode.ConfigurationTarget.Global);
  const workers = configuredWorkers(); const workerTokenIds = (await Promise.all(workers.map(async worker => (await hasWorkerToken(worker.id)) ? worker.id : undefined))).filter(Boolean);
  void view.webview.postMessage({ type: 'settings', mode: config().get('accessMode', 'workspace'), model: selected, language: configuredLanguage === 'auto' ? vscode.env.language : configuredLanguage, languageAuto: configuredLanguage === 'auto', webEnabled: webEnabled(), temperature: config().get('temperature', 0.2), contextWindow: config().get('contextWindow', 0), endpoint: endpointBase(), endpointStatus, hasEndpointToken: Boolean(endpointToken && endpointTokenFor === endpointBase()), models, workers, workerTokenIds });
}
async function setModel(name) {
  try {
    if (!(await installedModels()).some(model => model.name === name)) throw new Error('Selected model is not installed.');
    await config().update('model', name, vscode.ConfigurationTarget.Global); await publishSettings();
  } catch (error) { vscode.window.showErrorMessage(`Could not list local Ollama models: ${error.message}`); }
}
function selectModel() { postUi('openSettings', { menu: 'model' }); }
async function setAccessMode(value) {
  if (!['workspace', 'guardedSystem', 'fullSystem'].includes(value)) return;
  if (value === 'fullSystem') {
    const confirmed = await vscode.window.showWarningMessage('Full system mode allows safe commands anywhere accessible to your Windows account, including installers, without repeated command prompts. Non-sensitive file changes inside the open workspace proceed autonomously with rollback checkpoints. Destructive system commands remain blocked; writes outside the workspace, sensitive files, restores, and playbook saves still require approval.', { modal: true }, 'Enable Full System');
    if (confirmed !== 'Enable Full System') return;
  }
  await config().update('accessMode', value, vscode.ConfigurationTarget.Global); await publishSettings();
}
function selectAccessMode() { postUi('openSettings', { menu: 'permissions' }); }
function showAbout() { postUi('about', { version: extensionVersion, historyPath: root() ? '.ollama-agent/chat-history.json' : 'Open a workspace to create local history.' }); }
async function setLanguage(language) { await config().update('language', String(language || 'auto'), vscode.ConfigurationTarget.Global); await publishSettings(); }
async function setWebEnabled(value) { await config().update('webEnabled', Boolean(value), vscode.ConfigurationTarget.Global); await publishSettings(); }
async function modelContextLimit(model) { return ollama.modelContextLimit(model); }
async function setGenerationSettings(temperature, contextWindow) { const requested = Math.max(0, Math.min(262144, Number(contextWindow) || 0)); const limit = requested ? await modelContextLimit(await configuredModel()) : 0; if (limit && requested > limit) return vscode.window.showWarningMessage(`Selected model supports at most ${limit} context tokens.`); await config().update('temperature', Math.max(0, Math.min(2, Number(temperature))), vscode.ConfigurationTarget.Global); await config().update('contextWindow', requested, vscode.ConfigurationTarget.Global); await publishSettings(); }
async function setEndpoint(value, token, clearToken) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); }
  catch { return vscode.window.showErrorMessage('Enter a valid Ollama endpoint URL, for example http://127.0.0.1:11434.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return vscode.window.showErrorMessage('The endpoint must be an HTTP(S) URL without embedded credentials.');
  const normalized = normalizeEndpoint(parsed.toString());
  if (!endpointIsLocal(normalized)) {
    const confirmed = await vscode.window.showWarningMessage('This is a remote endpoint. Prompts, relevant project context, and attached resources sent for inference can leave this computer. Continue?', { modal: true }, 'Use Remote Endpoint');
    if (confirmed !== 'Use Remote Endpoint') return;
  }
  await config().update('endpoint', normalized, vscode.ConfigurationTarget.Global);
  const providedToken = String(token || '').trim();
  if (providedToken) { endpointToken = providedToken; endpointTokenFor = normalized; await extensionSecrets.store('ollamaEndpointToken', JSON.stringify({ endpoint: endpointTokenFor, token: endpointToken })); }
  else if (clearToken) { endpointToken = ''; endpointTokenFor = ''; await extensionSecrets.delete('ollamaEndpointToken'); }
  await publishSettings();
  vscode.window.showInformationMessage(`Ollama endpoint configured: ${normalized}`);
}
async function pullModel(name) {
  const model = String(name || '').trim();
  if (!model || /\s/.test(model) || model.length > 180) return vscode.window.showErrorMessage('Enter a valid Ollama model name, for example qwen3.6:27b.');
  try {
    if ((await installedModels()).some(item => item.name === model)) { await config().update('model', model, vscode.ConfigurationTarget.Global); await publishSettings(); return; }
    await ollama.pullModel(model, status => log(`Pull ${model}: ${status}`));
    await config().update('model', model, vscode.ConfigurationTarget.Global); await publishSettings();
  } catch (error) { vscode.window.showErrorMessage(`Could not download ${model}: ${error.message}`); }
}
async function openSkills() {
  await fsp.mkdir(skillsDir, { recursive: true });
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(skillsDir));
}
async function newChat() {
  if (running) return vscode.window.showWarningMessage('Stop the current agent run before starting a new chat.');
  const confirmed = await vscode.window.showWarningMessage('Clear this workspace chat history? This removes the visible conversation and its local context.', { modal: true }, 'Clear Chat History');
  if (confirmed !== 'Clear Chat History') return;
  await chatStore.clear(); pendingResources.length = 0; promptStates.clear(); activeTaskUi = undefined;
  postUi('historyCleared');
}
function openChatEditor() { chatProvider.openInEditor(); }
async function moveChatToSecondarySidebar() {
  // VS Code owns view layout. Its Move View picker is reliable even if the
  // webview itself is not focused (unlike Move Focused View).
  await vscode.commands.executeCommand('workbench.action.moveView');
}
class OfflineChatViewProvider {
  constructor(context) { this.context = context; this.readyViews = new WeakSet(); this.messageQueues = new WeakMap(); }
  isReady(view) { return this.readyViews.has(view); }
  post(view, message) {
    if (!this.isReady(view)) return Promise.resolve(false);
    const epoch = view._ollamaEpoch;
    const prior = this.messageQueues.get(view) || Promise.resolve();
    const next = prior.catch(() => undefined).then(() => view._ollamaEpoch === epoch ? view.webview.postMessage(message) : false);
    this.messageQueues.set(view, next);
    return next;
  }
  resolveWebviewView(view) {
    sideBarChatView = view;
    if (!editorChatPanel) chatView = view;
    this.setup(view);
    view.onDidDispose(() => { sideBarChatView = undefined; if (chatView === view) chatView = editorChatPanel; });
  }
  setup(view) {
    view._ollamaEpoch = (view._ollamaEpoch || 0) + 1;
    this.readyViews.delete(view);
    view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri, ...(root() ? [vscode.Uri.file(root())] : [])], retainContextWhenHidden: true };
    view._ollamaMessageDisposable?.dispose();
    view._ollamaMessageDisposable = view.webview.onDidReceiveMessage(message => {
      if (message.type === 'prompt' && String(message.text || '').trim()) ask(String(message.text).trim(), message.id, Array.isArray(message.attachments) ? message.attachments : [], message.replyTo, undefined, message.mode, message.editId);
      if (message.type === 'steer' && String(message.text || '').trim()) steer(String(message.text).trim(), message.id, Array.isArray(message.attachments) ? message.attachments : [], message.replyTo, message.mode);
      if (message.type === 'queue' && String(message.text || '').trim()) queueAgentRequest(String(message.text).trim(), message.id, Array.isArray(message.attachments) ? message.attachments : [], message.replyTo, message.mode);
      if (message.type === 'stop') requestStop();
      if (message.type === 'restoreCheckpoint') rollbackLastChange().then(result => {
        log(result);
        if (/^Restored /i.test(result) && activeTaskUi) { activeTaskUi.canRestore = false; postUi('taskUi', activeTaskUi); }
        postUi('taskRestoreResult', { result });
      });
      if (message.type === 'openTaskDiff' && typeof message.path === 'string') void openTaskFileDiff(message.path);
      if (message.type === 'model') selectModel();
      if (message.type === 'newChat') newChat();
      if (message.type === 'exportChatPdf') exportChatPdf();
      if (message.type === 'about') showAbout();
      if (message.type === 'permissions') selectAccessMode();
      if (message.type === 'setModel') setModel(String(message.model || ''));
      if (message.type === 'setAccessMode') setAccessMode(String(message.mode || ''));
      if (message.type === 'setLanguage') setLanguage(String(message.language || 'auto'));
      if (message.type === 'setWebEnabled') setWebEnabled(Boolean(message.enabled));
      if (message.type === 'setWorkers') setWorkers(message.workers, message.tokens || {});
      if (message.type === 'setWorkerToken') setWorkerToken(String(message.id || ''), message.token, Boolean(message.clearToken));
      if (message.type === 'loadWorkerModels') loadWorkerModels(String(message.id || ''));
      if (message.type === 'probeWorkerModels') probeWorkerModels(String(message.id || 'new'), message.endpoint, message.token);
      if (message.type === 'checkWorkers') checkWorkers({ benchmark: true });
      if (message.type === 'autodetectWorkers') autodetectWorkers();
      if (message.type === 'cancelWorkerDiscovery') workerDiscoveryController?.abort();
      if (message.type === 'setGeneration') setGenerationSettings(message.temperature, message.contextWindow);
      if (message.type === 'setEndpoint') setEndpoint(message.endpoint, message.token, Boolean(message.clearToken));
      if (message.type === 'pullModel') pullModel(message.model);
      if (message.type === 'resource') saveResource(message).catch(error => postUi('resourceError', { clientId: message.clientId, message: error.message }));
      if (message.type === 'cancelResource') cancelResource(message.clientId);
      if (message.type === 'deleteMessage') deleteChatMessage(message.id);
      if (message.type === 'ready') { this.readyViews.add(view); this.replay(view); }
    });
    view.webview.html = this.html(view.webview);
  }
  openInEditor() {
    if (editorChatPanel) { editorChatPanel.reveal(vscode.ViewColumn.Beside, true); return; }
    const panel = vscode.window.createWebviewPanel('ollamaOffline.editorChat', 'Ollama Offline Agent', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, localResourceRoots: [this.context.extensionUri], retainContextWhenHidden: true });
    editorChatPanel = panel; chatView = panel; this.setup(panel);
    panel.onDidDispose(() => { editorChatPanel = undefined; chatView = sideBarChatView; });
  }
  replay(view = chatView) {
    if (!view || chatView !== view || !this.isReady(view)) return;
    void publishSettings(view);
    void this.post(view, {
      type: 'historySnapshot',
      messages: chatHistory.filter(event => !event.internal).map(event => this.uiEvent(view.webview, event)),
      streams: [...activeStreams.entries()].map(([id, stream]) => ({ id, ...stream })),
      working: running
    });
    for (const [id, state] of promptStates) void this.post(view, { type: 'promptState', id, state });
    if (activeTaskUi) void this.post(view, { type: 'taskUi', ...activeTaskUi });
  }
  uiEvent(webview, event) {
    const workspace = root();
    const attachments = [...(event.attachments || []).map(item => ({ ...item, preview: workspace && String(item.mime || '').startsWith('image/') && item.path ? webview.asWebviewUri(vscode.Uri.file(path.join(workspace, item.path))).toString() : undefined })), ...(event.sources || []).map(item => ({ ...item, source: true }))];
    return { ...event, attachments };
  }
  renderHtml(webview) {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.js'));
    const highlightUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'highlight.min.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css'));
    const brain = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5a3 3 0 0 0-5.997.142 4 4 0 0 0-2.526 5.77 4 4 0 0 0 1.842 7.192A4 4 0 0 0 12 20Z"/><path d="M12 5a3 3 0 0 1 5.997.142 4 4 0 0 1 2.526 5.77 4 4 0 0 1-1.842 7.192A4 4 0 0 1 12 20Z"/><path d="M12 5v15"/></svg>';
    const shield = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3Z"/></svg>';
    const clip = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
    const arrow = '<svg class="arrow-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>';
    const square = '<svg class="stop-icon" viewBox="0 0 24 24" aria-hidden="true"><rect width="10" height="10" x="7" y="7" rx="1"/></svg>';
    const route = '<svg class="steer-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="19" r="2"/><path d="M9 19h2a4 4 0 0 0 4-4V5"/><path d="m12 8 3-3 3 3"/></svg>';
    const globe = webEnabled() ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2 2 20 20"/><path d="M12 21a9 9 0 0 0 8.84-7.3M18.6 18.6A9 9 0 0 1 3.16 10.3M6 6.3A9 9 0 0 1 20.84 10M12 3a14 14 0 0 1 3.3 10.7M12 21a14 14 0 0 1-3.3-10.7M3 12h7M14 12h7"/></svg>';
    const initialMode = config().get('accessMode', 'workspace');
    const initialModel = config().get('model');
    const initialModeLabel = ({ workspace: 'Workspace access', guardedSystem: 'Guarded system access', fullSystem: 'Full system access' })[initialMode] || 'Permissions';
    const initialShield = initialMode === 'guardedSystem' ? '<svg viewBox="0 0 24 24"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3Z"/><path d="m9 12 2 2 4-4"/></svg>' : initialMode === 'fullSystem' ? '<svg viewBox="0 0 24 24"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3Z"/><path d="M12 8v4M12 16h.01"/></svg>' : shield;
    return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; img-src ${webview.cspSource} data:;"><meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="stylesheet" href="${styleUri}"></head><body><aside id="aboutPanel" class="about-panel" aria-live="polite"></aside><main id="chat" aria-live="polite"><div class="status">Ready</div></main><section class="composer" id="composer"><div id="composerResize" title="Drag to resize prompt"></div><div id="replyContext" class="reply-context"></div><div id="attachments" class="attachments"></div><textarea id="input" placeholder="Ask the agent to inspect, plan, code, or test…" aria-label="Agent prompt"></textarea><input id="resourceInput" type="file" multiple hidden><div class="composer-actions"><div class="setting"><button class="permissions icon-only mode-${initialMode}" id="permissions" title="${initialModeLabel}">${initialShield}</button><div id="permissionsMenu" class="setting-menu"></div></div><div class="setting"><button class="model icon-only" id="model" title="Model: ${initialModel}">${brain}</button><div id="modelMenu" class="setting-menu model-menu"></div></div><button class="attach icon-only" id="attach" title="Attach files or images">${clip}</button><button class="web icon-only" id="web" title="Enable web access">${globe}</button><span class="composer-hint" title="Paste files · Shift+drop · Enter" title="Paste files with Ctrl+V. When dragging from VS Code Explorer, hold Shift while dropping.">Paste files · Shift+drop · Enter</span><div class="setting"><button id="language" class="language" title="Reply language">SK</button><div id="languageMenu" class="setting-menu language-menu"></div></div><button id="submit" class="submit" title="Send">${arrow}${square}${route}</button></div></section><script src="${highlightUri}"></script><script src="${scriptUri}"></script></body></html>`;
  }
  html(webview) {
    return this.renderHtml(webview);
  }
}
function activate(context) {
  extensionVersion = context.extension?.packageJSON?.version || 'unknown';
  extensionSecrets = context.secrets;
  endpointTokenReady = context.secrets.get('ollamaEndpointToken').then(value => {
    if (!value) return;
    try { const saved = JSON.parse(value); endpointToken = String(saved.token || ''); endpointTokenFor = String(saved.endpoint || ''); }
    catch { endpointToken = value; endpointTokenFor = endpointBase(); }
  });
  output = vscode.window.createOutputChannel('Ollama Offline Agent');
  executionEnvironment = detectExecutionEnvironment();
  environmentDescription = undefined;
  log(`Environment detected: ${executionEnvironment.platform}; runner: ${executionEnvironment.runner ? `${executionEnvironment.runner.label} (${executionEnvironment.runner.executable})` : 'none'}; configured terminal: ${executionEnvironment.configuredProfile}.`);
  skillsDir = path.join(context.globalStorageUri.fsPath, 'skills');
  chatProvider = new OfflineChatViewProvider(context);
  if (root()) void ensureWorkspaceState();
  context.subscriptions.push(output, vscode.workspace.onDidChangeWorkspaceFolders(() => { if (root()) void ensureWorkspaceState(); }), vscode.window.registerWebviewViewProvider('ollamaOffline.chat', chatProvider), vscode.commands.registerCommand('ollamaOffline.ask', ask), vscode.commands.registerCommand('ollamaOffline.stop', () => { requestStop(); vscode.window.showInformationMessage('Stop requested.'); }), vscode.commands.registerCommand('ollamaOffline.health', health), vscode.commands.registerCommand('ollamaOffline.selectModel', selectModel), vscode.commands.registerCommand('ollamaOffline.openSkills', openSkills), vscode.commands.registerCommand('ollamaOffline.newChat', newChat), vscode.commands.registerCommand('ollamaOffline.exportChatPdf', exportChatPdf), vscode.commands.registerCommand('ollamaOffline.about', showAbout), vscode.commands.registerCommand('ollamaOffline.openChatEditor', openChatEditor), vscode.commands.registerCommand('ollamaOffline.moveChatToSecondarySidebar', moveChatToSecondarySidebar));
}
function deactivate() { requestStop(); }
module.exports = { activate, deactivate };
