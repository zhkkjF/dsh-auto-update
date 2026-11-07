# 上架到插件市场（awesome-dsh-plugin）

收录规则（2026-11 实测）：市场 [dshmarket](https://github.com/dsh-market/dsh-market) 与
[awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) 都读取
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的
`data/plugins/*.yml`。提一个 PR、**只加一个文件**即可，合并后站点与市场自动收录（通常一天内）。

## 前置条件（需要你操作）

1. **公开仓库**：`https://github.com/zhkkjF/dsh-auto-update`（owner 按本机 git 配置推断为
   `zhkkjF`；如果实际账号不同，替换下面所有 `zhkkjF` 与条目里的 url/name）。
   仓库根目录就是本插件目录（`package.json` 在根，含 `dsh.bundle` 与 `cordis.patch.yml`）。
2. 仓库创建满 **1 天**，并添加 topic `dsh-plugin`。
3. （推荐，非必需）发布 npm：`npm publish`。包名 `dsh-auto-update` 在 npm 上可用，
   `package.json` 的 `repository` 已指回该仓库，市场会自动关联下载量；不发 npm 也能收录
   （安装走 GitHub 源码；仓库无法从源码安装时才必须提供 Release tarball）。

## 提交步骤

```sh
# 1) 第一次建仓库并推送（在插件目录）
cd "F:\deepseek work\plugins\dsh-auto-update"
git init -b main
git add .
git commit -m "dsh-auto-update 1.0.0"
git remote add origin https://github.com/zhkkjF/dsh-auto-update.git
git push -u origin main
# 然后在 GitHub 仓库设置里加 topic: dsh-plugin

# 2) Fork awesome-dsh-plugin，克隆自己的 fork
git clone https://github.com/<你的账号>/awesome-dsh-plugin.git
cd awesome-dsh-plugin
mkdir -p data/plugins
cp "/f/deepseek work/plugins/dsh-auto-update/publish/awesome-dsh-plugin/data/plugins/zhkkjF__dsh-auto-update.yml" data/plugins/
git add data/plugins/zhkkjF__dsh-auto-update.yml
git commit -m "Add zhkkjF/dsh-auto-update"
git push
# 3) 在 GitHub 对 awesome-dsh-plugin 开 PR
```

PR 标题：`Add zhkkjF/dsh-auto-update`；正文写一句功能说明即可（描述必须与代码一致，
不要写激励性用语）。CI 会检查：条目 ≤ 3 条、仓库 `package.json` 有 `dsh.bundle`、仓库年龄 ≥ 1 天、
YAML 格式与双语文案。条目已按格式写好，文件名必须是 `<owner>__<repo>.yml`。

## 条目文件内容

```yaml
url: https://github.com/zhkkjF/dsh-auto-update
name: zhkkjF/dsh-auto-update
category: dev
icon: https://raw.githubusercontent.com/zhkkjF/dsh-auto-update/main/assets/icon-180.png
description:
  en: "Checks DSH Desktop's official update feed, downloads and SHA-512 verifies the installer, closes the app and installs silently, then reinstalls profile plugins and restores their pre-update settings from a snapshot."
  zh: "检查 DSH Desktop 官方更新源，下载并校验安装包，关闭应用后静默安装，并在重启后按更新前快照自动重装插件、恢复设置。"
```

- `category: dev`（开发与运行时）是最接近的归类；维护者可能调整，不影响收录。
- `icon` 必须指向 GitHub 托管的**位图**（本仓库 `assets/icon-180.png`，已生成 180×180 PNG）；
  SVG 和第三方图床会被拒绝。
- 截图可选：在仓库根放 `screenshots.json`（1–8 个仓库内图片路径），市场详情页会展示；
  不放则从 README 自动抽取。

## 合并后

- 市场里可按 `dsh-auto-update` / “自动更新”搜到并一键安装；
- 已装版本的更新检测按 npm 版本或 GitHub commit 走；
- 本仓库后续推送新版本无需再提目录 PR（描述变更才需要）。
