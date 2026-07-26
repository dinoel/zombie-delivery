// The game's only global object. Every subsystem publishes its API here.
(function createTownGameNamespace(global) {
  'use strict';
  Object.defineProperty(global, 'TownGame', {
    value: Object.create(null),
    enumerable: false,
    configurable: false,
    writable: false
  });
})(window);
