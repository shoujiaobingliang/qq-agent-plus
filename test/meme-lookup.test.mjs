import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// 与其它工具用例同口径：先给临时数据目录，再动态 import（config 在模块加载期读 DATA_DIR）。
const __dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-meme-lookup-'));
process.env.QQ_AGENT_DATA_DIR = __dir;
process.on('exit', () => { try { fs.rmSync(__dir, { recursive: true, force: true }); } catch { /* Windows 可能占着句柄 */ } });

const {
  lookupSlang,
  readSlangRecords,
  upsertSlangCandidate
} = await import('../src/core/slang-store.js');
const {
  resetMemeLookupState,
  runMemeLookup
} = await import('../src/llm/meme-lookup.js');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(__dir, 'case-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeLibrary(dir, entries) {
  fs.writeFileSync(path.join(dir, 'slang.json'), JSON.stringify(entries, null, 2));
}

function webResult(query, results) {
  return { query, results };
}

test('本地查询命中词条与别名，并按 confirmed 优先排序', (t) => {
  const dir = tempDir(t);
  writeLibrary(dir, [
    { id: 'a', content: '典中典', aliases: ['经典永流传'], meaning: '非常经典', status: 'candidate' },
    { id: 'b', content: '开香槟', meaning: '提前庆祝', status: 'confirmed' }
  ]);
  const byAlias = lookupSlang('经典永流传', { dataDir: dir });
  assert.equal(byAlias[0].content, '典中典');
  assert.equal(byAlias[0].status, 'candidate');
  const byTerm = lookupSlang('  「开香槟」 ', { dataDir: dir });
  assert.equal(byTerm[0].content, '开香槟');
  assert.equal(byTerm[0].matchScore, 1);
});

test('本地查询不做群作用域隔离，但会过滤 rejected', (t) => {
  const dir = tempDir(t);
  writeLibrary(dir, [
    {
      id: 'private',
      content: '本群暗号',
      meaning: '旧的自定义说法',
      status: 'confirmed',
      scope: 'chat-private',
      scopeChatKey: 'group:100'
    },
    { id: 'rejected', content: '坏梗', meaning: '不该再出现', status: 'rejected' }
  ]);
  assert.equal(lookupSlang('本群暗号', { dataDir: dir }).length, 1);
  assert.equal(lookupSlang('坏梗', { dataDir: dir }).length, 0);
});

test('外部候选去重合并别名；已确认解释不被候选覆盖；被拒绝的词不复活', (t) => {
  const dir = tempDir(t);
  const first = upsertSlangCandidate({
    term: '典中典',
    meaning: '非常经典的说法',
    aliases: ['经典永流传'],
    source: 'moegirl',
    sourceUrl: 'https://example.test/a',
    confidence: 0.4
  }, { dataDir: dir });
  assert.equal(first.created, true);
  assert.equal(first.entry.status, 'candidate');
  assert.equal(first.entry.scope, 'global-safe');

  const second = upsertSlangCandidate({
    term: ' 典中典 ',
    meaning: '模型提炼的新解释',
    aliases: ['典'],
    source: 'ai',
    overrideMeaning: true
  }, { dataDir: dir });
  assert.equal(second.created, false);
  assert.equal(second.updated, true);
  assert.deepEqual(second.entry.aliases, ['经典永流传', '典']);
  assert.equal(second.entry.meaning, '模型提炼的新解释');
  assert.equal(readSlangRecords(dir).length, 1);

  writeLibrary(dir, [
    { id: 'confirmed', content: '开香槟', meaning: '人工确认的解释', status: 'confirmed' },
    { id: 'rejected', content: '坏梗', meaning: '别用', status: 'rejected' }
  ]);
  const confirmed = upsertSlangCandidate({
    term: '开香槟', meaning: '外部候选解释', source: 'web', overrideMeaning: true
  }, { dataDir: dir });
  assert.equal(confirmed.entry.meaning, '人工确认的解释');
  const rejected = upsertSlangCandidate({
    term: '坏梗', meaning: '又被搜到了', source: 'web', overrideMeaning: true
  }, { dataDir: dir });
  assert.equal(rejected.skipped, 'rejected');
  assert.equal(rejected.entry.meaning, '别用');
});

test('auto 先查本地：命中时不外呼', async (t) => {
  const dir = tempDir(t);
  writeLibrary(dir, [{ id: 'a', content: '开香槟', meaning: '提前庆祝', status: 'confirmed' }]);
  resetMemeLookupState();
  let calls = 0;
  const result = await runMemeLookup({ term: '开香槟' }, {
    dataDir: dir,
    webSearchFn: async () => { calls += 1; return webResult('', []); },
    sourceSearchFn: async () => { calls += 1; return { results: [] }; }
  });
  assert.equal(result.stage, 'local');
  assert.equal(result.found, true);
  assert.equal(calls, 0);
});

test('auto 本地没有时普通搜索，并给出可检查的不足信号；结果进短期缓存', async (t) => {
  const dir = tempDir(t);
  resetMemeLookupState();
  let calls = 0;
  const queries = [];
  const run = (term) => runMemeLookup({ term }, {
    dataDir: dir,
    webSearchFn: async (query) => {
      calls += 1;
      queries.push(query);
      return webResult(query, [{
        title: '典中典是什么梗',
        url: 'https://example.test/1',
        snippet: '典中典是指非常经典的言论，常用于调侃。'
      }]);
    },
    sourceSearchFn: async () => { throw new Error('不该走到梗来源'); }
  });
  const first = await run('典中典');
  assert.equal(first.stage, 'web');
  assert.equal(first.signals.mentionsTerm, true);
  assert.equal(first.signals.definitionLike, true);
  assert.equal(first.signals.likelyInsufficient, false);
  assert.match(queries[0], /典中典/);
  const second = await run('典中典');
  assert.equal(second.cached, true);
  assert.equal(calls, 1, '第二次应命中进程内缓存');
});

test('普通搜索结果只有字面意思时 likelyInsufficient=true', async (t) => {
  const dir = tempDir(t);
  resetMemeLookupState();
  const result = await runMemeLookup({ term: '扎啤' }, {
    dataDir: dir,
    webSearchFn: async (query) => webResult(query, [{
      title: '扎啤 - 京东',
      url: 'https://example.test/beer',
      snippet: '整箱批发，24 听装包邮，冷链配送。'
    }]),
    sourceSearchFn: async () => { throw new Error('不该走到梗来源'); }
  });
  assert.equal(result.signals.likelyInsufficient, true);
});

test('mode=source 查梗来源、自动存候选，之后 auto 直接命中本地', async (t) => {
  const dir = tempDir(t);
  resetMemeLookupState();
  let sourceCalls = 0;
  const source = await runMemeLookup({ term: '典中典', mode: 'source' }, {
    dataDir: dir,
    webSearchFn: async () => { throw new Error('不该走普通搜索'); },
    sourceSearchFn: async () => {
      sourceCalls += 1;
      return {
        results: [{
          title: '典中典',
          url: 'https://example.test/moegirl',
          snippet: '典中典是指非常经典的言论，源自网络社区。',
          source: '萌娘百科'
        }]
      };
    }
  });
  assert.equal(source.stage, 'source');
  assert.equal(sourceCalls, 1);
  assert.equal(source.saved.term, '典中典');
  assert.equal(source.saved.status, 'candidate');

  const auto = await runMemeLookup({ term: '典中典' }, {
    dataDir: dir,
    webSearchFn: async () => { throw new Error('本地命中后不应外呼'); },
    sourceSearchFn: async () => { throw new Error('本地命中后不应外呼'); }
  });
  assert.equal(auto.stage, 'local');
  assert.equal(auto.entries[0].definition, '典中典是指非常经典的言论，源自网络社区。');
});

test('mode=memorize 保存模型提炼的解释，dedupe 到同一条', async (t) => {
  const dir = tempDir(t);
  resetMemeLookupState();
  const saved = await runMemeLookup({
    term: '典中典',
    mode: 'memorize',
    meaning: '形容非常经典、值得反复引用的发言',
    usage: '看到经典发言时调侃',
    aliases: ['经典永流传']
  }, { dataDir: dir });
  assert.equal(saved.stage, 'memorize');
  assert.equal(saved.saved.definition, '形容非常经典、值得反复引用的发言');
  assert.equal(saved.created, true);

  const again = await runMemeLookup({
    term: '典中典',
    mode: 'memorize',
    meaning: '更短的解释'
  }, { dataDir: dir });
  assert.equal(again.created, false);
  assert.equal(again.saved.definition, '更短的解释');
  assert.equal(readSlangRecords(dir).length, 1);
});

test('普通搜索失败时自动回退梗来源', async (t) => {
  const dir = tempDir(t);
  resetMemeLookupState();
  const result = await runMemeLookup({ term: '典中典' }, {
    dataDir: dir,
    webSearchFn: async () => { throw new Error('搜索服务 HTTP 503'); },
    sourceSearchFn: async () => ({
      results: [{
        title: '典中典',
        url: 'https://example.test/m',
        snippet: '典中典是指经典言论。',
        source: '萌娘百科'
      }]
    })
  });
  assert.equal(result.stage, 'source');
  assert.match(result.webError, /503/);
  assert.equal(result.saved.term, '典中典');
});

test('工具表里有 meme_lookup，且描述教模型在普通搜索读不通时升级到梗来源', async () => {
  const { buildToolDefs } = await import('../src/tools/tools-core.js');
  const tool = buildToolDefs().find((entry) => entry.name === 'meme_lookup');
  assert.ok(tool);
  assert.match(tool.description, /mode="source"/);
  assert.deepEqual(tool.parameters.properties.mode.enum, ['auto', 'source', 'memorize']);
});

test('MediaWiki 结果解析：去 HTML、编码标题、保留来源', async () => {
  const { parseMediaWikiResults, parseMediaWikiHtml } = await import('../src/llm/meme-search.js');
  const results = parseMediaWikiResults({
    query: {
      search: [
        { title: '典中典', snippet: '<span class="searchmatch">典中典</span>是指经典言论 &amp; 名场面' },
        { title: '', snippet: '没有标题的条目' },
        { title: '梗/列表', snippet: '带斜杠的标题' }
      ]
    }
  }, { name: '萌娘百科', articleUrl: 'https://mzh.moegirl.org.cn/' }, 4);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, '典中典');
  assert.equal(results[0].snippet, '典中典 是指经典言论 & 名场面');
  assert.equal(results[0].url, 'https://mzh.moegirl.org.cn/%E5%85%B8%E4%B8%AD%E5%85%B8');
  assert.equal(results[0].source, '萌娘百科');
  assert.match(results[1].url, /%2F/, '标题里的斜杠必须编码，不能变成路径');

  const html = `<ul>
    <li class="mw-search-result">
      <div class="mw-search-result-heading"><a href="/%E5%85%B8%E4%B8%AD%E5%85%B8">典中典</a></div>
      <div class="searchresult">  <b>典中典</b> 是一个网络流行词，指经典中的经典。 </div>
    </li>
    <li class="mw-search-result">
      <div class="mw-search-result-heading"><a href="/x">无关条目</a></div>
      <div class="searchresult">只是名字里带一个典字。</div>
    </li>
  </ul>`;
  const fromHtml = parseMediaWikiHtml(html, {
    name: '萌娘百科',
    articleUrl: 'https://mzh.moegirl.org.cn/'
  }, 4);
  assert.equal(fromHtml.length, 2);
  assert.equal(fromHtml[0].title, '典中典');
  assert.equal(fromHtml[0].url, 'https://mzh.moegirl.org.cn/%E5%85%B8%E4%B8%AD%E5%85%B8');
  assert.equal(fromHtml[0].snippet, '典中典 是一个网络流行词，指经典中的经典。');
});
