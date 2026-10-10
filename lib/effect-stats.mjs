// 效果基准的**纯函数**:判分 + 配对显著性检验。
//
// ⚠ 为什么单独一个文件而不是塞进 memory-store.mjs:
//   memory-store 是**插件运行时**的核心(注入、检索、写入分级)。
//   这里是**评测工具**的统计件,运行时不 import 它。混在一起会让
//   「插件行为」与「怎么衡量插件」纠缠 —— 改判分器不该有碰运行时的风险。
//
// ⚠ 为什么这两件事必须有测试:
//   判分器错 ⇒ 所有数字错;McNemar 的 p 值错 ⇒ 结论错。
//   两者都**不会崩**,只会静默给出一个看起来很正常的数。这是最危险的一类缺陷。

// ───────────────────────────────────────────── 判分

const RE_REFUSAL = /无法确定|不知道|没有相关|未找到|无法回答|不能确定|无相关信息|没有记录/;

/**
 * 判分:ground truth 串是否出现在回答里。
 *
 * ⚠ 三条纪律:
 *   1. **truth 出现在回答里就算对,哪怕带「无法确定」的措辞**。
 *      这不是宽松,是**保守**:零记忆臂没有这个事实,它若说对了就是**蒙的**,
 *      而蒙对计入基线 ⇒ 基线上抬 ⇒ 插件的测得增益**变小**。宁可低估自己。
 *      ⚠ 反过来(拒答一律算错)会系统性**抬高**插件增益 —— 那是自证。
 *   2. 大小写与空白归一化,但**不做模糊匹配** —— 模糊匹配是判分器自己引入的自由度,
 *      而自由度是偏置的温床。
 *   3. **纯拒答(不含 truth)必须计为错**。零记忆臂的失败模式是「承认不知道」
 *      而不是「自信地编」(实测 4 题答不出全写「无法确定」,零编造)。
 *      若把纯拒答算成「不算错」,基线会被虚高,增益被抹平。
 */
export function grade(answer, truth) {
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, '');
  const a = norm(answer);
  const t = norm(truth);
  const refused = RE_REFUSAL.test(String(answer));
  if (a.includes(t)) return { ok: true, reason: 'hit' };
  return { ok: false, reason: refused ? 'refused' : 'miss' };
}

// ───────────────────────────────────────────── 统计

// Lanczos 近似的 ln Γ(z)。只用于算二项系数,精度足够。
function lgamma(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z; let y = z; let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function lchoose(n, k) {
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}

/** 二项分布的双侧精确 p 值(取 ≤min 的尾部 ×2,封顶 1)。 */
export function binomTwoSided(n, k) {
  if (n <= 0) return 1;
  let tail = 0;
  for (let i = 0; i <= Math.min(k, n - k); i++) tail += Math.exp(lchoose(n, i) + n * Math.log(0.5));
  return Math.min(1, 2 * tail);
}

/**
 * McNemar **精确**检验(配对二值数据)。
 *
 * ⚠⚠ 必须用精确检验,不能用渐近卡方 `χ²=(|b−c|−1)²/(b+c)`。
 *   卡方靠大样本正态近似,统计学定则要求 **不一致对 b+c ≥ 25**(宽松也需 ≥10)。
 *   本仓题量 10~30,b+c 通常 4~12 ⇒ 卡方会产生严重的 I 类错误率畸变
 *   —— 即**虚报显著**。出处:Dror et al. 2018, https://aclanthology.org/P18-1128/
 *
 * 零假设 H₀: b = c = 0.5(有无记忆的差异纯属随机)。
 * 条件精确检验:b | (b+c) ~ Binomial(b+c, 0.5)。
 *
 * @param pairs 数组,每项是 [对照臂结果, 实验臂结果] 的布尔值对
 */
export function mcnemar(pairs) {
  const b = pairs.filter((p) => !p[0] && p[1]).length; // 对照错、实验对 ⇒ 收益
  const c = pairs.filter((p) => p[0] && !p[1]).length; // 对照对、实验错 ⇒ 反噬
  const n = b + c;
  if (n === 0) {
    return { b, c, n, p: 1, note: '两臂完全一致,无判别信息' };
  }
  return { b, c, n, p: binomTwoSided(n, b) };
}

/**
 * 达到 α=0.05 所需的最小「全胜」不一致对数(即 c=0 时的 b)。
 * 用途:把「样本太小」这句空话换成**可直接执行的扩容目标**。
 */
export function minAllWinPairs(alpha = 0.05) {
  for (let n = 1; n <= 64; n++) {
    if (binomTwoSided(n, n) <= alpha) return n;
  }
  return null;
}
