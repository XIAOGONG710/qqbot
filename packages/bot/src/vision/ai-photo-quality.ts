// AI 生活照的质量门（ADR 0242）：先做本地结构检查，再让可注入的视觉审查器核对人物、文字和世界事实。
// 任何一步拿不准都不通过；这个模块只给出结论，不发送、不批准草稿。

export const AI_PHOTO_MIN_EDGE = 512;
export const AI_PHOTO_MAX_EDGE = 8192;
export const AI_PHOTO_MAX_PIXELS = 24_000_000;
export const AI_PHOTO_MAX_BYTES = 12 * 1024 * 1024;

export type AiPhotoSceneKind = 'cat' | 'food' | 'desk' | 'view';
export type AiPhotoTimeOfDay = 'dawn' | 'day' | 'dusk' | 'night';

export interface AiPhotoWorldFacts {
    kind: AiPhotoSceneKind;
    at: string;
    subject: string;
    dish?: string;
    weather?: string;
    timeOfDay?: AiPhotoTimeOfDay;
}

export interface AiPhotoVisualReview {
    sceneKind: AiPhotoSceneKind | 'other';
    confidence: number;
    personCount: number;
    faceCount: number;
    handCount: number;
    readableText: boolean;
    watermark: boolean;
    famousLandmark: boolean;
    cinematicStyle: boolean;
    subjectMatches: boolean;
    dishMatches?: boolean;
    weatherMatches?: boolean;
    timeMatches?: boolean;
    referenceMatches?: boolean;
}

export interface AiPhotoVisualReviewInput {
    bytes: Uint8Array;
    type: 'image/jpeg' | 'image/png' | 'image/webp';
    width: number;
    height: number;
    facts: AiPhotoWorldFacts;
    /** 只传供应商能识别的引用 ID，不传参考图、路径或人物描述。 */
    referenceIds: readonly string[];
}

export type AiPhotoVisualReviewer = (input: AiPhotoVisualReviewInput) => Promise<AiPhotoVisualReview>;

export interface AiPhotoQualityResult {
    passed: boolean;
    reasons: string[];
    type?: 'image/jpeg' | 'image/png' | 'image/webp';
    width?: number;
    height?: number;
    review?: AiPhotoVisualReview;
}

const readU24LE = (b: Buffer, offset: number) => b[offset]! | (b[offset + 1]! << 8) | (b[offset + 2]! << 16);
const contentType = (b: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | undefined => {
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    return undefined;
};

function pngDimensions(b: Buffer): { width: number; height: number } | undefined {
    if (b.length < 33 || b.subarray(12, 16).toString('ascii') !== 'IHDR') return undefined;
    if (b.readUInt32BE(8) !== 13) return undefined;
    const width = b.readUInt32BE(16);
    const height = b.readUInt32BE(20);
    const depth = b[24]!;
    const color = b[25]!;
    const validDepths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
    if (!validDepths[color]?.includes(depth) || b[26] !== 0 || b[27] !== 0 || b[28] !== 0) return undefined;
    return width && height ? { width, height } : undefined;
}

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
function jpegDimensions(b: Buffer): { width: number; height: number } | undefined {
    if (b.length < 11 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
    let at = 2;
    while (at + 3 < b.length) {
        while (at < b.length && b[at] === 0xff) at++;
        if (at >= b.length) return undefined;
        const marker = b[at++]!;
        if (marker === 0xd9 || marker === 0xda) return undefined;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (at + 2 > b.length) return undefined;
        const length = b.readUInt16BE(at);
        if (length < 2 || at + length > b.length) return undefined;
        if (JPEG_SOF.has(marker)) {
            if (length < 8) return undefined;
            const height = b.readUInt16BE(at + 3);
            const width = b.readUInt16BE(at + 5);
            return width && height ? { width, height } : undefined;
        }
        at += length;
    }
    return undefined;
}

function webpDimensions(b: Buffer): { width: number; height: number } | undefined {
    if (b.length < 30 || b.subarray(0, 4).toString('ascii') !== 'RIFF' || b.subarray(8, 12).toString('ascii') !== 'WEBP') return undefined;
    const riffSize = b.readUInt32LE(4);
    if (riffSize < 18 || riffSize + 8 > b.length) return undefined;
    const chunk = b.subarray(12, 16).toString('ascii');
    const chunkSize = b.readUInt32LE(16);
    if (20 + chunkSize > b.length) return undefined;
    if (chunk === 'VP8X' && chunkSize >= 10) return { width: 1 + readU24LE(b, 24), height: 1 + readU24LE(b, 27) };
    if (chunk === 'VP8L' && chunkSize >= 5 && b[20] === 0x2f) {
        const bits = b.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    if (chunk === 'VP8 ' && chunkSize >= 10 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
        return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    return undefined;
}

/** 只解析支持格式的固定结构，不信扩展名、Content-Type 或模型声明。 */
export function aiPhotoDimensions(bytes: Uint8Array): { type: 'image/jpeg' | 'image/png' | 'image/webp'; width: number; height: number } | undefined {
    const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const detected = contentType(b);
    if (!detected) return undefined;
    const size = detected === 'image/png' ? pngDimensions(b) : detected === 'image/jpeg' ? jpegDimensions(b) : webpDimensions(b);
    return size ? { type: detected, ...size } : undefined;
}

function validFacts(facts: AiPhotoWorldFacts): string[] {
    const reasons: string[] = [];
    if (!['cat', 'food', 'desk', 'view'].includes(facts.kind)) reasons.push('照片种类不受支持');
    if (!Number.isFinite(Date.parse(facts.at))) reasons.push('世界时间无效');
    if (!facts.subject.trim()) reasons.push('缺少画面主体事实');
    if (facts.kind === 'food' && !facts.dish?.trim()) reasons.push('食物照片缺少实际菜名');
    if (facts.timeOfDay && !['dawn', 'day', 'dusk', 'night'].includes(facts.timeOfDay)) reasons.push('时段标签无效');
    return reasons;
}

/** 本地硬门先拦坏文件 / 异常尺寸，再调用视觉审查器；审查器没接、出错或低把握都失败关闭。 */
export async function assessAiPhotoQuality(input: {
    bytes: Uint8Array;
    facts: AiPhotoWorldFacts;
    reviewer?: AiPhotoVisualReviewer;
    referenceIds?: readonly string[];
}): Promise<AiPhotoQualityResult> {
    const reasons = validFacts(input.facts);
    if (!input.bytes.length) reasons.push('图片文件为空');
    if (input.bytes.length > AI_PHOTO_MAX_BYTES) reasons.push('图片文件超过 12 MB');
    const image = aiPhotoDimensions(input.bytes);
    if (!image) reasons.push('图片结构损坏或格式不受支持');
    if (image) {
        if (Math.min(image.width, image.height) < AI_PHOTO_MIN_EDGE) reasons.push(`图片太小，短边至少需要 ${AI_PHOTO_MIN_EDGE} 像素`);
        if (Math.max(image.width, image.height) > AI_PHOTO_MAX_EDGE || image.width * image.height > AI_PHOTO_MAX_PIXELS) reasons.push('图片尺寸过大');
        const ratio = image.width / image.height;
        if (ratio < 0.5 || ratio > 2) reasons.push('图片比例不像普通手机照片');
    }
    if (reasons.length || !image) return { passed: false, reasons, ...(image ?? {}) };
    if (!input.reviewer) return { passed: false, reasons: ['尚未完成视觉审查'], ...image };

    let review: AiPhotoVisualReview;
    try {
        review = await input.reviewer({ ...image, bytes: input.bytes, facts: input.facts, referenceIds: input.referenceIds ?? [] });
    } catch {
        return { passed: false, reasons: ['视觉审查失败，请稍后重试'], ...image };
    }
    if (!Number.isFinite(review.confidence) || review.confidence < 0.7) reasons.push('视觉审查把握不足');
    if (!Number.isInteger(review.personCount) || review.personCount < 0 || review.personCount > 0) reasons.push('画面中出现了人物');
    if (!Number.isInteger(review.faceCount) || review.faceCount < 0 || review.faceCount > 0) reasons.push('画面中出现了人脸');
    if (!Number.isInteger(review.handCount) || review.handCount < 0 || review.handCount > 0) reasons.push('画面中出现了手或其他身体部位');
    if (review.readableText) reasons.push('画面中有可读文字');
    if (review.watermark) reasons.push('画面中有水印或标志');
    if (review.famousLandmark) reasons.push('画面中有可定位的著名地标');
    if (review.cinematicStyle) reasons.push('画面电影感或棚拍感过强');
    if (review.sceneKind !== input.facts.kind) reasons.push('画面类型与世界事件不一致');
    if (!review.subjectMatches) reasons.push('主体与世界事实不一致');
    if (input.facts.kind === 'food' && review.dishMatches !== true) reasons.push('菜品与这一顿不一致');
    if (input.facts.weather?.trim() && review.weatherMatches !== true) reasons.push('天气与世界事实不一致');
    if (input.facts.timeOfDay && review.timeMatches !== true) reasons.push('光线时段与世界时间不一致');
    if ((input.referenceIds?.length ?? 0) > 0 && review.referenceMatches !== true) reasons.push('主体或环境与既有视觉设定不一致');
    return { passed: reasons.length === 0, reasons, ...image, review };
}
