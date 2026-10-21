#!/usr/bin/env node
/**
 * Install this plugin into a DSH profile.
 *
 * DSH Desktop ships a `dsh` shim (Electron-as-Node) that is allowed to manage
 * the `desktop` profile; the npm-published CLI refuses that profile name. This
 * helper finds the newest shim generation and runs:
 *
 *   dsh plugin --profile <profile> add link:<this-package>
 *
 * Usage:
 *   node scripts/install.mjs                     # desktop profile
 *   node scripts/install.mjs --profile synctest
 *   node scripts/install.mjs --print             # only print the command
 *
 * The profile package.json records the link dependency and appends the bundle
 * (this package declares dsh.bundle.patch), so the plugin row is enabled on
 * the next DSH start.
 *
 * @module dsh-plugin-github-sync/scripts/install
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write('用法：node scripts/install.mjs [--profile desktop] [--print]\n')
  process.exit(0)
}
const printOnly = argv.includes('--print')
const profileIndex = argv.indexOf('--profile')
const profile = profileIndex === -1 ? 'desktop' : (argv[profileIndex + 1] ?? 'desktop')

/**
 * Find the newest DSH Desktop `dsh` shim generation.
 *
 * @returns {string | null} absolute shim path.
 */
function findDesktopShim() {
  const appData = process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming')
  const root = path.join(appData, 'DSH Desktop', 'host-commands', 'desktop', 'generations')
  if (!existsSync(root)) return null
  const candidates = readdirSync(root)
    .map((name) => path.join(root, name, 'bin', 'dsh.cmd'))
    .filter((file) => existsSync(file))
    .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return candidates[0]?.file ?? null
}

const shim = findDesktopShim()
if (shim === null && profile === 'desktop') {
  process.stderr.write(
    '未找到 DSH Desktop 的 dsh 垫片。请改用桌面「插件」页安装本地路径，或手动执行：\n'
    + `  dsh plugin --profile ${profile} add link:${packageRoot}\n`
    + '（npm 版 dsh 不允许管理 desktop profile；desktop profile 只能在 Desktop 的 dsh 或界面里安装。）\n',
  )
  process.exit(2)
}

const executable = shim ?? 'dsh'
const args = ['plugin', '--profile', profile, 'add', `link:${packageRoot}`]
if (printOnly) {
  process.stdout.write(`${executable} ${args.join(' ')}\n`)
  process.exit(0)
}
process.stdout.write(`安装到 profile "${profile}"：\n  ${executable} ${args.join(' ')}\n`)
try {
  execFileSync(executable, ['--version'], { stdio: 'inherit' })
} catch {
  // version probe is best-effort; the install command below reports real errors
}
const result = spawnSync(executable, args, { stdio: 'inherit' })
if (result.status !== 0) {
  process.stderr.write('安装失败。可在 DSH Desktop 的「插件」页面安装本地路径，或检查 profile 写锁。\n')
  process.exit(result.status ?? 1)
}
process.stdout.write([
  '',
  '安装完成。请完全退出并重启 DSH Desktop；然后在对话里执行：',
  '  /sync init https://github.com/<你>/dsh-sync.git',
  '或先编辑 %USERPROFILE%\\.dsh\\github-sync.json 后再执行 /sync sync。',
  '',
].join('\n'))
