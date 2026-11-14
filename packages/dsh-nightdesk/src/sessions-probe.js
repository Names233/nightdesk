const RUN_STATE_REASON = 'host read seam does not expose run state';
const UNAVAILABLE_REASON = 'sessionQuery-unavailable';

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_ARGS arguments must be an object');
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`INVALID_ARGS ${field} must be a non-empty string`);
  }
}

function asMilliseconds(value) {
  const candidate = typeof value === 'function' ? value() : value;
  const milliseconds = candidate instanceof Date ? candidate.getTime() : new Date(candidate ?? Date.now()).getTime();
  if (!Number.isFinite(milliseconds)) throw new Error('INVALID_ARGS now must be a valid date');
  return milliseconds;
}

function asIso(value) {
  return new Date(asMilliseconds(value)).toISOString();
}

function errorCode(cause) {
  return typeof cause?.code === 'string' && cause.code.length > 0 ? cause.code : String(cause?.message ?? cause);
}

function sessionRecord(surface) {
  const session = surface?.session;
  if (!session || typeof session !== 'object') return null;
  const record = session.record && typeof session.record === 'object' ? session.record : session;
  const header = record.header ?? record.session?.header ?? {};
  return {
    live: record.live ?? record.session?.live ?? false,
    persisted: record.persisted ?? record.session?.persisted ?? false,
    header,
  };
}

function eventTime(event) {
  return event && Number.isFinite(event.time) ? new Date(event.time).toISOString() : null;
}

function lastEventOf(events) {
  let latest = null;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (latest === null || (Number.isFinite(event.seq) && (!Number.isFinite(latest.seq) || event.seq >= latest.seq))) {
      latest = event;
    }
  }
  return latest;
}

function unavailable() {
  return { available: false, reason: UNAVAILABLE_REASON };
}

export function createSessionProbe({ getSessionQuery, now = Date.now, store } = {}) {
  if (typeof getSessionQuery !== 'function') throw new Error('INVALID_ARGS getSessionQuery must be a function');
  if (!store || typeof store.watchSession !== 'function' || typeof store.unwatchSession !== 'function'
    || typeof store.listWatchedSessions !== 'function' || typeof store.updateWatchedSession !== 'function') {
    throw new Error('INVALID_ARGS store does not support watched sessions');
  }

  const currentTime = () => asIso(now);
  const owner = (ownerId) => {
    const resolved = ownerId ?? store.ownerId;
    requiredString(resolved, 'ownerId');
    return resolved;
  };

  const isAvailable = () => {
    try { return getSessionQuery() !== undefined; } catch { return false; }
  };

  function watch(args = {}) {
    requireObject(args);
    const ownerId = owner(args.ownerId);
    requiredString(args.sessionId, 'sessionId');
    if (args.label !== undefined && typeof args.label !== 'string') {
      throw new Error('INVALID_ARGS label must be a string');
    }
    return store.watchSession({ ownerId, sessionId: args.sessionId, label: args.label, at: currentTime() });
  }

  function unwatch(args = {}) {
    requireObject(args);
    const ownerId = owner(args.ownerId);
    requiredString(args.sessionId, 'sessionId');
    return store.unwatchSession({ ownerId, sessionId: args.sessionId });
  }

  function list(args = {}) {
    requireObject(args);
    return store.listWatchedSessions({ ownerId: owner(args.ownerId) });
  }

  function refresh(args = {}) {
    requireObject(args);
    const ownerId = owner(args.ownerId);
    if (args.sessionIds !== undefined && (!Array.isArray(args.sessionIds)
      || args.sessionIds.some((sessionId) => typeof sessionId !== 'string' || sessionId.length === 0))) {
      throw new Error('INVALID_ARGS sessionIds must be an array of non-empty strings');
    }
    let watched = store.listWatchedSessions({ ownerId });
    if (args.sessionIds !== undefined) {
      const selected = new Set(args.sessionIds);
      watched = watched.filter(({ sessionId }) => selected.has(sessionId));
    }
    let query;
    try { query = getSessionQuery(); } catch { query = undefined; }
    if (query === undefined) return unavailable();
    if (!query || typeof query.readSurface !== 'function') {
      const unavailableReadAt = currentTime();
      return watched.map((record) => failedResult(
        record, unavailableReadAt, 'sessionQuery-readSurface-unavailable', 'read_failed', ownerId, store,
      ));
    }

    const readAt = currentTime();
    return watched.map((record) => {
      try {
        const surface = query.readSurface(record.sessionId);
        const session = sessionRecord(surface);
        if (!session) throw Object.assign(new Error('session not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
        const events = Array.isArray(surface.events) ? surface.events : [];
        const lastEvent = lastEventOf(events);
        const capturedThroughSeq = Number.isInteger(surface.capturedThroughSeq)
          ? surface.capturedThroughSeq : (Number.isInteger(lastEvent?.seq) ? lastEvent.seq : null);
        const result = {
          sessionId: record.sessionId,
          label: record.label,
          found: true,
          live: Boolean(session.live),
          persisted: Boolean(session.persisted),
          capturedThroughSeq,
          eventCount: events.length,
          inheritedEventCount: Number.isInteger(surface.inheritedEventCount) ? surface.inheritedEventCount : 0,
          lastEvent: lastEvent ? {
            type: lastEvent.type ?? null,
            seq: Number.isInteger(lastEvent.seq) ? lastEvent.seq : null,
            time: eventTime(lastEvent),
          } : null,
          readAt,
          runState: 'unknown',
          runStateReason: RUN_STATE_REASON,
          status: 'read_ok',
          error: null,
        };
        store.updateWatchedSession({
          ownerId,
          sessionId: record.sessionId,
          lastReadAt: readAt,
          lastSeq: capturedThroughSeq,
          lastEventAt: result.lastEvent?.time ?? null,
          lastEventType: result.lastEvent?.type ?? null,
          status: result.status,
          error: null,
          updatedAt: readAt,
        });
        return result;
      } catch (cause) {
        const status = cause?.code === 'SESSION_QUERY_SESSION_NOT_FOUND' ? 'not_found' : 'read_failed';
        return failedResult(record, readAt, errorCode(cause), status, ownerId, store);
      }
    });
  }

  return { watch, unwatch, list, refresh, isAvailable };
}

function failedResult(record, readAt, failure, status, ownerId, store) {
  const result = {
    sessionId: record.sessionId,
    label: record.label,
    found: false,
    live: null,
    persisted: null,
    capturedThroughSeq: null,
    eventCount: 0,
    inheritedEventCount: 0,
    lastEvent: null,
    readAt,
    runState: 'unknown',
    runStateReason: RUN_STATE_REASON,
    status,
    error: failure,
  };
  if (ownerId && store) {
    store.updateWatchedSession({
      ownerId,
      sessionId: record.sessionId,
      lastReadAt: readAt,
      lastSeq: null,
      lastEventAt: null,
      lastEventType: null,
      status,
      error: failure,
      updatedAt: readAt,
    });
  }
  return result;
}
