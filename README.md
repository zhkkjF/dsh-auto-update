# DSH 自动更新（dsh-auto-update）

一个面向 DSH Desktop 的 Host + Web 插件：

- 自动检查 DSH Desktop 官方更新通道（读取安装目录的 `app-update.yml`，支持 `nightly` / `latest`）。
- 发现新版本后：备份 profile 与插件设置 → 下载并校验安装包（SHA-512）→ 以官方相同的静默参数启动 electron-builder NSIS 安装器。
- 新版本首次启动时：按更新前的快照恢复设置、重新安装 profile 里的插件、恢复插件的启用/禁用状态。
- 设置页提供「自动更新」面板：状态、开关、立即检查/安装、手动快照、重装插件、恢复设置。

> 安装更新会让 DSH 关闭并重新打开，请先保存当前工作。默认「等待运行中的任务结束」开启，有对话回合或后台任务时会推迟安装。

## 面板位置

设置 → 自动更新（`settings.section`，id `auto-update`）。

## 工作流程

1. **检查**：读取 `<resources>/app-update.yml` 的 feed 地址与 channel，请求 `<url>/<channel>.yml`，解析 `version` 与安装包 `url / size / sha512`，与 `<resources>/app.asar/package.json` 的当前版本比较。
2. **准备**：在 `$DSH_HOME/dsh-auto-update/snapshots/<timestamp>/` 创建快照：
   - `profile/package.json`、`cordis.patch.yml`（插件设置）、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`compatibility.json`、`.npmrc`
   - `storages/`（插件设置存储）
   - `data/<插件目录>/`（默认 `dsh-pet`、`dsh-market`、`skills-manager`、`pet-indesktop`、`archive-desk`、`llm-deepseek`、`skill-mcp-manager`、`mcp-bundles`，可在配置里改）
   - `manifest.json`：版本、bundle 列表、依赖、禁用行
3. **下载**：流式下载到 `$DSH_HOME/dsh-auto-update/downloads/`，边下边算 SHA-512，与 feed 校验一致后才使用。
4. **安装**：写 `pending.json` 后创建一个一次性的 Windows 计划任务（Task Scheduler），由它接管安装：
   - 等待 3 秒，核对当前 Electron 主进程的 PID 与可执行文件路径；
   - `taskkill /PID <pid> /T /F`，确保安装目录里的文件不再被占用；
   - 以 `--updated /S --force-run` 启动安装器（与 electron-updater 的 `quitAndInstall(true, true)` 一致），安装完成后自动重新打开应用。

   这一步必须绕开插件自身：electron-builder 的 NSIS 安装器在应用仍在运行时直接退出（observed exit code 2，[electron-builder#8026](https://github.com/electron-userland/electron-builder/issues/8026)），而 Host 插件没有退出 Electron 主进程的入口。计划任务由 Task Scheduler 服务启动，不属于应用的进程树，因此能安全地先关闭应用再安装；任务结束时自行删除。

5. **恢复**：新版本启动后，插件检测到 `pending.json` 的 `fromVersion` 与当前版本不同，执行：
   - 从快照恢复 profile 文件、`storages` 与插件数据目录（覆盖前先把当前状态备份到 `<snapshot>/pre-restore-<timestamp>/`）
   - 用 Desktop 自带的 pnpm 在 profile 里执行 `pnpm install` 重建 `node_modules`
   - 通过 Plugin Manager 服务补装缺失/损坏的 bundle，恢复启用与禁用状态
   - 结果写入 `$DSH_HOME/dsh-auto-update/recovery.json`，面板显示

## 配置（`cordis.patch.yml`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `checkIntervalMinutes` | `30` | 自动检查间隔（分钟）；`0` 关闭定时检查 |
| `autoInstall` | `true` | 发现新版本时自动下载并静默安装 |
| `autoInstallWhenIdle` | `true` | 有运行中的任务时推迟安装 |
| `snapshotKeep` | `5` | 保留最近几份快照 |
| `restoreSettings` | `true` | 更新后恢复 `storages` 与插件数据目录 |
| `restorePolicy` | `overwrite` | `overwrite` 覆盖为更新前设置；`missing-only` 只补缺失文件 |
| `dataDirs` | 见上 | 需要一并备份/恢复的 `$DSH_HOME` 插件数据目录 |

面板里的开关与间隔会写入 `$DSH_HOME/dsh-auto-update/settings.json`，优先于 patch 里的默认值。

## 安全与限制

- 只支持打包的 DSH Desktop（存在 `app-update.yml` 与 `app.asar`）；普通 `dsh web` 会话里面板会显示「仅在 DSH Desktop 中可用」。
- 「自动」更新与官方「手动确认」更新的区别在确认环节：插件用一次性计划任务先关闭应用再静默安装，不经过 Electron 主进程的更新对话框。安装期间 DSH 会关闭并重新打开，进行中的对话会中断；默认「等待运行中的任务结束」会在有任务时推迟安装。
- 下载源与 app-update.yml 一致，仅接受 SHA-512 匹配的安装包。
- 恢复前会备份当前状态；`restorePolicy: overwrite` 会把更新前的设置写回，可能覆盖更新后手工改过的同名设置，可改成 `missing-only`。
- `pnpm install` 由 Desktop 传给 Host 的 pnpm 入口执行，运行在 profile 目录；失败时面板会显示错误，并保留快照供手动恢复。
- 所有状态与日志都位于 `$DSH_HOME/dsh-auto-update/`，不写 profile 之外的系统位置。
