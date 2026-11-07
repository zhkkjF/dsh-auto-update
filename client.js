/**
 * Client half of the auto-update plugin: one Settings → Auto Update page.
 *
 * The page is a plain React component registered into `settings.section`. It
 * reads and drives the Host through the plugin's same-origin JSON route, so no
 * Harness Client package is imported.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-auto-update',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = '@local/dsh-auto-update'
    const SECTION_ID = 'auto-update'
    const ENDPOINT = '/dsh-auto-update/'

    const zh = {
      nav: '自动更新',
      title: '自动更新',
      subtitle: '让 DSH Desktop 保持最新，并在更新后把已安装的插件和设置带回来。',
      currentVersion: '当前版本',
      latestVersion: '最新版本',
      feedChannel: '更新通道',
      checkedAt: '上次检查',
      never: '从未',
      phase: '状态',
      idle: '空闲',
      checking: '正在检查更新…',
      downloading: '正在下载 {percent}%…',
      ready: '更新已下载',
      installing: '正在安装更新…',
      error: '失败',
      autoInstall: '自动安装更新',
      autoInstallHint: '自动下载并静默启动安装器，应用会关闭并在安装完成后自动重新打开。',
      autoInstallWhenIdle: '等待运行中的任务结束',
      autoInstallWhenIdleHint: '有正在运行的对话回合或后台任务时，推迟安装。',
      checkInterval: '检查间隔',
      minutes: '{count} 分钟',
      checkNow: '立即检查',
      updateNow: '下载并安装',
      snapshotNow: '创建快照',
      reinstallNow: '重装插件',
      restoreNow: '恢复设置',
      openLog: '日志目录',
      busy: '处理中…',
      snapshotTitle: '快照',
      noSnapshots: '还没有快照。每次更新前会自动创建一份。',
      snapshotLine: '{version} · {time}',
      recoveryTitle: '上次恢复',
      noRecovery: '暂未执行过恢复。',
      recovered: '更新后已恢复',
      reinstalled: '已重装插件',
      restored: '已恢复设置',
      failed: '失败',
      errorLabel: '错误',
      intervalUnit: '分钟',
      applySaved: '已保存',
      applySaveFailed: '保存设置失败。',
      updateAvailable: '发现新版本。',
      upToDate: '当前已是最新版本。',
      desktopOnly: '此面板仅在 DSH Desktop 中可用。',
      installConfirm: 'DSH 将关闭、安装更新并重新打开。继续吗？',
      done: '完成',
      dryRun: '试运行',
      reinstallHint: '按当前 profile 重装插件并恢复禁用状态；不会修改设置。',
      restoreHint: '从最近快照恢复 profile 设置、storages 与插件数据目录。',
      snapshotHint: '在更新前保存当前插件清单与设置。',
      busyHint: '有任务正在运行，安装会推迟到任务结束。',
    }
    const en = {
      nav: 'Auto Update',
      title: 'Auto Update',
      subtitle: 'Keep DSH Desktop current and bring every installed plugin back after an update.',
      currentVersion: 'Installed version',
      latestVersion: 'Latest version',
      feedChannel: 'Update channel',
      checkedAt: 'Last checked',
      never: 'Never',
      phase: 'State',
      idle: 'Idle',
      checking: 'Checking for updates…',
      downloading: 'Downloading {percent}%…',
      ready: 'Update downloaded',
      installing: 'Installing update…',
      error: 'Failed',
      autoInstall: 'Install updates automatically',
      autoInstallHint: 'Downloads and starts the installer silently. The app closes and reopens by itself.',
      autoInstallWhenIdle: 'Wait for running tasks to finish',
      autoInstallWhenIdleHint: 'Defers installation while an agent turn or background job is running.',
      checkInterval: 'Check every',
      minutes: '{count} min',
      checkNow: 'Check now',
      updateNow: 'Download and install',
      snapshotNow: 'Snapshot now',
      reinstallNow: 'Reinstall plugins',
      restoreNow: 'Restore settings',
      openLog: 'Log folder',
      busy: 'Working…',
      snapshotTitle: 'Snapshots',
      noSnapshots: 'No snapshots yet. One is created before every update.',
      snapshotLine: '{version} · {time}',
      recoveryTitle: 'Last recovery',
      noRecovery: 'Nothing to recover yet.',
      recovered: 'Recovered after update',
      reinstalled: 'Plugins reinstalled',
      restored: 'Settings restored',
      failed: 'Failed',
      errorLabel: 'Error',
      intervalUnit: 'minutes',
      applySaved: 'Saved',
      applySaveFailed: 'Could not save the setting.',
      updateAvailable: 'A new version is available.',
      upToDate: 'You are running the latest version.',
      desktopOnly: 'This panel is available in DSH Desktop.',
      installConfirm: 'DSH will close, install the update and reopen. Continue?',
      done: 'Done',
      dryRun: 'Dry run',
      reinstallHint: 'Reinstall plugins for the current profile and restore saved enablement; settings stay untouched.',
      restoreHint: 'Restore profile settings, storages and plugin data directories from the latest snapshot.',
      snapshotHint: 'Save the current plugin inventory and settings before an update.',
      busyHint: 'Tasks are running; installation waits for them to finish.',
    }

    const styles = `
      .dau-root { display: flex; flex-direction: column; gap: 18px; max-width: 760px; }
      .dau-head h2 { margin: 0 0 6px; font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .dau-head p { margin: 0; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
      .dau-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 14px 16px; }
      .dau-grid { display: grid; grid-template-columns: minmax(120px, 1fr) 1.6fr; gap: 8px 16px; font-size: 13px; }
      .dau-grid .k { color: var(--dsw-alias-label-secondary); }
      .dau-grid .v { color: var(--dsw-alias-label-primary); word-break: break-all; }
      .dau-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 0; }
      .dau-row + .dau-row { border-top: 1px solid var(--dsw-alias-border-l1); }
      .dau-row .text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .dau-row .title { font-size: 13px; color: var(--dsw-alias-label-primary); }
      .dau-row .hint { font-size: 12px; line-height: 1.45; color: var(--dsw-alias-label-secondary); }
      .dau-switch { position: relative; flex: none; width: 38px; height: 22px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); cursor: pointer; padding: 0; }
      .dau-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
      .dau-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-bg-layer-1); transition: transform .15s ease; }
      .dau-switch[aria-checked="true"]::after { transform: translateX(16px); }
      .dau-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .dau-btn { appearance: none; border-radius: 8px; padding: 7px 14px; font-size: 13px; line-height: 1.2; cursor: pointer; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
      .dau-btn:hover { background: var(--dsw-alias-bg-layer-2); }
      .dau-btn:disabled { opacity: .55; cursor: default; }
      .dau-btn.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
      .dau-btn.primary:hover { filter: brightness(1.06); }
      .dau-input { width: 76px; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 13px; }
      .dau-list { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0; padding: 0; list-style: none; }
      .dau-list li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .dau-list li:last-child { border-bottom: 0; }
      .dau-note { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 8px 0 0; }
      .dau-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; margin: 6px 0 0; white-space: pre-wrap; }
      .dau-ok { color: var(--dsw-alias-state-success-primary); }
      .dau-warn { color: var(--dsw-alias-state-warn-primary); }
      .dau-section-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); margin: 0 0 8px; }
    `

    function injectStyles() {
      const element = document.createElement('style')
      element.dataset.dshAutoUpdate = ''
      element.textContent = styles
      document.head.append(element)
      return () => element.remove()
    }

    function resolveLocale() {
      const lang = document.documentElement.lang || navigator.language || 'en'
      return String(lang).toLowerCase().startsWith('zh') ? zh : en
    }

    function formatMessage(template, values) {
      if (typeof template !== 'string') return ''
      return template.replace(/\{(\w+)\}/gu, (match, key) => (values[key] === undefined ? match : String(values[key])))
    }

    async function call(action, body) {
      const response = await fetch(`${ENDPOINT}${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      let value = null
      try {
        value = await response.json()
      } catch {
        value = { ok: false, error: `HTTP ${response.status}` }
      }
      if (value !== null && value.ok === false && typeof value.error === 'string') throw new Error(value.error)
      return value
    }

    function formatTime(value) {
      if (typeof value !== 'string' || value.length === 0) return null
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      return date.toLocaleString()
    }

    function SettingsSection(props) {
      const t = props.t ?? (key => resolveLocale()[key] ?? key)
      const [data, setData] = React.useState(null)
      const [pending, setPending] = React.useState('')
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)

      const refresh = React.useCallback(async () => {
        try {
          const value = await call('status')
          setData(value)
          setError(null)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])

      React.useEffect(() => {
        void refresh()
        const timer = setInterval(() => {
          void refresh()
        }, 5000)
        return () => clearInterval(timer)
      }, [refresh])

      const run = async (name, action, body, after) => {
        setPending(name)
        setError(null)
        setNotice(null)
        try {
          const value = await call(action, body)
          setData(value)
          if (after !== undefined) after(value)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setPending('')
        }
      }

      const saveSettings = async (patch) => {
        setPending('settings')
        try {
          const value = await call('settings', { settings: patch })
          setData(value)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setPending('')
        }
      }

      const phaseLabel = () => {
        if (data === null) return t('idle')
        if (data.phase === 'checking') return t('checking')
        if (data.phase === 'downloading') return formatMessage(t('downloading'), { percent: data.percent ?? 0 })
        if (data.phase === 'ready') return t('ready')
        if (data.phase === 'installing') return t('installing')
        if (data.phase === 'error') return t('error')
        return t('idle')
      }

      const statusLine = data?.available === true ? t('updateAvailable') : data?.checkedAt ? t('upToDate') : null
      const settings = data?.settings ?? {}
      const busy = pending !== '' || data?.phase === 'checking' || data?.phase === 'downloading' || data?.phase === 'installing'

      const current = data?.currentVersion ?? '—'
      const latest = data?.latestVersion ?? '—'
      const recovery = data?.lastRecovery ?? null
      const snapshots = Array.isArray(data?.snapshots) ? data.snapshots : []

      return h('section', { className: 'dau-root' },
        h('header', { className: 'dau-head' },
          h('h2', null, t('title')),
          h('p', null, t('subtitle')),
        ),

        data === null && error === null && h('p', { className: 'dau-note' }, t('busy')),

        data !== null && data.desktop === false && h('p', { className: 'dau-note dau-warn' }, t('desktopOnly')),

        data !== null && data.desktop !== false && h('div', { className: 'dau-card dau-grid' },
          h('span', { className: 'k' }, t('currentVersion')),
          h('span', { className: 'v' }, current),
          h('span', { className: 'k' }, t('latestVersion')),
          h('span', { className: 'v' }, latest),
          h('span', { className: 'k' }, t('feedChannel')),
          h('span', { className: 'v' }, data?.channel ?? '—'),
          h('span', { className: 'k' }, t('checkedAt')),
          h('span', { className: 'v' }, formatTime(data?.checkedAt) ?? t('never')),
          h('span', { className: 'k' }, t('phase')),
          h('span', { className: 'v' }, phaseLabel()),
        ),

        statusLine !== null && h('p', { className: data?.available === true ? 'dau-note dau-ok' : 'dau-note' }, statusLine),

        data !== null && data.desktop !== false && h('div', { className: 'dau-card' },
          h('div', { className: 'dau-row' },
            h('div', { className: 'text' },
              h('span', { className: 'title' }, t('autoInstall')),
              h('span', { className: 'hint' }, t('autoInstallHint')),
            ),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': settings.autoInstall === true ? 'true' : 'false',
              'aria-label': t('autoInstall'),
              className: 'dau-switch',
              disabled: pending !== '',
              onClick: () => { void saveSettings({ autoInstall: settings.autoInstall !== true }) },
            }),
          ),
          h('div', { className: 'dau-row' },
            h('div', { className: 'text' },
              h('span', { className: 'title' }, t('autoInstallWhenIdle')),
              h('span', { className: 'hint' }, t('autoInstallWhenIdleHint')),
            ),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': settings.waitForIdle !== false ? 'true' : 'false',
              'aria-label': t('autoInstallWhenIdle'),
              className: 'dau-switch',
              disabled: pending !== '',
              onClick: () => { void saveSettings({ waitForIdle: settings.waitForIdle === false }) },
            }),
          ),
          h('div', { className: 'dau-row' },
            h('div', { className: 'text' },
              h('span', { className: 'title' }, t('checkInterval')),
            ),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              h('input', {
                className: 'dau-input',
                type: 'number',
                min: 1,
                max: 1440,
                step: 1,
                value: settings.checkIntervalMinutes ?? 30,
                disabled: pending !== '',
                onChange: event => {
                  const value = Number(event.target.value)
                  if (Number.isFinite(value) && value >= 1 && value <= 1440) void saveSettings({ checkIntervalMinutes: value })
                },
              }),
              h('span', { className: 'hint' }, t('intervalUnit')),
            ),
          ),
        ),

        data !== null && data.desktop !== false && h('div', { className: 'dau-actions' },
          h('button', {
            type: 'button',
            className: 'dau-btn',
            disabled: busy,
            onClick: () => { void run('check', 'check') },
          }, pending === 'check' ? t('busy') : t('checkNow')),
          h('button', {
            type: 'button',
            className: 'dau-btn primary',
            disabled: busy || data?.available !== true,
            onClick: () => {
              if (!window.confirm(t('installConfirm'))) return
              void run('install', 'install')
            },
          }, pending === 'install' ? t('busy') : t('updateNow')),
          h('button', {
            type: 'button',
            className: 'dau-btn',
            disabled: busy,
            onClick: () => { void run('snapshot', 'snapshot', {}, () => setNotice(t('done'))) },
          }, pending === 'snapshot' ? t('busy') : t('snapshotNow')),
          h('button', {
            type: 'button',
            className: 'dau-btn',
            disabled: busy,
            onClick: () => { void run('reinstall', 'reinstall', { dryRun: false }, () => setNotice(t('done'))) },
          }, pending === 'reinstall' ? t('busy') : t('reinstallNow')),
          h('button', {
            type: 'button',
            className: 'dau-btn',
            disabled: busy,
            onClick: () => { void run('restore', 'restore', {}, () => setNotice(t('done'))) },
          }, pending === 'restore' ? t('busy') : t('restoreNow')),
        ),

        h('p', { className: 'dau-note' }, t('snapshotHint')),
        h('p', { className: 'dau-note' }, t('reinstallHint')),
        h('p', { className: 'dau-note' }, t('restoreHint')),
        data?.busy === true && h('p', { className: 'dau-note dau-warn' }, t('busyHint')),

        notice !== null && h('p', { className: 'dau-note dau-ok' }, notice),
        error !== null && h('p', { className: 'dau-error' }, error),
        data?.error !== null && data?.error !== undefined && h('p', { className: 'dau-error' }, `${t('errorLabel')}: ${data.error}`),

        h('div', { className: 'dau-card' },
          h('p', { className: 'dau-section-title' }, t('snapshotTitle')),
          snapshots.length === 0
            ? h('p', { className: 'dau-note', style: { margin: 0 } }, t('noSnapshots'))
            : h('ul', { className: 'dau-list' },
              ...snapshots.slice(0, 5).map(entry => h('li', { key: entry.id },
                h('span', null, formatMessage(t('snapshotLine'), {
                  version: entry.fromVersion ?? '—',
                  time: formatTime(entry.createdAt) ?? entry.id,
                })),
                h('span', null, `${entry.bundles ?? 0} plugins`),
              )),
            ),
        ),

        h('div', { className: 'dau-card' },
          h('p', { className: 'dau-section-title' }, t('recoveryTitle')),
          recovery === null || recovery === undefined
            ? h('p', { className: 'dau-note', style: { margin: 0 } }, t('noRecovery'))
            : h('div', { className: 'dau-grid' },
              h('span', { className: 'k' }, t('recovered')),
              h('span', { className: 'v' }, `${recovery.fromVersion ?? '?'} → ${recovery.toVersion ?? '?'}`),
              h('span', { className: 'k' }, t('restored')),
              h('span', { className: 'v' }, String(recovery.restore?.files?.length ?? 0)),
              h('span', { className: 'k' }, t('reinstalled')),
              h('span', { className: 'v' }, String((recovery.reinstall?.installed?.length ?? 0) + (recovery.reinstall?.reinstalled?.length ?? 0))),
              recovery.errors !== undefined && recovery.errors.length > 0 && h('span', { className: 'k' }, t('failed')),
              recovery.errors !== undefined && recovery.errors.length > 0 && h('span', { className: 'v dau-error' }, recovery.errors.join('; ')),
            ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }))
        ctx.effect(() => injectStyles())
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: 35,
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ t }),
        }, SettingsSection))
      },
    }
  },
})
