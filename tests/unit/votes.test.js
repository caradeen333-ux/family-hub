import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPoll, startMealPoll, mealOfDay, MEAL_LABELS } from '../../js/votes.js';

function fakeEngine() {
  const calls = [];
  return {
    calls,
    async mutate(type, payload, opts) {
      calls.push({ type, payload, opts });
      return { payload };
    },
  };
}

test('createPoll passes extra fields (meal) through to the payload', async () => {
  const engine = fakeEngine();
  await startMealPoll(engine, { author: 'mike', meal: 'breakfast' });
  const { type, payload, opts } = engine.calls[0];
  assert.equal(type, 'poll.created');
  assert.equal(payload.meal, 'breakfast'); // regression: meal was being dropped
  assert.equal(payload.title, "What's for breakfast?");
  assert.equal(payload.kind, 'dinner');
  assert.equal(opts.author, 'mike');
});

test('createPoll builds option ids in order', async () => {
  const engine = fakeEngine();
  await createPoll(engine, { title: 'Pick one', kind: 'general', options: ['A', 'B', 'C'], author: 'mike' });
  const { payload } = engine.calls[0];
  assert.deepEqual(payload.options, [
    { id: 'o1', label: 'A' },
    { id: 'o2', label: 'B' },
    { id: 'o3', label: 'C' },
  ]);
});

test('mealOfDay buckets by hour', () => {
  const at = (h, m = 0) => new Date(2026, 8, 10, h, m).getTime();
  assert.equal(mealOfDay(at(0, 1)), 'breakfast');
  assert.equal(mealOfDay(at(9, 59)), 'breakfast');
  assert.equal(mealOfDay(at(10, 0)), 'lunch');
  assert.equal(mealOfDay(at(14, 59)), 'lunch');
  assert.equal(mealOfDay(at(15, 0)), 'dinner');
  assert.equal(mealOfDay(at(23, 59)), 'dinner');
});

test('every meal has a label', () => {
  for (const meal of ['breakfast', 'lunch', 'dinner']) {
    assert.ok(MEAL_LABELS[meal]);
  }
});
