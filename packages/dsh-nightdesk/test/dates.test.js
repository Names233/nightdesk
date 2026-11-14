import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDeadline } from '../src/dates.js';

const now = new Date('2026-11-16T02:00:00.000Z'); // Monday 2026-11-16 in Shanghai.

test('T01/T07: absolute date forms retain day precision', () => {
  for (const [text, dueDate, basis] of [
    ['2026-11-20', '2026-11-20', 'literal'],
    ['2026/11/20', '2026-11-20', 'literal'],
    ['2026年11月20日', '2026-11-20', 'literal'],
    ['11月20日', '2026-11-20', 'assumed-year'],
    ['11/20', '2026-11-20', 'assumed-year'],
  ]) {
    assert.deepEqual(extractDeadline(text, now), {
      timeStatus: 'resolved', dueAt: null, dueDate, precision: 'day', matchedText: text, basis,
    });
  }
});

test('T02: tonight is ambiguous and never invents an instant', () => {
  const result = extractDeadline('今晚之前交作业', now);
  assert.equal(result.timeStatus, 'ambiguous');
  assert.equal(result.dueDate, '2026-11-16');
  assert.equal(result.dueAt, null);
  assert.equal(result.matchedText, '今晚之前');
  assert.equal(extractDeadline('明晚再核对', now).dueDate, '2026-11-17');
  assert.equal(extractDeadline('明早再核对', now).dueDate, '2026-11-17');
});

test('relative days cross a month boundary using Shanghai calendar dates', () => {
  assert.equal(extractDeadline('大后天', '2026-11-29T02:00:00Z').dueDate, '2026-12-02');
  assert.equal(extractDeadline('明天', now).dueDate, '2026-11-17');
  assert.equal(extractDeadline('后天', now).dueDate, '2026-11-18');
});

test('T07: this week and future weekdays are calculated from Monday correctly', () => {
  assert.equal(extractDeadline('本周五', now).dueDate, '2026-11-20');
  assert.equal(extractDeadline('这周五', now).dueDate, '2026-11-20');
  assert.equal(extractDeadline('周五', now).dueDate, '2026-11-20');
  assert.equal(extractDeadline('下周一', now).dueDate, '2026-11-23');
  assert.equal(extractDeadline('本周五', '2026-11-21T02:00:00Z').dueDate, '2026-11-20');
  assert.equal(extractDeadline('下周一', '2026-11-21T02:00:00Z').dueDate, '2026-11-23');
  assert.equal(extractDeadline('本周日', '2026-11-21T02:00:00Z').dueDate, '2026-11-22');
  assert.equal(extractDeadline('下周一', '2026-11-15T02:00:00Z').dueDate, '2026-11-16');
  assert.equal(extractDeadline('周五', '2026-11-20T02:00:00Z').dueDate, '2026-11-27');
});

test('vague relative dates remain ambiguous and unknown text remains unknown', () => {
  for (const text of ['月底', '下周', '尽快', '过几天', '近期']) {
    const result = extractDeadline(text, now);
    assert.equal(result.timeStatus, 'ambiguous');
    assert.equal(result.dueDate, null);
    assert.equal(result.dueAt, null);
    assert.equal(result.matchedText, text);
  }
  assert.deepEqual(extractDeadline('记得买牛奶', now), {
    timeStatus: 'unknown', dueAt: null, dueDate: null, precision: 'unknown', matchedText: null, basis: null,
  });
});

test('first resolvable time phrase wins without losing its source text', () => {
  assert.equal(extractDeadline('明天处理，周五复核', now).matchedText, '明天');
  assert.equal(extractDeadline('月底前，今晚交', now).matchedText, '月底');
});
