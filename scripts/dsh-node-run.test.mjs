import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nodeCommand } from '../dsh-plugins/dsh-qqbot-services/node-run.js';

test('spawned children run the app binary as node instead of opening a second GUI', () => {
    const electron = nodeCommand({ electron: '35.0.0' }, {});
    assert.equal(electron.command, process.execPath);
    assert.equal(electron.env.ELECTRON_RUN_AS_NODE, '1');

    const plain = nodeCommand({}, {});
    assert.equal(plain.command, process.execPath);
    assert.equal(plain.env.ELECTRON_RUN_AS_NODE, undefined);

    const already = nodeCommand({ electron: '35.0.0' }, { ELECTRON_RUN_AS_NODE: '1' });
    assert.equal(already.env.ELECTRON_RUN_AS_NODE, '1');

    const explicit = nodeCommand({ electron: '35.0.0' }, { QQBOT_NODE: 'C:/node.exe' });
    assert.deepEqual([explicit.command, explicit.env.ELECTRON_RUN_AS_NODE], ['C:/node.exe', undefined]);

    const source = {};
    nodeCommand({ electron: '35.0.0' }, source);
    assert.deepEqual(source, {});
});
