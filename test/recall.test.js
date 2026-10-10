// recall.test.js
//
// 检索质量回归。语料 = `test/fixtures/memory/`,由 `tools/make-fixture.mjs` **生成**。
//
// ── 语料为什么是生成的,不是提交的 ──
// 夹具原本是**真实记忆仓的逐字节快照**,含个人数据。本仓是**公开仓** ⇒
// 真实语料不进版本控制,改由生成器产出合成语料。`npm test` 跑的是合成语料,任何人 clone 后可复现。
//
// ⚠ 2026-10-10:上一版生成器只换了**标识符**(币种/数字/出处),**规则文本是真实记忆原文**
// (实测 28 条里 4 条逐字相同 + 6 条只截了尾巴)⇒ 等于把真实交易纪律放进了公开仓。
// 本版改成**完全虚构的领域(家庭水族箱养护)**,连路径一起换,故下面的提问也换成水族箱主题。
// 检索算法与领域无关 —— 换领域不影响这些判据对**检索质量**的判别力。
//
// 想在**真实**语料上看检索质量,用 `node tools/recall-report.mjs`(默认读 `~/.dsh/memory`)。
// README 里引用的真实数字来自那个脚本,不是来自本文件。
//
// 判据:
//   C1 正向集 top-1 命中率 >= 7/8。  (合成语料实测 8/8,留一格余量)
//   C2 负向集 top-1 分数均值必须**低于**正向集。
//   C3 反空转:语料非空、两个查询集非空、正向集确实产生命中。
//   C4 README.md **不进检索语料**(它是「记忆系统本身的说明」,不是记忆内容;
//      不排除时它靠元词汇在多个查询里抢 top-1)。
//
// ⚠ 已知局限(在**真实**语料上实测):分数分布**重叠**(正向最低 1 / 负向最高 2)
//   ⇒ **无法用阈值切分**。合成语料上分布恰好可分(正 2 / 负 1),所以**别拿合成语料
//   的可分性当作可以加阈值的依据** —— 那是语料差异,不是算法性质。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { collectDocuments, searchDocuments } from '../lib/memory-store.mjs'

const CORPUS = path.join(import.meta.dirname, 'fixtures', 'memory')

/** 正向集:[自然语言提问, 期望的 top-1 文件] —— 答案确实在记忆语料里 */
const POSITIVE = [
  ['哪些品种不能混养', 'aquarium/tank-rules.md'],
  ['我的换水纪律是什么', 'aquarium/tank-rules.md'],
  ['临时照片怎么命名', 'preferences/log-style.md'],
  ['怎么升级灯盘', 'equipment/filter-pitfalls.md'],
  ['改滤材有什么坑', 'equipment/filter-pitfalls.md'],
  ['当前鱼缸主线是什么', 'MEMORY.md'],
  ['断电后温控器会怎样', 'equipment/filter-pitfalls.md'],
  ['停电后能用继电器吗', 'equipment/filter-pitfalls.md'],
]

/** 负向集:记忆语料里根本没有的主题 */
const NEGATIVE = [
  '怎样避免过度工程',
  'Python 的 GIL 是什么',
  'React 的 useEffect 依赖数组',
  '如何配置 Nginx 反向代理',
  'Docker 镜像分层原理',
  '怎样做红烧肉',
  'Kubernetes 的 Pod 调度',
  'Rust 的所有权模型',
]

const docs = () => collectDocuments(CORPUS)
const top1 = (q) => searchDocuments(docs(), q, 5)[0]

test('C0 语料存在(夹具是生成的,不是提交的)', () => {
  const rels = docs().map((d) => d.rel)
  assert.ok(
    rels.length >= 4,
    '语料不足 4 篇 —— 夹具缺失或过期时先跑 `node tools/make-fixture.mjs`,实际: ' + JSON.stringify(rels)
  )
})

test('C3 反空转:语料与两个查询集都非空', () => {
  assert.ok(docs().length >= 4, '语料至少 4 篇')
  assert.ok(POSITIVE.length >= 8, '正向集至少 8 问')
  assert.ok(NEGATIVE.length >= 5, '负向集至少 5 问')
  assert.ok(POSITIVE.every(([q]) => top1(q)), '正向集必须都能产生命中')
})

test('C4 README.md 不进检索语料(但它仍可被 memory_read 读到)', () => {
  const rels = docs().map((d) => d.rel)
  assert.ok(!rels.includes('README.md'), 'README 不该被索引,实际: ' + JSON.stringify(rels))
})

test('C1 正向集 top-1 命中率 >= 7/8', () => {
  const misses = []
  for (const [q, want] of POSITIVE) {
    const hit = top1(q)
    if (!hit || hit.doc.rel !== want) misses.push(`${q} → ${hit ? hit.doc.rel : '(空)'},期望 ${want}`)
  }
  const rate = (POSITIVE.length - misses.length) / POSITIVE.length
  assert.ok(
    rate >= 7 / 8,
    `top-1 命中率 ${(rate * 100).toFixed(1)}% 低于 87.5%;未命中:\n  ${misses.join('\n  ')}`
  )
})

test('C2 正向集 top-1 分数均值高于负向集', () => {
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
  const pos = mean(POSITIVE.map(([q]) => top1(q).score))
  const neg = mean(NEGATIVE.map((q) => (top1(q)?.score ?? 0)))
  assert.ok(pos > neg, `正向均值 ${pos} 未高于负向均值 ${neg}`)
})

test('已知局限:负向查询会产生非零噪声 ⇒ 别加分数阈值', () => {
  // 真实语料上实测:正向最低 1 / 负向最高 2 —— 分布**重叠**,任何阈值都会误杀正向。
  // 这里不锁「重叠」(合成语料恰好可分),只锁「**存在噪声**」这个更弱、但两种语料都成立的事实:
  // 若负向全是 0 分,「无命中」本身就能当判据,也就没人会想去加阈值了。
  //
  // ⚠ 2026-10-10 阶段 D 更新:加了单字符停用词过滤后,夹具噪声从 3 降到 **2**。
  // 剩下的两条是**语义**巧合(「避免」「镜像」在无关义项上出现),词法手段修不掉 ——
  // 那需要 embedding,属**明确不做**的项。所以这里只锁「还有噪声」,不锁具体条数。
  const noisy = NEGATIVE.filter((q) => (top1(q)?.score ?? 0) > 0)
  assert.ok(
    noisy.length >= 2,
    `负向集只有 ${noisy.length}/${NEGATIVE.length} 条产生噪声 —— 若真的全是 0,` +
      `说明语料或打分器变了,需要重新评估「不能加阈值」这个结论`
  )
  // ⚠ 反向断言:噪声**不能**来自单字符停用词。若某天噪声全是「的」这类碎片,
  // 说明单字符过滤被改坏了 —— 那才是真缺陷,不是「已知局限」。
  assert.equal(
    NEGATIVE.some((q) => /(^|\s)[的了和是在有](\s|$)/.test(q) && (top1(q)?.score ?? 0) > 0),
    false,
    '单字符停用词不该再制造命中'
  )
})
