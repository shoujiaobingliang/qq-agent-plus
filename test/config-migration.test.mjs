// 老配置（四段式滑条）读盘时必须一次性迁移成"滑条上的数字就是概率"。
//
// 这条用例专门防一个真踩过的坑（2026-09-22 审查发现）：把 `sliderMode: 'probability'`
// 写进 DEFAULT_CONFIG 之后，`loadConfig` 的 deepMerge 会替老配置补上这个键，
// 于是"文件里到底有没有这个键"再也分不出来 —— 迁移判定放进 updateConfig 时永远不成立，
// 老 1/2 档用户会被当成 5~20% 概率开始接话、老 4 档会丢掉"全响应"。
// 所以必须**真的写一份老形状的 config.json、再用新进程加载它**：
// 内存里构造对象（显式 sliderMode: ''）和同进程 import 都测不出这个坑
// （ESM 模块缓存会让 config-legacy 停留在第一次的 DATA_DIR 上）。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 一个进程只挂一个 exit 处理器（每个用例各挂一个会触发 MaxListenersExceededWarning）
const tempDirs = new Set();
process.on('exit', () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
});
const CONFIG_URL = pathToFileURL(path.join(REPO, 'src', 'core', 'config.js')).href;

/**
 * 写一份 config.json → 新起一个 Node 进程加载它 → 取回 store（可选再跑一段脚本并取回第二次）。
 * 另回传 `full`（整份配置）：store 只是其中一段，"外观"那类根级段落要用它。
 */
function loadStoreInNewProcess(config, extraScript = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-config-migrate-'));
  tempDirs.add(dir);   // 用例自己造的临时目录自己清（约定见 test/README.md）
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  const script = `
    process.env.QQ_AGENT_DATA_DIR = ${JSON.stringify(dir)};
    const { getConfig, updateConfig } = await import(${JSON.stringify(CONFIG_URL)});
    const first = structuredClone(getConfig().store);
    ${extraScript}
    console.log(JSON.stringify({ first, after: getConfig().store, full: getConfig(), file: ${JSON.stringify(file)} }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  const parsed = JSON.parse(out.trim().split('\n').pop());
  return { ...parsed, dir };
}

test('老四段式滑条：1/2 档迁移成 0%，3 档保留概率，4 档迁移成 100%', () => {
  for (const [contextSliderPos, contextTier, randomPercent, wantPct, wantTier] of [
    [5, 1, 0, 0, 1],       // 老 1 档（仅艾特）：不掷骰子
    [15, 2, 0, 0, 1],      // 老 2 档（+关键词）：不掷骰子
    [55, 3, 50, 50, 3],    // 老 3 档正中：概率原样搬过来
    [95, 4, 100, 100, 4]   // 老 4 档（全响应）
  ]) {
    const { first } = loadStoreInNewProcess({ store: { contextSliderPos, contextTier, randomPercent } });
    assert.equal(first.randomPercent, wantPct, `位置 ${contextSliderPos} 应迁移成 ${wantPct}%`);
    assert.equal(first.contextSliderPos, wantPct, '滑条位置也落在概率上');
    assert.equal(first.contextTier, wantTier, `档位展示应为 ${wantTier}`);
    assert.equal(first.sliderMode, 'probability', '迁移后要打标记，避免二次换算');
  }
});

test('老配置连滑条位置都没有：按老档位换算，不能被当成"没填=全响应"', () => {
  assert.equal(
    loadStoreInNewProcess({ store: { contextTier: 1, randomPercent: 0 } }).first.randomPercent,
    0, '老 1 档 → 0%'
  );
  assert.equal(
    loadStoreInNewProcess({ store: { contextTier: 4, randomPercent: 100 } }).first.randomPercent,
    100, '老 4 档 → 100%'
  );
  assert.equal(
    loadStoreInNewProcess({ store: { contextSliderPos: null, contextTier: 2, randomPercent: 0 } }).first.randomPercent,
    0, 'null 位置 → 按老 2 档 → 0%'
  );
});

test('分群表也换算；新语义原样保留；写回后再加载不漂移', () => {
  const legacy = loadStoreInNewProcess({
    store: {
      contextTier: 4, randomPercent: 100, contextSliderPos: 95,
      unifiedTier: false, groupSliderPos: { '111': 5, '222': 55, '333': 95 }
    }
  }, 'updateConfig({ ui: { refreshMs: 7000 } });');   // 迁移后保存一次（走真实落盘路径）
  assert.deepEqual(
    legacy.first.groupSliderPos,
    { '111': 0, '222': 50, '333': 100 },
    '老的分群位置要换算成概率'
  );
  assert.equal(legacy.after.randomPercent, 100, '保存一次之后仍是 100%');

  // 幂等：写回文件后再加载一次，值不漂移（43 不能再被换算成 32.9）
  const reloaded = loadStoreInNewProcess(JSON.parse(fs.readFileSync(legacy.file, 'utf8')));
  assert.equal(reloaded.first.randomPercent, 100);
  assert.deepEqual(reloaded.first.groupSliderPos, { '111': 0, '222': 50, '333': 100 });

  // 已经是新语义的配置原样保留
  const fresh = loadStoreInNewProcess({
    store: { sliderMode: 'probability', contextSliderPos: 43, contextTier: 3, randomPercent: 43 }
  });
  assert.equal(fresh.first.randomPercent, 43);
});

test('只有 randomPercent、没有 tier/位置的老配置：按概率本身读，别变成全响应', () => {
  // 手写配置可能长这样。迁移时若按"没有 tier → 默认 4 档"处理，0% 会被抬成 100%（全响应）
  const onlyPct = loadStoreInNewProcess({ store: { randomPercent: 0, atCount: 5 } });
  assert.equal(onlyPct.first.randomPercent, 0, '0% 要原样保留');
  assert.equal(onlyPct.first.contextTier, 1);
  const halfPct = loadStoreInNewProcess({ store: { randomPercent: 50 } });
  assert.equal(halfPct.first.randomPercent, 50);
  assert.equal(halfPct.first.contextTier, 3);

  // 完全没有 store 段的老配置：沿用默认（全响应），不报错
  const bare = loadStoreInNewProcess({ server: { port: 3210, token: 'x' } });
  assert.equal(bare.first.randomPercent, 100, '默认是全响应（与老默认档 4 一致）');
  assert.equal(bare.first.sliderMode, 'probability');
});

/** 同 loadStoreInNewProcess，但回传整个配置（顶层），用于验证"坏字段不连累其他配置"。 */
function loadWholeConfigInNewProcess(rawText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-config-malformed-'));
  tempDirs.add(dir);
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, rawText);
  const script = `
    process.env.QQ_AGENT_DATA_DIR = ${JSON.stringify(dir)};
    const { getConfig } = await import(${JSON.stringify(CONFIG_URL)});
    console.log(JSON.stringify(structuredClone(getConfig())));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  return { config: JSON.parse(out.trim().split('\n').pop()), dir };
}

// ── 2026-09-23 全面审查发现：坏字段会连累整份配置（apiKey/白名单/人设一起没） ──

test('子段被手改成标量：其余配置不许被整份退回默认值', () => {
  // identityPilot.friendProposal 被手改成 true 时，老代码在迁移里抛 TypeError
  // （Cannot create property 'mode' on boolean），被 loadConfig 的 catch 吞掉 →
  // 整份配置退回默认值并持久化 → apiKey、白名单、人设正文全丢。
  const { config } = loadWholeConfigInNewProcess(JSON.stringify({
    api: { apiKey: 'keep-me', model: 'm1', baseUrl: 'https://example.invalid/v1' },
    identityPilot: { friendProposal: true },
    aiNames: { self: '小鲸鱼' }
  }));
  assert.equal(config.api.apiKey, 'keep-me', '一个坏子段不能把整份配置冲掉');
  assert.equal(config.api.model, 'm1');
  assert.equal(config.identityPilot.friendProposal.mode, 'triggered', '坏掉的子段按默认模式恢复');
});

test('config.json 解析不了：退回默认值，但先把原件留一份', () => {
  const { config, dir } = loadWholeConfigInNewProcess('{"api": {"apiKey": "keep-me"},');
  const backups = fs.readdirSync(dir).filter((name) => name.startsWith('config.json.broken-'));
  assert.equal(backups.length, 1, '解析失败必须留下 config.json.broken-* 备份');
  assert.match(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), /keep-me/);
  assert.equal(String(config.api.apiKey || ''), '', '退回默认值（apiKey 为空）');
});

test('整个 config.json 是个标量：按空配置恢复，不抛错', () => {
  const { config } = loadWholeConfigInNewProcess('5');
  assert.equal(typeof config, 'object');
  // 按"未绑定"恢复（与 persona 段被写坏时的规则一致）：坏字段不许被治好成绑定默认卡
  assert.equal(config.persona.templateId, '', '按未绑定恢复，不静默绑上默认卡');
});

test('省 Token：老配置缺键补 off、坏值不许带崩整份配置', () => {
  const missing = loadWholeConfigInNewProcess(JSON.stringify({ api: { apiKey: 'keep-me' } }));
  assert.equal(missing.config.tokenSaver?.mode, 'off', '缺键时补 off（默认关闭）');
  const bad = loadWholeConfigInNewProcess(JSON.stringify({ tokenSaver: { mode: 5 }, api: { apiKey: 'keep-me' } }));
  assert.equal(bad.config.tokenSaver.mode, 'off', '坏值按 off');
  assert.equal(bad.config.api.apiKey, 'keep-me', '坏值不许把整份配置冲掉');
  const scaled = loadWholeConfigInNewProcess(JSON.stringify({ tokenSaver: 'balanced', api: { apiKey: 'keep-me' } }));
  assert.equal(scaled.config.tokenSaver.mode, 'off', '整段被写成字符串时也按 off');
  const good = loadWholeConfigInNewProcess(JSON.stringify({ tokenSaver: { mode: 'aggressive' } }));
  assert.equal(good.config.tokenSaver.mode, 'aggressive', '合法值原样保留');
});

// ── 平台能力键拆细（2026-10-07：读/写分开 + 按群覆盖 + 配额上限）──
test('平台能力拆细：老配置只开过 avatarWrites 时，昵称也回填成开（意图不许被拆细收掉一半）', () => {
  const on = loadWholeConfigInNewProcess(JSON.stringify({ platform: { avatarWrites: true }, api: { apiKey: 'keep-me' } }));
  assert.equal(on.config.platform.avatarWrites, true, '老键原样保留');
  assert.equal(on.config.platform.nicknameWrites, true, '显式开过外观开关 → 改昵称一并回填');
  const off = loadWholeConfigInNewProcess(JSON.stringify({ platform: { avatarWrites: false }, api: { apiKey: 'keep-me' } }));
  assert.equal(off.config.platform.nicknameWrites, false, '没开过就保持新默认关');
  const absent = loadWholeConfigInNewProcess(JSON.stringify({ api: { apiKey: 'keep-me' } }));
  assert.equal(absent.config.platform.nicknameWrites, false, '全新配置默认关');
  assert.equal(absent.config.platform.reactionsWrite, true, '拆出来的写侧默认延续拆细前（开）');
  assert.equal(absent.config.platform.avatarWrites, false, '拆出来的头像键仍是默认关');
});

test('平台能力：perGroup / quotas 坏形状被归一化，不牵连整份配置', () => {
  const bad = loadWholeConfigInNewProcess(JSON.stringify({
    platform: { perGroup: 'nope', quotas: [1, 2] },
    api: { apiKey: 'keep-me' }
  }));
  assert.deepEqual(bad.config.platform.perGroup, {}, '整段写坏 → 空表');
  assert.deepEqual(bad.config.platform.quotas,
    { reactionsPerHour: 10, albumWritesPerHour: 5, profilePerDay: 1, remarksPerDay: 1, avatarsPerWeek: 1 },
    '整段写坏 → 默认值');
  assert.equal(bad.config.api.apiKey, 'keep-me', '坏字段不许把整份配置冲掉');

  const dirty = loadWholeConfigInNewProcess(JSON.stringify({
    platform: {
      perGroup: {
        '433': { reactionsWrite: false, albumWrites: 'yes', readReceipts: true, bogus: 1 },
        '999': 'not-an-object'
      }
    },
    api: { apiKey: 'keep-me' }
  }));
  assert.deepEqual(dirty.config.platform.perGroup, { '433': { reactionsWrite: false } },
    '只留"合法门控键 + 显式布尔值"；字符串值、非门控键（readReceipts）、坏形状的群整条丢掉');
});

// ── 平台能力：换头像额度从"每天"改"每周"（2026-10-07，按真人标准）──
test('平台能力：老配置的 avatarsPerDay 搬成 avatarsPerWeek，值不丢、老键不留', () => {
  const carried = loadWholeConfigInNewProcess(JSON.stringify({
    platform: { quotas: { avatarsPerDay: 3 } },
    api: { apiKey: 'keep-me' }
  }));
  assert.equal(carried.config.platform.quotas.avatarsPerWeek, 3, '老键的值要搬到新键（用户改过的额度不许被重置）');
  assert.equal(carried.config.platform.quotas.avatarsPerDay, undefined,
    '老键必须删掉：留着的话控制台"留空 = 用默认"那条兜底会读到它，等于这项改不动');
  assert.equal(carried.config.api.apiKey, 'keep-me', '迁移不许连累其它段');

  const fresh = loadWholeConfigInNewProcess(JSON.stringify({ api: { apiKey: 'keep-me' } }));
  assert.equal(fresh.config.platform.quotas.avatarsPerWeek, 1, '没存过的按新默认（1/周）');
  const junk = loadWholeConfigInNewProcess(JSON.stringify({
    platform: { quotas: { avatarsPerDay: 'abc' } }, api: { apiKey: 'keep-me' }
  }));
  assert.equal(junk.config.platform.quotas.avatarsPerWeek, 1, '老键是坏值时按新默认');
});

// ── 平台能力：老"伞键"被显式关掉时，拆细出来的写侧兄弟键也要跟着关（升级不许静默扩权）──
test('平台能力：老配置 reactions/profileWrites/groupTools/groupFiles/albumRead=false 时，写侧兄弟键一并关', () => {
  const off = loadWholeConfigInNewProcess(JSON.stringify({
    platform: { reactions: false, profileWrites: false, groupTools: false, groupFiles: false, albumRead: false },
    api: { apiKey: 'keep-me' }
  }));
  const p = off.config.platform;
  for (const [oldKey, newKey] of [['reactions', 'reactionsWrite'], ['profileWrites', 'remarkWrites'],
    ['groupTools', 'groupWrites'], ['groupFiles', 'groupFileSend'], ['albumRead', 'albumWrites']]) {
    assert.equal(p[oldKey], false, `${oldKey} 原样保留`);
    assert.equal(p[newKey], false, `${oldKey}=false 要下传到 ${newKey}（否则升级即悄悄放行写动作）`);
  }
  assert.equal(p.avatarWrites, false, '没存过外观开关时仍是默认关');
  assert.equal(p.nicknameWrites, false);
  assert.equal(p.qqVoice, true, '没碰过的键仍按默认开');
  assert.equal(off.config.api.apiKey, 'keep-me', '迁移不许连累其它段');
});

test('平台能力：控制台保存过的 15 键配置，迁移不许改写其中任何一项', () => {
  const saved = loadWholeConfigInNewProcess(JSON.stringify({
    platform: {
      reactions: false, reactionsWrite: true,        // 用户手改过：读关、写开（运行时语义就是互不牵连）
      profileWrites: false, remarkWrites: true,
      groupTools: false, groupWrites: true,
      groupFiles: false, groupFileSend: true,
      albumRead: false, albumWrites: true
    },
    api: { apiKey: 'keep-me' }
  }));
  const p = saved.config.platform;
  for (const key of ['reactionsWrite', 'remarkWrites', 'groupWrites', 'groupFileSend', 'albumWrites']) {
    assert.equal(p[key], true, `${key} 已显式存过 true，迁移不许把它按老伞键改成 false`);
  }
});

test('平台能力：换头像额度从老键搬过来时夹到 1~200（0.5 不能变成 0 —— 闸门把 0 当不限量）', () => {
  const tiny = loadWholeConfigInNewProcess(JSON.stringify({
    platform: { quotas: { avatarsPerDay: 0.5 } }, api: { apiKey: 'keep-me' }
  }));
  assert.equal(tiny.config.platform.quotas.avatarsPerWeek, 1, '0.5 夹到下界 1，不许留 0');
  const huge = loadWholeConfigInNewProcess(JSON.stringify({
    platform: { quotas: { avatarsPerDay: 9999 } }, api: { apiKey: 'keep-me' }
  }));
  assert.equal(huge.config.platform.quotas.avatarsPerWeek, 200, '上界仍夹到 200');
});

// 外观 v2 → v3（2026-10-08）：v2 只有"主题配色"（ui.preset）一个抽象，v3 拆成"表面色板"与
// "强调色"两条轴。老值要按色相搬到 accentPreset，并且把 preset 删掉 —— 留着它就有两个真源
// （界面读 accentPreset，存档里还躺着一个 preset，而保存路径根本不写 preset，它会永远留在那）。
test('外观 v2 → v3：旧的主题配色 id 搬进 accentPreset，preset 字段被清掉', () => {
  const legacy = loadStoreInNewProcess({ ui: { preset: 'mint', theme: 'light' } });
  assert.equal(legacy.full.ui.accentPreset, 'emerald', 'mint 应按色相搬成 emerald');
  assert.equal('preset' in legacy.full.ui, false, 'preset 要删掉，避免两个真源');
  assert.equal(legacy.full.ui.theme, 'light', '明暗沿用老字段 ui.theme，不能被迁移搞丢');

  // 认不出的旧值：回落到默认强调色，但仍然要把 preset 清掉
  const unknown = loadStoreInNewProcess({ ui: { preset: '不存在' } });
  assert.equal(unknown.full.ui.accentPreset, 'indigo');
  assert.equal('preset' in unknown.full.ui, false);

  // 已经是 v3 的配置原样保留（迁移不能反过来覆盖新版字段）
  const modern = loadStoreInNewProcess({ ui: { accentPreset: 'rose', scheme: 'nord', preset: 'mint' } });
  assert.equal(modern.full.ui.accentPreset, 'rose', '新版字段优先，不被旧 preset 覆盖');
  assert.equal('preset' in modern.full.ui, false);
});

test('外观 v3：新版键在缺省时由默认值补齐（老配置升上来不会缺项）', () => {
  const { full } = loadStoreInNewProcess({ ui: { theme: 'dark' } });
  const first = { ui: full.ui };
  for (const [key, want] of Object.entries({
    darkIntensity: 'soft', scheme: 'default', accentPreset: 'indigo', accent: '',
    accentScope: 'global', sidebarStyle: 'follow', background: 'none', font: 'default',
    radius: 1, zoom: 1, density: 'cozy', contrast: 'normal'
  })) {
    assert.deepEqual(first.ui[key], want, `ui.${key} 缺省值不对`);
  }
  assert.equal(first.ui.showBadges, true);
  assert.equal(first.ui.showTopbarTheme, true);
  assert.equal(first.ui.reduceMotion, false);
  assert.equal(first.ui.noMotion, false);
  assert.deepEqual(first.ui.tweaks, {});
});

test('人设 templateId 写成 null：按未绑定处理，不退回默认卡', () => {
  // deepMerge 把 null 当"没给"；不先归一成空串的话，默认卡的正文会盖掉自定义正文
  const { full } = loadStoreInNewProcess({
    persona: { templateId: null, roleText: '我自己的正文', botName: '小鲸鱼' }
  });
  assert.equal(full.persona.templateId, '', 'null 要归一成未绑定');
  assert.equal(full.persona.roleText, '我自己的正文', '自定义正文不能被默认卡覆盖');
});

test('跨分支的未知 behaviorProfile：加载时回落 legacy，后续 updateConfig 不再抛错', () => {
  // 真实故障（2026-10-20）：作者分支写入的档位名/空串留在 config.json 里，
  // 切回自己的分支后 configure-linux 的 updateConfig 直接抛
  // "Invalid persona behavior profile"，部署脚本中断。
  for (const bad of ['persona-driven', '']) {
    const { full } = loadStoreInNewProcess(
      { persona: { roleText: '自定义正文', behaviorProfile: bad } },
      // 模拟 configure-linux：用一份不含 persona 的 patch 走一次 updateConfig
      "updateConfig({ api: { model: 'after-migrate' } });"
    );
    assert.equal(full.persona.behaviorProfile, 'legacy', `坏值 ${JSON.stringify(bad)} 要回落到 legacy`);
    assert.equal(full.persona.roleText, '自定义正文', '档位回落不该动角色正文');
    assert.equal(full.api.model, 'after-migrate', 'updateConfig 要能正常完成');
  }
});
