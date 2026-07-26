$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent $PSScriptRoot
$problems = [Collections.Generic.List[string]]::new()

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $problems.Add('Node.js не найден: проверка синтаксиса JavaScript недоступна.')
} else {
  Get-ChildItem -LiteralPath (Join-Path $project 'src') -Filter '*.js' |
    Sort-Object Name |
    ForEach-Object {
      $output = & node --check $_.FullName 2>&1
      if ($LASTEXITCODE -ne 0) {
        $problems.Add("Ошибка синтаксиса в $($_.Name):`n$output")
      }
    }

  $carDamageTest = & node (Join-Path $PSScriptRoot 'test-car-damage.js') 2>&1
  if ($LASTEXITCODE -ne 0) {
    $problems.Add("Ошибка модели повреждений машин:`n$carDamageTest")
  }
}

$indexPath = Join-Path $project 'index.html'
$html = Get-Content -Raw -LiteralPath $indexPath
$references = [regex]::Matches($html, '(?:src|href)="([^"]+)"') |
  ForEach-Object { $_.Groups[1].Value }

$expectedScripts = @(
  'src/namespace.js?v=20260726-16',
  'src/core.js?v=20260726-16',
  'src/quality.js?v=20260726-16',
  'src/audio.js?v=20260726-16',
  'src/car-physics.js?v=20260726-16',
  'src/environment.js?v=20260726-19',
  'src/world.js?v=20260726-16',
  'src/physics.js?v=20260726-16',
  'src/input.js?v=20260726-16',
  'src/gameplay.js?v=20260726-16',
  'src/lighting.js?v=20260726-19',
  'src/entities.js?v=20260726-17',
  'src/render.js?v=20260726-19',
  'src/main.js?v=20260726-17'
)
$actualScripts = [regex]::Matches($html, '<script\s+src="([^"]+)"') |
  ForEach-Object { $_.Groups[1].Value }

if (($actualScripts -join "`n") -ne ($expectedScripts -join "`n")) {
  $problems.Add("Нарушен порядок загрузки подсистем:`n$($actualScripts -join "`n")")
}

foreach ($reference in $references) {
  $referenceFile = ($reference -split '[?#]')[0]
  $localPath = Join-Path $project ($referenceFile -replace '/', '\')
  if (-not (Test-Path -LiteralPath $localPath)) {
    $problems.Add("Не найден ресурс из index.html: $reference")
  }
}

$moduleNames = @('core', 'quality', 'audio', 'carPhysics', 'environment', 'world', 'physics', 'input', 'gameplay', 'lighting', 'entities', 'render')
foreach ($moduleName in $moduleNames) {
  $moduleFile = if ($moduleName -eq 'carPhysics') { 'car-physics.js' } else { "$moduleName.js" }
  $modulePath = Join-Path $project "src\$moduleFile"
  $moduleSource = Get-Content -Raw -LiteralPath $modulePath
  if (-not $moduleSource.Contains("window.TownGame.$moduleName = (() => {")) {
    $problems.Add("Подсистема $moduleName не зарегистрирована в TownGame.")
  }
  if (-not $moduleSource.Contains('return Object.freeze(')) {
    $problems.Add("Публичный API подсистемы $moduleName не заморожен.")
  }
}

$namespaceSource = Get-Content -Raw -LiteralPath (Join-Path $project 'src\namespace.js')
if (-not $namespaceSource.Contains("Object.defineProperty(global, 'TownGame'")) {
  $problems.Add('Глобальное пространство TownGame не защищено от замены.')
}

$mainSource = Get-Content -Raw -LiteralPath (Join-Path $project 'src\main.js')
if (-not $mainSource.Contains('Object.freeze(window.TownGame)')) {
  $problems.Add('Набор подсистем TownGame не зафиксирован в точке входа.')
}

$referencePath = Join-Path $project 'reference\town.original.html'
$expectedHash = 'C0EE2255D89478A7E6DC505E26AE2A8F4D0E6C377DC8872FC128A04CE1A78E26'
$actualHash = (Get-FileHash -LiteralPath $referencePath -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) {
  $problems.Add('Эталонный HTML отличается от исходного файла.')
}

if ($problems.Count -gt 0) {
  $problems | ForEach-Object { Write-Error $_ }
  exit 1
}

Write-Host "Проверка пройдена: $($references.Count) ресурсов, 12 изолированных подсистем, порядок загрузки и JavaScript корректны, эталонный файл не изменён."
