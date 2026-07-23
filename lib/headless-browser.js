'use strict';

// A deliberately small browser runner. It uses an installed Chromium browser,
// a disposable profile, and a loopback proxy that refuses private destinations.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const cp = require('child_process');
const http = require('http');
const net = require('net');
const dns = require('dns').promises;

function privateIp(value) {
  const ip = String(value || '').toLowerCase();
  if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')) return true;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}
function browserCandidates() {
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
    return [
      ...roots.map(root => ({ id: 'chrome', name: 'Google Chrome', executable: path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), engine: 'chromium' })),
      ...roots.map(root => ({ id: 'edge', name: 'Microsoft Edge', executable: path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), engine: 'chromium' })),
      ...roots.map(root => ({ id: 'firefox', name: 'Mozilla Firefox', executable: path.join(root, 'Mozilla Firefox', 'firefox.exe'), engine: 'firefox' }))
    ];
  }
  if (process.platform === 'darwin') return [
    { id: 'chrome', name: 'Google Chrome', executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', engine: 'chromium' },
    { id: 'edge', name: 'Microsoft Edge', executable: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', engine: 'chromium' },
    { id: 'firefox', name: 'Mozilla Firefox', executable: '/Applications/Firefox.app/Contents/MacOS/firefox', engine: 'firefox' }
  ];
  return [
    { id: 'chrome', name: 'Google Chrome', executable: '/usr/bin/google-chrome', engine: 'chromium' },
    { id: 'chromium', name: 'Chromium', executable: '/usr/bin/chromium', engine: 'chromium' },
    { id: 'edge', name: 'Microsoft Edge', executable: '/usr/bin/microsoft-edge', engine: 'chromium' },
    { id: 'firefox', name: 'Mozilla Firefox', executable: '/usr/bin/firefox', engine: 'firefox' }
  ];
}
function discoverBrowsers() {
  const seen = new Set();
  return browserCandidates().filter(item => fs.existsSync(item.executable)).filter(item => {
    const key = item.executable.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true;
  }).map(item => ({ ...item, headless: item.engine === 'chromium' }));
}
async function publicAddress(host) {
  const name = String(host || '').replace(/^\[|\]$/g, '');
  if (!name || name.toLowerCase() === 'localhost' || name.toLowerCase().endsWith('.local')) throw new Error('Private browser destination is blocked.');
  if (net.isIP(name)) { if (privateIp(name)) throw new Error('Private browser destination is blocked.'); return name; }
  const records = await dns.lookup(name, { all: true, verbatim: true });
  if (!records.length || records.some(item => privateIp(item.address))) throw new Error('Browser destination resolves to a private address and is blocked.');
  return records[0].address;
}
function targetUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP(S) browser URLs are allowed.');
  return url;
}
async function createFilteringProxy() {
  const observed = new Set();
  const server = http.createServer(async (request, response) => {
    try {
      const target = targetUrl(request.url); const address = await publicAddress(target.hostname); observed.add(target.toString());
      const upstream = http.request({ protocol: 'http:', hostname: address, port: Number(target.port) || 80, method: request.method, path: target.pathname + target.search, headers: { ...request.headers, host: target.host }, agent: false }, upstreamResponse => { response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers); upstreamResponse.pipe(response); });
      upstream.once('error', error => { if (!response.headersSent) response.writeHead(502); response.end(String(error.message || error)); }); request.pipe(upstream);
    } catch (error) { response.writeHead(403); response.end(`Blocked browser request: ${error.message}`); }
  });
  server.on('connect', async (request, socket, head) => {
    // Browsers routinely cancel speculative requests; a closed tunnel is not
    // a proxy failure and must never become an unhandled Node socket error.
    socket.on('error', () => {});
    try {
      const parsed = new URL('https://' + request.url); const address = await publicAddress(parsed.hostname); const port = Number(parsed.port) || 443; observed.add(`https://${parsed.host}/`);
      const upstream = net.connect({ host: address, port }, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head?.length) upstream.write(head); upstream.pipe(socket); socket.pipe(upstream); });
      upstream.on('error', () => { if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
      socket.on('close', () => { if (!upstream.destroyed) upstream.destroy(); });
    } catch (error) { socket.end(`HTTP/1.1 403 Forbidden\r\n\r\n${error.message}`); }
  });
  server.on('clientError', (_error, socket) => { socket.destroy(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const port = server.address().port;
  return { port, observed, close: () => new Promise(resolve => server.close(() => resolve())) };
}
async function renderPage(browser, url, waitMs = 8000) {
  if (!browser?.headless) throw new Error('Select an installed Chromium-based browser (Edge, Chrome, or Chromium) for headless rendering.');
  const target = targetUrl(url); await publicAddress(target.hostname);
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'ollama-agent-browser-')); const proxy = await createFilteringProxy();
  const timeout = Math.max(2000, Math.min(15000, Number(waitMs) || 8000));
  try {
    const args = ['--headless=new', '--disable-gpu', '--in-process-gpu', '--disable-software-rasterizer', '--disable-gpu-compositing', '--disable-gpu-shader-disk-cache', '--disable-gpu-program-cache', '--disable-features=Vulkan,UseSkiaRenderer', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--disable-popup-blocking', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--proxy-bypass-list=<-loopback>', `--proxy-server=http://127.0.0.1:${proxy.port}`, `--user-data-dir=${profile}`, `--virtual-time-budget=${timeout}`, '--dump-dom', target.toString()];
    const html = await new Promise((resolve, reject) => cp.execFile(browser.executable, args, { windowsHide: true, timeout: timeout + 10000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}${stderr ? `: ${stderr}` : ''}`)) : resolve(stdout)));
    return { html: String(html || ''), observedUrls: [...proxy.observed] };
  } finally { await proxy.close().catch(() => {}); await fsp.rm(profile, { recursive: true, force: true }).catch(() => {}); }
}

module.exports = { discoverBrowsers, renderPage };
