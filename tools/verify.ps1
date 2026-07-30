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

  $streetLayoutTest = & node (Join-Path $PSScriptRoot 'test-street-layout.js') 2>&1
  if ($LASTEXITCODE -ne 0) {
    $problems.Add("Street layout test failed:`n$streetLayoutTest")
  }

  $seededTownTest = & node (Join-Path $PSScriptRoot 'test-seeded-town.js') 2>&1
  if ($LASTEXITCODE -ne 0) {
    $problems.Add("Seeded town test failed:`n$seededTownTest")
  }

  $simDeterminismTest = & node (Join-Path $PSScriptRoot 'test-sim-determinism.js') 2>&1
  if ($LASTEXITCODE -ne 0) {
    $problems.Add("Simulation determinism test failed:`n$simDeterminismTest")
  }

  $coopRulesTest = & node (Join-Path $PSScriptRoot 'test-coop-rules.js') 2>&1
  if ($LASTEXITCODE -ne 0) {
    $problems.Add("Co-op rules test failed:`n$coopRulesTest")
  }

  $presentationTest = & node (Join-Path $PSScriptRoot 'test-presentation.js') 2>&1
  if ($LASTEXITCODE -ne 0) {
    $problems.Add("Presentation seam test failed:`n$presentationTest")
  }

  $relayFramesTest = & node (Join-Path $PSScriptRoot 'test-relay-frames.js') 2>&1
  if ($LASTEXITCODE -ne 0) {
    $problems.Add("Relay framing test failed:`n$relayFramesTest")
  }

  $snapshotTest = & node (Join-Path $PSScriptRoot 'test-snapshot.js') 2>&1
  if ($LASTEXITCODE -ne 0) {
    $problems.Add("Snapshot test failed:`n$snapshotTest")
  }

  $predictionTest = & node (Join-Path $PSScriptRoot 'test-prediction.js') 2>&1
  if ($LASTEXITCODE -ne 0) {
    $problems.Add("Prediction test failed:`n$predictionTest")
  }

  $infightingTest = & node (Join-Path $PSScriptRoot 'test-infighting.js') 2>&1
  if ($LASTEXITCODE -ne 0) {
    $problems.Add("Infighting test failed:`n$infightingTest")
  }
}

$indexPath = Join-Path $project 'index.html'
$html = Get-Content -Raw -LiteralPath $indexPath
$references = [regex]::Matches($html, '(?:src|href)="([^"]+)"') |
  ForEach-Object { $_.Groups[1].Value }

$expectedScripts = @(
  'src/namespace.js?v=20260730-69',
  'src/core.js?v=20260730-69',
  'src/quality.js?v=20260730-69',
  'src/audio.js?v=20260730-69',
  'src/car-physics.js?v=20260730-69',
  'src/environment.js?v=20260730-69',
  'src/world.js?v=20260730-69',
  'src/physics.js?v=20260730-69',
  'src/input.js?v=20260730-69',
  'src/gameplay.js?v=20260730-69',
  'src/lighting.js?v=20260730-69',
  'src/entities.js?v=20260730-69',
  'src/render.js?v=20260730-69',
  'src/net.js?v=20260730-69',
  'src/main.js?v=20260730-69'
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

$moduleNames = @('core', 'quality', 'audio', 'carPhysics', 'environment', 'world', 'physics', 'input', 'gameplay', 'lighting', 'entities', 'render', 'net')
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

$inputSource = Get-Content -Raw -LiteralPath (Join-Path $project 'src\input.js')
if ($inputSource -match '\be\.key\b' -or -not $inputSource.Contains('const code = e.code;')) {
  $problems.Add('Keyboard controls must use physical KeyboardEvent.code values, not layout-dependent key labels.')
}
foreach ($controlCode in @('KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyM', 'KeyP', 'Space', 'KeyC')) {
  if (-not $inputSource.Contains($controlCode)) {
    $problems.Add("Physical keyboard control is missing: $controlCode")
  }
}

$gameplaySource = Get-Content -Raw -LiteralPath (Join-Path $project 'src\gameplay.js')
# Devices are read in one place and written onto the courier as a record, so the rules can move a
# courier holding this keyboard and a courier whose keystrokes crossed a network with one path.
foreach ($actionCode in @('keys.Space', 'keys.KeyK', 'keys.KeyE')) {
  if (-not $inputSource.Contains($actionCode)) {
    $problems.Add("Physical gameplay action is missing: $actionCode")
  }
}
foreach ($recordField in @('function readLocalInput(', 'rec.torchSeq', 'rec.sneakSeq', 'rec.aimScreen')) {
  if (-not $inputSource.Contains($recordField)) {
    $problems.Add("The input record is incomplete: $recordField")
  }
}
foreach ($stepField in @('function stepCourier(', 'p.in', 'inp.torchSeq !== p.torchSeen', 'readLocalInput(g, g.p)')) {
  if (-not $gameplaySource.Contains($stepField)) {
    $problems.Add("The courier step must be driven by the input record: $stepField")
  }
}
foreach ($stealthFeature in @('NOTICE_SNEAK', 'NOTICE_SNEAK_FILL', 'CONTACT_NOTICE_PAD',
    'touching ? 1', 'resolveZombieContact(g, z, courier)', 'SNEAK_SPEED', 'p.sneaking', 'p.stealthNotice', 'stealthDetected')) {
  if (-not $gameplaySource.Contains($stealthFeature)) {
    $problems.Add("Stealth crawling behavior is missing: $stealthFeature")
  }
}

# Health, ammunition, what is carried and how noticed a courier is belong to the courier rather
# than to the district, so a second one can exist without sharing a magazine with the first.
foreach ($courierFeature in @('g.players', 'p.hp', 'p.ammo', 'p.carried', 'downCourier',
    'hurt(g, p,', 'fire(g, p)', 'takedownTarget(g, p)')) {
  if (-not $gameplaySource.Contains($courierFeature)) {
    $problems.Add("Per-courier state is missing: $courierFeature")
  }
}
$worldSource = Get-Content -Raw -LiteralPath (Join-Path $project 'src\world.js')
if (-not $worldSource.Contains('function makeCourier(') -or
    -not $worldSource.Contains('players, p: players[0]')) {
  $problems.Add('Couriers must be built by makeCourier into a roster the district holds.')
}

# The horde, the traffic, the weather and the light all have to cope with more than one courier,
# and a courier on the ground has to be worth walking back for.
foreach ($coopFeature in @('function noticeFor(', 'function nearestCourier(', 'z.prey = prey',
    'function pickerAt(', 'function reviveCouriers(', 'REVIVE_TIME', 'function actCourier(',
    'b.carrier = taker.id')) {
  if (-not $gameplaySource.Contains($coopFeature)) {
    $problems.Add("Two-courier behavior is missing: $coopFeature")
  }
}
$environmentSource = Get-Content -Raw -LiteralPath (Join-Path $project 'src\environment.js')
if (-not $environmentSource.Contains('function revealAround(') -or
    -not $environmentSource.Contains('for (const p of g.players) revealAround(')) {
  $problems.Add('Fog of war must be revealed by every courier on the shift.')
}
if (-not $environmentSource.Contains('function nearestPlayer(')) {
  $problems.Add('Traffic and weather must react to the nearest courier, not to a fixed one.')
}
# A peer that is not running the rules still owns its own senses. The pieces are called from the
# exact lines they occupied inside update, because several of them are position-sensitive.
foreach ($presentFeature in @('function presentFrame(', 'function listenFor(', 'function ageRings(',
    'function ageCarSmoke(', 'function ageBlasts(', 'function ageDebris(', 'function playEvents(',
    'update, presentFrame')) {
  if (-not $gameplaySource.Contains($presentFeature)) {
    $problems.Add("The presentation seam is incomplete: $presentFeature")
  }
}
foreach ($eventFeature in @('function emit(', 'function shakeAt(', 'const EV = Object.freeze(',
    'emit(g, EV.ring, x, y, r)', 'function updateWeatherVisuals(')) {
  if (-not $environmentSource.Contains($eventFeature)) {
    $problems.Add("The event channel is incomplete: $eventFeature")
  }
}
if (-not $gameplaySource.Contains('stepCourier(g, p, dt, predicted = false)') -or
    -not $gameplaySource.Contains('if (!predicted) makeNoise(g, p.x, p.y,')) {
  $problems.Add('A predicted courier step must not be able to alert the horde.')
}
if ($gameplaySource.Contains('g.shake = Math.max(g.shake, 1);')) {
  $problems.Add('Screen shake must be measured from the local courier through shakeAt, not set flat.')
}
# A shared district belongs to both ends: only the one running the rules may stop it, and the
# other has to be told the shift is over rather than watching a frame that stopped moving.
foreach ($shiftFeature in @('function watchDistrictEnd(', 'g.endShown')) {
  if (-not $gameplaySource.Contains($shiftFeature)) {
    $problems.Add("A guest must be shown the end of a district: $shiftFeature")
  }
}
if (-not $inputSource.Contains('net.authoritative()') -or -not $inputSource.Contains('net.sendPause(')) {
  $problems.Add('Only the peer running the rules may pause a shared district.')
}
if (-not $mainSource.Contains('authoritative()')) {
  $problems.Add('The loop must choose between running the rules and only presenting them.')
}

# Two browsers work one district by growing the same town from one seed and proving it matched,
# never by sending the district itself.
$netSource = Get-Content -Raw -LiteralPath (Join-Path $project 'src/net.js')
foreach ($netFeature in @('const PROTOCOL', "role !== 'guest'", 'function hostDistrict(',
    'function declareLayout(', "t: 'join'", "t: 'ready'", 'available',
    'function encodeSnapshot(', 'function applySnapshot(', 'function pump(', 'function hostTick(',
    'function applyRemoteInput(', 'function lerpAngle(', 'const DELAY',
    'function predict(', 'function reconcile(', 'const SNAP_AT')) {
  if (-not $netSource.Contains($netFeature)) {
    $problems.Add("The co-op session is incomplete: $netFeature")
  }
}
if (-not $mainSource.Contains('function buildSeeded(') -or
    -not $mainSource.Contains('Math.random = previous')) {
  $problems.Add('A co-op district must be grown from a shared seed and the generator put back.')
}
if (-not $worldSource.Contains('function layoutChecksum(')) {
  $problems.Add('Peers must be able to prove they built the same district.')
}
$relaySource = Get-Content -Raw -LiteralPath (Join-Path $project 'tools/relay.js')
foreach ($relayFeature in @('258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 'function createParser(',
    'fragmented frames are not supported', 'require.main === module')) {
  if (-not $relaySource.Contains($relayFeature)) {
    $problems.Add("The relay is incomplete: $relayFeature")
  }
}
if ($relaySource.Contains('Sec-WebSocket-Extensions:')) {
  $problems.Add('The relay must not accept permessage-deflate: it cannot inflate.')
}

$lightingCouriers = Get-Content -Raw -LiteralPath (Join-Path $project 'src\lighting.js')
# A lamp points down: a compact patch on the asphalt plus a weak lift that casts nothing.
foreach ($lampLightFeature in @('LAMP_POOL_R', 'LAMP_HAZE_R', 'haze.flat = true', '!l.flat', '!L.flat')) {
  if (-not $lightingCouriers.Contains($lampLightFeature)) {
    $problems.Add("Street lamp light is missing its shape: $lampLightFeature")
  }
}
$renderSource = Get-Content -Raw -LiteralPath (Join-Path $project 'src/render.js')
if (-not $renderSource.Contains('function drawTracers(') -or
    -not $renderSource.Contains('drawTracers(g, camx, camy)')) {
  $problems.Add('Tracers must be composited above the night lighting, not painted into the world.')
}
if (-not $lightingCouriers.Contains('for (const courier of g.players)')) {
  $problems.Add('Every courier must contribute their own flashlight, footing and muzzle flash.')
}
if (-not $inputSource.Contains('sneakPresses++') -or
    -not $gameplaySource.Contains('p.sneakToggle = !p.sneakToggle')) {
  $problems.Add('Crawl must be toggled by a single KeyC press rather than held continuously.')
}

foreach ($damageThreshold in @('damage >= .3', 'damage >= .7', 'damage >= .9')) {
  if (-not $gameplaySource.Contains($damageThreshold)) {
    $problems.Add("Zombie dismemberment threshold is missing: $damageThreshold")
  }
}
foreach ($dismembermentFeature in @('severZombiePart', 'g.zombieParts', "kind === 'arm'")) {
  if (-not $gameplaySource.Contains($dismembermentFeature)) {
    $problems.Add("Zombie dismemberment behavior is missing: $dismembermentFeature")
  }
}
foreach ($headPhysicsFeature in @('kickZombieHead', "part.kind !== 'head'", 'circleCarContact(car, part.x', 'headKicks')) {
  if (-not $gameplaySource.Contains($headPhysicsFeature)) {
    $problems.Add("Persistent zombie-head physics is missing: $headPhysicsFeature")
  }
}
# A grudge between two of the horde is a brawl, not an execution.
if (-not $gameplaySource.Contains('INFIGHT_SCALE') -or
    -not $gameplaySource.Contains('FILTH_DMG * INFIGHT_SCALE') -or
    -not $gameplaySource.Contains('swing * INFIGHT_SCALE')) {
  $problems.Add('Blows between two of the horde must be scaled down from what they cost a courier.')
}
foreach ($explosiveHeadFeature in @('explodeZombieHead', 'shootZombieHead', 'head.shotHits', 'g.blasts', "SND.play('headBlast'", "z.kind === 'tank'")) {
  if (-not $gameplaySource.Contains($explosiveHeadFeature)) {
    $problems.Add("Explosive tank-head behavior is missing: $explosiveHeadFeature")
  }
}
$audioSource = Get-Content -Raw -LiteralPath (Join-Path $project 'src\audio.js')
# A gunshot outdoors is mostly its reflections: without them the sharpest transient still sounds
# like a click. The response is generated once, from its own generator, so building it cannot
# shift the stream the town is grown from.
foreach ($shotFeature in @('function buildStreetTail(', 'function outdoors(', 'function impulse(',
    'createConvolver')) {
  if (-not $audioSource.Contains($shotFeature)) {
    $problems.Add("The gunshot is missing its street: $shotFeature")
  }
}
if (-not $audioSource.Contains("case 'headBlast'")) {
  $problems.Add('Explosive tank-head audio is missing.')
}

$qualitySource = Get-Content -Raw -LiteralPath (Join-Path $project 'src\quality.js')
if (-not $qualitySource.Contains('foliageShadows: true') -or
    ([regex]::Matches($qualitySource, 'foliageShadows: false')).Count -ne 2) {
  $problems.Add('Detailed foliage shadows must be enabled only by the HIGH quality profile.')
}
$lightingSource = Get-Content -Raw -LiteralPath (Join-Path $project 'src\lighting.js')
foreach ($lightingFeature in @('forEachFoliageLobe', 'profile.foliageShadows', 'l.lampRgb', 'softNear(g',
    'foliageTransmission', 'buildFoliageData', 'return max(.55, transmission)',
    'buildRoofVerts', 'roofP', 'ROOF_AMB', "lctx.fillStyle = 'rgba(10,14,38,.68)'")) {
  if (-not $lightingSource.Contains($lightingFeature)) {
    $problems.Add("Detailed lighting behavior is missing: $lightingFeature")
  }
}
$worldSource = Get-Content -Raw -LiteralPath (Join-Path $project 'src\world.js')
foreach ($worldLightingFeature in @('LAMP_TEMPERATURES', 'lampRgb:', "foliage: 'tree'", "foliage: 'bush'",
    'function lampGlow(', 'LAMP_FAULTY_SHARE', 'faulty: seed <')) {
  if (-not $worldSource.Contains($worldLightingFeature)) {
    $problems.Add("World lighting data is missing: $worldLightingFeature")
  }
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

Write-Host "Verification passed: $($references.Count) resources, 13 isolated subsystems, valid load order and JavaScript, English-only project text."
