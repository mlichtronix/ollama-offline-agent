'use strict';

// ToolBroker is the execution boundary between an untrusted model response
// and host-owned tools. It intentionally has no filesystem/network authority;
// the extension supplies the actual executor after this validation succeeds.

function availableToolNames(tools) {
  return new Set((tools || []).map(tool => tool?.function?.name).filter(Boolean));
}

function toolPhase(name) {
  if (['web_search', 'web_fetch', 'web_download', 'read_downloaded_web_file', 'search_downloaded_web_file', 'list_browsers', 'browser_open', 'search_chat_history', 'read_chat_messages', 'list_files', 'read_file', 'search_text', 'share_file_excerpt'].includes(name)) return 'work';
  if (['write_file', 'delete_file', 'save_skill'].includes(name)) return 'implement';
  if (name === 'run_command') return 'verify';
  if (['git_status', 'git_diff', 'git_log', 'rollback_last_change'].includes(name)) return 'review';
  return 'work';
}

function prepareToolCall(call, tools) {
  const name = String(call?.function?.name || '');
  if (!name) return { ok: false, tool: '', kind: 'invalid_call', content: 'Tool call is missing a function name.' };
  if (!availableToolNames(tools).has(name)) return { ok: false, tool: name, kind: 'blocked', content: `Tool ${name} is not available in the current task state.` };
  let args;
  try { args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : call.function.arguments || {}; }
  catch { return { ok: false, tool: name, kind: 'invalid_call', content: `Tool ${name} received invalid JSON arguments.` }; }
  if (!args || Array.isArray(args) || typeof args !== 'object') return { ok: false, tool: name, kind: 'invalid_call', content: `Tool ${name} arguments must be a JSON object.` };
  return { ok: true, tool: name, args, phase: toolPhase(name), call: { function: { name, arguments: JSON.stringify(args) } } };
}

function toolResult(prepared, value) {
  if (!prepared?.ok) return { ok: false, tool: prepared?.tool || '', kind: prepared?.kind || 'invalid_call', phase: prepared?.phase || 'work', content: String(prepared?.content || 'Invalid tool call.') };
  const content = String(value || '');
  const blocked = /^(?:Blocked by guardrail:|Blocked:|Plan mode is read-only.|Deleting files requires|User denied)/i.test(content);
  const failed = /^Tool error:|^Invalid tool arguments JSON\./i.test(content);
  return { ok: !blocked && !failed, tool: prepared.tool, kind: blocked ? 'blocked' : failed ? 'error' : 'success', phase: prepared.phase, content };
}

function serializeToolResult(result) {
  return JSON.stringify({ ok: Boolean(result?.ok), tool: String(result?.tool || ''), kind: String(result?.kind || 'error'), phase: String(result?.phase || 'work'), content: String(result?.content || '') });
}

function parseToolResult(value) {
  try {
    const result = JSON.parse(String(value || ''));
    if (typeof result?.ok === 'boolean' && typeof result?.tool === 'string' && typeof result?.content === 'string') return result;
  } catch {}
  return { ok: !/^Tool error:|^Blocked:/i.test(String(value || '')), tool: '', kind: 'legacy', phase: 'work', content: String(value || '') };
}

module.exports = { availableToolNames, toolPhase, prepareToolCall, toolResult, serializeToolResult, parseToolResult };
