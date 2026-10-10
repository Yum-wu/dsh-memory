// 效果基准的统计件测试。
//
// ⚠ 为什么必须有这组断言:
//   判分器错 ⇒ 所有数字错;McNemar 的 p 值错 ⇒ 结论错。
//   两者都**不会崩**,只会静默给出一个看起来很正常的数 —— 最危险的一类缺陷。
//   下面每个期望值都是**手算的**精确二项结果,不是从实现里抄的。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grade, mcnemar, binomTwoSided, minAllWinPairs } from '../lib/effect-stats.mjs';

// -------------------------------------- 判分

test('判分:truth 出现在回答里就算对', () => {
  assert.equal(grade('答案是 2h', '2h').ok, true);
  assert.equal(grade('应该是 2H', '2h').ok, true, '大小写归一化');
  assert.equal(grade('等待 2 h 就行', '2h').ok, true, '空白归一化');
});

test('判分:⚠ 带「无法确定」但答对了,仍算对(这是**保守**方向)', () => {
  // 反直觉但故意的:零记忆臂没有这个事实,它若说对了就是蒙的。
  // 蒙对计入基线 ⇒ 基线上抬 ⇒ 插件测得增益**变小**。宁可低估自己。
  const r = grade('我无法确定,但记录里提到 2h', '2h');
  assert.equal(r.ok, true, '含 truth 的含糊回答必须算对 —— 算错会系统性抬高插件增益');
  assert.equal(r.reason, 'hit');
});

test('判分:⚠ 纯拒答(不含 truth)必须算错', () => {
  // 若把纯拒答算成「不算错」,基线会被虚高,插件的增益被抹平。
  assert.equal(grade('无法确定', '2h').ok, false);
  assert.equal(grade('无法确定', '2h').reason, 'refused');
  assert.equal(grade('不知道', '2h').reason, 'refused');
  assert.equal(grade('没有相关记录', '2h').reason, 'refused');
});

test('判分:答错且不拒答 ⇒ miss(不是 refused)', () => {
  const r = grade('应该是 4h', '2h');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'miss', '要能把「答错」与「拒答」分开 —— 它们的含义完全不同');
});

test('判分:不做模糊匹配(自由度是偏置的温床)', () => {
  assert.equal(grade('大概是两个小时的量级', '2h').ok, false, '「两个小时」不该匹配「2h」');
  // ⚠ 已知假阳性:子串匹配下 `12h` 含 `2h`(而 `24h` **不含** —— 中间隔着 4)。
  //   这条断言是**记录缺陷**,不是认可它。ground truth 选串时要避开这种前缀。
  assert.equal(grade('12h', '2h').ok, true, '⚠ 子串匹配的已知假阳性,选 truth 时须避开');
});

// -------------------------------------- McNemar 精确检验

// ⚠ 每个期望值都是手算:双侧 p = 2 × Σ_{k≤min(b,c)} C(n,k) × 0.5^n
test('McNemar:与手算的精确二项值一致(这张表就是判据)', () => {
  const cases = [
    { b: 3, c: 0, n: 3, p: 2 * 1 / 8 },              // 0.25
    { b: 4, c: 0, n: 4, p: 2 * 1 / 16 },             // 0.125
    { b: 8, c: 0, n: 8, p: 2 * 1 / 256 },            // 0.0078125 ← 最小显著全胜
    { b: 7, c: 1, n: 8, p: 2 * 9 / 256 },            // 0.0703 ← **不显著**
    { b: 9, c: 1, n: 10, p: 2 * 11 / 1024 },         // 0.0215
    { b: 8, c: 2, n: 10, p: 2 * 56 / 1024 },         // 0.1094 ← 不显著
    { b: 10, c: 2, n: 12, p: 2 * 79 / 4096 },        // 0.0386
  ];
  for (const c of cases) {
    const pairs = [
      ...Array(c.b).fill([false, true]),
      ...Array(c.c).fill([true, false]),
    ];
    const r = mcnemar(pairs);
    assert.equal(r.b, c.b, `b 错(${c.b})`);
    assert.equal(r.c, c.c, `c 错(${c.c})`);
    assert.equal(r.n, c.n, `n 错(${c.n})`);
    assert.ok(
      Math.abs(r.p - c.p) < 1e-9,
      `b=${c.b} c=${c.c}: p 期望 ${c.p},实得 ${r.p} —— 精确二项算错了`,
    );
  }
});

test('McNemar:⚠ 7:1 不显著、8:0 显著 —— 这条边界是本工具结论门禁的依据', () => {
  const p71 = mcnemar([...Array(7).fill([false, true]), [true, false]]).p;
  const p80 = mcnemar(Array(8).fill([false, true])).p;
  assert.ok(p71 > 0.05, `7:1 的 p=${p71} 竟被当成显著 —— 会虚报结论`);
  assert.ok(p80 < 0.05, `8:0 的 p=${p80} 竟不显著 —— 门禁定错了`);
});

test('McNemar:两臂完全一致 ⇒ 无判别信息', () => {
  const r = mcnemar([[true, true], [false, false], [true, true]]);
  assert.equal(r.n, 0);
  assert.equal(r.p, 1);
  assert.ok(r.note, '必须给出 note —— 「无判别信息」和「p=1 所以无效」不是一回事');
});

test('McNemar:⚠ 只用不一致对,一致的对不贡献信息', () => {
  // 加 100 个「两臂都对」不该改变 p —— 那正是「配对」的意义。
  const base = [...Array(8).fill([false, true])];
  const padded = [...base, ...Array(100).fill([true, true]), ...Array(100).fill([false, false])];
  assert.equal(mcnemar(base).p, mcnemar(padded).p, '一致对污染了结果 —— 那不是 McNemar');
});

test('McNemar:反噬(c>b)同样算显著 —— 不能只测一个方向', () => {
  // 记忆让回答**变差**也必须能被检出,否则这个工具只会报喜。
  const r = mcnemar(Array(8).fill([true, false]));
  assert.equal(r.b, 0);
  assert.equal(r.c, 8);
  assert.ok(r.p < 0.05, '退化反噬必须也能达到显著');
});

// -------------------------------------- 辅助

test('binomTwoSided:边界', () => {
  assert.equal(binomTwoSided(0, 0), 1);
  assert.equal(binomTwoSided(1, 0), 1, 'n=1 时任何结果都不显著');
  assert.equal(binomTwoSided(1, 1), 1);
});

test('minAllWinPairs:最小全胜对数是 6(手算:5:0 ⇒ 0.0625,6:0 ⇒ 0.03125)', () => {
  // ⚠ 别把它与「n=8 时需 8:0」混为一谈 —— 后者是**条件**陈述
  //   (「若不一致对恰好有 8 个,则必须全胜」),不是「需要 8 对」。
  assert.equal(minAllWinPairs(0.05), 6);
});

test('minAllWinPairs:返回值确实满足阈值,且前一个不满足', () => {
  const k = minAllWinPairs(0.05);
  assert.ok(binomTwoSided(k, k) <= 0.05, `${k}:0 竟不满足 α=0.05`);
  assert.ok(binomTwoSided(k - 1, k - 1) > 0.05, `${k - 1}:0 竟已满足 —— 返回值不是最小的`);
  assert.equal(binomTwoSided(5, 5), 0.0625, 'n=5 全胜手算 = 2×0.5^5');
  // ⚠ 用容差:实现走 lgamma + exp,必然带浮点尾数(实测 0.031250000000000014)
  assert.ok(Math.abs(binomTwoSided(6, 6) - 0.03125) < 1e-12, 'n=6 全胜手算 = 2×0.5^6');
});
