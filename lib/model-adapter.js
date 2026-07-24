'use strict';

// The agent runtime must not treat arbitrary model prose as an instruction.
// This adapter is the only compatibility boundary between an Ollama message
// and the runtime. It returns a small, explicit protocol that callers can
// safely route through the task state machine.

function text(value) { return String(value || '').trim(); }

function toolNames(value) {
  return new Set((value || []).map(tool => typeof tool === 'string' ? tool : tool?.function?.name).filter(Boolean));
}

function normalizeCall(value, allowed) {
  const name = value?.function?.name || value?.name;
  const rawArguments = value?.function?.arguments ?? value?.arguments ?? {};
  if (!allowed.has(name)) return undefined;
  let argumentsObject;
  try { argumentsObject = typeof rawArguments === 'string' ? JSON.parse(rawArguments || '{}') : rawArguments; }
  catch { return undefined; }
  if (!argumentsObject || Array.isArray(argumentsObject) || typeof argumentsObject !== 'object') return undefined;
  return { function: { name, arguments: JSON.stringify(argumentsObject) } };
}

function nativeCalls(message, allowed) {
  return (Array.isArray(message?.tool_calls) ? message.tool_calls : []).map(call => normalizeCall(call, allowed)).filter(Boolean);
}

function exactJsonCalls(content, allowed) {
  try {
    const value = JSON.parse(text(content));
    const calls = (Array.isArray(value) ? value : [value]).map(call => normalizeCall(call, allowed)).filter(Boolean);
    return calls.length ? calls : [];
  } catch { return []; }
}

function exactXmlCalls(content, allowed) {
  const source = text(content);
  const matches = [...source.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)];
  if (!matches.length) return [];
  // Do not accept XML embedded in explanation or copied documentation.
  if (source.replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/gi, '').trim()) return [];
  return matches.map(match => {
    try { return normalizeCall(JSON.parse(match[1]), allowed); } catch { return undefined; }
  }).filter(Boolean);
}

function exactPlainCall(content, allowed) {
  const source = text(content);
  const names = [...allowed].map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!names) return [];
  const match = source.match(new RegExp(`^(${names})\\s*(\\{[\\s\\S]*\\})$`));
  if (!match) return [];
  try { const call = normalizeCall({ name: match[1], arguments: JSON.parse(match[2]) }, allowed); return call ? [call] : []; }
  catch { return []; }
}

function isToolProtocolEcho(content) {
  const source = text(content);
  return /for each function call,? return (?:a )?json object/i.test(source)
    || /<tool_call>\s*\{\s*"name"/i.test(source)
    || (/\b(?:tools?|functions?)\b/i.test(source) && /\b(?:parameters?|arguments?)\b/i.test(source) && /\b(?:list_files|read_file|write_file|run_command|web_fetch|browser_open)\b/i.test(source));
}

function isRepetitiveProgressEcho(content) {
  const paragraphs = text(content).replace(/\r/g, '').split(/\n\s*\n/).map(part => part.replace(/\s+/g, ' ').trim().toLowerCase()).filter(part => part.length >= 48);
  const counts = new Map();
  for (const paragraph of paragraphs) counts.set(paragraph, (counts.get(paragraph) || 0) + 1);
  return [...counts.values()].some(count => count >= 3);
}

function classifyModelMessage(message, tools) {
  const allowed = toolNames(tools);
  const native = nativeCalls(message, allowed);
  if (native.length) return { kind: 'tool_call', calls: native, source: 'native' };
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
    const requested = message.tool_calls.map(call => call?.function?.name || call?.name).filter(Boolean).join(', ') || 'unknown';
    return { kind: 'invalid_model_output', reason: `unavailable_tool:${requested}`, content: '' };
  }
  const content = text(message?.content);
  if (!content) return { kind: 'empty', reason: 'empty_content' };
  const fallback = exactJsonCalls(content, allowed);
  if (fallback.length) return { kind: 'tool_call', calls: fallback, source: 'json-fallback' };
  const xml = exactXmlCalls(content, allowed);
  if (xml.length) return { kind: 'tool_call', calls: xml, source: 'xml-fallback' };
  const plain = exactPlainCall(content, allowed);
  if (plain.length) return { kind: 'tool_call', calls: plain, source: 'plain-fallback' };
  if (isToolProtocolEcho(content)) return { kind: 'invalid_model_output', reason: 'tool_protocol_echo', content };
  if (isRepetitiveProgressEcho(content)) return { kind: 'invalid_model_output', reason: 'repetitive_progress_echo', content };
  return { kind: 'final_answer', content };
}

module.exports = { classifyModelMessage, isToolProtocolEcho, isRepetitiveProgressEcho };
