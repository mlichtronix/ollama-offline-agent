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
let replyTo;
const trashSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>';
const copySvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16V4a2 2 0 0 1 2-2h10"/></svg>';
const replySvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 17-5-5 5-5"/><path d="M4 12h9a7 7 0 0 1 7 7"/></svg>';
const checkSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
const banSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></svg>';
const clearSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/></svg>';
const xSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const shieldSvg = mode => mode === 'guardedSystem' ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3Z"/><path d="m9 12 2 2 4-4"/></svg>' : mode === 'fullSystem' ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3Z"/><path d="M12 8v4M12 16h.01"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3Z"/></svg>';
const imageViewer = document.createElement('div'); imageViewer.id = 'imageViewer'; imageViewer.className = 'image-viewer'; imageViewer.innerHTML = `<button type="button" title="Close image viewer">${xSvg}</button><img alt="Expanded attachment">`; document.body.appendChild(imageViewer);
const viewerImage = imageViewer.querySelector('img'); function openImageViewer(image) { viewerImage.src = image.currentSrc || image.src; viewerImage.alt = image.alt || 'Expanded attachment'; imageViewer.classList.add('open'); imageViewer.querySelector('button').focus(); } function closeImageViewer() { imageViewer.classList.remove('open'); viewerImage.removeAttribute('src'); }

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
function markdown(value) {
  const lines = String(value).replace(/\r/g, '').split('\n');
  const out = []; let inCode = false; let code = []; let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith('```')) { closeList(); if (inCode) { out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = []; } inCode = !inCode; continue; }
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
  closeList(); if (inCode) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); return out.join('');
}
function attachmentMarkup(items, temporary = false) {
  if (!items?.length) return '';
  const markup = items.map(item => {
    const name = escapeHtml(item.name || 'resource');
    const remove = temporary ? `<button class="attachment-remove" data-remove-attachment="${escapeHtml(item.clientId)}" title="Cancel attachment">${xSvg}</button>` : '';
    const image = String(item.mime || '').startsWith('image/') && (item.data || item.preview);
    const content = image ? `<img class="attachment-image" src="${item.preview || `data:${escapeHtml(item.mime)};base64,${item.data}`}" alt="${name}" title="${name}">` : `<span class="attachment-file" title="${name}">${name}</span>`;
    return temporary ? `<span class="queued-attachment${image ? ' image-attachment' : ''}">${content}${remove}</span>` : content;
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
function persistScroll() { vscode.setState({ stickToBottom, scrollTop: chat.scrollTop }); }
async function copyText(text) { try { await navigator.clipboard.writeText(text); } catch { const area = document.createElement('textarea'); area.value = text; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove(); } }
function renderReplyContext() { const target = document.getElementById('replyContext'); if (!replyTo) { target.replaceChildren(); return; } target.innerHTML = `<span>${replySvg} Replying to: ${escapeHtml(replyTo.quote)}</span><button id="cancelReply" title="Cancel reply">×</button>`; document.getElementById('cancelReply').onclick = () => { replyTo = undefined; renderReplyContext(); }; }
function selectedExcerpt(element) { const selection = window.getSelection(); if (!selection || selection.isCollapsed || !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return ''; return selection.toString().trim().slice(0, 4000); }
function add(kind, text, id, messageAttachments = [], scroll = true, createdAt, messageReplyTo) {
  const shouldScroll = scroll && nearBottom();
  let element = id && chat.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
  if (!element) { element = document.createElement('div'); element.className = 'message ' + kind; if (id) element.dataset.messageId = id; chat.appendChild(element); }
  element.className = 'message ' + kind;
  element.innerHTML = (kind === 'assistant' || kind === 'user') ? `<time title="${escapeHtml(fullTimestamp(createdAt))}">${formatTime(createdAt)}</time>${messageReplyTo?.quote ? `<blockquote class="reply-reference">${escapeHtml(messageReplyTo.quote)}</blockquote>` : ''}${markdown(text)}` : '';
  if (kind !== 'assistant' && kind !== 'user') element.textContent = text;
  if (kind === 'user') element.insertAdjacentHTML('beforeend', attachmentMarkup(messageAttachments));
  if (id && (kind === 'assistant' || kind === 'user')) { const actions = document.createElement('div'); actions.className = 'message-actions'; if (kind === 'assistant') { const copy = document.createElement('button'); copy.title = 'Copy Markdown'; copy.innerHTML = copySvg; copy.onclick = () => copyText(text); const reply = document.createElement('button'); reply.title = 'Reply to this response or selected text'; reply.innerHTML = replySvg; reply.onpointerdown = event => { reply._excerpt = selectedExcerpt(element); event.preventDefault(); }; reply.onclick = () => { replyTo = { id, quote: reply._excerpt || String(text).slice(0, 4000) }; renderReplyContext(); input.focus(); }; actions.append(copy, reply); } const remove = document.createElement('button'); remove.title = 'Delete message'; remove.innerHTML = trashSvg; remove.onclick = () => vscode.postMessage({ type: 'deleteMessage', id }); actions.appendChild(remove); element.appendChild(actions); }
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
function renderSettings(message) {
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
}
function renderAbout(message) { const panel = document.getElementById('aboutPanel'); panel.innerHTML = `<div class="about-content"><button id="closeAbout" title="Close About">×</button><strong>Ollama Offline Coding Agent</strong><span>Version ${escapeHtml(message.version || 'unknown')}</span><p>Offline-first local coding agent for VS Code. Prompts, chat history, resources, and inference stay local unless you deliberately configure a remote endpoint.</p><small>Project history: ${escapeHtml(message.historyPath || '')}</small></div>`; panel.classList.toggle('open'); document.getElementById('closeAbout').onclick = () => panel.classList.remove('open'); }
function nativeLanguage(code) { try { return new Intl.DisplayNames([code], { type: 'language' }).of(code) || code; } catch { return languageNames.of(code) || code; } }
submit.onclick = () => { if (working) vscode.postMessage({ type: 'stop' }); else send(); };
document.getElementById('model').onclick = event => { event.stopPropagation(); toggleMenu('modelMenu'); };
document.getElementById('permissions').onclick = event => { event.stopPropagation(); toggleMenu('permissionsMenu'); };
document.getElementById('language').onclick = event => { event.stopPropagation(); toggleMenu('languageMenu'); };
document.addEventListener('click', event => { const image = event.target.closest('.attachment-image'); const model = event.target.closest('[data-model]'); const access = event.target.closest('[data-access]'); const language = event.target.closest('[data-language]'); const clearEndpointToken = event.target.closest('#clearEndpointToken'); const removeAttachment = event.target.closest('[data-remove-attachment]'); if (image) { openImageViewer(image); } else if (event.target === imageViewer || event.target.closest('#imageViewer button')) { closeImageViewer(); } else if (removeAttachment) { cancelQueuedAttachment(removeAttachment.dataset.removeAttachment); } else if (clearEndpointToken) { vscode.postMessage({ type: 'setEndpoint', endpoint: document.getElementById('endpoint').value, token: '', clearToken: true }); } else if (model) { vscode.postMessage({ type: 'setModel', model: model.dataset.model }); closeMenus(); } else if (access) { vscode.postMessage({ type: 'setAccessMode', mode: access.dataset.access }); closeMenus(); } else if (language) { vscode.postMessage({ type: 'setLanguage', language: language.dataset.language }); closeMenus(); } else if (!event.target.closest('.setting')) closeMenus(); });
let endpointSaveTimer; let generationSaveTimer; function saveEndpointWhenReady() { clearTimeout(endpointSaveTimer); endpointSaveTimer = setTimeout(() => { const endpoint = document.getElementById('endpoint'); const token = document.getElementById('endpointToken'); if (!endpoint || !token) return; try { new URL(endpoint.value.trim()); } catch { return; } vscode.postMessage({ type: 'setEndpoint', endpoint: endpoint.value, token: token.value, clearToken: false }); }, 900); } function saveGenerationWhenReady() { clearTimeout(generationSaveTimer); generationSaveTimer = setTimeout(() => vscode.postMessage({ type: 'setGeneration', temperature: document.getElementById('temperature').value, contextWindow: document.getElementById('contextWindow').value }), 250); }
document.addEventListener('input', event => { if (event.target.id === 'temperature') document.getElementById('temperatureValue').textContent = event.target.value; if (event.target.id === 'endpoint' || event.target.id === 'endpointToken') saveEndpointWhenReady(); });
document.addEventListener('change', event => { if (event.target.id === 'temperature' || event.target.id === 'contextWindow') saveGenerationWhenReady(); });
document.addEventListener('wheel', event => { if (event.target.id !== 'temperature') return; event.preventDefault(); const control = event.target; const step = Number(control.step) || .05; const next = Math.max(Number(control.min), Math.min(Number(control.max), Number(control.value) + (event.deltaY < 0 ? step : -step))); control.value = String(Math.round(next * 100) / 100); document.getElementById('temperatureValue').textContent = control.value; saveGenerationWhenReady(); }, { passive: false });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && imageViewer.classList.contains('open')) { closeImageViewer(); return; } if (event.target.id === 'customModel' && event.key === 'Enter') { event.preventDefault(); vscode.postMessage({ type: 'pullModel', model: event.target.value }); } });
const resizeHandle = document.getElementById('composerResize'); resizeHandle.addEventListener('pointerdown', event => { const startY = event.clientY; const startHeight = input.getBoundingClientRect().height; resizeHandle.setPointerCapture(event.pointerId); const move = next => { const height = Math.max(70, Math.min(window.innerHeight - 130, startHeight + startY - next.clientY)); input.style.height = `${height}px`; }; const up = () => { resizeHandle.removeEventListener('pointermove', move); resizeHandle.removeEventListener('pointerup', up); }; resizeHandle.addEventListener('pointermove', move); resizeHandle.addEventListener('pointerup', up); });
document.getElementById('attach').onclick = () => resourceInput.click();
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
window.addEventListener('message', event => { const message = event.data; if (message.type === 'historyCleared') { streamed.clear(); chat.innerHTML = '<div class="status">Ready</div>'; } if (message.type === 'historySnapshot') { streamed.clear(); chat.replaceChildren(); for (const item of message.messages || []) add(item.kind, item.text, item.id, item.attachments, false, item.createdAt, item.replyTo); for (const stream of message.streams || []) { streamed.set(stream.id, stream); add('assistant', stream.text, stream.id, [], false, stream.createdAt); } working = Boolean(message.working); submit.classList.toggle('working', working); submit.title = working ? 'Stop' : 'Send'; if (stickToBottom) chat.scrollTop = chat.scrollHeight; else chat.scrollTop = Math.min(Number(restoredState.scrollTop) || 0, chat.scrollHeight); } if (message.type === 'message') { streamed.delete(message.id); add(message.kind, message.text, message.id, message.attachments, true, message.createdAt, message.replyTo); } if (message.type === 'assistantDelta') { const current = streamed.get(message.id) || { text: '', createdAt: message.createdAt }; current.text += message.delta; current.createdAt ||= message.createdAt; streamed.set(message.id, current); add('assistant', current.text, message.id, [], true, current.createdAt); } if (message.type === 'assistantClear') { streamed.delete(message.id); document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)?.remove(); } if (message.type === 'messageDeleted') document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)?.remove(); if (message.type === 'runState') { working = Boolean(message.working); submit.classList.toggle('working', working); submit.title = working ? 'Stop' : 'Send'; } if (message.type === 'settings') renderSettings(message); if (message.type === 'about') renderAbout(message); if (message.type === 'openSettings') toggleMenu(message.menu === 'model' ? 'modelMenu' : 'permissionsMenu'); if (message.type === 'resourceSaved') { const upload = uploads.get(message.clientId); if (upload) { upload.item.path = message.path; uploads.delete(message.clientId); upload.resolve(); } } if (message.type === 'resourceError') { const upload = uploads.get(message.clientId); if (upload) { const index = queuedAttachments.indexOf(upload.item); if (index >= 0) queuedAttachments.splice(index, 1); uploads.delete(message.clientId); upload.resolve(); renderQueuedAttachments(); } add('status', `Attachment error: ${message.message}`); } });
vscode.postMessage({ type: 'ready' });
