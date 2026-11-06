// 测试用的合成角色（虚构资料，见 synthetic-character/README.md）。
// 测试不读 characters/ 下的真实角色卡：要卡就用这里的路径。

import { resolve } from 'node:path';
import { useCharacterTerms } from '../../src/character-terms.ts';

export const TIERS = ['boyfriend', 'bestie', 'girl_friend', 'known', 'classmate', 'stranger', 'unlisted'] as const;
export type SyntheticTier = (typeof TIERS)[number];

/** 合成卡上的角色名（persona.yml 的 name） */
export const SYNTHETIC_CHAR_NAME = '测试角色';
/** 合成卡的文件名前缀（convert:synthetic 的 --prefix） */
export const SYNTHETIC_PREFIX = 'synthetic';

export const syntheticCharacterDir = resolve(import.meta.dirname, 'synthetic-character');
export const syntheticSourceDir = resolve(syntheticCharacterDir, 'source');
export const syntheticStDir = resolve(syntheticCharacterDir, 'st');

/** 和配置里的 characterCard 同一种写法：含 {tier} 占位，给 loadTierCard / 配置用 */
export const syntheticCardPattern = resolve(syntheticStDir, `${SYNTHETIC_PREFIX}-{tier}.json`);

/** 一档的卡；open 为 true 时是承认版（<档位>-open，名单外那一档没有） */
export function syntheticCardPath(tier: SyntheticTier | string, open = false): string {
    return resolve(syntheticStDir, `${SYNTHETIC_PREFIX}-${tier}${open ? '-open' : ''}.json`);
}

/** 一档的场景世界书 */
export function syntheticLorebookPath(tier: SyntheticTier | string, open = false): string {
    return resolve(syntheticStDir, `${SYNTHETIC_PREFIX}-scenes-${tier}${open ? '-open' : ''}.json`);
}

/** 合成卡上的真实天气地点（world.yml 的 weather.places）：在学校 school-town、在家 home-town，都是虚构的 */
export const SYNTHETIC_WEATHER_PLACES = [
    { id: 'school-town', name: '雾岚市', latitude: 30.5, longitude: 110.5 },
    { id: 'home-town', name: '溪口镇', latitude: 31.5, longitude: 112.5 },
] as const;

/** 合成角色的专有名字（ADR 0262）：猫「团子饼」，学校在雾岚市、家在溪口镇。要测认出猫名 / 城市名的测试先调这个 */
export function useSyntheticTerms(): void {
    useCharacterTerms({ cat: '团子饼', cities: ['雾岚市', '溪口镇'], home: '溪口镇' });
}
