// 装本机语音引擎（ADR 0140）：sherpa-onnx 的 Node 包 + 一个中文语音合成模型，装到 runtime/voice（可用 --dir 改）。
// node scripts/voice-install.mjs [--dir runtime/voice] [--model kokoro|melo]
// 做的事：写 package.json 钉死 sherpa-onnx-node 2.0.0 → npm install（--ignore-scripts，包里是预编译的原生库，不跑安装脚本）→
// 从 k2-fsa/sherpa-onnx 的 GitHub release 下载模型，核对 SHA-256，解压 → 合成一句“你好”自检。
// 下载的是不受信任的文件：核对不上就删掉、不解压。装好后在 koishi.yml 里加 voice: true 才会用（默认关）。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const dir = resolve(arg('dir') ?? join(root, 'runtime', 'voice'));
const model = arg('model') ?? 'kokoro';

/** 模型：release 资产名、文件夹名、SHA-256（kokoro 的和 GitHub 公布的摘要一致；melo 的是 2026-10-24 下载后自己算的） */
const MODELS = {
    kokoro: { asset: 'kokoro-int8-multi-lang-v1_1.tar.bz2', folder: 'kokoro-int8-multi-lang-v1_1', sha256: 'a1e94694776049035c4f2c6529f003aaece993c76aae9a78995831c3c4dcafc6' },
    melo: { asset: 'vits-melo-tts-zh_en.tar.bz2', folder: 'vits-melo-tts-zh_en', sha256: 'e58351ed7149f290a54534538badd4077cdbe6fddc964b24d0bee870415d1514' },
};
const spec = MODELS[model];
if (!spec) { console.error(`不认识的模型 ${model}，应为 ${Object.keys(MODELS).join(' / ')}`); process.exit(2); }

mkdirSync(join(dir, 'models'), { recursive: true });
mkdirSync(join(dir, 'dl'), { recursive: true });
console.log(`安装目录 ${dir}`);

// 1. npm 包
writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'qqbot-voice-engine', private: true, version: '1.0.0', dependencies: { 'sherpa-onnx-node': '2.0.0' } }, null, 2)}\n`);
if (!existsSync(join(dir, 'node_modules', 'sherpa-onnx-node'))) {
    console.log('npm install sherpa-onnx-node@2.0.0 …');
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
} else {
    console.log('sherpa-onnx-node 已经装了');
}

// 2. 模型
const target = join(dir, 'models', spec.folder);
if (existsSync(target)) {
    console.log(`模型 ${spec.folder} 已经在了`);
} else {
    const archive = join(dir, 'dl', spec.asset);
    const url = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${spec.asset}`;
    console.log(`下载 ${url} …`);
    const response = await fetch(url);
    if (!response.ok || !response.body) { console.error(`下载失败：HTTP ${response.status}`); process.exit(1); }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
    const { createReadStream } = await import('node:fs');
    const hash = createHash('sha256');
    await pipeline(createReadStream(archive), hash);
    const got = hash.digest('hex');
    if (got !== spec.sha256) {
        rmSync(archive, { force: true });
        console.error(`SHA-256 对不上（${got}，应为 ${spec.sha256}），已删除，不解压`);
        process.exit(1);
    }
    console.log('SHA-256 核对通过，解压 …');
    execFileSync('tar', ['-xjf', archive, '-C', join(dir, 'models')], { stdio: 'inherit' });
    rmSync(archive, { force: true });
}

// 3. 自检：念一句“你好”
const out = join(dir, 'selftest.wav');
const started = Date.now();
const child = execFileSync(process.execPath, [join(root, 'scripts', 'voice-synth.mjs')], { input: JSON.stringify({ engineDir: dir, model, speaker: 3, speed: 1, text: '你好，我是林梦瑶。', out }), encoding: 'utf8' });
const result = JSON.parse(child.trim().split('\n').at(-1));
rmSync(out, { force: true });
if (!result.ok) { console.error(`自检失败：${result.error}`); process.exit(1); }
console.log(`自检通过：念了一句 ${result.seconds.toFixed(1)} 秒的话，用了 ${((Date.now() - started) / 1000).toFixed(1)} 秒（含加载模型）`);
console.log('下一步：koishi.yml 里加 voice: true（要重启 Koishi）；想换模型 / 说话人 / 语速，加 voiceEngine: { model, speaker, speed }');
