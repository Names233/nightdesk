import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDelegation, DELEGATION_ERRORS } from '../src/delegation.js';
import { NightDeskStore } from '../src/store.js';
import { createTools } from '../src/tools.js';

const KNOWN_TOOLS = ['nightdesk_health', 'nightdesk_capture', 'nightdesk_items'];
const OWNER = 'owner-a';

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nightdesk-delegation-'));
  const store = new NightDeskStore({ dataDir, ownerId: OWNER });
  t.after(() => store.close());
  let tick = 0;
  const now = () => {
    tick += 1;
    return new Date(Date.UTC(2026, 10, 15, 0, 0, tick)).toISOString();
  };
  const delegation = createDelegation({ store, now, config: { knownTools: KNOWN_TOOLS } });
  return { store, delegation, dataDir };
}

function task(delegation, overrides = {}) {
  return delegation.createTask({
    ownerId: OWNER,
    objective: '写一份周报草稿',
    acceptance: ['包含本周完成、风险与下周计划'],
    allowedTools: ['nightdesk_items'],
    ...overrides,
  });
}

function rejectsCode(code) {
  return (cause) => cause?.code === code;
}

function startSubmitted(delegation, created = task(delegation), draftText = '本周完成：D08') {
  const attempt = delegation.startAttempt({ ownerId: OWNER, taskId: created.id });
  const submitted = delegation.submitDraft({
    ownerId: OWNER,
    taskId: created.id,
    attemptId: attempt.attemptId,
    goalVersion: created.goalVersion,
    expectedTaskVersion: created.version,
    draftText,
  });
  return { attempt, submitted };
}

test('createTask applies defaults and records the creation audit', (t) => {
  const { store, delegation } = fixture(t);
  const created = task(delegation, { goalVersion: 1 });
  assert.equal(created.status, 'drafting');
  assert.equal(created.version, 1);
  assert.equal(created.goalVersion, 1);
  assert.deepEqual(created.budget, { maxAttempts: 5, maxReviewRounds: 2, maxDraftChars: 20000 });
  assert.deepEqual(created.inputs, []);
  assert.equal(created.currentAttempt, null);
  const audit = store.db.prepare("SELECT action, detail_json FROM audit_events WHERE item_id = ? AND action = 'nightdesk.task_created'").get(created.id);
  assert.equal(JSON.parse(audit.detail_json).goalVersion, 1);
});

test('createTask rejects unknown tools with UNAUTHORIZED_TOOL', (t) => {
  const { delegation } = fixture(t);
  assert.throws(
    () => task(delegation, { allowedTools: ['nightdesk_not_registered'] }),
    rejectsCode(DELEGATION_ERRORS.UNAUTHORIZED_TOOL),
  );
});

test('createTask rejects task tools and delegate-like names as recursive delegation', (t) => {
  const { delegation } = fixture(t);
  for (const toolName of ['nightdesk_task_submit', 'delegate_writer', 'subagent-run', 'spawn_child']) {
    assert.throws(
      () => task(delegation, { allowedTools: [toolName] }),
      rejectsCode(DELEGATION_ERRORS.RECURSIVE_DELEGATION),
      toolName,
    );
  }
});

test('createTask rejects empty objective and empty acceptance', (t) => {
  const { delegation } = fixture(t);
  assert.throws(() => task(delegation, { objective: '   ' }), rejectsCode(DELEGATION_ERRORS.INVALID_ARGS));
  assert.throws(() => task(delegation, { acceptance: [] }), rejectsCode(DELEGATION_ERRORS.INVALID_ARGS));
});

test('startAttempt is idempotent while an attempt is drafting', (t) => {
  const { delegation } = fixture(t);
  const created = task(delegation);
  const first = delegation.startAttempt({ ownerId: OWNER, taskId: created.id });
  const second = delegation.startAttempt({ ownerId: OWNER, taskId: created.id, goalVersion: 1 });
  assert.equal(first.attemptId, second.attemptId);
  assert.equal(second.attemptNo, 1);
  assert.equal(second.status, 'drafting');
});

test('submitDraft stores a hashed artifact and advances the task version', (t) => {
  const { store, delegation } = fixture(t);
  const created = task(delegation);
  const attempt = delegation.startAttempt({ ownerId: OWNER, taskId: created.id });
  const draftText = '本周完成：D08 受管委派\n风险：无';
  const result = delegation.submitDraft({
    ownerId: OWNER,
    taskId: created.id,
    attemptId: attempt.attemptId,
    goalVersion: 1,
    expectedTaskVersion: 1,
    draftText,
    resources: { tokens: 42 },
  });
  assert.equal(result.task.status, 'submitted');
  assert.equal(result.task.version, 2);
  assert.equal(result.attempt.status, 'submitted');
  assert.ok(result.attempt.submittedAt);
  const artifact = store.db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(result.artifact.id);
  assert.equal(artifact.content, draftText);
  assert.equal(artifact.sha256, createHash('sha256').update(draftText).digest('hex'));
  const listed = delegation.list({ ownerId: OWNER });
  assert.equal(listed[0].currentAttempt.attemptId, attempt.attemptId);
  assert.equal('draftText' in listed[0], false);
  assert.equal(JSON.stringify(listed).includes(draftText), false);
});

test('submitDraft rejects an expired expectedTaskVersion with VERSION_CONFLICT', (t) => {
  const { delegation } = fixture(t);
  const created = task(delegation);
  const attempt = delegation.startAttempt({ ownerId: OWNER, taskId: created.id });
  assert.throws(() => delegation.submitDraft({
    ownerId: OWNER,
    taskId: created.id,
    attemptId: attempt.attemptId,
    goalVersion: 1,
    expectedTaskVersion: 99,
    draftText: '过期版本',
  }), rejectsCode(DELEGATION_ERRORS.VERSION_CONFLICT));
});

test('an old attempt cannot submit after revision starts a new attempt (T22)', (t) => {
  const { delegation } = fixture(t);
  const created = task(delegation);
  const first = startSubmitted(delegation, created);
  delegation.review({
    ownerId: OWNER,
    taskId: created.id,
    attemptId: first.attempt.attemptId,
    verdict: 'needs_revision',
    structure: { ok: true },
    evidence: { ok: true },
    content: { ok: false },
    findings: [{ severity: 'medium', problem: '缺少风险', requiredFix: '补风险段落' }],
  });
  const second = delegation.startAttempt({ ownerId: OWNER, taskId: created.id });
  const current = delegation.list({ ownerId: OWNER })[0];
  assert.throws(() => delegation.submitDraft({
    ownerId: OWNER,
    taskId: created.id,
    attemptId: first.attempt.attemptId,
    goalVersion: 1,
    expectedTaskVersion: current.version,
    draftText: '旧 attempt 的提交',
  }), rejectsCode(DELEGATION_ERRORS.STALE_ATTEMPT));
  assert.equal(second.status, 'drafting');
});

test('requestChange invalidates old attempts and exposes the new goal version (T21)', (t) => {
  const { delegation } = fixture(t);
  const created = task(delegation);
  const attempt = delegation.startAttempt({ ownerId: OWNER, taskId: created.id });
  const changed = delegation.requestChange({ ownerId: OWNER, taskId: created.id, goalVersion: 2 });
  assert.equal(changed.goalVersion, 2);
  assert.equal(changed.status, 'drafting');
  assert.equal(changed.currentAttempt, null);
  assert.throws(() => delegation.submitDraft({
    ownerId: OWNER,
    taskId: created.id,
    attemptId: attempt.attemptId,
    goalVersion: 2,
    expectedTaskVersion: changed.version,
    draftText: '旧目标下的草稿',
  }), rejectsCode(DELEGATION_ERRORS.STALE_ATTEMPT));
});

test('submitDraft rejects a mismatched goalVersion with STALE_GOAL', (t) => {
  const { delegation } = fixture(t);
  const created = task(delegation);
  const attempt = delegation.startAttempt({ ownerId: OWNER, taskId: created.id });
  assert.throws(() => delegation.submitDraft({
    ownerId: OWNER,
    taskId: created.id,
    attemptId: attempt.attemptId,
    goalVersion: 2,
    expectedTaskVersion: 1,
    draftText: '目标版本不符',
  }), rejectsCode(DELEGATION_ERRORS.STALE_GOAL));
});

test('stop is idempotent and blocks later attempts with TASK_STOPPED', (t) => {
  const { store, delegation } = fixture(t);
  const created = task(delegation);
  const stopped = delegation.stop({ ownerId: OWNER, taskId: created.id, reason: '用户取消' });
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.version, 2);
  const again = delegation.stop({ ownerId: OWNER, taskId: created.id });
  assert.equal(again.status, 'stopped');
  assert.equal(again.version, 2);
  assert.throws(
    () => delegation.startAttempt({ ownerId: OWNER, taskId: created.id }),
    rejectsCode(DELEGATION_ERRORS.TASK_STOPPED),
  );
  const audit = store.db.prepare("SELECT detail_json FROM audit_events WHERE item_id = ? AND action = 'nightdesk.task_stopped'").get(created.id);
  assert.equal(JSON.parse(audit.detail_json).reason, '用户取消');
});

test('stopping before submit rejects the draft without adding an artifact (T27)', (t) => {
  const { store, delegation } = fixture(t);
  const created = task(delegation);
  const attempt = delegation.startAttempt({ ownerId: OWNER, taskId: created.id });
  delegation.stop({ ownerId: OWNER, taskId: created.id, reason: '停止与派发竞争' });
  assert.throws(() => delegation.submitDraft({
    ownerId: OWNER,
    taskId: created.id,
    attemptId: attempt.attemptId,
    goalVersion: 1,
    expectedTaskVersion: 1,
    draftText: '不应落库',
  }), rejectsCode(DELEGATION_ERRORS.TASK_STOPPED));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM task_artifacts WHERE task_id = ?').get(created.id).count, 0);
  const stoppedAttempt = store.db.prepare('SELECT status, is_current FROM task_attempts WHERE id = ?').get(attempt.attemptId);
  assert.equal(stoppedAttempt.status, 'stopped');
  assert.equal(stoppedAttempt.is_current, 0);
});

test('review pass requires all three layers to be true', (t) => {
  const { delegation } = fixture(t);
  const created = task(delegation);
  const submitted = startSubmitted(delegation, created);
  assert.throws(() => delegation.review({
    ownerId: OWNER,
    taskId: created.id,
    attemptId: submitted.attempt.attemptId,
    verdict: 'pass',
    structure: { ok: true },
    evidence: { ok: false },
    content: { ok: true },
    findings: [],
  }), rejectsCode(DELEGATION_ERRORS.INVALID_ARGS));
  assert.equal(delegation.list({ ownerId: OWNER })[0].status, 'submitted');
});

test('accepted tasks cannot be reviewed again', (t) => {
  const { delegation } = fixture(t);
  const created = task(delegation);
  const submitted = startSubmitted(delegation, created);
  const reviewed = delegation.review({
    ownerId: OWNER,
    taskId: created.id,
    attemptId: submitted.attempt.attemptId,
    verdict: 'pass',
    structure: { ok: true },
    evidence: { ok: true },
    content: { ok: true },
    findings: [],
  });
  assert.equal(reviewed.task.status, 'accepted');
  assert.equal(reviewed.attempt.status, 'accepted');
  assert.throws(() => delegation.review({
    ownerId: OWNER,
    taskId: created.id,
    attemptId: submitted.attempt.attemptId,
    verdict: 'pass',
    structure: { ok: true },
    evidence: { ok: true },
    content: { ok: true },
    findings: [],
  }), rejectsCode(DELEGATION_ERRORS.DUPLICATE_REVIEW));
});

test('needs_revision requires at least one finding', (t) => {
  const { delegation } = fixture(t);
  const created = task(delegation);
  const submitted = startSubmitted(delegation, created);
  assert.throws(() => delegation.review({
    ownerId: OWNER,
    taskId: created.id,
    attemptId: submitted.attempt.attemptId,
    verdict: 'needs_revision',
    structure: { ok: true },
    evidence: { ok: true },
    content: { ok: false },
    findings: [],
  }), rejectsCode(DELEGATION_ERRORS.INVALID_ARGS));
});

test('a third needs_revision exhausts the task while preserving review history', (t) => {
  const { store, delegation } = fixture(t);
  const created = task(delegation);
  let submitted = startSubmitted(delegation, created);
  for (let round = 1; round <= 2; round += 1) {
    const reviewed = delegation.review({
      ownerId: OWNER,
      taskId: created.id,
      attemptId: submitted.attempt.attemptId,
      verdict: 'needs_revision',
      structure: { ok: true },
      evidence: { ok: true },
      content: { ok: false },
      findings: [{ severity: 'high', problem: `第 ${round} 轮缺内容`, requiredFix: '补齐缺项' }],
    });
    assert.equal(reviewed.task.status, 'needs_revision');
    const next = delegation.startAttempt({ ownerId: OWNER, taskId: created.id });
    const current = delegation.list({ ownerId: OWNER })[0];
    submitted = delegation.submitDraft({
      ownerId: OWNER,
      taskId: created.id,
      attemptId: next.attemptId,
      goalVersion: 1,
      expectedTaskVersion: current.version,
      draftText: `第 ${round + 1} 版草稿`,
    });
  }
  assert.throws(() => delegation.review({
    ownerId: OWNER,
    taskId: created.id,
    attemptId: submitted.attempt.attemptId,
    verdict: 'needs_revision',
    structure: { ok: true },
    evidence: { ok: true },
    content: { ok: false },
    findings: [{ severity: 'blocker', problem: '仍不满足', requiredFix: '重写' }],
  }), rejectsCode(DELEGATION_ERRORS.REVIEW_ROUNDS_EXHAUSTED));
  assert.equal(delegation.list({ ownerId: OWNER })[0].status, 'exhausted');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM task_reviews WHERE task_id = ?').get(created.id).count, 3);
  assert.throws(
    () => delegation.startAttempt({ ownerId: OWNER, taskId: created.id }),
    rejectsCode(DELEGATION_ERRORS.REVIEW_ROUNDS_EXHAUSTED),
  );
});

test('budget.maxAttempts caps the number of attempts', (t) => {
  const { delegation } = fixture(t);
  const created = task(delegation, { budget: { maxAttempts: 1 } });
  const submitted = startSubmitted(delegation, created);
  delegation.review({
    ownerId: OWNER,
    taskId: created.id,
    attemptId: submitted.attempt.attemptId,
    verdict: 'needs_revision',
    structure: { ok: true },
    evidence: { ok: true },
    content: { ok: false },
    findings: [{ severity: 'low', problem: '格式', requiredFix: '调整格式' }],
  });
  assert.throws(
    () => delegation.startAttempt({ ownerId: OWNER, taskId: created.id }),
    rejectsCode(DELEGATION_ERRORS.BUDGET_EXCEEDED),
  );
});

test('owners are isolated from each other tasks', (t) => {
  const { delegation } = fixture(t);
  const created = task(delegation);
  assert.deepEqual(delegation.list({ ownerId: 'owner-b' }), []);
  assert.throws(
    () => delegation.startAttempt({ ownerId: 'owner-b', taskId: created.id }),
    rejectsCode(DELEGATION_ERRORS.NOT_FOUND),
  );
  assert.throws(
    () => delegation.stop({ ownerId: 'owner-b', taskId: created.id, reason: '越权' }),
    rejectsCode(DELEGATION_ERRORS.NOT_FOUND),
  );
  assert.equal(delegation.list({ ownerId: OWNER })[0].status, 'drafting');
});

test('task tools return structured errors instead of throwing', async (t) => {
  const { store, delegation } = fixture(t);
  const tools = new Map(createTools(store, { delegation }).map((tool) => [tool.name, tool]));
  const rejected = await tools.get('nightdesk_task_create').execute({
    objective: '越权工具',
    acceptance: ['任一'],
    allowedTools: ['nightdesk_task_submit'],
  }, {});
  assert.deepEqual(rejected, {
    ok: false,
    code: DELEGATION_ERRORS.RECURSIVE_DELEGATION,
    message: 'tool nightdesk_task_submit cannot be delegated',
  });
  const created = await tools.get('nightdesk_task_create').execute({
    objective: '工具层创建',
    acceptance: ['一条'],
  }, {});
  assert.equal(created.status, 'drafting');
  const listed = await tools.get('nightdesk_tasks').execute({}, {});
  assert.equal(listed.count, 1);
});
