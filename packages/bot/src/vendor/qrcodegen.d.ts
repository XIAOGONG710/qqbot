// 只声明 qr.ts 用到的部分（完整 API 见 vendor/qrcodegen.js 里的注释）
export interface QrCode {
    /** 边长（模块数），21 到 177 */
    readonly size: number;
    /** 第 x 列第 y 行是不是深色；越界返回 false */
    getModule(x: number, y: number): boolean;
}
declare const qrcodegen: {
    QrCode: {
        encodeText(text: string, ecl: unknown): QrCode;
        Ecc: { LOW: unknown; MEDIUM: unknown; QUARTILE: unknown; HIGH: unknown };
    };
};
export default qrcodegen;
