$ErrorActionPreference = 'Stop'
$PSDefaultParameterValues['*:Encoding'] = 'utf8'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ('ollama-agent-vsix-' + [guid]::NewGuid())
$extension = Join-Path $stage 'extension'
New-Item -ItemType Directory -Path $extension -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'package.json'), (Join-Path $root 'extension.js'), (Join-Path $root 'README.md'), (Join-Path $root 'extension.vsixmanifest'), (Join-Path $root '[Content_Types].xml') -Destination $extension
Copy-Item -LiteralPath (Join-Path $root 'media') -Destination $extension -Recurse
# VS Code expects these two files in the VSIX archive root, not in extension/.
Move-Item -LiteralPath (Join-Path $extension 'extension.vsixmanifest') -Destination (Join-Path $stage 'extension.vsixmanifest')
Move-Item -LiteralPath (Join-Path $extension '[Content_Types].xml') -Destination (Join-Path $stage '[Content_Types].xml')
$out = Join-Path $root 'ollama-offline-agent-0.1.0.vsix'
if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }
$zip = Join-Path $root 'ollama-offline-agent-0.1.0.zip'
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
Move-Item -LiteralPath $zip -Destination $out
Remove-Item -LiteralPath $stage -Recurse -Force
Write-Host "Created $out"
