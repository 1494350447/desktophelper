Desktophelper {{VERSION}} — clean-room Electron 重写版。

## 下载

- `Desktophelper-Portable-{{VERSION}}.exe`：单文件便携版，首次运行会解压到 `%LOCALAPPDATA%`。
- `Desktophelper-{{VERSION}}-win-x64.zip`：目录版，解压后运行 `Desktophelper.exe`。
- `SHA256SUMS.txt`：SHA-256 校验值。

## 说明

- Windows 10/11 x64，内置 Electron 29.4.6。
- 未做代码签名，首次运行可能出现 SmartScreen 提示，选择“更多信息 → 仍要运行”。
- 用户数据默认保存在 `%APPDATA%\DesktophelperRewrite`，与原应用隔离。
- 本项目为 clean-room 重写，不含账号、登录、订阅校验或原应用资源。
- 默认使用演示模型；真实模型需在设置中填写自己的 OpenAI 兼容接口与 API Key。

由 GitHub Actions 从提交 `{{SHA}}` 自动构建。
