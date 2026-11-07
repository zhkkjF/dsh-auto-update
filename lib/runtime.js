/**
 * Desktop installation facts, update-feed parsing, version comparison and
 * installer download for the auto-update plugin.
 *
 * Everything here is plain Node: the DSH Desktop host process runs the
 * Electron executable in Node mode, so `process.resourcesPath` and Electron's
 * ASAR-aware filesystem are available, but no Electron API is.
 *
 * @module @local/dsh-auto-update/runtime
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Update channel used when the packaged manifest does not name one. */
export const DEFAULT_CHANNEL = 'nightly'

/**
 * Read `app-update.yml` next to the packaged application.
 * @param {string} resourcesDir - The unpacked `resources` directory.
 * @returns {{ provider: string, url: string | null, channel: string, updaterCacheDirName: string | null } | null}
 */
export function readUpdateConfig(resourcesDir) {
  const file = join(resourcesDir, 'app-update.yml')
  if (!existsSync(file)) return null
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const values = {}
  for (const raw of text.split(/\r?\n/u)) {
    const match = /^([A-Za-z][\w.-]*):\s*(.*)$/u.exec(raw.trim())
    if (!match) continue
    values[match[1]] = stripQuotes(match[2].trim())
  }
  const channel = values.channel === 'latest' || values.channel === 'nightly' ? values.channel : DEFAULT_CHANNEL
  return {
    provider: values.provider ?? 'generic',
    url: values.url ?? null,
    channel,
    updaterCacheDirName: values.updaterCacheDirName ?? null,
  }
}

/**
 * Resolve the packaged Desktop installation and its version.
 *
 * Candidates are tried in order: the runtime directory the Desktop shell
 * passes to its host process, the Electron `resources` path, and the
 * `resources` sibling of `process.execPath`. A candidate only counts when both
 * `app-update.yml` and the ASAR manifest can be read.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   version: string,
 *   resourcesDir: string,
 *   asarPath: string,
 *   updateConfig: { provider: string, url: string | null, channel: string, updaterCacheDirName: string | null },
 * } | null}
 */
export function resolveInstallation(env = process.env) {
  const candidates = []
  const runtimeDir = env.DSH_DESKTOP_DSH_DIR
  if (typeof runtimeDir === 'string' && runtimeDir.length > 0) candidates.push(dirname(runtimeDir))
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) candidates.push(process.resourcesPath)
  if (typeof process.execPath === 'string' && process.execPath.length > 0) {
    candidates.push(join(dirname(process.execPath), 'resources'))
  }
  for (const resourcesDir of candidates) {
    const updateConfig = readUpdateConfig(resourcesDir)
    if (updateConfig === null) continue
    const asarPath = join(resourcesDir, 'app.asar')
    const version = readAsarVersion(asarPath)
    if (version === null) continue
    return { version, resourcesDir, asarPath, updateConfig }
  }
  return null
}

/**
 * Read the packaged application version from the ASAR manifest.
 * @param {string} asarPath
 * @returns {string | null}
 */
export function readAsarVersion(asarPath) {
  try {
    const manifest = JSON.parse(readFileSync(join(asarPath, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

/**
 * Compare two semantic versions, including prerelease identifiers.
 * @param {string} a
 * @param {string} b
 * @returns {number} -1, 0 or 1
 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return 0
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index += 1) {
    const x = left.pre[index]
    const y = right.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const numericX = /^\d+$/u.test(x)
    const numericY = /^\d+$/u.test(y)
    if (numericX && numericY) {
      const delta = Number(x) - Number(y)
      if (delta !== 0) return delta > 0 ? 1 : -1
    } else if (numericX) {
      return -1
    } else if (numericY) {
      return 1
    } else if (x !== y) {
      return x > y ? 1 : -1
    }
  }
  return 0
}

/** @param {string} value */
function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value.trim())
  if (match === null) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/**
 * Parse the electron-updater generic feed (`<channel>.yml`).
 *
 * electron-builder writes `>-` folded scalars for URLs and digests; this
 * reader follows the block continuation and keeps only the fields the updater
 * needs, so unknown keys are ignored instead of becoming a parse error.
 *
 * @param {string} text
 * @param {string} baseUrl - The feed URL the document was read from.
 * @returns {{ version: string | null, path: string | null, sha512: string | null, size: number | null, files: Array<{ url: string, size: number | null, sha512: string | null }> }}
 */
export function parseFeed(text, baseUrl) {
  const result = { version: null, path: null, sha512: null, size: null, files: [] }
  const lines = String(text).split(/\r?\n/u)
  /** @type {{ key: string, target: 'root' | 'file', file: { url: string, size: number | null, sha512: string | null } } | null} */
  let pending = null
  let currentFile = null
  let inFiles = false
  const flush = () => {
    if (pending === null) return
    const value = pending.lines.join(' ').replace(/\s+/gu, ' ').trim()
    if (value.length > 0) assign(pending.key, value, pending.target)
    pending = null
  }
  /** @param {string} key @param {string} value @param {'root' | 'file'} target */
  const assign = (key, value, target) => {
    if (target === 'file' && currentFile !== null) {
      if (key === 'url') currentFile.url = value
      else if (key === 'size') currentFile.size = Number(value) || null
      else if (key === 'sha512') currentFile.sha512 = value
      return
    }
    if (key === 'version') result.version = stripQuotes(value)
    else if (key === 'path') result.path = resolveFeedUrl(value, baseUrl)
    else if (key === 'sha512') result.sha512 = stripQuotes(value)
    else if (key === 'size') result.size = Number(value) || null
  }
  for (const raw of lines) {
    const line = raw.replace(/\t/gu, '  ')
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const rootLine = indent === 0
    const fieldLike = /^[A-Za-z][\w.-]*:/u.test(trimmed)
    const urlLike = /^https?:\/\//u.test(trimmed) || /^sha512-/u.test(trimmed)
    if (rootLine && fieldLike) {
      // Any root-level key ends the `files:` block.
      flush()
      inFiles = false
      const key = trimmed.slice(0, trimmed.indexOf(':'))
      if (key === 'files') {
        inFiles = true
        continue
      }
      const rest = trimmed.slice(trimmed.indexOf(':') + 1).trim()
      if (rest.length === 0 || rest === '>-' || rest === '>' || rest === '|' || rest === '|-') {
        pending = { key, target: 'root', lines: [], indent, file: null }
      } else {
        assign(key, rest, 'root')
      }
      continue
    }
    const fileStart = /^-\s+([A-Za-z][\w.-]*):\s*(.*)$/u.exec(trimmed)
    if (fileStart !== null && inFiles && indent > 0) {
      flush()
      currentFile = { url: '', size: null, sha512: null }
      result.files.push(currentFile)
      const rest = fileStart[2]
      if (rest.length > 0 && rest !== '>-' && rest !== '>' && rest !== '|' && rest !== '|-') {
        assign(fileStart[1], rest, 'file')
      } else {
        pending = { key: fileStart[1], target: 'file', lines: [], indent, file: currentFile }
      }
      continue
    }
    if (pending !== null && (urlLike || !fieldLike || indent <= pending.indent)) {
      // Continuation of a folded scalar. A URL or digest line also looks like
      // `key: value`, so those are always kept as content.
      pending.lines.push(trimmed)
      continue
    }
    if (pending !== null) flush()
    const field = /^([A-Za-z][\w.-]*):\s*(.*)$/u.exec(trimmed)
    if (field !== null) {
      const rest = field[2]
      if (rest.length === 0 || rest === '>-' || rest === '>' || rest === '|' || rest === '|-') {
        if (inFiles && currentFile !== null) pending = { key: field[1], target: 'file', lines: [], indent, file: currentFile }
        else pending = { key: field[1], target: 'root', lines: [], indent, file: null }
      } else if (inFiles && currentFile !== null) {
        assign(field[1], rest, 'file')
      } else {
        assign(field[1], rest, 'root')
      }
      continue
    }
    if (pending !== null) pending.lines.push(trimmed)
  }
  flush()
  if (result.files.length > 0) {
    const first = result.files[0]
    if (first.url.length > 0) first.url = resolveFeedUrl(first.url, baseUrl)
    if (result.path === null && first.url.length > 0) result.path = first.url
    if (result.sha512 === null && first.sha512 !== null) result.sha512 = first.sha512
    if (result.size === null && first.size !== null) result.size = first.size
  }
  return result
}

/**
 * @param {string} value
 * @param {string} baseUrl
 */
export function resolveFeedUrl(value, baseUrl) {
  const cleaned = stripQuotes(value)
  try {
    return new URL(cleaned, baseUrl).toString()
  } catch {
    return cleaned
  }
}

/** @param {string} value */
function stripQuotes(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Read the update feed for a channel.
 * @param {string} feedUrl - Base URL from `app-update.yml` (with trailing slash).
 * @param {string} channel
 * @param {AbortSignal} signal
 * @returns {Promise<{ url: string, text: string, parsed: ReturnType<typeof parseFeed> }>}
 */
export async function fetchFeed(feedUrl, channel, signal) {
  const base = feedUrl.endsWith('/') ? feedUrl : `${feedUrl}/`
  const url = new URL(`${channel}.yml`, base)
  const response = await fetch(url, {
    signal,
    headers: { 'cache-control': 'no-cache', 'user-agent': 'dsh-auto-update' },
  })
  if (!response.ok) throw new Error(`feed request failed with HTTP ${response.status}`)
  const text = await response.text()
  return { url: url.toString(), text, parsed: parseFeed(text, url.toString()) }
}

/**
 * Download the installer with a streaming SHA-512 check.
 * @param {{ url: string, size: number | null, sha512: string | null }} file
 * @param {string} destination
 * @param {(received: number, total: number) => void} [onProgress]
 * @param {AbortSignal} signal
 * @returns {Promise<{ path: string, size: number, sha512: string }>}
 */
export async function downloadInstaller(file, destination, onProgress, signal) {
  if (typeof file.url !== 'string' || file.url.length === 0) throw new Error('update feed did not name an installer file')
  const response = await fetch(file.url, { signal, headers: { 'user-agent': 'dsh-auto-update' } })
  if (!response.ok || response.body === null) throw new Error(`installer download failed with HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length') ?? '') || file.size || 0
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.part`
  const hash = createHash('sha512')
  let received = 0
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      hash.update(chunk)
      if (onProgress !== undefined) {
        try {
          onProgress(received, total)
        } catch {
          // Progress reporting must never break the transfer.
        }
      }
      callback(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary))
  const digest = hash.digest('base64')
  if (file.sha512 !== null && file.sha512.length > 0) {
    const expected = stripShaPrefix(file.sha512)
    if (expected !== digest) {
      await rm(temporary, { force: true })
      throw new Error('downloaded installer failed its SHA-512 check')
    }
  }
  if (file.size !== null && file.size > 0 && received !== file.size) {
    await rm(temporary, { force: true })
    throw new Error(`downloaded installer has ${received} bytes, the feed named ${file.size}`)
  }
  await rename(temporary, destination)
  const info = await stat(destination)
  return { path: destination, size: info.size, sha512: digest }
}

/** @param {string} value */
function stripShaPrefix(value) {
  return value.startsWith('sha512-') ? value.slice(7) : value
}

/**
 * A stable, filesystem-safe file name for an installer URL.
 * @param {string} url
 * @param {string} version
 */
export function installerFileName(url, version) {
  const name = basename(new URL(url).pathname)
  const safe = name.replace(/[^\w.-]+/gu, '_')
  return `${version}-${safe.length > 0 ? safe : 'installer.exe'}`
}
