# 抖音接入门槛与第一阶段方案

## 当前可确认的官方能力

抖音开放平台提供 OAuth 授权、用户管理、内容管理和数据能力，但具体接口需要创建应用、申请对应权限，并受应用类型和平台审核影响。内容发布能力属于需要单独申请的能力，不能把网页登录后的 Cookie 当成稳定接口使用。

第一阶段只实现以下能力：

1. 在控制台保存应用标识和回调地址，不保存明文密钥；
2. 生成官方 OAuth 授权入口；
3. 保存授权后的状态摘要、过期时间和最近错误；
4. 将她生成的内容先写入统一草稿箱，人工确认后再由官方授权应用发布；
5. 所有请求有超时、限速、失败退避和关闭开关。

## 暂不实现

- 使用浏览器 Cookie、逆向接口或模拟点击；
- 自动批量点赞、关注、评论、私信；
- 未经用户确认的实时发布或删除；
- 把任意公开视频或用户资料当作开放 API 数据源。

## 与当前项目的接法

- 复用 `presence/drafts.md` 的草稿语义，新增平台字段和素材引用；
- 复用现有平台熔断器，连续失败后暂停请求；
- DSH 只负责生成标题、正文和素材建议，不直接取得平台令牌；
- 发布动作必须经过现有设备 / 账号动作策略，并写入审计日志；
- QQ 回复只同步“草稿已生成 / 发布成功 / 发布失败”的摘要，不带令牌、Cookie 或完整错误堆栈。

## 官方资料

- [抖音开放平台接入概览](https://open.douyin.com/platform/resource/docs/accession-guide/platform-introduction/)
- [抖音内容发布方案](https://open.douyin.com/platform/resource/docs/ability/content-management/douyin-publish-solution/)
- [抖音权限与授权方式](https://open.douyin.com/platform/resource/docs/develop/permission/overall-permission)
- [抖音开放平台使用规范](https://partner.open-douyin.com/docs/resource/zh-CN/dop/operation-standard/platform-capabilities/usage-spec/)

## 结论

抖音可以接入，但必须按“官方 OAuth + 草稿优先 + 用户确认 + 审计”的路径推进。实际发布接口应在应用审核通过并拿到明确权限后再接入，避免先写一套不稳定的私有接口。
