// 语音合成旁路（ADR 0140）：机器人需要发语音时，起一个这样的子进程，念完一句话就退出——模型常驻要占 400 多 MB，6 GB 的虚拟机担不起。
// 在本机、离线跑 sherpa-onnx 的中文语音合成（Melo 或 Kokoro），不联网、不要 key，聊天内容不会发给任何第三方。
// 输入：stdin 一段 JSON { engineDir, model: 'melo' | 'kokoro', speaker, speed, text, out }；输出：stdout 最后一行 JSON { ok, seconds, sampleRate } 或 { ok: false, error }。
// 安装在 engineDir（默认 runtime/voice）里：npm 包 sherpa-onnx-node + models/ 下的模型，安装步骤见 docs/adr/0140-voice.md。
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

const fail = error => { process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error).slice(0, 300) })}\n`); process.exit(1); };

let input = '';
for await (const chunk of process.stdin) input += chunk;
let request;
try { request = JSON.parse(input); } catch { fail('请求不是 JSON'); }
const { engineDir, model = 'melo', speaker = 0, speed = 1, text, out } = request;
if (!engineDir || !text || !out) fail('缺 engineDir / text / out');

try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* 设不了就算了 */ }

const require = createRequire(join(engineDir, 'package.json'));
let sherpa;
try { sherpa = require('sherpa-onnx-node'); } catch (error) { fail(`没装 sherpa-onnx-node（${engineDir}）：${error.message}`); }

const models = join(engineDir, 'models');
const dirs = { melo: 'vits-melo-tts-zh_en', kokoro: 'kokoro-int8-multi-lang-v1_1' };
const root = join(models, dirs[model] ?? '');
if (!dirs[model] || !existsSync(root)) fail(`模型不在：${root}`);

const config = model === 'kokoro'
    ? {
        model: {
            kokoro: {
                model: join(root, 'model.int8.onnx'), voices: join(root, 'voices.bin'), tokens: join(root, 'tokens.txt'),
                dataDir: join(root, 'espeak-ng-data'), dictDir: join(root, 'dict'),
                lexicon: [join(root, 'lexicon-us-en.txt'), join(root, 'lexicon-zh.txt')].join(','),
            },
            debug: false, numThreads: 2, provider: 'cpu',
        },
        ruleFsts: ['date-zh.fst', 'phone-zh.fst', 'number-zh.fst'].map(file => join(root, file)).join(','),
        maxNumSentences: 1,
    }
    : {
        model: {
            vits: { model: join(root, 'model.onnx'), tokens: join(root, 'tokens.txt'), lexicon: join(root, 'lexicon.txt'), dictDir: join(root, 'dict') },
            debug: false, numThreads: 2, provider: 'cpu',
        },
        ruleFsts: ['date.fst', 'phone.fst', 'number.fst'].map(file => join(root, file)).join(','),
        maxNumSentences: 1,
    };

try {
    const tts = new sherpa.OfflineTts(config);
    const audio = tts.generate({ text, sid: speaker, speed });
    const samples = audio.samples;
    if (!samples?.length) fail('合成出来是空的');
    // 响度：这些模型出来的声音偏小（Melo 峰值才 0.2），QQ 里点开听不清——把均方根拉到约 0.09，峰值不超过 0.95
    let sum = 0; let peak = 0;
    for (const s of samples) { sum += s * s; peak = Math.max(peak, Math.abs(s)); }
    const rms = Math.sqrt(sum / samples.length) || 1e-6;
    const gain = Math.min(0.09 / rms, 0.95 / (peak || 1), 8);
    // 开头留 150 毫秒静音、结尾 120 毫秒淡出，免得点开有爆音
    const sr = audio.sampleRate;
    const lead = Math.round(sr * 0.15); const fade = Math.round(sr * 0.12);
    const shaped = new Float32Array(lead + samples.length + Math.round(sr * 0.1));
    for (let i = 0; i < samples.length; i++) {
        const tail = samples.length - i;
        shaped[lead + i] = samples[i] * gain * (tail < fade ? tail / fade : 1);
    }
    sherpa.writeWave(out, { samples: shaped, sampleRate: sr });
    process.stdout.write(`${JSON.stringify({ ok: true, seconds: shaped.length / sr, sampleRate: sr })}\n`);
} catch (error) {
    fail(error);
}
