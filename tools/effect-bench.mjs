#!/usr/bin/env node
// 模型级效果基准:记忆插件到底有没有让模型的回答变好?
//
// ⚠⚠ 为什么需要这个工具(以及它推翻了什么)
//   `benchmark.mjs` 测的是**检索命中率**。检索准 ≠ 回答好 —— 那是两件事。
//   此前本仓在台账里写过「模型级 A/B 测不出来」,理由是「所有子代理的系统提示词都含记忆注入段,
//   拿不到干净的无记忆对照臂」。**那个结论只对 DSH 子代理成立,不对直连 API 成立。**
//   DSH 子代理拿不到干净臂是真的;但**直连 LLM 端点**时,提示词完全由本脚本构造
//   ⇒ 可以造出**逐字节干净的零记忆臂**。这个工具就是那么做的。
//
// 三臂设计(两两对照,各自分离一个变量)
//
//   臂 0  零记忆      : 只给问题。**不注入任何记忆**。← 此前缺失的那个基线
//   臂 A  索引单独    : 注入常驻段(与真实运行时逐字节相同的那 27 行)。禁工具。
//   臂 B  索引 + 工具 : 由 DSH 子代理跑(本脚本**不覆盖**,见下)
//
//   臂0 vs 臂A  ⇒ 分离「常驻索引」的贡献
//   臂A vs 臂B  ⇒ 分离「检索工具」的贡献
//
// ⚠ 臂 B 为什么不在这里:它要真的调 `memory_search` / `memory_read`,那是 agent 循环,
//   不是一次 chat completion。本脚本**不伪造**它 —— 臂 B 仍由父会话手工派子代理跑,
//   结果并回报告。**宁可少一个臂,不要一个假臂。**
//
// 判分:不用 LLM-as-judge
//   每道题的 ground truth 是一个**字符串**(该事实在记忆里的关键串)。命中即对。
//   理由:LLM-as-judge 有位置偏置/长度偏置/自我偏好,而本任务有**客观**答案
//   ⇒ 用 LLM 判分是自找偏置。能自动判的绝不用模型判。
//
// ⚠ 判分前先剥离「不知道」类回答:那**不算对**。零记忆臂的典型失败模式是
//   「我无法确定」而不是「自信地编」—— 前者必须计为错,否则会虚高基线。
//
// 用法
//   node tools/effect-bench.mjs --questions <仓库外 json> [--endpoint URL] [--model M]
//                               [--repeat 1] [--root ~/.dsh/memory] [--json]
//
// ⚠ 题集**必须放在仓库外**。本仓是公开仓(硬规则 8),题面与 ground truth 都是语料。

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { composeSection, collectDocuments, STATIC_NONCE } from '../lib/memory-store.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const asJson = args.includes('--json');

const ROOT = opt('--root', path.join(os.homedir(), '.dsh', 'memory'));
const ENDPOINT = opt('--endpoint', 'http://127.0.0.1:10100/v1/chat/completions');
// ⚠ 别用 shangtang/* —— 实测 429,限流敏感路由。
const MODEL = opt('--model', 'google-antigravity/gemini-3.8-flash');
const REPEAT = Number(opt('--repeat', '1'));
const MAX_TOKENS = Number(opt('--max-tokens', '2000'));
const QUESTIONS = opt('--questions', '');
const TIMEOUT_MS = Number(opt('--timeout-ms', '120000'));
// ⚠ 默认 0.7 + 3 次多数投票,不是 0 + 1 次。
//   理由:闭卷预筛要能**暴露**基座「偶尔蒙对」——temperature=0 时模型没有随机性,
//   蒙对也只会蒙对一次,筛不出「这题其实有常识捷径」。
//   代价:3× 请求量。小样本下这个代价必须付,否则单次采样不可复现(见文件头)。
const TEMPERATURE = Number(opt('--temperature', '0.7'));
const ARMS = opt('--arms', 'arm0,armA').split(',').map((s) => s.trim()).filter(Boolean);

if (!QUESTIONS || !existsSync(QUESTIONS)) {
  console.error('缺少 --questions <仓库外 json>。题集不得进本仓(硬规则 8)。');
  process.exit(2);
}

// ───────────────────────────────────────────── 题集

function loadQuestions(file, limit = 0) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  let list = Array.isArray(raw) ? raw : raw.questions;
  if (!Array.isArray(list) || list.length === 0) throw new Error('题集为空或形状不对');
  if (limit > 0) list = list.slice(0, limit);
  return list.map((q, i) => {
    const question = q.q ?? q.question;
    // ground truth:优先用显式 answer;没有就退回「期望文件里的关键串」
    const truth = q.answer ?? q.truth ?? q.want ?? '';
    // oracle 臂要用的「正确答案所在的那篇文档」
    const want = q.want ?? q.doc ?? '';
    if (!question || !truth) throw new Error(`第 ${i + 1} 题缺 q 或 answer`);
    return { question, truth: String(truth), want: String(want), id: q.id ?? `q${i + 1}` };
  });
}

// ───────────────────────────────────────────── 提示词构造

/**
 * 安慰剂段:与常驻索引段**等长**、格式相同、但领域完全无关的虚构文本。
 *
 * ⚠ 为什么需要它(不是洁癖):把「有记忆」和「什么都没有」比,分不清
 *   ①记忆内容有效 ②提示词凭空多了 552 token 这件事本身影响了输出。
 *   长上下文会让注意力稀释、改变输出措辞与长度 —— 这是有实测支撑的现象
 *   (Liu et al. 2023, "Lost in the Middle", arXiv:2307.03172)。
 *   安慰剂臂把「长度/格式干扰」与「记忆语义有效性」解耦:
 *     臂0 vs 臂P  ⇒ 纯长度效应(理论上应≈0)
 *     臂P vs 臂A  ⇒ **记忆内容的净效应**(这才是要报的数)
 *
 * ⚠ 文本必须**完全虚构**、且与本机真实事实零重合(硬规则 8 的推论)。
 *   这里用水族箱领域 —— 与 test/fixtures 的合成语料同域,保证不泄真实语料。
 */
function placeboBlock(targetBytes) {
  const para = [
    '## 水族箱维护备忘(占位,与任何真实记录无关)',
    '',
    '- 换水周期:每周一次,每次不超过总水体的三分之一 [source: aquarium/manual.md; added: 2026-01-01]',
    '- 温度带:淡水草缸保持 24-26 摄氏度,波动每小时不超过 1 度 [source: aquarium/manual.md; added: 2026-01-01]',
    '- 光照:每日 8 小时,分两段;藻类爆发时先减光再加碳 [source: aquarium/algae.md; added: 2026-01-02]',
    '- 过滤:滤材分层放置,机械层每月冲洗,生化层只在流量下降时轻冲 [source: aquarium/filter.md; added: 2026-01-02]',
    '- 投喂:每日两次,每次两分钟内吃完;残饵立即捞出 [source: aquarium/feeding.md; added: 2026-01-03]',
    '- 混养:体型差超过一倍不混养;领地性品种单独隔离 [source: aquarium/stocking.md; added: 2026-01-03]',
    '- 检疫:新入缸生物隔离观察 14 天,期间不共用器具 [source: aquarium/quarantine.md; added: 2026-01-04]',
    '',
    '## 常见故障',
    '',
    '- 白浊:多为硝化系统未建立,减喂食、加曝气,不要整缸换水 [source: aquarium/trouble.md; added: 2026-01-04]',
    '- 绿水:光照与营养盐同时过剩,先遮光三天再逐步恢复 [source: aquarium/trouble.md; added: 2026-01-05]',
    '- 鱼只浮头:先测氨氮与溶氧,再考虑密度问题 [source: aquarium/trouble.md; added: 2026-01-05]',
  ].join('\n');
  // 等长:按字节补齐(补的是同格式的虚构条目,不是空白 —— 空白本身也是变量)
  const padLine = '- 补充条目:该行仅用于对齐长度,内容为占位文本 [source: aquarium/placeholder.md; added: 2026-01-06]';
  let out = para;
  while (Buffer.byteLength(out, 'utf8') < targetBytes) out += '\n' + padLine;
  return out;
}

/**
 * 常驻段。**必须与运行时逐字节相同** —— 用同一个 composeSection 渲染,
 * 只是 nonce 固定(STATIC_NONCE),因为这里不需要防伪造围栏,只需要内容一致。
 * ⚠ 若这里手写一份「差不多的」文案,A 臂就不再是运行时的代理,整个对照失去意义。
 */
function indexBlock() {
  const index = readFileSync(path.join(ROOT, 'MEMORY.md'), 'utf8');
  return composeSection(index, { nonce: STATIC_NONCE }).text;
}

const ARM_DEFS = {
  arm0: {
    label: '臂 0 零记忆',
    system: '你是个人助理,回答用户问题。只依据你已知的信息作答;不知道就直接说不知道。',
    block: null,
  },
  armP: {
    label: '臂 P 安慰剂(等长无关)',
    system: '你是个人助理,回答用户问题。下面「长期记忆」段是用户的记录,请优先依据它作答。',
    block: 'placebo',
  },
  armA: {
    label: '臂 A 索引单独',
    system: '你是个人助理,回答用户问题。下面「长期记忆」段是用户的事实记录,请优先依据它作答。',
    block: 'index',
  },
  // ⚠ 天花板臂:把**正确答案所在的那篇文档整篇**塞进提示词。
  //   它回答的是「信息**已经**在上下文里时,模型能不能答对」——
  //   把「检索没找对」与「找到了但模型没用好」分开。
  //   出处:LongMemEval 发布 longmemeval_oracle.json(只留证据 session);
  //        LongMemEval-V2 附录 B.2「Can Models Reliably Answer with Oracle Trajectory Access?」。
  //   ⚠ 这是**测量**不是推断:它不需要「题集是随机样本」这个假设,
  //     而 p 值需要。手挑题集上 oracle 缺口比 p 值可信得多。
  armO: {
    label: '臂 O oracle(整篇塞入)',
    system: '你是个人助理,回答用户问题。下面「长期记忆」段是用户的事实记录,请优先依据它作答。',
    block: 'oracle',
  },
};

function oracleBlock(docRel) {
  if (!docRel) return '';
  const p = path.join(ROOT, ...String(docRel).split('/'));
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf8');
}

function messagesFor(arm, question, docRel) {
  const def = ARM_DEFS[arm];
  if (!def) throw new Error(`未知臂:${arm}`);
  const parts = [def.system];
  if (def.block === 'index') parts.push('', indexBlock());
  else if (def.block === 'placebo') parts.push('', placeboBlock(Buffer.byteLength(indexBlock(), 'utf8')));
  else if (def.block === 'oracle') parts.push('', oracleBlock(docRel));
  parts.push('', `问题:${question}`, '', '要求:直接给答案。若上面没有相关信息,只回「无法确定」。不要编造。');
  return [
    { role: 'system', content: parts[0] },
    { role: 'user', content: parts.slice(1).join('\n') },
  ];
}

// ───────────────────────────────────────────── 调用

async function callModel(messages) {
  const body = JSON.stringify({
    model: MODEL,
    messages,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const m = j.choices?.[0]?.message ?? {};
    return {
      content: String(m.content ?? ''),
      reasoning: String(m.reasoning_content ?? ''),
      usage: j.usage ?? {},
    };
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────────────────────────── 判分

const RE_REFUSAL = /无法确定|不知道|没有相关|未找到|无法回答|不能确定|无相关信息|没有记录/;

/**
 * 判分:ground truth 串是否出现在回答里。
 *
 * ⚠ 三条纪律:
 *   1. **先剥「不知道」** —— 拒答里可能恰好包含 truth 的片段(例如问题本身),
 *      不剥会把拒答判成对。
 *   2. **大小写与空白归一化**,但**不做模糊匹配** —— 模糊匹配是判分器自己引入的自由度。
 *   3. 拒答**不算对**。零记忆臂的失败模式是「承认不知道」而非「自信地编」,
 *      计为错才是诚实的。
 */
function grade(answer, truth) {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, '');
  const a = norm(answer);
  const t = norm(truth);
  const refused = RE_REFUSAL.test(answer);
  if (refused && !a.includes(t)) return { ok: false, reason: 'refused' };
  if (a.includes(t)) return { ok: true, reason: 'hit' };
  return { ok: false, reason: refused ? 'refused' : 'miss' };
}

// ───────────────────────────────────────────── McNemar

/**
 * 配对设计(同一题跑两臂)⇒ McNemar 精确检验。
 * 只看**不一致对**:b = 臂1错臂2对,c = 臂1对臂2错。
 * 零假设下 b ~ Binomial(b+c, 0.5) ⇒ 双侧 p = 2 * P(X <= min(b,c))。
 *
 * ⚠ 为什么不报 Wilson 区间:那是单臂比例区间,不处理**配对**。
 *   本题两臂跑的是同一批题,独立区间会高估不确定性。
 */
function mcnemar(pairs) {
  const b = pairs.filter((p) => !p[0] && p[1]).length;
  const c = pairs.filter((p) => p[0] && !p[1]).length;
  const n = b + c;
  if (n === 0) return { b, c, n, p: 1, note: '两臂完全一致,无判别信息' };
  const lgamma = (z) => {
    const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let x = z; let y = z; let tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += g[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  };
  const lchoose = (nn, k) => lgamma(nn + 1) - lgamma(k + 1) - lgamma(nn - k + 1);
  let tail = 0;
  for (let k = 0; k <= Math.min(b, c); k++) tail += Math.exp(lchoose(n, k) + n * Math.log(0.5));
  return { b, c, n, p: Math.min(1, 2 * tail) };
}

// ───────────────────────────────────────────── 主流程

const questions = loadQuestions(QUESTIONS, Number(opt('--limit', '0')));
const arms = ARMS;

if (!asJson) {
  console.log('═'.repeat(72));
  console.log('  dsh-memory 模型级效果基准(零记忆 / 安慰剂 / 索引单独)');
  console.log('═'.repeat(72));
  console.log(`  端点    : ${ENDPOINT}`);
  console.log(`  模型    : ${MODEL}`);
  console.log(`  记忆根  : ${ROOT}`);
  console.log(`  题集    : ${QUESTIONS}(${questions.length} 题,仓库外)`);
  console.log(`  臂      : ${arms.map((a) => ARM_DEFS[a].label).join(' / ')}`);
  console.log(`  采样    : ${REPEAT} 次/题/臂,temperature=${TEMPERATURE},多数投票`);
  const block = indexBlock();
  console.log(`  索引段  : ${block.split('\n').length} 行 / ${Buffer.byteLength(block, 'utf8')} B`);
  if (arms.includes('armP')) {
    const pb = placeboBlock(Buffer.byteLength(block, 'utf8'));
    console.log(`  安慰剂段: ${pb.split('\n').length} 行 / ${Buffer.byteLength(pb, 'utf8')} B(等长,虚构水族箱域)`);
  }
  console.log('');
}

const rows = [];
for (const q of questions) {
  const perArm = {};
  for (const arm of arms) {
    const runs = [];
    for (let k = 0; k < REPEAT; k++) {
      try {
        const out = await callModel(messagesFor(arm, q.question, q.want));
        runs.push({ ...grade(out.content, q.truth), content: out.content });
      } catch (e) {
        runs.push({ ok: false, reason: `error:${e.message}`, content: '' });
      }
    }
    // 多次重复:多数投票(REPEAT=1 时就是单次)
    const okCount = runs.filter((r) => r.ok).length;
    perArm[arm] = { ok: okCount * 2 > REPEAT, okCount, runs };
  }
  rows.push({ ...q, ...perArm });
  if (!asJson) {
    const marks = arms.map((a) => (perArm[a].ok ? '✓' : '✗')).join(' ');
    console.log(`  [${marks}]  ${q.id.padEnd(5)} ${q.question.slice(0, 38)}`);
  }
}

// ───────────────────────────────────────────── 汇总

const acc = (arm) => rows.filter((r) => r[arm].ok).length;
const summary = {
  endpoint: ENDPOINT,
  model: MODEL,
  repeat: REPEAT,
  temperature: TEMPERATURE,
  n: rows.length,
  arms: Object.fromEntries(arms.map((a) => [a, {
    label: ARM_DEFS[a].label,
    correct: acc(a),
    accuracy: rows.length ? acc(a) / rows.length : 0,
  }])),
  // 配对 McNemar(精确)。基线优先取臂0(零点);⚠ **没有臂0 时退到第一个臂** ——
  // 直接写死 `r.arm0.ok` 会在 `--arms armO` 这类单臂/缺臂0 的调用上抛
  // `Cannot read properties of undefined (reading 'ok')`(2026-10-10 实测踩到)。
  // ⚠ 退到第一个臂而不是**返回空对象**:空对象是**静默截断**,
  // 调用方看不出「本来就没有对照」还是「对照算失败了」(硬规则 7/12)。
  mcnemar: (() => {
    const base = arms.includes('arm0') ? 'arm0' : arms[0];
    return Object.fromEntries(
      arms.filter((a) => a !== base).map((a) => [`${base}_vs_${a}`, mcnemar(rows.map((r) => [r[base].ok, r[a].ok]))]),
    );
  })(),
  perQuestion: rows.map((r) => ({
    id: r.id,
    question: r.question,
    truth: r.truth,
    ...Object.fromEntries(arms.map((a) => [a, r[a].ok])),
    reasons: Object.fromEntries(arms.map((a) => [a, r[a].runs.map((x) => x.reason).join(',')])),
    // ⚠ 必须留原文:只留 ok/reason 时**判分器自身的假阴性查不出来** ——
    // ⚠ 这里**故意不复述那两串原文** —— 它们是真实题集的 ground truth,属语料(硬规则 8 推论 2)。
    // 实测某题的 truth 是「数字 + 量词 A」而模型答「数字 + 量词 B」⇒ 判 miss,
    // 但那**不是模型答错**。没有原文就只能看到「它没答对」,会把判分器缺陷记成模型缺陷。
    answers: Object.fromEntries(arms.map((a) => [a, r[a].runs.map((x) => x.content)])),
  })),
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('');
  console.log('─'.repeat(72));
  for (const a of arms) {
    const s = summary.arms[a];
    console.log(`  ${s.label.padEnd(22)} ${s.correct}/${summary.n} = ${(s.accuracy * 100).toFixed(1)}%`);
  }
  console.log('');
  // ── 闭卷预筛:零点臂答对的题**没有判别力**,必须报出来 ──
  // 出处:LongMemEval 把 closed-book 当零点基线,arXiv:2410.10813。
  // ⚠ 不自动剔除 —— 剔除是人的判断(可能是判分器的假阳性)。
  //   工具只负责**让它可见**;悄悄丢掉题目等于把不利证据藏起来。
  if (arms.includes('arm0')) {
    const leaky = rows.filter((r) => r.arm0.ok);
    if (leaky.length === 0) {
      console.log(`  ✅ 闭卷预筛:零点臂 0/${rows.length} —— 全部题目都有判别力。`);
    } else {
      console.log(`  ⚠ 闭卷预筛:零点臂答对 ${leaky.length}/${rows.length} 题 ⇒ **这些题没有判别力**,`);
      console.log(`     基座靠常识就能蒙对,不该用来证明记忆有效。逐题看:`);
      leaky.forEach((r) => console.log(`       ${r.id}  ${r.question.slice(0, 46)}`));
      console.log(`     ⇒ 处置是**人工判断**:确认是常识捷径就剔除;若是判分器假阳性就改 ground truth。`);
    }
    console.log('');
  }
  for (const [k, m] of Object.entries(summary.mcnemar)) {
    console.log(`  配对 McNemar ${k}: 不一致对 b=${m.b} c=${m.c} n=${m.n}  精确双侧 p=${m.p.toFixed(4)}`);
    if (m.note) console.log(`    ⚠ ${m.note}`);
  }
  console.log('');
  console.log('  ⚠ 最小可检出效应(精确二项,α=0.05):不一致对 n=8 时需 **8:0**(p=0.0078);');
  console.log('     7:1 的 p=0.070 ⇒ **不显著**。n=10 时需 9:1(p=0.021)。');
  console.log('     ⇒ 小样本只检得动**压倒性**效应,检不动「提升 15%」这种。别过度解读。');
  // ⚠⚠ 别把「扩题到 N 题就能显著」当建议 —— 那是错的方向。
  //   手挑的题集**不是**从某个超总体里随机抽的 ⇒ 超总体假设不成立 ⇒ p 值本身没有总体意义。
  //   扩题只会让一个前提不成立的数字变小,不会让它变对。
  //   正确做法:用 oracle 臂**量出**缺口在哪(不需要任何总体假设)。
  if (arms.includes('armO')) {
    const oracle = acc('armO');
    const a = acc('armA');
    console.log('');
    console.log(`  ── oracle 缺口分解(这是**测量**,不需要「题集是随机样本」的假设)──`);
    console.log(`     臂 0 零记忆 ${acc('arm0')}/${summary.n} → 臂 A 索引 ${a}/${summary.n} → 臂 O oracle ${oracle}/${summary.n}`);
    console.log(`     · 检索/索引缺口 = ${oracle - a} 题 —— 信息**本来就在语料里**,只是没进上下文`);
    console.log(`     · 生成缺口     = ${summary.n - oracle} 题 —— 信息**已经**在上下文里,模型仍然没答对`);
    if (oracle === summary.n) {
      console.log(`     ⇒ oracle 满分 ⇒ 上限可达,瓶颈**全在检索侧**。`);
    } else if (oracle === 0) {
      console.log(`     ⇒ oracle 也 0 ⇒ 要么判分器坏了,要么题目与文档对不上。**先查这两件事**,别急着下结论。`);
    } else {
      console.log(`     ⇒ 两侧都有缺口 ⇒ 单纯加强检索**不足以**把分数拉满。`);
    }
  } else {
    console.log('  ℹ 加 --arms ...,armO 可测 oracle 天花板,把缺口拆成「检索侧」与「生成侧」。');
  }
  console.log('');
  console.log('  ⚠⚠ 手挑题集上 **p 值没有总体意义** —— 题目不是从某个超总体随机抽的,');
  console.log('     超总体假设不成立。所以本工具把 p 值当**参考**而不是**判据**;');
  console.log('     要下结论请用 oracle 缺口 + 效应量,并把题集来源如实写进报告。');
  console.log('  ⚠ 臂 B(索引 + 工具)不在本脚本内 —— 它要真的跑 agent 循环,');
  console.log('     由父会话派子代理跑,结果并回报告。**不伪造那个臂。**');
  console.log('  ⚠ 本脚本不产出「答案质量」这类主观指标。它只判「ground truth 串在不在回答里」。');
  console.log('═'.repeat(72));
}
