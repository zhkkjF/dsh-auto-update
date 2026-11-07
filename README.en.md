# dsh-auto-update

An auto-update plugin for **DSH Desktop**. It checks the desktop application's official update feed, verifies and installs a new version, and after the restart reinstalls the profile's plugins with the settings they had before the update.

## What it does

- **Checks** the feed named by the installation's `app-update.yml` (`nightly` or `latest`) and compares the advertised version with the packaged one.
- **Snapshots** the profile before updating: `package.json`, `cordis.patch.yml` (plugin settings), `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `compatibility.json`, `.npmrc`, `$DSH_HOME/storages`, and plugin data directories such as `dsh-pet`, `dsh-market` and `skills-manager`.
- **Downloads** the installer and checks its SHA-512 against the feed.
- **Installs** it silently with the same arguments as the desktop updater (`--updated /S --force-run`), through a one-shot Windows Task Scheduler job that terminates the running application first. electron-builder's NSIS installer refuses to run while the application it replaces is running (exit code 2, [electron-builder#8026](https://github.com/electron-userland/electron-builder/issues/8026)), and a Host plugin cannot quit the Electron main process itself, so the scheduled job performs the close-then-install handoff.
- **Recovers after the update**: on the next launch, restores the snapshot (the current state is backed up first), reinstalls the profile's plugins from the restored manifest and lockfile with the desktop's own pnpm entry, and reconciles bundle enablement. The result is written to `$DSH_HOME/dsh-auto-update/recovery.json`.

## Settings

Settings → **Auto Update** (a `settings.section` page):

- automatic installation on/off;
- wait for running agent turns and background jobs to finish before installing;
- check interval;
- check now / download and install;
- snapshot now;
- reinstall plugins from the latest snapshot;
- restore settings from the latest snapshot.

Defaults and state live under `$DSH_HOME/dsh-auto-update/` (`settings.json`, `state.json`, `snapshots/`, `downloads/`, `log.jsonl`, `recovery.json`). The page writes preferences to `settings.json`, which takes precedence over the defaults in the profile patch.

## Configuration (profile patch)

```yaml
- id: dsh-auto-update
  name: dsh-auto-update
  config:
    checkIntervalMinutes: 30
    autoInstall: true
    autoInstallWhenIdle: true
    snapshotKeep: 5
    restoreSettings: true
    restorePolicy: overwrite
    dataDirs: [dsh-pet, dsh-market, skills-manager]
```

`restorePolicy: missing-only` restores only absent files instead of replacing the current settings.

## Requirements

- DSH Desktop (packaged, with `app-update.yml` and `app.asar`). In a plain `dsh web` profile the settings page reports that it is desktop-only.
- Windows for the automatic installation handoff (the plugin uses `taskkill` and `schtasks`). Checking, snapshots and restoration remain available elsewhere.

## Safety notes

- Installation closes DSH and reopens it; in-progress turns are interrupted. With “wait for running tasks” enabled, installation is deferred while an agent turn or background job is running.
- Only the feed named by the installation is used, and only a SHA-512 matching installer is executed.
- A restore always backs up the current state under the snapshot's `pre-restore-<timestamp>/` directory.
- Listing in a plugin catalog does not imply an audit of this code; review it before installing.

## License

MIT
