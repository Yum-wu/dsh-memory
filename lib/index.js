// dsh-memory —— DSH 跨会话记忆(宿主插件)
//
// 职责(仅 P1):
//   1) 把 ~/.dsh/memory/MEMORY.md 作为**常驻系统提示词段**注入(带行数/字节硬预算)
//   2) 提供 memory_search / memory_read 两个只读工具
//
// 本阶段**只读** —— 插件不写任何文件。写入(门控 + pending 确认)是 P2。
//
// ── 为什么用 systemPrompt.section() 而不是往消息序列里插一条消息 ──
// 官方有两条路:① dsh-agent-instructions 走 `agent/pre-step` + createUserMessage 插消息;
// ② ctx.systemPrompt.section() 注册提示词段。记忆是**恒定上下文**,语义上属于系统提示词,
// 用 ② 更贴切,且 text 支持传函数(每次装配求值),天然满足「文件改了要跟着变」。
// 附带好处:不必 import @deepseek-ai/dsh-llm(本地插件在 profile 外,那个包从本目录解析不到)。
//
// ── order 取 100 的依据 ──
// @deepseek-ai/dsh-system-prompt 的 SECTION_ORDERS 正典:
//   HARNESS_IDENTITY -1000 / DEPLOYMENT_PERSONA_PREFIX 0 / PLAN_POLICY 500 /
//   TOOL_* 1000~3100 / TOOLS_SDK 5000 / DEPLOYMENT_PERSONA_SUFFIX 10200
// 记忆 = 「你是谁、我们已确立了什么」,应紧跟 persona、早于策略与工具描述 → 取 100。
// getSectionOrder() 只认正典名字,自定义位置只能用字面量。

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_INDEX_MAX_BYTES,
  DEFAULT_INDEX_MAX_LINES,
  DEFAULT_MAX_LISTED_FILES,
  DEFAULT_MAX_SCAN_FILES,
  appendEntryToIndex,
  classifyWrite,
  collectDocuments,
  composeSection,
  entryHash as entryHashOf,
  formatEntry,
  isRestrictedEntry,
  listUncovered,
  parseEntryLine,
  readWithinRoot,
  renderReviewReport,
  reviewDue,
  reviewEntries,
  reviewNotice,
  REVIEW_DEFAULT_DAYS,
  searchDetailed,
} from './memory-store.mjs'

import {
  addRejected,
  atomicWrite,
  listPending,
  listReviewReports,
  promotePending,
  readLastReview,
  readRejected,
  readRestricted,
  rejectPending,
  withWriteLock,
  writeLastReview,
  writePending,
  writeReviewReport,
} from './write-store.mjs'

export const name = 'dsh-memory'

/** 需要宿主提供的服务:提示词注册表 + 工具注册表。 */
export const inject = ['systemPrompt', 'tools']

/** 默认记忆根:独立于任何项目仓。 */
export function defaultMemoryRoot() {
  return path.join(os.homedir(), '.dsh', 'memory')
}

/**
 * 宿主插件入口。
 * @param ctx - cordis 上下文
 * @param config - 见 profiles/web/cordis.patch.yml 的 config 段
 */
export function apply(ctx, config = {}) {
  const root = path.resolve(config.memoryRoot || defaultMemoryRoot())
  const maxLines = config.maxIndexLines ?? DEFAULT_INDEX_MAX_LINES
  const maxBytes = config.maxIndexBytes ?? DEFAULT_INDEX_MAX_BYTES
  const sectionOrder = config.sectionOrder ?? 100
  const maxScanFiles = config.maxScanFiles ?? DEFAULT_MAX_SCAN_FILES
  const maxListedFiles = config.maxListedFiles ?? DEFAULT_MAX_LISTED_FILES
  /** 自审周期(天)。超过就在注入段尾部提醒(阶段 C / 决策 D4 —— 不建计划任务)。 */
  const reviewDays = config.reviewDays ?? REVIEW_DEFAULT_DAYS
  /** 陈旧阈值(天),自审评分用。 */
  const reviewStaleDays = config.reviewStaleDays ?? 180
  const indexFile = path.join(root, 'MEMORY.md')

  /**
   * 数据区围栏的 nonce —— **结构性注入隔离的核心**(阶段 A)。
   *
   * 每进程生成一次(不是每次装配):装配是每轮都跑的,每轮换 nonce 会让
   * 「同一段记忆在不同轮次有不同的边界标记」,徒增不确定性,且对防御没有增益 ——
   * 攻击者要伪造闭合标记,只需要在**写入时**猜不到即可,而写入发生在进程之外。
   *
   * ⚠ 为什么这算**结构性**而不是文案:nonce 不出现在记忆仓里,写记忆的人(或模型)
   * 无法知道它 ⇒ **无法闭合数据区** ⇒ 无法把后续文本顶到数据区之外冒充指令。
   * 这跟「猜不到的定界符」是同一类防御。
   */
  const fenceNonce = crypto.randomBytes(6).toString('hex')

  /** 当天日期(YYYY-MM-DD,UTC)。写入时打时间戳用。 */
  const today = () => new Date().toISOString().slice(0, 10)

  /**
   * 读常驻索引;任何失败都退化为空串 —— 记忆坏了绝不能连累整个提示词装配。
   *
   * ⚠ 但「静默退化」和「静默失效」只差一线:调用方分不清「本来就没有记忆」与「读取失败了」。
   * 所以按**状态迁移**告警(不是每次装配都刷),失败可观测且不刷屏。
   */
  let lastFailReason = null
  const readIndex = () => {
    try {
      const text = fs.readFileSync(indexFile, 'utf8')
      if (lastFailReason !== null) {
        ctx.logger?.info?.('dsh-memory: 索引恢复正常 %s', indexFile)
        lastFailReason = null
      }
      return text
    } catch (e) {
      const reason = e?.code || e?.message || 'unknown'
      if (reason !== lastFailReason) {
        lastFailReason = reason
        ctx.logger?.warn?.('dsh-memory: 读不到索引 %s (%s) —— 本次注入空段', indexFile, reason)
      }
      return ''
    }
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'dsh-memory:index',
    order: sectionOrder,
    // ⚠ **必须** interpolate:false。记忆是**字面数据**,不是提示词模板。
    // 默认 true 时 renderPrompt 会对 `{{name}}` 做严格插值,遇到未知/畸形引用**抛错**
    // (dsh-system-prompt/lib/index.js:160/166/169),而该调用在 agent loop 的 step() 内同步执行
    // ⇒ 记忆里出现一个字面的 `{{中文}}` 就能让**整轮会话失败**。红队实测确认。
    interpolate: false,
    text: () => {
      try {
        // 阶段 C:自审过期时在**数据围栏之外**附一行提醒(它是给模型的指令,不是记忆数据)。
        // ⚠ 每次装配都读一次状态文件 —— 它是几十字节的小文件,且必须反映**最新**状态;
        //    缓存住会让刚跑完的自审继续被提醒。
        const last = readLastReview(root)
        const { due, age } = reviewDue(last?.lastReview ?? null, new Date(), reviewDays)
        const notice = due ? reviewNotice(age) : ''
        return composeSection(readIndex(), { maxLines, maxBytes, nonce: fenceNonce, notice }).text
      } catch { return '' }
    },
  }), 'dsh-memory.section()')

  // 与同目录 shadow-desk 一致的零依赖工具定义形状。
  const makeTool = (toolName, description, parameters, execute, timeoutMs) => ({
    name: toolName,
    description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute,
    timeoutMs,
  })

  const dSearch = ctx.tools.register(makeTool(
    'memory_search',
    '检索跨会话长期记忆(markdown 文件)。分词匹配,支持自然语言提问;问「哪些/所有/列出」返回全部命中(上限 20,被截断时 truncatedHits=true)。返回 path/score/snippet,细节用 memory_read 取全文。otherFiles 是本次未覆盖到的其他文档 —— 搜不到时它就是完整清单,别把「搜不到」当成「不存在」',
    { type: 'object', properties: { q: { type: 'string', description: '检索内容,关键词或自然语言提问均可' } }, required: ['q'] },
    async (args) => {
      const docs = collectDocuments(root, { maxFiles: maxScanFiles })
      // 命中扫描上限要**可见**,不能静默截断 —— 否则检索结果不完整而调用方毫不知情。
      if (docs.length >= maxScanFiles) {
        ctx.logger?.warn?.('dsh-memory: 扫描命中上限 %d 篇,结果可能不完整(记忆仓 %s)', maxScanFiles, root)
      }
      const { hits, scoredCount, limit } = searchDetailed(docs, args?.q, 5)
      // ⚠ 命中列表也会被 limit 截断,原先**没有标志** —— 硬规则 7「命中上限要告警,不能静默截断」
      // 只落实了文件数那一半。枚举查询(上限 20)在仓变大后必然撞上。
      const truncatedHits = scoredCount > hits.length
      if (truncatedHits && limit < scoredCount) {
        ctx.logger?.warn?.('dsh-memory: 命中上限 %d 条,实际打分为正的文档 %d 篇', hits.length, scoredCount)
      }
      // ⚠ 把「本次没覆盖到的文档」一并交出去。零命中时它就是完整文件清单 ——
      // 模型因此不会把「搜不到」误读成「不存在」;非 `.md` 文件那类
      // 「read 读得到 / search 永远搜不到」的不对称,也因此对调用方**可见**。
      const uncovered = listUncovered(docs, hits, maxListedFiles)
      return {
        root,
        total: docs.length,
        truncatedScan: docs.length >= maxScanFiles,
        scoredCount,
        truncatedHits,
        hits: hits.map((x) => ({ path: x.doc.rel, score: x.score, snippet: x.snippet })),
        otherFiles: uncovered.files,
        otherFilesTruncated: uncovered.truncated,
      }
    },
    10000,
  ))

  const dRead = ctx.tools.register(makeTool(
    'memory_read',
    '读取跨会话长期记忆中的某个 markdown 文件全文。路径相对记忆根,越界路径、备用数据流、硬链接、超限大文件一律拒绝',
    { type: 'object', properties: { path: { type: 'string', description: '相对记忆根的路径,如 topic/notes.md' } }, required: ['path'] },
    async (args) => {
      // 路径限定 + 体积上限都在纯函数层做;越界抛错即工具错误。
      const r = readWithinRoot(root, args?.path)
      return { path: r.rel, bytes: r.bytes, text: r.text }
    },
    10000,
  ))

  // ── 写入路径(P2)。⚠ 分级判据全在 memory-store.classifyWrite(纯函数,可穷举测试)。
  //
  // 三条不可省的纪律:
  //   ① 命中密钥 ⇒ **拒收且不落盘** —— 记忆仓是 git 仓,写进 pending 也会被提交
  //   ② 受限类 / 含指令性文本 / 缺 source / 超长 / 与既有条目高度重合 ⇒ 落 pending,人工确认
  //   ③ 只有「全部判据通过」才自动进常驻索引 —— 常驻段是稀缺资源(60 行 / 4096 B)
  const dWrite = ctx.tools.register(makeTool(
    'memory_write',
    '写入一条跨会话记忆。**自动分级**:全部判据通过才自动进常驻索引;受限类/含指令性文本/缺出处/超长/与既有条目高度重合的一律落 pending/ 等人工确认;命中密钥的直接拒收(不落盘)。返回 channel(index=已自动写入 / pending=待确认 / rejected=拒收)与 reason。⚠ 规则类内容请写进 AGENTS.md,不要写这里 —— 记忆通道明写「不是指令」,规则进来会被降级',
    {
      type: 'object',
      properties: {
        text: { type: 'string', description: '一条**事实**(不是规则),单行,≤200 字符' },
        source: { type: 'string', description: '出处,如 vendor/AGENTS.md 或 dsh://session/<id>。必填 —— 记不清出处的一律落 pending' },
        scope: { type: 'string', description: '可选作用域,如某个主题目录名。命中受限前缀(记忆仓 .restricted.json 声明)的条目永不自动写入' },
      },
      required: ['text', 'source'],
    },
    async (args) => {
      const docs = collectDocuments(root, { maxFiles: maxScanFiles })
      const existingLines = docs
        .flatMap((d) => d.text.split(/\r?\n/))
        .filter((l) => l.trim().startsWith('- '))
      const verdict = classifyWrite({
        text: args?.text,
        source: args?.source,
        scope: args?.scope,
        existingLines,
        rejected: readRejected(root),
        // ⚠ 受限前缀由**记忆仓自己**声明(`.restricted.json`),公开源码里一个都不含(硬规则 8)。
        restricted: readRestricted(root),
      })

      if (verdict.channel === 'rejected') {
        // ⚠ 拒收也留抑制记录(除非是「空内容」这种无意义的)。WeKnora 的做法:
        //   拒绝留痕可防「幻觉→检索→再抽取」的放大环(实测放大成 808 条同一句)。
        let suppressed = false
        if (verdict.code !== 'MEMORY_WRITE_EMPTY') {
          try {
            withWriteLock(root, () => addRejected(root, entryHashOf(args?.text), today()))
            suppressed = true
          } catch { /* 记不上就算了,不能因此让拒收变成写入 */ }
        }
        return { channel: 'rejected', code: verdict.code, reason: verdict.reason, suppressed }
      }

      const entryLine = formatEntry({ text: args?.text, source: args?.source, added: today() })

      if (verdict.channel === 'pending') {
        const r = withWriteLock(root, () => writePending(root, { entry: entryLine, reason: verdict.reason, date: today() }))
        return { channel: 'pending', reason: verdict.reason, path: r.rel, bytes: r.bytes, entryLine }
      }

      const r = withWriteLock(root, () => {
        const before = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : ''
        atomicWrite(indexFile, appendEntryToIndex(before, entryLine))
        return { indexFile }
      })
      return { channel: 'index', reason: verdict.reason, path: 'MEMORY.md', entryLine }
    },
    10000,
  ))

  const dPending = ctx.tools.register(makeTool(
    'memory_pending',
    '列出待人工确认的候选记忆(pending/ 目录)。⚠ 这些条目**不进检索语料、不进常驻段** —— 它们在等你确认。确认后调 memory_promote,不采纳调 memory_reject(会留抑制记录防止反复抽取)',
    { type: 'object', properties: {} },
    async () => {
      const items = listPending(root).map((p) => ({
        path: p.rel,
        bytes: p.bytes,
        reason: (p.text.match(/<!-- 落 pending 的原因:(.*?)-->/) ?? [, ''])[1].trim(),
        entry: (p.text.split(/\r?\n/).find((l) => l.trim() !== '' && !l.trim().startsWith('<!--')) ?? '').trim(),
      }))
      return { count: items.length, items }
    },
    10000,
  ))

  const dPromote = ctx.tools.register(makeTool(
    'memory_promote',
    '把一条 pending 候选记忆提升进常驻索引 MEMORY.md(追加到「自动记录」小节),并删除该 pending 文件。⚠ 提升前请确认内容确实是事实且仍然成立 —— 进常驻段后它每轮都会注入',
    { type: 'object', properties: { path: { type: 'string', description: 'memory_pending 返回的 path,如 pending/2026-10-10-abc123.md' } }, required: ['path'] },
    async (args) => promotePending(root, String(args?.path ?? ''), { date: today() }),
    10000,
  ))

  const dReject = ctx.tools.register(makeTool(
    'memory_reject',
    '拒绝一条 pending 候选记忆:删除该文件并留下**抑制记录**(只存内容哈希,不存原文),防止同一条被反复抽取。依据:WeKnora 的「拒绝留痕防重抽」—— 对治 mem0 实测的「幻觉→检索→再抽取」放大环',
    { type: 'object', properties: { path: { type: 'string', description: 'memory_pending 返回的 path' } }, required: ['path'] },
    async (args) => rejectPending(root, String(args?.path ?? ''), { date: today() }),
    10000,
  ))

  // ── 定期自审(阶段 C)。决策 D2 = 「先报告再删」⇒ 本工具**只写报告,绝不删条目**。
  const globalAgentsFile = path.join(os.homedir(), '.dsh', 'AGENTS.md')

  const dReview = ctx.tools.register(makeTool(
    'memory_review',
    '对记忆做定期自审,产出**报告文件** review/report-<日期>.md。⚠ **只报告,不删除任何东西** —— 删除由用户看过报告后拍板(显式路径白名单)。六个确定性维度:无出处(3)/ 仓内重复(3)/ 复述全局 AGENTS.md(3)/ 低信息(2)/ 疑似失效(1)/ 陈旧(1)。受限类条目按双重判据豁免(restricted/ 路径 或 vendor/* 出处),不参与评分。零 LLM 判分 —— 让模型自评「这条还有没有用」正是 mem0 实测 97.8% 垃圾的来源',
    {
      type: 'object',
      properties: {
        staleDays: { type: 'number', description: '陈旧阈值(天),默认 180' },
      },
    },
    async (args) => {
      const staleDays = Number(args?.staleDays) > 0 ? Number(args.staleDays) : reviewStaleDays
      const docs = collectDocuments(root, { maxFiles: maxScanFiles })

      // 逐条收集 + D3 双重判据豁免。⚠ 豁免条目**不出现在报告里**(避免噪声)。
      const entries = []
      let exempt = 0
      for (const d of docs) {
        const scope = d.rel.split('/')[0]
        for (const raw of d.text.split(/\r?\n/)) {
          const line = raw.trim()
          if (!line.startsWith('- ')) continue
          if (isRestrictedEntry({ scope, source: parseEntryLine(line).source }, readRestricted(root))) { exempt++; continue }
          entries.push({ rel: d.rel, raw: line })
        }
      }

      let globalAgentsText = ''
      try { globalAgentsText = fs.readFileSync(globalAgentsFile, 'utf8') } catch { /* 没有就跳过该维度 */ }

      const result = reviewEntries(entries, { now: new Date(), globalAgentsText, staleDays })
      const date = today()
      const markdown = renderReviewReport(result, { date, memoryRoot: root })
      const out = withWriteLock(root, () => {
        const written = writeReviewReport(root, markdown, { date })
        writeLastReview(root, { date, count: result.summary.total })
        return written
      })

      return {
        path: out.rel,
        bytes: out.bytes,
        scored: result.summary.total,
        exempt,
        flagged: result.summary.flagged,
        byRule: result.summary.byRule,
        top: result.items.filter((i) => i.score > 0).slice(0, 10)
          .map((i) => ({ score: i.score, rel: i.rel, hits: i.hits, body: i.body.slice(0, 60) })),
        reports: listReviewReports(root).slice(0, 5),
        note: '报告只提出建议;删除由用户拍板(设计决策 D2)',
      }
    },
    15000,
  ))

  // 显式保留注册句柄,停载时统一回收(与 shadow-desk 同一写法)。
  const handles = [dSearch, dRead, dWrite, dPending, dPromote, dReject, dReview].filter((d) => typeof d === 'function')
  if (handles.length > 0) ctx.effect(() => () => handles.forEach((d) => d()))

  ctx.logger?.info?.('dsh-memory: 记忆根 %s(常驻预算 %d 行 / %d 字节)', root, maxLines, maxBytes)}
