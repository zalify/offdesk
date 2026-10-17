# Web UI 独立更新实施记录

- 实现分支：`feat/independent-web-ui`；PR：https://github.com/zalify/offdesk/pull/480
- 功能源码：`78609c3`；补充 Android 发布模式验证与启动诊断：`fb1830c`；模拟器 adbd 重连：`6f511ac`；输入焦点与按键节奏：`b6b321a`。
- 工作树：`/tmp/offdesk-web-ui-updates`。原工作区未提交代码保留。

## 已实现

保留 Tauri 本地 origin 与加密 transport，增加签名 UI 资源、兼容校验、后台下载、下次进程启动启用、启动失败回退、关于页版本与检查按钮、桌面恢复菜单及独立发布工作流。RC/stable 通道由壳决定，用户不需要配置。

## 已验证

最终提交 `b6b321a` 的所有 PR 检查通过（包括 Android 启动、容器 E2E、Rust、前端与原生加密）：https://github.com/zalify/offdesk/actions/runs/36307039836 。

- Rust 更新核心 9 项测试与 Clippy 通过；前端更新 4 项测试、发布签名/回滚脚本测试、类型检查通过。
- 本地 17 项容器 Chromium 回归通过。
- 完整 CI 通过：https://github.com/zalify/offdesk/actions/runs/36304334187 。E2E 为 162 passed、1 flaky（workspace manager 重命名，重试通过）、3 skipped。
- 最新完整 CI 也已通过：https://github.com/zalify/offdesk/actions/runs/36305350330 。容器 E2E 为 163 passed、3 skipped，无 flaky。
- 原生同包 UI A → B 与坏版本回退通过：https://github.com/zalify/offdesk/actions/runs/36304334191 。该轮 Android 为调试构建；补充的优化 release APK 同包更新与自动回退也已通过：https://github.com/zalify/offdesk/actions/runs/36305350307 。
- UI 发布成功：https://github.com/zalify/offdesk/actions/runs/36304363799 。实际下载并用客户端同一校验模块验证成功。

## 本机实际迁移

macOS App 已安装 0.7.6-rc.3，Developer ID 签名和苹果公证均通过。旧 App 备份在 `~/Library/Application Support/offdesk-update-backups/20260927-160601/Offdesk.app`。

客户端自动从公开 RC 通道下载 `rc-36304363799-1`，下次启动后 `current` 切换至该版本，`booting=false`，已收到真实 React 界面经原生 bridge 发出的就绪确认。激活前后 App 可执行文件 SHA-256 完全一致。Hub PID 66892、Node PID 73079 和 Cloud connector PID 2842 未重启。

本机窗口自动化工具仍返回 `cgWindowNotFound`，因此本机验证采用原生启动确认、资源状态和二进制哈希；两端可运行界面另由原生 CI 验证。

## Android 发布验证结果

首个签名 RC 构建在冷启动检查未找到登录页面，已阻止发布。补齐日志后，第二轮同样的客户端代码已通过冷启动、输入和前后台检查，但模拟器 `adb root` 重启连接返回非零，阻止了后续恢复测试和发布。测试现在在启动前获取 root、重连并验证真实 uid，最多三次，仍未获取 root 则失败。没有跳过恢复检查，也没有改动应用代码来猜测修复首次超时。

- 优化 APK 原生验证：https://github.com/zalify/offdesk/actions/runs/36305350307
- 第二轮诊断：https://github.com/zalify/offdesk/actions/runs/36305374817
- 第三轮签名 APK 已正常启动并自动下载 UI；批量按键注入仅显示部分地址，导致输入断言失败：https://github.com/zalify/offdesk/actions/runs/36306193194 。测试改为等待真实焦点、逐字符键盘输入、等待完整地址，不跳过输入验证。
- 同时一次普通 CI 被 `Pixel Launcher isn’t responding` 系统弹窗挡住；已保留日志，未误记为通过。
- 最新双端原生同包更新与回退通过：https://github.com/zalify/offdesk/actions/runs/36306194936 。
- 最终签名 Android RC 已成功：https://github.com/zalify/offdesk/actions/runs/36307036917 。冷启动、完整地址输入、前后台切换、保留配对数据的覆盖安装与两次恢复界面检查全部通过。
- 下载：https://github.com/zalify/offdesk/releases/download/rc-android-v0.7.6-rc.3/offdesk-0.7.6-rc.3-arm64-v8a.apk 。版本 0.7.6-rc.3，versionCode 7006，包名 dev.offdesk.desktop.rc，原发布签名不变。本地下载 SHA-256 校验通过，文件位于 `target/rc/android-0.7.6-rc.3/`。
- 最终代码的双端原生更新/回退验证也已通过：https://github.com/zalify/offdesk/actions/runs/36307039918 。

签名密钥保存在 CI secret，公钥通过 repository variable 注入壳；私钥备份位于本机受限目录，未进入仓库。普通 UI 更新不触碰 Hub/Node 或配对数据；新增原生能力仍需要客户端更新。
