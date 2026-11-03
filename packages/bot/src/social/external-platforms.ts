/**
 * 外部内容平台的能力边界（贴吧、抖音、小红书）。
 *
 * 这里只描述经过官方能力确认的接入方式，不包含网页抓取、模拟点击或私有接口。
 * 真正接入时由宿主提供 OAuth 凭证和请求实现；默认只能生成草稿，不能自动发布。
 */

export type ExternalPlatform = 'tieba' | 'douyin' | 'xiaohongshu';
export type ExternalPlatformMode = 'off' | 'draft' | 'authorized';
export const EXTERNAL_PLATFORM_MODES: readonly ExternalPlatformMode[] = ['off', 'draft', 'authorized'];

export interface ExternalPlatformCapability {
    platform: ExternalPlatform;
    label: string;
    mode: ExternalPlatformMode;
    /** 是否可以在官方能力范围内读取公开内容。 */
    readPublic: boolean;
    /** 是否可以生成待人工确认的内容草稿。 */
    draft: boolean;
    /** 是否需要平台授权后才可调用。 */
    requiresAuthorization: boolean;
    /** 用户可以查看的能力说明。 */
    note: string;
}

/**
 * 保守默认值：三个平台都关闭；开启后先走草稿，授权发布需要单独配置。
 * 小红书目前只把 OAuth / 账号授权列为稳定公共能力，不能把公开笔记读取当作默认能力。
 */
export const EXTERNAL_PLATFORM_CAPABILITIES: readonly ExternalPlatformCapability[] = [
    {
        platform: 'tieba',
        label: '百度贴吧',
        mode: 'off',
        readPublic: true,
        draft: true,
        requiresAuthorization: true,
        note: '使用官方开放能力时可读取指定贴吧摘要；发帖必须保留人工确认。',
    },
    {
        platform: 'douyin',
        label: '抖音',
        mode: 'off',
        readPublic: false,
        draft: true,
        requiresAuthorization: true,
        note: '按开放平台授权和已申请权限接入；发布内容先进入草稿。',
    },
    {
        platform: 'xiaohongshu',
        label: '小红书',
        mode: 'off',
        readPublic: false,
        draft: true,
        requiresAuthorization: true,
        note: '使用官方 OAuth / 分享能力；不抓取公开笔记，不绕过登录。',
    },
];

export function externalPlatformCapability(platform: ExternalPlatform): ExternalPlatformCapability {
    return EXTERNAL_PLATFORM_CAPABILITIES.find(item => item.platform === platform)!;
}

/** 只接受明确的安全模式；未知值和空值都回到关闭。 */
export function externalPlatformMode(value: unknown): ExternalPlatformMode {
    return value === 'draft' || value === 'authorized' || value === 'off' ? value : 'off';
}

/** 授权发布前的统一门槛：必须显式授权，且调用方仍应继续执行白名单和确认。 */
export function canPublishExternal(platform: ExternalPlatform, mode: unknown, authorized: boolean): boolean {
    return externalPlatformCapability(platform).draft && externalPlatformMode(mode) === 'authorized' && authorized;
}
