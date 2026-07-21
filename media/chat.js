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
const trashSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>';
const shieldSvg = mode => mode === 'guardedSystem' ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3Z"/><path d="m9 12 2 2 4-4"/></svg>' : mode === 'fullSystem' ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3Z"/><path d="M12 8v4M12 16h.01"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3Z"/></svg>';

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
function markdown(value) {
  const lines = String(value).replace(/\r/g, '').split('\n');
  const out = []; let inCode = false; let code = []; let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith('```')) { closeList(); if (inCode) { out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = []; } inCode = !inCode; continue; }
    if (inCode) { code.push(line); continue; }
    const cells = value => value.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
    if (/^\|?.+\|.+\|?$/.test(line) && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] || '')) {
      closeList(); const headers = cells(line); index += 2; const rows = [];
      while (index < lines.length && /^\|?.+\|.+\|?$/.test(lines[index])) { rows.push(cells(lines[index])); index++; }
      index--; out.push(`<table><thead><tr>${headers.map(cell => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((_, cell) => `<td>${inlineMarkdown(row[cell] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`); continue;
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
    if (String(item.mime || '').startsWith('image/') && (item.data || item.preview)) return `<img class="attachment-image" src="${item.preview || `data:${escapeHtml(item.mime)};base64,${item.data}`}" alt="${name}" title="${name}">`;
    return `<span class="attachment-file" title="${name}">${name}</span>`;
  }).join('');
  return `<div class="message-attachments${temporary ? ' pending-attachments' : ''}">${markup}</div>`;
}
function renderQueuedAttachments() { attachments.innerHTML = attachmentMarkup(queuedAttachments, true); }
function add(kind, text, id, messageAttachments = []) {
  let element = id && chat.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
  if (!element) { element = document.createElement('div'); element.className = 'message ' + kind; if (id) element.dataset.messageId = id; chat.appendChild(element); }
  element.className = 'message ' + kind;
  element.innerHTML = (kind === 'assistant' || kind === 'user') ? markdown(text) : '';
  if (kind !== 'assistant' && kind !== 'user') element.textContent = text;
  if (kind === 'user') element.insertAdjacentHTML('beforeend', attachmentMarkup(messageAttachments));
  if (id && (kind === 'assistant' || kind === 'user')) { const remove = document.createElement('button'); remove.className = 'delete-message'; remove.title = 'Delete message'; remove.innerHTML = trashSvg; remove.onclick = () => vscode.postMessage({ type: 'deleteMessage', id }); element.appendChild(remove); }
  element.scrollIntoView({ block: 'end' });
}
async function send() {
  const text = input.value.trim(); if (!text || sending) return;
  sending = true;
  try {
    await Promise.allSettled([...uploads.values()].map(upload => upload.done));
    const sentAttachments = queuedAttachments.splice(0);
    renderQueuedAttachments();
    const id = crypto.randomUUID(); add('user', text, id, sentAttachments); input.value = '';
    vscode.postMessage({ type: 'prompt', text, id, attachments: sentAttachments.map(({ name, mime, path }) => ({ name, mime, path })) });
  } finally { sending = false; }
}
const languageCodes = 'af am ar as az be bg bn bo br bs ca cs cy da de el en eo es et eu fa fi fil fo fr fy ga gd gl gu he hi hr hu hy id is it ja ka kk km kn ko ku ky la lb lo lt lv mg mi mk ml mn mr ms mt my ne nl no oc or pa pl ps pt qu ro ru sa sd si sk sl so sq sr sv sw ta te tg th tk tl tr tt ug uk ur uz vi wo xh yi yo zh zu'.split(' ');
const languageNames = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' });
function closeMenus() { document.querySelectorAll('.setting-menu.open').forEach(menu => menu.classList.remove('open')); }
function toggleMenu(id) { const menu = document.getElementById(id); const open = !menu.classList.contains('open'); closeMenus(); if (open) menu.classList.add('open'); }
function renderSettings(message) {
  const mode = message.mode || 'workspace'; const permission = document.getElementById('permissions');
  permission.className = `permissions icon-only mode-${mode}`; permission.title = ({ workspace: 'Workspace access', guardedSystem: 'Guarded system access', fullSystem: 'Full system access' })[mode] || 'Permissions'; permission.innerHTML = shieldSvg(mode);
  document.getElementById('permissionsMenu').innerHTML = [['workspace', 'Workspace'], ['guardedSystem', 'Guarded system'], ['fullSystem', 'Full system']].map(([value, label]) => `<button data-access="${value}" class="${value === mode ? 'selected' : ''}">${shieldSvg(value)}<span>${label}</span></button>`).join('');
  document.getElementById('model').title = `Model: ${message.model || 'unknown'}`;
  if (Array.isArray(message.models)) document.getElementById('modelMenu').innerHTML = `<div class="model-controls"><label>Heat <output id="temperatureValue"></output><input id="temperature" type="range" min="0" max="2" step="0.05"></label><label>Context <select id="contextWindow"><option value="0">Auto</option><option value="4096">4K</option><option value="8192">8K</option><option value="16384">16K</option><option value="32768">32K</option><option value="65536">64K</option><option value="131072">128K</option><option value="262144">256K</option></select></label><input id="customModel" placeholder="model:tag — Enter downloads or selects"></div><div class="model-list">${message.models.map(model => `<button data-model="${escapeHtml(model.name)}" class="${model.name === message.model ? 'selected' : ''}">${escapeHtml(model.name)} <small>${model.size} GB</small></button>`).join('') || '<span class="menu-empty">No local models</span>'}</div>`;
  const temperature = document.getElementById('temperature'); const contextWindow = document.getElementById('contextWindow'); if (temperature) { temperature.value = String(message.temperature ?? .2); contextWindow.value = String(message.contextWindow || 0); document.getElementById('temperatureValue').textContent = temperature.value; }
  const current = (message.language || navigator.language || 'en').split('-')[0]; const language = document.getElementById('language'); language.textContent = current.toUpperCase(); language.title = message.languageAuto ? `Auto (${nativeLanguage(current)})` : nativeLanguage(current); document.getElementById('languageMenu').innerHTML = `<button data-language="auto" class="${message.languageAuto ? 'selected' : ''}">Auto</button>${languageCodes.map(code => `<button data-language="${code}" class="${code === current && !message.languageAuto ? 'selected' : ''}"><small>${code.toUpperCase()}</small><span>${escapeHtml(nativeLanguage(code))}</span></button>`).join('')}`;
}
function nativeLanguage(code) { try { return new Intl.DisplayNames([code], { type: 'language' }).of(code) || code; } catch { return languageNames.of(code) || code; } }
submit.onclick = () => { if (working) vscode.postMessage({ type: 'stop' }); else send(); };
document.getElementById('model').onclick = event => { event.stopPropagation(); toggleMenu('modelMenu'); };
document.getElementById('new').onclick = () => vscode.postMessage({ type: 'newChat' });
document.getElementById('permissions').onclick = event => { event.stopPropagation(); toggleMenu('permissionsMenu'); };
document.getElementById('language').onclick = event => { event.stopPropagation(); toggleMenu('languageMenu'); };
document.addEventListener('click', event => { const model = event.target.closest('[data-model]'); const access = event.target.closest('[data-access]'); const language = event.target.closest('[data-language]'); if (model) { vscode.postMessage({ type: 'setModel', model: model.dataset.model }); closeMenus(); } else if (access) { vscode.postMessage({ type: 'setAccessMode', mode: access.dataset.access }); closeMenus(); } else if (language) { vscode.postMessage({ type: 'setLanguage', language: language.dataset.language }); closeMenus(); } else if (!event.target.closest('.setting')) closeMenus(); });
document.addEventListener('input', event => { if (event.target.id === 'temperature') document.getElementById('temperatureValue').textContent = event.target.value; });
document.addEventListener('change', event => { if (event.target.id === 'temperature' || event.target.id === 'contextWindow') vscode.postMessage({ type: 'setGeneration', temperature: document.getElementById('temperature').value, contextWindow: document.getElementById('contextWindow').value }); });
document.addEventListener('keydown', event => { if (event.target.id === 'customModel' && event.key === 'Enter') { event.preventDefault(); vscode.postMessage({ type: 'pullModel', model: event.target.value }); } });
const resizeHandle = document.getElementById('composerResize'); resizeHandle.addEventListener('pointerdown', event => { const startY = event.clientY; const startHeight = input.getBoundingClientRect().height; resizeHandle.setPointerCapture(event.pointerId); const move = next => { const height = Math.max(70, Math.min(window.innerHeight - 130, startHeight + startY - next.clientY)); input.style.height = `${height}px`; }; const up = () => { resizeHandle.removeEventListener('pointermove', move); resizeHandle.removeEventListener('pointerup', up); }; resizeHandle.addEventListener('pointermove', move); resizeHandle.addEventListener('pointerup', up); });
document.getElementById('attach').onclick = () => resourceInput.click();
async function attachFiles(files) {
  for (const file of Array.from(files)) {
    if (file.size > 12 * 1024 * 1024) { add('status', `${file.name}: resource exceeds 12 MB.`); continue; }
    const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = reject; reader.readAsDataURL(file); });
    const clientId = crypto.randomUUID(); const item = { clientId, name: file.name, mime: file.type || 'application/octet-stream', data };
    queuedAttachments.push(item); renderQueuedAttachments();
    let resolve; const done = new Promise(next => { resolve = next; }); uploads.set(clientId, { done, resolve, item });
    vscode.postMessage({ type: 'resource', clientId, name: item.name, mime: item.mime, data });
  }
}
resourceInput.addEventListener('change', () => { attachFiles(resourceInput.files); resourceInput.value = ''; });
composer.addEventListener('dragover', event => { event.preventDefault(); composer.classList.add('dragging'); });
composer.addEventListener('dragleave', () => composer.classList.remove('dragging'));
composer.addEventListener('drop', event => { event.preventDefault(); composer.classList.remove('dragging'); attachFiles(event.dataTransfer.files); });
input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } });
window.addEventListener('message', event => { const message = event.data; if (message.type === 'message') { streamed.delete(message.id); add(message.kind, message.text, message.id, message.attachments); } if (message.type === 'assistantDelta') { const next = (streamed.get(message.id) || '') + message.delta; streamed.set(message.id, next); add('assistant', next, message.id); } if (message.type === 'assistantClear') { streamed.delete(message.id); document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)?.remove(); } if (message.type === 'messageDeleted') document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)?.remove(); if (message.type === 'runState') { working = Boolean(message.working); submit.classList.toggle('working', working); submit.title = working ? 'Stop' : 'Send'; } if (message.type === 'settings') renderSettings(message); if (message.type === 'openSettings') toggleMenu(message.menu === 'model' ? 'modelMenu' : 'permissionsMenu'); if (message.type === 'resourceSaved') { const upload = uploads.get(message.clientId); if (upload) { upload.item.path = message.path; uploads.delete(message.clientId); upload.resolve(); } } if (message.type === 'resourceError') { const upload = uploads.get(message.clientId); if (upload) { const index = queuedAttachments.indexOf(upload.item); if (index >= 0) queuedAttachments.splice(index, 1); uploads.delete(message.clientId); upload.resolve(); renderQueuedAttachments(); } add('status', `Attachment error: ${message.message}`); } });
vscode.postMessage({ type: 'ready' });
