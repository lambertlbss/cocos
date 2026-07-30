'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TokenVault } = require('../dist/security/token-vault');

test('falls back to session memory without ever persisting plaintext', async () => {
    const calls = [];
    global.Editor = {
        Profile: {
            getConfig: async (...args) => calls.push(['get', ...args]),
            setConfig: async (...args) => calls.push(['set', ...args]),
            removeConfig: async (...args) => calls.push(['remove', ...args]),
        },
    };
    const vault = new TokenVault('test-package');
    const status = await vault.set('test-token-value');
    assert.equal(status.persistent, false);
    assert.equal(await vault.get(), 'test-token-value');
    assert.equal(calls.some(([method]) => method === 'set'), false);
    await vault.clear();
    await assert.rejects(() => vault.get(), /请先设置/);
});
