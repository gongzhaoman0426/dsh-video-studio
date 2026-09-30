# DSH Video Studio

在 DeepSeek Harness 会话里，一章一章把小说做成视频。

把本章正文贴给 DeepSeek，讨论改编，逐步形成场次、台词和分镜，再生成候选、采用镜头、配音与合成。全部操作通过 DSH 原有会话、Skills 和 Tools 完成：模型负责创作，插件负责保存、校验和制作，工具返回候选与成片的本地文件路径。

这是独立的新项目；包名为 **`dsh-chapter-video-studio`**，用于区别外层已有的同名参考项目。创作使用 DSH 会话、Skills 和 Tools，媒体 API Key 与模型在 **DSH 设置 → 插件 → 视频工作室** 配置。客户端仅提供这个设置面板。

## 当前版本

0.1 的会话工具链包括：

- 多作品、多章节、会话绑定、原文版本、作品修订和历史快照。
- 共享角色/场景/道具/风格、剧情事实及来源；按章节过滤当时已知的设定。
- 模型创作结构化剧本与分镜，检查动作/台词覆盖、来源引用、镜头时长；局部修改保留其他镜头和旧候选。
- DSH 原生工具及 `chapter-video-authoring`、`chapter-video-production` 两个技能，完成从正文到本地成片交付的协作。
- 图片、视频、音频后台任务；持久化远端任务 ID、操作去重、恢复查询、取消请求和结果校验。
- 火山方舟图片/视频适配器、OpenAI-compatible TTS 适配器；通过 DSH 设置配置密钥和模型，支持显式切换到宿主环境变量，不另建文本大模型服务。
- 无付费调用的本地预演卡、macOS 本地试配音、FFmpeg 合成 MP4 / SRT / 时间线 JSON。
- 通过 `video_studio_job` 的 `list` 操作返回的 `files` 清单，取得作品内已登记候选和成片的本地绝对路径，在 DSH 会话中说明结果与交付方式。

本地预演有明确水印，**不是 AI 生成画面**。静帧平移会标注 `STILL IMAGE`，不会冒充生成视频。真实生成需要你自己的服务配置；供应商协议测试使用注入的响应，未用真实账号验证付费生成。

详细规划见 [docs/PROJECT-PLAN.md](docs/PROJECT-PLAN.md)，实现范围与验证记录见 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)。

## 安装到 DSH

要求 Node.js `^22.19.0 || >=24.0.0`、已可用的 DeepSeek Harness 和 pnpm。媒体制作还需要带 `libx264` 支持的 FFmpeg 与 ffprobe；缺少媒体能力时仍可在会话中创作和保存正文、剧本与分镜。当前宿主兼容基线是本地 DSH `0.2.0-rc.1`，提交 `4878cdabd8`。

支持 `ass` 的 FFmpeg 会烧录字幕；缺少该模块时使用 MP4 内嵌软字幕轨和独立 SRT，时间线明确记录交付方式。缺少 `drawtext` 时，本地预演使用内置点阵文字标识。软字幕是否显示取决于播放器，SRT 可在剪辑软件或播放器中加载。

在此目录执行：

```sh
npm ci
npm run check
dsh plugin --profile web add .
dsh --profile web
```

如果没有全局 `dsh`，本地仓库已构建时可以使用：

```sh
node /Users/zhaoman/code/deepseek/deepseek-harness/apps/cli/lib/bin.js plugin --profile web add /Users/zhaoman/code/deepseek/projects/dsh-video-studio
node /Users/zhaoman/code/deepseek/deepseek-harness/apps/cli/lib/bin.js --profile web
```

先构建再安装。`dsh.bundle.patch` 将宿主插件加入所选 profile，加载 Tools、Skills、创作指引和设置 schema；客户端注册 DSH 原生设置面板。这里的 `web` 是 DSH 宿主 profile 名称；使用其他 profile 时替换即可。更新本项目后重新构建、更新 profile 中安装的本地包并重启 DSH。

进入有工作区的 DSH 会话，直接把小说正文贴给 DeepSeek 即可开始。

### 安装后提示 failed to import

插件入口为 `lib/index.js`，设置客户端为 `lib/client.js`。Git 仓库不提交 `lib`，因此 Git 安装需要通过 `prepare` 自动构建；如果安装的是没有 `prepare` 的旧版本，包虽已安装，启用时仍会因入口文件不存在而失败。重新启用或填写 API Key 无法补齐这些文件。

本项目通过 `prepare` 在依赖安装和打包时构建入口。通过 Git 安装时，需要远端包含此修复；如果 DSH 提示批准插件构建脚本，检查并允许对应构建项后重试。已有旧包不会因本地源码改动自动更新。

本机修复可在项目目录执行 `npm ci` 和 `npm pack`，然后在 DSH 的插件安装入口填写生成的 `dsh-chapter-video-studio-0.1.0.tgz` 的绝对路径，更新并重新启用插件。该包已经包含编译入口，安装时无需再次构建。桌面版可能使用独立 profile，优先通过当前桌面内安装入口更新。

## 从第一章开始

可以直接这样说：

```text
创建《渡口》这个视频作品，横屏，水墨写实风格。
下面是第一章，先理解情节，和我讨论怎么改编：
[粘贴一章正文]
```

DeepSeek 先保存原文、读取已知设定，在会话中给出场次和改编建议。你可以继续：

```text
独白保留为旁白，渡口那场不要删，按这个方向拆分镜。
第三镜从背后拍，第五镜多停两秒。
分镜可以了，先对前两镜做本地预演。
```

预演不需要供应商密钥。让 DeepSeek 查询候选并返回文件路径；查看素材后，在会话中指定采用哪一版：

```text
列出前两镜的候选和本地文件路径。
第一镜采用第二版，第二镜采用第一版。
按已采用的镜头合成，加入字幕，缺少配音的镜头使用本地试配音。
完成后给我视频、字幕和时间线的本地文件路径。
```

真实生产流程使用相同的分镜与候选机制，在会话中说明使用真实生成及本次镜头范围。DeepSeek 通过工具将模式设为 `production`。图片候选可以直接做静帧视频；先采用图片，再生成视频时，所选图片作为首帧参考传入已配置且支持参考输入的通道。

原视频音轨在合成时静音，已经采用的配音始终使用。本地试配音只为缺少已选音频的镜头补旁白，相关成片标为预演。用户可通过工具返回的路径，用现有本地播放器检查成片。

下一章直接贴到同一或新会话中：

```text
继续《渡口》，下面是第二章。沿用已确认的人物与画风，先看看有什么新场景。
[粘贴第二章正文]
```

作品、章节和候选有稳定 ID，但用户不必记住工具参数。DeepSeek 应先读取上下文，明确当前作品和章节，再按你的指令保存或制作。

## 配置媒体服务

在本机 DSH 打开 **设置 → 插件 → 视频工作室**，配置来源选择默认的“DSH 设置”：

1. **图片与视频 / 火山方舟**：填写 API Key、接口根地址，以及本账号可用的图片和视频模型或接入点 ID。按实际模型能力设置参考图、首帧参考和支持的时长。
2. **配音 / OpenAI-compatible TTS**：填写 API Key、接口根地址、模型和音色 ID。接口必须支持 `/audio/speech`。
3. 保存后，新请求立即读取配置，不需要重启；保存本身不会请求供应商或验证账户权限。

密钥输入不会回显已有值，留空保存表示保留；清空已有密钥使用明确的清空操作。保存带配置版本检查，冲突不会覆盖另一页面的新修改。设置由 DSH 保存在当前 profile 的 Cordis patch，读取时脱敏；这是宿主配置文件，并非额外加密的密钥库。密钥不进入小说、提示词、工具结果或浏览器持久存储。按当前 DSH 的规则，远程浏览器处于 memory 模式时该面板不可写，请在宿主本机配置。

如果已有服务器环境配置，可将配置来源切换为“宿主环境变量”。两种来源整组切换，空字段不会偷偷回退到另一个账号。复制 `.env.example` 为本机 `.env`，填写需要的通道；插件**不自动加载 `.env`**，变量需要进入启动 DSH 的进程环境：

```sh
set -a
source .env
set +a
dsh --profile web
```

| 变量 | 用途 |
| --- | --- |
| `DSH_VIDEO_ARK_API_KEY` | 方舟服务密钥 |
| `DSH_VIDEO_ARK_BASE_URL` | 默认为 `https://ark.cn-beijing.volces.com/api/v3` |
| `DSH_VIDEO_ARK_IMAGE_MODEL` / `VIDEO_MODEL` | 本账号可用的模型或接入点 ID；不预填可能失效的模型名 |
| `DSH_VIDEO_ARK_IMAGE_REFERENCES` / `VIDEO_REFERENCES` | 所配置模型确实支持参考图片时设为 `1` |
| `DSH_VIDEO_ARK_VIDEO_DURATIONS` | 模型支持的秒数，用逗号分隔；默认 `5,10`，请求不会静默取整 |
| `DSH_VIDEO_ARK_IMAGE_SIZE` | 可选，按模型支持设置；默认跟随画幅 |
| `DSH_VIDEO_TTS_API_KEY` / `BASE_URL` | 支持 `/audio/speech` 的服务；base URL 含 `/v1`，不含 `/audio/speech` |
| `DSH_VIDEO_TTS_MODEL` / `VOICE` | 该服务可用的模型与音色 |
| `DSH_VIDEO_FFMPEG` / `FFPROBE` | 可选，可执行文件路径，默认从 PATH 查找 |

DSH 设置保存后供后续请求使用；更改启动环境或 FFmpeg 路径需要重启宿主。已经执行的任务沿用已捕获的原配置，排队和恢复任务会核对原配置指纹，不会换账号重提；不匹配时恢复原配置再继续。诊断只检查本地配置与可执行文件，不调用供应商，也不代表账号权限已经验证。

## 数据、恢复与错误处理

作品保存在 **DSH 会话的工作目录** 下：

```text
.dsh-video-studio/
  bindings/                    会话与作品/章节绑定
  locks/                       作品事务锁
  works/<workId>/
    state.json                 当前完整状态
    history/<revision>.json    修改前的不可变快照
    media/assets/              参考资产与生成结果
    media/jobs/<jobId>/         任务中间文件
    media/renders/<renderId>/   MP4、字幕、时间线与合成输入
```

工具从当前 DSH 会话解析工作目录，不依赖额外的全局工作区登记表。备份创作成果应备份工作区的整个 `.dsh-video-studio` 目录。

写入带版本号；两个会话同时修改发生冲突时，DeepSeek 应重新读取、比较差异，再提交实际需要的字段，不自动覆盖。更新正文、分镜或相关设定会使原确认失效，旧原文、决定、素材和成片仍保留。视频、图片和声音的依赖分别计算，未受影响的候选可继续使用。

生成任务提交后会在宿主后台执行。重启后可以在会话中说“恢复这个作品的制作任务”，由 DeepSeek 调用 `video_studio_job resume`：已知远端 ID 继续查询，已有文件继续校验；丢失提交响应的真实任务标为 `unknown`，不会盲目再次扣费提交。查询供应商确认结果后，再明确决定是否创建新候选。

“取消”先停止尚未提交的本地工作。当前方舟适配器未声明远端取消能力，已经接收的请求继续跟踪最终状态；取消不代表供应商退费或停止计算。

发生进程强杀并提示遗留锁时：先停止所有使用该工作区的 DSH 进程，备份目录，核对锁文件中的 PID 确实已退出，再移走提示路径对应的锁，重启并恢复任务。不要在仍有写入进程时删除锁。

配音比镜头长时合成会报出时长，保留原素材；应调整分镜时长或台词后重新确认。视频不足目标时长时也不会静默截断剧情或用冻结画面补足。

## 开发与验证

```sh
npm run typecheck
npm test
npm run build
node scripts/dsh-smoke.mjs /absolute/path/to/deepseek-harness
node scripts/dsh-settings-smoke.mjs /absolute/path/to/deepseek-harness
node scripts/dsh-settings-client-smoke.mjs /absolute/path/to/deepseek-harness
npm run test:package
npm run demo:preview
```

宿主 smoke 使用宿主已构建的 Cordis、Tools、Skills 和 SystemPrompt 服务加载本插件；设置 smoke 使用临时 profile 的真实 Loader、ConfigEditor 和 Settings 验证脱敏、保存、热更新及重启恢复。设置客户端 smoke 使用真实 ModuleSystem、ConfigForms 和 Slots，以模拟传输和 jsdom 检查实际表单填写、保存、保留及清空密钥。测试不修改你的 profile，不调用文本模型或付费媒体接口。`demo:preview` 用会话工具流制作本地预演，验证素材、成片与交付路径。

模块划分：`src/domain` 管理数据与校验，`src/host` 提供 DSH 工具和当前会话工作区接入，`src/providers` 适配生成服务，`src/media` 和 `src/jobs` 负责后台任务及剪辑。`src/config.ts` 定义原生设置，`src/client` 仅承载设置表单；没有创作工作台、独立网页或插件 HTTP 服务。

0.1 尚未实现角色专用设定图生成流程、多角色音色/口型、BGM 音效编排、独立字幕/音量/排序编辑、剪映草稿和一章拆多集。这些可按会话工具能力逐步扩展；当前导出是章节级 MP4、SRT 和内部时间线 JSON。当前导出采用轻量分辨率：横屏 `640×360`、竖屏 `360×640`、方形 `480×480`。
