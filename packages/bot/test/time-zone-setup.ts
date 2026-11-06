// 测试固定在她的默认时区（ADR 0331）：用例里的 +08:00 时刻按上海的本地时间断言，不取决于跑测试的机器设成哪个时区。
// package.json 的 test 脚本用 --import 预加载；node --test 会把它带进每个测试文件的子进程。
import { applyTimeZone, DEFAULT_TIME_ZONE } from '../src/platform/time-zone.ts';

applyTimeZone(DEFAULT_TIME_ZONE);
