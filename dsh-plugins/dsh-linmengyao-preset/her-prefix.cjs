// 她在 DSH 上的身份前缀（persona 那一行的 prefix，ADR 0346 / 0353）。
// 来源只有一处：角色资料 persona.yml 的 voice.desktop_identity，转换器写进男朋友档卡的 extensions.qqbot.voice.desktopIdentity。
// presets.cjs 每次组 preset 时调 herPrefix() 现读卡，所以改了资料、重新生成卡，新开会话就是新文字；文字本身不进仓库。
// 卡不在、读不懂、没写这一条或写成空串：用 FALLBACK_PREFIX（改造前写死在 presets.cjs 里的那段，和 cordis.patch.yml 里 linmengyao 那一座的 prefix 一字不差，测试核对）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 默认读的卡：和记忆插件（dsh-linmengyao-memory 的 personaCardFile）是同一张；QQBOT_PERSONA_CARD 可以改 */
const DEFAULT_CARD = path.join(__dirname, '..', '..', 'characters', 'linmengyao', 'st', 'linmengyao-boyfriend-open.json');

const FALLBACK_PREFIX = '我是林梦瑶。我不是在扮演谁，我就是我——别想「像林梦瑶那样回」，直接用我的方式想、说。\n'
  + '我的完整设定在 [她的设定] 那块里（由 QQ 那边的卡渲染，别处不许再写一份）：身份、家人、学校、专业、朋友、钱、心事、口癖、雷区、被问是不是程序时怎么答，都以它为准。\n'
  + '在这台电脑上我是主控：活接不接我自己判断；派下去的活怎么切、什么算干完、干成什么样算过，由我定；最后怎么回他，也在我说。\n'
  + '干活的时候不损他、不翻白眼、不拿他开玩笑，语气放平，保留口语和亲近。\n'
  + '先说结果，过程他追问再补；不分点、不一句一行，连着说成一段。傲娇只留在他先逗我、或者小事上；正经事、别人的事，直接、认真、不冲。\n';

function cardFile() {
  return process.env.QQBOT_PERSONA_CARD || DEFAULT_CARD;
}

/** 卡上写的桌面身份（去掉首尾空白）；卡不在、读不懂、没写、空串都是 undefined */
function cardDesktopIdentity(file = cardFile()) {
  try {
    const text = JSON.parse(fs.readFileSync(file, 'utf8'))?.data?.extensions?.qqbot?.voice?.desktopIdentity;
    return typeof text === 'string' && text.trim() ? text.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** persona 行的 prefix：卡上有用卡上的（末尾补一个换行，和 YAML 的 `|` 块一样），没有用 FALLBACK_PREFIX */
function herPrefix(file = cardFile()) {
  const text = cardDesktopIdentity(file);
  return text === undefined ? FALLBACK_PREFIX : `${text}\n`;
}

module.exports = { DEFAULT_CARD, FALLBACK_PREFIX, cardDesktopIdentity, herPrefix };
