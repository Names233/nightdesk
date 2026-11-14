import { createHash, randomUUID } from 'node:crypto';

export const DELEGATION_ERRORS = {
  INVALID_ARGS: 'INVALID_ARGS',
  UNAUTHORIZED_TOOL: 'UNAUTHORIZED_TOOL',
  RECURSIVE_DELEGATION: 'RECURSIVE_DELEGATION',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  STALE_ATTEMPT: 'STALE_ATTEMPT',
  STALE_GOAL: 'STALE_GOAL',
  TASK_STOPPED: 'TASK_STOPPED',
  REVIEW_ROUNDS_EXHAUSTED: 'REVIEW_ROUNDS_EXHAUSTED',
  DUPLICATE_REVIEW: 'DUPLICATE_REVIEW',
  NOT_FOUND: 'NOT_FOUND',
};

const DEFAULT_CONFIG = {
  maxAttempts: 5,
  maxReviewRounds: 2,
  maxDraftChars: 20000,
  maxInputs: 20,
  maxTools: 8,
};

const TASK_TOOL_NAMES = new Set([
  'nightdesk_task_create',
  'nightdesk_task_start',
  'nightdesk_task_submit',
  'nightdesk_task_review',
  'nightdesk_task_stop',
]);
const TASK_STATUSES = new Set(['drafting', 'submitted', 'needs_revision', 'accepted', 'exhausted', 'stopped', 'canceled']);
const ATTEMPT_STATUSES = new Set(['drafting', 'submitted', 'accepted', 'superseded', 'stale', 'stopped']);
const FINDING_SEVERITIES = new Set(['low', 'medium', 'high', 'blocker']);

function fail(code, message) {
  const error = new Error(`${code} ${message}`);
  error.code = code;
  return error;
}

function requireObject(value, name = 'arguments') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(DELEGATION_ERRORS.INVALID_ARGS, `${name} must be an object`);
}

function requireOwnerId(ownerId) {
  if (typeof ownerId !== 'string' || ownerId.trim().length === 0) {
    throw fail(DELEGATION_ERRORS.INVALID_ARGS, 'ownerId must be a non-empty string');
  }
  return ownerId;
}

function requireId(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw fail(DELEGATION_ERRORS.INVALID_ARGS, `${field} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw fail(DELEGATION_ERRORS.INVALID_ARGS, `${field} must be a positive integer`);
  }
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonValue(value, field) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('undefined');
    return serialized;
  } catch {
    throw fail(DELEGATION_ERRORS.INVALID_ARGS, `${field} must be JSON serializable`);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function bool(value) {
  return value === 1 || value === true;
}

function toAttempt(row) {
  if (!row) return null;
  return {
    id: row.id,
    attemptId: row.id,
    ownerId: row.owner_id,
    taskId: row.task_id,
    attemptNo: row.attempt_no,
    goalVersion: row.goal_version,
    inputVersion: row.input_version,
    status: row.status,
    isCurrent: bool(row.is_current),
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTask(row, currentAttempt = null) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.id,
    ownerId: row.owner_id,
    objective: row.objective,
    inputs: parseJson(row.inputs_json, []),
    allowedTools: parseJson(row.allowed_tools_json, []),
    scope: row.scope,
    completionRule: row.completion_rule,
    acceptance: parseJson(row.acceptance_json, []),
    budget: parseJson(row.budget_json, {}),
    goalVersion: row.goal_version,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    currentAttempt: toAttempt(currentAttempt),
  };
}

function validateLayer(value, field) {
  requireObject(value, field);
  if (typeof value.ok !== 'boolean') throw fail(DELEGATION_ERRORS.INVALID_ARGS, `${field}.ok must be a boolean`);
}

function validateFindings(findings) {
  if (!Array.isArray(findings)) throw fail(DELEGATION_ERRORS.INVALID_ARGS, 'findings must be an array');
  for (const finding of findings) {
    requireObject(finding, 'finding');
    if (!FINDING_SEVERITIES.has(finding.severity)) {
      throw fail(DELEGATION_ERRORS.INVALID_ARGS, 'finding.severity is unsupported');
    }
    if (typeof finding.problem !== 'string' || finding.problem.trim().length === 0) {
      throw fail(DELEGATION_ERRORS.INVALID_ARGS, 'finding.problem must be a non-empty string');
    }
    if (typeof finding.requiredFix !== 'string' || finding.requiredFix.trim().length === 0) {
      throw fail(DELEGATION_ERRORS.INVALID_ARGS, 'finding.requiredFix must be a non-empty string');
    }
  }
}

export function createDelegation({ store, now, config = {} }) {
  if (!store || !store.db || typeof store.transaction !== 'function') {
    throw new Error('delegation requires a NightDeskStore');
  }
  const limits = { ...DEFAULT_CONFIG, ...config };
  const knownTools = new Set(config.knownTools ?? []);
  const clock = typeof now === 'function' ? now : () => new Date().toISOString();

  function at() {
    const value = clock();
    return value instanceof Date ? value.toISOString() : String(value);
  }

  function taskRow(ownerId, taskId) {
    return store.db.prepare('SELECT * FROM tasks WHERE id = ? AND owner_id = ?').get(taskId, ownerId) ?? null;
  }

  function currentAttempt(taskId, ownerId) {
    return store.db.prepare(`SELECT * FROM task_attempts
      WHERE task_id = ? AND owner_id = ? AND is_current = 1
      ORDER BY attempt_no DESC LIMIT 1`).get(taskId, ownerId) ?? null;
  }

  function taskView(row) {
    return toTask(row, currentAttempt(row.id, row.owner_id));
  }

  function audit(ownerId, action, taskId, detail, timestamp) {
    store.db.prepare(`INSERT INTO audit_events
      (id, at, actor, action, item_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)`).run(
      randomUUID(), timestamp, ownerId, action, taskId, JSON.stringify(detail ?? {}),
    );
  }

  function budgetValue(budget, field, minimum = 1) {
    const value = budget[field];
    if (!Number.isInteger(value) || value < minimum || value > limits[field]) {
      throw fail(DELEGATION_ERRORS.BUDGET_EXCEEDED, `${field} exceeds the configured budget`);
    }
    return value;
  }

  function validateCreateArgs(args) {
    requireObject(args);
    const ownerId = requireOwnerId(args.ownerId);
    if (typeof args.objective !== 'string' || args.objective.trim().length === 0 || args.objective.trim().length > 2000) {
      throw fail(DELEGATION_ERRORS.INVALID_ARGS, 'objective must be non-empty and at most 2000 characters');
    }
    const inputs = args.inputs ?? [];
    if (!Array.isArray(inputs) || inputs.length > limits.maxInputs) {
      throw fail(DELEGATION_ERRORS.INVALID_ARGS, `inputs must be an array of at most ${limits.maxInputs} items`);
    }
    for (const input of inputs) {
      requireObject(input, 'input');
      requireId(input.kind, 'input.kind');
      requireId(input.id, 'input.id');
      if (input.label !== undefined && typeof input.label !== 'string') {
        throw fail(DELEGATION_ERRORS.INVALID_ARGS, 'input.label must be a string');
      }
    }
    const allowedTools = args.allowedTools ?? [];
    if (!Array.isArray(allowedTools) || allowedTools.length > limits.maxTools) {
      throw fail(DELEGATION_ERRORS.INVALID_ARGS, `allowedTools must be an array of at most ${limits.maxTools} items`);
    }
    for (const tool of allowedTools) {
      if (typeof tool !== 'string' || tool.length === 0) throw fail(DELEGATION_ERRORS.INVALID_ARGS, 'allowedTools must contain tool names');
      if (TASK_TOOL_NAMES.has(tool) || /delegate|subagent|spawn/i.test(tool)) {
        throw fail(DELEGATION_ERRORS.RECURSIVE_DELEGATION, `tool ${tool} cannot be delegated`);
      }
      if (!knownTools.has(tool)) throw fail(DELEGATION_ERRORS.UNAUTHORIZED_TOOL, `tool ${tool} is not registered`);
    }
    if (!Array.isArray(args.acceptance) || args.acceptance.length < 1) {
      throw fail(DELEGATION_ERRORS.INVALID_ARGS, 'acceptance must contain at least one item');
    }
    const completionRule = args.completionRule ?? '满足全部验收条目';
    if (typeof completionRule !== 'string' || completionRule.trim().length === 0) {
      throw fail(DELEGATION_ERRORS.INVALID_ARGS, 'completionRule must be a non-empty string');
    }
    if (args.scope !== undefined && args.scope !== null && typeof args.scope !== 'string') {
      throw fail(DELEGATION_ERRORS.INVALID_ARGS, 'scope must be a string or null');
    }
    const goalVersion = args.goalVersion ?? 1;
    requirePositiveInteger(goalVersion, 'goalVersion');
    const budget = args.budget ?? {};
    requireObject(budget, 'budget');
    const mergedBudget = {
      maxAttempts: budget.maxAttempts ?? limits.maxAttempts,
      maxReviewRounds: budget.maxReviewRounds ?? limits.maxReviewRounds,
      maxDraftChars: budget.maxDraftChars ?? limits.maxDraftChars,
    };
    budgetValue(mergedBudget, 'maxAttempts');
    budgetValue(mergedBudget, 'maxReviewRounds', 0);
    budgetValue(mergedBudget, 'maxDraftChars');
    jsonValue(inputs, 'inputs');
    jsonValue(allowedTools, 'allowedTools');
    jsonValue(args.acceptance, 'acceptance');
    return {
      ownerId,
      objective: args.objective.trim(),
      inputs,
      allowedTools,
      scope: args.scope ?? null,
      completionRule: completionRule.trim(),
      acceptance: args.acceptance,
      budget: mergedBudget,
      goalVersion,
    };
  }

  function createTask(args) {
    const values = validateCreateArgs(args);
    const timestamp = at();
    return store.transaction(() => {
      const id = randomUUID();
      store.db.prepare(`INSERT INTO tasks
        (id, owner_id, objective, inputs_json, allowed_tools_json, scope,
         completion_rule, acceptance_json, budget_json, goal_version, status,
         version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'drafting', 1, ?, ?)`).run(
        id,
        values.ownerId,
        values.objective,
        JSON.stringify(values.inputs),
        JSON.stringify(values.allowedTools),
        values.scope,
        values.completionRule,
        JSON.stringify(values.acceptance),
        JSON.stringify(values.budget),
        values.goalVersion,
        timestamp,
        timestamp,
      );
      audit(values.ownerId, 'nightdesk.task_created', id, {
        goalVersion: values.goalVersion,
        allowedTools: values.allowedTools,
      }, timestamp);
      return taskView(taskRow(values.ownerId, id));
    });
  }

  function startAttempt(args) {
    requireObject(args);
    const ownerId = requireOwnerId(args.ownerId);
    const taskId = requireId(args.taskId, 'taskId');
    if (args.goalVersion !== undefined) requirePositiveInteger(args.goalVersion, 'goalVersion');
    const timestamp = at();
    return store.transaction(() => {
      const task = taskRow(ownerId, taskId);
      if (!task) throw fail(DELEGATION_ERRORS.NOT_FOUND, 'task not found');
      if (task.status === 'stopped' || task.status === 'canceled') throw fail(DELEGATION_ERRORS.TASK_STOPPED, 'task is stopped');
      if (task.status === 'exhausted') throw fail(DELEGATION_ERRORS.REVIEW_ROUNDS_EXHAUSTED, 'review rounds are exhausted');
      if (!['drafting', 'needs_revision'].includes(task.status)) throw fail(DELEGATION_ERRORS.INVALID_ARGS, 'task is not ready for an attempt');
      const goalVersion = args.goalVersion ?? task.goal_version;
      if (goalVersion !== task.goal_version) throw fail(DELEGATION_ERRORS.STALE_GOAL, 'goal version is stale');
      const existing = currentAttempt(taskId, ownerId);
      if (existing?.status === 'drafting') return toAttempt(existing);
      const count = store.db.prepare('SELECT COUNT(*) AS count FROM task_attempts WHERE task_id = ? AND owner_id = ?').get(taskId, ownerId).count;
      const budget = parseJson(task.budget_json, DEFAULT_CONFIG);
      if (count >= budget.maxAttempts) throw fail(DELEGATION_ERRORS.BUDGET_EXCEEDED, 'maximum attempts reached');
      const last = store.db.prepare('SELECT MAX(attempt_no) AS attempt_no FROM task_attempts WHERE task_id = ? AND owner_id = ?').get(taskId, ownerId);
      const attemptNo = (last.attempt_no ?? 0) + 1;
      store.db.prepare('UPDATE task_attempts SET is_current = 0 WHERE task_id = ? AND owner_id = ? AND is_current = 1')
        .run(taskId, ownerId);
      const id = randomUUID();
      store.db.prepare(`INSERT INTO task_attempts
        (id, owner_id, task_id, attempt_no, goal_version, input_version, status,
         is_current, draft_text, resources_json, submitted_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'drafting', 1, NULL, NULL, NULL, ?, ?)`).run(
        id, ownerId, taskId, attemptNo, task.goal_version, task.version, timestamp, timestamp,
      );
      audit(ownerId, 'nightdesk.attempt_started', taskId, {
        attemptId: id,
        attemptNo,
        goalVersion: task.goal_version,
      }, timestamp);
      return toAttempt(store.db.prepare('SELECT * FROM task_attempts WHERE id = ?').get(id));
    });
  }

  function submitDraft(args) {
    requireObject(args);
    const ownerId = requireOwnerId(args.ownerId);
    const taskId = requireId(args.taskId, 'taskId');
    const attemptId = requireId(args.attemptId, 'attemptId');
    const timestamp = at();
    return store.transaction(() => {
      const task = taskRow(ownerId, taskId);
      if (!task) throw fail(DELEGATION_ERRORS.NOT_FOUND, 'task not found');
      if (task.status === 'stopped' || task.status === 'canceled') throw fail(DELEGATION_ERRORS.TASK_STOPPED, 'task is stopped');
      const goalVersion = args.goalVersion ?? task.goal_version;
      if (!Number.isInteger(goalVersion) || goalVersion !== task.goal_version) throw fail(DELEGATION_ERRORS.STALE_GOAL, 'goal version is stale');
      if (!Number.isInteger(args.expectedTaskVersion) || args.expectedTaskVersion !== task.version) {
        throw fail(DELEGATION_ERRORS.VERSION_CONFLICT, `task version is ${task.version}`);
      }
      const attempt = store.db.prepare(`SELECT * FROM task_attempts
        WHERE id = ? AND task_id = ? AND owner_id = ?`).get(attemptId, taskId, ownerId);
      if (!attempt || attempt.is_current !== 1 || attempt.status !== 'drafting') {
        throw fail(DELEGATION_ERRORS.STALE_ATTEMPT, 'attempt is stale');
      }
      if (attempt.goal_version !== goalVersion) throw fail(DELEGATION_ERRORS.STALE_ATTEMPT, 'attempt goal version is stale');
      if (typeof args.draftText !== 'string' || args.draftText.trim().length === 0) {
        throw fail(DELEGATION_ERRORS.INVALID_ARGS, 'draftText must be non-empty');
      }
      const budget = parseJson(task.budget_json, DEFAULT_CONFIG);
      if (args.draftText.length > budget.maxDraftChars) {
        throw fail(DELEGATION_ERRORS.INVALID_ARGS, 'draftText exceeds maxDraftChars');
      }
      const resourcesJson = args.resources === undefined ? null : jsonValue(args.resources, 'resources');
      const artifactId = randomUUID();
      const digest = sha256(args.draftText);
      store.db.prepare(`INSERT INTO task_artifacts
        (id, owner_id, task_id, attempt_id, kind, content, sha256, created_at)
        VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`).run(
        artifactId, ownerId, taskId, attemptId, args.draftText, digest, timestamp,
      );
      store.db.prepare(`UPDATE task_attempts SET status = 'submitted', draft_text = ?,
        resources_json = ?, submitted_at = ?, updated_at = ?
        WHERE id = ? AND owner_id = ? AND is_current = 1 AND status = 'drafting'`).run(
        args.draftText, resourcesJson, timestamp, timestamp, attemptId, ownerId,
      );
      const changed = store.db.prepare(`UPDATE tasks SET status = 'submitted', version = version + 1,
        updated_at = ? WHERE id = ? AND owner_id = ? AND version = ?`).run(
        timestamp, taskId, ownerId, task.version,
      );
      if (changed.changes !== 1) throw fail(DELEGATION_ERRORS.VERSION_CONFLICT, 'task version changed during submit');
      audit(ownerId, 'nightdesk.draft_submitted', taskId, {
        attemptId,
        sha256: digest,
      }, timestamp);
      return {
        task: taskView(taskRow(ownerId, taskId)),
        attempt: toAttempt(store.db.prepare('SELECT * FROM task_attempts WHERE id = ?').get(attemptId)),
        artifact: { id: artifactId, artifactId, kind: 'draft', sha256: digest, createdAt: timestamp },
      };
    });
  }

  function review(args) {
    requireObject(args);
    const ownerId = requireOwnerId(args.ownerId);
    const taskId = requireId(args.taskId, 'taskId');
    const attemptId = requireId(args.attemptId, 'attemptId');
    if (!['pass', 'needs_revision'].includes(args.verdict)) throw fail(DELEGATION_ERRORS.INVALID_ARGS, 'verdict must be pass or needs_revision');
    validateLayer(args.structure, 'structure');
    validateLayer(args.evidence, 'evidence');
    validateLayer(args.content, 'content');
    const findings = args.findings ?? [];
    validateFindings(findings);
    if (args.verdict === 'pass' && (!args.structure.ok || !args.evidence.ok || !args.content.ok || findings.length > 0)) {
      throw fail(DELEGATION_ERRORS.INVALID_ARGS, 'pass requires three true layers and no findings');
    }
    if (args.verdict === 'needs_revision' && findings.length === 0) {
      throw fail(DELEGATION_ERRORS.INVALID_ARGS, 'needs_revision requires findings');
    }
    const timestamp = at();
    let exhausted = false;
    const result = store.transaction(() => {
      const task = taskRow(ownerId, taskId);
      if (!task) throw fail(DELEGATION_ERRORS.NOT_FOUND, 'task not found');
      if (task.status === 'stopped' || task.status === 'canceled') throw fail(DELEGATION_ERRORS.TASK_STOPPED, 'task is stopped');
      const alreadyPassed = store.db.prepare(`SELECT 1 FROM task_reviews
        WHERE owner_id = ? AND task_id = ? AND attempt_id = ? AND verdict = 'pass' LIMIT 1`).get(ownerId, taskId, attemptId);
      if (alreadyPassed) throw fail(DELEGATION_ERRORS.DUPLICATE_REVIEW, 'attempt was already accepted');
      const attempt = store.db.prepare(`SELECT * FROM task_attempts
        WHERE id = ? AND task_id = ? AND owner_id = ?`).get(attemptId, taskId, ownerId);
      if (!attempt || attempt.is_current !== 1 || attempt.status !== 'submitted') {
        throw fail(DELEGATION_ERRORS.STALE_ATTEMPT, 'attempt is not the current submitted attempt');
      }
      const reviewCount = store.db.prepare(`SELECT COUNT(*) AS count FROM task_reviews
        WHERE owner_id = ? AND task_id = ? AND verdict = 'needs_revision'`).get(ownerId, taskId).count;
      const round = reviewCount + 1;
      store.db.prepare(`INSERT INTO task_reviews
        (id, owner_id, task_id, attempt_id, round, verdict, structure_ok,
         evidence_ok, content_ok, findings_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        randomUUID(), ownerId, taskId, attemptId, round, args.verdict,
        args.structure.ok ? 1 : 0, args.evidence.ok ? 1 : 0, args.content.ok ? 1 : 0,
        JSON.stringify(findings), timestamp,
      );
      if (args.verdict === 'pass') {
        store.db.prepare(`UPDATE task_attempts SET status = 'accepted', updated_at = ?
          WHERE id = ? AND owner_id = ? AND is_current = 1 AND status = 'submitted'`).run(timestamp, attemptId, ownerId);
        store.db.prepare(`UPDATE tasks SET status = 'accepted', version = version + 1, updated_at = ?
          WHERE id = ? AND owner_id = ?`).run(timestamp, taskId, ownerId);
        audit(ownerId, 'nightdesk.task_accepted', taskId, { attemptId, round }, timestamp);
        return { task: taskView(taskRow(ownerId, taskId)), attempt: toAttempt(store.db.prepare('SELECT * FROM task_attempts WHERE id = ?').get(attemptId)), round };
      }
      const budget = parseJson(task.budget_json, DEFAULT_CONFIG);
      if (round > budget.maxReviewRounds) {
        store.db.prepare(`UPDATE task_attempts SET is_current = 0, updated_at = ?
          WHERE id = ? AND owner_id = ?`).run(timestamp, attemptId, ownerId);
        store.db.prepare(`UPDATE tasks SET status = 'exhausted', version = version + 1, updated_at = ?
          WHERE id = ? AND owner_id = ?`).run(timestamp, taskId, ownerId);
        audit(ownerId, 'nightdesk.task_exhausted', taskId, { attemptId, round }, timestamp);
        exhausted = true;
        return { task: taskView(taskRow(ownerId, taskId)), attempt: toAttempt(store.db.prepare('SELECT * FROM task_attempts WHERE id = ?').get(attemptId)), round };
      }
      store.db.prepare(`UPDATE task_attempts SET is_current = 0, updated_at = ?
        WHERE id = ? AND owner_id = ?`).run(timestamp, attemptId, ownerId);
      store.db.prepare(`UPDATE tasks SET status = 'needs_revision', version = version + 1, updated_at = ?
        WHERE id = ? AND owner_id = ?`).run(timestamp, taskId, ownerId);
      return { task: taskView(taskRow(ownerId, taskId)), attempt: toAttempt(store.db.prepare('SELECT * FROM task_attempts WHERE id = ?').get(attemptId)), round };
    });
    if (exhausted) throw fail(DELEGATION_ERRORS.REVIEW_ROUNDS_EXHAUSTED, 'review rounds are exhausted');
    return result;
  }

  function stop(args) {
    requireObject(args);
    const ownerId = requireOwnerId(args.ownerId);
    const taskId = requireId(args.taskId, 'taskId');
    if (args.reason !== undefined && typeof args.reason !== 'string') throw fail(DELEGATION_ERRORS.INVALID_ARGS, 'reason must be a string');
    const timestamp = at();
    return store.transaction(() => {
      const task = taskRow(ownerId, taskId);
      if (!task) throw fail(DELEGATION_ERRORS.NOT_FOUND, 'task not found');
      if (task.status === 'stopped') return taskView(task);
      if (task.status === 'accepted') throw fail(DELEGATION_ERRORS.INVALID_ARGS, 'accepted task cannot be stopped');
      if (task.status === 'canceled') throw fail(DELEGATION_ERRORS.TASK_STOPPED, 'task is stopped');
      const reason = (args.reason ?? '').slice(0, 200);
      store.db.prepare(`UPDATE tasks SET status = 'stopped', version = version + 1, updated_at = ?
        WHERE id = ? AND owner_id = ?`).run(timestamp, taskId, ownerId);
      store.db.prepare(`UPDATE task_attempts SET status = 'stopped', is_current = 0, updated_at = ?
        WHERE task_id = ? AND owner_id = ? AND is_current = 1`).run(timestamp, taskId, ownerId);
      audit(ownerId, 'nightdesk.task_stopped', taskId, { reason }, timestamp);
      return taskView(taskRow(ownerId, taskId));
    });
  }

  function requestChange(args) {
    requireObject(args);
    const ownerId = requireOwnerId(args.ownerId);
    const taskId = requireId(args.taskId, 'taskId');
    requirePositiveInteger(args.goalVersion, 'goalVersion');
    const timestamp = at();
    return store.transaction(() => {
      const task = taskRow(ownerId, taskId);
      if (!task) throw fail(DELEGATION_ERRORS.NOT_FOUND, 'task not found');
      if (task.status === 'stopped' || task.status === 'canceled') throw fail(DELEGATION_ERRORS.TASK_STOPPED, 'task is stopped');
      if (task.goal_version === args.goalVersion) return taskView(task);
      store.db.prepare(`UPDATE task_attempts SET status = 'stale', is_current = 0, updated_at = ?
        WHERE task_id = ? AND owner_id = ? AND is_current = 1`).run(timestamp, taskId, ownerId);
      store.db.prepare(`UPDATE tasks SET goal_version = ?, status = 'drafting', version = version + 1, updated_at = ?
        WHERE id = ? AND owner_id = ?`).run(args.goalVersion, timestamp, taskId, ownerId);
      audit(ownerId, 'nightdesk.goal_changed', taskId, {
        fromGoalVersion: task.goal_version,
        toGoalVersion: args.goalVersion,
      }, timestamp);
      return taskView(taskRow(ownerId, taskId));
    });
  }

  function list(args = {}) {
    requireObject(args);
    const ownerId = requireOwnerId(args.ownerId);
    if (args.status !== undefined && !TASK_STATUSES.has(args.status)) throw fail(DELEGATION_ERRORS.INVALID_ARGS, 'status is unsupported');
    const rows = store.db.prepare(`SELECT * FROM tasks WHERE owner_id = ?
      ${args.status === undefined ? '' : 'AND status = ?'}
      ORDER BY created_at, id`).all(...(args.status === undefined ? [ownerId] : [ownerId, args.status]));
    return rows.map(taskView);
  }

  return { createTask, startAttempt, submitDraft, review, stop, requestChange, list, DELEGATION_ERRORS, ATTEMPT_STATUSES };
}
