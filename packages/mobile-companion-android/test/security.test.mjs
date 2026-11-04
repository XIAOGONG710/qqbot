import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1));
const read = path => readFileSync(join(root, path), 'utf8');

test('Android 壳禁止明文、文件访问和任意 JavaScript 桥', () => {
    const manifest = read('app/src/main/AndroidManifest.xml');
    const activity = read('app/src/main/java/com/linmengyao/companion/MainActivity.kt');
    assert.match(manifest, /usesCleartextTraffic="false"/);
    assert.match(manifest, /allowBackup="false"/);
    assert.match(activity, /allowFileAccess = false/);
    assert.match(activity, /allowContentAccess = false/);
    assert.match(activity, /MIXED_CONTENT_NEVER_ALLOW/);
    assert.match(activity, /handler\.cancel\(\)/);
    assert.doesNotMatch(activity, /addJavascriptInterface/);
    assert.match(activity, /target\.host != configured\.host/);
});
