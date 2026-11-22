import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const WPS_BUNDLE_ID = 'com.kingsoft.wpsoffice.mac'
const CONFIRM_BUTTON = '关闭并重开 WPS'
const LATER_BUTTON = '稍后再说'
const QUIT_WAIT_ROUNDS = 150
const QUIT_POLL_MS = 2000

export const RESTART_TITLE = 'WPS 办公助手已更新'
export const RESTART_REASON = [
  'WPS 办公助手已更新，但 WPS 还在运行更新前的旧版本。',
  'WPS 只在启动时加载一次办公助手，必须完全退出再打开，新版本才会生效；在此之前 AI 无法读取或修改 Word、Excel 和演示文档。',
  `点击「${CONFIRM_BUTTON}」后，WPS 会先询问是否保存未保存的文档，然后自动重新打开。`,
].join('\n\n')

function appleString(value) { return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` }

async function runAppleScript(lines, timeout) {
  const { stdout } = await exec('/usr/bin/osascript', lines.flatMap(line => ['-e', line]), { timeout, maxBuffer: 64 * 1024 })
  return stdout
}

export function restartDialogScript(giveUpSeconds = 600) {
  return `display dialog ${appleString(RESTART_REASON)} with title ${appleString(RESTART_TITLE)} `
    + `buttons {${appleString(LATER_BUTTON)}, ${appleString(CONFIRM_BUTTON)}} default button 2 with icon note giving up after ${giveUpSeconds}`
}

// Asks before touching WPS: quitting goes through WPS itself, so unsaved documents still get its save prompt.
export async function promptWpsRestart(options = {}) {
  const run = options.run ?? runAppleScript
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const reopen = options.reopen ?? (() => exec('/usr/bin/open', ['-b', WPS_BUNDLE_ID], { timeout: 10_000 }))
  let answer
  try { answer = await run([restartDialogScript()], 620_000) }
  catch { return 'dismissed' }
  if (!answer.includes(`button returned:${CONFIRM_BUTTON}`)) return 'later'
  try { await run([`tell application id "${WPS_BUNDLE_ID}" to quit`], 30_000) }
  catch { return 'quit_refused' }
  for (let round = 0; round < QUIT_WAIT_ROUNDS; round += 1) {
    const running = (await run([`application id "${WPS_BUNDLE_ID}" is running`], 5000)).trim() === 'true'
    if (!running) { await reopen(); return 'restarted' }
    await wait(QUIT_POLL_MS)
  }
  return 'still_running'
}
