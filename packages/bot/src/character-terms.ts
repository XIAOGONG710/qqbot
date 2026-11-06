// 她世界里的专有名字（ADR 0335）：猫叫什么、学校和家在哪座城市。都从卡上读（world.cat.name、world.weather.places），源码里不写死。
// 用到它们的地方多是写死的文案和正则（认出他想看猫、照片说明里不许带地名、「你倒是回 X 了」这种怪他的话），一处处传参太散，
// 所以读卡时（contact.ts 的 loadTierCard）记下来：同一个角色各档的卡名字都一样，看得到的那一档记上，看不到的档位不清空。
// 没读到卡（单元测试、没有猫的角色）就用通用说法：猫叫「猫」，没有城市。

export interface CharacterTerms {
    /** 楼下那只猫的名字（world.cat.name） */
    cat?: string;
    /** 她学校、家所在的城市（world.weather.places 的 name） */
    cities: readonly string[];
    /** 家所在的城市（weather.places.home）：「你倒是回 X 了」这种话里的 X */
    home?: string;
}

let current: CharacterTerms = { cities: [] };

/** 换成这一套（测试用；线上由读卡记下） */
export function useCharacterTerms(terms: CharacterTerms): void {
    current = { ...(terms.cat ? { cat: terms.cat } : {}), cities: [...new Set(terms.cities.filter(Boolean))], ...(terms.home ? { home: terms.home } : {}) };
}

/** 读卡时记下卡上有的名字；卡上没有的不清空 */
export function noteCharacterTerms(world: { cat?: { name: string }; weather?: { places?: { school: { name: string }; home: { name: string } } } } | undefined): void {
    if (!world) return;
    const places = world.weather?.places;
    const home = places?.home.name ?? current.home;
    useCharacterTerms({ ...(world.cat?.name ?? current.cat ? { cat: world.cat?.name ?? current.cat } : {}), cities: places ? [places.school.name, places.home.name] : current.cities, ...(home ? { home } : {}) });
}

export function characterTerms(): CharacterTerms {
    return current;
}

/** 猫的名字；没有就叫「猫」 */
export function catName(): string {
    return current.cat ?? '猫';
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 正则里的「猫的名字 |」前缀：有名字才有（拼进别的词的 alternation 前面） */
export function catAlternative(): string {
    return current.cat ? `${escape(current.cat)}|` : '';
}

/** 家所在城市的 alternation（「|家乡」这样的后缀）；没有就是空串 */
export function homeAlternative(): string {
    return current.home ? `|${escape(current.home)}` : '';
}

/** 城市名的 alternation（「|城市A|城市B」这样的后缀）；没有就是空串 */
export function cityAlternatives(): string {
    return current.cities.map(city => `|${escape(city)}`).join('');
}
