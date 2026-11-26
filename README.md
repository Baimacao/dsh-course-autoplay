# dsh-course-autoplay（网课挂机）

在已登录的浏览器里自动播完网课并把进度推进到下一节，带可视化面板、可复用的站点经验、计划文档和自适应识别。

## 组成

    index.js            Host：工具、HTTP 路由、循环生命周期
    client.js           浏览器端：会话头部「挂课」按钮 + 浮层面板
    lib/engine.js       站点经验（JSON）→ 页面探针 / 决策 / 动作。plan 是纯函数，离线可测
    lib/profiles.js     经验库：内置 lib/profiles/*.json + 学到的 <data>/profiles/*.json，同名覆盖
    lib/discover.js     自适应：通用嗅探 → 拼草稿 → 复探确认
    lib/plan.js         计划文档：plan.md（给人看）+ plan.json（给面板）
    lib/runner.js       主循环：每轮每站点「读 → 判断 → 动 → 记账」
    lib/store.js        站点与状态
    lib/bsk.js          bsk CLI 薄封装（版本差异、失败识别）
    lib/log.js          运行日志（轮转保留说明）

## 自适应怎么工作

站点经验是数据，不是代码：

    {
      "id": "hnzjpx", "domain": "www.hnzjpx.cn",
      "listPage":   { "row": { "clickSelector": "button", "clickText": "立即学习",
                              "blockUp": 6, "blockMustContain": "学习进度", "progressRegex": "([0-9]+)%" } },
      "playerPage": { "videoSelector": "video",
                      "section": { "selector": ".section_list .section", "doneText": "已完成" } }
    }

遇到没见过的域名：

1. `autoplay_discover` 在页面里跑通用嗅探——找 video、找带百分比的可点条目、找同类兄弟列表、找页面自带的进度计数
2. 用最像的一组拼出草稿
3. **用草稿重新探一遍**，结构读不出来就不保存——一次 DOM 抖动不能被当成经验
4. 存进 `<数据目录>/profiles/<id>.json` 并把站点指过去

内置经验写错了？放一份同名文件到 `<数据目录>/profiles/` 就顶掉了，不用等插件更新

## 面板

会话标题栏的「挂课」按钮 → 浮层。里面是：目标与总进度、每站阶段和进度条、加站点、计划正文、日志尾部、数据目录与 bsk 状态、启停

面板数据全部来自 Host 的 `/course-autoplay/*` 路由，客户端不碰会话事件。拿不到 `webServer` 服务时插件会在日志里明确告警，而不是给一个空面板

## 工具

| 工具 | 用途 |
| --- | --- |
| `autoplay_sites` | list / add / update / remove，按域名自动匹配经验 |
| `autoplay_discover` | 自适应识别页面，dryRun 只看不存 |
| `autoplay_probe` | 只读探针，报结构和下一步计划 |
| `autoplay_run` | start / stop / status |
| `autoplay_log` | 日志尾部 |
| `autoplay_bsk` | daemon 与浏览器连接情况 |
| `autoplay_plan` | write / read 计划文档 |

## 环境要求

- `bsk` CLI 在 PATH 上，或配置 `bskPath`
- 浏览器装了 bsk 扩展并已连接
- daemon 由 **DSH 之外**的常驻任务跑：`bsk daemon start --foreground`。从 DSH 进程里 spawn 的进程会被 Job Object 收走（`os error 5`）

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `bskPath` | `bsk` | bsk CLI 路径 |
| `bskHome` | `<DSH_HOME>/bsk` | BSK_HOME，和 daemon 共用 |
| `dataDir` | `<DSH_HOME>/course-autoplay` | 配置、状态、经验、计划、日志 |
| `intervalMs` | `15000` | 两轮之间最短间隔 |
| `autoStart` | `false` | 加载后是否立刻开始 |
| `planTitle` | 空 | 计划文档里的目标；空则自动生成 |

## 测试

    node --test "test/*.test.js"

覆盖：引擎决策的每个分支、经验库匹配与覆盖、自适应草稿与可用性判定、计划文档、状态存取、日志轮转、循环单步

## 边界

- 不代填账号密码，只用浏览器已有的登录态
- 不改播放倍速
- 不把页面内容发到外部服务
- 关掉插件循环即停，状态与经验保留，重开可从断点继续
