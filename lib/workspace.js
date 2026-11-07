/**
 * DSH home/profile paths, per-user state, update snapshots and post-update
 * recovery (plugin reinstallation plus settings restoration).
 *
 * The snapshot deliberately stores only the small, user-owned parts of a
 * profile: the manifest, the Cordis patch with the user's plugin settings, the
 * lockfile, the build-script allowlist, version exemptions, the `storages`
 * directory and the configured plugin data directories. Sessions, attachments
 * and caches stay untouched.
 *
 * @module @local/dsh-auto-update/workspace
 */
import { spawn } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** Files that carry profile-level plugin state. */
export const PROFILE_FILES = [
  'package.json',
  'cordis.patch.yml',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'compatibility.json',
  '.npmrc',
]

/** DSH_HOME directories that hold data owned by individual plugins. */
export const DEFAULT_DATA_DIRS = [
  'dsh-pet',
  'dsh-market',
  'skills-manager',
  'pet-indesktop',
  'archive-desk',
  'llm-deepseek',
  'skill-mcp-manager',
  'mcp-bundles',
]

/** @param {NodeJS.ProcessEnv} [env] */
export function resolveHome(env = process.env) {
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0) return env.DSH_HOME
  return join(homedir(), '.dsh')
}

/** @param {NodeJS.ProcessEnv} [env] */
export function resolveProfileDir(home, env = process.env) {
  if (typeof env.DSH_PROFILE_DIR === 'string' && env.DSH_PROFILE_DIR.length > 0) return env.DSH_PROFILE_DIR
  const profile = typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE.length > 0 ? env.DSH_PROFILE : 'desktop'
  return join(home, 'profiles', profile)
}

/**
 * @param {string} home
 * @param {NodeJS.ProcessEnv} [env]
 */
export function createPaths(home, env = process.env) {
  const state = join(home, 'dsh-auto-update')
  return {
    home,
    state,
    profileDir: resolveProfileDir(home, env),
    snapshots: join(state, 'snapshots'),
    downloads: join(state, 'downloads'),
    settings: join(state, 'settings.json'),
    stateFile: join(state, 'state.json'),
    pending: join(state, 'pending.json'),
    recovery: join(state, 'recovery.json'),
    log: join(state, 'log.jsonl'),
  }
}

/** @param {string} file */
export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Atomic JSON write (write beside the target, then rename). */
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

/** @param {string} file */
export function removeFile(file) {
  try {
    rmSync(file, { force: true })
  } catch {
    // Best effort: a stale file is reported by the next read.
  }
}

/**
 * Append one structured line to the plugin's own log, keeping it bounded.
 * @param {string} file
 * @param {Record<string, unknown>} record
 */
export function appendLog(file, record) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean) : []
    lines.push(JSON.stringify({ time: new Date().toISOString(), ...record }))
    const kept = lines.slice(-400)
    writeFileSync(file, `${kept.join('\n')}\n`, 'utf8')
  } catch {
    // Logging is optional.
  }
}

/** @param {string} value */
export function timestampId(value = new Date()) {
  return value.toISOString().replace(/[:.]/gu, '-')
}

/** @param {string} profileDir */
export function readProfileManifest(profileDir) {
  const manifest = readJson(join(profileDir, 'package.json'))
  if (manifest === null || typeof manifest !== 'object') return null
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  return {
    manifest,
    dependencies: typeof manifest.dependencies === 'object' && manifest.dependencies !== null ? manifest.dependencies : {},
    bundles,
  }
}

/**
 * Create a snapshot before an update.
 * @param {{
 *   paths: ReturnType<typeof createPaths>,
 *   installation: { version: string },
 *   dataDirs?: string[],
 *   keep?: number,
 *   reason?: string,
 * }} options
 */
export function createSnapshot(options) {
  const { paths, installation } = options
  const dataDirs = Array.isArray(options.dataDirs) ? options.dataDirs : DEFAULT_DATA_DIRS
  const id = timestampId()
  const directory = join(paths.snapshots, id)
  mkdirSync(join(directory, 'profile'), { recursive: true })
  const profile = readProfileManifest(paths.profileDir)
  const copied = []
  for (const name of PROFILE_FILES) {
    const source = join(paths.profileDir, name)
    if (!existsSync(source)) continue
    const destination = join(directory, 'profile', name)
    copyFileSync(source, destination)
    copied.push(name)
  }
  let storages = false
  const storagesSource = join(paths.home, 'storages')
  if (existsSync(storagesSource)) {
    cpSync(storagesSource, join(directory, 'storages'), {
      recursive: true,
      force: true,
      filter: (source) => basename(source) !== 'session_projcache',
    })
    storages = true
  }
  const data = []
  for (const name of dataDirs) {
    const source = join(paths.home, name)
    if (!existsSync(source)) continue
    try {
      cpSync(source, join(directory, 'data', name), { recursive: true, force: true })
      data.push(name)
    } catch {
      // A locked file in one plugin's data directory must not fail the snapshot.
    }
  }
  const manifest = {
    schemaVersion: 1,
    id,
    createdAt: new Date().toISOString(),
    reason: options.reason ?? 'manual',
    fromVersion: installation?.version ?? null,
    profileDir: paths.profileDir,
    profileFiles: copied,
    storages,
    data,
    bundles: profile?.bundles ?? [],
    dependencies: profile?.dependencies ?? {},
    disabledRows: readDisabledRows(paths.profileDir),
  }
  writeJson(join(directory, 'manifest.json'), manifest)
  pruneSnapshots(paths, options.keep ?? 5)
  return { directory, manifest }
}

/**
 * Bundle rows the user explicitly disabled in the profile patch.
 * @param {string} profileDir
 * @returns {{ id: string, name?: string, disabled: boolean }[]}
 */
export function readDisabledRows(profileDir) {
  const file = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(file)) return []
  const rows = []
  let current = null
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const match = /^\s*-\s+id:\s*(.+)$/u.exec(raw)
    if (match !== null) {
      current = { id: match[1].trim(), hasName: false, disabled: null }
      rows.push(current)
      continue
    }
    if (current === null) continue
    const name = /^\s*name:\s*(.+)$/u.exec(raw)
    if (name !== null) {
      current.hasName = true
      current.name = name[1].trim().replace(/^['"]|['"]$/gu, '')
      continue
    }
    const disabled = /^\s*disabled:\s*(true|false)\s*$/u.exec(raw)
    if (disabled !== null) current.disabled = disabled[1] === 'true'
  }
  return rows
    .filter((row) => row.disabled !== null)
    .map(({ id, name, disabled }) => ({ id, ...(name === undefined ? {} : { name }), disabled }))
}

/** @param {ReturnType<typeof createPaths>} paths @param {number} keep */
export function pruneSnapshots(paths, keep) {
  if (!existsSync(paths.snapshots)) return
  const entries = snapshotList(paths).sort((a, b) => b.id.localeCompare(a.id))
  for (const entry of entries.slice(Math.max(1, keep))) {
    try {
      rmSync(entry.directory, { recursive: true, force: true })
    } catch {
      // A snapshot that cannot be removed is simply kept.
    }
  }
}

/** @param {ReturnType<typeof createPaths>} paths */
export function snapshotList(paths) {
  if (!existsSync(paths.snapshots)) return []
  return readdirSync(paths.snapshots, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = join(paths.snapshots, entry.name)
      const manifest = readJson(join(directory, 'manifest.json'), null)
      return {
        id: entry.name,
        directory,
        createdAt: manifest?.createdAt ?? null,
        fromVersion: manifest?.fromVersion ?? null,
        reason: manifest?.reason ?? null,
        bundles: Array.isArray(manifest?.bundles) ? manifest.bundles : [],
      }
    })
    .sort((a, b) => b.id.localeCompare(a.id))
}

/** @param {string} file */
function safeStat(file) {
  try {
    return statSync(file)
  } catch {
    return null
  }
}

/**
 * Restore a snapshot's profile files, storages and plugin data.
 *
 * Before writing anything, the current state of every restored location is
 * copied under `<snapshot>/pre-restore-<timestamp>/`, so a restore is always
 * reversible. `overwrite` replaces files; `missing-only` restores only what is
 * absent now.
 *
 * @param {{
 *   paths: ReturnType<typeof createPaths>,
 *   snapshotDir: string,
 *   policy?: 'overwrite' | 'missing-only',
 *   restoreSettings?: boolean,
 * }} options
 */
export function restoreSnapshot(options) {
  const { paths, snapshotDir } = options
  const policy = options.policy === 'missing-only' ? 'missing-only' : 'overwrite'
  const restoreSettings = options.restoreSettings !== false
  const manifest = readJson(join(snapshotDir, 'manifest.json'))
  if (manifest === null || typeof manifest !== 'object') throw new Error('snapshot manifest is missing or unreadable')
  const backup = join(snapshotDir, `pre-restore-${timestampId()}`)
  const report = {
    policy,
    snapshot: basename(snapshotDir),
    backup,
    files: [],
    settings: [],
    skipped: [],
    errors: [],
  }

  const copyInto = (source, destination, label) => {
    if (!existsSync(source)) return
    const current = safeStat(destination)
    if (current !== null || policy === 'overwrite') {
      if (current !== null) {
        const backupTarget = join(backup, label)
        mkdirSync(dirname(backupTarget), { recursive: true })
        try {
          cpSync(destination, backupTarget, { recursive: true, force: true })
        } catch (error) {
          report.errors.push(`could not back up ${label}: ${errorMessage(error)}`)
          return
        }
      }
      if (current !== null && policy === 'missing-only') {
        report.skipped.push(label)
        return
      }
      try {
        mkdirSync(dirname(destination), { recursive: true })
        // A directory is merged rather than removed: files the snapshot does
        // not contain (for example data a newer plugin created) stay in place.
        cpSync(source, destination, { recursive: true, force: true })
        report.files.push(label)
      } catch (error) {
        report.errors.push(`could not restore ${label}: ${errorMessage(error)}`)
      }
      return
    }
    try {
      mkdirSync(dirname(destination), { recursive: true })
      cpSync(source, destination, { recursive: true, force: true })
      report.files.push(label)
    } catch (error) {
      report.errors.push(`could not restore ${label}: ${errorMessage(error)}`)
    }
  }

  for (const name of Array.isArray(manifest.profileFiles) ? manifest.profileFiles : PROFILE_FILES) {
    copyInto(join(snapshotDir, 'profile', name), join(paths.profileDir, name), `profile/${name}`)
  }
  if (restoreSettings) {
    if (manifest.storages !== false) {
      copyInto(join(snapshotDir, 'storages'), join(paths.home, 'storages'), 'storages')
    }
    for (const name of Array.isArray(manifest.data) ? manifest.data : []) {
      copyInto(join(snapshotDir, 'data', name), join(paths.home, name), `data/${name}`)
    }
  }
  return report
}

/**
 * Reinstall the profile's plugins and restore their saved enablement.
 *
 * The primary path is the profile's own pnpm entry (passed by the Desktop shell
 * to its host process), which rebuilds `node_modules` from the restored
 * manifest and lockfile. When that entry is unavailable, missing bundles are
 * installed one by one through the Plugin Manager service.
 *
 * @param {{
 *   ctx: any,
 *   paths: ReturnType<typeof createPaths>,
 *   snapshot?: { bundles: string[], dependencies: Record<string, string>, disabledRows: Array<{ id: string, name?: string, disabled: boolean }> },
 *   dryRun?: boolean,
 *   log: (message: string) => void,
 * }} options
 */
export async function reinstallPlugins(options) {
  const { ctx, paths } = options
  const snapshot = options.snapshot ?? readProfileManifest(paths.profileDir) ?? { bundles: [], dependencies: {} }
  const log = options.log ?? (() => {})
  const report = {
    pnpm: null,
    installed: [],
    reinstalled: [],
    enabled: [],
    disabled: [],
    missing: [],
    skipped: [],
    errors: [],
  }
  const manager = ctx.get('pluginManager')
  const pnpm = resolvePnpmCommand()
  if (pnpm === null) {
    report.pnpm = { available: false, reason: 'the Desktop pnpm entry is not visible to the plugin' }
    log('pnpm entry not available; falling back to per-bundle installation')
  } else if (options.dryRun === true) {
    report.pnpm = { available: true, dryRun: true, command: pnpm.display }
    log(`would run ${pnpm.display} install in ${paths.profileDir}`)
  } else {
    log(`running ${pnpm.display} install in ${paths.profileDir}`)
    const result = await runPnpmInstall(pnpm, paths.profileDir)
    report.pnpm = { available: true, exitCode: result.code, output: result.output.slice(-8000) }
    if (result.code !== 0) report.errors.push(`pnpm install exited with ${result.code}`)
  }

  if (manager === undefined) {
    report.errors.push('the plugin manager service is unavailable, so bundle state could not be reconciled')
    return report
  }
  let bundles = []
  try {
    bundles = await manager.listBundles()
  } catch (error) {
    report.errors.push(`could not list bundles: ${errorMessage(error)}`)
    return report
  }
  const byName = new Map(bundles.map((bundle) => [bundle.name, bundle]))
  for (const name of snapshot.bundles ?? []) {
    const info = byName.get(name)
    if (info === undefined) {
      const spec = snapshot.dependencies?.[name] ?? null
      if (spec === null) {
        report.missing.push(name)
        continue
      }
      if (options.dryRun === true) {
        report.installed.push(`${name} (${spec})`)
        continue
      }
      try {
        log(`installing missing bundle ${name} from ${spec}`)
        const result = await manager.installBundle(spec, { enabled: true })
        if (result.application === 'failed' || result.changed === false) {
          report.errors.push(`could not install ${name}: ${result.error?.code ?? result.application}`)
        } else {
          report.installed.push(name)
        }
      } catch (error) {
        report.errors.push(`could not install ${name}: ${errorMessage(error)}`)
      }
      continue
    }
    if (info.availability === 'missing' || info.error !== undefined) {
      const spec = snapshot.dependencies?.[name] ?? info.source ?? null
      if (spec === null) {
        report.missing.push(name)
        continue
      }
      if (options.dryRun === true) {
        report.reinstalled.push(`${name} (${spec})`)
        continue
      }
      try {
        log(`reinstalling broken bundle ${name} from ${spec}`)
        await manager.removeBundle(name).catch(() => undefined)
        const result = await manager.installBundle(spec, { enabled: true })
        if (result.application === 'failed' || result.changed === false) {
          report.errors.push(`could not reinstall ${name}: ${result.error?.code ?? result.application}`)
        } else {
          report.reinstalled.push(name)
        }
      } catch (error) {
        report.errors.push(`could not reinstall ${name}: ${errorMessage(error)}`)
      }
      continue
    }
    if (info.enabled !== true) {
      if (options.dryRun === true) {
        report.enabled.push(name)
        continue
      }
      try {
        const result = await manager.setBundleEnabled(name, true)
        if (result.changed) report.enabled.push(name)
      } catch (error) {
        report.errors.push(`could not enable ${name}: ${errorMessage(error)}`)
      }
    }
  }
  // Disabled rows are restored with the profile patch itself, so no per-row
  // toggle is attempted here: the restored patch owns that state.
  return report
}

/**
 * Locate the pnpm entry the Desktop shell passes to its host process.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ command: string, args: string[], env: Record<string, string>, display: string } | null}
 */
export function resolvePnpmCommand(env = process.env) {
  const argv = process.argv
  const entry = argv[5]
  const nodeBin = argv[6]
  if (typeof entry === 'string' && entry.length > 0 && existsSync(entry)) {
    const childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: process.execPath }
    if (typeof nodeBin === 'string' && nodeBin.length > 0) childEnv.PATH = `${nodeBin};${env.PATH ?? ''}`
    return {
      command: process.execPath,
      args: ['--expose-internals', entry],
      env: childEnv,
      display: `${process.execPath} ${entry}`,
    }
  }
  return null
}

/**
 * Run one bounded `pnpm install` in the profile directory.
 * @param {{ command: string, args: string[], env: Record<string, string> }} pnpm
 * @param {string} profileDir
 * @param {number} [timeoutMs]
 */
export function runPnpmInstall(pnpm, profileDir, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    const output = []
    let settled = false
    const finish = (code, note) => {
      if (settled) return
      settled = true
      if (note !== undefined) output.push(note)
      resolve({ code, output: output.join('\n') })
    }
    let child
    try {
      child = spawn(pnpm.command, [...pnpm.args, 'install', '--reporter=append-only'], {
        cwd: profileDir,
        env: pnpm.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      finish(-1, errorMessage(error))
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        // The timeout report below still explains the failure.
      }
      finish(-1, 'pnpm install timed out')
    }, timeoutMs)
    const collect = (chunk) => {
      output.push(String(chunk))
      if (output.join('').length > 256 * 1024) output.splice(0, Math.floor(output.length / 2))
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (error) => {
      clearTimeout(timer)
      finish(-1, errorMessage(error))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(code ?? -1)
    })
  })
}

/** @param {unknown} error */
export function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** @param {string} home */
export function ensureDirectory(home) {
  mkdirSync(home, { recursive: true })
}
