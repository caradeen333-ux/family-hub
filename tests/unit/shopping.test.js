import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAisle, aisleInfo, parseQty, splitInput, groupByAisle, detectStore, WISHLIST_ID } from '../../js/shopping.js';
import { makeEvent, EVENT_TYPES } from '../../js/storage/log-format.js';
import { mergeLogs } from '../../js/storage/merge.js';

test('aisle detection: dairy, produce, meat, bakery, frozen, pantry, household', () => {
  assert.equal(detectAisle('2% milk'), 'dairy');
  assert.equal(detectAisle('large eggs'), 'dairy');
  assert.equal(detectAisle('apples'), 'produce');
  assert.equal(detectAisle('red onion'), 'produce');
  assert.equal(detectAisle('chicken breast'), 'meat');
  assert.equal(detectAisle('sourdough bread'), 'bakery');
  assert.equal(detectAisle('frozen peas'), 'frozen');
  assert.equal(detectAisle('tomato sauce'), 'pantry');
  assert.equal(detectAisle('paper towels'), 'household');
  assert.equal(detectAisle('zwibbleflorp'), 'other');
});

test('aisle detection is case-insensitive and substring-based', () => {
  assert.equal(detectAisle('MILK'), 'dairy');
  assert.equal(detectAisle('almond milk'), 'dairy');
  assert.equal(detectAisle('chocolate milk'), 'dairy');
});

test('aisleInfo resolves ids and falls back for unknowns', () => {
  assert.equal(aisleInfo('dairy').emoji, '🥛');
  assert.equal(aisleInfo('nonsense').label, 'Everything else');
});

test('parseQty handles "2x milk", "2 milk", "3 x eggs", plain text', () => {
  assert.deepEqual(parseQty('2x milk'), { qty: 2, text: 'milk' });
  assert.deepEqual(parseQty('2 milk'), { qty: 2, text: 'milk' });
  assert.deepEqual(parseQty('3 x eggs'), { qty: 3, text: 'eggs' });
  assert.deepEqual(parseQty('milk'), { qty: 1, text: 'milk' });
  assert.deepEqual(parseQty('  10x sparkling water '), { qty: 10, text: 'sparkling water' });
});

test('splitInput splits commas and newlines, drops empties', () => {
  assert.deepEqual(splitInput('milk, eggs, bread'), ['milk', 'eggs', 'bread']);
  assert.deepEqual(splitInput('milk\neggs\n\nbread\n'), ['milk', 'eggs', 'bread']);
  assert.deepEqual(splitInput('  milk ,,eggs '), ['milk', 'eggs']);
});

test('groupByAisle returns deterministic aisle order and skips empty groups', () => {
  const items = [
    { text: 'milk', aisle: detectAisle('milk'), ts: 1 },
    { text: 'apples', aisle: detectAisle('apples'), ts: 2 },
    { text: 'bananas', aisle: detectAisle('bananas'), ts: 3 },
    { text: 'zwibble', aisle: detectAisle('zwibble'), ts: 4 },
  ];
  const groups = groupByAisle(items);
  assert.deepEqual(groups.map((g) => g.aisle.id), ['produce', 'dairy', 'other']);
  assert.equal(groups[0].items.length, 2); // apples + bananas
});

test('merge: list + item lifecycle with tombstones', () => {
  const NOW = 1788955200000;
  const events = [
    makeEvent(EVENT_TYPES.LIST_UPSERT, 'mike', { listId: 'L1', name: 'Groceries', emoji: '🛒' }, { now: NOW }),
    makeEvent(EVENT_TYPES.ITEM_UPSERT, 'mike', { itemId: 'I1', listId: 'L1', text: 'milk', qty: 2, done: false, aisle: 'dairy' }, { now: NOW }),
    makeEvent(EVENT_TYPES.ITEM_UPSERT, 'avery', { itemId: 'I2', listId: 'L1', text: 'eggs', qty: 1, done: false, aisle: 'dairy' }, { now: NOW }),
    makeEvent(EVENT_TYPES.ITEM_UPSERT, 'mike', { itemId: 'I1', listId: 'L1', text: 'milk', qty: 2, done: true, aisle: 'dairy' }, { now: NOW + 1000 }),
    makeEvent(EVENT_TYPES.ITEM_TOMBSTONE, 'mike', { itemId: 'I2', listId: 'L1' }, { now: NOW + 2000 }),
  ];
  const view = mergeLogs(events, { now: NOW });
  assert.equal(view.lists.size, 1);
  assert.equal(view.lists.get('L1').name, 'Groceries');
  assert.equal(view.items.size, 1);
  assert.equal(view.items.get('I1').done, true); // LWW edit
  assert.equal(view.items.has('I2'), false); // tombstoned
});

test('detectStore badges known retailers by domain', () => {
  assert.deepEqual(detectStore('https://www.amazon.com/dp/B0ABC'), { label: 'Amazon', emoji: '📦' });
  assert.deepEqual(detectStore('https://walmart.com/ip/123'), { label: 'Walmart', emoji: '✳️' });
  assert.deepEqual(detectStore('https://www.target.com/p/x/-/A-123'), { label: 'Target', emoji: '🎯' });
  assert.deepEqual(detectStore('https://example.com/thing'), { label: 'example.com', emoji: '🔗' });
  assert.deepEqual(detectStore('not a url'), { label: 'Link', emoji: '🔗' });
});

test('wishlist id is a reserved constant', () => {
  assert.equal(WISHLIST_ID, 'wishlist');
});

test('merge: deleting a list removes it', () => {
  const NOW = 1788955200000;
  const events = [
    makeEvent(EVENT_TYPES.LIST_UPSERT, 'mike', { listId: 'L1', name: 'Groceries' }, { now: NOW }),
    makeEvent(EVENT_TYPES.LIST_TOMBSTONE, 'mike', { listId: 'L1' }, { now: NOW + 1000 }),
  ];
  const view = mergeLogs(events, { now: NOW });
  assert.equal(view.lists.size, 0);
});
