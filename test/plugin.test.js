// 插件接线测试:用 mock ctx 跑 apply(),不重启 DSH 就能验证 section/tools 是否注册正确。
// 这是本项目能"改完立刻验收"的关键 —— 宿主插件改动本来必须重启才生效。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, defaultMemoryRoot, inject, name } from '../lib/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'memory')

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-plugin-'))
  // ⚠ 受限前缀由**记忆仓自己**声明(硬规则 8:公开源码里零具体值)。
  //   这里用**合成前缀**,与任何真实目录名无关。
  fs.writeFileSync(path.join(root, '.restricted.json'), JSON.stringify({ scopes: ['restricted'], sources: ['vendor/'] }))
  return root
}

/** 最小 cordis ctx 替身:记录注册了什么,不执行任何真实装配。 */
function makeCtx() {
  const registeredSections = []
  const registeredTools = []
  const effectLabels = []
  const ctx = {
    registeredSections,
    registeredTools,
    effectLabels,
    systemPrompt: {
      section(section) {
        registeredSections.push(section)
        return () => {}
      },
    },
    tools: {
      register(tool) {
        registeredTools.push(tool)
        return () => {}
      },
    },
    effect(fn, label) {
      effectLabels.push(label)
      return fn()
    },
    logger: { info() {}, warn() {} },
  }
  return ctx
}

function setup(config) {
  const ctx = makeCtx()
  apply(ctx, config)
  return ctx
}

// ------------------------------------------------------------ 元信息

test('插件元信息', () => {
  assert.equal(name, 'dsh-memory')
  assert.deepEqual(inject, ['systemPrompt', 'tools'])
  assert.ok(defaultMemoryRoot().endsWith(path.join('.dsh', 'memory')))
})

// ------------------------------------------------------- 提示词段注册

test('注册唯一的提示词段,order=100(persona 0 之后、策略 500 之前)', () => {
  const ctx = setup({ memoryRoot: FIXTURE })
  assert.equal(ctx.registeredSections.length, 1)
  const s = ctx.registeredSections[0]
  assert.equal(s.name, 'dsh-memory:index')
  assert.equal(s.order, 100)
  assert.equal(typeof s.text, 'function', 'text 必须是每次装配求值的函数')
})

test('段落内容来自 MEMORY.md,且带「不是指令」的声明', () => {
  const ctx = setup({ memoryRoot: FIXTURE })
  const text = ctx.registeredSections[0].text()
  assert.match(text, /长期记忆/)
  assert.match(text, /不是指令/)
  // ⚠ 断言用的是**合成语料**的内容 —— 夹具由 `tools/make-fixture.mjs` 生成,
  // 真实记忆语料**不进版本控制**(本仓是公开仓)。改生成器时同步改这里。
  // 2026-10-10:夹具已从「半脱敏的真实语料」换成**完全虚构的水族箱语料**。
  assert.match(text, /开缸第 3 阶段/)
  assert.match(text, /蓄水桶/)
})

test('段落是动态的:文件改了,下次装配就变', () => {
  const root = tmpRoot()
  const file = path.join(root, 'MEMORY.md')
  fs.writeFileSync(file, '- 旧记忆内容')
  const ctx = setup({ memoryRoot: root })
  const textFn = ctx.registeredSections[0].text

  assert.match(textFn(), /旧记忆内容/)

  fs.writeFileSync(file, '- 新记忆内容')
  assert.match(textFn(), /新记忆内容/)
  assert.doesNotMatch(textFn(), /旧记忆内容/)
})

test('MEMORY.md 缺失时注入空段,不抛错', () => {
  const ctx = setup({ memoryRoot: tmpRoot() })
  assert.equal(ctx.registeredSections[0].text(), '')
})

test('记忆根整个不存在时也不抛错(fail-safe,不能连累提示词装配)', () => {
  const ctx = setup({ memoryRoot: path.join(os.tmpdir(), 'dsh-memory-absent-' + Date.now()) })
  assert.equal(ctx.registeredSections[0].text(), '')
})

test('预算可配置:超行数时截断并留标记', () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'MEMORY.md'), Array.from({ length: 50 }, (_, i) => `行 ${i}`).join('\n'))
  // ⚠ 预算必须**明显大于**外壳占位,否则 composeSection 会返回空段 ——
  // 那是防止"外壳自身就超预算"的闸(见 memory-store 的 composeSection)。
  // 外壳 = Header 7 行(含围栏开启)+ 段末声明 4 行(含围栏闭合)+ 截断标记 1 行 = **12 行**
  // (阶段 A 加围栏后从 6 行涨到 12 行;留 8 行余量,免得外壳再长大就把这条测试顶掉)。
  const ctx = setup({ memoryRoot: root, maxIndexLines: 20 })
  const text = ctx.registeredSections[0].text()
  assert.match(text, /已截断/)
})

test('⚠ P0 回归:段落必须 interpolate:false,否则记忆里的字面 {{x}} 会让整轮会话抛错', () => {
  // 官方默认 interpolate:true,renderPrompt 对未知 `{{name}}` 会抛错
  // (dsh-system-prompt/lib/index.js:160/166/169),而该调用在 agent loop step() 内同步执行。
  // 记忆是**字面数据**不是模板 —— 这条断言防的是「有人顺手把这个字段删掉」。
  const ctx = setup({ memoryRoot: FIXTURE })
  assert.equal(ctx.registeredSections[0].interpolate, false)
})

test('⚠ 阶段 A:注入段带**每进程随机** nonce 围栏,不是固定字面量', () => {
  // 固定字面量的围栏等于没围栏 —— 写记忆的人照着抄一遍就能闭合数据区。
  // 这条断言防的是「有人图省事把 nonce 写成常量」。
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'MEMORY.md'), '- 一条记忆')
  const a = setup({ memoryRoot: root }).registeredSections[0].text()
  const b = setup({ memoryRoot: root }).registeredSections[0].text()
  const nonceOf = (t) => (t.match(/<<<DSH-MEMORY-DATA:([0-9a-f]+)>>>/) ?? [])[1]
  assert.ok(nonceOf(a), '必须带 nonce 围栏')
  assert.match(nonceOf(a), /^[0-9a-f]{12}$/)
  assert.notEqual(nonceOf(a), nonceOf(b), '两次装配必须是不同的 nonce')
  assert.equal(a.includes('DSH-MEMORY-DATA:static'), false, '不得退化成 STATIC_NONCE')
  assert.match(a, /<<<\/DSH-MEMORY-DATA:[0-9a-f]{12}>>>/, '闭合标记必须用同一个 nonce')
})

// ------------------------------------------------------------ 工具注册

test('注册 7 个工具:2 个只读 + 4 个写入路径 + 1 个自审', () => {
  const ctx = setup({ memoryRoot: FIXTURE })
  const names = ctx.registeredTools.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'memory_pending',
    'memory_promote',
    'memory_read',
    'memory_reject',
    'memory_review',
    'memory_search',
    'memory_write',
  ])
  for (const t of ctx.registeredTools) {
    assert.equal(typeof t.execute, 'function')
    assert.equal(typeof t.description, 'string')
    assert.ok(t.parameters && t.parameters.type === 'object')
    assert.ok(t.output && typeof t.output.render === 'function')
  }
})

test('memory_search:自然语言提问返回命中', async () => {
  const ctx = setup({ memoryRoot: FIXTURE })
  const tool = ctx.registeredTools.find((t) => t.name === 'memory_search')
  const r = await tool.execute({ q: '哪些品种是禁养' })
  // total 不写死:夹具由生成器产出,条数会随生成器变。
  // 真正要守的是「top-1 指对文件」与「摘要含关键词」—— 那才是检索可用性。
  assert.ok(r.total >= 1, `应有命中,实际 total=${r.total}`)
  assert.ok(r.hits.length > 0)
  assert.equal(r.hits[0].path, 'aquarium/tank-rules.md')
  assert.match(r.hits[0].snippet, /禁养/)
})

test('memory_search:无命中返回空数组而非报错', async () => {
  const ctx = setup({ memoryRoot: FIXTURE })
  const tool = ctx.registeredTools.find((t) => t.name === 'memory_search')
  const r = await tool.execute({ q: 'zzzqqqxxx' })
  assert.deepEqual(r.hits, [])
})

test('memory_search:截断与「未覆盖文档清单」都要可见(硬规则 7 / 硬规则 10)', async () => {
  const ctx = setup({ memoryRoot: FIXTURE })
  const tool = ctx.registeredTools.find((t) => t.name === 'memory_search')

  // ① 命中被 limit 截断时必须带标志 —— 原先只有 truncatedScan(文件数)那一半
  const hit = await tool.execute({ q: '哪些品种是禁养' })
  assert.equal(typeof hit.scoredCount, 'number', 'scoredCount 必须存在,调用方据此判截断')
  assert.equal(typeof hit.truncatedHits, 'boolean')
  assert.equal(hit.truncatedHits, hit.scoredCount > hit.hits.length, '标志必须与事实一致')

  // ② 零命中时把完整文件清单交出去 —— 模型不能把「搜不到」读成「不存在」
  const miss = await tool.execute({ q: 'zzzqqqxxx' })
  assert.equal(miss.scoredCount, 0)
  assert.equal(miss.truncatedHits, false)
  assert.ok(Array.isArray(miss.otherFiles), 'otherFiles 必须是数组')
  assert.ok(miss.otherFiles.length > 0, '零命中时它就是完整文件清单')
  assert.ok(miss.otherFiles.includes('MEMORY.md'), '清单应含 MEMORY.md')
  assert.equal(typeof miss.otherFilesTruncated, 'boolean')

  // ③ 命中的文件不应再出现在 otherFiles 里(否则是重复信息)
  const covered = new Set(hit.hits.map((h) => h.path))
  for (const f of hit.otherFiles) assert.ok(!covered.has(f), `${f} 既在 hits 又在 otherFiles`)
})

test('memory_read:返回指定文件全文', async () => {
  const ctx = setup({ memoryRoot: FIXTURE })
  const tool = ctx.registeredTools.find((t) => t.name === 'memory_read')
  const r = await tool.execute({ path: 'aquarium/tank-rules.md' })
  assert.equal(r.path, 'aquarium/tank-rules.md')
  assert.ok(r.bytes > 0)
  assert.match(r.text, /禁养品种/)
})

test('memory_read:越界路径被拒绝(安全边界)', async () => {
  const ctx = setup({ memoryRoot: FIXTURE })
  const tool = ctx.registeredTools.find((t) => t.name === 'memory_read')
  for (const bad of ['../../etc/passwd', 'C:/Windows/win.ini', '/etc/passwd', '.git/config']) {
    await assert.rejects(() => tool.execute({ path: bad }), undefined, '应拒绝 ' + bad)
  }
})

// -------------------------------------------------- 写入路径工具(阶段 B)

const writeTool = (ctx) => ctx.registeredTools.find((t) => t.name === 'memory_write')

test('memory_write:自动写入 ⇒ 进常驻索引,且人工小节一字不改', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'MEMORY.md'), '## 当前主线\n- 人工条目 [source: a; added: 2026-01-01]\n')
  const ctx = setup({ memoryRoot: root })
  const r = await writeTool(ctx).execute({ text: 'zzqauto 一条事实', source: 'dsh://session/x' })
  assert.equal(r.channel, 'index')
  assert.equal(r.path, 'MEMORY.md')
  const index = fs.readFileSync(path.join(root, 'MEMORY.md'), 'utf8')
  assert.match(index, /- 人工条目 \[source: a; added: 2026-01-01\]/, '人工小节必须原样')
  assert.match(index, /## 自动记录/)
  assert.match(index, /- zzqauto 一条事实 \[source: dsh:\/\/session\/x; added: \d{4}-\d{2}-\d{2}\]/)
})

test('memory_write:受限类落 pending,且 pending 不进常驻段', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'MEMORY.md'), '## 当前主线\n')
  const ctx = setup({ memoryRoot: root })
  const r = await writeTool(ctx).execute({ text: 'zzqres 一个受限事实', source: 'vendor/AGENTS.md' })
  assert.equal(r.channel, 'pending')
  assert.match(r.path, /^pending\//)
  const index = fs.readFileSync(path.join(root, 'MEMORY.md'), 'utf8')
  assert.equal(index.includes('zzqres'), false, 'pending 内容不得进常驻段')
})

test('memory_write:⚠ 命中密钥 ⇒ 拒收且**磁盘上找不到原文**', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'MEMORY.md'), '## 当前主线\n')
  const ctx = setup({ memoryRoot: root })
  const secret = 'sk-abcdefghijklmnopqrstuvwx'
  const r = await writeTool(ctx).execute({ text: `key=${secret}`, source: 'dsh://x' })
  assert.equal(r.channel, 'rejected')
  assert.equal(r.reason.includes(secret), false, '理由里不得复述密钥原文')

  // 全根扫一遍:原文一次都不该出现(记忆仓是 git 仓,落盘就会被提交)
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name)
    return e.isDirectory() ? walk(p) : [p]
  })
  for (const f of walk(root)) {
    assert.equal(fs.readFileSync(f, 'utf8').includes(secret), false, `${f} 里出现了密钥原文`)
  }
})

test('memory_pending:列出候选,且能提取「落 pending 的原因」', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'MEMORY.md'), '## 当前主线\n')
  const ctx = setup({ memoryRoot: root })
  await writeTool(ctx).execute({ text: 'zzqpend 一条事实', source: 'vendor/AGENTS.md' })

  const list = ctx.registeredTools.find((t) => t.name === 'memory_pending')
  const r = await list.execute({})
  assert.equal(r.count, 1)
  assert.equal(r.items[0].reason, '属受限类(D3 豁免:永不自动写入,只能人工)', '原因必须能提取出来')
  assert.match(r.items[0].entry, /zzqpend/)
})

test('memory_promote:提升进常驻段并删掉 pending(端到端)', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'MEMORY.md'), '## 当前主线\n')
  const ctx = setup({ memoryRoot: root })
  await writeTool(ctx).execute({ text: 'zzqpromote 一条事实', source: 'vendor/AGENTS.md' })

  const list = await ctx.registeredTools.find((t) => t.name === 'memory_pending').execute({})
  const promote = ctx.registeredTools.find((t) => t.name === 'memory_promote')
  await promote.execute({ path: list.items[0].path })

  const index = fs.readFileSync(path.join(root, 'MEMORY.md'), 'utf8')
  assert.match(index, /zzqpromote/)
  const after = await ctx.registeredTools.find((t) => t.name === 'memory_pending').execute({})
  assert.equal(after.count, 0, 'pending 文件必须被删掉')
})

test('memory_reject:删 pending + 留抑制记录,同一内容再写直接拒收(防反复抽取)', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'MEMORY.md'), '## 当前主线\n')
  const ctx = setup({ memoryRoot: root })
  await writeTool(ctx).execute({ text: 'zzqreject 一条事实', source: 'vendor/AGENTS.md' })

  const list = await ctx.registeredTools.find((t) => t.name === 'memory_pending').execute({})
  const reject = ctx.registeredTools.find((t) => t.name === 'memory_reject')
  const rr = await reject.execute({ path: list.items[0].path })
  assert.match(rr.hash, /^[0-9a-f]{16}$/)

  // 同一条内容再写 ⇒ 命中抑制记录(WeKnora 的「拒绝留痕防重抽」)
  const again = await writeTool(ctx).execute({ text: 'zzqreject 一条事实', source: 'vendor/AGENTS.md' })
  assert.equal(again.channel, 'rejected')
  assert.match(again.reason, /抑制记录/)
})

test('memory_write:与既有条目完全重复 ⇒ 拒收(不重复入库)', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'MEMORY.md'), '## 当前主线\n')
  const ctx = setup({ memoryRoot: root })
  const first = await writeTool(ctx).execute({ text: 'zzqdup 一条事实', source: 'dsh://x' })
  assert.equal(first.channel, 'index')
  const second = await writeTool(ctx).execute({ text: 'zzqdup 一条事实', source: 'dsh://x' })
  assert.equal(second.channel, 'rejected')
  assert.match(second.reason, /重复/)
})

// -------------------------------------------------- 定期自审(阶段 C)

test('memory_review:产出报告文件,且**不删任何记忆文件**', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'MEMORY.md'), [
    '## 当前主线',
    '- zzqa 一条正常条目,出处齐全 [source: dsh://session/x; added: 2026-10-10]',
    '- zzqb 无出处的一条 [added: 2026-10-10]',
    '',
  ].join('\n'))
  const before = fs.readFileSync(path.join(root, 'MEMORY.md'), 'utf8')

  const ctx = setup({ memoryRoot: root })
  const r = await ctx.registeredTools.find((t) => t.name === 'memory_review').execute({})

  assert.match(r.path, /^review\/report-\d{4}-\d{2}-\d{2}\.md$/)
  assert.ok(fs.existsSync(path.join(root, r.path)))
  assert.equal(fs.readFileSync(path.join(root, 'MEMORY.md'), 'utf8'), before, '⚠ 自审不得改动记忆文件')
  assert.ok(r.flagged >= 1, '无出处那条应被标记')
  assert.match(r.note, /用户拍板/)
})

test('memory_review:受限类条目按 D3 双重判据豁免,不参与评分也不进报告', async () => {
  const root = tmpRoot()
  fs.mkdirSync(path.join(root, 'restricted'), { recursive: true })
  fs.writeFileSync(path.join(root, 'MEMORY.md'), '- zzqnormal 正常条目 [source: dsh://x; added: 2026-10-10]\n')
  // ① 路径豁免:restricted/ 下的条目**故意**无出处,仍不该被标记
  fs.writeFileSync(path.join(root, 'restricted', 'risk.md'), '- zzqres1 受限纪律 [added: 2026-01-01]\n')
  // ② 出处豁免:MEMORY.md 里 source 指向 vendor/*
  fs.appendFileSync(path.join(root, 'MEMORY.md'), '- zzqres2 受限事实 [source: vendor/AGENTS.md; added: 2026-01-01]\n')

  const ctx = setup({ memoryRoot: root })
  const r = await ctx.registeredTools.find((t) => t.name === 'memory_review').execute({})

  assert.equal(r.exempt, 2, '两条受限类都应被豁免')
  assert.equal(r.scored, 1, '只有非交易那条参与评分')
  const report = fs.readFileSync(path.join(root, r.path), 'utf8')
  assert.equal(report.includes('zzqres1'), false, '豁免条目不得出现在报告里')
  assert.equal(report.includes('zzqres2'), false)
})

test('memory_review:报告落 review/ ⇒ 不进检索语料,但读得到', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'MEMORY.md'), '- zzqz 条目 [source: dsh://x; added: 2026-10-10]\n')
  const ctx = setup({ memoryRoot: root })
  const r = await ctx.registeredTools.find((t) => t.name === 'memory_review').execute({})

  const search = ctx.registeredTools.find((t) => t.name === 'memory_search')
  const s = await search.execute({ q: 'zzqz' })
  assert.equal(s.hits.some((h) => h.path.startsWith('review/')), false, 'review/ 不得进检索语料')

  const read = ctx.registeredTools.find((t) => t.name === 'memory_read')
  const got = await read.execute({ path: r.path })
  assert.match(got.text ?? JSON.stringify(got), /记忆自审报告/)
})

test('memory_review:跑完写状态文件,注入段的过期提醒随之消失', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'MEMORY.md'), '- zzqw 条目 [source: dsh://x; added: 2026-10-10]\n')

  // 未自审过 ⇒ 段尾应有提醒
  const c1 = setup({ memoryRoot: root })
  const t1 = c1.registeredSections[0].text()
  assert.match(t1, /从未自审过/, '未自审过必须提醒')
  assert.match(t1, /memory_review/)

  await c1.registeredTools.find((t) => t.name === 'memory_review').execute({})

  // 自审完 ⇒ 提醒消失(同一进程重新装配)
  const t2 = c1.registeredSections[0].text()
  assert.equal(t2.includes('从未自审过'), false, '刚自审完不该再提醒')
  assert.equal(t2.includes('memory_review'), false)
})

test('⚠ 过期提醒必须落在**数据围栏之外**(它是指令,不是数据)', () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'MEMORY.md'), '- 条目 [source: dsh://x; added: 2026-10-10]\n')
  const ctx = setup({ memoryRoot: root })
  const text = ctx.registeredSections[0].text()
  const close = text.search(/<<<\/DSH-MEMORY-DATA:[0-9a-f]{12}>>>/)
  const notice = text.indexOf('memory_review')
  assert.ok(close >= 0, '必须有闭合标记')
  assert.ok(notice > close, '提醒必须在闭合标记**之后** —— 放进数据区就与硬规则 15 自相矛盾')
})

// ------------------------------------------------------------ 生命周期

test('注册了 effect 清理标签', () => {
  const ctx = setup({ memoryRoot: FIXTURE })
  assert.ok(ctx.effectLabels.includes('dsh-memory.section()'))
})
