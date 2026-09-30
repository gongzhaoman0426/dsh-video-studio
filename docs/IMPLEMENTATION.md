# 0.1 实现与验收记录

日期：2026-09-30。独立项目路径：`/Users/zhaoman/code/deepseek/projects/dsh-video-studio`。

当前交付范围是 **DSH 原生会话 + Skills + Tools + 媒体服务设置**。章节创作与制作通过会话完成，API Key、地址和模型在 DSH「设置 → 插件 → 视频工作室」配置。客户端仅有设置表单，没有章节工作台、定制工具结果卡、独立网页或 HTTP 媒体接口。

完整产品方向以修订后的 [PROJECT-PLAN.md](PROJECT-PLAN.md) 为准。本文记录保留的实现范围及会话工具与原生设置的验证结果。

## 1. 会话创作与交付流程

```text
DSH 会话贴入本章
  → 创建/打开作品、保存原文和段落 ID
  → DeepSeek 阅读章节与历史上下文
  → 在会话中讨论改编，登记设定与来源事实
  → 保存场次、动作/台词和镜头草案
  → 校验并记录用户对当前修订的确认
  → 指定镜头制作图片/视频/声音候选
  → 查询任务及 files，返回候选编号和本地路径
  → 用户在会话中指定采用哪一版
  → 已选画面 + 已选声音或本地试配音 + 字幕
  → FFmpeg 合成 MP4 / SRT / 时间线 JSON
  → 查询 files，交付本地文件路径与可用状态
  → 下一章读取已有设定与剧情事实继续
```

文本创作由 DSH 当前模型执行。插件没有另起文本 LLM 后端，也没有用断句算法替代改编或拆镜。无需整书导入，不预设总章数、总集数。

全部创作交互留在既有 DSH 聊天中。进度、分镜表、候选和失败原因由标准工具结果返回，DeepSeek 根据实际结果组织回复。工具返回本地媒体路径，用户可使用已有播放器查看；插件不建立用于预览或下载的 Web 服务。

## 2. 参考项目如何落到实现

| 来源 | 保留的方法 | 新实现的位置 |
| --- | --- | --- |
| DirectorX | DSH 工具、运行时技能、沿用宿主对话编排 | `src/index.ts`、`src/host/tools.ts`、`skills/chapter-video-authoring` |
| DirectorX / DSH | Config 叶子 volatile、secret 脱敏、原生设置持久化与 ConfigForms 表单 | `src/config.ts`、`src/client`、`scripts/dsh-settings-smoke.mjs` |
| DirectorX | 创作对象落盘、分阶段推进、命令式 FFmpeg 处理 | `src/domain`、`src/media/render.ts` |
| 鲸影 | 作品与角色/场景资产、镜头候选及异步生成职责分离 | `src/domain/types.ts`、`src/media/service.ts`、`src/jobs/queue.ts` |
| 鲸影 | 方舟图像与视频请求、远端任务 ID、状态查询思路 | `src/providers/official.ts` |
| 宿主实际源码 | 工具 JSON schema、session.header.cwd、技能和系统提示注册、生命周期清理 | `scripts/dsh-smoke.mjs` 验证实际契约 |

创作工作台、固定集数模型和旧项目凭证不属于当前复用范围。新包标识为 `dsh-chapter-video-studio`，工具前缀为 `video_studio_`，数据目录独立于两个参考项目。媒体供应商仍通过各自协议访问远端服务，这与已撤销的插件 HTTP 接口不同。

## 3. 对象、版本与连续性

- `WorkState` 是事务边界，保存 chapters / canon / facts / assets / jobs / takes / renders / decisions / events；每次更新递增作品 revision。
- 每章保存独立 chapter revision、全部 source revisions、当前来源、draft、approval 和 adopted takes。来源段落 ID 随原文内容计算，工具返回给模型用于追溯。
- 场次包含 beat（action / dialogue / narration）；镜头引用 beat IDs。校验覆盖、重复、顺序、角色与来源，实际配音文本需要覆盖相关台词。
- 共享设定更新保留历史及 knownFromChapter。回看前章使用当时可知的版本，不把后章伤势、身份揭示等提前应用。
- 原著与改编事实分开；模型推测不能直接标为确认。改原文后，引用旧来源的事实会撤销确认并标待复核，在后章上下文中提示。使用旧证据重新保存不能绕过待复核状态。
- 画面、视频、声音分别计算依赖指纹。局部改稿保留全部旧候选与成片；不匹配当前输入的候选不能直接作为当前结果采用或合成。
- 两个 DSH 会话可以分别绑定不同章节。遇到作品修订冲突时，调用方需要重读、比较并提交实际改动，不能用旧对象整体覆盖新状态。

存储使用会话工作目录下的 `.dsh-video-studio`、类型校验、作品锁、修改前不可变快照、临时文件写入、fsync 和 rename。没有自动覆盖冲突，也没有静默重置损坏状态。锁文件强杀恢复采用保守的人工核对方式；暂不提供跨 schema 大版本迁移和一键回滚工具。

## 4. DSH 工具与技能

| 工具 | 职责 |
| --- | --- |
| `video_studio_work` | 建立/列出/打开作品，绑定本会话 |
| `video_studio_chapter` | 新增章节或保存原文新版本 |
| `video_studio_context` | 读取当前章及截至此章的设定、事实、决定和下一步 |
| `video_studio_draft` | 保存模型创作的剧本分镜或局部修改单镜 |
| `video_studio_canon` | 维护共享人物、场景、道具、风格 |
| `video_studio_fact` | 保存原著事实、改编事实、推测和证据 |
| `video_studio_decision` | 记录已表达的确认、撤销和改编意见 |
| `video_studio_validate` | 只读检查剧本、分镜与已选素材 |
| `video_studio_generate` | 指定镜头、媒介、模式和操作键提交制作任务 |
| `video_studio_job` | 查询/恢复/取消任务；`list` 返回任务、候选、渲染和本地交付文件清单 |
| `video_studio_take` | 采用指定候选，保留其他版本 |
| `video_studio_asset` | 复制用户明确提供的本地参考资产到作品素材库 |
| `video_studio_render` | 基于已采用素材提交章节合成 |

运行时技能与目录统一为：

- `skills/chapter-video-authoring/SKILL.md`：逐章理解、改编、剧本、分镜、连续性和修改。
- `skills/chapter-video-production/SKILL.md`：素材、候选、媒体任务、采用、恢复、合成和本地交付。

宿主 system prompt 提供简短使用指引，详细字段与创作步骤在技能内。宿主创作入口接入 Tools、Skills 和 SystemPrompt，设置通过 Loader 的 Config / volatile 与 Settings 持久化；工作区从工具执行上下文的当前 DSH 会话解析，持久绑定保存在该工作区。无额外聊天服务或全局浏览器工作区 registry。

工具输出剔除凭证和供应商签名 URL。交付清单中的本地绝对路径用于定位已经登记的媒体；它不授权读取任意路径或其他作品的文件。

## 5. 制作通道与真实边界

| 通道 | 保留的实现 | 本轮验证状态 | 未验证边界 |
| --- | --- | --- | --- |
| local-preview | FFmpeg PNG/MP4 预演卡，明确非 AI 标识；macOS say 试配音 | 本机样例生成、文件路径交付与轨道/时长检查通过 | 其他操作系统本地声音；它本来就不是 AI 画面服务 |
| Ark | 图像生成、视频任务提交/查询；真实参考图数据字段；模型/时长能力校验 | 注入响应的协议与故障测试通过 | 用户账号、实时模型权限、在线生成质量及账单 |
| compatible-tts | `/audio/speech`、模型/音色配置、MP3 接收 | 类型检查与媒体音轨采用测试通过 | 具体 TTS 服务在线请求、多人物音色、情绪/音色克隆 |

任务采用显式 operationId：同一操作重投不新增任务，用户明确再做一版则使用新操作。后台 worker 提交前重新检查分镜确认和指纹。持久保存 remoteId 后恢复查询；unknown 不自动重提。取消意图与真实远端结果分开，迟到结果不自动采用。下载中断仅重拉原结果，完整下载、探测、解码成功后才入库。确定损坏的媒体标为失败，不会永久卡在校验中。

队列并发有界；生成与渲染使用独立队列。正常卸载会终止子进程并等待状态保存和锁释放。进程强杀后的遗留锁见 README 恢复步骤。

### 5.1 媒体服务设置

- `src/config.ts` 暴露 DSH 原生 Config，全字段为 volatile 叶子；API Key 标记为 secret，客户端不会读回明文。
- 当前宿主不会自动根据 Config 生成页面，因此 `src/client` 仅注册 `settings.plugins.tab`，通过 ConfigForms 读取脱敏描述与原子保存。
- API Key 空输入保留原值，显式清空写入空值以覆盖继承值；secret presence 表示存在保存值，不代表密钥有效。
- 使用宿主 profile Cordis patch 持久化，并非额外加密的凭证库。浏览器不保存密钥，远程 memory 模式面板不可写。
- 默认来源为 DSH 设置；显式选择环境变量模式才读取旧环境配置，不混用账号。
- 已有工作区的新请求读取最新配置；运行中的 worker 捕获原 provider，排队及恢复任务继续核对 providerConfigId，变更账号不会自动重发。
- 保存与诊断不调用供应商。实际账户权限和在线生成仍待真实账号验证。

## 6. 成片与本地路径交付

- 按镜头顺序使用已采用视频；没有视频时使用已采用图片并做明确标注的轻微运镜。
- 原视频音轨静音，始终使用已采用配音。`voice=true` 仅在缺少已选声音时补本地试配音，相关产物标为预演。
- 配音长于镜头、视频短于目标时长时拒绝完成，不静默切掉台词或冻结补时。
- 支持字幕烧录；无 libass 时输出 MP4 `mov_text` 软字幕轨 + SRT。字幕按镜头和实际配音时长对齐，尚无字级强制对齐。
- 保存输入计划、素材哈希、最终 timeline、MP4、SRT；重渲染不提交媒体模型请求。
- `video_studio_job` 的 `list` 操作返回 `files` 数组，包含本地绝对 `path`、`available`、`kind` / `mimeType` 及相应 `assetId` 或 `renderId`。模型据此报告可用文件，不能把缺失文件说成已交付。
- 字幕是烧录还是软轨道以渲染时间线的 `subtitleDelivery` 为准。交付时同时说明播放方式、预演标识、分辨率与尚未完成的制作步骤。
- 当前工作预览分辨率为横屏 640×360、竖屏 360×640、方形 480×480。尚未提供高清导出选项、独立字幕编辑、多轨编排或剪映格式。

## 7. 本轮验收复核

本轮验收覆盖会话工具、技能、领域存储、媒体任务及原生设置。设置面板的测试不包含创作工作台或插件 HTTP 服务。

| 检查 | 当前记录 |
| --- | --- |
| `npm run typecheck` | 通过；宿主、领域、媒体、设置客户端与测试类型检查 |
| `npm test` | 36 项通过：领域 7、宿主 4、媒体 12、技能 2、配置 3、设置客户端 8 |
| `npm run build` | 通过；完整 `npm run check` 通过，产物为宿主插件及约 19 KB 的原生设置客户端，共享宿主 React |
| 真实 DSH smoke | 通过；实际加载 Cordis、Tools、Skills、SystemPrompt，注册 13 工具、2 技能，执行 7 次工具调用并清理；不依赖 WebServer、Connection 或 Credentials 服务，不访问网络 |
| 真实 DSH Settings smoke | 通过；临时 profile 的 Loader / ConfigEditor / Settings 验证配置发现、密钥脱敏、原子保存、版本冲突拒绝、同 fiber 热更新、既有工作区读取新模型与重启恢复；6 次工具调用、0 网络请求 |
| DSH 设置客户端 smoke | 通过；真实 ModuleSystem / ConfigForms / Slots 加模拟远端传输，在 jsdom 渲染实际表单并填写、保存、留空保留和明确清空密钥，验证保存后密码输入清空、版本拒绝与设置页生命周期；不代表真实浏览器视觉验收 |
| `npm run demo:preview` | 通过；工具流生成并采用本地素材、试配音和合成，MP4 时长约 10.021333 秒，确认视频/声音/中文字幕轨、SRT 与时间线 |
| 本地交付检查 | 通过；样例通过 `video_studio_job list` 的 `files` 返回 MP4、SRT、时间线 3 个本地文件，宿主测试检查交付与文件可用状态 |
| 安装包检查 | `npm pack --dry-run` 通过；宿主、技能、文档与设置客户端在包内，无创作工作台或独立 HTTP 服务 |

复现命令：

```sh
npm run check
npm run test:dsh -- /absolute/path/to/deepseek-harness
npm run test:settings -- /absolute/path/to/deepseek-harness
npm run test:settings-client -- /absolute/path/to/deepseek-harness
npm run demo:preview
```

测试与预演应使用临时工作区，不修改用户 profile、不调用付费供应商。验收样例位置由 `.test-output/demo/receipt.json` 记录，该目录被 Git 忽略。本轮环境为 macOS、Node 24.19.0、本机 FFmpeg 与 ffprobe；样例和宿主 smoke 均未调用真实供应商。

## 8. 与完整规划的差距

| 规划阶段 | 当前实现边界 |
| --- | --- |
| M0 / M1 | 核心对象、独立包、宿主构建、存储、原生工具/技能注册与卸载；纯会话接入已通过本轮 smoke |
| M2 | 剧本与分镜的模型创作工具、来源校验、局部修改和跨章上下文；真实文本模型的创作质量仍需用用户章节走读 |
| M3 会话协作与交付 | 由上下文/任务工具提供状态与候选，通过 `files` 清单交付本地路径；原前端里程碑已撤销 |
| M4 | 参考资产、候选、队列、恢复和生产适配器；真实账号在线验收未做，角色专用设定图生成流程待扩展 |
| M5 | 工作预览成片；独立字幕/音量/排序编辑、多角色配音、高清成片待做 |
| M6 | 自动测试、真实宿主 smoke、配置/恢复文档；完整发布兼容矩阵与迁移工具仍待后续版本 |

规划 A01–A25 不能全部标为端到端验收完成。特别是 A01 的真实模型协作质量、A14 的在线参考一致性、A15 的字幕/音量/排序独立编辑、A18 的三个插件完整共存，需要后续真实创作或功能扩展验证。本轮已验证纯会话工具流程、本地文件路径交付、持久化和媒体执行；这些结果不能替代真实在线生成与用户创作验收。

下一次真实创作应使用用户提供的一章，在 DSH 中完成文本与分镜讨论后，再为少量已确认镜头配置并联调真实供应商。API Key 通过 DSH 原生设置配置，可显式切换到环境变量模式，不保存在小说、提示词或工具结果中。
