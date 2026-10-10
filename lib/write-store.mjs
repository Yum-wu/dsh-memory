// dsh-memory 写入层:写锁 + 原子落盘 + pending 生命周期。
//
// 与 memory-store.mjs 的分工:
//   memory-store.mjs  **纯函数** —— 分级、扫描、格式化、相似度,不碰磁盘,可穷举测试
//   write-store.mjs   **IO** —— 锁、临时文件、rename、pending 目录
//
// ⚠ 本文件仍然**不碰 ctx**(硬规则 2),所以 `node --test` 能直接跑。

import fs from 'node:fs'
import path from 'node:path'

import {
  MEMORY_CODES,
  MemoryError,
  NO_RESTRICTED,
  PENDING_DIR,
  REJECTED_FILE,
  RESTRICTED_FILE,
  REVIEW_DIR,
  REVIEW_STATE_FILE,
  appendEntryToIndex,
  entryHash,
  parseRestrictedRules,
} from './memory-store.mjs'

/** 拿锁的等待上限。写操作很短,超过这个数说明有别的进程卡住了。 */
export const DEFAULT_LOCK_TIMEOUT_MS = 3000
/** 锁文件超过这个年龄即视为**陈旧**(持锁进程已死)并回收。 */
export const DEFAULT_LOCK_STALE_MS = 30_000

const LOCK_FILE = '.write.lock'

/** 同步睡眠。写路径全是同步 IO,引异步只为等锁不值得。 */
function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // 环境不支持 SharedArrayBuffer 时退化成忙等 —— 宁可烧 CPU,也不能静默跳过等待
    const until = Date.now() + ms
    while (Date.now() < until) { /* busy wait */ }
  }
}

/**
 * 独占写锁。
 *
 * ⚠ **为什么需要它**(不是防御性编程,是实测教训):
 * Graphiti 实测 8 线程各 150 次 set/get **丢 1043/1200** —— 并发写会丢更新。
 * 现在 P2 一开写就会有并发(工具调用可能并行),而记忆是**只追加**的,
 * 丢一条就是永久丢一条。
 *
 * 实现:`openSync(lock,'wx')` 独占创建;拿不到就退避重试;
 * 锁文件 mtime 超过 `staleMs` 视为陈旧并回收(持锁进程崩了不会永久卡死)。
 */
export function withWriteLock(root, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS
  const lock = path.join(root, LOCK_FILE)
  const deadline = Date.now() + timeoutMs
  let fd = null

  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx')
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let st = null
      try { st = fs.statSync(lock) } catch { continue } // 锁刚好被释放 ⇒ 立刻重试
      if (Date.now() - st.mtimeMs > staleMs) {
        try { fs.unlinkSync(lock) } catch { /* 别人抢先回收了,下一轮重试即可 */ }
        continue
      }
      if (Date.now() > deadline) {
        // ⚠ 参数序是 (message, code) —— 写反了 code 会变成整句中文,调用方分派全部失效。
        throw new MemoryError(
          `拿不到写锁 ${lock}(等 ${timeoutMs}ms 超时;若确认无进程在写,删掉该文件即可)`,
          MEMORY_CODES.WRITE_LOCKED
        )
      }
      sleepMs(5)
    }
  }

  try {
    return fn()
  } finally {
    try { fs.closeSync(fd) } catch { /* 已关 */ }
    try { fs.unlinkSync(lock) } catch { /* 已被回收 */ }
  }
}

/**
 * 原子落盘:先写同目录临时文件,再 `rename` 覆盖。
 * ⚠ 必须**同目录** —— 跨卷 rename 会退化成 copy+delete,不再原子。
 */
export function atomicWrite(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = path.join(
    path.dirname(target),
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  )
  fs.writeFileSync(tmp, content, 'utf8')
  try {
    fs.renameSync(tmp, target)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* 尽力清理 */ }
    throw e
  }
}

/** 读抑制记录。文件缺失/损坏一律当空表 —— 记忆坏了不能连累写入。 */
export function readRejected(root) {
  try {
    const raw = fs.readFileSync(path.join(root, REJECTED_FILE), 'utf8')
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
  } catch {
    return {}
  }
}

/** 记一条抑制记录(哈希 → 日期)。⚠ 只存哈希,**不存原文**。 */
export function addRejected(root, hash, date) {
  const table = readRejected(root)
  if (table[hash]) return table
  table[hash] = date
  atomicWrite(path.join(root, REJECTED_FILE), JSON.stringify(table, null, 2) + '\n')
  return table
}

/**
 * 落一条待确认条目。
 * ⚠ 调用方必须已经过了 `classifyWrite` 且结论是 `pending` —— 本函数不做分级。
 */
export function writePending(root, { entry, reason, date }) {
  const rel = `${PENDING_DIR}/${date}-${entryHash(entry)}.md`
  const body = [
    '<!-- pending:自动抽取的候选记忆,**未经确认不进常驻段、不进检索语料** -->',
    `<!-- 落 pending 的原因:${reason} -->`,
    '<!-- 确认:人工并入 MEMORY.md(或合适的主题文件)后删除本文件 -->',
    '<!-- 不采纳:调 memory_reject,它会留抑制记录防同一条被反复抽取 -->',
    '',
    entry,
    '',
  ].join('\n')
  atomicWrite(path.join(root, rel), body)
  return { rel, bytes: Buffer.byteLength(body, 'utf8') }
}

/** 列出待确认条目(只列 `.md`)。 */
export function listPending(root) {
  const dir = path.join(root, PENDING_DIR)
  let names
  try { names = fs.readdirSync(dir) } catch { return [] }
  return names
    .filter((n) => n.toLowerCase().endsWith('.md'))
    .sort()
    .map((n) => {
      const rel = `${PENDING_DIR}/${n}`
      let text = ''
      try { text = fs.readFileSync(path.join(dir, n), 'utf8') } catch { /* 读不到就当空 */ }
      return { rel, bytes: Buffer.byteLength(text, 'utf8'), text }
    })
}

/**
 * 把一条 pending 条目提升进常驻索引。
 *
 * ⚠ 提升 = 写 `MEMORY.md` + **删掉 pending 文件**,两步都要在锁内。
 * 顺序不能反:先删后写,写失败就永久丢了内容。
 */
export function promotePending(root, rel, opts = {}) {
  const date = opts.date ?? new Date().toISOString().slice(0, 10)
  const abs = path.join(root, rel)
  let raw
  try {
    raw = fs.readFileSync(abs, 'utf8')
  } catch {
    throw new MemoryError(`待确认条目不存在:${rel}`, MEMORY_CODES.WRITE_NOT_FOUND)
  }
  // 取出正文里的条目行(第一个非注释、非空行)
  const line = raw.split(/\r?\n/).find((l) => l.trim() !== '' && !l.trim().startsWith('<!--'))
  if (!line) {
    throw new MemoryError(`待确认条目里没有内容:${rel}`, MEMORY_CODES.WRITE_EMPTY)
  }
  const entryLine = line.startsWith('- ') ? line.trim() : `- ${line.trim()}`

  return withWriteLock(root, () => {
    const indexFile = path.join(root, 'MEMORY.md')
    const before = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : ''
    atomicWrite(indexFile, appendEntryToIndex(before, entryLine))
    fs.unlinkSync(abs)
    return { entryLine, removed: rel, date }
  })
}

/** 拒绝一条 pending 条目:删文件 + 记抑制记录(哈希)。 */
export function rejectPending(root, rel, opts = {}) {
  const date = opts.date ?? new Date().toISOString().slice(0, 10)
  const abs = path.join(root, rel)
  let raw
  try {
    raw = fs.readFileSync(abs, 'utf8')
  } catch {
    throw new MemoryError(`待确认条目不存在:${rel}`, MEMORY_CODES.WRITE_NOT_FOUND)
  }
  const line = raw.split(/\r?\n/).find((l) => l.trim() !== '' && !l.trim().startsWith('<!--')) ?? ''
  const hash = entryHash(line)

  return withWriteLock(root, () => {
    fs.unlinkSync(abs)
    addRejected(root, hash, date)
    return { hash, removed: rel, date }
  })
}

// ────────────────────────────────────── 定期自审(阶段 C)
//
// ⚠ 本段**绝不写记忆文件** —— 只写 `review/` 与 `.last-review.json`。
// 删除是用户看过报告后的显式路径白名单操作(决策 D2)。

/** 读自审状态。文件缺失/损坏一律当「从未自审」—— 宁可多提醒一次,不可静默不提醒。 */
export function readLastReview(root) {
  try {
    const obj = JSON.parse(fs.readFileSync(path.join(root, REVIEW_STATE_FILE), 'utf8'))
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && typeof obj.lastReview === 'string') {
      return { lastReview: obj.lastReview, count: Number(obj.count) || 0 }
    }
    return null
  } catch {
    return null
  }
}

/** 写自审状态。⚠ 数据文件,**不带 BOM**(本机 BOM 规则)。 */
export function writeLastReview(root, { date, count }) {
  atomicWrite(path.join(root, REVIEW_STATE_FILE), JSON.stringify({ lastReview: date, count }, null, 2) + '\n')
  return { lastReview: date, count }
}

/**
 * 落报告。⚠ 报告是**关于记忆的元数据**,不是记忆内容 ——
 * 它进 `SEARCH_SKIP_DIRS`(检索跳过)但**不在** `SKIP_DIRS`(路径限定),所以人读得到。
 */
export function writeReviewReport(root, markdown, opts = {}) {
  const date = opts.date ?? new Date().toISOString().slice(0, 10)
  const rel = `${REVIEW_DIR}/report-${date}.md`
  atomicWrite(path.join(root, rel), markdown)
  return { rel, bytes: Buffer.byteLength(markdown, 'utf8') }
}

/** 列出已有报告(新→旧)。 */
export function listReviewReports(root) {
  const dir = path.join(root, REVIEW_DIR)
  let names
  try { names = fs.readdirSync(dir) } catch { return [] }
  return names.filter((n) => /^report-\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort().reverse()
}

/**
 * 读受限规则(`<root>/.restricted.json`)。
 *
 * ⚠ **公开源码里一个具体前缀都不含** —— 规则由记忆仓自己声明(硬规则 8)。
 * ⚠ **缺文件 / 坏 JSON / 形状不对 ⇒ 空规则**,不抛错:
 *   记忆仓坏了不能连累写入路径(与 `readRejected` 同一条纪律)。
 * ⚠ 每次调用都读盘(不缓存)—— 用户改配置后**下次工具调用即生效**,不必重启 DSH。
 */
export function readRestricted(root) {
  let raw
  try { raw = fs.readFileSync(path.join(root, RESTRICTED_FILE), 'utf8') } catch { return NO_RESTRICTED }
  try { return parseRestrictedRules(JSON.parse(raw)) } catch { return NO_RESTRICTED }
}
