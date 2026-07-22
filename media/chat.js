/* Local, dependency-free and deliberately HTML-safe Markdown renderer. */
const vscode = acquireVsCodeApi();
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const submit = document.getElementById('submit');
const composer = document.getElementById('composer');
const resourceInput = document.getElementById('resourceInput');
const attachments = document.getElementById('attachments');
let working = false;
let sending = false;
const queuedAttachments = [];
const uploads = new Map();
const streamed = new Map();
const restoredState = vscode.getState() || {};
let stickToBottom = restoredState.stickToBottom !== false;
let steeringMode = restoredState.steeringMode === 'queue' ? 'queue' : 'steer';
let replyTo;
let workers = [];
let workerHealth = new Map();
let workerTokenIds = new Set();
const workerModels = new Map();
const draftWorkerIds = new Set();
const draftWorkerTokens = new Map();
const pendingWorkerEdits = new Set();
const trashSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>';
const pencilSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const copySvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16V4a2 2 0 0 1 2-2h10"/></svg>';
const replySvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 17-5-5 5-5"/><path d="M4 12h9a7 7 0 0 1 7 7"/></svg>';
const checkSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
const banSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></svg>';
const clearSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/></svg>';
const xSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const plusSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const keyRoundSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>';
const refreshSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12A9 9 0 0 1 18.5 5.8L21 8"/><path d="M21 3v5h-5"/></svg>';
const routeSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="19" r="2"/><path d="M9 19h2a4 4 0 0 0 4-4V5"/><path d="m12 8 3-3 3 3"/></svg>';
const queueSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>';
const globeSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';
const globeOffSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2 2 20 20"/><path d="M12 21a9 9 0 0 0 8.84-7.3M18.6 18.6A9 9 0 0 1 3.16 10.3M6 6.3A9 9 0 0 1 20.84 10M12 3a14 14 0 0 1 3.3 10.7M12 21a14 14 0 0 1-3.3-10.7M3 12h7M14 12h7"/></svg>';
const serverPlusSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="14" height="18" rx="2"/><path d="M7 7h6M7 11h6M20 16v6M17 19h6"/></svg>';
const shieldSvg = mode => mode === 'guardedSystem' ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3Z"/><path d="m9 12 2 2 4-4"/></svg>' : mode === 'fullSystem' ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3Z"/><path d="M12 8v4M12 16h.01"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3Z"/></svg>';
const imageViewer = document.createElement('div'); imageViewer.id = 'imageViewer'; imageViewer.className = 'image-viewer'; imageViewer.innerHTML = `<button type="button" title="Close image viewer" aria-label="Close image viewer">${xSvg}</button><img alt="Expanded attachment">`; document.body.appendChild(imageViewer);
const viewerImage = imageViewer.querySelector('img'); function openImageViewer(image) { viewerImage.src = image.currentSrc || image.src; viewerImage.alt = image.alt || 'Expanded attachment'; imageViewer.classList.add('open'); imageViewer.querySelector('button').focus(); } function closeImageViewer() { imageViewer.classList.remove('open'); viewerImage.removeAttribute('src'); }
const workerHelp = 'Workers can read chat and project context, and use enabled public web tools. They cannot write, run commands, or mutate Git.';
const workersDialog = document.createElement('section'); workersDialog.id = 'workersDialog'; workersDialog.className = 'worker-dialog'; workersDialog.setAttribute('aria-labelledby', 'workersDialogTitle'); workersDialog.innerHTML = `<section class="worker-dialog-card"><header class="worker-dialog-header"><strong id="workersDialogTitle" title="${workerHelp}">Read-only workers</strong><div><button id="addWorkerRow" class="icon-only" title="Add worker row" aria-label="Add worker row">${plusSvg}</button><button id="checkWorkers" title="Check worker availability">Check</button><button id="closeWorkersDialog" class="icon-only" title="Close worker manager" aria-label="Close worker manager">${xSvg}</button></div></header><div id="workersMenu" class="workers-menu"></div><aside id="workerTokenPopover" class="worker-token-popover" aria-label="Worker Bearer token"><header><strong>Bearer token</strong><button id="closeWorkerToken" class="icon-only" title="Close token editor" aria-label="Close token editor">${xSvg}</button></header><input id="workerTokenEditor" type="password" autocomplete="off" placeholder="Optional Bearer token — stored securely"><footer><button id="clearWorkerToken" class="secondary">Clear</button><button id="saveWorkerToken">Save</button></footer></aside></section>`; composer.before(workersDialog);
function openWorkersDialog() { renderWorkers(); closeMenus(); workersDialog.classList.add('open'); document.getElementById('closeWorkersDialog').focus(); for (const worker of workers) vscode.postMessage({ type: 'loadWorkerModels', id: worker.id }); }
function closeWorkersDialog() { workersDialog.classList.remove('open'); document.getElementById('workers').focus(); }

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function inlineMarkdown(value) {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
}
function tableCells(line) {
  const source = String(line).trim().replace(/^\|/, '').replace(/\|$/, ''); const cells = []; let cell = ''; let inCode = false;
  for (let index = 0; index < source.length; index++) { const char = source[index]; if (char === '\\' && source[index + 1] === '|') { cell += '|'; index++; continue; } if (char === '`') inCode = !inCode; if (char === '|' && !inCode) { cells.push(cell.trim()); cell = ''; } else cell += char; }
  cells.push(cell.trim()); return cells;
}
function highlightCode(source, language) {
  const code = escapeHtml(source); const lang = String(language || '').toLowerCase();
  const keywords = lang === 'lua' ? /\b(?:and|break|do|else|elseif|end|false|for|function|if|in|local|nil|not|or|repeat|return|then|true|until|while)\b/g : lang === 'javascript' || lang === 'js' || lang === 'typescript' || lang === 'ts' ? /\b(?:async|await|const|class|else|export|false|for|function|if|import|let|new|null|return|true|undefined|while)\b/g : lang === 'python' || lang === 'py' ? /\b(?:and|as|class|def|elif|else|False|for|from|if|import|in|None|not|or|return|True|while)\b/g : /$^/g;
  return code.replace(/(--[^\n]*|\/\/[^\n]*|#[^\n]*|&quot;(?:[^&]|&(?!quot;))*?&quot;|&#39;(?:[^&]|&(?!#39;))*?&#39;|\b\d+(?:\.\d+)?\b)/g, token => token.startsWith('--') || token.startsWith('//') || token.startsWith('#') ? `<span class="tok-comment">${token}</span>` : token.startsWith('&') ? `<span class="tok-string">${token}</span>` : `<span class="tok-number">${token}</span>`).replace(keywords, '<span class="tok-keyword">$&</span>');
}
function markdown(value) {
  const lines = String(value).replace(/\r/g, '').split('\n');
  const out = []; let inCode = false; let code = []; let codeLanguage = ''; let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith('```')) { closeList(); if (inCode) { out.push(`<pre class="language-${escapeHtml(codeLanguage || 'plain')}"><code>${highlightCode(code.join('\n'), codeLanguage)}</code></pre>`); code = []; codeLanguage = ''; } else codeLanguage = line.slice(3).trim().split(/\s+/)[0]; inCode = !inCode; continue; }
    if (inCode) { code.push(line); continue; }
    if (/^\|?.+\|.+\|?$/.test(line) && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] || '')) {
      closeList(); const headers = tableCells(line); const markdownRows = [line, lines[index + 1]]; index += 2; const rows = [];
      while (index < lines.length && /^\|?.+\|.+\|?$/.test(lines[index])) { rows.push(tableCells(lines[index])); markdownRows.push(lines[index]); index++; }
      index--; out.push(`<div class="table-wrap"><button class="copy-table" title="Copy table as Markdown" data-copy-table="${escapeHtml(markdownRows.join('\n'))}">${copySvg}</button><table><thead><tr>${headers.map(cell => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((_, cell) => `<td>${inlineMarkdown(row[cell] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/); const unordered = line.match(/^[-*+]\s+(.+)$/); const ordered = line.match(/^\d+\.\s+(.+)$/);
    if (heading) { closeList(); const level = heading[1].length; out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); continue; }
    if (unordered || ordered) { const type = ordered ? 'ol' : 'ul'; if (list && list !== type) closeList(); if (!list) { list = type; out.push(`<${type}>`); } out.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`); continue; }
    closeList(); out.push(line ? `<div>${inlineMarkdown(line)}</div>` : '<br>');
  }
  closeList(); if (inCode) out.push(`<pre class="language-${escapeHtml(codeLanguage || 'plain')}"><code>${highlightCode(code.join('\n'), codeLanguage)}</code></pre>`); return out.join('');
}
function attachmentMarkup(items, temporary = false) {
  if (!items?.length) return '';
  const markup = items.map(item => {
    const name = escapeHtml(item.name || 'resource');
    const remove = temporary ? `<button class="attachment-remove" data-remove-attachment="${escapeHtml(item.clientId)}" title="Cancel attachment">${xSvg}</button>` : '';
    const image = String(item.mime || '').startsWith('image/') && (item.data || item.preview);
    if (image) { const content = `<img class="attachment-image" src="${item.preview || `data:${escapeHtml(item.mime)};base64,${item.data}`}" alt="${name}" title="${name}">`; return temporary ? `<span class="queued-attachment image-attachment">${content}${remove}</span>` : content; }
    const content = `<span class="attachment-file" title="${name}">${name}${temporary ? remove : ''}</span>`;
    return temporary ? `<span class="queued-attachment file-attachment">${content}</span>` : content;
  }).join('');
  return `<div class="message-attachments${temporary ? ' pending-attachments' : ''}">${markup}</div>`;
}
function renderQueuedAttachments() { attachments.innerHTML = attachmentMarkup(queuedAttachments, true); }
function cancelQueuedAttachment(clientId) { const index = queuedAttachments.findIndex(item => item.clientId === clientId); if (index < 0) return; queuedAttachments.splice(index, 1); const upload = uploads.get(clientId); if (upload) { uploads.delete(clientId); upload.resolve(); } renderQueuedAttachments(); vscode.postMessage({ type: 'cancelResource', clientId }); }
function messageDate(value) { return new Date(value || Date.now()); }
function timestampPart(value) { return String(value).padStart(2, '0'); }
function formatTime(value) { const date = messageDate(value); return `${date.getFullYear()}-${timestampPart(date.getMonth() + 1)}-${timestampPart(date.getDate())} ${timestampPart(date.getHours())}:${timestampPart(date.getMinutes())}:${timestampPart(date.getSeconds())}`; }
function fullTimestamp(value) { return formatTime(value); }
function nearBottom() { return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 28; }
function persistScroll() { vscode.setState({ ...vscode.getState(), stickToBottom, scrollTop: chat.scrollTop, steeringMode }); }
async function copyText(text) { try { await navigator.clipboard.writeText(text); } catch { const area = document.createElement('textarea'); area.value = text; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove(); } }
function renderReplyContext() { const target = document.getElementById('replyContext'); if (!replyTo) { target.replaceChildren(); return; } target.innerHTML = `<span>${replySvg} Replying to: ${escapeHtml(replyTo.quote)}</span><button id="cancelReply" title="Cancel reply">×</button>`; document.getElementById('cancelReply').onclick = () => { replyTo = undefined; renderReplyContext(); }; }
function selectedExcerpt(element) { const selection = window.getSelection(); if (!selection || selection.isCollapsed || !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return ''; return selection.toString().trim().slice(0, 4000); }
function sourceMarkup(items) { const sources = (items || []).filter(item => item.source); if (!sources.length) return ''; return `<div class="web-sources"><span>Sources</span>${sources.map(item => { const icon = item.favicon ? `<img src="${escapeHtml(item.favicon)}" alt="">` : `<span class="source-fallback-icon" title="No favicon available">${globeSvg}</span>`; return `<a href="${escapeHtml(item.url)}" title="${escapeHtml(item.url)}">${icon}${escapeHtml(item.title || new URL(item.url).hostname)}</a>`; }).join('')}</div>`; }
function add(kind, text, id, messageAttachments = [], scroll = true, createdAt, messageReplyTo, messageSources = []) {
  const shouldScroll = scroll && nearBottom();
  let element = id && chat.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
  if (!element) { element = document.createElement('div'); element.className = 'message ' + kind; if (id) element.dataset.messageId = id; chat.appendChild(element); }
  element.className = 'message ' + kind;
  element.innerHTML = (kind === 'assistant' || kind === 'user') ? `<time title="${escapeHtml(fullTimestamp(createdAt))}">${formatTime(createdAt)}</time>${messageReplyTo?.quote ? `<blockquote class="reply-reference">${escapeHtml(messageReplyTo.quote)}</blockquote>` : ''}${markdown(text)}${kind === 'assistant' ? sourceMarkup(messageAttachments) : ''}` : '';
  if (kind !== 'assistant' && kind !== 'user') element.textContent = text;
  if (kind === 'user') element.insertAdjacentHTML('beforeend', attachmentMarkup(messageAttachments));
  if (id && (kind === 'assistant' || kind === 'user')) { const actions = document.createElement('div'); actions.className = 'message-actions'; if (kind === 'assistant') { const copy = document.createElement('button'); copy.title = 'Copy Markdown'; copy.innerHTML = copySvg; copy.onclick = () => copyText(text); const reply = document.createElement('button'); reply.title = 'Reply to this response or selected text'; reply.innerHTML = replySvg; reply.onpointerdown = event => { reply._excerpt = selectedExcerpt(element); event.preventDefault(); }; reply.onclick = () => { replyTo = { id, quote: reply._excerpt || String(text).slice(0, 4000) }; renderReplyContext(); input.focus(); }; actions.append(copy, reply); } else { const edit = document.createElement('button'); edit.title = 'Edit and run this prompt again'; edit.innerHTML = pencilSvg; edit.onclick = () => { input.value = text; input.focus(); input.setSelectionRange(input.value.length, input.value.length); vscode.postMessage({ type: 'editMessage', id }); updateSubmit(); }; actions.append(edit); } const remove = document.createElement('button'); remove.title = 'Delete message'; remove.innerHTML = trashSvg; remove.onclick = () => vscode.postMessage({ type: 'deleteMessage', id }); actions.appendChild(remove); element.appendChild(actions); }
  if (shouldScroll) { element.scrollIntoView({ block: 'end' }); stickToBottom = true; persistScroll(); }
}
async function send() {
  const text = input.value.trim(); if (!text || sending) return;
  sending = true;
  try {
    await Promise.allSettled([...uploads.values()].map(upload => upload.done));
    const sentAttachments = queuedAttachments.splice(0);
    renderQueuedAttachments();
    const id = crypto.randomUUID(); add('user', text, id, sentAttachments, true, new Date().toISOString(), replyTo); input.value = '';
    vscode.postMessage({ type: 'prompt', text, id, replyTo, attachments: sentAttachments.map(({ name, mime, path }) => ({ name, mime, path })) }); replyTo = undefined; renderReplyContext();
  } finally { sending = false; }
}
const languageCodes = 'af am ar as az be bg bn bo br bs ca cs cy da de el en eo es et eu fa fi fil fo fr fy ga gd gl gu he hi hr hu hy id is it ja ka kk km kn ko ku ky la lb lo lt lv mg mi mk ml mn mr ms mt my ne nl no oc or pa pl ps pt qu ro ru sa sd si sk sl so sq sr sv sw ta te tg th tk tl tr tt ug uk ur uz vi wo xh yi yo zh zu'.split(' ');
const languageNames = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' });
function closeMenus() { document.querySelectorAll('.setting-menu.open').forEach(menu => menu.classList.remove('open')); }
function toggleMenu(id) { const menu = document.getElementById(id); const open = !menu.classList.contains('open'); closeMenus(); if (open) menu.classList.add('open'); }
function saveWorkers() { vscode.postMessage({ type: 'setWorkers', workers: workers.filter(worker => !draftWorkerIds.has(worker.id)) }); }
function workerState(worker) {
  const health = workerHealth.get(worker.id); const state = health?.status || 'unknown';
  const label = state === 'available' ? 'Available' : state === 'model-missing' ? 'Model missing' : state === 'unavailable' ? 'Unavailable' : state === 'disabled' ? 'Disabled' : 'Not checked';
  const draftLabel = !String(worker.name || '').trim() ? 'Enter name' : !validWorkerEndpoint(worker.endpoint) ? 'Enter endpoint' : !worker.model ? 'Select model' : 'Saving…';
  return { health, state, label: draftWorkerIds.has(worker.id) ? draftLabel : label };
}
function workerModelMarkup(worker) {
  const models = workerModels.get(worker.id)?.models || []; const hasSelectedModel = models.some(item => item.name === worker.model);
  const options = `${!worker.model ? '<option value="" selected disabled>Select installed model</option>' : (!hasSelectedModel ? `<option value="${escapeHtml(worker.model)}" selected>${escapeHtml(worker.model)} · unavailable</option>` : '')}${models.map(item => `<option value="${escapeHtml(item.name)}" ${item.name === worker.model ? 'selected' : ''}>${escapeHtml(item.name)}${Number.isFinite(item.size) ? ` · ${item.size} GB` : ''}</option>`).join('')}`;
  const select = models.length ? `<select data-worker-model="${escapeHtml(worker.id)}">${options}</select>` : `<select disabled title="Loading models from worker"><option>${workerModels.get(worker.id)?.error || 'Loading installed models…'}</option></select>`;
  return `${select}<button data-load-worker-models="${escapeHtml(worker.id)}" title="Load installed models and check this worker">${refreshSvg}</button>`;
}
function workerRowMarkup(worker) {
  const { health, state, label } = workerState(worker);
  return `<tr class="worker-row ${draftWorkerIds.has(worker.id) ? 'draft' : ''}" data-worker-row="${escapeHtml(worker.id)}"><td><input type="checkbox" data-worker-toggle="${escapeHtml(worker.id)}" ${worker.enabled !== false ? 'checked' : ''} title="Use this worker"></td><td><input data-worker-name="${escapeHtml(worker.id)}" value="${escapeHtml(worker.name)}" maxlength="80" aria-label="Worker name"></td><td><input data-worker-endpoint="${escapeHtml(worker.id)}" type="url" value="${escapeHtml(worker.endpoint)}" aria-label="Worker endpoint"></td><td><div class="worker-model-cell">${workerModelMarkup(worker)}</div></td><td><button data-edit-worker-token="${escapeHtml(worker.id)}" class="worker-key ${workerTokenIds.has(worker.id) ? 'saved' : ''}" title="${workerTokenIds.has(worker.id) ? 'Update saved Bearer token' : 'Set Bearer token'}">${keyRoundSvg}</button></td><td><span class="worker-status ${state}" title="${escapeHtml(health?.error || label)}">${label}</span></td><td><button data-worker-remove="${escapeHtml(worker.id)}" title="Remove worker">${trashSvg}</button></td></tr>`;
}
function workerIdsMatch(body) { return [...body.querySelectorAll('[data-worker-row]')].map(row => row.dataset.workerRow).join('\u0000') === workers.map(worker => worker.id).join('\u0000'); }
function syncWorkerRow(row, worker) {
  const { health, state, label } = workerState(worker); row.classList.toggle('draft', draftWorkerIds.has(worker.id));
  const toggle = row.querySelector('[data-worker-toggle]'); if (toggle) toggle.checked = worker.enabled !== false;
  for (const [attribute, value] of [['data-worker-name', worker.name], ['data-worker-endpoint', worker.endpoint]]) { const field = row.querySelector(`[${attribute}]`); if (field && document.activeElement !== field && field.value !== value) field.value = value; }
  const modelCell = row.querySelector('.worker-model-cell'); if (modelCell && !modelCell.contains(document.activeElement)) modelCell.innerHTML = workerModelMarkup(worker);
  const key = row.querySelector('[data-edit-worker-token]'); if (key) { key.classList.toggle('saved', workerTokenIds.has(worker.id)); key.title = workerTokenIds.has(worker.id) ? 'Update saved Bearer token' : 'Set Bearer token'; }
  const status = row.querySelector('.worker-status'); if (status) { status.className = `worker-status ${state}`; status.title = health?.error || label; status.textContent = label; }
}
function renderWorkers(nextWorkers) {
  if (Array.isArray(nextWorkers)) {
    const currentById = new Map(workers.map(worker => [worker.id, worker])); const drafts = workers.filter(worker => draftWorkerIds.has(worker.id));
    workers = [...nextWorkers.map(worker => {
      const current = currentById.get(worker.id);
      if (!current || !pendingWorkerEdits.has(worker.id)) return { ...current, ...worker };
      const saved = current.name === worker.name && current.endpoint === worker.endpoint && current.model === worker.model;
      if (saved) pendingWorkerEdits.delete(worker.id);
      return saved ? { ...current, ...worker } : { ...worker, ...current };
    }), ...drafts];
  }
  const menu = document.getElementById('workersMenu'); if (!menu) return;
  let body = menu.querySelector('tbody');
  if (!body || !workerIdsMatch(body)) { menu.innerHTML = `<div class="worker-table-wrap"><table class="worker-table"><thead><tr><th>Use</th><th>Name</th><th>Endpoint</th><th>Model</th><th>Bearer</th><th>Status</th><th></th></tr></thead><tbody>${workers.map(workerRowMarkup).join('') || '<tr><td class="menu-empty" colspan="7">Use + to add a worker.</td></tr>'}</tbody></table></div>`; return; }
  workers.forEach(worker => syncWorkerRow(body.querySelector(`[data-worker-row="${CSS.escape(worker.id)}"]`), worker));
}
function renderSettings(message) {
  const web = document.getElementById('web'); if (web) { web.dataset.enabled = String(Boolean(message.webEnabled)); web.title = message.webEnabled ? 'Disable web access' : 'Enable web access'; web.innerHTML = message.webEnabled ? globeSvg : globeOffSvg; }
  const mode = message.mode || 'workspace'; const permission = document.getElementById('permissions');
  permission.className = `permissions icon-only mode-${mode}`; permission.title = ({ workspace: 'Workspace access', guardedSystem: 'Guarded system access', fullSystem: 'Full system access' })[mode] || 'Permissions'; permission.innerHTML = shieldSvg(mode);
  document.getElementById('permissionsMenu').innerHTML = [['workspace', 'Workspace'], ['guardedSystem', 'Guarded system'], ['fullSystem', 'Full system']].map(([value, label]) => `<button data-access="${value}" class="mode-${value} ${value === mode ? 'selected' : ''}">${shieldSvg(value)}<span>${label}</span></button>`).join('');
  document.getElementById('model').title = `Model: ${message.model || 'unknown'}`;
  const endpointIcon = message.endpointStatus === 'connected' ? checkSvg : banSvg;
  const endpointTitle = message.endpointStatus === 'connected' ? 'Endpoint reachable' : 'Endpoint unavailable';
  const clearTokenButton = message.hasEndpointToken ? `<button id="clearEndpointToken" class="clear-token" title="Clear saved token">${clearSvg}</button>` : '';
  if (Array.isArray(message.models)) document.getElementById('modelMenu').innerHTML = `<div class="model-controls"><label>Endpoint<div class="endpoint-field"><input id="endpoint" type="url" placeholder="http://127.0.0.1:11434"><span id="endpointStatus" class="endpoint-status ${message.endpointStatus || 'unknown'}" title="${endpointTitle}">${endpointIcon}</span></div></label><label>Bearer token<div class="endpoint-field"><input id="endpointToken" type="password" autocomplete="off" placeholder="Optional — stored securely">${clearTokenButton}</div></label><small class="endpoint-note">Saved automatically. LAN and cloud endpoints may receive selected context.</small><div class="generation-controls"><label><span>Heat <output id="temperatureValue"></output></span><input id="temperature" type="range" min="0" max="2" step="0.05"></label><label><span>Context</span><select id="contextWindow"><option value="0">Auto</option><option value="4096">4K</option><option value="8192">8K</option><option value="16384">16K</option><option value="32768">32K</option><option value="65536">64K</option><option value="131072">128K</option><option value="262144">256K</option></select></label></div><input id="customModel" placeholder="model:tag — Enter downloads or selects"></div><div class="model-list">${message.models.map(model => `<button data-model="${escapeHtml(model.name)}" class="${model.name === message.model ? 'selected' : ''}">${escapeHtml(model.name)} <small>${model.size} GB</small></button>`).join('') || '<span class="menu-empty">No models available from this endpoint</span>'}</div>`;
  const temperature = document.getElementById('temperature'); const contextWindow = document.getElementById('contextWindow'); if (temperature) { temperature.value = String(message.temperature ?? .2); contextWindow.value = String(message.contextWindow || 0); document.getElementById('temperatureValue').textContent = temperature.value; }
  const endpoint = document.getElementById('endpoint'); if (endpoint) endpoint.value = message.endpoint || ''; const endpointToken = document.getElementById('endpointToken'); if (endpointToken && message.hasEndpointToken) endpointToken.placeholder = 'Token saved securely — enter a replacement';
  const current = (message.language || navigator.language || 'en').split('-')[0]; const language = document.getElementById('language'); language.textContent = current.toUpperCase(); language.title = message.languageAuto ? `Auto (${nativeLanguage(current)})` : nativeLanguage(current); document.getElementById('languageMenu').innerHTML = `<button data-language="auto" class="${message.languageAuto ? 'selected' : ''}">Auto</button>${languageCodes.map(code => `<button data-language="${code}" class="${code === current && !message.languageAuto ? 'selected' : ''}"><small>${code.toUpperCase()}</small><span>${escapeHtml(nativeLanguage(code))}</span></button>`).join('')}`;
  workerTokenIds = new Set(message.workerTokenIds || []); renderWorkers(message.workers);
}
function renderAbout(message) { const panel = document.getElementById('aboutPanel'); panel.innerHTML = `<div class="about-content"><button id="closeAbout" title="Close About">×</button><strong>Ollama Offline Coding Agent</strong><span>Version ${escapeHtml(message.version || 'unknown')}</span><p>Offline-first local coding agent for VS Code. Prompts, chat history, resources, and inference stay local unless you deliberately configure a remote endpoint.</p><small>Project history: ${escapeHtml(message.historyPath || '')}</small></div>`; panel.classList.toggle('open'); document.getElementById('closeAbout').onclick = () => panel.classList.remove('open'); }
function nativeLanguage(code) { try { return new Intl.DisplayNames([code], { type: 'language' }).of(code) || code; } catch { return languageNames.of(code) || code; } }
function updateSubmit() { const steering = working && Boolean(input.value.trim()); submit.classList.toggle('working', working); submit.classList.toggle('steering', steering); submit.title = steering ? steeringMode === 'queue' ? 'Queue follow-up' : 'Steer agent' : working ? 'Stop' : 'Send'; }
async function steerAgent() { const text = input.value.trim(); if (!text || sending) return; sending = true; try { await Promise.allSettled([...uploads.values()].map(upload => upload.done)); const sentAttachments = queuedAttachments.splice(0); renderQueuedAttachments(); const id = crypto.randomUUID(); add('user', text, id, sentAttachments, true, new Date().toISOString(), replyTo); input.value = ''; vscode.postMessage({ type: steeringMode === 'queue' ? 'queue' : 'steer', text, id, replyTo, attachments: sentAttachments.map(({ name, mime, path }) => ({ name, mime, path })) }); replyTo = undefined; renderReplyContext(); } finally { sending = false; updateSubmit(); } }
submit.onclick = () => { if (working) { if (input.value.trim()) void steerAgent(); else vscode.postMessage({ type: 'stop' }); } else void send(); };
const steeringSetting = document.createElement('div'); steeringSetting.className = 'setting'; steeringSetting.innerHTML = `<button id="steeringMode" class="icon-only" title="Steering mode"></button><div id="steeringMenu" class="setting-menu steering-menu"><button data-steering-mode="steer">${routeSvg}Steer</button><button data-steering-mode="queue">${queueSvg}Queue</button></div>`; submit.before(steeringSetting);
const workersSetting = document.createElement('div'); workersSetting.className = 'setting'; workersSetting.innerHTML = `<button id="workers" class="icon-only" title="Manage read-only Ollama workers">${serverPlusSvg}</button>`; document.getElementById('attach').after(workersSetting);
function renderSteeringMode() { const button = document.getElementById('steeringMode'); button.innerHTML = steeringMode === 'queue' ? queueSvg : routeSvg; button.title = steeringMode === 'queue' ? 'Queued follow-up mode' : 'Steer mode'; document.querySelectorAll('[data-steering-mode]').forEach(item => item.classList.toggle('selected', item.dataset.steeringMode === steeringMode)); persistScroll(); updateSubmit(); }
document.getElementById('steeringMode').onclick = event => { event.stopPropagation(); toggleMenu('steeringMenu'); }; renderSteeringMode();
document.getElementById('workers').onclick = event => { event.stopPropagation(); openWorkersDialog(); };
document.getElementById('closeWorkersDialog').onclick = closeWorkersDialog;
document.getElementById('model').onclick = event => { event.stopPropagation(); toggleMenu('modelMenu'); };
document.getElementById('permissions').onclick = event => { event.stopPropagation(); toggleMenu('permissionsMenu'); };
document.getElementById('language').onclick = event => { event.stopPropagation(); toggleMenu('languageMenu'); };
const workerSaveTimers = new Map();
let editedWorkerTokenId;
function validWorkerEndpoint(value) { try { const url = new URL(String(value || '').trim()); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }
function scheduleWorkerSave(id) { clearTimeout(workerSaveTimers.get(id)); workerSaveTimers.set(id, setTimeout(() => { const worker = workers.find(item => item.id === id); if (!worker || !worker.name.trim() || !validWorkerEndpoint(worker.endpoint)) return; if (draftWorkerIds.has(id)) { if (!worker.model) return; draftWorkerIds.delete(id); const token = draftWorkerTokens.get(id); vscode.postMessage({ type: 'setWorkers', workers: workers.filter(item => !draftWorkerIds.has(item.id)), tokens: token ? { [id]: token } : {} }); draftWorkerTokens.delete(id); return; } saveWorkers(); }, 1200)); }
function openWorkerToken(id) { editedWorkerTokenId = id; const popover = document.getElementById('workerTokenPopover'); const editor = document.getElementById('workerTokenEditor'); editor.value = ''; editor.placeholder = workerTokenIds.has(id) ? 'Token saved securely — enter replacement' : 'Optional Bearer token — stored securely'; document.getElementById('clearWorkerToken').hidden = !workerTokenIds.has(id); popover.classList.add('open'); editor.focus(); }
function closeWorkerToken() { editedWorkerTokenId = undefined; document.getElementById('workerTokenPopover').classList.remove('open'); }
document.getElementById('addWorkerRow').onclick = () => { const id = crypto.randomUUID(); draftWorkerIds.add(id); workers.push({ id, name: '', endpoint: '', model: '', enabled: true }); renderWorkers(); document.querySelector(`[data-worker-name="${CSS.escape(id)}"]`)?.focus(); };
document.getElementById('closeWorkerToken').onclick = closeWorkerToken;
document.getElementById('saveWorkerToken').onclick = () => { if (!editedWorkerTokenId) return; const value = document.getElementById('workerTokenEditor').value.trim(); if (!value) return; if (draftWorkerIds.has(editedWorkerTokenId)) draftWorkerTokens.set(editedWorkerTokenId, value); vscode.postMessage({ type: 'setWorkerToken', id: editedWorkerTokenId, token: value, clearToken: false }); workerTokenIds.add(editedWorkerTokenId); closeWorkerToken(); renderWorkers(); };
document.getElementById('clearWorkerToken').onclick = () => { if (!editedWorkerTokenId) return; draftWorkerTokens.delete(editedWorkerTokenId); vscode.postMessage({ type: 'setWorkerToken', id: editedWorkerTokenId, token: '', clearToken: true }); workerTokenIds.delete(editedWorkerTokenId); closeWorkerToken(); renderWorkers(); };
document.addEventListener('click', event => { const image = event.target.closest('.attachment-image'); const model = event.target.closest('[data-model]'); const access = event.target.closest('[data-access]'); const language = event.target.closest('[data-language]'); const steering = event.target.closest('[data-steering-mode]'); const clearEndpointToken = event.target.closest('#clearEndpointToken'); const removeAttachment = event.target.closest('[data-remove-attachment]'); const removeWorker = event.target.closest('[data-worker-remove]'); const editWorkerToken = event.target.closest('[data-edit-worker-token]'); const loadWorkerModels = event.target.closest('[data-load-worker-models]'); if (image) { openImageViewer(image); } else if (event.target === imageViewer || event.target.closest('#imageViewer button')) { closeImageViewer(); } else if (removeAttachment) { cancelQueuedAttachment(removeAttachment.dataset.removeAttachment); } else if (event.target.closest('#checkWorkers')) { vscode.postMessage({ type: 'checkWorkers' }); } else if (loadWorkerModels) { const id = loadWorkerModels.dataset.loadWorkerModels; const worker = workers.find(item => item.id === id); if (worker && draftWorkerIds.has(id)) vscode.postMessage({ type: 'probeWorkerModels', id, endpoint: document.querySelector(`[data-worker-endpoint="${CSS.escape(id)}"]`)?.value || worker.endpoint, token: draftWorkerTokens.get(id) || '' }); else { vscode.postMessage({ type: 'loadWorkerModels', id }); vscode.postMessage({ type: 'checkWorkers' }); } } else if (editWorkerToken) { openWorkerToken(editWorkerToken.dataset.editWorkerToken); } else if (removeWorker) { const id = removeWorker.dataset.workerRemove; const wasDraft = draftWorkerIds.has(id); if (wasDraft) vscode.postMessage({ type: 'setWorkerToken', id, token: '', clearToken: true }); workers = workers.filter(worker => worker.id !== id); draftWorkerIds.delete(id); draftWorkerTokens.delete(id); workerTokenIds.delete(id); workerHealth.delete(id); saveWorkers(); renderWorkers(); } else if (steering) { steeringMode = steering.dataset.steeringMode === 'queue' ? 'queue' : 'steer'; renderSteeringMode(); closeMenus(); } else if (clearEndpointToken) { vscode.postMessage({ type: 'setEndpoint', endpoint: document.getElementById('endpoint').value, token: '', clearToken: true }); } else if (model) { vscode.postMessage({ type: 'setModel', model: model.dataset.model }); closeMenus(); } else if (access) { vscode.postMessage({ type: 'setAccessMode', mode: access.dataset.access }); closeMenus(); } else if (language) { vscode.postMessage({ type: 'setLanguage', language: language.dataset.language }); closeMenus(); } else if (!event.target.closest('.setting')) closeMenus(); });
document.addEventListener('change', event => { const toggle = event.target.closest('[data-worker-toggle]'); if (!toggle) return; const worker = workers.find(item => item.id === toggle.dataset.workerToggle); if (!worker) return; worker.enabled = toggle.checked; saveWorkers(); renderWorkers(); });
document.addEventListener('change', event => { const model = event.target.closest('[data-worker-model]'); if (!model || !model.value.trim()) return; const worker = workers.find(item => item.id === model.dataset.workerModel); if (!worker || worker.model === model.value.trim()) return; worker.model = model.value.trim(); pendingWorkerEdits.add(worker.id); if (draftWorkerIds.has(worker.id)) scheduleWorkerSave(worker.id); else saveWorkers(); });
let endpointSaveTimer; let generationSaveTimer; function saveEndpointWhenReady() { clearTimeout(endpointSaveTimer); endpointSaveTimer = setTimeout(() => { const endpoint = document.getElementById('endpoint'); const token = document.getElementById('endpointToken'); if (!endpoint || !token) return; try { new URL(endpoint.value.trim()); } catch { return; } vscode.postMessage({ type: 'setEndpoint', endpoint: endpoint.value, token: token.value, clearToken: false }); }, 900); } function saveGenerationWhenReady() { clearTimeout(generationSaveTimer); generationSaveTimer = setTimeout(() => vscode.postMessage({ type: 'setGeneration', temperature: document.getElementById('temperature').value, contextWindow: document.getElementById('contextWindow').value }), 250); }
document.addEventListener('input', event => { if (event.target === input) updateSubmit(); if (event.target.id === 'temperature') document.getElementById('temperatureValue').textContent = event.target.value; if (event.target.id === 'endpoint' || event.target.id === 'endpointToken') saveEndpointWhenReady(); });
document.addEventListener('input', event => { const id = event.target.dataset?.workerName || event.target.dataset?.workerEndpoint; if (!id) return; const worker = workers.find(item => item.id === id); if (!worker) return; if (event.target.dataset.workerName) worker.name = event.target.value; else worker.endpoint = event.target.value; pendingWorkerEdits.add(id); scheduleWorkerSave(id); });
document.addEventListener('change', event => { if (event.target.id === 'temperature' || event.target.id === 'contextWindow') saveGenerationWhenReady(); });
document.addEventListener('wheel', event => { if (event.target.id !== 'temperature') return; event.preventDefault(); const control = event.target; const step = Number(control.step) || .05; const next = Math.max(Number(control.min), Math.min(Number(control.max), Number(control.value) + (event.deltaY < 0 ? step : -step))); control.value = String(Math.round(next * 100) / 100); document.getElementById('temperatureValue').textContent = control.value; saveGenerationWhenReady(); }, { passive: false });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && imageViewer.classList.contains('open')) { closeImageViewer(); return; } if (event.target.id === 'customModel' && event.key === 'Enter') { event.preventDefault(); vscode.postMessage({ type: 'pullModel', model: event.target.value }); } });
const resizeHandle = document.getElementById('composerResize'); resizeHandle.addEventListener('pointerdown', event => { const startY = event.clientY; const startHeight = input.getBoundingClientRect().height; resizeHandle.setPointerCapture(event.pointerId); const move = next => { const height = Math.max(70, Math.min(window.innerHeight - 130, startHeight + startY - next.clientY)); input.style.height = `${height}px`; }; const up = () => { resizeHandle.removeEventListener('pointermove', move); resizeHandle.removeEventListener('pointerup', up); }; resizeHandle.addEventListener('pointermove', move); resizeHandle.addEventListener('pointerup', up); });
document.getElementById('attach').onclick = () => resourceInput.click();
document.getElementById('web').onclick = () => { const button = document.getElementById('web'); vscode.postMessage({ type: 'setWebEnabled', enabled: button.dataset.enabled !== 'true' }); };
async function attachFiles(files) {
  const dropped = Array.from(files || []);
  if (!dropped.length) { add('status', 'No files were received from the drop operation.'); return; }
  for (const file of dropped) {
    try {
      if (file.size > 12 * 1024 * 1024) { add('status', `${file.name}: resource exceeds 12 MB.`); continue; }
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = reject; reader.readAsDataURL(file); });
      const clientId = crypto.randomUUID(); const item = { clientId, name: file.name, mime: file.type || 'application/octet-stream', data };
      queuedAttachments.push(item); renderQueuedAttachments();
      let resolve; const done = new Promise(next => { resolve = next; }); uploads.set(clientId, { done, resolve, item });
      vscode.postMessage({ type: 'resource', clientId, name: item.name, mime: item.mime, data });
    } catch (error) { add('status', `${file.name}: could not attach file (${error.message || error}).`); }
  }
}
resourceInput.addEventListener('change', () => { attachFiles(resourceInput.files); resourceInput.value = ''; });
chat.addEventListener('scroll', () => { stickToBottom = nearBottom(); persistScroll(); });
chat.addEventListener('click', event => { const copy = event.target.closest('[data-copy-table]'); if (copy) void copyText(copy.dataset.copyTable || ''); });
function hasDroppedFiles(event) { const transfer = event.dataTransfer; return Boolean(transfer && ((transfer.files && transfer.files.length) || Array.from(transfer.types || []).includes('Files'))); }
let dragIdleTimer; function showDropTarget() { clearTimeout(dragIdleTimer); composer.classList.add('dragging'); dragIdleTimer = setTimeout(() => composer.classList.remove('dragging'), 180); }
document.addEventListener('dragenter', event => { if (!hasDroppedFiles(event)) return; event.preventDefault(); showDropTarget(); }, true);
document.addEventListener('dragover', event => { if (!hasDroppedFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; showDropTarget(); }, true);
document.addEventListener('dragleave', event => { if (!hasDroppedFiles(event)) return; event.preventDefault(); }, true);
document.addEventListener('drop', event => { if (!hasDroppedFiles(event)) return; event.preventDefault(); event.stopPropagation(); clearTimeout(dragIdleTimer); composer.classList.remove('dragging'); attachFiles(event.dataTransfer?.files); }, true);
document.addEventListener('paste', event => { const files = event.clipboardData?.files; if (!files?.length) return; event.preventDefault(); attachFiles(files); });
input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } });
window.addEventListener('message', event => { const message = event.data; if (message.type === 'historyCleared') { streamed.clear(); chat.innerHTML = '<div class="status">Ready</div>'; } if (message.type === 'historySnapshot') { streamed.clear(); chat.replaceChildren(); for (const item of message.messages || []) add(item.kind, item.text, item.id, item.attachments, false, item.createdAt, item.replyTo); for (const stream of message.streams || []) { streamed.set(stream.id, stream); add('assistant', stream.text, stream.id, [], false, stream.createdAt); } working = Boolean(message.working); updateSubmit(); if (stickToBottom) chat.scrollTop = chat.scrollHeight; else chat.scrollTop = Math.min(Number(restoredState.scrollTop) || 0, chat.scrollHeight); } if (message.type === 'message') { streamed.delete(message.id); add(message.kind, message.text, message.id, message.attachments, true, message.createdAt, message.replyTo); } if (message.type === 'assistantDelta') { const current = streamed.get(message.id) || { text: '', createdAt: message.createdAt }; current.text += message.delta; current.createdAt ||= message.createdAt; streamed.set(message.id, current); add('assistant', current.text, message.id, [], true, current.createdAt); } if (message.type === 'assistantClear') { streamed.delete(message.id); document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)?.remove(); } if (message.type === 'messageDeleted') document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)?.remove(); if (message.type === 'runState') { working = Boolean(message.working); updateSubmit(); } if (message.type === 'settings') renderSettings(message); if (message.type === 'about') renderAbout(message); if (message.type === 'openSettings') toggleMenu(message.menu === 'model' ? 'modelMenu' : 'permissionsMenu'); if (message.type === 'resourceSaved') { const upload = uploads.get(message.clientId); if (upload) { upload.item.path = message.path; uploads.delete(message.clientId); upload.resolve(); } } if (message.type === 'resourceError') { const upload = uploads.get(message.clientId); if (upload) { const index = queuedAttachments.indexOf(upload.item); if (index >= 0) queuedAttachments.splice(index, 1); uploads.delete(message.clientId); upload.resolve(); renderQueuedAttachments(); } add('status', `Attachment error: ${message.message}`); } if (message.type === 'workerHealth') { workerHealth = new Map((message.workers || []).map(worker => [worker.id, worker])); renderWorkers(); } });
window.addEventListener('message', event => { const message = event.data; if (message.type !== 'workerModels') return; workerModels.set(message.id, { models: message.models || [], error: message.error || '' }); renderWorkers(); });
vscode.postMessage({ type: 'ready' });
