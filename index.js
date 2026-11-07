/**
 * Host half of the auto-update plugin.
 *
 * Responsibilities:
 *  - resolve the packaged DSH Desktop installation and its update channel;
 *  - poll the official election feed and compare versions;
 *  - snapshot the profile and plugin settings, download and checksum the
 *    installer, then hand off to it silently;
 *  - on the next launch after a version change, restore the snapshot and
 *    reinstall the profile's plugins;
 *  - expose the same operations to the Web settings page through a small
 *    same-origin JSON route.
 *
 * Every optional service (webServer, pluginManager, agents, jobs) is looked up
 * through `ctx.get`, so the plugin still loads in a minimal profile.
 *
 * @module @local/dsh-auto-update
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  compareVersions,
  downloadInstaller,
  fetchFeed,
  installerFileName,
  resolveInstallation,
} from './lib/runtime.js'
import {
  appendLog,
  createPaths,
  createSnapshot,
  ensureDirectory,
  errorMessage,
  readJson,
  reinstallPlugins,
  removeFile,
  resolveHome,
  restoreSnapshot,
  snapshotList,
  timestampId,
  writeJson,
} from './lib/workspace.js'

export const name = 'dsh-auto-update'

/** All services are optional; the plugin degrades instead of failing startup. */
export const inject = []

const FEED_FALLBACK = 'https://download.deepseek.com/dsh-desk/feeds/win-x64/'
const ROUTE_PREFIX = '/dsh-auto-update'
const MAX_BODY_BYTES = 64 * 1024
const CHECK_TIMEOUT_MS = 45_000
const RECOVERY_DELAY_MS = 8_000
const INSTALLER_ARGS = ['--updated', '/S', '--force-run']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config) {
  try {
    start(ctx, config ?? {})
  } catch (error) {
    // A broken startup entry must never take the Desktop shell down with it.
    console.error('[dsh-auto-update] setup failed:', error)
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
function start(ctx, config) {
  const home = resolveHome()
  ensureDirectory(home)
  const paths = createPaths(home)
  const settings = loadSettings(paths, config)
  /** @type {Record<string, any>} */
  let state = readJson(paths.stateFile, {}) ?? {}
  state = {
    phase: 'idle',
    currentVersion: null,
    latestVersion: null,
    latestFile: null,
    available: false,
    checkedAt: null,
    feedUrl: null,
    channel: null,
    percent: 0,
    error: null,
    desktop: null,
    lastRecovery: readJson(paths.recovery, null),
    pendingUpdate: readJson(paths.pending, null),
    ...state,
  }
  const log = (event, fields = {}) => appendLog(paths.log, { event, ...fields })
  let checkPromise = null
  let installPromise = null

  const installation = () => {
    try {
      return resolveInstallation()
    } catch {
      return null
    }
  }

  const persist = () => {
    writeJson(paths.stateFile, {
      phase: state.phase,
      currentVersion: state.currentVersion,
      latestVersion: state.latestVersion,
      latestFile: state.latestFile,
      available: state.available,
      checkedAt: state.checkedAt,
      percent: state.percent,
      error: state.error,
      desktop: state.desktop,
    })
  }

  const snapshotPublic = () => ({
    phase: state.phase,
    currentVersion: state.currentVersion,
    latestVersion: state.latestVersion,
    available: state.available,
    checkedAt: state.checkedAt,
    percent: state.percent,
    error: state.error,
    desktop: state.desktop,
    channel: state.channel,
    feedUrl: state.feedUrl,
    pendingUpdate: state.pendingUpdate,
    lastRecovery: readJson(paths.recovery, null),
    settings,
    snapshots: snapshotList(paths).map((entry) => ({
      id: entry.id,
      createdAt: entry.createdAt,
      fromVersion: entry.fromVersion,
      reason: entry.reason,
      bundles: entry.bundles.length,
    })),
    busy: hasActiveWork(ctx),
    platform: process.platform,
  })

  const finish = (extra = {}) => ({ ok: true, ...snapshotPublic(), ...extra })

  const fail = (error) => {
    const message = errorMessage(error)
    state.phase = 'error'
    state.error = message
    persist()
    log('error', { message })
    return { ok: false, ...snapshotPublic(), error: message }
  }

  /** @param {boolean} manual */
  async function check(manual = false) {
    if (checkPromise !== null) return checkPromise
    checkPromise = (async () => {
      const found = installation()
      state.desktop = found !== null
      if (found === null) {
        state.currentVersion = null
        state.phase = 'idle'
        state.error = null
        throw new Error('this is not a packaged DSH Desktop installation')
      }
      state.currentVersion = found.version
      const feedUrl = typeof found.updateConfig.url === 'string' ? found.updateConfig.url : FEED_FALLBACK
      const channel = found.updateConfig.channel
      state.feedUrl = feedUrl
      state.channel = channel
      state.phase = 'checking'
      state.error = null
      persist()
      try {
        const { parsed } = await fetchFeed(feedUrl, channel, AbortSignal.timeout(CHECK_TIMEOUT_MS))
        if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
          throw new Error('the update feed did not name a version')
        }
        state.latestVersion = parsed.version
        const file = parsed.files.find((entry) => typeof entry.url === 'string' && entry.url.length > 0) ?? null
        state.latestFile = file === null ? null : {
          url: file.url,
          size: file.size,
          sha512: file.sha512 ?? parsed.sha512,
        }
        state.available = compareVersions(parsed.version, found.version) > 0
        state.checkedAt = new Date().toISOString()
        state.phase = 'idle'
        persist()
        log('checked', { current: found.version, latest: parsed.version, available: state.available, manual })
        if (state.available && manual) log('update-available', { version: parsed.version })
        return finish({ available: state.available })
      } catch (error) {
        return fail(error)
      } finally {
        checkPromise = null
      }
    })()
    return checkPromise
  }

  /** @param {string} directory @param {void} _unused */
  function prepareSnapshot(found) {
    const { directory, manifest } = createSnapshot({
      paths,
      installation: found,
      dataDirs: settings.dataDirs,
      keep: settings.snapshotKeep,
      reason: 'update',
    })
    log('snapshot-created', { directory, fromVersion: manifest.fromVersion, bundles: manifest.bundles.length })
    return { directory, manifest }
  }

  /**
   * Start the electron-builder NSIS installer in the same silent mode the
   * Desktop shell uses for `quitAndInstall(true, true)`.
   *
   * The installer refuses to run while the application it replaces is still
   * running (it exits with code 2; see electron-builder issue #8026), and a
   * Host plugin cannot quit the Electron main process itself. The supported
   * handoff is therefore a detached Task Scheduler job: it waits, terminates
   * this application's process tree, then runs the installer, which installs
   * the new version and starts it again because of `--force-run`.
   *
   * @param {string} installerPath
   * @param {boolean} dryRun - Write the script and validate `schtasks` without running the job.
   */
  function scheduleInstaller(installerPath, dryRun) {
    const mainPid = process.ppid
    const taskName = `DSH-Auto-Update-${Date.now()}`
    const scriptPath = join(paths.state, 'apply-update.ps1')
    const logPath = join(paths.state, 'apply-update.log')
    const exePath = process.execPath
    const quote = (value) => `'${String(value).replace(/'/gu, "''")}'`
    const lines = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$log = ${quote(logPath)}`,
      `Add-Content -Path $log -Value ("[{0}] scheduled update started: main={1} installer={2}" -f (Get-Date -Format o), ${quote(String(mainPid))}, ${quote(installerPath)})`,
      `Start-Sleep -Seconds 3`,
      `$target = Get-Process -Id ${mainPid} -ErrorAction SilentlyContinue`,
      `if ($null -eq $target) { Add-Content -Path $log -Value "target process already exited"; }`,
      `elseif ($target.Path -ne ${quote(exePath)}) { Add-Content -Path $log -Value ("target path mismatch: {0}" -f $target.Path); }`,
      `else { taskkill.exe /PID ${mainPid} /T /F 2>&1 | Add-Content -Path $log; Start-Sleep -Seconds 3 }`,
      `$p = Start-Process -FilePath ${quote(installerPath)} -ArgumentList '--updated','/S','--force-run' -WindowStyle Hidden -PassThru`,
      `if ($null -ne $p) { $null = $p.WaitForExit(600000); Add-Content -Path $log -Value ("installer exited: {0}" -f $p.ExitCode) }`,
      `schtasks.exe /Delete /TN ${quote(taskName)} /F 2>&1 | Add-Content -Path $log`,
    ]
    writeFileSync(scriptPath, lines.join('\r\n'), 'utf8')
    const command = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`
    const create = spawnSync('schtasks.exe', [
      '/Create', '/TN', taskName, '/SC', 'ONCE', '/ST', '23:59', '/TR', command, '/F',
    ], { windowsHide: true, timeout: 30_000, encoding: 'utf8' })
    if (create.status !== 0) {
      throw new Error(`could not create the update task: ${String(create.stderr ?? create.stdout ?? '').trim()}`)
    }
    if (dryRun === true) {
      spawnSync('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { windowsHide: true, timeout: 30_000, encoding: 'utf8' })
      return { taskName, scriptPath, logPath, dryRun: true, command }
    }
    const run = spawnSync('schtasks.exe', ['/Run', '/TN', taskName], { windowsHide: true, timeout: 30_000, encoding: 'utf8' })
    if (run.status !== 0) {
      spawnSync('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { windowsHide: true, timeout: 30_000, encoding: 'utf8' })
      throw new Error(`could not start the update task: ${String(run.stderr ?? run.stdout ?? '').trim()}`)
    }
    return { taskName, scriptPath, logPath, dryRun: false }
  }

  /**
   * Fallback used only when the Task Scheduler handoff cannot be prepared.
   * @param {string} installerPath
   */
  function launchInstaller(installerPath) {
    const child = spawn(installerPath, INSTALLER_ARGS, {
      detached: true,
      stdio: 'ignore',
      cwd: dirname(installerPath),
      windowsHide: false,
    })
    child.unref()
    const pid = child.pid ?? null
    let exited = false
    child.once('exit', (code, signal) => {
      exited = true
      if (code === 0) return
      log('installer-exited', { pid, code, signal })
      if (state.phase === 'installing') {
        state.phase = 'error'
        state.error = `the update installer exited with code ${String(code ?? signal)}`
        persist()
      }
    })
    setTimeout(() => {
      if (!exited) log('installer-running', { pid })
    }, 15_000).unref?.()
    return pid
  }

  async function downloadAndInstall(dryRun = false) {
    if (installPromise !== null) return installPromise
    installPromise = (async () => {
      const found = installation()
      if (found === null) throw new Error('this is not a packaged DSH Desktop installation')
      if (state.phase === 'downloading' || state.phase === 'installing') return snapshotPublic()
      if (state.latestVersion === null) {
        await check(true)
      }
      if (state.available !== true || state.latestFile === null || state.latestVersion === null) {
        throw new Error('no downloaded update is available')
      }
      const version = state.latestVersion
      const file = state.latestFile
      const snapshot = prepareSnapshot(found)
      state.phase = 'downloading'
      state.percent = 0
      state.error = null
      persist()
      try {
        const destination = join(paths.downloads, installerFileName(file.url, version))
        let installerPath = destination
        if (existsSync(destination)) {
          const size = statSync(destination).size
          if (file.size === null || size === file.size) {
            log('installer-cached', { path: destination, size })
          } else {
            removeFile(destination)
          }
        }
        if (!existsSync(destination)) {
          log('installer-download-start', { url: file.url, size: file.size })
          const result = await downloadInstaller(file, destination, (received, total) => {
            state.percent = total > 0 ? Math.round((received / total) * 100) : 0
            if (state.percent % 5 === 0) persist()
          }, AbortSignal.timeout(30 * 60 * 1000))
          installerPath = result.path
          log('installer-downloaded', { path: installerPath, size: result.size })
        }
        state.percent = 100
        const pending = {
          createdAt: new Date().toISOString(),
          fromVersion: found.version,
          toVersion: version,
          snapshotId: snapshot.manifest.id,
          snapshotDir: snapshot.directory,
          installer: installerPath,
        }
        if (dryRun === true) {
          const handoff = scheduleInstaller(installerPath, true)
          log('installer-handoff-dry-run', handoff)
          state.phase = 'idle'
          persist()
          return finish({ installing: false, dryRun: true, handoff, pendingUpdate: null })
        }
        writeJson(paths.pending, pending)
        state.pendingUpdate = pending
        state.phase = 'installing'
        persist()
        let handoff
        try {
          handoff = scheduleInstaller(installerPath, false)
          log('installer-scheduled', handoff)
        } catch (error) {
          log('installer-schedule-failed', { message: errorMessage(error) })
          const pid = launchInstaller(installerPath)
          handoff = { pid, fallback: true }
          log('installer-launched', { pid, installer: installerPath, toVersion: version })
        }
        return finish({ installing: true, pendingUpdate: pending, handoff })
      } catch (error) {
        return fail(error)
      } finally {
        installPromise = null
      }
    })()
    return installPromise
  }

  async function recoverAfterUpdate() {
    const pending = readJson(paths.pending, null)
    if (pending === null || typeof pending !== 'object') return null
    const found = installation()
    const current = found?.version ?? null
    if (current === null) return null
    if (current === pending.fromVersion) {
      const age = Date.now() - Date.parse(pending.createdAt ?? '')
      if (Number.isFinite(age) && age > 24 * 60 * 60 * 1000) {
        removeFile(paths.pending)
        state.pendingUpdate = null
        persist()
        log('pending-expired', { fromVersion: pending.fromVersion })
      }
      return null
    }
    const snapshotDir = typeof pending.snapshotDir === 'string' ? pending.snapshotDir : null
    const manifest = snapshotDir === null ? null : readJson(join(snapshotDir, 'manifest.json'), null)
    log('recovery-start', { fromVersion: pending.fromVersion, toVersion: current, snapshot: snapshotDir })
    const report = {
      time: new Date().toISOString(),
      trigger: 'post-update',
      fromVersion: pending.fromVersion,
      toVersion: current,
      snapshot: pending.snapshotId ?? null,
      settings: settingsForReport(settings),
      restore: null,
      reinstall: null,
      errors: [],
    }
    if (snapshotDir !== null && existsSync(snapshotDir)) {
      try {
        report.restore = restoreSnapshot({
          paths,
          snapshotDir,
          policy: settings.restorePolicy,
          restoreSettings: settings.restoreSettings,
        })
      } catch (error) {
        report.errors.push(`restore: ${errorMessage(error)}`)
      }
      try {
        report.reinstall = await reinstallPlugins({
          ctx,
          paths,
          snapshot: {
            bundles: manifest?.bundles ?? [],
            dependencies: manifest?.dependencies ?? {},
            disabledRows: manifest?.disabledRows ?? [],
          },
          log: (message) => log('reinstall', { message }),
        })
      } catch (error) {
        report.errors.push(`reinstall: ${errorMessage(error)}`)
      }
    } else {
      report.errors.push('the pre-update snapshot could not be found')
    }
    writeJson(paths.recovery, report)
    removeFile(paths.pending)
    state.pendingUpdate = null
    state.currentVersion = current
    state.phase = 'idle'
    persist()
    log('recovery-done', {
      restored: report.restore?.files?.length ?? 0,
      installed: report.reinstall?.installed?.length ?? 0,
      reinstalled: report.reinstall?.reinstalled?.length ?? 0,
      errors: report.errors.length,
    })
    return report
  }

  async function reinstall(dryRun) {
    const found = installation()
    const latest = snapshotList(paths)[0]
    const snapshot = latest === undefined
      ? (() => {
          const manifest = readJson(join(paths.profileDir, 'package.json'), null)
          const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
          return { bundles, dependencies: manifest?.dependencies ?? {}, disabledRows: [] }
        })()
      : (() => {
          const manifest = readJson(join(latest.directory, 'manifest.json'), null)
          return {
            bundles: manifest?.bundles ?? [],
            dependencies: manifest?.dependencies ?? {},
            disabledRows: manifest?.disabledRows ?? [],
          }
        })()
    if (found === null) throw new Error('this is not a packaged DSH Desktop installation')
    const report = await reinstallPlugins({
      ctx,
      paths,
      snapshot,
      dryRun: dryRun === true,
      log: (message) => log('reinstall', { message }),
    })
    writeJson(join(paths.state, 'last-reinstall.json'), { time: new Date().toISOString(), dryRun: dryRun === true, report })
    return report
  }

  async function restore(snapshotId, policy) {
    const entries = snapshotList(paths)
    const chosen = snapshotId === undefined
      ? entries[0]
      : entries.find((entry) => entry.id === snapshotId)
    if (chosen === undefined) throw new Error('no snapshot is available to restore')
    const report = restoreSnapshot({
      paths,
      snapshotDir: chosen.directory,
      policy: policy === 'missing-only' ? 'missing-only' : settings.restorePolicy,
      restoreSettings: settings.restoreSettings,
    })
    writeJson(join(paths.state, 'last-restore.json'), { time: new Date().toISOString(), snapshot: chosen.id, report })
    log('settings-restored', { snapshot: chosen.id, files: report.files.length })
    return report
  }

  async function snapshotNow() {
    const found = installation()
    if (found === null) throw new Error('this is not a packaged DSH Desktop installation')
    const created = prepareSnapshot(found)
    return {
      id: created.manifest.id,
      directory: created.directory,
      bundles: created.manifest.bundles.length,
      files: created.manifest.profileFiles,
      storages: created.manifest.storages,
      data: created.manifest.data,
    }
  }

  function updateSettings(patch) {
    if (typeof patch !== 'object' || patch === null) throw new Error('settings patch must be an object')
    const next = { ...settings }
    if (typeof patch.autoInstall === 'boolean') next.autoInstall = patch.autoInstall
    if (typeof patch.waitForIdle === 'boolean') next.waitForIdle = patch.waitForIdle
    if (Number.isFinite(patch.checkIntervalMinutes) && patch.checkIntervalMinutes >= 0 && patch.checkIntervalMinutes <= 24 * 60) {
      next.checkIntervalMinutes = Math.round(patch.checkIntervalMinutes)
    }
    if (Number.isFinite(patch.snapshotKeep) && patch.snapshotKeep >= 1 && patch.snapshotKeep <= 50) {
      next.snapshotKeep = Math.round(patch.snapshotKeep)
    }
    if (typeof patch.restoreSettings === 'boolean') next.restoreSettings = patch.restoreSettings
    if (patch.restorePolicy === 'overwrite' || patch.restorePolicy === 'missing-only') next.restorePolicy = patch.restorePolicy
    Object.assign(settings, next)
    writeJson(paths.settings, settings)
    log('settings-updated', { settings })
    return settings
  }

  /** Auto-install when a check finds an update. */
  async function autoInstallIfDue() {
    if (settings.autoInstall !== true) return
    if (state.available !== true) return
    if (state.phase === 'downloading' || state.phase === 'installing') return
    if (settings.waitForIdle === true && hasActiveWork(ctx)) {
      log('auto-install-deferred', { reason: 'active tasks' })
      return
    }
    log('auto-install-start', { version: state.latestVersion })
    const result = await downloadAndInstall()
    if (result.ok !== true) log('auto-install-failed', { error: result.error })
  }

  // Initial facts, then the background loops.
  state.desktop = installation() !== null
  state.currentVersion = state.desktop === true ? installation()?.version ?? null : null
  persist()

  ctx.effect(() => {
    const timer = setTimeout(() => {
      void check(false)
        .then(() => autoInstallIfDue())
        .catch(() => undefined)
    }, 5_000)
    return () => clearTimeout(timer)
  })

  ctx.effect(() => {
    const minutes = Number(settings.checkIntervalMinutes)
    if (!Number.isFinite(minutes) || minutes <= 0) return () => undefined
    const timer = setInterval(() => {
      void check(false)
        .then(() => autoInstallIfDue())
        .catch(() => undefined)
    }, Math.max(1, minutes) * 60_000)
    return () => clearInterval(timer)
  })

  ctx.effect(() => {
    const timer = setTimeout(() => {
      void recoverAfterUpdate().catch((error) => log('recovery-failed', { message: errorMessage(error) }))
    }, RECOVERY_DELAY_MS)
    return () => clearTimeout(timer)
  })

  installRoute(ctx, {
    status: () => finish(),
    check: () => check(true),
    install: (body) => downloadAndInstall(body?.dryRun === true),
    snapshot: () => snapshotNow().then((value) => finish({ snapshot: value })),
    reinstall: (body) => reinstall(body?.dryRun === true).then((report) => finish({ reinstall: report })),
    restore: (body) => restore(body?.snapshotId, body?.policy).then((report) => finish({ restore: report })),
    settings: (body) => {
      const next = updateSettings(body?.settings ?? body)
      return { ...finish(), settings: next }
    },
    log: () => {
      const file = paths.log
      return { ok: true, path: paths.state, log: existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/u).slice(-80) : [] }
    },
  })

  log('plugin-ready', {
    home,
    profileDir: paths.profileDir,
    desktop: state.desktop,
    currentVersion: state.currentVersion,
    settings,
  })
}

/**
 * @param {() => any} status
 * @param {() => Promise<any>} check
 * @param {() => Promise<any>} install
 * @param {() => Promise<any>} snapshot
 * @param {(body: any) => Promise<any>} reinstall
 * @param {(body: any) => Promise<any>} restore
 * @param {(body: any) => any} settings
 * @param {() => any} log
 */
function installRoute(ctx, handlers) {
  const server = ctx.get('webServer')
  if (server === undefined || server === null) return
  ctx.effect(() => server.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (request, response) => handleRequest(request, response, handlers),
  }))
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {Record<string, Function>} handlers
 */
async function handleRequest(request, response, handlers) {
  try {
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const action = url.pathname.startsWith(`${ROUTE_PREFIX}/`)
      ? url.pathname.slice(ROUTE_PREFIX.length + 1)
      : url.pathname.slice(1)
    const body = await readBody(request)
    switch (action) {
      case 'status':
        sendJson(response, 200, handlers.status())
        return
      case 'check':
        sendJson(response, 200, await handlers.check())
        return
      case 'install':
        sendJson(response, 200, await handlers.install(body))
        return
      case 'snapshot':
        sendJson(response, 200, await handlers.snapshot())
        return
      case 'reinstall':
        sendJson(response, 200, await handlers.reinstall(body))
        return
      case 'restore':
        sendJson(response, 200, await handlers.restore(body))
        return
      case 'settings':
        sendJson(response, 200, handlers.settings(body))
        return
      case 'log':
        sendJson(response, 200, handlers.log())
        return
      default:
        sendJson(response, 404, { ok: false, error: `unknown action: ${action}` })
    }
  } catch (error) {
    sendJson(response, 500, { ok: false, error: errorMessage(error) })
  }
}

/** @param {import('node:http').IncomingMessage} request */
async function readBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (total === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} value
 */
function sendJson(response, status, value) {
  const payload = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

/**
 * Whether an agent turn or a background job is currently running.
 * Follows the Desktop shell's own definition, with every service optional.
 * @param {any} ctx
 */
function hasActiveWork(ctx) {
  try {
    const agents = ctx.get('agents')
    const jobs = ctx.get('jobs')
    if (agents === undefined || jobs === undefined) return false
    const live = agents.list()
    const busy = live.some((agent) => agent.status === 'running'
      || (agent.inbox?.nextTurn?.length ?? 0) > 0
      || (agent.inbox?.nextStep?.length ?? 0) > 0)
    if (busy) return true
    return [undefined, ...live].some((agent) => jobs.list(agent?.id).some((job) => job.status === 'running' || job.status === 'stopping'))
  } catch {
    return false
  }
}

/**
 * Merge plugin-documented config with the user's saved preferences.
 * Saved preferences win so the settings page can change them without editing
 * the profile patch.
 * @param {ReturnType<typeof createPaths>} paths
 * @param {Record<string, unknown>} config
 */
function loadSettings(paths, config) {
  const saved = readJson(paths.settings, {})
  const merged = {
    autoInstall: config.autoInstall !== false,
    waitForIdle: config.autoInstallWhenIdle !== false,
    checkIntervalMinutes: Number.isFinite(config.checkIntervalMinutes) ? Number(config.checkIntervalMinutes) : 30,
    snapshotKeep: Number.isFinite(config.snapshotKeep) ? Number(config.snapshotKeep) : 5,
    restoreSettings: config.restoreSettings !== false,
    restorePolicy: config.restorePolicy === 'missing-only' ? 'missing-only' : 'overwrite',
    dataDirs: Array.isArray(config.dataDirs) ? config.dataDirs.filter((entry) => typeof entry === 'string') : undefined,
  }
  const effective = {
    ...merged,
    ...(typeof saved === 'object' && saved !== null ? saved : {}),
  }
  if (!Array.isArray(effective.dataDirs)) {
    effective.dataDirs = [
      'dsh-pet',
      'dsh-market',
      'skills-manager',
      'pet-indesktop',
      'archive-desk',
      'llm-deepseek',
      'skill-mcp-manager',
      'mcp-bundles',
    ]
  }
  return effective
}

/** @param {Record<string, unknown>} settings */
function settingsForReport(settings) {
  return {
    autoInstall: settings.autoInstall,
    restoreSettings: settings.restoreSettings,
    restorePolicy: settings.restorePolicy,
    snapshotKeep: settings.snapshotKeep,
  }
}
