// Профили качества и выбор подходящего режима для текущего рендерера.
window.TownGame.quality = (() => {
'use strict';

const { UI, STORAGE_KEYS, gameStorage } = window.TownGame.core;

const profiles = Object.freeze({
  low: Object.freeze({
    key: 'low', label: 'низкое', maxLights: 8,
    shadowLights: 0, shadowSamples: 1,
    rainDensity: .35, fogEvery: 4
  }),
  medium: Object.freeze({
    key: 'medium', label: 'среднее', maxLights: 18,
    shadowLights: 6, shadowSamples: 2,
    rainDensity: .65, fogEvery: 2
  }),
  high: Object.freeze({
    key: 'high', label: 'высокое', maxLights: Infinity,
    shadowLights: Infinity, shadowSamples: 8,
    rainDensity: 1, fogEvery: 1
  })
});

const allowed = new Set(['auto', 'low', 'medium', 'high']);
let choice = gameStorage.get(STORAGE_KEYS.quality, 'auto');
if (!allowed.has(choice)) choice = 'auto';
let renderer = 'pending';

const resolvedKey = () => choice === 'auto'
  ? (renderer === 'webgl' ? 'medium' : 'low')
  : choice;

function syncUI() {
  UI.quality.value = choice;
  const profile = profiles[resolvedKey()];
  const rendererLabel = renderer === 'webgl' ? 'WebGL' : renderer === 'canvas2d' ? 'Canvas 2D' : 'определение…';
  UI.qualityStatus.textContent = choice === 'auto'
    ? `авто: ${profile.label} · ${rendererLabel}`
    : `${profile.label} · ${rendererLabel}`;
}

UI.quality.addEventListener('change', () => {
  choice = allowed.has(UI.quality.value) ? UI.quality.value : 'auto';
  gameStorage.set(STORAGE_KEYS.quality, choice);
  syncUI();
});

syncUI();

return Object.freeze({
  profiles,
  get choice() { return choice; },
  get current() { return profiles[resolvedKey()]; },
  setRenderer(value) {
    renderer = value === 'webgl' ? 'webgl' : 'canvas2d';
    syncUI();
  }
});
})();
