# 给以后其他人聊天留的接口

不改代码，往运行数据目录放一个 `others.json` 就能加人。

## 文件位置

`<dataDir>/others.json`

本机当前是：

`C:\Users\22601\Desktop\astrbot创建\runtime\bot-shadow\others.json`

## 格式

```json
{
  "people": [
    {
      "qq": 10002,
      "name": "新同学",
      "tier": "classmate",
      "note": "选修课认识的，说话比较客气"
    }
  ]
}
```

- `qq`：QQ 号，必填；
- `name`：称呼，必填；
- `tier`：`boyfriend / bestie / girl_friend / known / classmate / stranger`，不写默认 `classmate`；
- `note`：一两句“他是谁”，会进提示词当人物描述。

## 规则

- 和 `koishi.yml` 里已有的人重复 QQ 会跳过；
- 坏条目（QQ 不是数字、没名字）跳过，不影响启动；
- 读完在启动时合并进名单；加人/改人后重启 Koishi 生效；
- 记忆、档位、回复器都按普通联系人走，不需要额外接。

## 给别的程序的接口

任何适配器/脚本只要写这个文件，就相当于“注册了一个可以和她聊天的人”。以后接微信、其他 QQ 号、群聊，都可以复用同一个文件格式。
