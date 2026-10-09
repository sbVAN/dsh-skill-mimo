# dsh-skill-mimo

一个 DSH 插件，把小米 MiMo（MiMo Desktop / MiMoCode）里的 skill 读进 DSH 的技能目录。

## 安装

```powershell
dsh plugin add github:sbVAN/dsh-skill-mimo
```

本地开发用 `dsh plugin add "file:$PWD"`，链进 profile，改完重载生效。收录进插件市场之后也可以直接在市场里搜。

HMR 开着时改配置立即生效；换包版本要重启 DSH，模块监听默认跳过 `node_modules`。

## 扫哪些目录

- `~/.config/mimocode/skills/`：MiMoCode 全局
- `<项目>/.mimocode/skills/`、`<项目>/.mimocode/skill/`：项目级，最多往下三层
- `engine-config/skills/`：引擎内置的
- `extensions.json` 里各个扩展的 `placements.skillDirs`
- `~/.agents`、`~/.claude`、`~/.codex`、`~/.opencode` 下的 `skills/`，只扫 MiMo 在 `preferences.json` 里 `skillPathCompat` 打开的那几个，默认只有 agents

引擎内置那批通常由 MiMo 自己同步到 `engine-config/skills`。这个目录空了的时候，插件会从 `<MiMo 安装目录>/resources/app.asar` 解 `/electron/lib/engine/skills` 到 `<DSH_HOME>/cache/dsh-skill-mimo/`。skill 里写的 `references/xxx.md` 这种相对路径必须落在真实磁盘上，模型才读得到。

## 监听

每个根递归监听，改 `SKILL.md` 的正文或 frontmatter、增删 skill 目录，一秒内重新注册，事件做了 120ms 合并。根目录本身还不存在的（项目第一次建 `.mimocode/skills`）挂不上监听，靠 3 秒轮询补。

Linux 的 `fs.watch` 不支持递归，只有根的直接增删能察觉，改子目录得重启。Windows 和 macOS 没这问题。

## 测试

```powershell
node test/smoke.mjs
```

不依赖 DSH，会挂载插件、列出注册到的 skill、检查字段。装好之后开个新会话问一句「你有哪些 skill 可用」也行。

插件只写自己缓存目录里的三个文件，MiMo 那边一个字节不碰：`mounted.json`（apply 跑过没有）、`last-list.json`（这次注册了什么）、`last-error.json`（出错才有）。

## 配置

`~/.dsh/skill-mimo.json`：

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

`watch: false` 关掉监听，`extraSkillDirs` 加额外目录。

## 卸载

`plugin_manager` 里移除这个 bundle，或者删掉 `cordis.patch.yml` 里的 `skill-mimo` 行再卸依赖。

## 限制

- 只读，不碰 MiMo 的文件，唯一写的是 DSH 自己的缓存目录
- `<name>/SKILL.md` 一层目录包和扁平 `<name>.md` 都认
- 名字要 kebab-case，描述不能为空，不合格的跳过
- 正文注册时读入，改了等 watcher 刷新
