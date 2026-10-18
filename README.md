# Desktophelper（重写版）

一个本地优先的实时面试辅助浮层：转写、自动回答、截图分析、知识库。
本项目是 **clean-room 重写**，没有账号、没有登录、没有 Token 刷新、没有服务端订阅或权益校验。
发布页：<https://github.com/1494350447/desktophelper/releases/latest>

- 默认使用本地演示模型，无需任何 Key 即可跑通完整流程。
- 要获得真实回答，切换到任意 OpenAI 兼容接口并填写自己的 API Key。
- 转写、截图和知识库默认只保存在本机。
- 渲染层禁用 Node.js，所有能力通过命名 IPC + 校验 + 稳定错误码暴露。

## 仓库内容

这里只包含源码、测试、构建脚本与自有图标：

- 不包含 Electron 运行时、打包后的 EXE/ZIP、`dist/`、`work/` 或用户数据。
- 不包含任何 API Key、登录凭据、原应用资源或加密资源。
- 首次运行请执行 `node scripts/fetch-electron.mjs` 获取运行时。
- 二进制通过 GitHub Actions 构建并发布到 GitHub Releases；单文件 EXE 超过 100 MiB，不进入源码仓库。

## 当前状态

已完成并验证：

- Electron 主进程 / preload / renderer / shared 分层。
- 命名 IPC 通道、payload 校验、IpcResult 错误封装。
- 会话、转写、自动回答、队列、取消、重试、回答条数上限。
- 语音与截图双通道：独立页面、独立生成状态、独立取消与队列，语音进行中仍可截图解题。
- 全屏截图、区域截图、截图组采集、组级解题/重试、归档重试。
- 本地知识库导入、分块、BM25 检索、引用文档提示。
- 可选本地应用锁（PIN），仅保护本机数据，不参与功能授权。
- 单元/服务测试 + Electron E2E 探针（登录页不存在、渲染层无 Node、浮层命中与穿透、独立语音页收音状态、截图工作台布局、分组与单图删除、题组滑动切换、截图成功、窗口排除生效）。
- 单栏紧凑浮层 + 横向截图组卡片；设置页按需展开双栏工作区，资料库保持单栏，快捷键中心带冲突检测，旧版快捷键配置自动迁移。

## 环境要求

- Windows 10/11（当前验证环境）。
- Node.js 22+（已在 24.x 上验证）。
- Electron 29.4.6 运行时：首次执行 `node scripts/fetch-electron.mjs`，脚本会从
  npmmirror 下载官方压缩包、校验 SHA-256 并解压到 `work/e2e-runtime`。
- 启动脚本会把构建产物部署到 `work/e2e-runtime/resources/app`，不会改动运行时原始文件。

项目本身没有 npm 依赖，不需要 `npm install`。

## 快速开始

```powershell
git clone git@github.com:1494350447/desktophelper.git
cd desktophelper
node scripts/fetch-electron.mjs
.\start.cmd
```

`start.cmd` 会自动查找系统 Node 或 Codex 内置 Node，避免 PATH 中找不到 `node`。也可以直接执行：

```powershell
node scripts/build.mjs        # 构建到 out/
node --test tests/*.test.ts   # 单元与服务测试
node scripts/e2e.mjs          # 启动 Electron 并做端到端探针
node scripts/run-electron.mjs # 日常启动
```

也可以使用 package.json 脚本：

```powershell
npm test
npm run build
npm run e2e
npm start
npm run verify   # 测试 + E2E
```

> `npm` 只是脚本入口。若系统没有 npm，直接执行上面的 node 命令即可。

## 打包为 EXE

运行下面的命令后，产物会生成在 `dist/`（该目录已在 `.gitignore` 中排除，不会提交）：

- 目录版：`dist/Desktophelper-0.1.0-win-x64/Desktophelper.exe`
- 单文件版：`dist/Desktophelper-Portable-0.1.0.exe`
- 压缩包：`dist/Desktophelper-0.1.0-win-x64.zip`
- 校验值：`dist/SHA256SUMS.txt`

打包命令：

```powershell
node scripts/package.mjs           # 目录版 + zip
node scripts/package-portable.mjs  # 单文件便携 EXE
```

说明：

- 使用 `work/e2e-runtime` 中的 Electron 29.4.6 干净运行时；下载压缩包缓存在 `work/electron-cache`。
- 目录版启动最快，整个文件夹可以复制到任意位置，但不能只复制 exe。
- 单文件版首次启动会解压到 `%LOCALAPPDATA%\DesktophelperApp\0.1.0-<构建指纹>`，之后直接启动；重新打包会生成新的构建指纹。
- 未做代码签名，Windows 首次运行可能出现 SmartScreen 提示，选择“更多信息 → 仍要运行”。
- 用户配置、截图与知识库默认保存在 `%APPDATA%\DesktophelperRewrite`，与原版数据完全隔离。

## 自动发布

推送 v* 标签会触发 .github/workflows/release.yml，在 Windows Runner 上构建、运行测试、打包并创建或更新 GitHub Release。

    git tag -a v0.1.0 -m "Desktophelper v0.1.0"
    git push origin v0.1.0

也可以在 GitHub Actions 页面手动运行 Release 工作流。发布产物包括目录版 ZIP、单文件便携 EXE 和 SHA256SUMS.txt。

## 第一次使用

1. 启动后会出现一个 430×680 左右的无边框单栏浮层，默认在屏幕右侧。
2. 顶部只有「截图 / 语音 / 更多」三个入口；底部常驻“截图 / 解题 / 收音”三个快捷键。
3. 默认模型是 `mock`（演示模式），回答会立即以流式文字出现。
4. 点「更多」进入设置、模型、资料库与快捷键中心；设置和资料库都是二级页。
5. 点顶部 ◉ 开始/停止收音；点“截图”框选区域，点旁边 ▾ 可选全屏截图。

主界面默认是紧凑单栏，按功能拆成独立页面：

- 「截图」页上方是横向滚动的截图组卡片，下方是当前组解答；缩略图右上角可单张删除，组操作收进 `⋯` 菜单。
- 截图页顶部的“第 X 组”支持左右拖动（从标题或箭头附近起手均可）、触控板横向滑动或点击两侧箭头切换历史题组；新组在左、旧组在右。
- 「语音」页默认显示实时转写和提问框；点“回答”按钮展开右侧回答记录，回答内容与转写同页查看。
- 点标题栏的展开按钮可切换双栏工作区；进入设置会自动展开，资料库与截图/语音页保持单栏。
- 标题栏只保留“防切屏 / 防录屏 / 收音”三个状态灯；“更多”页提供新建会话、模型、资料库、快捷键与紧急隐身。
- 两个页面共用同一份会话记录，但各自维护生成状态：语音回答进行中仍可开始截图解题，截图解题进行中也可继续语音提问；取消其中一个不会中断另一个。
- 截图任务之间仍然串行，避免同一时间启动两个识图流程。

默认窗口约 430×680，最小尺寸 360×420；拖动标题栏移动、拖动右下角缩放，快捷键都可以在设置中调整。

### 1. 接入真实模型

设置 → 模型：

- 提供方：OpenAI 兼容
- Base URL：例如 `https://api.openai.com/v1`
- 模型：你的模型名
- API Key：填写后点“保存 Key”
- 点“测试连接”确认网络与 Key 可用

兼容任何实现 `/chat/completions` 的服务（OpenAI、Azure OpenAI 兼容网关、
自建 vLLM / Ollama OpenAI 兼容层等）。

### 1.1 视觉与题面提取

- 视觉解题和题面提取共用 OpenAI 兼容的 `/chat/completions` 图片消息格式。
- 可勾选“复用文本模型的接口、模型和 Key”，直接使用上面配置的文本模型。
- 复用的模型必须支持图片输入；DeepSeek `deepseek-flash` 已验证可读图。
- “测试连接”会真实发送一张 1×1 PNG；服务端拒绝图片输入时会显示具体错误。
- 视觉失败时若开启回退，会先用提取模型读出题面，再交给文本模型解题。

### 2. 实时转写

设置 → 转写：

- 批量模式：提供方选“OpenAI 兼容”填 Whisper 兼容接口，或选“阿里百炼（HTTP 批量）”。
- 实时模式：提供方选“DashScope 实时”，转写模式选“实时流式”。
- 填写对应提供方的转写 API Key。Key 只保存在本机主进程的安全存储中，不会进入渲染层、日志或构建产物。
- 语言：`zh`、`en`、`ja`、`ko` 等；留空或填 `auto` 让服务自动识别。

点顶部 ◉ 后，一次启动麦克风与系统声音（Windows 默认开启，可在设置关闭），再按句子调用转写接口。
- 麦克风与系统声音是两路独立采集、独立断句、独立转写，不会把两路声音混在一起。
- 采集端统一输出 16 kHz、单声道、16-bit PCM；客户端做能量断句，说完一句才上传，长时间静音不会产生请求。
- 停止收音时会 flush 最后一句，避免尾句丢失。
- 系统声音在 Windows 上通过 loopback 捕获；无需在弹出的窗口里勾选音频。
- 设置 → 转写中的“麦克风归属 / 系统声音归属”决定片段标记为“我”还是“对方”。默认麦克风=我、系统声音=对方。
- OpenAI 兼容批量模式只需兼容 `POST /audio/transcriptions`；百炼模式使用多模态生成接口。DeepSeek 文本接口不提供语音识别，不要把它填到转写 Base URL。

#### DashScope 实时模式

选择“DashScope 实时”后会自动填入：

- Base URL：`wss://dashscope.aliyuncs.com/api-ws/v1/inference`
- 模型：`qwen-audio-3.1-asr-flash-streaming`
- 语言：`zh`

工作方式：

- 主进程直接建立 WebSocket，握手时使用 `Authorization: Bearer <API Key>`。
- 发送 `run-task` 后持续上传 16 kHz PCM，约每 100 ms 一帧；服务返回 `task-started` 前的音频会先缓冲。
- `result-generated` 的中间结果实时显示为临时行；`sentence_end=true` 的最终句子立即写入转写并触发自动回答。
- 开启服务端 `heartbeat`，长时间静音不会因无音频而断开；停止收音时发送 `finish-task` 并等待最后一句返回。
- “测试连接”会真实完成 WebSocket 握手和 `run-task`，不是本地假探测。

如果使用百炼工作空间专属域名，把 Base URL 换成
`wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`
（新加坡区域用 `ap-southeast-1`）。工作空间 ID 与 API Key 都只保存在本机。

#### 阿里百炼 HTTP 批量模式

选择“阿里百炼（HTTP 批量）”后会自动填入：

- Base URL：工作空间专属的 `.../api/v1/services/aigc/multimodal-generation/generation`
- 模型：`qwen-audio-3.1-asr-flash`
- 转写模式：批量

也可以只填 `https://dashscope.aliyuncs.com/api/v1`，客户端会自动补齐生成接口路径。

工作方式：

- 本地按句切出 16 kHz、单声道、16-bit WAV，再以 `data:audio/wav;base64,...` 形式上传，不需要公网音频 URL。
- 请求头使用 `Authorization: Bearer <API Key>` 和 `X-DashScope-SSE: disable`。
- 响应优先读取 `output.text`，并兼容 `output.sentence.text`、`output.sentences[].text`。
- 401/403 会显示“百炼鉴权失败”，429 会提示限流或配额问题。
- “测试连接”会真实发送一段 1 秒静音 WAV；返回 2xx 即表示地址、模型与 Key 可用。
- 单段音频超过约 10MB 会被本地拦截，避免 Base64 请求体过大。

HTTP 批量按句上传，延迟取决于句子结束和网络往返；需要边说边出字的低延迟体验时，仍推荐上面的 WebSocket 实时模式。

批量与实时的区别：

- 批量：本地断句后上传 WAV，按句请求 `POST /audio/transcriptions` 或百炼生成接口，兼容性最广。
- 实时：边说话边上传 PCM，能看到中间识别结果，句子结束后延迟更低，适合面试对话。

### 3. 自动回答与队列

- 自动回答默认常开，不再作为配置按钮展示。
- 只对“对方”的发言触发；麦克风固定归“我”，系统声音固定归“对方”，点击转写片段上的标签可手动纠正。
- 正在生成时到来的问题会进入队列。
- 回答结束后队列自动排空；可在设置中关闭自动排空。
- 默认最多保留 5 条回答，正在生成的回答不会被删除。

### 4. 截图、区域截图与截图组

- 区域截图：顶部“截图”或 `Ctrl+H`，先点左上角、再点右下角；Esc 或右键取消。
- Windows 区域截图不创建全屏选区窗口：主浮层先隐藏，`bin/dh-pointer.exe` 通过 `GetCursorPos` / `GetAsyncKeyState` 取两个点，再从当前显示器取一帧裁剪。因此共享端看到的是实时桌面，不会出现整屏黑或选区遮罩。
- 取点助手返回物理像素坐标，主进程用 `screen.screenToDipPoint` 转为 DIP 后再匹配显示器与裁剪，125% / 150% 缩放下不会偏移。
- 其他平台或取点助手不可用时，会退化为冻结预览的选区窗口；该窗口不使用内容保护，避免“全屏窗口被整体排除”导致共享端黑屏。
- E2E 会校验区域截图必须走无窗口取点路径，并采样裁剪帧亮度，防止再次退化为黑屏。
- 全屏截图：顶部“截图”右侧 ▾ 或 `Ctrl+Shift+A`。
- 连续截图自动加入当前采集中的组；点“解题”后本组锁定，下一次截图自动新建一组。
- 解题失败后可以直接继续截图，新图会追加进同一组，再点“重试”一起发送。
- 空闲超过 10 分钟不再自动追加，下一次截图会新建一组。
- 每组只有两个入口：主按钮（解题 / 重试 / 停止 / 重新解题 / 补图）和 `⋯` 菜单（补图、只提取题面、结束本组、复制解答、删除本组）。
- 每张缩略图右上角有 `×` 按钮，可单独删除截错的图片；本组正在解题时需先停止。
- 截图解答只显示在组卡片内，不会混入普通回答列表。
- 点击任意组卡片即可查看该组自己的历史解题记录；最新一条默认展开，旧记录按“第 N 次”折叠，点击摘要可展开或收起，切换组不会串记录。
- 直接视觉解题：把整组原图交给多模态模型，一次得到完整解答。
- 只提取题面：先用提取模型把截图转成题面 JSON；之后可用文本模型解题。
- 补图：把原题截图、上一版完整解答和本次补图一起发送，只修改与新信息相关的部分。
- 设置 → 截图流程可选择 `自动 / 直接视觉 / 先提取再解题`，并开启“视觉失败时回退到提取 + 文本解题”。
- 截图先保存在本地 `screenshots/`，再后台归档到 `archive/日期/`；归档失败不会阻塞回答，可重试。
- 发送给模型前会压缩大图：宽度上限 1600px，超过约 1.5MB 的 PNG 转为 JPEG（82%），原图保持不变。

截图任务的阶段会显示在组卡片上：

`排队 → 提取题面 → 解题 → 完成`，失败时显示错误；视觉模型不可用或额度异常时，
会自动回退到 `提取题面 → 文本解题`。只有“提取”会保存题面文本，原始截图不会被改写。

需要注意：提取模型必须支持图片输入；纯文本模型无法替代提取阶段。

推理模型（如 `deepseek-flash`、`deepseek-v4-pro`、o 系列）的思考内容也会占用输出 Token。
应用会自动保证这类模型至少使用 4096 tokens；仍被截断时会显示明确错误，而不是标记为“完成（无内容）”。

### 5. 浮层交互

- 浮层默认点击穿透，不会挡住下面的应用；顶部标题栏右侧显示“穿透 / 交互”状态。
- 点击标题栏即可激活整窗交互，按钮、输入框和列表都能正常操作。
- 拖动标题栏移动窗口，拖动右下角调整大小；这两处在穿透状态下也可直接唤醒。
- 按 Esc 或切换到其他应用会恢复点击穿透。
- 顶部 ◉ 是收音状态灯：空闲为绿色，收音中为红色脉冲；再次点击暂停收音。

### 6. 知识库

设置 → 知识库：

- 开启知识库。
- 支持 `.md/.txt/.json/.csv/.log/.html/.ts/.js/.py` 等文本文件。
- 可按文件导入，也可以直接粘贴文本。
- 回答时按 BM25 检索 Top-K 片段，并在回答下方标注引用文档。
- 单文件大小、切片大小、重叠长度都可配置。

### 7. 快捷键

| 功能 | 默认快捷键 |
| --- | --- |
| 显示/隐藏浮层 | `Ctrl+B` |
| 紧急隐身（隐藏浮层并停止收音） | `Ctrl+Shift+H` |
| 区域截图 | `Ctrl+H` |
| 全屏截图 | `Ctrl+Shift+A` |
| 开始/停止收音 | `Ctrl+M` |
| 处理当前截图组 | `Ctrl+Enter` |
| 删除最后一张截图 | `Ctrl+L` |
| 回答问题 | `Ctrl+G` |
| 语音解题 | `Ctrl+J` |
| 上一组 / 下一组 | `Ctrl+,` / `Ctrl+.` |
| 重置视图 | `Ctrl+R` |
| 知识库面板 | `Ctrl+K` |

可在「更多 → 快捷键与冲突」中按“通用 / 截图与处理 / 导航 / 窗口与显示”分组修改；
支持直接按键录制，并会在保存前校验格式。冲突检测中心会实时标出重复绑定、系统占用、无效组合和待保存项，并显示已注册数量。
旧版本默认键位会在首次启动时自动迁移，自定义键位不会被覆盖。

### 8. 屏幕共享保护（默认开启）

- 设置 → 屏幕共享保护：默认勾选“在屏幕共享 / 录屏中隐藏浮层”。
- Windows 10 2004+ 使用官方 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`（经 Electron `setContentProtection` 调用），浮层不会出现在 OBS、Zoom、腾讯会议等使用系统捕获接口的画面中。
- 旧版 Windows 会退化为黑色矩形；macOS 仅作兼容尝试，ScreenCaptureKit 仍可能捕获。
- 保护只作用于主浮层，不影响区域截图与全屏截图；区域截图在 Windows 上根本没有全屏窗口，因此不会把共享画面整体排除。切换开关后立即生效并持久化。
- 仅调用系统公开 API，不使用 Hook、注入或驱动；无法保证所有第三方采集软件都遵循系统约束。

#### 不触发切屏检测

- 点击按钮、切换导航、拖动标题栏都不会让浮层成为前台窗口。Windows 上浮层使用 `focusable: false`（即 `WS_EX_NOACTIVATE`）并通过 `showInactive()` 显示，考试页不会收到 `blur` / `focusout`。
- 浮层是工具窗口（`skipTaskbar: true`，即 `WS_EX_TOOLWINDOW`）：不会出现在任务栏，也不会出现在 Alt+Tab 切换列表；隐藏后可通过托盘图标或 `Ctrl+B` 恢复。
- 浮层默认不接收键盘输入。只有点击文本框时，应用会临时恢复可聚焦以完成输入，失焦或按 Esc 后立即恢复免激活状态；这一瞬间仍可能被个别监考工具识别，这是公开系统 API 的边界。
- 区域截图由独立的两点取框辅助进程完成，不创建全屏选择窗口，也不会抢占焦点。

### 9. 应用锁（可选）

设置 → 隐私：

- 设置 4 位以上本地 PIN 后，可锁定界面。
- PIN 只用于保护本机数据，不是账号，也不参与任何功能授权。
- 连续输错 5 次会锁定 1 分钟。
- 忘记 PIN 时，删除数据目录下的 `secrets.json` 会同时清除 Key 和锁记录。

## 数据目录

默认数据目录：

```text
%APPDATA%\DesktophelperRewrite
```

可用环境变量 `DH_DATA_DIR` 指定到其他目录。

主要文件：

```text
settings.json      # 设置
sessions.json      # 会话、转写、回答、队列
screenshots.json   # 截图元数据
knowledge.json     # 知识库
secrets.json       # API Key 与本地锁（safeStorage 加密，不可用时退回本地编码）
screenshots/       # 截图原图
archive/YYYY-MM-DD/# 归档截图
logs/              # 结构化日志
```

## 隐私说明

- 没有账号系统，不上报登录状态、订阅状态或设备权益。
- 不包含遥测、崩溃上传或云端同步。
- 模型请求只发送到你配置的 Base URL。
- 截图、转写、知识库默认只写本机。
- 密钥不会写入日志、URL 或渲染层快照。
- 设置页只显示“是否已配置”，不回显完整 Key。
- 屏幕共享保护只调用系统窗口属性 API，不读取、不修改其他进程。

## 测试与验证

```powershell
node --test tests/*.test.ts
node scripts/build.mjs
node scripts/e2e.mjs
```

E2E 会：

- 构建并部署到 `work/e2e-runtime/resources/app`。
- 使用独立的 `APPDATA` / `LOCALAPPDATA` / `DH_DATA_DIR`。
- 检查页面存在、没有登录页、渲染层没有 `require` / `process`。
- 检查 preload 暴露的 `invoke` / `on` API。
- 截图并校验 PNG 头与尺寸。
- 校验会话和设置已落盘。
- 读取主浮层原生句柄的 `GetWindowDisplayAffinity`，断言返回 `WDA_EXCLUDEFROMCAPTURE (0x11)`。
- 断言浮层扩展样式包含 `WS_EX_NOACTIVATE`，且显示后不是前台窗口。
- 断言浮层扩展样式包含 `WS_EX_TOOLWINDOW`，确认它不会出现在任务栏或 Alt+Tab 中。
- 用真实鼠标拖动浮层标题栏，断言浮层发生位移、尺寸不变，并且前台窗口始终是另一个窗口。
- 只关闭自己启动的进程，不按进程名杀进程。

## 目录结构

```text
src/
  main/       Electron 生命周期、IPC、服务、截图、密钥、日志
  preload/    白名单 contextBridge
  renderer/   浮层与区域选择 UI
  shared/     模型、协议、校验、reducer、检索、提示词
scripts/
  fetch-electron.mjs 下载并校验 Electron 运行时
  build.mjs   类型剥离 + 模块输出 + 静态资源复制 + 图标
  gen-icon.mjs 自有 PNG 图标生成器
  deploy.mjs  安全部署到测试运行时
  run-electron.mjs 日常启动
  e2e.mjs     端到端验证
  package.mjs / package-portable.mjs 打包目录版与单文件版
tests/        单元与服务测试
```

## 常见问题

**启动后没有窗口？**
查看 `%APPDATA%\DesktophelperRewrite\logs` 下的日志；确认已执行 `node scripts/fetch-electron.mjs`，且 `work/e2e-runtime/Desktophelper.exe` 存在。

**窗口点击没反应？**
浮层默认点击穿透，鼠标事件会落到下方应用。点击顶部标题栏即可激活整窗交互；此时可拖动标题栏移动窗口、拖动右下角缩放。按 Esc 或切换到其他应用会恢复穿透。

**提示单实例已运行？**
同一数据目录只允许一个实例。确认没有残留进程，或换一个 `DH_DATA_DIR`。

**提示 safeStorage 不可用？**
系统安全存储不可用时，Key 会退化为本地编码保存。应用会在界面和日志中提示。

**没有配置 Key 能做什么？**
演示模型可以完成提问、流式回答、队列、取消、知识库引用等流程；截图分析会返回“演示模式”说明。
转写选择“演示模式”时可以用伪音频走通断句与入库；要识别真实音频，请配置兼容
`/audio/transcriptions` 的服务与 Key。

**截图解题显示“完成（无内容）”？**
通常是推理模型的思考过程占满了 `max_tokens`，最终答案尚未开始就被截断。当前版本会自动提高到至少
4096 tokens 并重试；如果仍然截断，会显示错误并提示提高最大 Token，而不是静默返回空答案。

## Clean-room 说明

本实现只依据行为规格重新编写：

- 不复制原应用的源码、提示词、模型别名、加密资源或图标。
- 不实现原产品的订阅/权益绕过。
- 不包含登录、注册、账号切换或 Token 刷新。
- 图标由 `scripts/gen-icon.mjs` 本地生成。
