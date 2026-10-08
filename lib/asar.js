/**
 * 最小 asar 归档读取器（零依赖）。
 *
 * MiMo Desktop 把 11 个内置 skill 打进 `resources/app.asar` 的
 * `/electron/lib/engine/skills/` 下。正常情况下 MiMo 会把它们解包到
 * `<userData>/engine-config/skills/`，插件优先读那里；只有当那份解包
 * 不存在时，才回退到直接读 asar，并把它解到 DSH 的缓存目录，
 * 这样模型读 references/scripts 时面对的是真实磁盘路径。
 *
 * asar 布局：8 字节头 + 4 字节 pickle 长度 + header JSON，
 * 文件内容紧跟其后，用 header 里的 offset 定位。
 */

import fs from 'node:fs'
import path from 'node:path'

const HEADER_OFFSET = 16

/**
 * 打开 asar，返回文件索引与数据区起点。调用方负责 fclose。
 * @param {string} asarPath - .asar 文件路径。
 * @returns {{ fd: number, dataOffset: number, files: Array<{path: string, size: number, offset: number}> }}
 */
export function openAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const sizeBuffer = Buffer.alloc(16)
    fs.readSync(fd, sizeBuffer, 0, 16, 0)
    const headerSize = sizeBuffer.readUInt32LE(12)
    const headerBuffer = Buffer.alloc(headerSize)
    fs.readSync(fd, headerBuffer, 0, headerSize, HEADER_OFFSET)
    const header = JSON.parse(headerBuffer.toString('utf8').replace(/\0+$/u, ''))
    const files = []
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const internal = `${prefix}/${name}`
        if (entry.files) walk(entry, internal)
        else files.push({ path: internal, size: entry.size ?? 0, offset: entry.offset ?? 0 })
      }
    }
    walk(header, '')
    return { fd, dataOffset: HEADER_OFFSET + headerSize, files }
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}

/**
 * 精确读取 asar 内一个文件。
 * @param {string} asarPath - .asar 文件路径。
 * @param {string} internalPath - 归档内路径，例如 `/electron/lib/engine/skills/figma/SKILL.md`。
 * @returns {string} UTF-8 文本。
 */
export function readAsarText(asarPath, internalPath) {
  const { fd, dataOffset, files } = openAsar(asarPath)
  try {
    const entry = files.find(file => file.path === internalPath)
    if (entry === undefined) throw new Error(`asar entry not found: ${internalPath}`)
    const buffer = Buffer.alloc(entry.size)
    if (entry.size > 0) fs.readSync(fd, buffer, 0, entry.size, dataOffset + entry.offset)
    return buffer.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 把 asar 中某个前缀下的全部文件解包到磁盘。
 * @param {string} asarPath - .asar 文件路径。
 * @param {string} prefix - 归档内前缀，例如 `/electron/lib/engine/skills`。
 * @param {string} outDir - 目标目录。
 * @returns {number} 写出的文件数。
 */
export function extractAsarPrefix(asarPath, prefix, outDir) {
  const { fd, dataOffset, files } = openAsar(asarPath)
  let written = 0
  try {
    const normalized = prefix.replace(/\/$/u, '')
    for (const entry of files) {
      if (!entry.path.startsWith(`${normalized}/`)) continue
      const relative = entry.path.slice(normalized.length + 1)
      if (relative === '' || relative.includes('..')) continue
      const target = path.join(outDir, ...relative.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const buffer = Buffer.alloc(entry.size)
      if (entry.size > 0) fs.readSync(fd, buffer, 0, entry.size, dataOffset + entry.offset)
      fs.writeFileSync(target, buffer)
      written += 1
    }
  } finally {
    fs.closeSync(fd)
  }
  return written
}

/**
 * 列出 asar 中某个前缀下的全部条目路径。
 * @param {string} asarPath - .asar 文件路径。
 * @param {string} prefix - 归档内前缀。
 * @returns {string[]} 归档内路径。
 */
export function listAsarPrefix(asarPath, prefix) {
  const { fd, files } = openAsar(asarPath)
  try {
    const normalized = prefix.replace(/\/$/u, '')
    return files.filter(entry => entry.path.startsWith(`${normalized}/`)).map(entry => entry.path)
  } finally {
    fs.closeSync(fd)
  }
}
