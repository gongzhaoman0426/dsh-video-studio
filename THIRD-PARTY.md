# 参考与依赖

本项目是独立实现，没有将两个参考项目的业务代码整体合并。当前范围是 DeepSeek Harness 会话创作插件及原生媒体服务设置，参考重点为创作方法、Tools、Skills、持久化、设置与媒体执行。

- `dsh-directorx`（本地提交 `86f7cf9`，Apache-2.0）：参考 DSH 原生 Tools / Skills 的组合方式、逐层改编方法、持久化创作流程、Config / volatile 设置方法和 FFmpeg 制作路径。原项目的会话视图与画布仅曾作为参考分析对象，当前方案不采用其前端实现。
- 外层 `dsh-video-studio`，即鲸影（本地提交 `36198b8`，MIT）：参考人物与场景资产、候选与异步媒体任务的职责划分，方舟适配器的请求与状态查询形状。新适配器位于 `src/providers/official.ts`，未携带旧项目账号或模型配置。
- DeepSeek Harness（本地提交 `4878cdabd8`）：宿主工具执行上下文、技能注册、系统提示、原生 Settings / ConfigForms / 设置插槽与生命周期接口核对及兼容烟测依据。

精确的参考文件路径及规划取舍见 `docs/PROJECT-PLAN.md` 附录 A。历史前端参考位置只用于说明已撤销方案的来源，不构成当前依赖或后续开发计划。

运行时使用 Zod、YAML（解析技能元数据并剥离 frontmatter）与 DSH Schemastery（原生设置 schema）；开发使用 TypeScript、esbuild、tsx 及 Node / React 类型包。设置面板使用宿主共享的 React，不打包独立 React 运行时。FFmpeg、ffprobe 和 macOS 的 say 由宿主机器提供，不包含在本包中。第三方许可以各依赖包自带的 LICENSE 为准。
