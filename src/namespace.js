// Единственный глобальный объект игры. Все подсистемы публикуют API только здесь.
(function createTownGameNamespace(global) {
  'use strict';
  Object.defineProperty(global, 'TownGame', {
    value: Object.create(null),
    enumerable: false,
    configurable: false,
    writable: false
  });
})(window);
