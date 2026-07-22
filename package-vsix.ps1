$ErrorActionPreference = 'Stop'
$PSDefaultParameterValues['*:Encoding'] = 'utf8'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$packageSource = Get-Content -Raw -Encoding utf8 (Join-Path $root 'package.json') | ConvertFrom-Json
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$parts = @($packageSource.version -split '\.')
$revision = 0
try { $revision = [int](& git -C $root rev-list --count HEAD 2>$null) } catch {}
if ($revision -le 0) { $revision = [int]$parts[2] }
$version = "$($parts[0]).$($parts[1]).$revision"
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ('ollama-agent-vsix-' + [guid]::NewGuid())
$extension = Join-Path $stage 'extension'
New-Item -ItemType Directory -Path $extension -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'package.json'), (Join-Path $root 'extension.js'), (Join-Path $root 'README.md'), (Join-Path $root 'extension.vsixmanifest'), (Join-Path $root '[Content_Types].xml') -Destination $extension
Copy-Item -LiteralPath (Join-Path $root 'media') -Destination $extension -Recurse
Copy-Item -LiteralPath (Join-Path $root 'lib') -Destination $extension -Recurse
$packageSource.version = $version
[System.IO.File]::WriteAllText((Join-Path $extension 'package.json'), ($packageSource | ConvertTo-Json -Depth 32), $utf8NoBom)
# VS Code expects these two files in the VSIX archive root, not in extension/.
Move-Item -LiteralPath (Join-Path $extension 'extension.vsixmanifest') -Destination (Join-Path $stage 'extension.vsixmanifest')
Move-Item -LiteralPath (Join-Path $extension '[Content_Types].xml') -Destination (Join-Path $stage '[Content_Types].xml')
$manifest = Join-Path $stage 'extension.vsixmanifest'
[System.IO.File]::WriteAllText($manifest, ((Get-Content -Raw -Encoding utf8 $manifest) -replace 'Version="[^"]+" Publisher=', ('Version="{0}" Publisher=' -f $version)), $utf8NoBom)
$out = Join-Path $root "ollama-offline-agent-$version.vsix"
if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }
$zip = Join-Path $root "ollama-offline-agent-$version.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
Move-Item -LiteralPath $zip -Destination $out
Remove-Item -LiteralPath $stage -Recurse -Force
Write-Host "Created $out (version $version)"
