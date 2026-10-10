// dsh-memory 性能基准:把「每轮开销 / 检索质量 / 工具延迟 / 预算覆盖率」测成可复现的数字。
//
// 用法:
//   node tools/benchmark.mjs                              # 默认 ~/.dsh/memory
//   node tools/benchmark.mjs <记忆根>                      # 指定记忆根
//   node tools/benchmark.mjs <记忆根> --cwd <会话目录>      # 指定「会话 cwd」用于算与 AGENTS.md 的重叠
//   node tools/benchmark.mjs <记忆根> --questions <json>   # 用人工策展的题集(**文件须在仓库外**)
//
// ⚠⚠ 本仓是**公开仓**(硬规则 8):真实记忆语料永远不进版本控制。
// 所以题集**不硬编码在源码里**;加载逻辑见 `tools/questions.mjs`
// (优先 `--questions` / `<记忆根>/.bench-questions.json`,否则自动派生 —— 后者判别力弱)。
//
// ⚠ 本工具**只读**,不写任何记忆文件;不联网;不调 LLM。
//
// 设计取舍(为什么测这几项):
//   - 插件的全部价值 = 「每轮花很少 token,换来跨会话事实可用」。所以核心是
//     ① 每轮注入开销(成本)与 ④ 索引覆盖面(收益);
//   - ② 检索质量必须给**基线**,否则「90% top-1」是个没有参照的数字;
//   - ③ 工具延迟是 `memory_search` 的真实成本 —— 它每次都要**遍历并读取整个记忆仓**;
//   - ⑥ 与 AGENTS.md 的重复度决定**增量价值** —— 重复的部分不能算作插件的功劳。
//
// ⚠ **本工具不测「模型级 A/B(装 vs 不装的答案质量差)」**:所有子代理的系统提示词
// 都已含该注入段,拿不到干净的「无记忆」对照臂。模型级对照见
// `Desktop/DeepSeekHarness/docs/known-issues.md` 与 `notes/`。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const STORE = pathToFileURL(path.join(HERE, '..', 'lib', 'memory-store.mjs')).href
const {
  DEFAULT_INDEX_MAX_BYTES,
  DEFAULT_INDEX_MAX_LINES,
  collectDocuments,
  composeSection,
  readWithinRoot,
  searchDocuments,
  tokenize,
} = await import(STORE)
const { NEGATIVE, loadQuestions } = await import(pathToFileURL(path.join(HERE, 'questions.mjs')).href)

// 参数:第一个非 `--xxx` 的位置参数是记忆根;`--cwd <dir>` 指定「会话 cwd」用于算重叠度。
const argv = process.argv.slice(2)
const flagVal = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')))
const ROOT = path.resolve(positional[0] || path.join(os.homedir(), '.dsh', 'memory'))
const INDEX_FILE = path.join(ROOT, 'MEMORY.md')

// ---------------------------------------------------------------- 题集
//
// ⚠⚠ **本仓是公开仓(硬规则 8):真实记忆语料永远不进版本控制。**
// 所以「提问 + 期望命中文件」这张表**不能硬编码在源码里** —— 提问本身就会泄露记忆仓的主题。
//
// 加载逻辑抽到 `tools/questions.mjs`,两种来源:
//   ① `--questions <json>` 或 `<记忆根>/.bench-questions.json`(人工策展,**文件在仓库外**);
//   ② 自动派生(从记忆根自身推出,源码零真实内容,但**判别力弱,只能当冒烟**)。
// 详见该文件头部 —— 包括「为什么自动派生测不出算法差异」的实测。
const questionsArg = flagVal('--questions')
let QUESTIONS = []
let questionSource = '(未加载)'
let questionBroken = []

// ---------------------------------------------------------------- 两个基线
//
// ⚠ **基线不能是稻草人。** 只拿「整条查询当子串」比,会得到一个漂亮但没意义的对比 ——
// 没人会那样写。所以给两条:
//
//   B1 朴素子串:重写**之前**的真实实现(留出集通过率 20.0%,
//      见 notes/research-agent-memory-2026-10-09.md §9)。属**历史基线**,用于对齐旧数字。
//   B2 关键词 OR:一个**称职开发者**最可能写出来的版本 —— 按空白切词、任一命中即算。
//      **这条才是公平基线**,B1 只作历史参照。

function naiveSubstring(docs, q) {
  const needle = String(q ?? '').trim().toLowerCase()
  if (!needle) return []
  const out = []
  for (const d of docs) {
    const hay = (d.rel + '\n' + d.text).toLowerCase()
    if (!hay.includes(needle)) continue
    out.push({ doc: d, score: 1, snippet: d.text.split(/\r?\n/).find((l) => l.toLowerCase().includes(needle)) ?? '' })
  }
  return out
}

function keywordOr(docs, q) {
  // 按空白与常见分隔切词;ASCII 不分大小写。命中数即为分数。
  const terms = String(q ?? '').toLowerCase().split(/[\s,，。、;；:：!！?？()（）\[\]「」【】/]+/).filter((t) => t.length > 0)
  if (terms.length === 0) return []
  const out = []
  for (const d of docs) {
    const hay = (d.rel + '\n' + d.text).toLowerCase()
    let score = 0
    for (const t of terms) if (hay.includes(t)) score++
    if (score === 0) continue
    out.push({ doc: d, score, snippet: d.text.split(/\r?\n/).find((l) => terms.some((t) => l.toLowerCase().includes(t))) ?? '' })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

// ---------------------------------------------------------------- 计时
const timeIt = (fn, iterations) => {
  fn() // 预热
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < iterations; i++) fn()
  const t1 = process.hrtime.bigint()
  return Number(t1 - t0) / 1e6 / iterations
}

/** 粗略 token 估算:ASCII ≈ 4 字符/token,CJK ≈ 1 字符/token。仅用于量级对比。 */
const estTokens = (s) => {
  const cjk = (s.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length
  const rest = s.length - cjk
  return Math.round(cjk + rest / 4)
}

const pct = (n, d) => `${((n / d) * 100).toFixed(1)}%`
const B = (n) => `${n} B`

// ================================================================ 开跑
console.log(`记忆根: ${ROOT}`)
if (!fs.existsSync(INDEX_FILE)) {
  console.error(`✖ 找不到 ${INDEX_FILE} —— 不是有效的记忆仓`)
  process.exit(2)
}

const indexText = fs.readFileSync(INDEX_FILE, 'utf8')
const docs = collectDocuments(ROOT)
const corpusBytes = docs.reduce((a, d) => a + Buffer.byteLength(d.text, 'utf8'), 0)
const corpusLines = docs.reduce((a, d) => a + d.text.split(/\r?\n/).length, 0)

console.log(`语料: ${docs.length} 文件 / ${B(corpusBytes)} / ${corpusLines} 行`)
console.log(`索引: ${INDEX_FILE.replace(ROOT, '.')} = ${B(Buffer.byteLength(indexText, 'utf8'))} / ${indexText.split(/\r?\n/).length} 行`)

{
  const loaded = loadQuestions({ docs, indexText, explicit: questionsArg, root: ROOT })
  QUESTIONS = loaded.questions
  questionSource = loaded.source
  questionBroken = loaded.broken
}
console.log(`题集: ${questionSource}`)
console.log(`      实际可用 ${QUESTIONS.length} 条(负向 ${NEGATIVE.length} 条)`)
const broken = questionBroken
if (broken.length) {
  console.log(`  ⚠ 其中 ${broken.length} 条是**索引指向的文件根本不在语料里**(索引自身失修,不是检索错):`)
  broken.forEach((x) => console.log(`      「${x.q}」 → ${x.want}`))
}

// ── 1. 每轮注入开销 ──
console.log('\n' + '═'.repeat(72))
console.log('1. 每轮注入开销(系统提示词装配路径 —— 每个 turn 都跑)')
console.log('═'.repeat(72))

const compose = () => composeSection(fs.readFileSync(INDEX_FILE, 'utf8'), {
  maxLines: DEFAULT_INDEX_MAX_LINES,
  maxBytes: DEFAULT_INDEX_MAX_BYTES,
})
const section = compose()
const secBytes = Buffer.byteLength(section.text, 'utf8')
const secLines = section.text === '' ? 0 : section.text.split(/\r?\n/).length
const secTokens = estTokens(section.text)

const perTurnMs = timeIt(compose, 200)
const fullTokens = estTokens(docs.map((d) => d.text).join('\n'))

console.log(`  注入段        : ${B(secBytes)} / ${secLines} 行 / ≈${secTokens} token`)
console.log(`  装配墙钟      : ${perTurnMs.toFixed(3)} ms/次(200 次均值,含 1 次同步 readFileSync)`)
console.log(`  预算上限      : ${DEFAULT_INDEX_MAX_LINES} 行 / ${B(DEFAULT_INDEX_MAX_BYTES)}`)
console.log(`  预算占用      : ${pct(secLines, DEFAULT_INDEX_MAX_LINES)} 行 · ${pct(secBytes, DEFAULT_INDEX_MAX_BYTES)} 字节`)
console.log('')
console.log('  三种策略的每轮成本对比:')
console.log(`    A 不装插件(无记忆)      : 0 token/轮`)
console.log(`    B 装插件(当前,预算注入) : ≈${secTokens} token/轮   ← 本插件`)
console.log(`    C 注入全部语料(Cline 反模式): ≈${fullTokens} token/轮   (是 B 的 ${(fullTokens / secTokens).toFixed(1)} 倍)`)
console.log(`  ⇒ 预算把每轮成本压到全量注入的 ${pct(secTokens, fullTokens)}`)

// ── 2. 检索质量 A/B ──
console.log('\n' + '═'.repeat(72))
console.log('2. 检索质量 A/B:当前算法 vs 朴素子串基线')
console.log('═'.repeat(72))

const runArm = (searchFn, questionSet) => {
  let top1 = 0
  const misses = []
  for (const c of questionSet) {
    const hits = searchFn(docs, c.q)
    const got = hits[0]?.doc?.rel
    if (got === c.want) top1++
    else misses.push({ q: c.q, want: c.want, got: got ?? '(无命中)' })
  }
  let noise = 0
  for (const q of NEGATIVE) if (searchFn(docs, q).length > 0) noise++
  return { top1, misses, noise }
}

// ⚠ 别把这条写成 `QUESTIONS.length - SCORED.length` —— `SCORED` 就是 `QUESTIONS` 的别名,
// 那个减法**恒等于 0**,输出永远说「已剔除 0 条」,看着正常其实什么都没说。
const SCORED = QUESTIONS

const cur = runArm((d, q) => searchDocuments(d, q, 5), SCORED)
const b1 = runArm(naiveSubstring, SCORED)
const b2 = runArm(keywordOr, SCORED)

console.log(`  正向题 ${SCORED.length} 条(另有 ${broken.length} 条因索引失修被 loadQuestions 剔除,未计入分母),看 **top-1 命中率**:`)
console.log(`    当前算法(tokenize+二元组+字段加权+OR) : ${cur.top1}/${SCORED.length} = ${pct(cur.top1, SCORED.length)}`)
console.log(`    B2 关键词 OR(公平基线)              : ${b2.top1}/${SCORED.length} = ${pct(b2.top1, SCORED.length)}`)
console.log(`    B1 朴素子串(历史基线,重写前实现)     : ${b1.top1}/${SCORED.length} = ${pct(b1.top1, SCORED.length)}`)
console.log(`  ⇒ 对**公平基线** B2 提升 ${cur.top1 - b2.top1} 题;对历史基线 B1 提升 ${cur.top1 - b1.top1} 题`)
console.log('')
console.log(`  负向题 ${NEGATIVE.length} 条(不该有命中),看**噪声**:`)
console.log(`    当前算法: ${cur.noise}/${NEGATIVE.length} 条有噪声`)
console.log(`    B2 关键词 OR: ${b2.noise}/${NEGATIVE.length} 条有噪声`)
console.log(`    B1 朴素子串: ${b1.noise}/${NEGATIVE.length} 条有噪声`)
if (b1.misses.length) {
  console.log('\n  B1 朴素子串漏掉的题(前 4 条):')
  b1.misses.slice(0, 4).forEach((m) => console.log(`    ✖ ${m.q}\n        期望 ${m.want},实际 ${m.got}`))
}
if (b2.misses.length) {
  console.log('\n  B2 关键词 OR 漏掉的题:')
  b2.misses.forEach((m) => console.log(`    ✖ ${m.q}\n        期望 ${m.want},实际 ${m.got}`))
}
if (cur.misses.length) {
  console.log('\n  ⚠ 当前算法仍漏掉的题:')
  cur.misses.forEach((m) => console.log(`    ✖ ${m.q}\n        期望 ${m.want},实际 ${m.got}`))
}

// ── 3. 工具延迟 ──
console.log('\n' + '═'.repeat(72))
console.log('3. 工具延迟(memory_search 每次都要遍历并读取整个记忆仓)')
console.log('═'.repeat(72))

const searchMs = timeIt(() => {
  const d = collectDocuments(ROOT)
  return searchDocuments(d, QUESTIONS[1].q, 5)
}, 50)
const collectMs = timeIt(() => collectDocuments(ROOT), 50)
// ⚠ 别硬编码路径 —— 本仓是公开仓,写真实记忆路径就是把语料结构抄进 git 历史。
// 从语料里取一篇真实存在的文档来计时。
const readMs = timeIt(() => readWithinRoot(ROOT, docs[0].rel), 200)

console.log(`  memory_search 端到端 : ${searchMs.toFixed(3)} ms/次`)
console.log(`    其中 collectDocuments: ${collectMs.toFixed(3)} ms/次 (${pct(collectMs, searchMs)} —— 遍历 + 逐文件读)`)
console.log(`    纯检索打分          : ${(searchMs - collectMs).toFixed(3)} ms/次`)
console.log(`  memory_read          : ${readMs.toFixed(3)} ms/次`)
console.log(`  timeoutMs 声明        : 10000 ms ⇒ 实测占 ${pct(searchMs, 10000)}`)
console.log('')
console.log('  ⚠ 已知局限(硬规则 7):`execute` 是**同步** fs 读,`timeoutMs` **中断不了同步 IO**。')
console.log(`     本仓 ${docs.length} 个文件 ${B(corpusBytes)} 时延迟可忽略;`)
console.log(`     但 collectDocuments 的成本**随文件数线性增长** —— 上限 ${500} 篇时约 ${(searchMs * 500 / Math.max(docs.length, 1)).toFixed(1)} ms/次。`)

// ── 4. 索引覆盖面 ──
console.log('\n' + '═'.repeat(72))
console.log('4. 索引覆盖面:注入的索引段让模型「知道哪些文档存在」')
console.log('═'.repeat(72))

// ⚠ 本节的判据**不含任何真实内容** —— 只看索引段有没有**提到**每篇文档
// (按相对路径,或按文件名主干)。这是「模型知不知道该去读哪个文件」的直接度量。
const mentionOf = (rel) => {
  const stem = rel.replace(/\.md$/, '')
  const base = path.basename(stem)
  return indexText.includes(rel) || indexText.includes(stem) || indexText.includes(base)
}
const mentioned = []
const unmentioned = []
for (const d of docs) {
  if (d.rel === 'MEMORY.md') continue
  ;(mentionOf(d.rel) ? mentioned : unmentioned).push(d.rel)
}
const topicDocs = docs.filter((d) => d.rel !== 'MEMORY.md').length
console.log(`  非索引文档 ${topicDocs} 篇:`)
console.log(`    被索引段提到(模型知道它存在) : ${mentioned.length}/${topicDocs} = ${pct(mentioned.length, topicDocs)}`)
console.log(`    未被提到(只能靠 memory_search 撞) : ${unmentioned.length}/${topicDocs}`)
unmentioned.forEach((r) => console.log(`      ✖ ${r}`))
console.log('')
console.log('  解读:MEMORY.md 是**主题索引 + 当前主线**,不是事实全集。')
console.log('        被提到的文档 ⇒ 模型知道去读;没提到的 ⇒ 只能靠检索碰运气。')

// 题集带 `answer` 时,额外给「答案串在索引段里」的比例(这一项需要真实内容)
// ⚠ 判据是「题集里有没有 answer 字段」,不是「有没有传 --questions」——
//   走约定位置题集(<记忆根>/.bench-questions.json)时同样要算。
let inIndex = 0, needRead = []
if (SCORED.some((c) => c.answer)) {
  for (const c of SCORED) {
    if (c.answer && indexText.includes(c.answer)) inIndex++
    else if (c.answer) needRead.push(c)
  }
  const withAns = SCORED.filter((c) => c.answer).length
  if (withAns) {
    console.log('')
    console.log(`  【题集】答案串直接出现在索引段里 : ${inIndex}/${withAns} = ${pct(inIndex, withAns)}`)
    console.log(`  【题集】需要再调一次 memory_read : ${needRead.length}/${withAns} = ${pct(needRead.length, withAns)}`)
    needRead.forEach((c) => console.log(`    → ${c.q}   (答案在 ${c.want})`))
  }
}

// ── 5. 与「本来就会注入的 AGENTS.md」的重叠度 ──
//
// ⚠ 这是**最容易被忽略、也最决定插件价值**的一项:
// `~/.dsh/AGENTS.md`(全局)与 `<repoRoot>/AGENTS.md`(项目)是 DSH **本来就会每轮注入**的
// 指令通道。如果某个事实它们已经写了,那「记忆插件」对这个事实的**增量价值是 0**。
// 所以真正该问的是:**插件覆盖了多少 AGENTS.md 没写的事实?**
console.log('\n' + '═'.repeat(72))
console.log('5. 增量价值:记忆仓有多少内容其实 AGENTS.md 本来就有(逐行重复度)')
console.log('═'.repeat(72))

// 对照的注入文件必须按 DSH 的**实际分层规则**取:
//   ~/.dsh/AGENTS.md(全局)→ 会话 cwd 各层(含 .git 的项目根是最关键的一层)
// ⚠ 不能用 process.cwd() —— 在插件目录里跑会把 `plugins/dsh-memory/AGENTS.md`
// 误算进去(那个只在 cwd 落在该目录时才注入),从而**低估**重叠度。
const findRepoRoot = (start) => {
  let cur = path.resolve(start)
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur
    const up = path.dirname(cur)
    if (up === cur) return null
    cur = up
  }
}

const cwdArg = path.resolve(flagVal('--cwd') || process.cwd())
const repoRoot = findRepoRoot(cwdArg)
const INJECTED = [
  path.join(os.homedir(), '.dsh', 'AGENTS.md'),
  repoRoot ? path.join(repoRoot, 'AGENTS.md') : null,
  path.join(cwdArg, 'AGENTS.md'),
].filter((f) => f && fs.existsSync(f))
  .filter((f, i, a) => a.indexOf(f) === i) // 去重

const injectedText = INJECTED.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
const injectedLower = injectedText.toLowerCase() // 题干级:子串匹配(跨行也能命中)
const injectedNorm = new Set(
  injectedText.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l.length >= 8),
)
console.log(`  对照的注入文件(${INJECTED.length} 个,共 ${B(Buffer.byteLength(injectedText, 'utf8'))}):`)
INJECTED.forEach((f) => console.log(`    ${f}`))
console.log('')

// 逐行重复度:记忆文档的正文行有多少**逐字**出现在 AGENTS.md 里。
// 判据只做「这行是否重复」的计数,**不打印任何行内容** —— 本文件是公开仓的一部分。
let dupTotal = 0, dupHit = 0
const dupRows = []
for (const d of docs) {
  const lines = d.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 8)
  if (lines.length === 0) continue
  const hit = lines.filter((l) => injectedNorm.has(l.toLowerCase())).length
  dupTotal += lines.length
  dupHit += hit
  dupRows.push({ rel: d.rel, lines: lines.length, hit, ratio: hit / lines.length })
}
console.log(`  逐行重复度(记忆仓正文行 vs AGENTS.md 行):`)
console.log(`    ${'文档'.padEnd(30)} ${'正文行'.padStart(6)} ${'重复'.padStart(6)} ${'占比'.padStart(8)}`)
for (const r of dupRows) {
  console.log(`    ${r.rel.padEnd(30)} ${String(r.lines).padStart(6)} ${String(r.hit).padStart(6)} ${pct(r.hit, r.lines).padStart(8)}`)
}
console.log(`    ${'合计'.padEnd(30)} ${String(dupTotal).padStart(6)} ${String(dupHit).padStart(6)} ${pct(dupHit, dupTotal).padStart(8)}`)
console.log('')
console.log('  ⚠ **逐行重复度测不出「换个说法重述同一事实」。** 实测:逐行重复 0.0%,')
console.log('     而同一批事实按**题干级**判据有相当比例已在 AGENTS.md 里(见下,**以下面的实算值为准**)。')
console.log('     所以逐行这条只能证明「没有逐字抄袭」,不能用来判增量价值。')
console.log('     ⚠ 别在这里写死一个比例 —— 题集一换就过期,而写死的数字没人会回来改。')

if (SCORED.some((c) => c.answer)) {
  const withAns = SCORED.filter((c) => c.answer)
  const overlap = withAns.filter((c) => injectedLower.includes(c.answer.toLowerCase()))
  const incremental = withAns.filter((c) => !injectedLower.includes(c.answer.toLowerCase()))
  console.log('')
  console.log(`  【题干级 · 主指标】答案串已在 AGENTS.md 里 ⇒ 插件增量价值 0 : ${overlap.length}/${withAns.length} = ${pct(overlap.length, withAns.length)}`)
  console.log(`  【题干级 · 主指标】答案 AGENTS.md 没有 ⇒ 插件真增量     : ${incremental.length}/${withAns.length} = ${pct(incremental.length, withAns.length)}`)
  if (overlap.length) {
    console.log('    重叠的题(⚠ 这些不能算作插件的功劳):')
    overlap.forEach((c) => console.log(`      = ${c.q}`))
  }
  if (incremental.length) {
    console.log('    真增量的题:')
    incremental.forEach((c) => console.log(`      + ${c.q}   (在 ${c.want})`))
  }
  console.log('')
  console.log('  ⇒ **衡量插件效果时必须以这组为准** —— 重叠的那些用户早就从 AGENTS.md 拿到了。')
} else {
  console.log('')
  console.log('  ⚠ 未给 `--questions`,**题干级增量价值无法计算**(它需要期望答案串)。')
  console.log('     要拿到这一项,用 `--questions` 传一个仓库外的题集。')
}
console.log('')
console.log('  解读:重叠的那些**不是缺陷** —— 主题文件按设计就是「版本化的运维事实副本」')
console.log('        (`~/.dsh/AGENTS.md` 不在任何 git 仓里,所以需要一份可版本化的副本),')
console.log('        且它们**不占每轮预算**(只按需 memory_read)。')

// ── 7. 分词规模 ──
console.log('\n' + '═'.repeat(72))
console.log('6. 分词规模(检索打分的输入规模)')
console.log('═'.repeat(72))
const qTok = SCORED.map((c) => tokenize(c.q).length)
console.log(`  查询分词数: 平均 ${(qTok.reduce((a, b) => a + b, 0) / Math.max(qTok.length, 1)).toFixed(1)},最大 ${Math.max(...qTok)}`)
console.log(`  单文档打分是 O(token数 × 文档长度),本仓规模下无需索引结构。`)

console.log('\n' + '═'.repeat(72))
console.log('汇总')
console.log('═'.repeat(72))
console.log(`  每轮成本      : ≈${secTokens} token(全量注入需 ≈${fullTokens},压到 ${pct(secTokens, fullTokens)})`)
console.log(`  每轮延迟      : ${perTurnMs.toFixed(3)} ms`)
console.log(`  检索 top-1    : ${pct(cur.top1, SCORED.length)}(公平基线 B2 ${pct(b2.top1, SCORED.length)},提升 ${cur.top1 - b2.top1} 题;n=${SCORED.length})`)
console.log(`  工具延迟      : search ${searchMs.toFixed(2)} ms / read ${readMs.toFixed(2)} ms`)
console.log(`  索引覆盖面    : ${pct(mentioned.length, topicDocs)} 篇文档被索引段提到`)
console.log(`  与 AGENTS.md 逐行重复: ${pct(dupHit, dupTotal)}`)
console.log('')
console.log('  ⚠ 未测:**模型级 A/B(装 vs 不装的答案质量差)** ——')
console.log('     所有子代理的系统提示词都已含该注入段,本工具拿不到干净的「无记忆」对照臂。')
console.log('     硬造只会得到一个被污染的数字。模型级对照见 notes/ 与 docs/known-issues.md。')

