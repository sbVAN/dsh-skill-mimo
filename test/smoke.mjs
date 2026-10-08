/**
 * 冒烟测试：不依赖 DSH 运行时，直接挂载插件并列举 MiMo 的 skill。
 *
 *   node test/smoke.mjs [cwd]
 */

import { apply, PROVIDER_NAME } from '../lib/index.js'

const cwd = process.argv[2] ?? process.cwd()

let provider
const ctx = {
  logger: {
    info: message => console.log(`[info] ${message}`),
    warn: message => console.warn(`[warn] ${message}`),
  },
  skills: {
    registerProvider(create) {
      provider = create({ signal: new AbortController().signal, invalidate: () => {} })
      return () => {}
    },
  },
}

apply(ctx, {})

if (provider === undefined) {
  console.error('插件没有注册 provider')
  process.exit(1)
}
if (provider.name !== PROVIDER_NAME) {
  console.error(`provider 名不对：${provider.name}`)
  process.exit(1)
}

const observation = await provider.list({ cwd })
const candidates = Array.isArray(observation) ? observation : observation.candidates
const complete = Array.isArray(observation) ? true : observation.complete

console.log(`\nprovider=${provider.name} complete=${complete} 共 ${candidates.length} 个 skill\n`)
for (const candidate of [...candidates].sort((a, b) => a.name.localeCompare(b.name))) {
  const description = candidate.description.replace(/\s+/gu, ' ').slice(0, 72)
  console.log(
    `- ${candidate.name.padEnd(30)} rank=${String(candidate.rank).padEnd(4)} source=${candidate.source.padEnd(14)} ${description}`,
  )
}

// 校验 DSH 注册表的硬约束
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
for (const candidate of candidates) {
  if (!SKILL_NAME.test(candidate.name)) throw new Error(`非法名字：${candidate.name}`)
  if (typeof candidate.description !== 'string' || candidate.description === '') {
    throw new Error(`缺少描述：${candidate.name}`)
  }
  if (candidate.provider !== PROVIDER_NAME) throw new Error(`provider 字段不对：${candidate.name}`)
  if (typeof candidate.rank !== 'number' || !Number.isFinite(candidate.rank)) {
    throw new Error(`rank 不对：${candidate.name}`)
  }
  if (typeof candidate.invocation?.modelInvocable !== 'boolean') {
    throw new Error(`invocation 不对：${candidate.name}`)
  }
}

// 抽一个读正文，确认 get() 通路可用
const sample = candidates.find(candidate => candidate.name === 'visualizer') ?? candidates[0]
if (sample !== undefined) {
  const definition = await provider.get(sample)
  if (definition === undefined) throw new Error(`get() 读不到正文：${sample.name}`)
  if (typeof definition.content !== 'string' || definition.content.length === 0) {
    throw new Error(`正文为空：${sample.name}`)
  }
  console.log(`\nget("${sample.name}") -> ${definition.content.length} 字符正文，base=${definition.resourceBase?.path}`)
}

const names = new Set(candidates.map(candidate => candidate.name))
const expected = [
  '3d-creation',
  'figma',
  'imagegen',
  'lieflat-less-ai-tone',
  'mimo-desktop-guide',
  'mimo-skill-authoring',
  'session-chat',
  'threejs-game-skills',
  'visualizer',
  'websearch',
  'windows-powershell-reference',
]
const missing = expected.filter(name => !names.has(name))
console.log(`\nMiMo 引擎内置 11 个 skill 命中 ${expected.length - missing.length}/${expected.length}`)
if (missing.length > 0) console.log(`缺失：${missing.join(', ')}`)

// fs.watch 的句柄会吊住事件循环，测完直接退。
process.exit(missing.length > 0 ? 1 : 0)
