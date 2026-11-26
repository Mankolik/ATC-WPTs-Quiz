// SM-2 style spaced-repetition scheduler (Anki-flavoured).
// Pure functions only: no DOM, no storage. Works in the browser (window.SRS)
// and in Node (module.exports) so it can be tested on its own.
(function (root) {
  const MINUTE_MS = 60 * 1000;
  const DAY_MS = 24 * 60 * MINUTE_MS;

  const DEFAULT_CONFIG = {
    // Steps for a brand-new card before it graduates to day-based reviews.
    learningStepsMs: [1 * MINUTE_MS, 10 * MINUTE_MS],
    // Steps for a review card you got wrong, before it goes back to reviews.
    relearningStepsMs: [10 * MINUTE_MS],
    graduatingIntervalDays: 1,
    startingEase: 2.5,
    minEase: 1.3,
    lapseEasePenalty: 0.2,
    // After a lapse the interval is shrunk by this factor (min 1 day).
    lapseIntervalMultiplier: 0.5,
    maxIntervalDays: 365,
    // Review cards with an interval at least this long count as "known well".
    matureIntervalDays: 21,
    // A new "day" starts at this local hour, like Anki (late-night sessions
    // still count as the previous day).
    dayStartHour: 4,
    // When nothing is due, learning cards due within this window may be shown early.
    learnAheadMs: 20 * MINUTE_MS,
    // +/- fraction of random spread on review intervals of 3+ days, so cards
    // learned together don't stay bunched together forever.
    fuzzFraction: 0.05,
  };

  const STATES = ['new', 'learning', 'review', 'relearning'];

  function withConfig(cfg) {
    return cfg ? { ...DEFAULT_CONFIG, ...cfg } : DEFAULT_CONFIG;
  }

  function newCard(cfg) {
    const c = withConfig(cfg);
    return {
      state: 'new',
      step: 0,
      ease: c.startingEase,
      intervalDays: 0,
      due: 0,
      reps: 0,
      lapses: 0,
      lastGrade: null,
      lastReviewAt: 0,
    };
  }

  function normalizeCard(raw, cfg) {
    const base = newCard(cfg);
    if (!raw || typeof raw !== 'object' || !STATES.includes(raw.state)) return base;
    const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
    return {
      state: raw.state,
      step: Math.max(0, Math.floor(num(raw.step, 0))),
      ease: Math.max(withConfig(cfg).minEase, num(raw.ease, base.ease)),
      intervalDays: Math.max(0, num(raw.intervalDays, 0)),
      due: num(raw.due, 0),
      reps: Math.max(0, num(raw.reps, 0)),
      lapses: Math.max(0, num(raw.lapses, 0)),
      lastGrade: raw.lastGrade === 'again' || raw.lastGrade === 'good' ? raw.lastGrade : null,
      lastReviewAt: num(raw.lastReviewAt, 0),
    };
  }

  // Timestamp of the start of the study day containing `now`.
  function dayStart(now, cfg) {
    const c = withConfig(cfg);
    const d = new Date(now);
    if (d.getHours() < c.dayStartHour) d.setDate(d.getDate() - 1);
    d.setHours(c.dayStartHour, 0, 0, 0);
    return d.getTime();
  }

  // Stable "YYYY-MM-DD" key for the study day containing `now`.
  function dayKey(now, cfg) {
    const d = new Date(dayStart(now, cfg));
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // Reviews are due at the start of a study day, `days` days from today.
  function reviewDueAt(now, days, cfg) {
    const d = new Date(dayStart(now, cfg));
    d.setDate(d.getDate() + Math.max(1, Math.round(days)));
    return d.getTime();
  }

  function fuzzInterval(days, cfg, rand) {
    const c = withConfig(cfg);
    if (days < 3 || !c.fuzzFraction) return days;
    const spread = days * c.fuzzFraction;
    return days + (rand() * 2 - 1) * spread;
  }

  function graduate(card, intervalDays, now, cfg) {
    card.state = 'review';
    card.step = 0;
    card.intervalDays = intervalDays;
    card.due = reviewDueAt(now, intervalDays, cfg);
  }

  // grade: 'again' (wrong / needed help) or 'good' (correct first time).
  // Returns a new card object; the input is not modified.
  function gradeCard(card, grade, now, cfg, rand = Math.random) {
    const c = withConfig(cfg);
    const prev = normalizeCard(card, c);
    const next = { ...prev, reps: prev.reps + 1, lastGrade: grade, lastReviewAt: now };
    const again = grade === 'again';

    switch (prev.state) {
      case 'new':
      case 'learning': {
        const steps = c.learningStepsMs;
        if (again) {
          next.state = 'learning';
          next.step = 0;
          next.due = now + (steps[0] ?? 0);
          break;
        }
        const step = prev.state === 'new' ? 1 : prev.step + 1;
        if (step >= steps.length) {
          graduate(next, c.graduatingIntervalDays, now, c);
        } else {
          next.state = 'learning';
          next.step = step;
          next.due = now + steps[step];
        }
        break;
      }

      case 'relearning': {
        const steps = c.relearningStepsMs;
        if (again) {
          next.step = 0;
          next.due = now + (steps[0] ?? 0);
          break;
        }
        const step = prev.step + 1;
        if (step >= steps.length) {
          graduate(next, prev.intervalDays, now, c);
        } else {
          next.step = step;
          next.due = now + steps[step];
        }
        break;
      }

      case 'review': {
        if (again) {
          next.lapses = prev.lapses + 1;
          next.ease = Math.max(c.minEase, prev.ease - c.lapseEasePenalty);
          next.intervalDays = Math.max(
            1,
            Math.round(prev.intervalDays * c.lapseIntervalMultiplier)
          );
          if (c.relearningStepsMs.length) {
            next.state = 'relearning';
            next.step = 0;
            next.due = now + c.relearningStepsMs[0];
          } else {
            graduate(next, next.intervalDays, now, c);
          }
          break;
        }
        // Remembering a card despite reviewing it late is evidence it's known
        // better than scheduled, so half the overdue time counts too (as in SM-2/Anki).
        const overdueDays = Math.max(0, (now - prev.due) / DAY_MS);
        const raw = (prev.intervalDays + overdueDays / 2) * prev.ease;
        const fuzzed = Math.round(fuzzInterval(raw, c, rand));
        const interval = Math.min(
          c.maxIntervalDays,
          Math.max(prev.intervalDays + 1, fuzzed)
        );
        graduate(next, interval, now, c);
        break;
      }

      default:
        return gradeCard(newCard(c), grade, now, c, rand);
    }

    return next;
  }

  // 'red' = not learned yet / just forgotten, 'yellow' = being learned, 'green' = known well.
  function cardStatus(card, cfg) {
    const c = withConfig(cfg);
    if (!card || card.state === 'new' || card.lastGrade === 'again') return 'red';
    if (card.state === 'review' && card.intervalDays >= c.matureIntervalDays) return 'green';
    return 'yellow';
  }

  function isLearning(card) {
    return card.state === 'learning' || card.state === 'relearning';
  }

  function randomOf(list, rand) {
    return list.length ? list[Math.floor(rand() * list.length)] : null;
  }

  function earliestDue(list) {
    return list.reduce((best, item) => (!best || item.card.due < best.card.due ? item : best), null);
  }

  function pickFrom(items, now, newAllowed, cfg, rand) {
    const c = withConfig(cfg);

    // 1. Learning cards whose step timer has run out, oldest first.
    const learningDue = items.filter((i) => isLearning(i.card) && i.card.due <= now);
    if (learningDue.length) return earliestDue(learningDue);

    // 2. Due reviews and new cards, interleaved in proportion to how many of each remain.
    const reviewsDue = items.filter((i) => i.card.state === 'review' && i.card.due <= now);
    const newCards = newAllowed > 0 ? items.filter((i) => i.card.state === 'new') : [];
    const newCount = Math.min(newAllowed, newCards.length);
    if (reviewsDue.length || newCount) {
      const pickNew = rand() * (reviewsDue.length + newCount) >= reviewsDue.length;
      return pickNew ? randomOf(newCards, rand) : randomOf(reviewsDue, rand);
    }

    // 3. Nothing due: show a learning card early if it's due soon.
    const soon = items.filter((i) => isLearning(i.card) && i.card.due <= now + c.learnAheadMs);
    return earliestDue(soon);
  }

  // items: [{ id, card }]. Returns the chosen item, or null if nothing is due.
  // excludeId (the card just answered) is avoided unless it's the only option.
  function pickNext(items, { now, newAllowed = 0, excludeId = null, rand = Math.random, cfg } = {}) {
    const others = excludeId == null ? items : items.filter((i) => i.id !== excludeId);
    return pickFrom(others, now, newAllowed, cfg, rand) ?? pickFrom(items, now, newAllowed, cfg, rand);
  }

  // Earliest future due time among learning cards (for waking up when idle).
  function nextLearningDueAt(items) {
    const learning = items.filter((i) => isLearning(i.card));
    return learning.length ? earliestDue(learning).card.due : null;
  }

  const SRS = {
    DAY_MS,
    DEFAULT_CONFIG,
    newCard,
    normalizeCard,
    gradeCard,
    cardStatus,
    pickNext,
    nextLearningDueAt,
    dayKey,
    dayStart,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SRS;
  } else {
    root.SRS = SRS;
  }
})(typeof window !== 'undefined' ? window : globalThis);
