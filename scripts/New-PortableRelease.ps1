param(
  [switch]$SkipBuild,
  [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'dist'))
$package = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
$sourcePath = Join-Path $distRoot 'win-unpacked'

if (-not $SkipBuild) {
  Push-Location $projectRoot
  try {
    & npm.cmd run pack
    if ($LASTEXITCODE -ne 0) { throw "Windows packaging failed with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
  throw "Packaged Windows directory not found: $sourcePath"
}

if (-not $OutputPath) {
  $OutputPath = Join-Path $distRoot "RSignals-$($package.version)-win-x64.zip"
} elseif (-not [System.IO.Path]::IsPathRooted($OutputPath)) {
  $OutputPath = Join-Path $projectRoot $OutputPath
}

$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$distPrefix = "$($distRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar))$([System.IO.Path]::DirectorySeparatorChar)"
if (-not $OutputPath.StartsWith($distPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Portable release output must stay inside the project dist directory.'
}
if (Test-Path -LiteralPath $OutputPath) {
  throw "Portable release already exists: $OutputPath"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem

try {
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $sourcePath,
    $OutputPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  $sourceFiles = @(Get-ChildItem -LiteralPath $sourcePath -File -Recurse)
  $archive = [System.IO.Compression.ZipFile]::OpenRead($OutputPath)
  try {
    $entryNames = @($archive.Entries | ForEach-Object FullName)
    if ($entryNames.Count -ne $sourceFiles.Count) {
      throw "ZIP contains $($entryNames.Count) files; expected $($sourceFiles.Count)."
    }
    if ($entryNames -contains '.' -or $entryNames -contains './' -or @($entryNames | Where-Object { $_.StartsWith('./') -or $_.StartsWith('../') }).Count) {
      throw 'ZIP contains Unix-style relative entries that Windows Explorer may reject.'
    }
    if ($entryNames -notcontains 'RSignals.exe') {
      throw 'ZIP does not contain RSignals.exe at its root.'
    }
  } finally {
    $archive.Dispose()
  }

  $shell = New-Object -ComObject Shell.Application
  $explorerArchive = $shell.NameSpace($OutputPath)
  if ($null -eq $explorerArchive -or $explorerArchive.Items().Count -le 0) {
    throw 'Windows Explorer cannot enumerate the portable ZIP.'
  }

  $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $sourcePath 'RSignals.exe')
  if ($signature.Status -ne 'Valid') {
    throw "RSignals.exe signature is not valid: $($signature.Status)"
  }

  $artifact = Get-Item -LiteralPath $OutputPath
  $hash = Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256
  [pscustomobject]@{
    Artifact = $artifact.FullName
    Size = $artifact.Length
    Files = $sourceFiles.Count
    ExplorerTopLevelItems = $explorerArchive.Items().Count
    Signature = $signature.Status
    SHA256 = $hash.Hash
  } | Format-List
} catch {
  if (Test-Path -LiteralPath $OutputPath) {
    Remove-Item -LiteralPath $OutputPath -Force
  }
  throw
}
