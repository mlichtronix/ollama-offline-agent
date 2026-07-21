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
  assert.match(chatSource, /function tableCells/);
  assert.match(chatSource, /data-copy-table/);
  assert.match(chatSource, /copySvg/);
  assert.match(chatSource, /replySvg/);
  assert.match(chatSource, /selectedExcerpt/);
  assert.match(chatSource, /getFullYear\(\).*getMonth\(\).*getSeconds\(\)/s);
  assert.match(chatSource, /renderAbout/);
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
});

test('the package script derives a unique VSIX version from Git history', () => {
  const packageScript = fs.readFileSync(path.join(__dirname, '..', 'package-vsix.ps1'), 'utf8');
  assert.match(packageScript, /git -C \$root rev-list --count HEAD/);
  assert.match(packageScript, /ollama-offline-agent-\$version\.vsix/);
  assert.match(packageScript, /UTF8Encoding\(\$false\)/);
});
