// 本机的两个小命令（直接改 runtime/chat-bridge/devices.json，中继在跑也行，它每次都重新读）：
//
//   npm run pair --workspace @qqbot/chat-bridge                          生成一个配对码
//   npm run devices --workspace @qqbot/chat-bridge                       列出已配对的设备
//   npm run devices --workspace @qqbot/chat-bridge -- revoke <deviceId>  撤销一台
import { join } from 'node:path';
import { dataDirFrom } from './config.ts';
import { createDeviceStore, fileDeviceStorage } from './devices.ts';

const [command, ...args] = process.argv.slice(2);
const devices = createDeviceStore({ storage: fileDeviceStorage(join(dataDirFrom(process.env), 'devices.json')) });

if (command === 'pair') {
    console.log(`配对码：${devices.startPairing()}`);
    console.log('10 分钟内有效，只能用一次，输错 5 次作废。在手机 App 里输入它。');
} else if (command === 'devices' && args[0] === 'revoke') {
    const id = args[1];
    if (!id) {
        console.error('用法：npm run devices --workspace @qqbot/chat-bridge -- revoke <deviceId>');
        process.exitCode = 1;
    } else if (devices.revoke(id)) {
        console.log(`已撤销 ${id}。中继在跑的话，这台设备几秒内会被断开。`);
    } else {
        console.error(`没有这台设备：${id}`);
        process.exitCode = 1;
    }
} else if (command === 'devices' && (args[0] === undefined || args[0] === 'list')) {
    const list = devices.list();
    if (!list.length) console.log('还没有配对过的设备。');
    for (const device of list) console.log(`${device.id}  ${device.name}  配对于 ${new Date(device.createdAt).toISOString()}`);
} else {
    console.error('用法：cli.ts pair | devices [list] | devices revoke <deviceId>');
    process.exitCode = 1;
}
