// 别人写的字进她的提示词之前拆掉动作标记的样子（2026-11-26 入站 QQ 审查）。
// 她回复里的 <<执行：…>> <<记住：…>> <<用电脑>> <device:…> 这些会被当成标记办掉；转发的聊天记录、分享卡片、文件名、
// 图上认出来的字、群公告都是第三方写的，原样带着这种字、她照抄一句就成了别人替她下的命令（同 web.ts 的 untrustedText、bilibili 的 material）。
// 只拆标记的样子：连着的两个尖括号、紧跟 device: 的那个尖括号；单个的 < > 照留（>_< 这类颜文字、a<b 这种不动），平常的字一个不变。

/** 拆掉 << >>（含全角）和 <device: 的开头，别的原样 */
export function defuseMarkers(text: string): string {
    return text
        .replace(/[<＜]{2,}/g, '')
        .replace(/[>＞]{2,}/g, '')
        .replace(/[<＜](?=\s*device\s*[:：])/gi, '');
}
