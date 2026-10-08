/**
 * dsh-skill-mimo —— 把「小米 MiMo」（MiMo Desktop / MiMoCode）里的全部 skill
 * 读进 DeepSeek Harness 的会话技能目录。
 *
 * 做法：在 DSH 的技能注册表（`ctx.skills`）上再挂一个 provider，
 * 每次目录列举时现场扫描 MiMo 的全部 skill 来源，解析 SKILL.md 的
 * frontmatter，产出 DSH 认识的候选项；模型用 `skill` 工具加载时再读正文。
 *
 * 于是模型在会话开头拿到的 `<available_skills>` 目录里就会出现 MiMo 的
 * 每一个 skill（名字 + 描述），自然语言提到对应场景即可触发加载。
 */

import fs from 'node:fs'
import path from 'node:path'

import { readSkillBody, resolveEngineSkillsDir, scanSkillRoot } from './catalog.js'
import { collectSkillRoots, readPluginConfig, resolveDshHome } from './roots.js'

/** Cordis 插件身份。 */
export const name = 'skill-mimo'
/** 依赖的技能注册表服务。 */
export const inject = ['skills']
/** 注册到 `ctx.skills` 的 provider 名。 */
export const PROVIDER_NAME = 'mimo'

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文。
 * @param {Record<string, any>} [config] - 加载器传入的配置（可选）。
 */
export function apply(ctx, config = {}) {
  const log = ctx.logger ?? console
  const info = typeof log.info === 'function' ? message => log.info(message) : () => {}
  const warn = typeof log.warn === 'function' ? message => log.warn(message) : () => {}

  // 可选的外部配置：<DSH_HOME>/skill-mimo.json，便于不改代码调整范围。
  const extraConfig = readPluginConfig(resolveDshHome())
  const settings = { ...extraConfig, ...(config ?? {}) }

  // 自证：插件真的被 apply 过，会在缓存目录留一份心跳，排查时先看它。
  const diagnosticDir = path.join(resolveDshHome(), 'cache', 'dsh-skill-mimo')
  const writeDiagnostic = (file, payload) => {
    try {
      fs.mkdirSync(diagnosticDir, { recursive: true })
      fs.writeFileSync(path.join(diagnosticDir, file), JSON.stringify(payload, undefined, 2))
    } catch {
      // 诊断写不出去不影响功能
    }
  }
  writeDiagnostic('mounted.json', {
    at: new Date().toISOString(),
    plugin: name,
    provider: PROVIDER_NAME,
    pid: process.pid,
    cwd: process.cwd(),
    settings,
  })

  ctx.skills.registerProvider((control) => {
    /** @type {Map<string, import('node:fs').FSWatcher>} */
    const watchers = new Map()
    /** @type {string | undefined} */
    let cacheDir
    /** @type {string | undefined} */
    let lastEngineDir
    let announced = false
    let lastWrittenNames

    const closeWatchers = () => {
      for (const watcher of watchers.values()) {
        try {
          watcher.close()
        } catch {
          // 关闭失败无所谓
        }
      }
      watchers.clear()
    }

    if (control?.signal !== undefined && typeof control.signal.addEventListener === 'function') {
      control.signal.addEventListener('abort', closeWatchers, { once: true })
    }
    const invalidate = typeof control?.invalidate === 'function' ? control.invalidate : () => {}

    /**
     * 跟随根目录集合调整 watcher；文件变动即让 DSH 的技能缓存失效。
     * @param {Iterable<string>} dirs - 当前存在的根目录。
     */
    const syncWatchers = (dirs) => {
      if (settings.watch === false) return
      const wanted = new Set(dirs)
      for (const [dir, watcher] of watchers) {
        if (wanted.has(dir)) continue
        try {
          watcher.close()
        } catch {
          // 忽略
        }
        watchers.delete(dir)
      }
      for (const dir of wanted) {
        if (watchers.has(dir)) continue
        try {
          const watcher = fs.watch(dir, () => invalidate())
          watcher.on('error', () => {
            try {
              watcher.close()
            } catch {
              // 忽略
            }
            watchers.delete(dir)
          })
          watchers.set(dir, watcher)
        } catch {
          // 这个平台/目录不支持 watch，忽略即可
        }
      }
    }

    /**
     * 解析本次列举要用的根目录列表（含 app.asar 回退）。
     * @param {string | undefined} cwd - 会话工作目录。
     */
    const resolveRoots = (cwd) => {
      const snapshot = collectSkillRoots({ cwd, config: settings })
      cacheDir = path.join(snapshot.dshHome, 'cache', 'dsh-skill-mimo')

      let engineDir
      if (settings.includeEngineSkills !== false) {
        engineDir = resolveEngineSkillsDir({
          engineSkillsDir: snapshot.engineSkillsDir,
          mimoAppDir: snapshot.mimoAppDir,
          cacheDir,
          info,
          warn,
        })
        lastEngineDir = engineDir
      }

      /** @type {Array<{ id: string, label: string, dir: string, rank: number, source: string, depth?: number }>} */
      const roots = []
      for (const root of snapshot.roots) {
        if (root.id === 'engine-config') {
          if (engineDir === undefined) continue
          roots.push({ ...root, dir: engineDir })
          continue
        }
        roots.push(root)
      }
      // 项目级按 MiMo 的约定允许嵌套（.mimocode/{skill,skills}/**）
      for (const root of roots) {
        if (root.id.startsWith('project-')) root.depth = 3
      }
      return { roots, snapshot }
    }

    const provider = {
      name: PROVIDER_NAME,

      /**
       * 列举 MiMo 的全部 skill。
       * @param {{ cwd?: string, signal?: AbortSignal }} options - 查询选项。
       */
      list(options = {}) {
        try {
          const { roots } = resolveRoots(options.cwd)
          /** @type {object[]} */
          const candidates = []
          const existingDirs = []
          const skipped = []

          for (const root of roots) {
            let exists = false
            try {
              exists = fs.statSync(root.dir).isDirectory()
            } catch {
              exists = false
            }
            if (!exists) continue
            existingDirs.push(root.dir)
            const scanned = scanSkillRoot({ root, warn: message => skipped.push(message) })
            for (const candidate of scanned.candidates) {
              if (candidates.some(existing => existing.name === candidate.name)) continue
              candidates.push({ ...candidate, provider: PROVIDER_NAME })
            }
          }

          syncWatchers(existingDirs)

          const names = candidates.map(candidate => candidate.name).sort()
          if (!announced) {
            announced = true
            info(
              `dsh-skill-mimo：从 ${existingDirs.length} 个 MiMo skill 根读到 ${names.length} 个 skill`
              + `${lastEngineDir === undefined ? '' : `（引擎内置：${lastEngineDir}）`}`
              + `${names.length === 0 ? '' : `：${names.join(', ')}`}`,
            )
            if (skipped.length > 0) warn(`dsh-skill-mimo：跳过 ${skipped.length} 项，例如 ${skipped[0]}`)
          }

          if (typeof options.signal?.throwIfAborted === 'function') options.signal.throwIfAborted()

          // 一个根都不存在通常意味着 MiMo 没装或配置指错：报「不完整」，
          // 让 DSH 保留上一份好目录，而不是把旧名字注销掉。
          const complete = existingDirs.length > 0
          const fingerprint = `${complete}|${names.join(',')}|${existingDirs.join(',')}`
          if (fingerprint !== lastWrittenNames) {
            lastWrittenNames = fingerprint
            writeDiagnostic('last-list.json', {
              at: new Date().toISOString(),
              complete,
              roots: existingDirs,
              names,
              skipped: skipped.slice(0, 20),
            })
          }
          return { candidates, complete }
        } catch (error) {
          // 宁可少给，不可拖垮整个技能目录：出错时报「不完整」并留证据。
          writeDiagnostic('last-error.json', {
            at: new Date().toISOString(),
            message: error instanceof Error ? (error.stack ?? error.message) : String(error),
          })
          warn(`dsh-skill-mimo：列举失败：${error instanceof Error ? error.message : String(error)}`)
          return { candidates: [], complete: false }
        }
      },

      /**
       * 加载一个 skill 的正文。
       * @param {object} candidate - list 产出的候选项。
       */
      get(candidate) {
        const { rank: _rank, locator, ...summary } = candidate
        const body = readSkillBody(locator)
        if (body === undefined) return Promise.resolve(undefined)
        return Promise.resolve({ ...summary, content: body })
      },
    }

    return provider
  })

  info('dsh-skill-mimo：已注册 MiMo 技能 provider')
}
