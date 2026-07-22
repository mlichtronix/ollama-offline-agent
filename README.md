# Ollama Offline Coding Agent for VS Code

Ollama Offline Coding Agent is a local, tool-using coding assistant for Visual Studio Code. It connects to an Ollama server at `http://127.0.0.1:11434` by default and is designed to keep prompts, project data, conversation history, and model inference on the local machine.

The extension is **offline-first**: it remains functional without a network connection. Network access is optional rather than assumed; local project work and local-only Git repositories do not require a remote service.

> **Disclaimer:** This software is provided **as is**, without warranty of any kind. You use it entirely at your own risk. The author accepts no responsibility for data loss, security incidents, incorrect output, failed commands, costs, or any other direct or indirect consequences of using the extension. Review every proposed command and file change before approving it, and keep backups of important work.

## Features

- Secondary Sidebar chat experience for VS Code.
- Streaming responses, with tool activity and supported model thinking written to the **Ollama Offline Agent** Output channel.
- Local project file inspection, search, editing, shell commands, Git status/diff/log, and user-approved reusable playbooks.
- Per-project conversation history stored in `.ollama-agent/chat-history.json`.
- File and image attachments through drag and drop or the paperclip control.
- Public-web search and page retrieval, explicitly enabled with the **Globe** control. Sources used for an answer are shown below it and retained in local history.
- Local model selection, model download by name, response language selection, temperature, and context-window controls.
- Workspace, guarded system, and full system access modes. Writes and commands require explicit user approval.
- **Steer** and **Queue** modes for follow-up instructions while the agent is working.
- Optional parallel Ollama workers for independent research before the master agent begins execution.
- Markdown tables and fenced code blocks, including lightweight Lua syntax highlighting for ` ```lua ` blocks.

## Requirements

- Visual Studio Code 1.85 or later.
- A local [Ollama](https://ollama.com/) installation and at least one installed model.
- A model with tool calling support. Vision-capable models are required for image analysis.

Verify the local Ollama service:

```powershell
ollama list
Invoke-RestMethod http://127.0.0.1:11434/api/version
```

## Installation

1. Download the `.vsix` asset from the project's GitHub Releases page.
2. In VS Code, run **Extensions: Install from VSIX...** and select the downloaded file.
3. Run **Developer: Reload Window**.

Alternatively:

```powershell
code --install-extension .\ollama-offline-agent-<version>.vsix
```

Open the **Ollama Agent** view and move it to the Secondary Sidebar if desired. The model menu lists the models installed in the local Ollama instance. Entering a model name and pressing Enter selects an installed model or requests Ollama to download it.

## Usage

The chat stores visible messages locally for the current workspace. Prior messages are not preloaded into each model request. When earlier discussion is relevant, the agent searches the complete local history and reads only the messages needed for the current task; this avoids both unrelated context and arbitrary recent-message limits.

The agent presents only user-facing messages in chat. Tool calls, command output, and model thinking are written to **View: Output** → **Ollama Offline Agent**.

Attachments are saved under `.ollama-agent/resources/` and are not intended for source control. Images are supplied to the model only when the selected model supports vision.

Hover a user message to use the pencil action. It moves that prompt to the composer and removes that prompt and all later messages from visible history and model context. Edit it, then send it to create a clean replacement branch. Hover any user or assistant message to reveal its delete action.

While a response is running, an empty composer shows **Stop**. With text in the composer, select either **Steer** to interrupt the current step and continue with the new instruction, or **Queue** to run the follow-up after the current work completes.

## Read-only Workers

Use the **Server-plus** control in the composer to add up to eight Ollama workers. Each worker has a name, an Ollama-compatible HTTP endpoint, a model name, an optional Bearer token, and an enabled state. Tokens are stored per worker in VS Code Secret Storage. Load the models installed on a worker into the model picker, or enter a custom `model:tag`. The **Check** action verifies availability without starting a task.

Before a new master task starts, enabled workers are checked in parallel. The planner may skip delegation for a narrow task; otherwise it selects only the number of experts justified by the task, up to the workerMaxTasks setting (default: 3). The master then creates a delegation plan: each selected worker is assigned a distinct expert role and non-overlapping read-only subtask, while the master retains implementation, integration, and verification. Independent assignments run in parallel. A later expert may explicitly depend on an earlier report; the host waits for that report and passes only the relevant handoff to the dependent expert, capped at 12,000 characters total. Cyclic dependency plans are rejected in favor of the safe independent fallback plan. Assignments and results are written to the Output channel. Full worker reports are retained as internal local chat-history records; they do not clutter the chat UI, but the master can retrieve a specific report by its ID when it needs detail beyond the compact handoff.

Each available expert receives an English assignment and produces an English internal report, regardless of the language selected for the chat. The master is the only component that communicates with the user and uses the selected response language. Each expert can use only these tools through the master host:

- Search and read the local chat history.
- List, search, and read files in the open workspace.
- Search and retrieve public web pages when the shared **Globe** setting is enabled.

Workers cannot write files, run shell commands, change Git state, install software, or access attachments as image pixels. Their final handoff uses a structured schema with findings, confidence, evidence, risks, next steps, and unverified items. The host marks an evidence URL as fetched only when that worker actually retrieved it with \`web_fetch\` during the task; a report that does not meet the schema is retained as an unverified legacy report. Before handing a result to the master, the host requests one automatic correction for malformed reports, empty handoffs, or claims marked verified without host-fetched evidence. Their findings are returned to the master as research leads; the master must inspect the relevant evidence and performs all edits and tests. Sources must match the claim: standards and protocol semantics require an official specification or standards body, package facts require official project documentation or registry metadata, and legal/service facts require an official publisher or register. A vendor blog can substantiate only the vendor's own claims, not universal technical behavior. For time-sensitive external claims—such as package versions, release dates, prices, laws, or service availability—workers must provide the exact authoritative source URL. Search snippets, model memory, and secondary summaries are not verification; the master must qualify or omit any claim lacking direct support. Architecture tradeoffs are presented as conditional analysis, not universal rules. Worker endpoints therefore receive the task, their assigned subtask, any history or workspace excerpts selected by the worker, and enabled public-web results. Configure only servers you trust.

## Access Modes

| Mode | Scope |
| --- | --- |
| Workspace | File operations and commands are limited to the open workspace. |
| Guarded system | Absolute paths are available; protected system locations remain blocked. |
| Full system | Paths accessible to the current Windows user, including local installers, are available after explicit approval. Destructive command guardrails remain active. |

Every file write, command execution, and playbook save requires confirmation. Review each approval carefully, especially in full system mode.

Before an agent file write, the extension records a local checkpoint and writes a concise diff preview to the Output channel. The agent can request restoration of its most recent file change; restoration also requires confirmation.

## Model Settings

The model menu provides:

- **Heat**: sampling temperature.
- **Context**: `Auto`, 4K, 8K, 16K, 32K, 64K, 128K, or 256K tokens. Larger context windows consume more memory.
- **Language**: response language, with `Auto` following the newest user message.

The context setting is passed to the native Ollama API as `options.num_ctx`. Select a value appropriate for the model and available RAM/VRAM.

## Web Access

The extension is offline-first. Public web access is disabled by default and is never required for local coding work.

Use the **Globe-off** icon in the composer to enable it. Its icon changes to **Globe** when enabled and the preference is stored in VS Code settings. The agent can then use `web_search` and `web_fetch` for public HTTP(S) pages. Localhost, private IP ranges, LAN addresses, `.local` hosts, embedded URL credentials, and non-HTTP(S) schemes are blocked.

After a web-assisted answer, the extension shows the consulted sources beneath the message. Favicons are fetched by the extension host and stored as local `data:` images with the message, so they remain available after a reload. If the network, search provider, or target website fails, the agent should report that limitation rather than fabricate a result.

## Development

Open this repository in VS Code and press `F5` to start an Extension Development Host.

Create a VSIX package:

```powershell
powershell -ExecutionPolicy Bypass -File .\package-vsix.ps1
```

## Release Process

`package-vsix.ps1` derives the package patch version from the current Git commit count. Consequently, every committed change produces a newer VSIX identity without manually editing `package.json` or `extension.vsixmanifest`. The script applies the derived version consistently to both files inside the generated archive.

1. Validate the extension in an Extension Development Host.
2. Build the VSIX with `package-vsix.ps1`.
3. Commit and push the validated change.
4. Create and push a matching `v<version>` tag when publishing a GitHub Release.
5. Publish the generated VSIX asset with release notes.

## Privacy and Local Data

The extension uses `http://127.0.0.1:11434` by default. You can configure an Ollama-compatible HTTP endpoint from the model menu for a server on your LAN or a cloud service. Remote endpoints receive the prompt plus only the project context, tool results, and attachments that the agent selects as relevant for inference. The extension asks for confirmation before using a non-local address. Public web access is separate from the inference endpoint and remains off unless enabled with the Globe control.

Master and worker Bearer tokens are stored separately in VS Code Secret Storage, never in the workspace, chat-history file, or `settings.json`. This feature is for Ollama-compatible `/api/*` services; it does not turn arbitrary OpenAI-compatible APIs into Ollama endpoints. Removing a worker also removes its saved token. Remove `.ollama-agent/` to delete the local conversation history and saved attachment copies for a workspace.
