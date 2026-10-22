// 她每天碰到的小事（ADR 0106，配置 everydayLife，默认关）。
// 为什么：线上 15 天的事件账 150 件，全是课、饭、睡、学习、休闲这样的例行，卡上的“小事”只有 12 条（食堂排队、图书馆没座、宿舍查卫生……）；
// 真人的一天会碰到很多没人安排的小事：外卖晚了、手机掉电、老师拖堂、下雨没带伞、舍友的闹钟、食堂阿姨多给了半勺菜、看到晚霞拍了几张。
// 她“有自己的日子”就是这些：没有它们她只有课表，没什么可讲，也没什么可以高兴或烦。
// 这里只加**日常尺度**的小事（一件事一两句、不改变她是谁）：不加新的有名字的人、不加社团 / 恋爱 / 家里的变故这类要作者定的大事（那些走 moments.json，ADR 0102）。
// 做法和卡上的小事一样：按“日期 + 名目”取哈希，同一天对所有人一样，重启、重放都一样；这里是代码里的补充，不改角色卡（改卡 = 上线），
// 档位只看得到自己该看的（宿舍、闺蜜这些只给亲近档位）。
// 另有“小测”的一条线：高数 / 概率论 / 专业课每四周一次，前一次课老师说，当天写，两天后出分——分数是她难过或开心的真正来由（数学类偏低，自传：怕数学）。

import type { FeelingKind } from './feelings.ts';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';
import { classesOn, formatDate, type ClassToday, type Schedule } from './schedule.ts';
import type { World, WorldWindow } from './world.ts';

export type EventWeather = 'rain' | 'dry' | 'cold' | 'hot';
export type EventTier = 'boyfriend' | 'bestie' | 'girl_friend' | 'known' | 'classmate' | 'stranger' | 'unlisted';
const CLOSE: EventTier[] = ['boyfriend', 'bestie', 'girl_friend', 'known'];
const ALL: EventTier[] = [...CLOSE, 'classmate', 'stranger', 'unlisted'];
const PLAIN: EventTier[] = [...CLOSE, 'classmate'];

/** 感受：这件事在她心里留下什么（ADR 0102 的评估）；没写就是纯事实 */
export interface EventFeel { kind: FeelingKind; strength: 1 | 2 | 3 }

export type WorldEventDef = World['events'][number];

interface Def {
    id: string;
    text: string;
    window: WorldWindow;
    chance: number;
    when: 'school' | 'class_day' | 'any' | 'off_day';
    tiers?: EventTier[];
    person?: string;
    weekdays?: number[];
    months?: number[];
    weather?: EventWeather;
    /** 同一组一天最多一件（比如“吃”的、“天气”的） */
    group: string;
    feel?: EventFeel;
    cost?: { amount: [number, number]; what: string };
    skipWhen?: ('sick' | 'busy' | 'home')[];
    onlyWhen?: ('sick' | 'busy' | 'home')[];
    /** 要这一天土豆见到了 / 没见到 */
    requires?: 'cat_seen' | 'cat_unseen';
    /** 买了相机以后才有 */
    afterCamera?: boolean;
}

const f = (kind: FeelingKind, strength: 1 | 2 | 3 = 1): EventFeel => ({ kind, strength });

/** 一天里补充的小事最多几件（加上卡上原来的，一天不会堆成流水账） */
export const EVERYDAY_MAX_PER_DAY = 3;
/** 各条的概率整体乘这个数：卡上原来平均一天 1.5 件，补充的平均再加 2 件上下，一天总共 3.5–4 件（真人一天碰到的小事比这多，但值得被想起来的就这些） */
export const EVERYDAY_SCALE = 0.55;

const DEFS: Def[] = [
    // ───── 吃 ─────
    { id: 'ed_canteen_new', text: '食堂二楼开了个新窗口，试了一份，还不错', window: 'afternoon', chance: 0.06, when: 'school', group: 'food', feel: f('joy') },
    { id: 'ed_canteen_salty', text: '中午的菜咸得有点过，没吃完', window: 'afternoon', chance: 0.07, when: 'school', group: 'food' },
    { id: 'ed_canteen_aunt', text: '食堂阿姨今天多给了半勺菜', window: 'afternoon', chance: 0.05, when: 'school', group: 'food', feel: f('joy') },
    { id: 'ed_canteen_soldout', text: '想吃的那个窗口卖完了，换了别的', window: 'afternoon', chance: 0.09, when: 'school', group: 'food', feel: f('annoyed') },
    { id: 'ed_takeout_late', text: '外卖晚了二十多分钟才到', window: 'evening', chance: 0.07, when: 'any', group: 'food', feel: f('annoyed') },
    { id: 'ed_takeout_missing', text: '外卖少送了一样，联系了商家', window: 'evening', chance: 0.035, when: 'any', group: 'food', feel: f('annoyed') },
    { id: 'ed_tea_new', text: '奶茶店出了新品，买了一杯尝尝', window: 'afternoon', chance: 0.05, when: 'any', tiers: PLAIN, group: 'food', cost: { amount: [14, 22], what: '奶茶' } },
    { id: 'ed_tea_coupon', text: '领到一张奶茶券，打算周末用', window: 'afternoon', chance: 0.05, when: 'any', tiers: CLOSE, group: 'food', feel: f('joy') },
    { id: 'ed_noodles_night', text: '晚上饿了，煮了包泡面', window: 'evening', chance: 0.1, when: 'any', tiers: CLOSE, group: 'food' },
    { id: 'ed_fruit', text: '在楼下水果摊买了点橘子', window: 'afternoon', chance: 0.06, when: 'any', group: 'food', cost: { amount: [6, 12], what: '水果' } },
    { id: 'ed_skip_breakfast', text: '早上没吃早饭，第二节课就饿了', window: 'morning', chance: 0.1, when: 'class_day', group: 'food' },

    // ───── 上课 / 学习 ─────
    { id: 'ed_overtime', text: '下午那节课老师拖堂了十分钟', window: 'afternoon', chance: 0.09, when: 'class_day', group: 'class', feel: f('annoyed') },
    { id: 'ed_rollcall', text: '课上老师点名了，还好到了', window: 'morning', chance: 0.07, when: 'class_day', group: 'class' },
    { id: 'ed_lab_slow', text: '机房的电脑卡得厉害，实验做得特别慢', window: 'afternoon', chance: 0.06, when: 'class_day', group: 'class', feel: f('annoyed') },
    { id: 'ed_early_out', text: '有节课老师提前下课了', window: 'afternoon', chance: 0.06, when: 'class_day', group: 'class', feel: f('joy') },
    { id: 'ed_nap_class', text: '上午有一节课差点睡着，掐了自己一下', window: 'morning', chance: 0.1, when: 'class_day', group: 'class', feel: f('tired') },
    { id: 'ed_hw_hard', text: '今天布置的作业有点难，题目都没完全看懂', window: 'afternoon', chance: 0.09, when: 'class_day', group: 'class', feel: f('worry') },
    { id: 'ed_notes_missing', text: '笔记没记全，打算回头找人借', window: 'afternoon', chance: 0.05, when: 'class_day', group: 'class' },
    { id: 'ed_lab_bug', text: '实验课的程序一直报错，找了半天原来是少了个括号', window: 'afternoon', chance: 0.06, when: 'class_day', group: 'class', feel: f('relief') },
    { id: 'ed_group_show', text: '课上被分到一组，要做一个小展示', window: 'morning', chance: 0.035, when: 'class_day', group: 'class', feel: f('worry') },
    { id: 'ed_deadline_moved', text: '有门课的作业截止日期往后延了一天', window: 'afternoon', chance: 0.04, when: 'class_day', group: 'class', feel: f('relief') },
    { id: 'ed_lib_afternoon', text: '在图书馆待了一下午，效率还行', window: 'afternoon', chance: 0.09, when: 'school', group: 'study' },
    { id: 'ed_lib_closing', text: '图书馆闭馆的铃响了才走', window: 'evening', chance: 0.05, when: 'school', group: 'study' },
    { id: 'ed_print_queue', text: '打印店排了好长的队，打了几页资料', window: 'afternoon', chance: 0.05, when: 'school', group: 'study', cost: { amount: [2, 6], what: '打印' } },
    { id: 'ed_class_group', text: '班级群里通知了一件事，翻了好久才找到', window: 'evening', chance: 0.1, when: 'school', tiers: CLOSE, group: 'study' },
    { id: 'ed_counselor', text: '辅导员在群里发了个通知，要填一张表', window: 'afternoon', chance: 0.05, when: 'school', tiers: CLOSE, group: 'study' },
    { id: 'ed_wifi_slow', text: '晚上校园网特别卡，刷个视频一直转圈', window: 'evening', chance: 0.09, when: 'school', group: 'phone', feel: f('annoyed') },
    { id: 'ed_study_flow', text: '今天写作业特别顺，一个下午就写完了', window: 'afternoon', chance: 0.05, when: 'any', group: 'study', feel: f('joy') },
    { id: 'ed_study_stuck', text: '有一道题卡了很久，最后放弃去睡了', window: 'evening', chance: 0.06, when: 'any', group: 'study', feel: f('annoyed') },
    { id: 'ed_review_rush', text: '同学们都开始复习了，图书馆的座位一天比一天难抢', window: 'afternoon', chance: 0.3, when: 'school', months: [12, 1], tiers: CLOSE, group: 'study', feel: f('worry') },
    { id: 'ed_midterm_rush', text: '感觉这几天各门课都在赶进度', window: 'afternoon', chance: 0.15, when: 'class_day', months: [10, 11], tiers: CLOSE, group: 'study' },

    // ───── 宿舍 ─────
    { id: 'ed_dorm_light', text: '宿舍楼道的灯又坏了一盏', window: 'evening', chance: 0.05, when: 'school', tiers: CLOSE, group: 'dorm' },
    { id: 'ed_laundry_queue', text: '洗衣机排队，等了很久才轮到', window: 'evening', chance: 0.09, when: 'school', tiers: CLOSE, group: 'dorm', feel: f('annoyed') },
    { id: 'ed_clothes_wet', text: '晾的衣服一直没干，阴了两天', window: 'morning', chance: 0.25, when: 'school', weather: 'rain', tiers: CLOSE, group: 'dorm' },
    { id: 'ed_heater_moody', text: '宿舍的热水器时冷时热，洗澡洗得很折腾', window: 'evening', chance: 0.08, when: 'school', months: [10, 11, 12, 1, 2, 3], tiers: CLOSE, group: 'dorm', feel: f('annoyed') },
    { id: 'ed_dorm_cold', text: '宿舍夜里挺冷，又加了一床被子', window: 'evening', chance: 0.14, when: 'school', months: [11, 12, 1, 2], tiers: CLOSE, group: 'dorm' },
    { id: 'ed_next_door_noisy', text: '隔壁宿舍半夜吵到一点多', window: 'evening', chance: 0.05, when: 'school', tiers: CLOSE, group: 'dorm', feel: f('annoyed') },
    { id: 'ed_power_trip', text: '宿舍晚上跳了一次闸，手机充到一半', window: 'evening', chance: 0.03, when: 'school', tiers: CLOSE, group: 'dorm' },
    { id: 'ed_insect', text: '宿舍里飞进一只虫子，追着打了半天', window: 'evening', chance: 0.05, when: 'school', months: [4, 5, 6, 9, 10], tiers: CLOSE, group: 'dorm' },
    { id: 'ed_roommate_snack', text: '室友分了点零食', window: 'evening', chance: 0.06, when: 'school', tiers: CLOSE, group: 'dorm', feel: f('joy') },
    { id: 'ed_dorm_chat', text: '晚上宿舍大家聊了会儿天，笑得挺开心', window: 'evening', chance: 0.09, when: 'school', tiers: CLOSE, group: 'dorm', feel: f('joy') },
    { id: 'ed_roommate_alarm', text: '室友的闹钟早上响了好几遍', window: 'morning', chance: 0.08, when: 'class_day', tiers: CLOSE, group: 'dorm', feel: f('annoyed') },
    { id: 'ed_roommate_meal', text: '室友顺手帮她带了份饭回来', window: 'evening', chance: 0.05, when: 'school', tiers: CLOSE, group: 'dorm', feel: f('joy') },
    { id: 'ed_cable_borrowed', text: '室友借走了她的充电线，晚上才还', window: 'evening', chance: 0.04, when: 'school', tiers: CLOSE, group: 'dorm' },
    { id: 'ed_tidy_desk', text: '周末把桌子收拾了一遍，清爽多了', window: 'afternoon', chance: 0.14, when: 'off_day', weekdays: [6, 7], tiers: CLOSE, group: 'dorm', feel: f('relief') },

    // ───── 手机 / 网上 / 玩 ─────
    { id: 'ed_phone_battery', text: '手机电量掉得特别快，一天充了两次', window: 'afternoon', chance: 0.07, when: 'any', group: 'phone' },
    { id: 'ed_earphone_lost', text: '耳机丢了一只，把书包翻了个底朝天', window: 'afternoon', chance: 0.03, when: 'any', group: 'phone', feel: f('annoyed') },
    { id: 'ed_cable_found', text: '找了好几天的充电线，在书包夹层里找到了', window: 'afternoon', chance: 0.03, when: 'any', group: 'phone', feel: f('relief') },
    { id: 'ed_video_late', text: '晚上刷视频刷过头，一看都快一点了', window: 'evening', chance: 0.1, when: 'any', group: 'leisure', feel: f('tired') },
    { id: 'ed_tutorial', text: '刷到一个拍照调色的教程，收藏了', window: 'evening', chance: 0.12, when: 'any', tiers: CLOSE, group: 'leisure', feel: f('joy') },
    { id: 'ed_drama_update', text: '追的剧更新了一集', window: 'evening', chance: 0.14, when: 'any', tiers: PLAIN, group: 'leisure', feel: f('joy') },
    { id: 'ed_drama_slow', text: '追的剧这几集有点拖，差点弃了', window: 'evening', chance: 0.05, when: 'any', tiers: PLAIN, group: 'leisure' },
    { id: 'ed_game_win', text: '晚上打王者连赢了几把', window: 'evening', chance: 0.09, when: 'any', tiers: CLOSE, group: 'leisure', feel: f('joy') },
    { id: 'ed_game_lose', text: '晚上打王者连输了好几把，队友太坑', window: 'evening', chance: 0.09, when: 'any', tiers: CLOSE, group: 'leisure', feel: f('annoyed') },
    { id: 'ed_song_loop', text: '一首歌单曲循环了一晚上', window: 'evening', chance: 0.08, when: 'any', tiers: CLOSE, group: 'leisure' },
    { id: 'ed_album_old', text: '翻相册翻到去年的照片，看了好一会儿', window: 'evening', chance: 0.06, when: 'any', tiers: CLOSE, group: 'leisure' },
    { id: 'ed_photo_edit_good', text: '晚上修了几张片子，调出了想要的颜色', window: 'evening', chance: 0.08, when: 'any', tiers: CLOSE, group: 'photo', feel: f('joy', 1) },
    { id: 'ed_photo_edit_stuck', text: '修一张片子修了一个多小时，还是不满意', window: 'evening', chance: 0.06, when: 'any', tiers: CLOSE, group: 'photo', feel: f('annoyed') },
    { id: 'ed_photo_walk', text: '傍晚拿着相机在校园里转了转，拍了几张', window: 'evening', chance: 0.07, when: 'any', weather: 'dry', tiers: CLOSE, group: 'photo', afterCamera: true, feel: f('joy') },

    // ───── 天气 / 季节 ─────
    { id: 'ed_rain_no_umbrella', text: '出门没带伞，淋了一段路', window: 'afternoon', chance: 0.22, when: 'school', weather: 'rain', group: 'weather', feel: f('annoyed') },
    { id: 'ed_rain_canteen', text: '下雨，食堂里人特别多，地上湿漉漉的', window: 'afternoon', chance: 0.25, when: 'school', weather: 'rain', group: 'weather' },
    { id: 'ed_rain_cozy', text: '下雨天窝在宿舍，听着雨声还挺舒服', window: 'evening', chance: 0.2, when: 'school', weather: 'rain', tiers: CLOSE, group: 'weather', feel: f('relief') },
    { id: 'ed_windy', text: '风很大，吹得骑车的人东倒西歪', window: 'afternoon', chance: 0.12, when: 'school', weather: 'dry', months: [3, 4, 10, 11], group: 'weather' },
    { id: 'ed_cold_snap', text: '突然降温，把厚外套翻了出来', window: 'morning', chance: 0.25, when: 'any', weather: 'cold', months: [10, 11], group: 'weather' },
    { id: 'ed_hot_walk', text: '中午太阳很晒，从教学楼走到食堂出了一身汗', window: 'afternoon', chance: 0.25, when: 'school', weather: 'hot', group: 'weather', feel: f('annoyed') },
    { id: 'ed_sunset', text: '傍晚的晚霞特别好看，站在楼下拍了好几张', window: 'evening', chance: 0.1, when: 'any', weather: 'dry', tiers: CLOSE, group: 'weather', feel: f('joy') },
    { id: 'ed_leaves', text: '校园里的银杏黄了，路过拍了几张', window: 'afternoon', chance: 0.2, when: 'school', weather: 'dry', months: [10, 11], group: 'weather', feel: f('joy') },
    { id: 'ed_moon', text: '晚上月亮特别圆，在楼下站着看了一会儿', window: 'evening', chance: 0.04, when: 'any', weather: 'dry', tiers: CLOSE, group: 'weather' },

    // ───── 土豆 ─────
    { id: 'ed_cat_belly', text: '土豆今天蹭了蹭她的手，还翻出了肚皮', window: 'evening', chance: 0.12, when: 'any', requires: 'cat_seen', group: 'cat', feel: f('joy') },
    { id: 'ed_cat_fast', text: '土豆今天吃得特别快，碗舔得干干净净', window: 'evening', chance: 0.1, when: 'any', requires: 'cat_seen', group: 'cat' },
    { id: 'ed_cat_grass', text: '土豆身上沾了草屑，帮它摘了好一会儿', window: 'evening', chance: 0.05, when: 'any', requires: 'cat_seen', group: 'cat' },
    { id: 'ed_cat_photo', text: '给土豆拍了几张照片，有一张特别好', window: 'evening', chance: 0.1, when: 'any', requires: 'cat_seen', group: 'cat', feel: f('joy') },
    { id: 'ed_cat_other_feeder', text: '碰到别的同学也在喂土豆', window: 'evening', chance: 0.04, when: 'any', requires: 'cat_seen', group: 'cat' },
    { id: 'ed_cat_waiting', text: '喊了好几声土豆没出来，猫碗放在老地方', window: 'evening', chance: 0.2, when: 'any', requires: 'cat_unseen', group: 'cat', feel: f('worry') },

    // ───── 朋友（陈佳宁在外地，苏雨桐是同专业济南人；只做互动，不加新人新事） ─────
    { id: 'ed_jn_meme', text: '{person}发来一张搞笑图，互损了几句', window: 'evening', chance: 0.14, when: 'any', person: 'chen_jianing', skipWhen: ['busy'], tiers: CLOSE, group: 'social', feel: f('joy') },
    { id: 'ed_jn_campus', text: '{person}吐槽她们学校的食堂，笑死了', window: 'evening', chance: 0.09, when: 'any', person: 'chen_jianing', skipWhen: ['busy'], tiers: CLOSE, group: 'social', feel: f('joy') },
    { id: 'ed_jn_exam', text: '{person}说她们快考试了，在微信上哀嚎', window: 'evening', chance: 0.12, when: 'any', person: 'chen_jianing', months: [11, 12, 1], tiers: CLOSE, group: 'social' },
    { id: 'ed_yt_notes', text: '{person}把上课的笔记拍给她', window: 'afternoon', chance: 0.07, when: 'class_day', person: 'su_yutong', skipWhen: ['sick'], tiers: CLOSE, group: 'social' },
    { id: 'ed_yt_study', text: '和{person}在图书馆一起自习', window: 'afternoon', chance: 0.08, when: 'school', person: 'su_yutong', skipWhen: ['sick', 'home'], tiers: CLOSE, group: 'social' },
    { id: 'ed_yt_snack', text: '{person}分了她一包零食', window: 'afternoon', chance: 0.06, when: 'class_day', person: 'su_yutong', skipWhen: ['sick', 'home'], tiers: CLOSE, group: 'social', feel: f('joy') },
    { id: 'ed_yt_powerbank', text: '借了{person}的充电宝，下课还了', window: 'afternoon', chance: 0.04, when: 'class_day', person: 'su_yutong', skipWhen: ['sick', 'home'], tiers: CLOSE, group: 'social' },
    { id: 'ed_yt_gossip', text: '{person}聊起班里的八卦，听得津津有味', window: 'evening', chance: 0.06, when: 'school', person: 'su_yutong', skipWhen: ['sick'], tiers: CLOSE, group: 'social' },
    { id: 'ed_yt_hw', text: '和{person}一起研究一道作业题，研究了半天', window: 'evening', chance: 0.08, when: 'school', person: 'su_yutong', skipWhen: ['sick'], tiers: CLOSE, group: 'social', feel: f('relief') },
    { id: 'ed_yt_drama', text: '{person}推荐了一部剧，先收藏了', window: 'evening', chance: 0.05, when: 'any', person: 'su_yutong', skipWhen: ['sick'], tiers: CLOSE, group: 'social' },
    { id: 'ed_yt_walk', text: '和{person}绕着操场走了两圈', window: 'evening', chance: 0.06, when: 'school', person: 'su_yutong', skipWhen: ['sick', 'home'], weather: 'dry', months: [3, 4, 5, 9, 10], tiers: CLOSE, group: 'social' },
    { id: 'ed_mom_msg', text: '妈妈发微信问她吃得怎么样、冷不冷', window: 'evening', chance: 0.12, when: 'any', tiers: CLOSE, group: 'family' },

    // ───── 身体 / 睡眠 ─────
    { id: 'ed_slept_badly', text: '昨晚没睡好，翻来覆去到很晚', window: 'morning', chance: 0.1, when: 'any', group: 'body', feel: f('tired') },
    { id: 'ed_overslept', text: '早上睡过了头，差点迟到', window: 'morning', chance: 0.05, when: 'class_day', group: 'body', feel: f('annoyed') },
    { id: 'ed_headache', text: '下午有点头疼，喝了点热水', window: 'afternoon', chance: 0.05, when: 'any', group: 'body' },
    { id: 'ed_eyes_dry', text: '盯着屏幕太久，眼睛干得难受', window: 'evening', chance: 0.1, when: 'any', group: 'body' },
    { id: 'ed_stiff_neck', text: '低头看手机太久，脖子酸得不行', window: 'evening', chance: 0.08, when: 'any', group: 'body' },
    { id: 'ed_weird_dream', text: '做了个很怪的梦，醒来还记得', window: 'morning', chance: 0.06, when: 'any', group: 'body' },
    { id: 'ed_nap_good', text: '中午在宿舍睡了个很舒服的午觉', window: 'afternoon', chance: 0.1, when: 'any', tiers: CLOSE, group: 'body', feel: f('relief') },

    // ───── 买东西 / 钱 ─────
    { id: 'ed_voucher', text: '购物软件里领到一张满减券', window: 'evening', chance: 0.06, when: 'any', tiers: CLOSE, group: 'shop', feel: f('joy') },
    { id: 'ed_refund', text: '之前买的东西退款到账了', window: 'afternoon', chance: 0.03, when: 'any', tiers: CLOSE, group: 'shop', feel: f('joy') },
    { id: 'ed_pen', text: '买了支很好写的笔，十来块', window: 'afternoon', chance: 0.04, when: 'school', group: 'shop', cost: { amount: [8, 15], what: '文具' } },
    { id: 'ed_locker_full', text: '快递柜满了，等了一会儿才取到', window: 'afternoon', chance: 0.04, when: 'any', group: 'shop' },
    { id: 'ed_card_lost', text: '饭卡找了半天，原来在外套口袋里', window: 'afternoon', chance: 0.03, when: 'school', group: 'shop', feel: f('relief') },
];

/** 小测的一条线涉及的课：名字里有这些词的才有（水课没有） */
const MATH_COURSE = /高等数学|概率论|线性代数|离散/;
const CORE_COURSE = /数据结构|计算机网络|MySQL|数据库|操作系统|Linux|大数据|数据采集/;

export const EVERYDAY_EVENT_DEFS: readonly Def[] = DEFS;

/** 档位名去掉承认版的后缀（boyfriend-open → boyfriend） */
const baseTier = (tier: string): EventTier => tier.replace(/-open$/, '') as EventTier;

/** 一个档位看得到的补充小事；人物不在这一档的世界里（没有这个人）的不要；没有“小事”块的世界（陌生人 / 名单外）原样返回 */
export function everydayEventsFor(world: World, tier: string): WorldEventDef[] {
    const visible = baseTier(tier);
    return DEFS.filter(def => (def.tiers ?? ALL).includes(visible) && (!def.person || world.people.some(person => person.id === def.person)))
        .map((def): WorldEventDef => ({
            id: def.id, text: def.text, window: def.window, chance: Math.round(def.chance * EVERYDAY_SCALE * 1000) / 1000, when: def.when,
            ...(def.person ? { person: def.person } : {}), ...(def.skipWhen ? { skipWhen: def.skipWhen } : {}), ...(def.onlyWhen ? { onlyWhen: def.onlyWhen } : {}),
            ...(def.cost ? { cost: def.cost } : {}), ...(def.weekdays ? { weekdays: def.weekdays } : {}), ...(def.months ? { months: def.months } : {}),
            ...(def.weather ? { weather: def.weather } : {}), group: def.group, ...(def.feel ? { feel: def.feel } : {}),
            ...(def.requires ? { requires: def.requires } : {}), ...(def.afterCamera ? { afterCamera: true } : {}), everyday: true,
        }));
}

/** 把补充的小事加进这个世界（档位只看得到自己该看的）；小测的线开着。from：从这一天起才有（她已经过完的日子不改写） */
export function withEveryday(world: World | undefined, tier: string, from?: string): World | undefined {
    if (!world) return world;
    return { ...world, events: [...world.events, ...everydayEventsFor(world, tier)], quizzes: CLOSE.includes(baseTier(tier)), ...(from ? { everydayFrom: from } : {}) };
}

/**
 * 第一次开 everydayLife 时定下“从哪天起”并存进文件，以后重启都读同一个（和 needs-anchor.json 一个办法）：从第二天起，今天已经过的不改。
 * 文件读不了就用今天之后的一天，不去改写已经过的日子
 */
export function loadEverydayFrom(path: string, now: Date, log: (message: string) => void = () => undefined): string {
    const existing = readJsonOr<{ version?: number; from?: string }>(path, {}, message => log(`日常小事：${message}`));
    if (existing.version === 1 && typeof existing.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(existing.from)) return existing.from;
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const from = formatDate(tomorrow);
    writeJsonAtomic(path, { version: 1, from });
    log(`日常小事：从 ${from} 起生效（已经过完的日子不改）`);
    return from;
}

// ───────────────────────── 小测的一条线 ─────────────────────────

export interface Quiz {
    course: string;
    /** 'math'：数学类（怕数学，分数偏低）；'core'：专业课 */
    category: 'math' | 'core';
    /** 小测在哪一次课 */
    lesson: ClassToday;
}

const DAY_MS = 86_400_000;
const unitOf = (text: string): number => {
    let h = 0x811c9dc5;
    for (const ch of text) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
    // 只差最后一个字的两个键，FNV 的高位几乎一样；再过一遍 murmur 的收尾，让它们互相无关（小测的三个均匀数要独立）
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return (h >>> 0) / 2 ** 32;
};
const startOf = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate());
const weekOf = (schedule: Schedule, day: Date) => Math.floor((startOf(day).getTime() - new Date(`${schedule.semester.start}T00:00:00`).getTime()) / (7 * DAY_MS)) + 1;

function categoryOf(name: string | undefined): Quiz['category'] | undefined {
    if (!name) return undefined;
    return MATH_COURSE.test(name) ? 'math' : CORE_COURSE.test(name) ? 'core' : undefined;
}

/**
 * 这一周这门课有没有小测：每三周一个候选周（每门课按课名错开），数学类 75% 真考（大约每四周一次）、专业课 35%（大约每八周一次）；
 * 前两周和期末前最后两周不考
 */
function quizWeek(course: string, week: number, weeks: number, category: Quiz['category']): boolean {
    if (week < 3 || week > weeks - 2) return false;
    const offset = Math.floor(unitOf(`${course} quiz offset`) * 3);
    if ((week + offset) % 3 !== 0) return false;
    return unitOf(`${course} quiz ${week}`) < (category === 'math' ? 0.75 : 0.35);
}

const quizCache = new WeakMap<Schedule, Map<string, Quiz[]>>();

/** 这一天有哪几门课的小测（每门课那一周的第一次课）；只看课表，同一份课表同一天算一次 */
export function quizzesOn(schedule: Schedule, day: Date): Quiz[] {
    let byDay = quizCache.get(schedule);
    if (!byDay) quizCache.set(schedule, byDay = new Map());
    const key = formatDate(day);
    let found = byDay.get(key);
    if (!found) byDay.set(key, found = computeQuizzesOn(schedule, day));
    return found;
}

function computeQuizzesOn(schedule: Schedule, day: Date): Quiz[] {
    const { lessons, outsideSemester } = classesOn(schedule, day);
    if (outsideSemester) return [];
    const week = weekOf(schedule, day);
    const out: Quiz[] = [];
    for (const lesson of lessons) {
        const category = categoryOf(lesson.name);
        if (!category || !quizWeek(lesson.name!, week, schedule.semester.weeks, category)) continue;
        // 每门课那一周的第一次课：前面几天里没有同名的课
        const earlier = Array.from({ length: 6 }, (_, i) => classesOn(schedule, new Date(day.getTime() - (i + 1) * DAY_MS)))
            .some(({ lessons: before }, i) => weekOf(schedule, new Date(day.getTime() - (i + 1) * DAY_MS)) === week && before.some(l => l.name === lesson.name));
        if (!earlier) out.push({ course: lesson.name!, category, lesson });
    }
    return out;
}

/** 分数：数学类均值 72、专业课 83，近似正态（三个均匀数之和），按课名 + 日期定；38–99 */
export function quizScore(quiz: Pick<Quiz, 'course' | 'category'>, date: string): number {
    const sum = unitOf(`${date} ${quiz.course} s1`) + unitOf(`${date} ${quiz.course} s2`) + unitOf(`${date} ${quiz.course} s3`);
    const z = (sum - 1.5) / 0.5; // 三个均匀数之和的标准差 0.5
    const mean = quiz.category === 'math' ? 72 : 83;
    const sd = quiz.category === 'math' ? 11 : 8;
    return Math.max(38, Math.min(99, Math.round(mean + z * sd)));
}

/** 写的时候的感觉（按分数的档次，但不说分数；她写的时候不知道） */
function quizFeeling(score: number): string {
    return score >= 85 ? '写得挺顺' : score >= 70 ? '写得一般' : score >= 60 ? '有两道卡住了' : '好几道都没把握';
}

/** 出分之后的感受 */
export function quizFeel(score: number, category: Quiz['category']): EventFeel | undefined {
    if (score >= 90) return f('joy', 2);
    if (score >= 80) return category === 'math' ? f('joy', 1) : undefined;
    if (score >= 70) return category === 'math' ? f('relief', 1) : undefined;
    if (score >= 60) return f('worry', 1);
    return f('sad', score < 50 ? 3 : 2);
}

const SCORE_WORD = (score: number) => (score >= 90 ? '考得不错' : score >= 80 ? '还可以' : score >= 70 ? '中规中矩' : score >= 60 ? '刚过及格线附近' : '没考好');

/** 小测这条线在某一天发生的事：前一次课老师说要小测、当天小测、两天后出分；day 是她的这一天（0 点） */
export function quizEvents(schedule: Schedule, day: Date, atSchool: boolean): { id: string; text: string; at: Date; feel?: EventFeel }[] {
    if (!atSchool) return [];
    const date = formatDate(day);
    const events: { id: string; text: string; at: Date; feel?: EventFeel }[] = [];
    const clock = (base: Date, h: number, m: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m);
    // 今天的小测
    for (const quiz of quizzesOn(schedule, day)) {
        const score = quizScore(quiz, date);
        events.push({ id: `quiz_day:${quiz.course}:${date}`, text: `${quiz.course}课上小测，${quizFeeling(score)}`, at: new Date(quiz.lesson.start.getTime() + 45 * 60_000), ...(score < 70 ? { feel: f('worry') } : {}) });
    }
    // 两天前的小测今天出分（晚上）
    const back = new Date(day.getTime() - 2 * DAY_MS);
    for (const quiz of quizzesOn(schedule, back)) {
        const score = quizScore(quiz, formatDate(back));
        const feel = quizFeel(score, quiz.category);
        events.push({ id: `quiz_score:${quiz.course}:${formatDate(back)}`, text: `${quiz.course}小测的分数出来了，${score} 分（${SCORE_WORD(score)}）`, at: clock(day, 20, 10 + Math.floor(unitOf(`${date} ${quiz.course} score time`) * 40)), ...(feel ? { feel } : {}) });
    }
    // 明天有小测：今天最后一次同名课上老师说了（课后）
    const next = new Date(day.getTime() + DAY_MS);
    for (const quiz of quizzesOn(schedule, next)) {
        const last = classesOn(schedule, day).lessons.filter(l => l.name === quiz.course).at(-1);
        if (last) events.push({ id: `quiz_notice:${quiz.course}:${date}`, text: `${quiz.course}老师说明天小测`, at: new Date(last.end.getTime() - 10 * 60_000), feel: f('worry', quiz.category === 'math' ? 1 : 1) });
    }
    // 下一次课有小测但不在明天：在今天最后一次课上老师说“下次课小测”
    for (const lesson of classesOn(schedule, day).lessons) {
        const category = categoryOf(lesson.name);
        if (!category) continue;
        const nextQuizDay = Array.from({ length: 20 }, (_, i) => new Date(day.getTime() + (i + 2) * DAY_MS)).find(d => quizzesOn(schedule, d).some(q => q.course === lesson.name));
        if (!nextQuizDay) continue;
        // 今天就是这门课在小测之前的最后一次课
        const between = Array.from({ length: 21 }, (_, i) => new Date(day.getTime() + (i + 1) * DAY_MS)).filter(d => d < nextQuizDay && classesOn(schedule, d).lessons.some(l => l.name === lesson.name));
        if (between.length || events.some(e => e.id.startsWith(`quiz_notice:${lesson.name}`))) continue;
        events.push({ id: `quiz_notice:${lesson.name}:${date}`, text: `${lesson.name}老师说下次课小测`, at: new Date(lesson.end.getTime() - 10 * 60_000), feel: f('worry', 1) });
    }
    return events;
}
