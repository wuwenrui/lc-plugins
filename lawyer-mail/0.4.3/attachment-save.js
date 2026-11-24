import { writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Atomic allocation: existing files and symlinks belong to somebody else. */
export async function saveAttachmentExclusive(dir, safeName, bytes, write = writeFile) {
  const extension = path.extname(safeName)
  const stem = safeName.slice(0, safeName.length - extension.length)
  for (let index = 1; index <= 100; index += 1) {
    const name = index === 1 ? safeName : `${stem} (${index})${extension}`
    const target = path.join(dir, name)
    try {
      await write(target, bytes, { flag: 'wx', mode: 0o600 })
      return target
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw new Error('同名文件过多，未覆盖任何已有文件；请选择其他目录')
}
