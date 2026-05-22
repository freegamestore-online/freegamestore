const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { loadRegistry } = require('./registry');

describe('registry', () => {
  it('loads games from registry.json', () => {
    const games = loadRegistry(path.join(__dirname, '..', 'registry.json'));
    assert.ok(Array.isArray(games));
    assert.ok(games.length > 0);
    assert.ok(games[0].id);
    assert.ok(games[0].name);
    assert.ok(games[0].appUrl);
  });
});
