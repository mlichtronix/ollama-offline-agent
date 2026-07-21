# Ollama Offline Coding Agent for VS Code

Ollama Offline Coding Agent is a local, tool-using coding assistant for Visual Studio Code. It connects to an Ollama server at `http://127.0.0.1:11434` by default and is designed to keep prompts, project data, conversation history, and model inference on the local machine.

## Features

- Secondary Sidebar chat experience for VS Code.
- Streaming responses, with tool activity and supported model thinking written to the **Ollama Offline Agent** Output channel.
- Local project file inspection, search, editing, shell commands, Git status/diff/log, and user-approved reusable playbooks.
- Per-project conversation history stored in `.ollama-agent/chat-history.json`.
- File and image attachments through drag and drop or the paperclip control.
- Local model selection, model download by name, response language selection, temperature, and context-window controls.
- Workspace, guarded system, and full system access modes. Writes and commands require explicit user approval.

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

The chat stores visible messages locally for the current workspace. A self-contained request is sent without prior conversation context. Requests that explicitly continue prior work, such as “continue”, “fix it”, or “test it again”, include recent relevant history. Historical image attachments are restored for these follow-up requests when available.

The agent presents only user-facing messages in chat. Tool calls, command output, and model thinking are written to **View: Output** → **Ollama Offline Agent**.

Attachments are saved under `.ollama-agent/resources/` and are not intended for source control. Images are supplied to the model only when the selected model supports vision.

## Access Modes

| Mode | Scope |
| --- | --- |
| Workspace | File operations and commands are limited to the open workspace. |
| Guarded system | Absolute paths are available; protected system locations remain blocked. |
| Full system | Paths accessible to the current Windows user, including local installers, are available after explicit approval. Destructive command guardrails remain active. |

Every file write, command execution, and playbook save requires confirmation. Review each approval carefully, especially in full system mode.

## Model Settings

The model menu provides:

- **Heat**: sampling temperature.
- **Context**: `Auto`, 4K, 8K, 16K, 32K, 64K, 128K, or 256K tokens. Larger context windows consume more memory.
- **Language**: response language, with `Auto` following the newest user message.

The context setting is passed to the native Ollama API as `options.num_ctx`. Select a value appropriate for the model and available RAM/VRAM.

## Development

Open this repository in VS Code and press `F5` to start an Extension Development Host.

Create a VSIX package:

```powershell
powershell -ExecutionPolicy Bypass -File .\package-vsix.ps1
```

## Release Process

1. Update the version in `package.json` and `extension.vsixmanifest`.
2. Build the VSIX with `package-vsix.ps1`.
3. Validate the extension in an Extension Development Host.
4. Commit the release changes, create and push tag `v<version>`.
5. Create a GitHub Release from the tag and upload the generated VSIX as an asset.
6. Update the release notes with installation instructions and notable changes.

## Privacy and Local Data

The extension uses the configured local Ollama endpoint. Do not change that endpoint to a remote service unless you intentionally want prompts and project context to leave the machine. Remove `.ollama-agent/` to delete the local conversation history and saved attachment copies for a workspace.
