// 题集加载:供 `tools/benchmark.mjs` 与 `tools/recall-report.mjs` 共用。
//
// ⚠⚠ **本仓是公开仓(AGENTS.md 硬规则 8):真实记忆语料永远不进版本控制。**
// 所以「提问 + 期望命中文件」这张表**不能硬编码在源码里** ——
// 提问本身就会泄露记忆仓的主题(2026-10-10 实测:本文件上一版的注释里
// 为了说明这一点,**把真实提问原样引用了** —— 那是**二次泄漏**。已删,
// 本条只描述现象,不复述内容。同类错误在本仓犯过三次,详见 AGENTS.md)。
//
// 三种来源,优先级从高到低:
//   1. `--questions <json>` 显式指定(**文件必须在仓库外**);
//   2. `<记忆根>/.bench-questions.json`(通用约定位置,见下);
//   3. **自动派生** —— 从记忆根自身推出,源码零真实内容,但**判别力弱**(见下)。
//
// 题集 JSON 形状:
//   [{ "q": "自然语言提问", "want": "path/in/root.md", "answer": "期望答案里的关键串" }]
//   `answer` 可选;给了才能算「答案是否已在注入段/AGENTS.md 里」这类增量价值指标。
//
// ── 为什么第 3 种判别力弱(2026-10-10 实测) ──
// 自动派生出的「提问」是文档里的**原文字符串**(`## 标题`、索引里的主题名),
// 连朴素子串匹配都能命中 ⇒ 实测三臂给出完全相同的分数(82.4% ×3),测不出算法差异。
// ⇒ 它只能当**冒烟**(确认脚本能跑通、语料非空),**不能**用来比较检索算法优劣。

import fs from 'node:fs'
import path from 'node:path'

/** 负向集:与记忆无关的通用主题。**不含任何真实内容**,可安全入库。 */
export const NEGATIVE = [
  '怎样避免过度工程',
  'Python 的 GIL 是什么',
  'React 的 useEffect 依赖数组',
  '如何配置 Nginx 反向代理',
  'Docker 镜像分层原理',
  '怎样做红烧肉',
  'Kubernetes 的 Pod 调度',
  'Rust 的所有权模型',
]

/**
 * 题集的**约定位置**(通用机制:放记忆根里,不进本仓)。
 * ⚠ 本机**已不用它** —— 题集挪到了记忆仓外(见 AGENTS.md 验证命令段),
 * 因为记忆仓不该放测试夹具。这个约定对别的记忆根仍有效,故保留。
 */
export const QUESTIONS_BASENAME = '.bench-questions.json'

/**
 * 从记忆根自动派生题集。源码零真实内容,但判别力弱(见文件头)。
 * @returns {{questions: Array, broken: Array}} broken = 索引指向的文件根本不在语料里
 */
export function deriveQuestions(docs, indexText) {
  const questions = []
  const broken = []
  const seen = new Set()
  const push = (q, want, origin) => {
    const key = `${q}\u0000${want}`
    if (!q || !want || seen.has(key)) return
    seen.add(key)
    questions.push({ q, want, origin })
  }
  const has = (rel) => docs.some((d) => d.rel === rel)

  // Q1:索引指向题。`- <主题> → `path`` / `- <主题> → **path**`
  for (const line of indexText.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*(.+?)\s*(?:→|->)\s*[`*]*([^\s`*]+\.md)[`*]*/)
    if (!m) continue
    const theme = m[1].replace(/[`*]/g, '').replace(/（[^）]*）|\([^)]*\)/g, '').trim()
    const want = m[2].replace(/^\.\//, '')
    // 索引指向的文件必须真的在语料里,否则这条引用本身就是坏的 —— 报出来,不静默跳过。
    if (!has(want)) { broken.push({ q: theme, want }); continue }
    push(theme, want, '索引指向题')
  }

  // Q2:标题题。标题必须在全仓唯一,否则无法判定期望文档。
  const owners = new Map()
  for (const d of docs) {
    if (d.rel === 'MEMORY.md') continue
    for (const line of d.text.split(/\r?\n/)) {
      const m = line.match(/^##\s+(.+?)\s*$/)
      if (!m) continue
      const h = m[1].replace(/[`*]/g, '').trim()
      if (h.length < 2 || h.length > 24) continue // 太短会歧义,太长不像查询
      if (!owners.has(h)) owners.set(h, new Set())
      owners.get(h).add(d.rel)
    }
  }
  for (const [h, set] of owners) {
    if (set.size !== 1) continue // 多篇同名标题 ⇒ 判不了
    push(h, [...set][0], '标题题')
  }

  return { questions, broken }
}

/**
 * 按优先级加载题集。
 * @param {object} opts
 * @param {Array} opts.docs - collectDocuments 的结果(自动派生时要用)
 * @param {string} opts.indexText - MEMORY.md 全文(自动派生时要用)
 * @param {string} [opts.explicit] - `--questions` 的值
 * @param {string} opts.root - 记忆根(找约定位置的题集)
 * @returns {{questions: Array, source: string, broken: Array}}
 */
export function loadQuestions({ docs, indexText, explicit, root }) {
  const read = (p) => {
    const raw = JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'))
    if (!Array.isArray(raw) || raw.length === 0) throw new Error(`题集为空或不是数组: ${p}`)
    return raw.map((x) => ({ ...x, origin: path.basename(p) }))
  }

  if (explicit) {
    return { questions: read(explicit), source: `显式题集 ${path.resolve(explicit)}`, broken: [] }
  }

  const conventional = path.join(root, QUESTIONS_BASENAME)
  if (fs.existsSync(conventional)) {
    return { questions: read(conventional), source: `约定位置题集 ${conventional}`, broken: [] }
  }

  const { questions, broken } = deriveQuestions(docs, indexText)
  return {
    questions,
    source: '自动派生(索引指向题 + 全仓唯一标题题)—— ⚠ 判别力弱,只能当冒烟',
    broken,
  }
}
