// shopping.js — Shopping lists on the event log.
//
// Lists (list.upsert) hold items (item.upsert). Everyone sees the same list
// live — one person at the store, another adding from home.
//
// The magic: items auto-sort into grocery aisles by keyword ("milk" → Dairy,
// "apples" → Produce), quantity prefixes parse ("2x milk", "2 milk"), and a
// pasted comma-list splits into individual items.

import { EVENT_TYPES } from './storage/log-format.js';
import { clock } from './testing/clock.js';

export const DEFAULT_LIST_EMOJI = '🛒';
export const LIST_EMOJIS = ['🛒', '🏠', '🧴', '🛠️', '🎄', '🐕', '🎁', '📦'];
export const WISHLIST_ID = 'wishlist';

// Store detection for wish links — badge label + emoji per domain
export function detectStore(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host.includes('amazon')) return { label: 'Amazon', emoji: '📦' };
    if (host.includes('walmart')) return { label: 'Walmart', emoji: '✳️' };
    if (host.includes('target')) return { label: 'Target', emoji: '🎯' };
    if (host.includes('ebay')) return { label: 'eBay', emoji: '🛍️' };
    if (host.includes('bestbuy')) return { label: 'Best Buy', emoji: '🔌' };
    return { label: host, emoji: '🔗' };
  } catch {
    return { label: 'Link', emoji: '🔗' };
  }
}

export function ensureWishlist(view) {
  return [...view.lists.values()].some((l) => l.listId === WISHLIST_ID);
}

export async function createWishlist(engine) {
  return engine.mutate(EVENT_TYPES.LIST_UPSERT, {
    listId: WISHLIST_ID,
    name: 'Wish list',
    emoji: '🎁',
  });
}

export async function addWishItem(engine, { text, url }, { author } = {}) {
  return engine.mutate(EVENT_TYPES.ITEM_UPSERT, {
    itemId: generateId('w'),
    listId: WISHLIST_ID,
    text,
    url: url || '',
    qty: 1,
    done: false,
  }, { author });
}

export async function updateWishItem(engine, item, patch) {
  return engine.mutate(EVENT_TYPES.ITEM_UPSERT, { ...item, ...patch });
}

export function wishItems(view) {
  return [...view.items.values()]
    .filter((i) => i.listId === WISHLIST_ID)
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
}

// ---- aisle detection (pure, unit-tested) ----

export const AISLES = [
  { id: 'produce', label: 'Produce', emoji: '🥬' },
  { id: 'bakery', label: 'Bakery', emoji: '🍞' },
  { id: 'dairy', label: 'Dairy & Eggs', emoji: '🥛' },
  { id: 'meat', label: 'Meat & Fish', emoji: '🥩' },
  { id: 'frozen', label: 'Frozen', emoji: '🧊' },
  { id: 'pantry', label: 'Pantry', emoji: '🥫' },
  { id: 'pharmacy', label: 'Pharmacy', emoji: '💊' },
  { id: 'household', label: 'Household', emoji: '🧻' },
  { id: 'other', label: 'Everything else', emoji: '🛒' },
];

const AISLE_KEYWORDS = {
  produce: [
    'apple', 'banana', 'lettuce', 'tomato', 'onion', 'potato', 'carrot', 'broccoli', 'spinach', 'cucumber', 'pepper', 'avocado', 'berry', 'berries', 'strawberry', 'grape', 'orange', 'lemon', 'lime', 'melon', 'fruit', 'vegetable', 'salad', 'celery', 'garlic', 'corn', 'mushroom', 'zucchini', 'pear', 'peach', 'pineapple', 'watermelon', 'mango', 'kiwi', 'plum', 'cherries', 'ginger', 'herb', 'cilantro', 'basil', 'parsley', 'scallion', 'shallot',
    'cauliflower', 'cabbage', 'kale', 'arugula', 'asparagus', 'artichoke', 'brussels', 'bok choy', 'leek', 'radish', 'beet', 'turnip', 'squash', 'pumpkin', 'eggplant', 'okra', 'edamame', 'sprouts', 'watercress', 'fennel', 'chard', 'collard', 'dill', 'mint', 'rosemary', 'thyme', 'sage', 'chives', 'oregano', 'peas', 'green beans', 'snap peas', 'pomegranate', 'grapefruit', 'tangerine', 'clementine', 'cantaloupe', 'honeydew', 'papaya', 'guava', 'dragon fruit', 'blueberr', 'raspberr', 'blackberr', 'cranberr',
  ],
  bakery: [
    'bread', 'bagel', 'bun', 'roll', 'tortilla', 'muffin', 'croissant', 'cake', 'donut', 'baguette', 'pita', 'naan',
    'english muffin', 'biscuit', 'scone', 'danish', 'pastry', 'brownie', 'pie', 'cinnamon roll', 'hamburger bun', 'hot dog bun', 'sub roll', 'hoagie', 'ciabatta', 'focaccia', 'sourdough', 'rye bread', 'white bread', 'wheat bread', 'garlic bread', 'crouton', 'breadstick', 'bagel thins', 'pumpernickel',
  ],
  dairy: [
    'milk', 'cheese', 'yogurt', 'butter', 'cream', 'egg', 'sour cream', 'creamer', 'kefir', 'cottage cheese', 'margarine', 'half and half',
    'ricotta', 'mozzarella', 'parmesan', 'cheddar', 'provolone', 'swiss', 'brie', 'feta', 'goat cheese', 'cream cheese', 'almond milk', 'oat milk', 'soy milk', 'lactose', 'whipped cream', 'pudding', 'custard', 'heavy cream', 'whipping cream', 'egg whites', 'egg substitute',
  ],
  meat: [
    'chicken', 'beef', 'pork', 'turkey', 'bacon', 'sausage', 'ham', 'steak', 'ground beef', 'fish', 'salmon', 'shrimp', 'deli', 'meatball', 'meat', 'tuna', 'crab', 'lobster', 'jerky', 'pepperoni', 'hot dog', 'lunch meat',
    'burger', 'patties', 'patty', 'ribs', 'brisket', 'roast', 'wings', 'drumstick', 'chop', 'cutlet', 'filet', 'fillet', 'tenderloin', 'ground turkey', 'ground chicken', 'kielbasa', 'salami', 'prosciutto', 'tilapia', 'cod', 'haddock', 'halibut', 'trout', 'scallop', 'mussel', 'oyster', 'clam', 'anchovy', 'sardine', 'seafood', 'crab cake', 'brat', 'pastrami', 'liver', 'lamb', 'veal', 'venison', 'chorizo', 'andouille', 'cold cuts', 'rotisserie',
  ],
  frozen: [
    'frozen', 'ice cream', 'popsicle', 'waffle', 'pizza', 'tater', 'fries', 'dumpling', 'burrito', 'nugget', 'frozen veg',
    'tv dinner', 'frozen dinner', 'lasagna', 'ice', 'ice cream sandwich', 'frozen fruit', 'smoothie', 'pierogi', 'perogies', 'egg roll', 'spring roll', 'potsticker', 'fish stick', 'chicken strip', 'tots', 'popsicles', 'gelato', 'sherbet', 'ice pop',
  ],
  pantry: [
    'rice', 'pasta', 'cereal', 'soup', 'can', 'canned', 'sauce', 'oil', 'flour', 'sugar', 'salt', 'spice', 'coffee', 'tea', 'snack', 'chip', 'cracker', 'cookie', 'nut', 'peanut butter', 'jelly', 'syrup', 'oats', 'oatmeal', 'beans', 'quinoa', 'honey', 'vinegar', 'ketchup', 'mustard', 'mayo', 'noodle', 'granola', 'popcorn', 'pretzel', 'salsa', 'stock', 'broth', 'breadcrumbs', 'baking soda', 'baking powder', 'cocoa', 'chocolate', 'candy', 'gum', 'juice', 'soda', 'water', 'sparkling', 'coconut', 'condiment', 'seasoning', 'marinade', 'dressing', 'pickle', 'olive',
    'pancake mix', 'waffle mix', 'cereal bar', 'granola bar', 'protein bar', 'instant', 'mac and cheese', 'hamburger helper', 'taco', 'tortilla chip', 'hummus', 'guacamole', 'ranch', 'bbq sauce', 'hot sauce', 'sriracha', 'teriyaki', 'soy sauce', 'worcestershire', 'fish sauce', 'oyster sauce', 'curry', 'taco seasoning', 'chili', 'refried beans', 'tomato paste', 'diced tomatoes', 'marinara', 'alfredo', 'pesto', 'ramen', 'cup noodle', 'energy drink', 'gatorade', 'powerade', 'sports drink', 'tonic', 'ginger ale', 'root beer', 'lemonade', 'ice tea', 'iced tea', 'apple juice', 'orange juice', 'cranberry juice', 'marshmallow', 'sprinkle', 'frosting', 'cake mix', 'brownie mix', 'cookie dough', 'pie crust', 'jello', 'gelatin', 'pudding mix', 'evaporated milk', 'condensed milk', 'coconut milk', 'bouillon', 'cornstarch', 'corn starch', 'yeast', 'molasses', 'brown sugar', 'powdered sugar', 'baking chips', 'chocolate chips', 'raisin', 'dried fruit', 'trail mix', 'almond', 'cashew', 'walnut', 'pecan', 'peanut', 'sunflower seed', 'pumpkin seed', 'chia', 'flax', 'instant potato', 'stuffing', 'crouton', 'canned fruit', 'applesauce', 'preserves', 'marmalade', 'nutella', 'peanut butter cup', 'licorice', 'taffy', 'mints', 'breath mint',
  ],
  pharmacy: [
    'ibuprofen', 'tylenol', 'advil', 'aspirin', 'vitamin', 'supplement', 'allergy', 'cold medicine', 'cough', 'band-aid', 'bandage', 'first aid', 'thermometer', 'saline', 'eyedrop', 'eye drop', 'contact solution', 'contact lens', 'antacid', 'tums', 'pepto', 'imodium', 'laxative', 'pain reliever', 'prescription', 'melatonin', 'probiotic', 'protein powder', 'fiber', 'emergen-c', 'nyquil', 'dayquil', 'robitussin', 'mucinex', 'neosporin', 'hydrocortisone', 'vapor rub', 'humidifier', 'inhaler', 'blood pressure', 'glucose', 'hearing aid', 'reading glasses', 'medicine', 'medication',
  ],
  household: [
    'paper', 'towel', 'tissue', 'soap', 'shampoo', 'conditioner', 'detergent', 'bleach', 'trash', 'bag', 'sponge', 'foil', 'wrap', 'battery', 'light bulb', 'cleaner', 'wipes', 'toilet paper', 'dish soap', 'laundry', 'fabric softener', 'deodorant', 'toothpaste', 'toothbrush', 'razor', 'shave', 'lotion', 'sunscreen', 'diaper', 'wipes', 'pet food', 'dog food', 'cat food', 'cat litter', 'ziploc', 'freezer bag', 'air freshener', 'candle',
    'plate', 'cup', 'napkin', 'utensil', 'silverware', 'parchment', 'wax paper', 'coffee filter', 'dish detergent', 'hand soap', 'body wash', 'bar soap', 'floss', 'mouthwash', 'q-tip', 'cotton ball', 'cotton swab', 'garbage', 'recycling', 'lightbulb', 'laundry pod', 'dryer sheet', 'stain remover', 'glass cleaner', 'all purpose cleaner', 'disinfectant', 'bug spray', 'insect', 'lighter', 'matches', 'charcoal', 'propane', 'storage bin', 'batteries', 'dust pan', 'mop', 'broom', 'vacuum bag', 'furniture polish', 'wood cleaner', 'aluminum foil', 'plastic wrap', 'sandwich bag', 'storage bag', 'paper plate', 'plastic cup', 'styrofoam', 'glove', 'scrubber', 'dish brush', 'drain cleaner', 'toilet cleaner', 'tub cleaner', 'tile cleaner', 'window cleaner', 'dust cloth', 'microfiber',
  ],
};

// Keyword match with a SPECIFICITY-first order: multi-word products win over
// their ingredients ("tomato sauce" → Pantry, not Produce; "chicken broth" →
// Pantry, not Meat; "chocolate milk" → Dairy, not Pantry). Display order
// (AISLES) is separate.
// Bakery before meat: "hamburger buns" must win over the "burger" keyword
const DETECTION_ORDER = ['frozen', 'dairy', 'pantry', 'pharmacy', 'household', 'bakery', 'meat', 'produce'];

export function detectAisle(text) {
  const t = ` ${text.toLowerCase()} `;
  for (const aisleId of DETECTION_ORDER) {
    for (const kw of AISLE_KEYWORDS[aisleId] ?? []) {
      if (t.includes(kw)) return aisleId;
    }
  }
  return 'other';
}

export function aisleInfo(aisleId) {
  return AISLES.find((a) => a.id === aisleId) ?? AISLES[AISLES.length - 1];
}

// ---- quantity parsing (pure, unit-tested) ----

// "2x milk" / "2 milk" / "3 x milk" → {qty: 2, text: "milk"}
export function parseQty(raw) {
  const m = /^\s*(\d{1,3})\s*x?\s+(.+)$/i.exec(raw.trim());
  if (m) return { qty: Number(m[1]), text: m[2].trim() };
  return { qty: 1, text: raw.trim() };
}

// One pasted/typed string → many items: "milk, eggs, bread" → 3
export function splitInput(raw) {
  return raw
    .split(/,|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---- events ----

export function generateId(prefix = 'i') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

export async function createList(engine, { name, emoji = DEFAULT_LIST_EMOJI }) {
  return engine.mutate(EVENT_TYPES.LIST_UPSERT, {
    listId: generateId('l'),
    name: name.trim(),
    emoji,
  });
}

export async function deleteList(engine, listId) {
  return engine.mutate(EVENT_TYPES.LIST_TOMBSTONE, { listId });
}

// Add one or more items (each with qty + detected aisle)
export async function addItems(engine, listId, rawEntries, { author } = {}) {
  for (const entry of rawEntries) {
    const { qty, text } = parseQty(entry);
    await engine.mutate(EVENT_TYPES.ITEM_UPSERT, {
      itemId: generateId(),
      listId,
      text,
      qty,
      done: false,
      aisle: detectAisle(text),
    }, { author });
  }
}

export async function updateItem(engine, item, patch) {
  await engine.mutate(EVENT_TYPES.ITEM_UPSERT, { ...item, ...patch, aisle: detectAisle(patch.text ?? item.text) });
}

export async function toggleItem(engine, item) {
  await engine.mutate(EVENT_TYPES.ITEM_UPSERT, { ...item, done: !item.done });
}

export async function deleteItem(engine, item) {
  await engine.mutate(EVENT_TYPES.ITEM_TOMBSTONE, { itemId: item.itemId, listId: item.listId });
}

// Delete all done items in a list; returns the deleted items (for Undo)
export async function clearChecked(engine, itemsInList) {
  const done = itemsInList.filter((i) => i.done);
  for (const item of done) {
    await engine.mutate(EVENT_TYPES.ITEM_TOMBSTONE, { itemId: item.itemId, listId: item.listId });
  }
  return done;
}

// Undo a clear-checked: re-add the items (fresh ids — dedupe-safe)
export async function restoreItems(engine, items) {
  for (const item of items) {
    await engine.mutate(EVENT_TYPES.ITEM_UPSERT, {
      itemId: generateId(),
      listId: item.listId,
      text: item.text,
      qty: item.qty ?? 1,
      done: false,
      aisle: item.aisle ?? detectAisle(item.text),
    });
  }
}

// ---- view helpers ----

export function ensureDefaultList(view) {
  return view.lists.size === 0;
}

export function sortedLists(view) {
  return [...view.lists.values()].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}

export function itemsInList(view, listId) {
  return [...view.items.values()].filter((i) => i.listId === listId);
}

// Aisle grouping (deterministic order), done items excluded
export function groupByAisle(activeItems) {
  const groups = new Map();
  for (const item of activeItems) {
    const aisle = item.aisle ?? detectAisle(item.text);
    if (!groups.has(aisle)) groups.set(aisle, []);
    groups.get(aisle).push(item);
  }
  return AISLES
    .map((a) => (groups.has(a.id) ? { aisle: a, items: groups.get(a.id) } : null))
    .filter(Boolean);
}
