const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

test('security controls remain present', () => {
  assert.match(source, /realpathSync\.native/);
  assert.match(source, /isSensitiveTarget/);
  assert.match(source, /stopProcessTree/);
  assert.match(source, /rollback_last_change/);
  assert.match(source, /Allow for this task/);
  assert.match(source, /approvedCommands\.clear\(\)/);
});

test('Ollama context and streaming remain configured', () => {
  assert.match(source, /num_ctx/);
  assert.match(source, /stream: true/);
  assert.match(source, /api\/chat/);
  assert.match(source, /describeExecutionEnvironment/);
  assert.match(source, /configured VS Code integrated-terminal profile/);
  assert.match(source, /search_chat_history/);
  assert.match(source, /read_chat_messages/);
  assert.match(source, /most recent assistant answer is always supplied as candidate context/);
  assert.match(source, /latestAssistantContext/);
  assert.match(source, /function steer\(/);
  assert.match(source, /function queueAgentRequest/);
  assert.match(source, /queuedAgentRequests/);
  const chatSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
  assert.match(chatSource, /data-steering-mode/);
  assert.match(chatSource, /Queue follow-up/);
});

test('remote Ollama configuration keeps credentials out of workspace settings', () => {
  const chatSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
  assert.match(source, /function ollamaFetch/);
  assert.match(source, /Authorization: `Bearer \$\{endpointToken\}`/);
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
});

test('chat rendering preserves inline-code table pipes and exposes copy/reply actions', () => {
  const chatSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
  const chatStyles = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.css'), 'utf8');
  assert.match(chatSource, /function tableCells/);
  assert.match(chatSource, /data-copy-table/);
  assert.match(chatSource, /copySvg/);
  assert.match(chatSource, /replySvg/);
  assert.match(chatSource, /selectedExcerpt/);
  assert.match(chatSource, /getFullYear\(\).*getMonth\(\).*getSeconds\(\)/s);
  assert.match(chatSource, /renderAbout/);
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
  assert.match(chatStyles, /\.steering-menu\s*\{\s*left:\s*50%;\s*width:\s*112px/);
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
  assert.match(packageScript, /ollama-offline-agent-\$version\.vsix/);
  assert.match(packageScript, /UTF8Encoding\(\$false\)/);
});
