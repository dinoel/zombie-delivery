$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent $PSScriptRoot
$problems = [Collections.Generic.List[string]]::new()

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $problems.Add('Node.js was not found; JavaScript syntax checks are unavailable.')
} else {
  Get-ChildItem -LiteralPath (Join-Path $project 'src') -Filter '*.js' |
    Sort-Object Name |
    ForEach-Object {
      $output = & node --check $_.FullName 2>&1
      if ($LASTEXITCODE -ne 0) {
        $problems.Add("Syntax error in $($_.Name):`n$output")
      }
    }

  $carDamageTest = & node (Join-Path $PSScriptRoot 'test-car-damage.js') 2>&1
  if ($LASTEXITCODE -ne 0) {
    $problems.Add("Vehicle damage model test failed:`n$carDamageTest")
  }
}

$indexPath = Join-Path $project 'index.html'
$html = Get-Content -Raw -LiteralPath $indexPath
$references = [regex]::Matches($html, '(?:src|href)="([^"]+)"') |
  ForEach-Object { $_.Groups[1].Value }

$expectedScripts = @(
  'src/namespace.js?v=20260727-24',
  'src/core.js?v=20260727-24',
  'src/quality.js?v=20260727-24',
  'src/audio.js?v=20260727-24',
  'src/car-physics.js?v=20260727-24',
  'src/environment.js?v=20260727-24',
  'src/world.js?v=20260727-24',
  'src/physics.js?v=20260727-24',
  'src/input.js?v=20260727-24',
  'src/gameplay.js?v=20260727-24',
  'src/lighting.js?v=20260727-24',
  'src/entities.js?v=20260727-24',
  'src/render.js?v=20260727-24',
  'src/main.js?v=20260727-24'
)
$actualScripts = [regex]::Matches($html, '<script\s+src="([^"]+)"') |
  ForEach-Object { $_.Groups[1].Value }

if (($actualScripts -join "`n") -ne ($expectedScripts -join "`n")) {
  $problems.Add("Subsystem load order is incorrect:`n$($actualScripts -join "`n")")
}

foreach ($reference in $references) {
  $referenceFile = ($reference -split '[?#]')[0]
  $localPath = Join-Path $project ($referenceFile -replace '/', '\')
  if (-not (Test-Path -LiteralPath $localPath)) {
    $problems.Add("Resource referenced by index.html was not found: $reference")
  }
}

$moduleNames = @('core', 'quality', 'audio', 'carPhysics', 'environment', 'world', 'physics', 'input', 'gameplay', 'lighting', 'entities', 'render')
foreach ($moduleName in $moduleNames) {
  $moduleFile = if ($moduleName -eq 'carPhysics') { 'car-physics.js' } else { "$moduleName.js" }
  $modulePath = Join-Path $project "src\$moduleFile"
  $moduleSource = Get-Content -Raw -LiteralPath $modulePath
  if (-not $moduleSource.Contains("window.TownGame.$moduleName = (() => {")) {
    $problems.Add("Subsystem $moduleName is not registered on TownGame.")
  }
  if (-not $moduleSource.Contains('return Object.freeze(')) {
    $problems.Add("The public API of subsystem $moduleName is not frozen.")
  }
}

$namespaceSource = Get-Content -Raw -LiteralPath (Join-Path $project 'src\namespace.js')
if (-not $namespaceSource.Contains("Object.defineProperty(global, 'TownGame'")) {
  $problems.Add('The global TownGame namespace is not protected against replacement.')
}

$mainSource = Get-Content -Raw -LiteralPath (Join-Path $project 'src\main.js')
if (-not $mainSource.Contains('Object.freeze(window.TownGame)')) {
  $problems.Add('The TownGame subsystem collection is not frozen at the entry point.')
}

# The frozen reference HTML is guarded by version control, not by a pinned hash here:
# a checked-in hash breaks on line-ending conversion at checkout while the content is intact.

$cyrillicFiles = Get-ChildItem -LiteralPath $project -Recurse -File -Force |
  Where-Object { $_.FullName -notmatch '[\\/]\.git[\\/]' } |
  Select-String -Pattern '[\u0400-\u052F]' -List
if ($cyrillicFiles) {
  $problems.Add("Cyrillic text remains in:`n$($cyrillicFiles.Path -join "`n")")
}

if ($problems.Count -gt 0) {
  $problems | ForEach-Object { Write-Error $_ }
  exit 1
}

Write-Host "Verification passed: $($references.Count) resources, 12 isolated subsystems, valid load order and JavaScript, English-only project text."
