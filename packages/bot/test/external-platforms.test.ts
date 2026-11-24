import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EXTERNAL_PLATFORM_CAPABILITIES, EXTERNAL_PLATFORM_MODES, externalPlatformMode } from '../src/social/external-platforms.ts';

describe('外部内容平台的能力边界', () => {
    test('只认三种明确的模式，其余（未知字符串、大小写不同、空值、非字符串）一律回到关闭', () => {
        assert.deepEqual([...EXTERNAL_PLATFORM_MODES], ['off', 'draft', 'authorized']);
        for (const mode of EXTERNAL_PLATFORM_MODES) assert.equal(externalPlatformMode(mode), mode);
        for (const bad of [undefined, null, '', ' draft', 'Draft', 'AUTHORIZED', 'on', 'publish', true, 1, {}, ['draft']]) {
            assert.equal(externalPlatformMode(bad), 'off', `${JSON.stringify(bad)} 不能被当成开启`);
        }
    });

    test('默认三个平台都关着、都要授权、都只到草稿为止', () => {
        assert.deepEqual(EXTERNAL_PLATFORM_CAPABILITIES.map(c => c.platform), ['tieba', 'douyin', 'xiaohongshu']);
        for (const capability of EXTERNAL_PLATFORM_CAPABILITIES) {
            assert.equal(capability.mode, 'off', `${capability.platform} 默认必须关着`);
            assert.equal(capability.requiresAuthorization, true, `${capability.platform} 必须授权才能调用`);
            assert.equal(capability.draft, true);
            assert.ok(capability.label.trim() && capability.note.trim());
        }
    });

    test('隐私边界：小红书和抖音不默认读取公开内容，小红书说明里写明不抓取、不绕过登录', () => {
        const byPlatform = new Map(EXTERNAL_PLATFORM_CAPABILITIES.map(c => [c.platform, c]));
        assert.equal(byPlatform.get('xiaohongshu')!.readPublic, false);
        assert.equal(byPlatform.get('douyin')!.readPublic, false);
        assert.equal(byPlatform.get('tieba')!.readPublic, true);
        assert.match(byPlatform.get('xiaohongshu')!.note, /不抓取公开笔记/);
        assert.match(byPlatform.get('xiaohongshu')!.note, /不绕过登录/);
        assert.match(byPlatform.get('tieba')!.note, /人工确认/);
    });
});
