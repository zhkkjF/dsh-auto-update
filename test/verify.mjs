/**
 * Self-check for the auto-update plugin's pure Node pieces.
 *
 * Runs under Electron-as-Node so `process.resourcesPath` and the ASAR-aware
 * filesystem behave exactly like the DSH Desktop host process.
 *
 *   $env:ELECTRON_RUN_AS_NODE='1'; & 'F:\deepseek\DeepSeek Harness.exe' test\verify.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  compareVersions,
  fetchFeed,
  parseFeed,
  resolveInstallation,
} from '../lib/runtime.js'
import {
  createPaths,
  createSnapshot,
  readDisabledRows,
  restoreSnapshot,
  snapshotList,
} from '../lib/workspace.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`ok   ${name}`)
  } else {
    failures += 1
    console.log(`FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

function equal(name, actual, expected) {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)
}

// --- semver ---------------------------------------------------------------
equal('0.2.2-rc.1 > 0.2.1-rc.5', compareVersions('0.2.2-rc.1', '0.2.1-rc.5'), 1)
equal('0.2.1-rc.5 > 0.2.1-rc.4', compareVersions('0.2.1-rc.5', '0.2.1-rc.4'), 1)
equal('1.0.0 > 1.0.0-rc.1', compareVersions('1.0.0', '1.0.0-rc.1'), 1)
equal('1.0.0 = 1.0.0', compareVersions('1.0.0', '1.0.0'), 0)
equal('1.10.0 > 1.9.9', compareVersions('1.10.0', '1.9.9'), 1)

// --- feed parsing ---------------------------------------------------------
const feedSample = `version: 0.2.2-rc.1
files:
  - url: >-
      https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.1-win-x64.exe
    size: 293425336
    sha512: >-
      swcK0J6ofGkaAWLRpOes2ca7CWO8vuM5Vp0FRnQ/DG3q+Z+OhvsgLz3hIiSYpRUETY+fEz+Ww86fNa0jiVIifw==
path: >-
  https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.1-win-x64.exe
sha512: >-
  swcK0J6ofGkaAWLRpOes2ca7CWO8vuM5Vp0FRnQ/DG3q+Z+OhvsgLz3hIiSYpRUETY+fEz+Ww86fNa0jiVIifw==
stagingPercentage: 100
releaseDate: '2026-11-04T09:31:49.677Z'
`
const parsedSample = parseFeed(feedSample, 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml')
equal('feed version', parsedSample.version, '0.2.2-rc.1')
equal('feed file count', parsedSample.files.length, 1)
equal('feed size', parsedSample.files[0]?.size, 293425336)
check('feed url resolved', String(parsedSample.files[0]?.url).endsWith('.exe'))
check('feed sha512 kept', String(parsedSample.files[0]?.sha512).startsWith('swcK0J6ofGkaA'))

// --- installation ---------------------------------------------------------
const installation = resolveInstallation()
check('installation resolved', installation !== null)
if (installation !== null) {
  console.log(`     version=${installation.version} resources=${installation.resourcesDir} channel=${installation.updateConfig.channel}`)
  check('packaged version is a semver', /^\d+\.\d+\.\d+/u.test(installation.version), installation.version)
  equal('update channel', installation.updateConfig.channel, 'nightly')
  check('generic feed url', String(installation.updateConfig.url).startsWith('https://download.deepseek.com/dsh-desk/feeds/'), String(installation.updateConfig.url))
  try {
    const live = await fetchFeed(installation.updateConfig.url, installation.updateConfig.channel, AbortSignal.timeout(30_000))
    check('live feed version looks like a release', /^\d+\.\d+\.\d+/u.test(String(live.parsed.version)), String(live.parsed.version))
    check('live feed has installer url', String(live.parsed.files[0]?.url).startsWith('https://'), String(live.parsed.files[0]?.url))
    console.log(`     live feed=${live.parsed.version} available=${compareVersions(String(live.parsed.version), installation.version) > 0}`)
  } catch (error) {
    check('live feed reachable', false, error.message)
  }
}

// --- snapshot / restore on a scratch home ---------------------------------
const scratch = mkdtempSync(join(tmpdir(), 'dau-test-'))
const home = join(scratch, '.dsh')
const profile = join(home, 'profiles', 'desktop')
mkdirSync(join(profile, 'node_modules', '@local', 'demo'), { recursive: true })
mkdirSync(join(home, 'storages', 'demo'), { recursive: true })
mkdirSync(join(home, 'dsh-pet'), { recursive: true })
writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { '@local/demo': 'link:demo' }, dsh: { profile: { bundles: ['@local/demo'] } } }, null, 2))
writeFileSync(join(profile, 'cordis.patch.yml'), `- id: demo\n  disabled: false\n`)
writeFileSync(join(home, 'storages', 'demo', 'state.json'), '{"value":1}\n')
writeFileSync(join(home, 'dsh-pet', 'pet.json'), '{"name":"fish"}\n')
const paths = createPaths(home, { ...process.env, DSH_HOME: home, DSH_PROFILE_DIR: profile })
const created = createSnapshot({ paths, installation: { version: '0.2.1-rc.5' }, keep: 3, reason: 'test' })
equal('snapshot profile files', created.manifest.profileFiles.includes('package.json'), true)
equal('snapshot storages', created.manifest.storages, true)
equal('snapshot data dirs', created.manifest.data.includes('dsh-pet'), true)
equal('snapshot bundle list', created.manifest.bundles[0], '@local/demo')
equal('snapshot list length', snapshotList(paths).length, 1)
equal('disabled rows parsed', readDisabledRows(profile).length, 1)

// Simulate settings drift after the update, then restore.
writeFileSync(join(profile, 'cordis.patch.yml'), `- id: demo\n  disabled: true\n`)
writeFileSync(join(home, 'storages', 'demo', 'state.json'), '{"value":2}\n')
const restored = restoreSnapshot({ paths, snapshotDir: created.directory, policy: 'overwrite', restoreSettings: true })
equal('restore reported files', restored.files.length >= 2, true)
check('settings restored', readFileSync(join(home, 'storages', 'demo', 'state.json'), 'utf8').includes('"value":1'))
check('patch restored', readFileSync(join(profile, 'cordis.patch.yml'), 'utf8').includes('disabled: false'))
check('pre-restore backup exists', restored.backup.length > 0)
rmSync(scratch, { recursive: true, force: true })

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
