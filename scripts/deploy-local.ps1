param([switch]$PrepareOnly, [switch]$VerifyOnly)

$ErrorActionPreference = 'Stop'
if ($PrepareOnly -and $VerifyOnly) { throw 'PrepareOnly and VerifyOnly cannot be combined.' }
$sourceRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$targetRoot = [IO.Path]::GetFullPath('D:\projectAJ\client\trunk\extensions\figma-importer-cocos')
$expectedParent = [IO.Path]::GetFullPath('D:\projectAJ\client\trunk\extensions')
$workRoot = Join-Path $sourceRoot 'node_modules\.local-deploy'
$stageRoot = Join-Path $workRoot 'stage'
$runtimeEntries = @('package.json', 'dist', 'static', 'i18n', 'mcp-dist', 'LICENSE', 'THIRD-PARTY-NOTICES.txt')

function Assert-Contained([string]$Path, [string]$Root) {
    $absolute = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (-not $absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path escapes the intended directory: $absolute"
    }
}

function Assert-NoLinks([string]$Path, [switch]$Recurse) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing linked path: $Path" }
    if ($Recurse -and $item.PSIsContainer) {
        foreach ($child in Get-ChildItem -LiteralPath $Path -Force) { Assert-NoLinks $child.FullName -Recurse }
    }
}

function Assert-Runtime([string]$Root) {
    foreach ($entry in $runtimeEntries) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $entry))) { throw "Missing runtime entry: $entry" }
    }
    foreach ($entry in @('dist\main.js', 'dist\scene.js', 'dist\panels\default\index.js',
        'static\template\default\index.html', 'static\style\default\index.css',
        'i18n\zh.js', 'i18n\en.js', 'mcp-dist\server.js')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $entry) -PathType Leaf)) { throw "Missing runtime file: $entry" }
    }
}

function Get-RuntimeHashes([string]$Root) {
    $hashes = @{}
    foreach ($file in Get-ChildItem -LiteralPath $Root -Recurse -File -Force) {
        Assert-Contained $file.FullName $Root
        $relative = $file.FullName.Substring($Root.TrimEnd('\').Length + 1)
        $hashes[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    }
    return $hashes
}

function Confirm-Deployment {
    Assert-Runtime $targetRoot
    Assert-NoLinks $targetRoot -Recurse
    $entries = @(Get-ChildItem -LiteralPath $targetRoot -Force | ForEach-Object Name)
    if (Compare-Object ($runtimeEntries | Sort-Object) ($entries | Sort-Object)) { throw 'Target contains unexpected entries.' }
    $expected = Get-RuntimeHashes $stageRoot
    $actual = Get-RuntimeHashes $targetRoot
    if ($expected.Count -ne $actual.Count) { throw 'Deployed file count differs from staged runtime.' }
    foreach ($key in $expected.Keys) {
        if ($actual[$key] -ne $expected[$key]) { throw "Deployed file hash mismatch: $key" }
    }
    $installed = Get-Content -LiteralPath (Join-Path $targetRoot 'package.json') -Raw | ConvertFrom-Json
    Write-Output "Verified $($installed.name) $($installed.version): $($actual.Count) runtime files."
}

if ((Split-Path -Parent $targetRoot) -ne $expectedParent -or (Split-Path -Leaf $targetRoot) -ne 'figma-importer-cocos') {
    throw 'Unexpected deployment target.'
}
foreach ($entry in $runtimeEntries) { Assert-NoLinks (Join-Path $sourceRoot $entry) -Recurse }
Assert-Runtime $sourceRoot
$manifest = Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw | ConvertFrom-Json
if ($manifest.name -ne 'figma-importer-cocos') { throw 'Unexpected source extension name.' }
foreach ($property in @('scripts', 'devDependencies')) { $manifest.PSObject.Properties.Remove($property) }

# Validate all target ancestors and contents before staging any destructive action.
for ($ancestor = Get-Item -LiteralPath $targetRoot -Force; $null -ne $ancestor; $ancestor = $ancestor.Parent) {
    Assert-NoLinks $ancestor.FullName
}
Assert-NoLinks $targetRoot -Recurse
if (Test-Path -LiteralPath (Join-Path $targetRoot '.git')) { throw 'Refusing to replace a Git checkout.' }
for ($ancestor = Get-Item -LiteralPath (Join-Path $sourceRoot 'node_modules') -Force; $null -ne $ancestor; $ancestor = $ancestor.Parent) {
    Assert-NoLinks $ancestor.FullName
}
if (Test-Path -LiteralPath $workRoot) { Assert-NoLinks $workRoot -Recurse }
New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
Assert-Contained $stageRoot $workRoot
if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
New-Item -ItemType Directory -Path $stageRoot | Out-Null
foreach ($entry in $runtimeEntries) {
    if ($entry -ne 'package.json') { Copy-Item -LiteralPath (Join-Path $sourceRoot $entry) -Destination $stageRoot -Recurse -Force }
}
[IO.File]::WriteAllText((Join-Path $stageRoot 'package.json'), ($manifest | ConvertTo-Json -Depth 100) + "`n", [Text.UTF8Encoding]::new($false))
Assert-Runtime $stageRoot
if ($PrepareOnly) {
    $staged = Get-RuntimeHashes $stageRoot
    Write-Output "Prepared $($manifest.name) $($manifest.version): $($staged.Count) runtime files at $stageRoot"
    exit 0
}
if ($VerifyOnly) { Confirm-Deployment; exit 0 }

$backupRoot = Join-Path $workRoot ('backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 6))
Assert-Contained $backupRoot $workRoot
New-Item -ItemType Directory -Path $backupRoot | Out-Null
foreach ($item in Get-ChildItem -LiteralPath $targetRoot -Force) {
    Copy-Item -LiteralPath $item.FullName -Destination $backupRoot -Recurse -Force
}

try {
    foreach ($item in Get-ChildItem -LiteralPath $targetRoot -Force) {
        Assert-Contained $item.FullName $targetRoot
        Remove-Item -LiteralPath $item.FullName -Recurse -Force
    }
    foreach ($item in Get-ChildItem -LiteralPath $stageRoot -Force) {
        Copy-Item -LiteralPath $item.FullName -Destination $targetRoot -Recurse -Force
    }
    Confirm-Deployment
    Write-Output "Deployed to $targetRoot"
    Write-Output "Previous extension backed up at $backupRoot"
} catch {
    $deploymentError = $_
    foreach ($item in Get-ChildItem -LiteralPath $targetRoot -Force) {
        Assert-Contained $item.FullName $targetRoot
        Remove-Item -LiteralPath $item.FullName -Recurse -Force
    }
    foreach ($item in Get-ChildItem -LiteralPath $backupRoot -Force) {
        Copy-Item -LiteralPath $item.FullName -Destination $targetRoot -Recurse -Force
    }
    throw $deploymentError
}
