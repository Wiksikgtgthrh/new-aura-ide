// The spell registry. Every module under src/spells (and its subfolders) whose default export
// has a create() is a spell; nothing to edit here when adding one (CONTRIBUTING.md).
// A module belongs to `element` (defaults to its own id, for the ten founding elements) and
// sorts by `order`, then name. Each of its `forms` is one entry in the spell browser.
export const ELEMENTS = [
  { id: 'lightning', name: 'Lightning', hue: '#7fb4ff', key: '1' },
  { id: 'fire', name: 'Fire', hue: '#ff7a1a', key: '2' },
  { id: 'water', name: 'Water', hue: '#2fa8ff', key: '3' },
  { id: 'ice', name: 'Ice', hue: '#9ff0ff', key: '4' },
  { id: 'earth', name: 'Earth', hue: '#c08a4a', key: '5' },
  { id: 'wind', name: 'Wind', hue: '#c8f5e4', key: '6' },
  { id: 'void', name: 'Void', hue: '#8a3dff', key: '7' },
  { id: 'light', name: 'Light', hue: '#ffe08a', key: '8' },
  { id: 'acid', name: 'Acid', hue: '#8aff3c', key: '9' },
  { id: 'arcane', name: 'Arcane', hue: '#ff4fd8', key: '0' },
  { id: 'hybrid', name: 'Hybrid', hue: '#ffffff', key: 'h' },
];

const modules = import.meta.glob(['./*.js', './*/*.js', '!./index.js', '!./cast.js', '!./combos.js', '!./_template.js'], { eager: true });
const rank = Object.fromEntries(ELEMENTS.map((e, i) => [e.id, i]));

export const SPELLS = Object.values(modules)
  .map((m) => m.default)
  .filter((s) => s && typeof s.create === 'function')
  .map((s) => { s.element ??= s.id; return s; })
  .filter((s) => s.element in rank)
  .sort((a, b) => rank[a.element] - rank[b.element] || (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));

// one browser entry per (module, form)
export const ENTRIES = SPELLS.flatMap((s) => (s.forms?.length ? s.forms : [s.name]).map((form) => ({
  spell: s, form: s.forms?.length ? form : '', name: s.forms?.length ? form : s.name, element: s.element, key: `${s.id}:${form}`,
})));
