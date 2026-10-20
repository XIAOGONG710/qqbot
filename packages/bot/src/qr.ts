// 把一段文字画成二维码（ADR 0089：B 站扫码登录要给用户一张能扫的码）。
// 编码用 vendor/qrcodegen.js（Nayuki，MIT），这里只管画：SVG（浏览器直接打开）和终端里的半块字符。

import qrcodegen from './vendor/qrcodegen.js';

/** 二维码的深浅矩阵：[行][列]，true 是深色。纠错用 M 档（B 站的登录链接大约 110 个字符，M 档够用也容易扫） */
export function qrMatrix(text: string): boolean[][] {
    const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
    return Array.from({ length: qr.size }, (_, y) => Array.from({ length: qr.size }, (_, x) => qr.getModule(x, y)));
}

/** SVG：白底黑块，四周留 border 个模块的白边（扫码需要至少 4 个）；用 path 一条画完，文件小 */
export function qrSvg(text: string, border = 4): string {
    const matrix = qrMatrix(text);
    const size = matrix.length + border * 2;
    const cells: string[] = [];
    matrix.forEach((row, y) => row.forEach((dark, x) => { if (dark) cells.push(`M${x + border},${y + border}h1v1h-1z`); }));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 8}" height="${size * 8}" shape-rendering="crispEdges">`
        + `<rect width="100%" height="100%" fill="#ffffff"/><path d="${cells.join('')}" fill="#000000"/></svg>\n`;
}

/**
 * 终端里画：两行模块并成一行字符（上下半块），白底黑块。深色终端里也要先铺白边，所以每行前后和上下都补 border 个浅色模块。
 * 字符：█ 上下都浅 → 用空格会被终端背景吃掉，所以「浅」画成全块 █，「深」画成空格，这样在深色背景里是白底黑码。
 */
export function qrTerminal(text: string, border = 2): string {
    const matrix = qrMatrix(text);
    const size = matrix.length + border * 2;
    const dark = (x: number, y: number) => matrix[y - border]?.[x - border] === true;
    const lines: string[] = [];
    for (let y = 0; y < size; y += 2) {
        let line = '';
        for (let x = 0; x < size; x++) {
            const top = dark(x, y);
            const bottom = dark(x, y + 1);
            line += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█';
        }
        lines.push(line);
    }
    return lines.join('\n');
}
