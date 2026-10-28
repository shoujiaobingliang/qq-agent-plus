// 记忆文本工具：中文 bigram、FTS 查询串、精确去重口径。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildMatchQuery,
  buildSearchText,
  compactForCompare,
  keywordMatchesQuery,
  normalizeForHash,
  tokenizeForSearch
} from '../src/memory/memory-text.js';

test('中文按重叠 bigram 切分，两字词也能命中', () => {
  assert.deepEqual(tokenizeForSearch('群暗号'), ['群暗', '暗号']);
  assert.deepEqual(tokenizeForSearch('菠萝'), ['菠萝']);
  assert.deepEqual(tokenizeForSearch('开黑吗'), ['开黑', '黑吗']);
});

test('拉丁/数字按整词保留，中英混排都能切', () => {
  assert.deepEqual(tokenizeForSearch('农=王者荣耀 v1.0'), ['农', '王者', '者荣', '荣耀', 'v1', '0']);
});

test('buildSearchText 合并 abstract/content/keywords', () => {
  const text = buildSearchText({ abstract: '群暗号是菠萝', content: '说菠萝就是开黑', keywords: ['开黑'] });
  for (const token of ['群暗', '暗号', '菠萝', '开黑']) assert.match(text, new RegExp(token));
});

test('buildMatchQuery 用引号 + OR，空输入返回空串', () => {
  assert.equal(buildMatchQuery('群暗号'), '"群暗" OR "暗号"');
  assert.equal(buildMatchQuery(''), '');
});

test('normalizeForHash 只做 NFKC/空白折叠，不改大小写与标点', () => {
  assert.equal(normalizeForHash('  Abc  群暗号 '), 'Abc 群暗号');
});

test('compactForCompare 去掉空白/标点/符号并小写', () => {
  assert.equal(compactForCompare('群暗号：「菠萝」！'), '群暗号菠萝');
});

test('keywordMatchesQuery：中文用子串，英文用整词', () => {
  assert.equal(keywordMatchesQuery('开黑', '周六一起开黑吗'), true);
  assert.equal(keywordMatchesQuery('开黑', '周六一起'), false);
  assert.equal(keywordMatchesQuery('game', 'play game now'), true);
  assert.equal(keywordMatchesQuery('game', 'gamepad'), false);
});
