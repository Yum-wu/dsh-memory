// 对**任意**记忆根跑一次检索质量报告。
//
// 用途:真实语料(`~/.dsh/memory`)含个人数据、**不进版本控制**,
// 所以 `npm test` 只能测合成语料(`test/fixtures/memory/`,由 tools/make-fixture.mjs 生成)。
// 想在真实语料上看检索质量,用本脚本 —— README 里引用的实测数字来自这里。
//
// 用法:
//   node tools/recall-report.mjs                    # 默认 ~/.dsh/memory
//   node tools/recall-report.mjs <记忆根路径>
//   node tools/recall-report.mjs <记忆根路径> --questions <json>   # 指定题集(**文件须在仓库外**)
//
// ⚠⚠ 本仓是**公开仓**(硬规则 8):真实记忆语料永远不进版本控制。
// 所以「提问 + 期望命中文件」这张表**不硬编码在这里** —— 提问本身就会泄露记忆仓的主题
// (2026-10-10 修:本文件此前硬编码了 8 条真实提问与真实路径,已抽出)。
// 加载优先级见 `tools/questions.mjs`:
//   ① `--questions <json>`;② `<记忆根>/.bench-questions.json`;③ 自动派生(判别力弱,只能当冒烟)。
//
// 输出:每个查询的 top-3 命中与分数,末尾给正向集 top-1 命中率。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { collectDocuments, searchDocuments } from '../lib/memory-store.mjs'
import { NEGATIVE, loadQuestions } from './questions.mjs'

const argv = process.argv.slice(2)
const flagVal = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}
const questionsArg = flagVal('--questions')
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')))

const root = path.resolve(positional[0] || path.join(os.homedir(), '.dsh', 'memory'))
if (!fs.existsSync(root)) {
  console.error(`记忆根不存在: ${root}`)
  process.exit(1)
}

const docs = collectDocuments(root)
const indexFile = path.join(root, 'MEMORY.md')
const indexText = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : ''
const { questions: POSITIVE, source, broken } = loadQuestions({ docs, indexText, explicit: questionsArg, root })

console.log(`记忆根: ${root}`)
console.log(`语料: ${docs.length} 篇 —— ${docs.map((d) => d.rel).join(', ')}`)
console.log('(README.md 按设计不进检索语料)')
console.log(`题集: ${source}(${POSITIVE.length} 条)\n`)

if (broken.length) {
  console.log(`⚠ ${broken.length} 条索引指向的文件不在语料里(索引自身失修,不是检索错):`)
  broken.forEach((b) => console.log(`    「${b.q}」 → ${b.want}`))
  console.log('')
}

if (!POSITIVE.length) {
  console.error('题集为空 —— 给 `--questions <json>` 或写一份 <记忆根>/.bench-questions.json')
  process.exit(1)
}

let hit = 0
console.log('── 正向集 ──')
for (const { q, want } of POSITIVE) {
  const hits = searchDocuments(docs, q, 3)
  const top = hits[0]
  const ok = top && top.doc.rel === want
  if (ok) hit++
  console.log(`  ${ok ? '✔' : '✖'} ${q}`)
  console.log(`      期望 ${want} / 实际 ${top ? top.doc.rel + ' (' + top.score + ')' : '(空)'}`)
  hits.slice(1).forEach((h) => console.log(`        · ${h.doc.rel} (${h.score})`))
}

console.log('\n── 负向集(不该有高置信命中)──')
const negScores = []
for (const q of NEGATIVE) {
  const hits = searchDocuments(docs, q, 3)
  const top = hits[0]
  negScores.push(top?.score ?? 0)
  console.log(`  ${top ? '·' : '○'} ${q} → ${top ? top.doc.rel + ' (' + top.score + ')' : '(空)'}`)
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
const posScores = POSITIVE.map(({ q }) => searchDocuments(docs, q, 3)[0]?.score ?? 0)
console.log(`\n正向集 top-1 命中率: ${hit}/${POSITIVE.length} = ${((hit / POSITIVE.length) * 100).toFixed(1)}%`)
console.log(`top-1 分数均值: 正向 ${mean(posScores).toFixed(2)} / 负向 ${mean(negScores).toFixed(2)}`)
console.log(`分布重叠: 正向最低 ${Math.min(...posScores)} / 负向最高 ${Math.max(...negScores)}` +
  (Math.max(...negScores) >= Math.min(...posScores) ? ' ⇒ **无法用阈值切分**' : ' ⇒ 可分,可考虑加阈值'))
