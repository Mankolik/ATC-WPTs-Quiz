// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const SRS = require('../srs.js');

const MIN = 60 * 1000;
const DAY = SRS.DAY_MS;
// Noon local time, so day boundaries (4am) are unambiguous.
const T0 = new Date(2026, 0, 10, 12, 0, 0).getTime();
const noFuzz = () => 0.5;

function daysUntil(card, now) {
  return Math.round((card.due - SRS.dayStart(now)) / DAY);
}

test('new card: good -> 10 min step -> graduates to 1 day', () => {
  let c = SRS.newCard();
  c = SRS.gradeCard(c, 'good', T0);
  assert.equal(c.state, 'learning');
  assert.equal(c.due, T0 + 10 * MIN);
  assert.equal(SRS.cardStatus(c), 'yellow');

  c = SRS.gradeCard(c, 'good', T0 + 10 * MIN);
  assert.equal(c.state, 'review');
  assert.equal(c.intervalDays, 1);
  assert.equal(daysUntil(c, T0), 1);
});

test('new card: again -> 1 min, stays red', () => {
  const c = SRS.gradeCard(SRS.newCard(), 'again', T0);
  assert.equal(c.state, 'learning');
  assert.equal(c.step, 0);
  assert.equal(c.due, T0 + MIN);
  assert.equal(SRS.cardStatus(c), 'red');
});

test('review intervals grow by ease and card becomes green after ~3 weeks', () => {
  let c = SRS.newCard();
  let now = T0;
  c = SRS.gradeCard(c, 'good', now);
  c = SRS.gradeCard(c, 'good', now);
  const intervals = [];
  for (let i = 0; i < 5; i++) {
    now = c.due;
    c = SRS.gradeCard(c, 'good', now, undefined, noFuzz);
    intervals.push(c.intervalDays);
  }
  assert.deepEqual(intervals, [3, 8, 20, 50, 125]);
  assert.equal(SRS.cardStatus(c), 'green');
});

test('lapse: ease drops, interval halves, relearning then back to review', () => {
  let c = { ...SRS.newCard(), state: 'review', intervalDays: 30, due: T0, ease: 2.5 };
  c = SRS.gradeCard(c, 'again', T0);
  assert.equal(c.state, 'relearning');
  assert.equal(c.lapses, 1);
  assert.equal(c.ease, 2.3);
  assert.equal(c.intervalDays, 15);
  assert.equal(SRS.cardStatus(c), 'red');

  c = SRS.gradeCard(c, 'good', c.due);
  assert.equal(c.state, 'review');
  assert.equal(c.intervalDays, 15);
  assert.equal(SRS.cardStatus(c), 'yellow');
});

test('ease never drops below the minimum', () => {
  let c = { ...SRS.newCard(), state: 'review', intervalDays: 5, due: T0, ease: 1.35 };
  c = SRS.gradeCard(c, 'again', T0);
  assert.equal(c.ease, 1.3);
});

test('normalizeCard rejects garbage and old-format data', () => {
  assert.equal(SRS.normalizeCard(null).state, 'new');
  assert.equal(SRS.normalizeCard({ status: 'green', correctStreak: 5 }).state, 'new');
  assert.equal(SRS.normalizeCard({ state: 'review', intervalDays: 'x' }).intervalDays, 0);
});

test('day boundary is 4am local time', () => {
  const lateNight = new Date(2026, 0, 11, 2, 0, 0).getTime();
  assert.equal(SRS.dayKey(lateNight), '2026-01-10');
  assert.equal(SRS.dayKey(T0), '2026-01-10');
});

test('pickNext: due learning cards come first', () => {
  const items = [
    { id: 'n', card: SRS.newCard() },
    { id: 'r', card: { ...SRS.newCard(), state: 'review', due: T0 - DAY, intervalDays: 3 } },
    { id: 'l', card: { ...SRS.newCard(), state: 'learning', due: T0 - MIN } },
  ];
  assert.equal(SRS.pickNext(items, { now: T0, newAllowed: 10 }).id, 'l');
});

test('pickNext: respects the new-card limit', () => {
  const items = [{ id: 'n', card: SRS.newCard() }];
  assert.equal(SRS.pickNext(items, { now: T0, newAllowed: 0 }), null);
  assert.equal(SRS.pickNext(items, { now: T0, newAllowed: 1 }).id, 'n');
});

test('pickNext: avoids repeating the card just answered when possible', () => {
  const items = [
    { id: 'a', card: { ...SRS.newCard(), state: 'learning', due: T0 - 2 * MIN } },
    { id: 'b', card: { ...SRS.newCard(), state: 'learning', due: T0 - MIN } },
  ];
  assert.equal(SRS.pickNext(items, { now: T0, excludeId: 'a' }).id, 'b');
  assert.equal(SRS.pickNext([items[0]], { now: T0, excludeId: 'a' }).id, 'a');
});

test('pickNext: learns ahead within the window, otherwise nothing', () => {
  const soon = [{ id: 's', card: { ...SRS.newCard(), state: 'learning', due: T0 + 5 * MIN } }];
  assert.equal(SRS.pickNext(soon, { now: T0 }).id, 's');
  const later = [{ id: 'l', card: { ...SRS.newCard(), state: 'review', due: T0 + DAY } }];
  assert.equal(SRS.pickNext(later, { now: T0, newAllowed: 5 }), null);
});

test('a shown-but-unanswered new card is still new (stays in rotation)', () => {
  const items = [{ id: 'x', card: SRS.normalizeCard(SRS.newCard()) }];
  assert.equal(SRS.pickNext(items, { now: T0, newAllowed: 1 }).id, 'x');
});
