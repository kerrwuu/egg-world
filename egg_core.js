/*
 * egg_core.js — 煎蛋世界模型：纯逻辑模拟器核心（无画面、无 DOM、无依赖）
 *
 * 这是什么：
 *   把 50天计划.md 第 3 节（3.1 状态变量、3.2 动作、3.3 连续动态、3.4 瞬时规则、3.5 结局判定）
 *   逐条写成代码。界面 index.html、批量生成脚本、自测脚本都只调用这里的函数，自己不写任何规则。
 *   规则的唯一权威是 50天计划.md 第 3 节；Python 参考实现是 ../参考模拟器.py。
 *
 * 怎么用：
 *   浏览器：<script src="egg_core.js"></script> 之后用 window.EggCore.step(...) 等。
 *   Node：  const EggCore = require('./egg_core.js');
 *   自测：  node test_core.js          （7 条自测 + 已验证数字 + 300 回合批量抽样）
 *   批量：  node gen_batch_node.js --n 2000 --seed 1 --out ../03_数据/episodes_js.jsonl
 *
 * 约定（见 CONTRACT.md）：
 *   - step() 是纯函数：不改传入的 state，返回新对象；不用 Date.now()、不用 Math.random()。
 *   - 随机数只来自带种子的 mulberry32，同一种子 → 同一批数据（可复现）。
 *   - 一个 tick 的顺序：先动作瞬时规则（WASTED / PLATE 立即结束，不再跑动态），
 *     再连续动态，t += 1；t 达到 300 仍未结束 → TIMEOUT。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();           // Node
  } else {
    root.EggCore = factory();             // 浏览器：window.EggCore
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 3.1 状态变量：15 个字段，名字与顺序固定 ----------
  const FIELDS = [
    'pan_on_stove', 'flame', 'pan_temp', 'oil', 'oil_temp',
    'egg_in_pan', 'side_down', 'cook_A', 'cook_B',
    'flag_stuck', 'flag_cold', 'flag_torn', 'flag_wasted', 'egg_on_plate', 't'
  ];

  // ---------- 3.2 动作：9 个 ----------
  const ACTIONS = [
    'WAIT', 'PLACE_PAN', 'REMOVE_PAN', 'IGNITE', 'FLAME_OFF',
    'POUR_OIL', 'CRACK_EGG', 'FLIP', 'PLATE'
  ];

  // 结局名称（3.5 顺序）+ TIMEOUT 单列
  const OUTCOMES = ['WASTED', 'STUCK', 'TORN', 'BURNT', 'RAW', 'PERFECT', 'TIMEOUT'];

  // 初始状态：全 0，pan_temp = oil_temp = 20 °C
  function newState() {
    return {
      pan_on_stove: 0, flame: 0, pan_temp: 20, oil: 0, oil_temp: 20,
      egg_in_pan: 0, side_down: 0, cook_A: 0, cook_B: 0,
      flag_stuck: 0, flag_cold: 0, flag_torn: 0, flag_wasted: 0, egg_on_plate: 0, t: 0
    };
  }

  // 标准 mulberry32：给种子，返回一个 rng()，每次返回 [0,1) 的数
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 朝上那一面的熟度（画面可见）与朝下那一面的熟度（隐藏）
  function cookUp(s)   { return s.side_down === 0 ? s.cook_B : s.cook_A; }
  function cookDown(s) { return s.side_down === 0 ? s.cook_A : s.cook_B; }

  const clamp15 = (x) => Math.min(1.5, Math.max(0, x));

  // ---------- 一个 tick：先 3.4 瞬时规则，再 3.3 连续动态 ----------
  // 返回 {state: 新对象, done: null | 'END' | 'TIMEOUT'}
  function step(state, action, k) {
    if (k === undefined || k === null) k = 1.0;
    const s = Object.assign({}, state);   // 不改原对象
    let done = null;

    // 3.4 瞬时规则
    switch (action) {
      case 'WAIT':
        break;
      case 'PLACE_PAN':
        s.pan_on_stove = 1;
        break;
      case 'REMOVE_PAN':
        s.pan_on_stove = 0;
        break;
      case 'IGNITE':
        s.flame = 1;
        break;
      case 'FLAME_OFF':
        s.flame = 0;
        break;
      case 'POUR_OIL':
        if (s.pan_on_stove === 1 && s.egg_in_pan === 0) {
          if (s.oil === 0) {                     // 已有油：无效，不算误操作
            s.oil = 1;
            s.oil_temp = Math.max(20, s.pan_temp - 40);
          }
        } else {
          s.flag_wasted = 1; done = 'END';       // 误操作，回合立即结束
        }
        break;
      case 'CRACK_EGG':
        if (s.pan_on_stove === 1 && s.egg_in_pan === 0) {
          s.egg_in_pan = 1;
          if (s.oil === 0) s.flag_stuck = 1;             // 无油 → 粘底
          else if (s.oil_temp < 140) s.flag_cold = 1;     // 油温不够 → 只记录
        } else {
          s.flag_wasted = 1; done = 'END';
        }
        break;
      case 'FLIP':
        if (s.egg_in_pan === 1) {                 // 没蛋时无效
          if (cookDown(s) >= 0.5 && s.flag_stuck === 0) s.side_down = 1 - s.side_down;
          else s.flag_torn = 1;                   // 翻早破黄 / 粘底撕裂
        }
        break;
      case 'PLATE':
        if (s.egg_in_pan === 1) {                 // 没蛋时无效
          s.egg_on_plate = 1; done = 'END';
        }
        break;
      default:
        throw new Error('未知动作: ' + action);
    }
    if (done) return { state: s, done: done };    // WASTED / PLATE：不再跑本 tick 的动态

    // 3.3 连续动态
    if (s.pan_on_stove === 1 && s.flame === 1) {
      s.pan_temp += 0.08 * k * (200 - s.pan_temp);   // 只有加热项乘灶功率 k
    } else {
      s.pan_temp += 0.02 * (20 - s.pan_temp);        // 慢慢变凉，有余温
    }
    if (s.oil === 1) s.oil_temp += 0.2 * (s.pan_temp - s.oil_temp);
    const T = s.oil === 1 ? s.oil_temp : s.pan_temp;   // 有效温度
    const r = T < 120 ? 0 : Math.min((T - 120) / 60, 1) / 40;   // 熟化速率，最快 0.025/tick
    if (s.egg_in_pan === 1 && s.egg_on_plate === 0) {
      const rd = r * (s.flag_stuck === 1 ? 3 : 1);     // 粘底 ×3
      if (s.side_down === 0) {
        s.cook_A = clamp15(s.cook_A + rd);
        s.cook_B = clamp15(s.cook_B + 0.25 * r);
      } else {
        s.cook_B = clamp15(s.cook_B + rd);
        s.cook_A = clamp15(s.cook_A + 0.25 * r);
      }
    }
    s.t += 1;
    if (s.t >= 300) done = 'TIMEOUT';
    return { state: s, done: done };
  }

  // ---------- 3.5 结局判定（从上到下取第一个命中）----------
  function judge(s, done) {
    if (done === 'TIMEOUT') return 'TIMEOUT';
    if (s.flag_wasted === 1) return 'WASTED';
    const mx = Math.max(s.cook_A, s.cook_B);
    const mn = Math.min(s.cook_A, s.cook_B);
    if (s.flag_stuck === 1 && mx >= 0.3) return 'STUCK';
    if (s.flag_torn === 1) return 'TORN';
    if (mx > 1.3) return 'BURNT';
    if (mn < 0.8) return 'RAW';
    return 'PERFECT';
  }

  // 日志用：数值保留 2 位小数，字段按 FIELDS 顺序
  function roundState(s) {
    const o = {};
    for (const f of FIELDS) o[f] = Math.round(s[f] * 100) / 100;
    return o;
  }

  // 按动作数组跑到回合结束或动作用完。
  // 返回 {outcome, state, rows}；rows 每行 {t, a, s}（s 是执行 a 之前的状态）。
  function runEpisode(actions, k) {
    if (k === undefined || k === null) k = 1.0;
    let s = newState();
    let done = null;
    const rows = [];
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      rows.push({ t: s.t, a: a, s: roundState(s) });
      const r = step(s, a, k);
      s = r.state; done = r.done;
      if (done) break;
    }
    return { outcome: judge(s, done), state: s, rows: rows, done: done };
  }

  // ---------- 菜谱与 3.6 七条自测 ----------
  function rep(a, n) { const out = []; for (let i = 0; i < n; i++) out.push(a); return out; }

  // 标准菜谱：PLACE_PAN, IGNITE, WAIT×w1, POUR_OIL, WAIT×w2, CRACK_EGG, WAIT×w3, FLIP, WAIT×w4, PLATE
  function recipe(opts) {
    const o = Object.assign({ w1: 25, w2: 10, w3: 32, w4: 26, oil: true, ignite: true, flip: true }, opts || {});
    return ['PLACE_PAN']
      .concat(o.ignite ? ['IGNITE'] : [])
      .concat(rep('WAIT', o.w1))
      .concat(o.oil ? ['POUR_OIL'] : [])
      .concat(rep('WAIT', o.w2))
      .concat(['CRACK_EGG'])
      .concat(rep('WAIT', o.w3))
      .concat(o.flip ? ['FLIP'] : [])
      .concat(rep('WAIT', o.w4))
      .concat(['PLATE']);
  }
  const STANDARD_RECIPE = recipe();

  const SELF_TESTS = [
    { name: '① 标准菜谱',                     actions: recipe(),                                  expected: 'PERFECT' },
    { name: '② 去掉 POUR_OIL 且去掉 FLIP',     actions: recipe({ oil: false, flip: false }),       expected: 'STUCK' },
    { name: '③ 去掉 IGNITE 且去掉 FLIP',       actions: recipe({ ignite: false, flip: false }),    expected: 'RAW' },
    { name: '④ CRACK_EGG 后 3 tick 就 FLIP',   actions: recipe({ w3: 3 }),                         expected: 'TORN' },
    { name: '⑤ 不翻面 WAIT×90 再 PLATE',       actions: recipe({ w3: 90, w4: 0, flip: false }),    expected: 'BURNT' },
    { name: '⑥ 先 CRACK_EGG 再 POUR_OIL',      actions: ['PLACE_PAN', 'IGNITE'].concat(rep('WAIT', 25), ['CRACK_EGG', 'POUR_OIL']), expected: 'WASTED' },
    { name: '⑦ WAIT×300',                     actions: rep('WAIT', 300),                          expected: 'TIMEOUT' }
  ];

  function runSelfTests() {
    return SELF_TESTS.map(function (tc) {
      const r = runEpisode(tc.actions, 1.0);
      return { name: tc.name, expected: tc.expected, got: r.outcome, pass: r.outcome === tc.expected, t: r.state.t, state: r.state };
    });
  }

  // ---------- 批量生成：三种策略 40% 带噪专家 / 35% 变体专家 / 25% 合法随机 ----------
  const POLICY_EXPERT = 'expert', POLICY_VARIANT = 'variant', POLICY_RANDOM = 'random';

  // 等待段长度 × U(0.6, 1.4)，四舍五入，至少 1
  function jitter(rng, w) { return Math.max(1, Math.round(w * (0.6 + 0.8 * rng()))); }
  function randInt(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); } // [lo, hi] 整数

  // 带噪专家：标准菜谱，四段等待各自抖动
  function noisyExpertActions(rng) {
    return recipe({ w1: jitter(rng, 25), w2: jitter(rng, 10), w3: jitter(rng, 32), w4: jitter(rng, 26) });
  }

  // 变体专家：在带噪菜谱基础上，七种变体等概率
  const VARIANTS = ['skip_ignite', 'skip_oil_skip_flip', 'skip_oil_still_flip', 'skip_flip', 'flip_early', 'plate_late', 'crack_early'];
  function variantExpertActions(rng) {
    const v = VARIANTS[Math.floor(rng() * VARIANTS.length)];
    const w1 = jitter(rng, 25), w2 = jitter(rng, 10), w3 = jitter(rng, 32), w4 = jitter(rng, 26);
    switch (v) {
      case 'skip_ignite':         return { variant: v, actions: recipe({ w1, w2, w3, w4, ignite: false }) };
      case 'skip_oil_skip_flip':  return { variant: v, actions: recipe({ w1, w2, w3, w4, oil: false, flip: false }) };
      case 'skip_oil_still_flip': return { variant: v, actions: recipe({ w1, w2, w3, w4, oil: false }) };
      case 'skip_flip':           return { variant: v, actions: recipe({ w1, w2, w3, w4, flip: false }) };
      case 'flip_early': {        // 翻早 1–15 tick
        const early = randInt(rng, 1, 15);
        return { variant: v, actions: recipe({ w1, w2, w3: Math.max(0, w3 - early), w4 }) };
      }
      case 'plate_late': {        // 装盘晚 20–80 tick
        const late = randInt(rng, 20, 80);
        return { variant: v, actions: recipe({ w1, w2, w3, w4: w4 + late }) };
      }
      case 'crack_early': {       // 蛋提前到第 2–20 tick 下锅（锅还没热）
        const c = randInt(rng, 2, 20);
        let head;
        if (c === 2) head = ['PLACE_PAN', 'POUR_OIL', 'CRACK_EGG', 'IGNITE'];      // 第 2 tick 下锅
        else head = ['PLACE_PAN', 'IGNITE'].concat(rep('WAIT', c - 3), ['POUR_OIL', 'CRACK_EGG']); // 第 c tick 下锅
        return { variant: v, actions: head.concat(rep('WAIT', w3), ['FLIP'], rep('WAIT', w4), ['PLATE']) };
      }
    }
  }

  // 合法随机策略用的「前置条件」（只用于挑动作，不是规则本身）
  function legalActions(s) {
    const out = [];
    if (s.pan_on_stove === 0) out.push('PLACE_PAN'); else out.push('REMOVE_PAN');
    if (s.flame === 0) out.push('IGNITE'); else out.push('FLAME_OFF');
    if (s.pan_on_stove === 1 && s.egg_in_pan === 0 && s.oil === 0) out.push('POUR_OIL');
    if (s.pan_on_stove === 1 && s.egg_in_pan === 0) out.push('CRACK_EGG');
    if (s.egg_in_pan === 1) { out.push('FLIP'); out.push('PLATE'); }
    return out;
  }
  // 故意违规：挑一个当前前置条件不满足、会导致 WASTED 的动作
  function illegalActions(s) {
    const out = [];
    if (!(s.pan_on_stove === 1 && s.egg_in_pan === 0)) { out.push('POUR_OIL'); out.push('CRACK_EGG'); }
    return out;
  }

  // 合法随机：逐 tick 决策，90% WAIT，否则在合法动作里随机；每次非 WAIT 决策有 3% 概率故意违规
  function runRandomEpisode(rng, k) {
    let s = newState();
    let done = null;
    const rows = [];
    while (!done) {
      let a = 'WAIT';
      if (rng() >= 0.9) {
        let pool;
        if (rng() < 0.03) {
          pool = illegalActions(s);
          if (pool.length === 0) pool = legalActions(s);
        } else {
          pool = legalActions(s);
        }
        a = pool[Math.floor(rng() * pool.length)];
      }
      rows.push({ t: s.t, a: a, s: roundState(s) });
      const r = step(s, a, k);
      s = r.state; done = r.done;
    }
    return { outcome: judge(s, done), state: s, rows: rows, done: done };
  }

  // 脚本型策略若动作用完还没结束（理论上不会，PLATE 必结束），补 WAIT 直到结束
  function runScriptedEpisode(actions, k) {
    const r = runEpisode(actions, k);
    if (r.done) return r;
    let s = r.state, done = null;
    while (!done) {
      r.rows.push({ t: s.t, a: 'WAIT', s: roundState(s) });
      const q = step(s, 'WAIT', k);
      s = q.state; done = q.done;
    }
    return { outcome: judge(s, done), state: s, rows: r.rows, done: done };
  }

  // generateBatch(N, seed, onProgress?) -> {rows, counts, policyCounts}
  function generateBatch(N, seed, onProgress) {
    const rng = mulberry32(seed);
    const rows = [];
    const counts = {}; OUTCOMES.forEach(o => counts[o] = 0);
    const policyCounts = { expert: 0, variant: 0, random: 0 };
    for (let ep = 0; ep < N; ep++) {
      const u = rng();
      const policy = u < 0.40 ? POLICY_EXPERT : (u < 0.75 ? POLICY_VARIANT : POLICY_RANDOM);
      const k = Math.round((0.85 + 0.30 * rng()) * 1000) / 1000;   // 灶功率，保留 3 位
      let r;
      if (policy === POLICY_EXPERT) r = runScriptedEpisode(noisyExpertActions(rng), k);
      else if (policy === POLICY_VARIANT) r = runScriptedEpisode(variantExpertActions(rng).actions, k);
      else r = runRandomEpisode(rng, k);
      for (const row of r.rows) {
        rows.push({ ep: ep, t: row.t, k: k, a: row.a, policy: policy, outcome: r.outcome, s: row.s });
      }
      counts[r.outcome] += 1;
      policyCounts[policy] += 1;
      if (onProgress && ((ep + 1) % 50 === 0 || ep + 1 === N)) onProgress(ep + 1, N);
    }
    return { rows: rows, counts: counts, policyCounts: policyCounts };
  }

  // ---------- 导出 ----------
  function toJSONL(rows) {
    return rows.map(r => JSON.stringify({ ep: r.ep, t: r.t, k: r.k, a: r.a, policy: r.policy, outcome: r.outcome, s: r.s })).join('\n') + '\n';
  }
  function toCSV(rows) {
    const head = ['ep', 't', 'k', 'a', 'policy', 'outcome'].concat(FIELDS);
    const lines = [head.join(',')];
    for (const r of rows) {
      const line = [r.ep, r.t, r.k, r.a, r.policy, r.outcome];
      for (const f of FIELDS) line.push(r.s[f]);
      lines.push(line.join(','));
    }
    return lines.join('\n') + '\n';
  }

  return {
    FIELDS, ACTIONS, OUTCOMES, VARIANTS,
    newState, mulberry32, step, judge, cookUp, cookDown,
    runEpisode, recipe, STANDARD_RECIPE,
    SELF_TESTS, runSelfTests,
    generateBatch, toJSONL, toCSV
  };
});
