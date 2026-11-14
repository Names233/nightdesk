export const TIME_ZONE = 'Asia/Shanghai';

const calendarFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
});

function calendarAt(now) {
  const date = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(date.getTime())) {
    throw new Error('INVALID_ARGS now must be a valid date');
  }
  const parts = Object.fromEntries(
    calendarFormatter.formatToParts(date)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
  };
}

function formatDate(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Date.UTC is used only as a calendar calculator, never as a Shanghai timestamp.
function shiftDate({ year, month, day }, days) {
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return formatDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

function validDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day
    ? formatDate(year, month, day)
    : null;
}

function result(timeStatus, dueDate = null, precision = 'unknown', matchedText = null, basis = null) {
  return { timeStatus, dueAt: null, dueDate, precision, matchedText, basis };
}

const patterns = [
  {
    regex: /(\d{4})([-/年])(\d{1,2})([-/月])(\d{1,2})日?/g,
    parse(match, calendar) {
      const dueDate = validDate(Number(match[1]), Number(match[3]), Number(match[5]));
      return dueDate && result('resolved', dueDate, 'day', match[0], 'literal');
    },
  },
  {
    regex: /(?<![\d/-])(\d{1,2})月(\d{1,2})日?/g,
    parse(match, calendar) {
      const dueDate = validDate(calendar.year, Number(match[1]), Number(match[2]));
      return dueDate && result('resolved', dueDate, 'day', match[0], 'assumed-year');
    },
  },
  {
    regex: /(?<![\d/-])(\d{1,2})\/(\d{1,2})(?![\d/-])/g,
    parse(match, calendar) {
      const dueDate = validDate(calendar.year, Number(match[1]), Number(match[2]));
      return dueDate && result('resolved', dueDate, 'day', match[0], 'assumed-year');
    },
  },
  {
    regex: /(今晚之前|今晚|明晚|明早)/g,
    parse(match, calendar) {
      const days = match[1] === '今晚之前' || match[1] === '今晚' ? 0 : 1;
      return result('ambiguous', shiftDate(calendar, days), 'day', match[0], 'ambiguous-time-of-day');
    },
  },
  {
    regex: /(大后天|后天|明天|今天)/g,
    parse(match, calendar) {
      const days = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3 }[match[1]];
      return result('resolved', shiftDate(calendar, days), 'day', match[0], 'relative-day');
    },
  },
  {
    regex: /(本周|这周)([一二三四五六日天])/g,
    parse(match, calendar) {
      const target = '一二三四五六日天'.indexOf(match[2]);
      const dueDate = shiftDate(calendar, target - (calendar.weekday + 6) % 7);
      return result('resolved', dueDate, 'day', match[0], 'explicit-this-week');
    },
  },
  {
    regex: /下周([一二三四五六日天])/g,
    parse(match, calendar) {
      const target = '一二三四五六日天'.indexOf(match[1]);
      const dueDate = shiftDate(calendar, 7 + target - (calendar.weekday + 6) % 7);
      return result('resolved', dueDate, 'day', match[0], 'explicit-next-week');
    },
  },
  {
    regex: /(?<!周)周([一二三四五六日天])/g,
    parse(match, calendar) {
      const target = '一二三四五六日天'.indexOf(match[1]);
      const days = (target - (calendar.weekday + 6) % 7 + 7) % 7 || 7;
      return result('resolved', shiftDate(calendar, days), 'day', match[0], 'assumed-future-week');
    },
  },
  {
    regex: /(月底|下周|尽快|过几天|近期)/g,
    parse(match) {
      return result('ambiguous', null, 'unknown', match[0], 'ambiguous-relative');
    },
  },
];

/** Extract only dates supported by explicit rules; ambiguous phrases never gain an instant. */
export function extractDeadline(text, now) {
  if (typeof text !== 'string') {
    throw new Error('INVALID_ARGS text must be a string');
  }
  const calendar = calendarAt(now);
  const candidates = [];
  for (const [priority, pattern] of patterns.entries()) {
    pattern.regex.lastIndex = 0;
    let match;
    while ((match = pattern.regex.exec(text)) !== null) {
      const parsed = pattern.parse(match, calendar);
      if (parsed) candidates.push({ ...parsed, index: match.index, priority });
    }
  }
  candidates.sort((a, b) => a.index - b.index || a.priority - b.priority || b.matchedText.length - a.matchedText.length);
  if (candidates.length === 0) return result('unknown');
  const { index, priority, ...deadline } = candidates[0];
  return deadline;
}

export function isShanghaiDate(value, date) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime())
    && shanghaiDate(value) === date;
}

export function shanghaiDate(now) {
  const { year, month, day } = calendarAt(now);
  return formatDate(year, month, day);
}
