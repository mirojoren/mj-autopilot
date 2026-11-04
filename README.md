# MJ Autopilot — Midjourney 批量助手

Midjourney 网页版的浏览器扩展（Chrome / Edge，Manifest V3），提供批量队列、提示词工作台、批量下载、免费翻译等能力，提升 MJ 网页版的使用效率。

> **当前版本：v0.9.3**（以 `manifest.json` 中的 `version` 字段为准）

## 功能特性

- **提示词工作台**：主体描述 + 10 维预设（含随机），一键全随机；一次生成 1–10 条结果，可勾选 / 删除 / 批量入列。
- **批量队列**：批量发送提示词到 MJ，支持单条发送间隔（秒）可调、每批并发控制、批间出图确认、预计完成时间估算。
- **批量下载**：静默下载出图结果，支持自动重命名、自动保存提示词 txt、下载目录选择、图片格式转换（png / jpg / webp）。
- **反选 / 全不选**：灵活的批量勾选操作。
- **单任务点击填入输入框**：点击历史任务即可回填到输入框。
- **任务勾选标记**：标记已处理 / 待处理的任务。
- **免费 AI 翻译**：中译英 MJ 提示词（保留 `--ar` / `--v` / `--seed` 等参数）。
- **发送节奏控制**：随机 seed / 随机间隔 / 随机顺序，让发送节奏更接近人工，降低被限流风险。
- **人机验证自动处理**：自动识别并处理登录时的安全验证，避免队列被验证页卡住。

## 安装方法（开发者模式加载）

1. 下载本仓库代码并解压。
2. 打开 Chrome / Edge，访问 `chrome://extensions`。
3. 打开右上角「开发者模式」。
4. 点击「加载已解压的扩展程序」，选择本项目根目录（`mj-autopilot/`）。
5. 打开 [Midjourney 网页版](https://www.midjourney.com)，页面右下角会出现紫色圆形按钮，点击即可打开操作面板。

## 使用说明

1. 进入 Midjourney 网页版。
2. 点击右下角紫色按钮打开操作面板。
3. 在提示词工作台中输入主体描述、选择预设维度，或直接粘贴完整提示词。
4. 将提示词加入队列，设置发送间隔、并发等参数。
5. 点击开始，插件会按设定节奏自动发送，并在出图后自动下载。

## 目录结构

```
mj-autopilot/
├── manifest.json     # 扩展清单（Manifest V3）
├── background.js     # Service Worker：下载、格式转换、翻译转发
├── content.js        # 页面注入脚本：面板 UI、队列、DOM 操作
├── parser.js         # 提示词解析
├── content.css       # 面板样式
├── popup.html        # 工具栏弹窗
└── icons/            # 图标
```

## 技术栈

- Manifest V3（Chrome 扩展）
- 原生 JavaScript（无构建依赖，无框架）
- Chrome APIs：`downloads`、`storage`、`notifications`、`declarativeNetRequest`

## 免责声明

本项目仅供学习与技术交流使用。使用本工具自动化操作 Midjourney 可能违反 Midjourney 的服务条款，请自行评估风险并合规使用。开发者不对因使用本工具导致的账号限制、封禁或其他后果承担责任。

## 版本更新记录（CHANGELOG）

> 更新版本号时，请同步修改 `manifest.json` 的 `version` 字段与本表。

### v0.9.3（最新）

- 当前版本，功能见上文「功能特性」。

## License

[MIT](./LICENSE)
