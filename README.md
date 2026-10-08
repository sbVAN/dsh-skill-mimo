# dsh-skill-mimo

把**小米 MiMo（MiMo Desktop / MiMoCode）里的全部 skill**读进 DeepSeek Harness 的会话技能目录。

装上之后，MiMo 那边有的 skill，DSH 这边在会话开头就会拿到一份
`<available_skills>` 目录（名字 + 描述）；你在对话里用自然语言提到对应场景
（例如「帮我做个 PPT」「画一张海报」「调研一下这个库」「写个 three.js 小游戏」），
模型就能按描述命中并调用 `skill` 工具加载它的完整说明。

这是一个纯 host 插件：在 `ctx.skills` 上再注册一个 provider（`mimo`），
不碰 DSH 原有的 `filesystem` provider。

## 读哪些来源

按 MiMo 自己的约定，一个 skill 可能躺在这些地方，插件全部会扫：

| 顺序 | 来源 | 路径 | 注册表里的 source |
|---|---|---|---|
| 1 | 项目 skill | `<项目根>/.mimocode/skills/<id>/SKILL.md`、`<项目根>/.mimocode/skill/…` | `project-agents` |
| 2 | 扩展（插件）贡献目录 | `<MiMo 用户数据>/extensions.json` 里每个扩展的 `placements.skillDirs` | `custom` |
| 3 | 引擎内置 skill | `<MiMo 用户数据>/engine-config/skills/<id>/SKILL.md` | `bundled` |
| 4 | 全局 MiMoCode skill | `~/.config/mimocode/skills/<id>/SKILL.md` | `custom` |
| 5 | 品牌兼容根 | `~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills`、`~/.opencode/skills` | `user-agents` |

第 5 组受 MiMo 设置 `preferences.json → skillPathCompat` 控制（MiMo 默认只开 `agents`），
插件默认尊重这个开关，避免把 MiMo 自己都不认的目录塞进来。

如果 `engine-config/skills` 不存在（例如刚装好还没同步），插件会直接读
`<MiMo 安装目录>/resources/app.asar` 里的 `/electron/lib/engine/skills`，
把它解包到 `<DSH_HOME>/cache/dsh-skill-mimo/engine-skills/`，
这样 skill 里引用的 `references/`、`scripts/` 对模型来说仍是真实磁盘路径。

## 安装

本插件在 [dsh-market](https://github.com/dsh-market/dsh-market) 收录后，可以直接在市场里搜索安装。
也支持以下方式：

```powershell
# 从 GitHub 仓库安装（推荐）
dsh plugin add github:sbVAN/dsh-skill-mimo

# 发布到 npm 之后
dsh plugin add dsh-skill-mimo

# 本地开发：把当前目录链进 profile（改动即时生效）
dsh plugin add "file:$PWD"
```

装完在 profile 的 `cordis.patch.yml` 里应能看到由插件自带补丁插入的行：

```yaml
- insert:
    - id: skill-mimo
      name: dsh-skill-mimo
```

HMR 打开时配置改动即时生效；**替换已安装的包版本仍需重启 DSH**（HMR 的模块监听默认忽略
`node_modules`）。

## 校验

不依赖 DSH 的本地自测：

```powershell
node test/smoke.mjs
```

它会挂载插件，打印注册到的全部 skill，并检查名字法、描述、正文非空、
`provider`/`invocation`/`resourceBase` 这些注册表的硬约束。

在 DSH 里校验：
- 插件是否真的挂上：看 `<DSH_HOME>/cache/dsh-skill-mimo/mounted.json`
- 注册结果：看同目录的 `last-list.json`（名字列表、命中的根、失败项）
- 出错时：看 `last-error.json`
- 模型侧：**开一个新会话**（技能目录在会话首步注入），问一句「你有哪些 skill 可用」，
  或者直接提一个命中描述的需求

### 诊断文件

插件从不写 MiMo 的任何文件，只会在自己的缓存目录留下一份自检记录：

| 文件 | 内容 |
|---|---|
| `mounted.json` | `apply()` 跑过的心跳：时间、pid、生效配置 |
| `last-list.json` | 最近一次注册：根目录、注册成功的 skill 名、失败项 |
| `last-error.json` | 注册抛错时的堆栈（只在出错时出现） |

## 可选配置

不改代码也能调：写 `<DSH_HOME>/skill-mimo.json`（默认 `~/.dsh/skill-mimo.json`）。

```json
{
  "includeEngineSkills": true,
  "includeUserSkills": true,
  "includeProjectSkills": true,
  "includeBrandRoots": true,
  "includeExtensions": true,
  "ignoreSkillPathCompatibility": false,
  "extraSkillDirs": [],
  "mimoDataDir": "C:\\Users\\你\\AppData\\Roaming\\Xiaomi MiMo",
  "mimoAppDir": "Z:\\MimoPlatform\\Xiaomi MiMo",
  "watch": true
}
```

`watch: false` 可以关掉目录监听。同名 skill 撞车时，DSH 在同一层内按 rank 取优先者 ——
本插件用 runtime 注册（rank 250），会盖过 `filesystem` provider（用户根 500、内置 600）
的同类条目，同时把 DSH 原本没有的补齐。

## 卸载

`plugin_manager` 里移除该 bundle，或删掉 profile 的 `cordis.patch.yml` 里的
`skill-mimo` 行并卸载依赖。

## 实现要点

- **注册走 runtime 表（`ctx.skills.register`），不走 provider**。`registerProvider`
  内部的 effect 绑定在「服务实例自己的 ctx」上，插件 fiber 重建（disable/enable、
  profile 重载）不会清掉它：之后每次注册都会撞同名而静默失败，表里永远留着第一份
  旧 provider。runtime 表没有这个问题。
- **注册表用 `ctx.get('skills')` 取**。在 host 层 + agent preset standing composition
  这类部署里，它和注入的 `ctx.skills` 未必是同一个对象；注册到错的那一份时，技能面板
  与快照里都能看见这些 skill，可模型的 `skill` 工具偏偏报 unknown。

## 已知边界

- 只读：不会改动 MiMo 的任何文件（只有 asar 回退解包会写 DSH 自己的缓存目录）。
- 一层目录包 + 扁平 `<name>.md` 都认；项目根允许嵌套 3 层。
- 名字必须是 kebab-case、描述必须非空，否则跳过并在日志里说明原因。
- 正文在注册时读入，因此改 `SKILL.md` 需要等 watcher 触发一次刷新才生效；
  增删 skill 同样由 watcher 触发重新注册（约 1 秒内）。
- runtime 注册的条目固定在 rank 250，不再随配置调整。

