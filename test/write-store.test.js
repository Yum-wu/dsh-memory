// 写入层测试(阶段 B):node --test test/write-store.test.js
//
// 这里测的是**真落盘**行为 —— 锁、原子写、pending 生命周期。
// 分级判据(纯函数)在 memory-store.test.js 里测。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  MEMORY_CODES,
  MemoryError,
  collectDocuments,
  entryHash,
  readWithinRoot,
  searchDocuments,
} from '../lib/memory-store.mjs'

import {
  addRejected,
  atomicWrite,
  listPending,
  promotePending,
  readRejected,
  rejectPending,
  withWriteLock,
  writePending,
} from '../lib/write-store.mjs'

/** 每个测试一个独立临时记忆根,避免互相污染。 */
function tmpRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-ws-'))
  fs.writeFileSync(path.join(d, 'MEMORY.md'), '## 当前主线\n- 人工条目 [source: a; added: 2026-01-01]\n')
  return d
}

// ------------------------------------------------------------------ 写锁

test('写锁:同一把锁不可重入,超时抛 WRITE_LOCKED(不是静默通过)', () => {
  const root = tmpRoot()
  assert.throws(
    () => withWriteLock(root, () => withWriteLock(root, () => 'never', { timeoutMs: 50, staleMs: 60_000 }), { timeoutMs: 5_000 }),
    (e) => e instanceof MemoryError && e.code === MEMORY_CODES.WRITE_LOCKED
  )
})

test('写锁:释放后可再次获取(锁文件不残留)', () => {
  const root = tmpRoot()
  assert.equal(withWriteLock(root, () => 'a'), 'a')
  assert.equal(fs.existsSync(path.join(root, '.write.lock')), false, '锁文件必须被删掉')
  assert.equal(withWriteLock(root, () => 'b'), 'b')
})

test('写锁:回调抛异常时也要释放(否则一次失败永久卡死记忆写入)', () => {
  const root = tmpRoot()
  assert.throws(() => withWriteLock(root, () => { throw new Error('boom') }), /boom/)
  assert.equal(fs.existsSync(path.join(root, '.write.lock')), false)
  assert.equal(withWriteLock(root, () => 'ok'), 'ok', '异常之后必须还能拿锁')
})

test('写锁:陈旧锁被回收(持锁进程崩了不会永久卡死)', () => {
  const root = tmpRoot()
  const lock = path.join(root, '.write.lock')
  fs.writeFileSync(lock, '{"pid":999999}')
  // 把 mtime 推到很久以前 ⇒ 视为陈旧
  const old = new Date(Date.now() - 3600_000)
  fs.utimesSync(lock, old, old)
  assert.equal(withWriteLock(root, () => 'recovered', { timeoutMs: 200, staleMs: 1000 }), 'recovered')
})

// ---------------------------------------------------------------- 原子写

test('原子写:落盘内容正确,且不残留临时文件', () => {
  const root = tmpRoot()
  const target = path.join(root, 'sub', 'x.md')
  atomicWrite(target, 'hello')
  assert.equal(fs.readFileSync(target, 'utf8'), 'hello')
  assert.deepEqual(fs.readdirSync(path.join(root, 'sub')), ['x.md'], '目录里只应有目标文件')
})

test('原子写:覆盖已有文件是替换而不是追加', () => {
  const root = tmpRoot()
  const target = path.join(root, 'x.md')
  atomicWrite(target, 'first')
  atomicWrite(target, 'second')
  assert.equal(fs.readFileSync(target, 'utf8'), 'second')
})

// ------------------------------------------------------- pending 生命周期

test('pending:落盘后可列出,且带「落 pending 的原因」', () => {
  const root = tmpRoot()
  const r = writePending(root, { entry: '- 候选条目 [source: dsh://x; added: 2026-10-10]', reason: '缺 source', date: '2026-10-10' })
  assert.match(r.rel, /^pending\/2026-10-10-[0-9a-f]{16}\.md$/)
  const items = listPending(root)
  assert.equal(items.length, 1)
  assert.equal(items[0].rel, r.rel)
  assert.match(items[0].text, /落 pending 的原因:缺 source/)
  assert.match(items[0].text, /候选条目/)
})

test('pending:⚠ 不进检索语料,但 memory_read 读得到(否则 pending 是黑洞)', () => {
  const root = tmpRoot()
  // ⚠ 用**唯一的 ASCII 词**当探针,别用中文短语 ——
  // CJK 二元组会让「候选条目」与 MEMORY.md 里的「人工条目」共享「条目」而假命中(踩过)。
  const probe = 'zzqpendingprobe'
  const r = writePending(root, { entry: `- ${probe} [source: dsh://x; added: 2026-10-10]`, reason: '测试', date: '2026-10-10' })

  // ① 检索侧:收不到
  const docs = collectDocuments(root)
  assert.equal(docs.some((d) => d.rel.startsWith('pending/')), false, 'pending/ 不得进检索语料')
  assert.equal(searchDocuments(docs, probe, 5).length, 0, `探针 ${probe} 不该被检索到`)

  // ② 读取侧:读得到 —— 人必须能看内容才能确认
  const read = readWithinRoot(root, r.rel)
  assert.match(read.text, new RegExp(probe))
})

test('pending:提升进常驻索引,并删除 pending 文件(顺序不能反)', () => {
  const root = tmpRoot()
  const r = writePending(root, { entry: '- 候选条目 [source: dsh://x; added: 2026-10-10]', reason: '测试', date: '2026-10-10' })

  const out = promotePending(root, r.rel, { date: '2026-10-11' })
  assert.match(out.entryLine, /候选条目/)

  const index = fs.readFileSync(path.join(root, 'MEMORY.md'), 'utf8')
  assert.match(index, /## 自动记录/)
  assert.match(index, /- 候选条目 \[source: dsh:\/\/x; added: 2026-10-10\]/)
  assert.ok(index.includes('- 人工条目 [source: a; added: 2026-01-01]'), '人工小节一字不改')
  assert.equal(fs.existsSync(path.join(root, r.rel)), false, 'pending 文件必须被删掉')
  assert.equal(listPending(root).length, 0)
})

test('pending:提升不存在的条目抛 WRITE_NOT_FOUND(不是静默成功)', () => {
  const root = tmpRoot()
  assert.throws(
    () => promotePending(root, 'pending/nope.md'),
    (e) => e instanceof MemoryError && e.code === MEMORY_CODES.WRITE_NOT_FOUND
  )
})

test('pending:拒绝会删文件 + 留抑制记录,且记录里**只有哈希没有原文**', () => {
  const root = tmpRoot()
  const secretish = '- 一条不想采纳的候选 [source: dsh://x; added: 2026-10-10]'
  const r = writePending(root, { entry: secretish, reason: '测试', date: '2026-10-10' })

  const out = rejectPending(root, r.rel, { date: '2026-10-10' })
  assert.equal(fs.existsSync(path.join(root, r.rel)), false)
  assert.equal(out.hash, entryHash(secretish))

  const table = readRejected(root)
  assert.equal(table[out.hash], '2026-10-10')
  const raw = fs.readFileSync(path.join(root, '.rejected.json'), 'utf8')
  assert.equal(raw.includes('不想采纳'), false, '抑制记录只存哈希,不得存原文')
})

test('抑制记录:损坏或缺失时当空表,不抛错(记忆坏了不能连累写入)', () => {
  const root = tmpRoot()
  assert.deepEqual(readRejected(root), {}, '文件不存在')
  fs.writeFileSync(path.join(root, '.rejected.json'), '{ this is not json')
  assert.deepEqual(readRejected(root), {}, '损坏的 JSON')
  fs.writeFileSync(path.join(root, '.rejected.json'), '[1,2,3]')
  assert.deepEqual(readRejected(root), {}, '不是对象')
})

test('抑制记录:重复记同一个哈希是幂等的', () => {
  const root = tmpRoot()
  addRejected(root, 'abc', '2026-10-10')
  addRejected(root, 'abc', '2026-10-11')
  assert.equal(readRejected(root).abc, '2026-10-10', '已存在则不改写')
})

test('pending:提升后条目真的进了常驻段(端到端,不只是文件内容对)', () => {
  const root = tmpRoot()
  const probe = 'zzqpromoteprobe'
  const r = writePending(root, { entry: `- ${probe} [source: dsh://x; added: 2026-10-10]`, reason: '测试', date: '2026-10-10' })
  promotePending(root, r.rel, { date: '2026-10-10' })
  const docs = collectDocuments(root)
  assert.ok(searchDocuments(docs, probe, 5).length > 0, '提升后必须能被检索到')
})
