// 生成 `test/fixtures/memory/` —— 检索测试用的记忆语料。
//
// ── 为什么要有生成器而不是直接提交夹具 ──
// 夹具原本是**真实记忆仓的逐字节快照**,含个人数据。本仓是**公开仓** ⇒
// 真实语料**不进版本控制**(见 .gitignore),改由本脚本生成一份合成语料。
//
// ── ⚠ 2026-10-10 修:上一版是「半脱敏」,必须彻底合成化 ──
// 上一版只换了**标识符**(币种、数量、出处前缀都改成虚构的),
// 但**规则文本是真实记忆的原文**。实测:28 条条目里 **4 条逐字相同 + 6 条只截了尾巴**。
// ⇒ 那等于把用户的**真实交易纪律**放进了公开仓,违反硬规则 8。
//
// ⚠⚠ **本条说明刻意不复述那些条文** —— 把泄漏内容写进修复说明等于**二次泄漏**,
// 而 git 历史不会因为你"只是在举例"就少留一份。(我第一版就是这么写的,已改。)
// 要核对泄漏范围,跑下面这条(它读的是**本地**记忆仓,输出只给计数):
//   node -e "..."  见 `AGENTS.md` 的「验证命令」段,或直接用全文扫描工具。
//
// 本版改为**完全虚构的领域**(家庭水族箱养护),连**路径一起换**:
// 任何人扫一眼就知道是合成语料,不存在"这段是不是真的"的判断空间。
//
// ── 与真实语料的关系(别混) ──
//   ① 合成语料(本脚本产出,提交进仓) —— `npm test` 用,任何人 clone 后可复现。
//   ② 真实语料(本机 `~/.dsh/memory`) —— **不提交**。用 `tools/recall-report.mjs` 度量,
//      README 里引用的实测数字来自它,不是来自本脚本。
//
// ⚠ 上一版刻意让**文件名与主题结构和真实语料平行**(5 文件、同名、同主题),
//   本版**放弃了这个平行性** —— 代价是 `test/recall.test.js` 的提问要改成水族箱主题;
//   收益是**零误认风险**。检索算法与领域无关,换了领域不影响它对检索质量的判别力。
//
// 用法:
//   node tools/make-fixture.mjs            # 写入 test/fixtures/memory/
//   node tools/make-fixture.mjs --check    # 只检查是否与生成结果一致,不写(供测试用)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const FIXTURE_DIR = path.join(HERE, '..', 'test', 'fixtures', 'memory')

/** 合成语料。**完全虚构**(家庭水族箱养护),与任何真实系统/项目无关。 */
export const CORPUS = {
  'MEMORY.md': `> ⚠ **本文件是测试夹具,内容全为虚构** —— 由 \`tools/make-fixture.mjs\` 生成,不对应任何真实系统。
> 只放主规则文件里**没有的事实**。

## 当前主线
- 鱼缸:60cm 草缸开缸第 3 阶段(底砂已铺,12 株水草,起点 2026-03-15 08:00) [source: demo/tank-log.md; added: 2026-10-01]
- 设备:example-filter 循环泵已接入定时器(每日 08:00-20:00) [source: demo/gear.md; added: 2026-10-01]

## 环境事实
- 换水入口 = 阳台「蓄水桶」;禁止直接接自来水(余氯会杀硝化菌) [source: demo/tank-log.md; added: 2026-10-01]

## 主题索引
- 鱼缸维护守则 → \`aquarium/tank-rules.md\`
- 记录格式约定 → \`preferences/log-style.md\`
- 设备坑位 → \`equipment/filter-pitfalls.md\`
`,

  'README.md': `# 示例记忆仓(测试夹具)

⚠ **本仓内容全为虚构**,由 \`tools/make-fixture.mjs\` 生成,供 \`npm test\` 使用。
真实记忆语料**不进版本控制**(本插件仓是公开仓)。

## 结构约定

\`\`\`
MEMORY.md                 常驻注入段(硬限 60 行 / 4096 字节)
<主题>/<主题>.md           按需加载,用 memory_read 取全文
\`\`\`

## 条目格式

\`\`\`
- 事实内容 [source: 出处; added: 日期; confidence: high|low]
\`\`\`

- \`source\` **必填** —— 记不清出处的条目不要写进来
- \`added\` 用绝对日期(YYYY-MM-DD),不写"今天"
`,

  'aquarium/tank-rules.md': `# 鱼缸维护守则

> 全部来自虚构的养护记录,出处指向 demo 条目 id。新增条目前先确认出处存在。

## 混养
- 只混养灯科与鼠鱼;金鱼是禁养品种,绝不混入 [source: demo/log-20260301-01; added: 2026-10-01; confidence: high]
- 缸内 8 个品种:红绿灯/宝莲灯/斑马/白云金丝/咖啡鼠/花椒鼠/小精灵/黑线飞狐 [source: demo/gear.md; added: 2026-10-01]

## 水温与换水
- 水温低于 22℃ 时不靠加热棒硬拉,避免昼夜温差过大;曾两次因温差全缸白点 [source: demo/log-20260301-05; added: 2026-10-01]
- 换水后至少静置 6h 再投食,<6h 投食会因水质波动引发肠炎 [source: demo/log-20260301-06; added: 2026-10-01]

## 投食与观察
- 连续 48h 未吃完的饲料必须捞出,残饵必然爆氨 [source: demo/log-20260301-02; added: 2026-10-01]
- 新鱼入缸前隔离观察 3-7 天,期间按盐浴浓度 0.3% 处理 [source: demo/log-20260301-03; added: 2026-10-01]
- 发现鱼只浮头应立刻加大曝气,不该拖到第二天 [source: demo/log-20260301-07; added: 2026-10-01]

## 密度与设备
- 缸体 <60L 时禁止加装第二组外置滤桶 [source: demo/log-20260302-01; added: 2026-10-01]
- 密度过高时单次停电即可全缸缺氧 [source: demo/log-20260302-01; added: 2026-10-01]
`,

  'preferences/log-style.md': `# 记录格式约定

## 临时文件
- 临时照片用 \`_tmp-\` 前缀,或落在 \`%TEMP%\` 下;备份用 \`*.bak*\`(连字符不是点) [source: demo/notes.md; added: 2026-10-01]
- 删除目标必须是**显式路径白名单**,禁止按前缀跨树 glob [source: demo/notes.md; added: 2026-10-01]

## 记录
- 结论先行,表格优先;绝对日期(2026-10-01),不写「今天/最近」 [source: demo/notes.md; added: 2026-10-01]
- 记水质读数必须注明口径与区间;硬度注明单位 + 样本数 + 换算方式 [source: demo/notes.md; added: 2026-10-01]
- 每条结论必须可追溯到实测,推测要写明是推测 [source: demo/notes.md; added: 2026-10-01]

## 变更
- 不改没要求的设备、参数或排布;不改没坏的东西 [source: demo/notes.md; added: 2026-10-01]
- 每次改动应能直接追溯到当前需求 [source: demo/notes.md; added: 2026-10-01]
`,

  'equipment/filter-pitfalls.md': `# 设备坑位

## 过滤
- 换滤材前必读:整桶滤材一次性全换会让硝化系统**整条崩溃**,水质只表现为"突然发白" [source: demo/notes.md; added: 2026-10-01]
- 生化棉是**分层替换**不是全换;配 \`full-replace: true\` 时未列出的层会**静默失效** [source: demo/notes.md; added: 2026-10-01]

## 加热
- 换加热棒后:温控按「功率+缸体+室温」三重校准,一个参数错会让**整条曲线偏移** [source: demo/notes.md; added: 2026-10-01]
- 断电恢复后温控器会丢校准值,需手动重设一次 [source: demo/notes.md; added: 2026-10-01]

## 照明
- 升级灯盘前先读 \`lamp-upgrade\` 说明,内有实测的完整流程与坑位清单,不要凭印象裸换 [source: demo/notes.md; added: 2026-10-01]
- 当前灯盘 = 全光谱 60cm(入口取 \`lamp-config.json\` 的 \`lampEntry\` 字段,**别记型号 —— 它会换**) [source: demo/notes.md; added: 2026-10-01]

## 停电
- 停电后一律用桌面「应急电池」;**禁止直接切 \`bypass-relay.sh\`** —— 它绕过的是整条安全回路 [source: demo/notes.md; added: 2026-10-01]
- 循环泵改动 **必须断电重启才生效** [source: demo/notes.md; added: 2026-10-01]
`,
}

/** 把语料写成文件树。@returns {string[]} 写入的相对路径 */
export function writeCorpus(dir = FIXTURE_DIR) {
  const written = []
  for (const [rel, text] of Object.entries(CORPUS)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text, 'utf8')
    written.push(rel.split(path.sep).join('/'))
  }
  return written.sort((a, b) => a.localeCompare(b))
}

/** 与磁盘现状比对,返回不一致的相对路径。 */
export function checkCorpus(dir = FIXTURE_DIR) {
  const drift = []
  for (const [rel, text] of Object.entries(CORPUS)) {
    const abs = path.join(dir, rel)
    let onDisk = null
    try { onDisk = fs.readFileSync(abs, 'utf8') } catch { drift.push(rel + '(缺失)'); continue }
    if (onDisk !== text) drift.push(rel + '(内容不一致)')
  }
  return drift
}

// 直接执行时才写盘(被 import 时不产生副作用)。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const drift = checkCorpus()
    if (drift.length) { console.error('夹具与生成器不一致:\n  ' + drift.join('\n  ')); process.exit(1) }
    console.log('夹具与生成器一致 ✔')
  } else {
    const w = writeCorpus()
    console.log(`已写入 ${w.length} 个文件到 ${FIXTURE_DIR}`)
    w.forEach((f) => console.log('  ' + f))
  }
}
