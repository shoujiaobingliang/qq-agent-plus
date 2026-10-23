// 自定义索引来源（src/plugins/sources.js）的验收用例。
//
// 这里不联网：fetchText 由用例注入，正反例都靠假响应钉死 —— 探测逻辑的价值就在
// "地址真的是一份能读的索引吗"，把抓取换成桩之后这条性质仍然可测。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_CUSTOM_INDEX_SOURCES,
  githubRepoOf,
  normalizeSourceInputs,
  normalizeSourceUrl,
  probeIndexSource,
  resolveIndexSources,
  sourceUrlCandidates
} from '../src/plugins/sources.js';

const INDEX_BODY = JSON.stringify({
  plugins: [{
    id: 'demo',
    name: '演示插件',
    version: '1.0.0',
    capabilities: ['tools'],
    apiVersion: 1,
    downloadUrl: 'https://example.com/demo-1.0.0.tar.gz',
    sha256: 'a'.repeat(64)
  }]
});

const ok = (body = INDEX_BODY) => async () => ({ statusCode: 200, body });
const notFound = async () => ({ statusCode: 404, body: 'not found' });

test('地址归一化：补协议、去 hash、拒绝非 http(s) 与带凭据的地址', () => {
  assert.equal(normalizeSourceUrl('github.com/owner/repo'), 'https://github.com/owner/repo');
  assert.equal(normalizeSourceUrl('https://example.com/index.json#x'), 'https://example.com/index.json');
  assert.throws(() => normalizeSourceUrl(''), /不能为空/);
  assert.throws(() => normalizeSourceUrl('ftp://example.com/index.json'), /只支持 http\(s\)/);
  assert.throws(() => normalizeSourceUrl('javascript:alert(1)'), /http/);
  assert.throws(() => normalizeSourceUrl('https://user:pass@example.com/index.json'), /用户名或密码/);
  assert.throws(() => normalizeSourceUrl(`https://example.com/${'x'.repeat(2100)}`), /不能超过/);
});

test('GitHub 仓库地址展开成两个候选；普通地址原样一个候选', () => {
  assert.deepEqual(githubRepoOf('https://github.com/owner/repo'), { owner: 'owner', repo: 'repo' });
  assert.equal(githubRepoOf('https://github.com/owner/repo/tree/main'), null, '带子路径不按仓库处理');

  const repo = sourceUrlCandidates('https://github.com/owner/repo');
  assert.equal(repo.kind, 'repo');
  assert.deepEqual(repo.candidates, [
    'https://raw.githubusercontent.com/owner/repo/HEAD/plugins/index.json',
    'https://raw.githubusercontent.com/owner/repo/HEAD/index.json'
  ]);

  const direct = sourceUrlCandidates('https://example.com/index.json');
  assert.equal(direct.kind, 'index');
  assert.deepEqual(direct.candidates, ['https://example.com/index.json']);
});

test('来源列表：接受字符串与对象、去重、上限，缺地址要报第几条', () => {
  const list = normalizeSourceInputs([
    'https://example.com/a.json',
    { url: 'https://example.com/b.json', name: '  我的索引  ' },
    'https://example.com/a.json'
  ]);
  assert.deepEqual(list, [
    { url: 'https://example.com/a.json', name: '' },
    { url: 'https://example.com/b.json', name: '我的索引' }
  ]);
  assert.throws(() => normalizeSourceInputs([{ name: '没有地址' }]), /第 1 个来源缺少地址/);
  assert.throws(() => normalizeSourceInputs('not-array'), /必须是数组/);
  assert.throws(() => normalizeSourceInputs(
    Array.from({ length: MAX_CUSTOM_INDEX_SOURCES + 1 }, (_, i) => `https://example.com/${i}.json`)
  ), /最多只能添加/);
});

test('探测：普通地址拉到合法索引', async () => {
  const source = await probeIndexSource({ input: 'https://example.com/index.json', fetchText: ok() });
  assert.equal(source.url, 'https://example.com/index.json');
  assert.equal(source.count, 1);
  assert.equal(source.repo, '');
});

test('探测：GitHub 仓库先试 plugins/index.json，404 后回退根目录 index.json', async () => {
  const seen = [];
  const fetchText = async (url) => {
    seen.push(url);
    return url.endsWith('/plugins/index.json') ? notFound() : { statusCode: 200, body: INDEX_BODY };
  };
  const source = await probeIndexSource({ input: 'https://github.com/owner/repo', fetchText });
  assert.deepEqual(seen, [
    'https://raw.githubusercontent.com/owner/repo/HEAD/plugins/index.json',
    'https://raw.githubusercontent.com/owner/repo/HEAD/index.json'
  ]);
  assert.equal(source.url, 'https://raw.githubusercontent.com/owner/repo/HEAD/index.json');
  assert.equal(source.name, 'owner/repo');
  assert.equal(source.repo, 'owner/repo');
});

test('探测：不是本项目的索引格式时明确拒绝（DSH 等外部市场）', async () => {
  const dsh = async () => ({ statusCode: 200, body: JSON.stringify({ format: 1, items: [] }) });
  await assert.rejects(
    probeIndexSource({ input: 'https://dshmarket.com/index.json', fetchText: dsh }),
    /没有 plugins 数组/
  );
});

test('批量解析：任一来源失败就整体失败，且指出是哪一条', async () => {
  const fetchText = async (url) => (url.includes('bad') ? notFound() : { statusCode: 200, body: INDEX_BODY });
  await assert.rejects(
    resolveIndexSources({
      inputs: ['https://example.com/good.json', 'https://example.com/bad.json'],
      fetchText
    }),
    (error) => {
      assert.equal(error.code, 'E_SOURCE_INVALID');
      assert.equal(error.sources.length, 1);
      assert.match(error.sources[0].name, /bad\.json/);
      return true;
    }
  );

  const sources = await resolveIndexSources({
    inputs: ['https://github.com/owner/repo', 'https://example.com/good.json'],
    fetchText: (url) => ((url.includes('raw.githubusercontent.com') && url.endsWith('/plugins/index.json'))
      || url === 'https://example.com/good.json'
      ? { statusCode: 200, body: INDEX_BODY }
      : notFound())
  });
  assert.equal(sources.length, 2);
  assert.equal(sources[0].repo, 'owner/repo');
});
