#!/usr/bin/env node

// server/index.mjs
import readline from "node:readline";
import fs3 from "node:fs";

// core/sources.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "_backup", "_backups", ".backup", "backup"]);
function defaultRoots(cwd = process.cwd()) {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".config", "opencode", "skills"),
    path.join(home, ".config", "opencode", "skill"),
    path.join(home, ".opencode", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(cwd, ".opencode", "skills")
  ];
  return candidates.filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}
function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last2 = value[value.length - 1];
    if (first === '"' && last2 === '"' || first === "'" && last2 === "'") {
      return value.slice(1, -1);
    }
  }
  return value;
}
var BLOCK_HEADER = /^[A-Za-z_][\w-]*:\s*[|>][-+]?\s*$/;
var KV_LINE = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/;
function parseFrontmatter(text) {
  const src = text.charCodeAt(0) === 65279 ? text.slice(1) : text;
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(src);
  if (!m) return { data: {}, body: src, hasFrontmatter: false, bodyLineOffset: 0 };
  const data = {};
  const lines = m[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) {
      i += 1;
      continue;
    }
    const kv = KV_LINE.exec(line);
    if (!kv) {
      i += 1;
      continue;
    }
    const key = kv[1];
    let value = kv[2].trim();
    i += 1;
    if (BLOCK_HEADER.test(line)) {
      const block = [];
      while (i < lines.length && /^[ \t]/.test(lines[i]) && lines[i].trim() !== "") {
        block.push(lines[i].trim());
        i += 1;
      }
      value = value.startsWith(">") ? block.join(" ") : block.join("\n");
    } else if (value === "") {
      const block = [];
      while (i < lines.length && /^[ \t]/.test(lines[i]) && lines[i].trim() !== "") {
        block.push(lines[i].trim());
        i += 1;
      }
      value = block.join(" ");
    } else {
      const block = [];
      while (i < lines.length && /^[ \t]/.test(lines[i]) && lines[i].trim() !== "" && !KV_LINE.test(lines[i].trim())) {
        block.push(lines[i].trim());
        i += 1;
      }
      if (block.length > 0) value = [value, ...block].join(" ");
    }
    data[key] = unquote(value);
  }
  const bodyLineOffset = m[0].split(/\r?\n/).length - 1;
  return { data, body: src.slice(m[0].length), hasFrontmatter: true, bodyLineOffset };
}
function extractHeadingEntries(text) {
  const { body, bodyLineOffset } = parseFrontmatter(text);
  const out = [];
  let fenced = false;
  let lineNo = bodyLineOffset;
  for (const line of body.split(/\r?\n/)) {
    lineNo += 1;
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2], line: lineNo });
  }
  return out;
}
function extractHeadings(body) {
  const out = [];
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) out.push(m[2]);
  }
  return out;
}
function parseSkill(text) {
  const { data, body } = parseFrontmatter(text);
  const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : null;
  const description = typeof data.description === "string" ? data.description.trim() : "";
  return { name, description, bodyHeadings: extractHeadings(body) };
}
function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.name === "SKILL.md" && (entry.isFile() || entry.isSymbolicLink())) {
      yield full;
    }
  }
}
function isInsideRoot(realRoot, realTarget) {
  const rel = path.relative(realRoot, realTarget);
  return !(rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}
function discoverSkills(roots = defaultRoots()) {
  const seen = /* @__PURE__ */ new Map();
  const skipped = [];
  for (const root of roots) {
    let realRoot;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      continue;
    }
    for (const file of walk(root)) {
      let real;
      try {
        real = fs.realpathSync(file);
      } catch {
        continue;
      }
      if (!isInsideRoot(realRoot, real)) {
        skipped.push({ path: file, root, reason: "outside-root" });
        continue;
      }
      if (seen.has(real)) continue;
      let text;
      try {
        text = fs.readFileSync(real, "utf8");
      } catch {
        continue;
      }
      const parsed = parseSkill(text);
      seen.set(real, {
        name: parsed.name || path.basename(path.dirname(real)),
        path: real,
        description: parsed.description,
        bodyHeadings: parsed.bodyHeadings,
        root
      });
    }
  }
  return { skills: [...seen.values()], skipped };
}
var PathForbiddenError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PathForbiddenError";
    this.code = "E_FORBIDDEN";
  }
};
var PathNotFoundError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PathNotFoundError";
    this.code = "E_NOT_FOUND";
  }
};
function resolveSkillPath(skill, root) {
  const target = typeof skill === "string" ? skill : skill && skill.path;
  if (!target) throw new PathNotFoundError("path is required");
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    throw new PathNotFoundError(`root does not exist: ${root}`);
  }
  let realFile;
  try {
    realFile = fs.realpathSync(target);
  } catch {
    throw new PathNotFoundError(`cannot resolve path: ${target}`);
  }
  if (!isInsideRoot(realRoot, realFile)) {
    throw new PathForbiddenError(`path escapes skill root: ${target}`);
  }
  return realFile;
}

// core/index.mjs
import fs2 from "node:fs";
import { fileURLToPath } from "node:url";

// node_modules/minisearch/dist/es/index.js
var ENTRIES = "ENTRIES";
var KEYS = "KEYS";
var VALUES = "VALUES";
var LEAF = "";
var TreeIterator = class {
  constructor(set, type) {
    const node = set._tree;
    const keys = Array.from(node.keys());
    this.set = set;
    this._type = type;
    this._path = keys.length > 0 ? [{ node, keys }] : [];
  }
  next() {
    const value = this.dive();
    this.backtrack();
    return value;
  }
  dive() {
    if (this._path.length === 0) {
      return { done: true, value: void 0 };
    }
    const { node, keys } = last$1(this._path);
    if (last$1(keys) === LEAF) {
      return { done: false, value: this.result() };
    }
    const child = node.get(last$1(keys));
    this._path.push({ node: child, keys: Array.from(child.keys()) });
    return this.dive();
  }
  backtrack() {
    if (this._path.length === 0) {
      return;
    }
    const keys = last$1(this._path).keys;
    keys.pop();
    if (keys.length > 0) {
      return;
    }
    this._path.pop();
    this.backtrack();
  }
  key() {
    return this.set._prefix + this._path.map(({ keys }) => last$1(keys)).filter((key) => key !== LEAF).join("");
  }
  value() {
    return last$1(this._path).node.get(LEAF);
  }
  result() {
    switch (this._type) {
      case VALUES:
        return this.value();
      case KEYS:
        return this.key();
      default:
        return [this.key(), this.value()];
    }
  }
  [Symbol.iterator]() {
    return this;
  }
};
var last$1 = (array) => {
  return array[array.length - 1];
};
var fuzzySearch = (node, query, maxDistance) => {
  const results = /* @__PURE__ */ new Map();
  if (query === void 0)
    return results;
  const n = query.length + 1;
  const m = n + maxDistance;
  const matrix = new Uint8Array(m * n).fill(maxDistance + 1);
  for (let j = 0; j < n; ++j)
    matrix[j] = j;
  for (let i = 1; i < m; ++i)
    matrix[i * n] = i;
  recurse(node, query, maxDistance, results, matrix, 1, n, "");
  return results;
};
var recurse = (node, query, maxDistance, results, matrix, m, n, prefix) => {
  const offset = m * n;
  key: for (const key of node.keys()) {
    if (key === LEAF) {
      const distance = matrix[offset - 1];
      if (distance <= maxDistance) {
        results.set(prefix, [node.get(key), distance]);
      }
    } else {
      let i = m;
      for (let pos = 0; pos < key.length; ++pos, ++i) {
        const char = key[pos];
        const thisRowOffset = n * i;
        const prevRowOffset = thisRowOffset - n;
        let minDistance = matrix[thisRowOffset];
        const jmin = Math.max(0, i - maxDistance - 1);
        const jmax = Math.min(n - 1, i + maxDistance);
        for (let j = jmin; j < jmax; ++j) {
          const different = char !== query[j];
          const rpl = matrix[prevRowOffset + j] + +different;
          const del = matrix[prevRowOffset + j + 1] + 1;
          const ins = matrix[thisRowOffset + j] + 1;
          const dist = matrix[thisRowOffset + j + 1] = Math.min(rpl, del, ins);
          if (dist < minDistance)
            minDistance = dist;
        }
        if (minDistance > maxDistance) {
          continue key;
        }
      }
      recurse(node.get(key), query, maxDistance, results, matrix, i, n, prefix + key);
    }
  }
};
var SearchableMap = class _SearchableMap {
  /**
   * The constructor is normally called without arguments, creating an empty
   * map. In order to create a {@link SearchableMap} from an iterable or from an
   * object, check {@link SearchableMap.from} and {@link
   * SearchableMap.fromObject}.
   *
   * The constructor arguments are for internal use, when creating derived
   * mutable views of a map at a prefix.
   */
  constructor(tree = /* @__PURE__ */ new Map(), prefix = "") {
    this._size = void 0;
    this._tree = tree;
    this._prefix = prefix;
  }
  /**
   * Creates and returns a mutable view of this {@link SearchableMap},
   * containing only entries that share the given prefix.
   *
   * ### Usage:
   *
   * ```javascript
   * let map = new SearchableMap()
   * map.set("unicorn", 1)
   * map.set("universe", 2)
   * map.set("university", 3)
   * map.set("unique", 4)
   * map.set("hello", 5)
   *
   * let uni = map.atPrefix("uni")
   * uni.get("unique") // => 4
   * uni.get("unicorn") // => 1
   * uni.get("hello") // => undefined
   *
   * let univer = map.atPrefix("univer")
   * univer.get("unique") // => undefined
   * univer.get("universe") // => 2
   * univer.get("university") // => 3
   * ```
   *
   * @param prefix  The prefix
   * @return A {@link SearchableMap} representing a mutable view of the original
   * Map at the given prefix
   */
  atPrefix(prefix) {
    if (!prefix.startsWith(this._prefix)) {
      throw new Error("Mismatched prefix");
    }
    const [node, path2] = trackDown(this._tree, prefix.slice(this._prefix.length));
    if (node === void 0) {
      const [parentNode, key] = last(path2);
      for (const k of parentNode.keys()) {
        if (k !== LEAF && k.startsWith(key)) {
          const node2 = /* @__PURE__ */ new Map();
          node2.set(k.slice(key.length), parentNode.get(k));
          return new _SearchableMap(node2, prefix);
        }
      }
    }
    return new _SearchableMap(node, prefix);
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/clear
   */
  clear() {
    this._size = void 0;
    this._tree.clear();
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/delete
   * @param key  Key to delete
   */
  delete(key) {
    this._size = void 0;
    return remove(this._tree, key);
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/entries
   * @return An iterator iterating through `[key, value]` entries.
   */
  entries() {
    return new TreeIterator(this, ENTRIES);
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/forEach
   * @param fn  Iteration function
   */
  forEach(fn) {
    for (const [key, value] of this) {
      fn(key, value, this);
    }
  }
  /**
   * Returns a Map of all the entries that have a key within the given edit
   * distance from the search key. The keys of the returned Map are the matching
   * keys, while the values are two-element arrays where the first element is
   * the value associated to the key, and the second is the edit distance of the
   * key to the search key.
   *
   * ### Usage:
   *
   * ```javascript
   * let map = new SearchableMap()
   * map.set('hello', 'world')
   * map.set('hell', 'yeah')
   * map.set('ciao', 'mondo')
   *
   * // Get all entries that match the key 'hallo' with a maximum edit distance of 2
   * map.fuzzyGet('hallo', 2)
   * // => Map(2) { 'hello' => ['world', 1], 'hell' => ['yeah', 2] }
   *
   * // In the example, the "hello" key has value "world" and edit distance of 1
   * // (change "e" to "a"), the key "hell" has value "yeah" and edit distance of 2
   * // (change "e" to "a", delete "o")
   * ```
   *
   * @param key  The search key
   * @param maxEditDistance  The maximum edit distance (Levenshtein)
   * @return A Map of the matching keys to their value and edit distance
   */
  fuzzyGet(key, maxEditDistance) {
    return fuzzySearch(this._tree, key, maxEditDistance);
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/get
   * @param key  Key to get
   * @return Value associated to the key, or `undefined` if the key is not
   * found.
   */
  get(key) {
    const node = lookup(this._tree, key);
    return node !== void 0 ? node.get(LEAF) : void 0;
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/has
   * @param key  Key
   * @return True if the key is in the map, false otherwise
   */
  has(key) {
    const node = lookup(this._tree, key);
    return node !== void 0 && node.has(LEAF);
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/keys
   * @return An `Iterable` iterating through keys
   */
  keys() {
    return new TreeIterator(this, KEYS);
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/set
   * @param key  Key to set
   * @param value  Value to associate to the key
   * @return The {@link SearchableMap} itself, to allow chaining
   */
  set(key, value) {
    if (typeof key !== "string") {
      throw new Error("key must be a string");
    }
    this._size = void 0;
    const node = createPath(this._tree, key);
    node.set(LEAF, value);
    return this;
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/size
   */
  get size() {
    if (this._size) {
      return this._size;
    }
    this._size = 0;
    const iter = this.entries();
    while (!iter.next().done)
      this._size += 1;
    return this._size;
  }
  /**
   * Updates the value at the given key using the provided function. The function
   * is called with the current value at the key, and its return value is used as
   * the new value to be set.
   *
   * ### Example:
   *
   * ```javascript
   * // Increment the current value by one
   * searchableMap.update('somekey', (currentValue) => currentValue == null ? 0 : currentValue + 1)
   * ```
   *
   * If the value at the given key is or will be an object, it might not require
   * re-assignment. In that case it is better to use `fetch()`, because it is
   * faster.
   *
   * @param key  The key to update
   * @param fn  The function used to compute the new value from the current one
   * @return The {@link SearchableMap} itself, to allow chaining
   */
  update(key, fn) {
    if (typeof key !== "string") {
      throw new Error("key must be a string");
    }
    this._size = void 0;
    const node = createPath(this._tree, key);
    node.set(LEAF, fn(node.get(LEAF)));
    return this;
  }
  /**
   * Fetches the value of the given key. If the value does not exist, calls the
   * given function to create a new value, which is inserted at the given key
   * and subsequently returned.
   *
   * ### Example:
   *
   * ```javascript
   * const map = searchableMap.fetch('somekey', () => new Map())
   * map.set('foo', 'bar')
   * ```
   *
   * @param key  The key to update
   * @param initial  A function that creates a new value if the key does not exist
   * @return The existing or new value at the given key
   */
  fetch(key, initial) {
    if (typeof key !== "string") {
      throw new Error("key must be a string");
    }
    this._size = void 0;
    const node = createPath(this._tree, key);
    let value = node.get(LEAF);
    if (value === void 0) {
      node.set(LEAF, value = initial());
    }
    return value;
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/values
   * @return An `Iterable` iterating through values.
   */
  values() {
    return new TreeIterator(this, VALUES);
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/@@iterator
   */
  [Symbol.iterator]() {
    return this.entries();
  }
  /**
   * Creates a {@link SearchableMap} from an `Iterable` of entries
   *
   * @param entries  Entries to be inserted in the {@link SearchableMap}
   * @return A new {@link SearchableMap} with the given entries
   */
  static from(entries) {
    const tree = new _SearchableMap();
    for (const [key, value] of entries) {
      tree.set(key, value);
    }
    return tree;
  }
  /**
   * Creates a {@link SearchableMap} from the iterable properties of a JavaScript object
   *
   * @param object  Object of entries for the {@link SearchableMap}
   * @return A new {@link SearchableMap} with the given entries
   */
  static fromObject(object) {
    return _SearchableMap.from(Object.entries(object));
  }
};
var trackDown = (tree, key, path2 = []) => {
  if (key.length === 0 || tree == null) {
    return [tree, path2];
  }
  for (const k of tree.keys()) {
    if (k !== LEAF && key.startsWith(k)) {
      path2.push([tree, k]);
      return trackDown(tree.get(k), key.slice(k.length), path2);
    }
  }
  path2.push([tree, key]);
  return trackDown(void 0, "", path2);
};
var lookup = (tree, key) => {
  if (key.length === 0 || tree == null) {
    return tree;
  }
  for (const k of tree.keys()) {
    if (k !== LEAF && key.startsWith(k)) {
      return lookup(tree.get(k), key.slice(k.length));
    }
  }
};
var createPath = (node, key) => {
  const keyLength = key.length;
  outer: for (let pos = 0; node && pos < keyLength; ) {
    for (const k of node.keys()) {
      if (k !== LEAF && key[pos] === k[0]) {
        const len = Math.min(keyLength - pos, k.length);
        let offset = 1;
        while (offset < len && key[pos + offset] === k[offset])
          ++offset;
        const child2 = node.get(k);
        if (offset === k.length) {
          node = child2;
        } else {
          const intermediate = /* @__PURE__ */ new Map();
          intermediate.set(k.slice(offset), child2);
          node.set(key.slice(pos, pos + offset), intermediate);
          node.delete(k);
          node = intermediate;
        }
        pos += offset;
        continue outer;
      }
    }
    const child = /* @__PURE__ */ new Map();
    node.set(key.slice(pos), child);
    return child;
  }
  return node;
};
var remove = (tree, key) => {
  const [node, path2] = trackDown(tree, key);
  if (node === void 0) {
    return;
  }
  node.delete(LEAF);
  if (node.size === 0) {
    cleanup(path2);
  } else if (node.size === 1) {
    const [key2, value] = node.entries().next().value;
    merge(path2, key2, value);
  }
};
var cleanup = (path2) => {
  if (path2.length === 0) {
    return;
  }
  const [node, key] = last(path2);
  node.delete(key);
  if (node.size === 0) {
    cleanup(path2.slice(0, -1));
  } else if (node.size === 1) {
    const [key2, value] = node.entries().next().value;
    if (key2 !== LEAF) {
      merge(path2.slice(0, -1), key2, value);
    }
  }
};
var merge = (path2, key, value) => {
  if (path2.length === 0) {
    return;
  }
  const [node, nodeKey] = last(path2);
  node.set(nodeKey + key, value);
  node.delete(nodeKey);
};
var last = (array) => {
  return array[array.length - 1];
};
var OR = "or";
var AND = "and";
var AND_NOT = "and_not";
var MiniSearch = class _MiniSearch {
  /**
   * @param options  Configuration options
   *
   * ### Examples:
   *
   * ```javascript
   * // Create a search engine that indexes the 'title' and 'text' fields of your
   * // documents:
   * const miniSearch = new MiniSearch({ fields: ['title', 'text'] })
   * ```
   *
   * ### ID Field:
   *
   * ```javascript
   * // Your documents are assumed to include a unique 'id' field, but if you want
   * // to use a different field for document identification, you can set the
   * // 'idField' option:
   * const miniSearch = new MiniSearch({ idField: 'key', fields: ['title', 'text'] })
   * ```
   *
   * ### Options and defaults:
   *
   * ```javascript
   * // The full set of options (here with their default value) is:
   * const miniSearch = new MiniSearch({
   *   // idField: field that uniquely identifies a document
   *   idField: 'id',
   *
   *   // extractField: function used to get the value of a field in a document.
   *   // By default, it assumes the document is a flat object with field names as
   *   // property keys and field values as string property values, but custom logic
   *   // can be implemented by setting this option to a custom extractor function.
   *   extractField: (document, fieldName) => document[fieldName],
   *
   *   // tokenize: function used to split fields into individual terms. By
   *   // default, it is also used to tokenize search queries, unless a specific
   *   // `tokenize` search option is supplied. When tokenizing an indexed field,
   *   // the field name is passed as the second argument.
   *   tokenize: (string, _fieldName) => string.split(SPACE_OR_PUNCTUATION),
   *
   *   // processTerm: function used to process each tokenized term before
   *   // indexing. It can be used for stemming and normalization. Return a falsy
   *   // value in order to discard a term. By default, it is also used to process
   *   // search queries, unless a specific `processTerm` option is supplied as a
   *   // search option. When processing a term from a indexed field, the field
   *   // name is passed as the second argument.
   *   processTerm: (term, _fieldName) => term.toLowerCase(),
   *
   *   // searchOptions: default search options, see the `search` method for
   *   // details
   *   searchOptions: undefined,
   *
   *   // fields: document fields to be indexed. Mandatory, but not set by default
   *   fields: undefined
   *
   *   // storeFields: document fields to be stored and returned as part of the
   *   // search results.
   *   storeFields: []
   * })
   * ```
   */
  constructor(options) {
    if ((options === null || options === void 0 ? void 0 : options.fields) == null) {
      throw new Error('MiniSearch: option "fields" must be provided');
    }
    const autoVacuum = options.autoVacuum == null || options.autoVacuum === true ? defaultAutoVacuumOptions : options.autoVacuum;
    this._options = {
      ...defaultOptions,
      ...options,
      autoVacuum,
      searchOptions: { ...defaultSearchOptions, ...options.searchOptions || {} },
      autoSuggestOptions: { ...defaultAutoSuggestOptions, ...options.autoSuggestOptions || {} }
    };
    this._index = new SearchableMap();
    this._documentCount = 0;
    this._documentIds = /* @__PURE__ */ new Map();
    this._idToShortId = /* @__PURE__ */ new Map();
    this._fieldIds = {};
    this._fieldLength = /* @__PURE__ */ new Map();
    this._avgFieldLength = [];
    this._nextId = 0;
    this._storedFields = /* @__PURE__ */ new Map();
    this._dirtCount = 0;
    this._currentVacuum = null;
    this._enqueuedVacuum = null;
    this._enqueuedVacuumConditions = defaultVacuumConditions;
    this.addFields(this._options.fields);
  }
  /**
   * Adds a document to the index
   *
   * @param document  The document to be indexed
   */
  add(document) {
    const { extractField, stringifyField, tokenize: tokenize2, processTerm: processTerm2, fields, idField } = this._options;
    const id = extractField(document, idField);
    if (id == null) {
      throw new Error(`MiniSearch: document does not have ID field "${idField}"`);
    }
    if (this._idToShortId.has(id)) {
      throw new Error(`MiniSearch: duplicate ID ${id}`);
    }
    const shortDocumentId = this.addDocumentId(id);
    this.saveStoredFields(shortDocumentId, document);
    for (const field of fields) {
      const fieldValue = extractField(document, field);
      if (fieldValue == null)
        continue;
      const tokens = tokenize2(stringifyField(fieldValue, field), field);
      const fieldId = this._fieldIds[field];
      const uniqueTerms = new Set(tokens).size;
      this.addFieldLength(shortDocumentId, fieldId, this._documentCount - 1, uniqueTerms);
      for (const term of tokens) {
        const processedTerm = processTerm2(term, field);
        if (Array.isArray(processedTerm)) {
          for (const t of processedTerm) {
            this.addTerm(fieldId, shortDocumentId, t);
          }
        } else if (processedTerm) {
          this.addTerm(fieldId, shortDocumentId, processedTerm);
        }
      }
    }
  }
  /**
   * Adds all the given documents to the index
   *
   * @param documents  An array of documents to be indexed
   */
  addAll(documents) {
    for (const document of documents)
      this.add(document);
  }
  /**
   * Adds all the given documents to the index asynchronously.
   *
   * Returns a promise that resolves (to `undefined`) when the indexing is done.
   * This method is useful when index many documents, to avoid blocking the main
   * thread. The indexing is performed asynchronously and in chunks.
   *
   * @param documents  An array of documents to be indexed
   * @param options  Configuration options
   * @return A promise resolving to `undefined` when the indexing is done
   */
  addAllAsync(documents, options = {}) {
    const { chunkSize = 10 } = options;
    const acc = { chunk: [], promise: Promise.resolve() };
    const { chunk, promise } = documents.reduce(({ chunk: chunk2, promise: promise2 }, document, i) => {
      chunk2.push(document);
      if ((i + 1) % chunkSize === 0) {
        return {
          chunk: [],
          promise: promise2.then(() => new Promise((resolve) => setTimeout(resolve, 0))).then(() => this.addAll(chunk2))
        };
      } else {
        return { chunk: chunk2, promise: promise2 };
      }
    }, acc);
    return promise.then(() => this.addAll(chunk));
  }
  /**
   * Removes the given document from the index.
   *
   * The document to remove must NOT have changed between indexing and removal,
   * otherwise the index will be corrupted.
   *
   * This method requires passing the full document to be removed (not just the
   * ID), and immediately removes the document from the inverted index, allowing
   * memory to be released. A convenient alternative is {@link
   * MiniSearch#discard}, which needs only the document ID, and has the same
   * visible effect, but delays cleaning up the index until the next vacuuming.
   *
   * @param document  The document to be removed
   */
  remove(document) {
    const { tokenize: tokenize2, processTerm: processTerm2, extractField, stringifyField, fields, idField } = this._options;
    const id = extractField(document, idField);
    if (id == null) {
      throw new Error(`MiniSearch: document does not have ID field "${idField}"`);
    }
    const shortId = this._idToShortId.get(id);
    if (shortId == null) {
      throw new Error(`MiniSearch: cannot remove document with ID ${id}: it is not in the index`);
    }
    for (const field of fields) {
      const fieldValue = extractField(document, field);
      if (fieldValue == null)
        continue;
      const tokens = tokenize2(stringifyField(fieldValue, field), field);
      const fieldId = this._fieldIds[field];
      const uniqueTerms = new Set(tokens).size;
      this.removeFieldLength(shortId, fieldId, this._documentCount, uniqueTerms);
      for (const term of tokens) {
        const processedTerm = processTerm2(term, field);
        if (Array.isArray(processedTerm)) {
          for (const t of processedTerm) {
            this.removeTerm(fieldId, shortId, t);
          }
        } else if (processedTerm) {
          this.removeTerm(fieldId, shortId, processedTerm);
        }
      }
    }
    this._storedFields.delete(shortId);
    this._documentIds.delete(shortId);
    this._idToShortId.delete(id);
    this._fieldLength.delete(shortId);
    this._documentCount -= 1;
  }
  /**
   * Removes all the given documents from the index. If called with no arguments,
   * it removes _all_ documents from the index.
   *
   * @param documents  The documents to be removed. If this argument is omitted,
   * all documents are removed. Note that, for removing all documents, it is
   * more efficient to call this method with no arguments than to pass all
   * documents.
   */
  removeAll(documents) {
    if (documents) {
      for (const document of documents)
        this.remove(document);
    } else if (arguments.length > 0) {
      throw new Error("Expected documents to be present. Omit the argument to remove all documents.");
    } else {
      this._index = new SearchableMap();
      this._documentCount = 0;
      this._documentIds = /* @__PURE__ */ new Map();
      this._idToShortId = /* @__PURE__ */ new Map();
      this._fieldLength = /* @__PURE__ */ new Map();
      this._avgFieldLength = [];
      this._storedFields = /* @__PURE__ */ new Map();
      this._nextId = 0;
    }
  }
  /**
   * Discards the document with the given ID, so it won't appear in search results
   *
   * It has the same visible effect of {@link MiniSearch.remove} (both cause the
   * document to stop appearing in searches), but a different effect on the
   * internal data structures:
   *
   *   - {@link MiniSearch#remove} requires passing the full document to be
   *   removed as argument, and removes it from the inverted index immediately.
   *
   *   - {@link MiniSearch#discard} instead only needs the document ID, and
   *   works by marking the current version of the document as discarded, so it
   *   is immediately ignored by searches. This is faster and more convenient
   *   than {@link MiniSearch#remove}, but the index is not immediately
   *   modified. To take care of that, vacuuming is performed after a certain
   *   number of documents are discarded, cleaning up the index and allowing
   *   memory to be released.
   *
   * After discarding a document, it is possible to re-add a new version, and
   * only the new version will appear in searches. In other words, discarding
   * and re-adding a document works exactly like removing and re-adding it. The
   * {@link MiniSearch.replace} method can also be used to replace a document
   * with a new version.
   *
   * #### Details about vacuuming
   *
   * Repetite calls to this method would leave obsolete document references in
   * the index, invisible to searches. Two mechanisms take care of cleaning up:
   * clean up during search, and vacuuming.
   *
   *   - Upon search, whenever a discarded ID is found (and ignored for the
   *   results), references to the discarded document are removed from the
   *   inverted index entries for the search terms. This ensures that subsequent
   *   searches for the same terms do not need to skip these obsolete references
   *   again.
   *
   *   - In addition, vacuuming is performed automatically by default (see the
   *   `autoVacuum` field in {@link Options}) after a certain number of
   *   documents are discarded. Vacuuming traverses all terms in the index,
   *   cleaning up all references to discarded documents. Vacuuming can also be
   *   triggered manually by calling {@link MiniSearch#vacuum}.
   *
   * @param id  The ID of the document to be discarded
   */
  discard(id) {
    const shortId = this._idToShortId.get(id);
    if (shortId == null) {
      throw new Error(`MiniSearch: cannot discard document with ID ${id}: it is not in the index`);
    }
    this._idToShortId.delete(id);
    this._documentIds.delete(shortId);
    this._storedFields.delete(shortId);
    (this._fieldLength.get(shortId) || []).forEach((fieldLength, fieldId) => {
      this.removeFieldLength(shortId, fieldId, this._documentCount, fieldLength);
    });
    this._fieldLength.delete(shortId);
    this._documentCount -= 1;
    this._dirtCount += 1;
    this.maybeAutoVacuum();
  }
  maybeAutoVacuum() {
    if (this._options.autoVacuum === false) {
      return;
    }
    const { minDirtFactor, minDirtCount, batchSize, batchWait } = this._options.autoVacuum;
    this.conditionalVacuum({ batchSize, batchWait }, { minDirtCount, minDirtFactor });
  }
  /**
   * Discards the documents with the given IDs, so they won't appear in search
   * results
   *
   * It is equivalent to calling {@link MiniSearch#discard} for all the given
   * IDs, but with the optimization of triggering at most one automatic
   * vacuuming at the end.
   *
   * Note: to remove all documents from the index, it is faster and more
   * convenient to call {@link MiniSearch.removeAll} with no argument, instead
   * of passing all IDs to this method.
   */
  discardAll(ids) {
    const autoVacuum = this._options.autoVacuum;
    try {
      this._options.autoVacuum = false;
      for (const id of ids) {
        this.discard(id);
      }
    } finally {
      this._options.autoVacuum = autoVacuum;
    }
    this.maybeAutoVacuum();
  }
  /**
   * It replaces an existing document with the given updated version
   *
   * It works by discarding the current version and adding the updated one, so
   * it is functionally equivalent to calling {@link MiniSearch#discard}
   * followed by {@link MiniSearch#add}. The ID of the updated document should
   * be the same as the original one.
   *
   * Since it uses {@link MiniSearch#discard} internally, this method relies on
   * vacuuming to clean up obsolete document references from the index, allowing
   * memory to be released (see {@link MiniSearch#discard}).
   *
   * @param updatedDocument  The updated document to replace the old version
   * with
   */
  replace(updatedDocument) {
    const { idField, extractField } = this._options;
    const id = extractField(updatedDocument, idField);
    this.discard(id);
    this.add(updatedDocument);
  }
  /**
   * Triggers a manual vacuuming, cleaning up references to discarded documents
   * from the inverted index
   *
   * Vacuuming is only useful for applications that use the {@link
   * MiniSearch#discard} or {@link MiniSearch#replace} methods.
   *
   * By default, vacuuming is performed automatically when needed (controlled by
   * the `autoVacuum` field in {@link Options}), so there is usually no need to
   * call this method, unless one wants to make sure to perform vacuuming at a
   * specific moment.
   *
   * Vacuuming traverses all terms in the inverted index in batches, and cleans
   * up references to discarded documents from the posting list, allowing memory
   * to be released.
   *
   * The method takes an optional object as argument with the following keys:
   *
   *   - `batchSize`: the size of each batch (1000 by default)
   *
   *   - `batchWait`: the number of milliseconds to wait between batches (10 by
   *   default)
   *
   * On large indexes, vacuuming could have a non-negligible cost: batching
   * avoids blocking the thread for long, diluting this cost so that it is not
   * negatively affecting the application. Nonetheless, this method should only
   * be called when necessary, and relying on automatic vacuuming is usually
   * better.
   *
   * It returns a promise that resolves (to undefined) when the clean up is
   * completed. If vacuuming is already ongoing at the time this method is
   * called, a new one is enqueued immediately after the ongoing one, and a
   * corresponding promise is returned. However, no more than one vacuuming is
   * enqueued on top of the ongoing one, even if this method is called more
   * times (enqueuing multiple ones would be useless).
   *
   * @param options  Configuration options for the batch size and delay. See
   * {@link VacuumOptions}.
   */
  vacuum(options = {}) {
    return this.conditionalVacuum(options);
  }
  conditionalVacuum(options, conditions) {
    if (this._currentVacuum) {
      this._enqueuedVacuumConditions = this._enqueuedVacuumConditions && conditions;
      if (this._enqueuedVacuum != null) {
        return this._enqueuedVacuum;
      }
      this._enqueuedVacuum = this._currentVacuum.then(() => {
        const conditions2 = this._enqueuedVacuumConditions;
        this._enqueuedVacuumConditions = defaultVacuumConditions;
        return this.performVacuuming(options, conditions2);
      });
      return this._enqueuedVacuum;
    }
    if (this.vacuumConditionsMet(conditions) === false) {
      return Promise.resolve();
    }
    this._currentVacuum = this.performVacuuming(options);
    return this._currentVacuum;
  }
  async performVacuuming(options, conditions) {
    const initialDirtCount = this._dirtCount;
    if (this.vacuumConditionsMet(conditions)) {
      const batchSize = options.batchSize || defaultVacuumOptions.batchSize;
      const batchWait = options.batchWait || defaultVacuumOptions.batchWait;
      let i = 1;
      for (const [term, fieldsData] of this._index) {
        for (const [fieldId, fieldIndex] of fieldsData) {
          for (const [shortId] of fieldIndex) {
            if (this._documentIds.has(shortId)) {
              continue;
            }
            if (fieldIndex.size <= 1) {
              fieldsData.delete(fieldId);
            } else {
              fieldIndex.delete(shortId);
            }
          }
        }
        if (this._index.get(term).size === 0) {
          this._index.delete(term);
        }
        if (i % batchSize === 0) {
          await new Promise((resolve) => setTimeout(resolve, batchWait));
        }
        i += 1;
      }
      this._dirtCount -= initialDirtCount;
    }
    await null;
    this._currentVacuum = this._enqueuedVacuum;
    this._enqueuedVacuum = null;
  }
  vacuumConditionsMet(conditions) {
    if (conditions == null) {
      return true;
    }
    let { minDirtCount, minDirtFactor } = conditions;
    minDirtCount = minDirtCount || defaultAutoVacuumOptions.minDirtCount;
    minDirtFactor = minDirtFactor || defaultAutoVacuumOptions.minDirtFactor;
    return this.dirtCount >= minDirtCount && this.dirtFactor >= minDirtFactor;
  }
  /**
   * Is `true` if a vacuuming operation is ongoing, `false` otherwise
   */
  get isVacuuming() {
    return this._currentVacuum != null;
  }
  /**
   * The number of documents discarded since the most recent vacuuming
   */
  get dirtCount() {
    return this._dirtCount;
  }
  /**
   * A number between 0 and 1 giving an indication about the proportion of
   * documents that are discarded, and can therefore be cleaned up by vacuuming.
   * A value close to 0 means that the index is relatively clean, while a higher
   * value means that the index is relatively dirty, and vacuuming could release
   * memory.
   */
  get dirtFactor() {
    return this._dirtCount / (1 + this._documentCount + this._dirtCount);
  }
  /**
   * Returns `true` if a document with the given ID is present in the index and
   * available for search, `false` otherwise
   *
   * @param id  The document ID
   */
  has(id) {
    return this._idToShortId.has(id);
  }
  /**
   * Returns the stored fields (as configured in the `storeFields` constructor
   * option) for the given document ID. Returns `undefined` if the document is
   * not present in the index.
   *
   * @param id  The document ID
   */
  getStoredFields(id) {
    const shortId = this._idToShortId.get(id);
    if (shortId == null) {
      return void 0;
    }
    return this._storedFields.get(shortId);
  }
  /**
   * Search for documents matching the given search query.
   *
   * The result is a list of scored document IDs matching the query, sorted by
   * descending score, and each including data about which terms were matched and
   * in which fields.
   *
   * ### Basic usage:
   *
   * ```javascript
   * // Search for "zen art motorcycle" with default options: terms have to match
   * // exactly, and individual terms are joined with OR
   * miniSearch.search('zen art motorcycle')
   * // => [ { id: 2, score: 2.77258, match: { ... } }, { id: 4, score: 1.38629, match: { ... } } ]
   * ```
   *
   * ### Restrict search to specific fields:
   *
   * ```javascript
   * // Search only in the 'title' field
   * miniSearch.search('zen', { fields: ['title'] })
   * ```
   *
   * ### Field boosting:
   *
   * ```javascript
   * // Boost a field
   * miniSearch.search('zen', { boost: { title: 2 } })
   * ```
   *
   * ### Prefix search:
   *
   * ```javascript
   * // Search for "moto" with prefix search (it will match documents
   * // containing terms that start with "moto" or "neuro")
   * miniSearch.search('moto neuro', { prefix: true })
   * ```
   *
   * ### Fuzzy search:
   *
   * ```javascript
   * // Search for "ismael" with fuzzy search (it will match documents containing
   * // terms similar to "ismael", with a maximum edit distance of 0.2 term.length
   * // (rounded to nearest integer)
   * miniSearch.search('ismael', { fuzzy: 0.2 })
   * ```
   *
   * ### Combining strategies:
   *
   * ```javascript
   * // Mix of exact match, prefix search, and fuzzy search
   * miniSearch.search('ismael mob', {
   *  prefix: true,
   *  fuzzy: 0.2
   * })
   * ```
   *
   * ### Advanced prefix and fuzzy search:
   *
   * ```javascript
   * // Perform fuzzy and prefix search depending on the search term. Here
   * // performing prefix and fuzzy search only on terms longer than 3 characters
   * miniSearch.search('ismael mob', {
   *  prefix: term => term.length > 3
   *  fuzzy: term => term.length > 3 ? 0.2 : null
   * })
   * ```
   *
   * ### Combine with AND:
   *
   * ```javascript
   * // Combine search terms with AND (to match only documents that contain both
   * // "motorcycle" and "art")
   * miniSearch.search('motorcycle art', { combineWith: 'AND' })
   * ```
   *
   * ### Combine with AND_NOT:
   *
   * There is also an AND_NOT combinator, that finds documents that match the
   * first term, but do not match any of the other terms. This combinator is
   * rarely useful with simple queries, and is meant to be used with advanced
   * query combinations (see later for more details).
   *
   * ### Filtering results:
   *
   * ```javascript
   * // Filter only results in the 'fiction' category (assuming that 'category'
   * // is a stored field)
   * miniSearch.search('motorcycle art', {
   *   filter: (result) => result.category === 'fiction'
   * })
   * ```
   *
   * ### Wildcard query
   *
   * Searching for an empty string (assuming the default tokenizer) returns no
   * results. Sometimes though, one needs to match all documents, like in a
   * "wildcard" search. This is possible by passing the special value
   * {@link MiniSearch.wildcard} as the query:
   *
   * ```javascript
   * // Return search results for all documents
   * miniSearch.search(MiniSearch.wildcard)
   * ```
   *
   * Note that search options such as `filter` and `boostDocument` are still
   * applied, influencing which results are returned, and their order:
   *
   * ```javascript
   * // Return search results for all documents in the 'fiction' category
   * miniSearch.search(MiniSearch.wildcard, {
   *   filter: (result) => result.category === 'fiction'
   * })
   * ```
   *
   * ### Advanced combination of queries:
   *
   * It is possible to combine different subqueries with OR, AND, and AND_NOT,
   * and even with different search options, by passing a query expression
   * tree object as the first argument, instead of a string.
   *
   * ```javascript
   * // Search for documents that contain "zen" and ("motorcycle" or "archery")
   * miniSearch.search({
   *   combineWith: 'AND',
   *   queries: [
   *     'zen',
   *     {
   *       combineWith: 'OR',
   *       queries: ['motorcycle', 'archery']
   *     }
   *   ]
   * })
   *
   * // Search for documents that contain ("apple" or "pear") but not "juice" and
   * // not "tree"
   * miniSearch.search({
   *   combineWith: 'AND_NOT',
   *   queries: [
   *     {
   *       combineWith: 'OR',
   *       queries: ['apple', 'pear']
   *     },
   *     'juice',
   *     'tree'
   *   ]
   * })
   * ```
   *
   * Each node in the expression tree can be either a string, or an object that
   * supports all {@link SearchOptions} fields, plus a `queries` array field for
   * subqueries.
   *
   * Note that, while this can become complicated to do by hand for complex or
   * deeply nested queries, it provides a formalized expression tree API for
   * external libraries that implement a parser for custom query languages.
   *
   * @param query  Search query
   * @param searchOptions  Search options. Each option, if not given, defaults to the corresponding value of `searchOptions` given to the constructor, or to the library default.
   */
  search(query, searchOptions = {}) {
    const { searchOptions: globalSearchOptions } = this._options;
    const searchOptionsWithDefaults = { ...globalSearchOptions, ...searchOptions };
    const rawResults = this.executeQuery(query, searchOptions);
    const results = [];
    for (const [docId, { score, terms, match }] of rawResults) {
      const quality = terms.length || 1;
      const result = {
        id: this._documentIds.get(docId),
        score: score * quality,
        terms: Object.keys(match),
        queryTerms: terms,
        match
      };
      Object.assign(result, this._storedFields.get(docId));
      if (searchOptionsWithDefaults.filter == null || searchOptionsWithDefaults.filter(result)) {
        results.push(result);
      }
    }
    if (query === _MiniSearch.wildcard && searchOptionsWithDefaults.boostDocument == null) {
      return results;
    }
    results.sort(byScore);
    return results;
  }
  /**
   * Provide suggestions for the given search query
   *
   * The result is a list of suggested modified search queries, derived from the
   * given search query, each with a relevance score, sorted by descending score.
   *
   * By default, it uses the same options used for search, except that by
   * default it performs prefix search on the last term of the query, and
   * combine terms with `'AND'` (requiring all query terms to match). Custom
   * options can be passed as a second argument. Defaults can be changed upon
   * calling the {@link MiniSearch} constructor, by passing a
   * `autoSuggestOptions` option.
   *
   * ### Basic usage:
   *
   * ```javascript
   * // Get suggestions for 'neuro':
   * miniSearch.autoSuggest('neuro')
   * // => [ { suggestion: 'neuromancer', terms: [ 'neuromancer' ], score: 0.46240 } ]
   * ```
   *
   * ### Multiple words:
   *
   * ```javascript
   * // Get suggestions for 'zen ar':
   * miniSearch.autoSuggest('zen ar')
   * // => [
   * //  { suggestion: 'zen archery art', terms: [ 'zen', 'archery', 'art' ], score: 1.73332 },
   * //  { suggestion: 'zen art', terms: [ 'zen', 'art' ], score: 1.21313 }
   * // ]
   * ```
   *
   * ### Fuzzy suggestions:
   *
   * ```javascript
   * // Correct spelling mistakes using fuzzy search:
   * miniSearch.autoSuggest('neromancer', { fuzzy: 0.2 })
   * // => [ { suggestion: 'neuromancer', terms: [ 'neuromancer' ], score: 1.03998 } ]
   * ```
   *
   * ### Filtering:
   *
   * ```javascript
   * // Get suggestions for 'zen ar', but only within the 'fiction' category
   * // (assuming that 'category' is a stored field):
   * miniSearch.autoSuggest('zen ar', {
   *   filter: (result) => result.category === 'fiction'
   * })
   * // => [
   * //  { suggestion: 'zen archery art', terms: [ 'zen', 'archery', 'art' ], score: 1.73332 },
   * //  { suggestion: 'zen art', terms: [ 'zen', 'art' ], score: 1.21313 }
   * // ]
   * ```
   *
   * @param queryString  Query string to be expanded into suggestions
   * @param options  Search options. The supported options and default values
   * are the same as for the {@link MiniSearch#search} method, except that by
   * default prefix search is performed on the last term in the query, and terms
   * are combined with `'AND'`.
   * @return  A sorted array of suggestions sorted by relevance score.
   */
  autoSuggest(queryString, options = {}) {
    options = { ...this._options.autoSuggestOptions, ...options };
    const suggestions = /* @__PURE__ */ new Map();
    for (const { score, terms } of this.search(queryString, options)) {
      const phrase = terms.join(" ");
      const suggestion = suggestions.get(phrase);
      if (suggestion != null) {
        suggestion.score += score;
        suggestion.count += 1;
      } else {
        suggestions.set(phrase, { score, terms, count: 1 });
      }
    }
    const results = [];
    for (const [suggestion, { score, terms, count }] of suggestions) {
      results.push({ suggestion, terms, score: score / count });
    }
    results.sort(byScore);
    return results;
  }
  /**
   * Total number of documents available to search
   */
  get documentCount() {
    return this._documentCount;
  }
  /**
   * Number of terms in the index
   */
  get termCount() {
    return this._index.size;
  }
  /**
   * Deserializes a JSON index (serialized with `JSON.stringify(miniSearch)`)
   * and instantiates a MiniSearch instance. It should be given the same options
   * originally used when serializing the index.
   *
   * ### Usage:
   *
   * ```javascript
   * // If the index was serialized with:
   * let miniSearch = new MiniSearch({ fields: ['title', 'text'] })
   * miniSearch.addAll(documents)
   *
   * const json = JSON.stringify(miniSearch)
   * // It can later be deserialized like this:
   * miniSearch = MiniSearch.loadJSON(json, { fields: ['title', 'text'] })
   * ```
   *
   * @param json  JSON-serialized index
   * @param options  configuration options, same as the constructor
   * @return An instance of MiniSearch deserialized from the given JSON.
   */
  static loadJSON(json, options) {
    if (options == null) {
      throw new Error("MiniSearch: loadJSON should be given the same options used when serializing the index");
    }
    return this.loadJS(JSON.parse(json), options);
  }
  /**
   * Async equivalent of {@link MiniSearch.loadJSON}
   *
   * This function is an alternative to {@link MiniSearch.loadJSON} that returns
   * a promise, and loads the index in batches, leaving pauses between them to avoid
   * blocking the main thread. It tends to be slower than the synchronous
   * version, but does not block the main thread, so it can be a better choice
   * when deserializing very large indexes.
   *
   * @param json  JSON-serialized index
   * @param options  configuration options, same as the constructor
   * @return A Promise that will resolve to an instance of MiniSearch deserialized from the given JSON.
   */
  static async loadJSONAsync(json, options) {
    if (options == null) {
      throw new Error("MiniSearch: loadJSON should be given the same options used when serializing the index");
    }
    return this.loadJSAsync(JSON.parse(json), options);
  }
  /**
   * Returns the default value of an option. It will throw an error if no option
   * with the given name exists.
   *
   * @param optionName  Name of the option
   * @return The default value of the given option
   *
   * ### Usage:
   *
   * ```javascript
   * // Get default tokenizer
   * MiniSearch.getDefault('tokenize')
   *
   * // Get default term processor
   * MiniSearch.getDefault('processTerm')
   *
   * // Unknown options will throw an error
   * MiniSearch.getDefault('notExisting')
   * // => throws 'MiniSearch: unknown option "notExisting"'
   * ```
   */
  static getDefault(optionName) {
    if (defaultOptions.hasOwnProperty(optionName)) {
      return getOwnProperty(defaultOptions, optionName);
    } else {
      throw new Error(`MiniSearch: unknown option "${optionName}"`);
    }
  }
  /**
   * @ignore
   */
  static loadJS(js, options) {
    const { index, documentIds, fieldLength, storedFields, serializationVersion } = js;
    const miniSearch = this.instantiateMiniSearch(js, options);
    miniSearch._documentIds = objectToNumericMap(documentIds);
    miniSearch._fieldLength = objectToNumericMap(fieldLength);
    miniSearch._storedFields = objectToNumericMap(storedFields);
    for (const [shortId, id] of miniSearch._documentIds) {
      miniSearch._idToShortId.set(id, shortId);
    }
    for (const [term, data] of index) {
      const dataMap = /* @__PURE__ */ new Map();
      for (const fieldId of Object.keys(data)) {
        let indexEntry = data[fieldId];
        if (serializationVersion === 1) {
          indexEntry = indexEntry.ds;
        }
        dataMap.set(parseInt(fieldId, 10), objectToNumericMap(indexEntry));
      }
      miniSearch._index.set(term, dataMap);
    }
    return miniSearch;
  }
  /**
   * @ignore
   */
  static async loadJSAsync(js, options) {
    const { index, documentIds, fieldLength, storedFields, serializationVersion } = js;
    const miniSearch = this.instantiateMiniSearch(js, options);
    miniSearch._documentIds = await objectToNumericMapAsync(documentIds);
    miniSearch._fieldLength = await objectToNumericMapAsync(fieldLength);
    miniSearch._storedFields = await objectToNumericMapAsync(storedFields);
    for (const [shortId, id] of miniSearch._documentIds) {
      miniSearch._idToShortId.set(id, shortId);
    }
    let count = 0;
    for (const [term, data] of index) {
      const dataMap = /* @__PURE__ */ new Map();
      for (const fieldId of Object.keys(data)) {
        let indexEntry = data[fieldId];
        if (serializationVersion === 1) {
          indexEntry = indexEntry.ds;
        }
        dataMap.set(parseInt(fieldId, 10), await objectToNumericMapAsync(indexEntry));
      }
      if (++count % 1e3 === 0)
        await wait(0);
      miniSearch._index.set(term, dataMap);
    }
    return miniSearch;
  }
  /**
   * @ignore
   */
  static instantiateMiniSearch(js, options) {
    const { documentCount, nextId, fieldIds, averageFieldLength, dirtCount, serializationVersion } = js;
    if (serializationVersion !== 1 && serializationVersion !== 2) {
      throw new Error("MiniSearch: cannot deserialize an index created with an incompatible version");
    }
    const miniSearch = new _MiniSearch(options);
    miniSearch._documentCount = documentCount;
    miniSearch._nextId = nextId;
    miniSearch._idToShortId = /* @__PURE__ */ new Map();
    miniSearch._fieldIds = fieldIds;
    miniSearch._avgFieldLength = averageFieldLength;
    miniSearch._dirtCount = dirtCount || 0;
    miniSearch._index = new SearchableMap();
    return miniSearch;
  }
  /**
   * @ignore
   */
  executeQuery(query, searchOptions = {}) {
    if (query === _MiniSearch.wildcard) {
      return this.executeWildcardQuery(searchOptions);
    }
    if (typeof query !== "string") {
      const options2 = { ...searchOptions, ...query, queries: void 0 };
      const results2 = query.queries.map((subquery) => this.executeQuery(subquery, options2));
      return this.combineResults(results2, options2.combineWith);
    }
    const { tokenize: tokenize2, processTerm: processTerm2, searchOptions: globalSearchOptions } = this._options;
    const options = { tokenize: tokenize2, processTerm: processTerm2, ...globalSearchOptions, ...searchOptions };
    const { tokenize: searchTokenize, processTerm: searchProcessTerm } = options;
    const terms = searchTokenize(query).flatMap((term) => searchProcessTerm(term)).filter((term) => !!term);
    const queries = terms.map(termToQuerySpec(options));
    const results = queries.map((query2) => this.executeQuerySpec(query2, options));
    return this.combineResults(results, options.combineWith);
  }
  /**
   * @ignore
   */
  executeQuerySpec(query, searchOptions) {
    const options = { ...this._options.searchOptions, ...searchOptions };
    const boosts = (options.fields || this._options.fields).reduce((boosts2, field) => ({ ...boosts2, [field]: getOwnProperty(options.boost, field) || 1 }), {});
    const { boostDocument, weights, maxFuzzy, bm25: bm25params } = options;
    const { fuzzy: fuzzyWeight, prefix: prefixWeight } = { ...defaultSearchOptions.weights, ...weights };
    const data = this._index.get(query.term);
    const results = this.termResults(query.term, query.term, 1, query.termBoost, data, boosts, boostDocument, bm25params);
    let prefixMatches;
    let fuzzyMatches;
    if (query.prefix) {
      prefixMatches = this._index.atPrefix(query.term);
    }
    if (query.fuzzy) {
      const fuzzy = query.fuzzy === true ? 0.2 : query.fuzzy;
      const maxDistance = fuzzy < 1 ? Math.min(maxFuzzy, Math.round(query.term.length * fuzzy)) : fuzzy;
      if (maxDistance)
        fuzzyMatches = this._index.fuzzyGet(query.term, maxDistance);
    }
    if (prefixMatches) {
      for (const [term, data2] of prefixMatches) {
        const distance = term.length - query.term.length;
        if (!distance) {
          continue;
        }
        fuzzyMatches === null || fuzzyMatches === void 0 ? void 0 : fuzzyMatches.delete(term);
        const weight = prefixWeight * term.length / (term.length + 0.3 * distance);
        this.termResults(query.term, term, weight, query.termBoost, data2, boosts, boostDocument, bm25params, results);
      }
    }
    if (fuzzyMatches) {
      for (const term of fuzzyMatches.keys()) {
        const [data2, distance] = fuzzyMatches.get(term);
        if (!distance) {
          continue;
        }
        const weight = fuzzyWeight * term.length / (term.length + distance);
        this.termResults(query.term, term, weight, query.termBoost, data2, boosts, boostDocument, bm25params, results);
      }
    }
    return results;
  }
  /**
   * @ignore
   */
  executeWildcardQuery(searchOptions) {
    const results = /* @__PURE__ */ new Map();
    const options = { ...this._options.searchOptions, ...searchOptions };
    for (const [shortId, id] of this._documentIds) {
      const score = options.boostDocument ? options.boostDocument(id, "", this._storedFields.get(shortId)) : 1;
      results.set(shortId, {
        score,
        terms: [],
        match: {}
      });
    }
    return results;
  }
  /**
   * @ignore
   */
  combineResults(results, combineWith = OR) {
    if (results.length === 0) {
      return /* @__PURE__ */ new Map();
    }
    const operator = combineWith.toLowerCase();
    const combinator = combinators[operator];
    if (!combinator) {
      throw new Error(`Invalid combination operator: ${combineWith}`);
    }
    return results.reduce(combinator) || /* @__PURE__ */ new Map();
  }
  /**
   * Allows serialization of the index to JSON, to possibly store it and later
   * deserialize it with {@link MiniSearch.loadJSON}.
   *
   * Normally one does not directly call this method, but rather call the
   * standard JavaScript `JSON.stringify()` passing the {@link MiniSearch}
   * instance, and JavaScript will internally call this method. Upon
   * deserialization, one must pass to {@link MiniSearch.loadJSON} the same
   * options used to create the original instance that was serialized.
   *
   * ### Usage:
   *
   * ```javascript
   * // Serialize the index:
   * let miniSearch = new MiniSearch({ fields: ['title', 'text'] })
   * miniSearch.addAll(documents)
   * const json = JSON.stringify(miniSearch)
   *
   * // Later, to deserialize it:
   * miniSearch = MiniSearch.loadJSON(json, { fields: ['title', 'text'] })
   * ```
   *
   * @return A plain-object serializable representation of the search index.
   */
  toJSON() {
    const index = [];
    for (const [term, fieldIndex] of this._index) {
      const data = {};
      for (const [fieldId, freqs] of fieldIndex) {
        data[fieldId] = Object.fromEntries(freqs);
      }
      index.push([term, data]);
    }
    return {
      documentCount: this._documentCount,
      nextId: this._nextId,
      documentIds: Object.fromEntries(this._documentIds),
      fieldIds: this._fieldIds,
      fieldLength: Object.fromEntries(this._fieldLength),
      averageFieldLength: this._avgFieldLength,
      storedFields: Object.fromEntries(this._storedFields),
      dirtCount: this._dirtCount,
      index,
      serializationVersion: 2
    };
  }
  /**
   * @ignore
   */
  termResults(sourceTerm, derivedTerm, termWeight, termBoost, fieldTermData, fieldBoosts, boostDocumentFn, bm25params, results = /* @__PURE__ */ new Map()) {
    if (fieldTermData == null)
      return results;
    for (const field of Object.keys(fieldBoosts)) {
      const fieldBoost = fieldBoosts[field];
      const fieldId = this._fieldIds[field];
      const fieldTermFreqs = fieldTermData.get(fieldId);
      if (fieldTermFreqs == null)
        continue;
      let matchingFields = fieldTermFreqs.size;
      const avgFieldLength = this._avgFieldLength[fieldId];
      for (const docId of fieldTermFreqs.keys()) {
        if (!this._documentIds.has(docId)) {
          this.removeTerm(fieldId, docId, derivedTerm);
          matchingFields -= 1;
          continue;
        }
        const docBoost = boostDocumentFn ? boostDocumentFn(this._documentIds.get(docId), derivedTerm, this._storedFields.get(docId)) : 1;
        if (!docBoost)
          continue;
        const termFreq = fieldTermFreqs.get(docId);
        const fieldLength = this._fieldLength.get(docId)[fieldId];
        const rawScore = calcBM25Score(termFreq, matchingFields, this._documentCount, fieldLength, avgFieldLength, bm25params);
        const weightedScore = termWeight * termBoost * fieldBoost * docBoost * rawScore;
        const result = results.get(docId);
        if (result) {
          result.score += weightedScore;
          assignUniqueTerm(result.terms, sourceTerm);
          const match = getOwnProperty(result.match, derivedTerm);
          if (match) {
            match.push(field);
          } else {
            result.match[derivedTerm] = [field];
          }
        } else {
          results.set(docId, {
            score: weightedScore,
            terms: [sourceTerm],
            match: { [derivedTerm]: [field] }
          });
        }
      }
    }
    return results;
  }
  /**
   * @ignore
   */
  addTerm(fieldId, documentId, term) {
    const indexData = this._index.fetch(term, createMap);
    let fieldIndex = indexData.get(fieldId);
    if (fieldIndex == null) {
      fieldIndex = /* @__PURE__ */ new Map();
      fieldIndex.set(documentId, 1);
      indexData.set(fieldId, fieldIndex);
    } else {
      const docs = fieldIndex.get(documentId);
      fieldIndex.set(documentId, (docs || 0) + 1);
    }
  }
  /**
   * @ignore
   */
  removeTerm(fieldId, documentId, term) {
    if (!this._index.has(term)) {
      this.warnDocumentChanged(documentId, fieldId, term);
      return;
    }
    const indexData = this._index.fetch(term, createMap);
    const fieldIndex = indexData.get(fieldId);
    if (fieldIndex == null || fieldIndex.get(documentId) == null) {
      this.warnDocumentChanged(documentId, fieldId, term);
    } else if (fieldIndex.get(documentId) <= 1) {
      if (fieldIndex.size <= 1) {
        indexData.delete(fieldId);
      } else {
        fieldIndex.delete(documentId);
      }
    } else {
      fieldIndex.set(documentId, fieldIndex.get(documentId) - 1);
    }
    if (this._index.get(term).size === 0) {
      this._index.delete(term);
    }
  }
  /**
   * @ignore
   */
  warnDocumentChanged(shortDocumentId, fieldId, term) {
    for (const fieldName of Object.keys(this._fieldIds)) {
      if (this._fieldIds[fieldName] === fieldId) {
        this._options.logger("warn", `MiniSearch: document with ID ${this._documentIds.get(shortDocumentId)} has changed before removal: term "${term}" was not present in field "${fieldName}". Removing a document after it has changed can corrupt the index!`, "version_conflict");
        return;
      }
    }
  }
  /**
   * @ignore
   */
  addDocumentId(documentId) {
    const shortDocumentId = this._nextId;
    this._idToShortId.set(documentId, shortDocumentId);
    this._documentIds.set(shortDocumentId, documentId);
    this._documentCount += 1;
    this._nextId += 1;
    return shortDocumentId;
  }
  /**
   * @ignore
   */
  addFields(fields) {
    for (let i = 0; i < fields.length; i++) {
      this._fieldIds[fields[i]] = i;
    }
  }
  /**
   * @ignore
   */
  addFieldLength(documentId, fieldId, count, length) {
    let fieldLengths = this._fieldLength.get(documentId);
    if (fieldLengths == null)
      this._fieldLength.set(documentId, fieldLengths = []);
    fieldLengths[fieldId] = length;
    const averageFieldLength = this._avgFieldLength[fieldId] || 0;
    const totalFieldLength = averageFieldLength * count + length;
    this._avgFieldLength[fieldId] = totalFieldLength / (count + 1);
  }
  /**
   * @ignore
   */
  removeFieldLength(documentId, fieldId, count, length) {
    if (count === 1) {
      this._avgFieldLength[fieldId] = 0;
      return;
    }
    const totalFieldLength = this._avgFieldLength[fieldId] * count - length;
    this._avgFieldLength[fieldId] = totalFieldLength / (count - 1);
  }
  /**
   * @ignore
   */
  saveStoredFields(documentId, doc) {
    const { storeFields, extractField } = this._options;
    if (storeFields == null || storeFields.length === 0) {
      return;
    }
    let documentFields = this._storedFields.get(documentId);
    if (documentFields == null)
      this._storedFields.set(documentId, documentFields = {});
    for (const fieldName of storeFields) {
      const fieldValue = extractField(doc, fieldName);
      if (fieldValue !== void 0)
        documentFields[fieldName] = fieldValue;
    }
  }
};
MiniSearch.wildcard = Symbol("*");
var getOwnProperty = (object, property) => Object.prototype.hasOwnProperty.call(object, property) ? object[property] : void 0;
var combinators = {
  [OR]: (a, b) => {
    for (const docId of b.keys()) {
      const existing = a.get(docId);
      if (existing == null) {
        a.set(docId, b.get(docId));
      } else {
        const { score, terms, match } = b.get(docId);
        existing.score = existing.score + score;
        existing.match = Object.assign(existing.match, match);
        assignUniqueTerms(existing.terms, terms);
      }
    }
    return a;
  },
  [AND]: (a, b) => {
    const combined = /* @__PURE__ */ new Map();
    for (const docId of b.keys()) {
      const existing = a.get(docId);
      if (existing == null)
        continue;
      const { score, terms, match } = b.get(docId);
      assignUniqueTerms(existing.terms, terms);
      combined.set(docId, {
        score: existing.score + score,
        terms: existing.terms,
        match: Object.assign(existing.match, match)
      });
    }
    return combined;
  },
  [AND_NOT]: (a, b) => {
    for (const docId of b.keys())
      a.delete(docId);
    return a;
  }
};
var defaultBM25params = { k: 1.2, b: 0.7, d: 0.5 };
var calcBM25Score = (termFreq, matchingCount, totalCount, fieldLength, avgFieldLength, bm25params) => {
  const { k, b, d } = bm25params;
  const invDocFreq = Math.log(1 + (totalCount - matchingCount + 0.5) / (matchingCount + 0.5));
  return invDocFreq * (d + termFreq * (k + 1) / (termFreq + k * (1 - b + b * fieldLength / avgFieldLength)));
};
var termToQuerySpec = (options) => (term, i, terms) => {
  const fuzzy = typeof options.fuzzy === "function" ? options.fuzzy(term, i, terms) : options.fuzzy || false;
  const prefix = typeof options.prefix === "function" ? options.prefix(term, i, terms) : options.prefix === true;
  const termBoost = typeof options.boostTerm === "function" ? options.boostTerm(term, i, terms) : 1;
  return { term, fuzzy, prefix, termBoost };
};
var defaultOptions = {
  idField: "id",
  extractField: (document, fieldName) => document[fieldName],
  stringifyField: (fieldValue, fieldName) => fieldValue.toString(),
  tokenize: (text) => text.split(SPACE_OR_PUNCTUATION),
  processTerm: (term) => term.toLowerCase(),
  fields: void 0,
  searchOptions: void 0,
  storeFields: [],
  logger: (level, message) => {
    if (typeof (console === null || console === void 0 ? void 0 : console[level]) === "function")
      console[level](message);
  },
  autoVacuum: true
};
var defaultSearchOptions = {
  combineWith: OR,
  prefix: false,
  fuzzy: false,
  maxFuzzy: 6,
  boost: {},
  weights: { fuzzy: 0.45, prefix: 0.375 },
  bm25: defaultBM25params
};
var defaultAutoSuggestOptions = {
  combineWith: AND,
  prefix: (term, i, terms) => i === terms.length - 1
};
var defaultVacuumOptions = { batchSize: 1e3, batchWait: 10 };
var defaultVacuumConditions = { minDirtFactor: 0.1, minDirtCount: 20 };
var defaultAutoVacuumOptions = { ...defaultVacuumOptions, ...defaultVacuumConditions };
var assignUniqueTerm = (target, term) => {
  if (!target.includes(term))
    target.push(term);
};
var assignUniqueTerms = (target, source) => {
  for (const term of source) {
    if (!target.includes(term))
      target.push(term);
  }
};
var byScore = ({ score: a }, { score: b }) => b - a;
var createMap = () => /* @__PURE__ */ new Map();
var objectToNumericMap = (object) => {
  const map = /* @__PURE__ */ new Map();
  for (const key of Object.keys(object)) {
    map.set(parseInt(key, 10), object[key]);
  }
  return map;
};
var objectToNumericMapAsync = async (object) => {
  const map = /* @__PURE__ */ new Map();
  let count = 0;
  for (const key of Object.keys(object)) {
    map.set(parseInt(key, 10), object[key]);
    if (++count % 1e3 === 0) {
      await wait(0);
    }
  }
  return map;
};
var wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var SPACE_OR_PUNCTUATION = /[\n\r\p{Z}\p{P}]+/u;

// core/text.mjs
var MIN_TOKEN_LENGTH = 3;
var SHORT_ACRONYMS = /* @__PURE__ */ new Set([
  "ai",
  "ml",
  "ui",
  "ux",
  "qa",
  "pr",
  "hr",
  "it",
  "ci",
  "cd",
  "db",
  "api",
  "sdk",
  "gpu"
]);
function isShortAcronym(raw) {
  const letters = String(raw ?? "").replace(/[^\p{L}]+/gu, "");
  if (letters.length < 2 || letters.length > 3) return false;
  if (letters !== letters.toUpperCase()) return false;
  return SHORT_ACRONYMS.has(letters.toLowerCase());
}
var MIN_STEM_LENGTH = 3;
var MAX_STEM_PASSES = 4;
var RAW_STOP_WORDS = [
  // English service words
  "when",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "why",
  "how",
  "should",
  "would",
  "could",
  "can",
  "will",
  "shall",
  "may",
  "might",
  "must",
  "do",
  "does",
  "did",
  "done",
  "is",
  "am",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "this",
  "that",
  "these",
  "those",
  "there",
  "here",
  "then",
  "than",
  "so",
  "such",
  "just",
  "very",
  "also",
  "about",
  "into",
  "over",
  "under",
  "after",
  "before",
  "between",
  "again",
  "more",
  "most",
  "some",
  "any",
  "all",
  "no",
  "not",
  "only",
  "own",
  "same",
  "too",
  "up",
  "down",
  "out",
  "off",
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "you",
  "your",
  "he",
  "she",
  "it",
  "they",
  "them",
  "their",
  "its",
  "and",
  "or",
  "but",
  "if",
  "because",
  "as",
  "at",
  "by",
  "from",
  "in",
  "of",
  "on",
  "to",
  "with",
  "without",
  "next",
  "new",
  "using",
  "use",
  // short English list kept from M5/M6 (a subset check: a, an, the, for …)
  "a",
  "an",
  "the",
  "for",
  // Russian service words (M7 standard list)
  "\u043A\u043E\u0433\u0434\u0430",
  "\u0447\u0442\u043E",
  "\u043A\u0430\u043A\u043E\u0439",
  "\u043A\u0430\u043A\u0438\u0435",
  "\u043A\u0430\u043A",
  "\u043F\u043E\u0447\u0435\u043C\u0443",
  "\u0437\u0430\u0447\u0435\u043C",
  "\u0433\u0434\u0435",
  "\u043A\u0442\u043E",
  "\u0447\u0442\u043E\u0431\u044B",
  "\u0435\u0441\u043B\u0438",
  "\u0438\u043B\u0438",
  "\u043D\u043E",
  "\u0430",
  "\u0436\u0435",
  "\u043B\u0438",
  "\u0431\u044B",
  "\u0434\u043B\u044F",
  "\u043F\u0440\u0438",
  "\u0431\u0435\u0437",
  "\u043F\u043E\u0434",
  "\u043D\u0430\u0434",
  "\u043F\u0440\u043E",
  "\u0447\u0435\u0440\u0435\u0437",
  "\u043C\u0435\u0436\u0434\u0443",
  "\u043F\u043E\u0441\u043B\u0435",
  "\u043F\u0435\u0440\u0435\u0434",
  "\u0442\u0430\u043A\u0436\u0435",
  "\u0443\u0436\u0435",
  "\u0435\u0449\u0435",
  "\u043E\u0447\u0435\u043D\u044C",
  "\u0442\u043E\u043B\u044C\u043A\u043E",
  "\u043D\u0430\u0434\u043E",
  "\u043D\u0443\u0436\u043D\u043E",
  "\u043C\u043E\u0436\u043D\u043E",
  "\u0435\u0441\u0442\u044C",
  "\u0431\u044B\u043B",
  "\u0431\u044B\u043B\u0430",
  "\u0431\u044B\u043B\u043E",
  "\u0431\u044B\u043B\u0438",
  "\u0431\u0443\u0434\u0435\u0442",
  "\u044D\u0442\u043E\u0442",
  "\u044D\u0442\u0430",
  "\u044D\u0442\u043E",
  "\u044D\u0442\u0438",
  "\u0442\u043E\u0442",
  "\u0442\u0430",
  "\u0442\u043E",
  "\u0442\u0435",
  "\u043C\u043E\u0439",
  "\u043C\u043E\u044F",
  "\u043C\u043E\u0451",
  "\u043C\u043E\u0438",
  "\u043D\u0430\u0448",
  "\u043D\u0430\u0448\u0430",
  "\u043D\u0430\u0448\u0435",
  "\u043D\u0430\u0448\u0438",
  "\u0441\u0432\u043E\u0439",
  "\u0441\u0432\u043E\u044F",
  "\u0441\u0432\u043E\u0438",
  "\u0441\u0430\u043C\u044B\u0439",
  // short Russian list kept from M5/M6 (и, в, во, на, по, с, со, к, о, об,
  // от, до, за, из, не) — none of them is in the M7 list above
  "\u0438",
  "\u0432",
  "\u0432\u043E",
  "\u043D\u0430",
  "\u043F\u043E",
  "\u0441",
  "\u0441\u043E",
  "\u043A",
  "\u043E",
  "\u043E\u0431",
  "\u043E\u0442",
  "\u0434\u043E",
  "\u0437\u0430",
  "\u0438\u0437",
  "\u043D\u0435",
  // v0.2 request verbs (owner-approved 26.10.2026): words that only ASK for
  // an action carry no topic — «запусти посмотри попробуй» must prove nothing.
  // SUBJECT verbs stay significant on purpose: проверь/проверить/проверка,
  // аудит, review (they correlate with the topic and already work).
  // "можно"/"нужно"/"надо"/"бы"/"еще" are already listed above (M7).
  "\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C",
  "\u0437\u0430\u043F\u0443\u0441\u0442\u0438",
  "\u0437\u0430\u043F\u0443\u0441\u043A\u0430\u0439",
  "\u043F\u043E\u0441\u043C\u043E\u0442\u0440\u0435\u0442\u044C",
  "\u043F\u043E\u0441\u043C\u043E\u0442\u0440\u0438",
  "\u043F\u043E\u0441\u043C\u043E\u0442\u0440\u0438\u043C",
  "\u0433\u043B\u044F\u043D\u0443\u0442\u044C",
  "\u0433\u043B\u044F\u043D\u044C",
  "\u043F\u043E\u043F\u0440\u043E\u0431\u043E\u0432\u0430\u0442\u044C",
  "\u043F\u043E\u043F\u0440\u043E\u0431\u0443\u0439",
  "\u043F\u0440\u043E\u0433\u043D\u0430\u0442\u044C",
  "\u043F\u0440\u043E\u0433\u043E\u043D\u0438",
  "\u043F\u0440\u043E\u0433\u043E\u043D\u044F\u0439",
  "\u0441\u0434\u0435\u043B\u0430\u0442\u044C",
  "\u0441\u0434\u0435\u043B\u0430\u0439",
  "\u043F\u043E\u043C\u043E\u0447\u044C",
  "\u043F\u043E\u043C\u043E\u0433\u0438",
  "\u043F\u043E\u0434\u0441\u043A\u0430\u0437\u0430\u0442\u044C",
  "\u043F\u043E\u0434\u0441\u043A\u0430\u0436\u0438",
  "\u043F\u043E\u043A\u0430\u0437\u0430\u0442\u044C",
  "\u043F\u043E\u043A\u0430\u0436\u0438",
  "\u043D\u0430\u0439\u0442\u0438",
  "\u043D\u0430\u0439\u0434\u0438",
  "\u043C\u043E\u0436\u0435\u0448\u044C",
  "\u0434\u0430\u0432\u0430\u0439",
  "\u043F\u043B\u0438\u0437",
  "\u043F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430",
  "\u0445\u043E\u0447\u0443",
  "\u0445\u043E\u0442\u0435\u043B",
  "\u0441\u0430\u043C",
  "\u0441\u0430\u043C\u0430",
  "\u0441\u0430\u043C\u043E"
];
var STOP_WORDS = new Set(RAW_STOP_WORDS.map((w) => normalizeTerm(w)));
var RU_SUFFIXES = [
  "\u0430\u043C\u0438",
  "\u044F\u043C\u0438",
  "\u043E\u0432",
  "\u0435\u0432",
  "\u0438\u0439",
  "\u044B\u0439",
  "\u0430\u044F",
  "\u043E\u0435",
  "\u044B\u0435",
  "\u043E\u0439",
  "\u0435\u0439",
  "\u0430\u043C",
  "\u044F\u043C",
  "\u0430\u0445",
  "\u044F\u0445",
  "\u0438",
  "\u044B",
  "\u0430",
  "\u044F",
  "\u043E",
  "\u0435",
  "\u0443",
  "\u044E"
].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
var EN_SUFFIXES = ["ing", "es", "ed", "s"];
var CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
var CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+/gu;
function isCjkToken(token) {
  return CJK_CHAR_RE.test(String(token ?? ""));
}
var SEGMENTER_CACHE = /* @__PURE__ */ new Map();
function localeForRun(run) {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(run)) return "ja";
  if (/[\p{Script=Hangul}]/u.test(run)) return "ko";
  if (/[\p{Script=Thai}]/u.test(run)) return "th";
  if (/[\p{Script=Lao}]/u.test(run)) return "lo";
  if (/[\p{Script=Khmer}]/u.test(run)) return "km";
  if (/[\p{Script=Myanmar}]/u.test(run)) return "my";
  return "zh";
}
function segmentRun(run) {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return null;
  const locale = localeForRun(run);
  let segmenter = SEGMENTER_CACHE.get(locale);
  if (segmenter === void 0) {
    try {
      segmenter = new Intl.Segmenter(locale, { granularity: "word" });
    } catch {
      segmenter = null;
    }
    SEGMENTER_CACHE.set(locale, segmenter);
  }
  if (segmenter === null) return null;
  try {
    const parts = [];
    for (const { segment } of segmenter.segment(run)) {
      if (segment !== "") parts.push(segment);
    }
    return parts;
  } catch {
    return null;
  }
}
function emitCjkRun(out, run, seen) {
  const emit = (t) => {
    if (t === "" || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  const segments = segmentRun(run);
  if (segments) for (const seg of segments) emit(seg);
  if (run.length === 1) {
    emit(run);
    return;
  }
  for (let i = 0; i + 1 < run.length; i += 1) emit(run.slice(i, i + 2));
}
function pushPlainWords(out, piece) {
  if (piece === "") return;
  for (const t of piece.split(/[^\p{L}\p{N}.]+/u)) {
    if (t !== "" && /[\p{L}\p{N}]/u.test(t)) out.push(t);
  }
}
function tokenize(text) {
  const s = String(text ?? "");
  const out = [];
  const seenCjk = /* @__PURE__ */ new Set();
  let last2 = 0;
  for (const m of s.matchAll(CJK_RUN_RE)) {
    pushPlainWords(out, s.slice(last2, m.index));
    emitCjkRun(out, m[0], seenCjk);
    last2 = m.index + m[0].length;
  }
  pushPlainWords(out, s.slice(last2));
  return out;
}
function normalizeTerm(raw) {
  let t = String(raw ?? "").toLowerCase();
  t = t.replace(/ё/g, "\u0435");
  t = t.replace(/[^\p{L}\p{N}]+/gu, "");
  return t;
}
function cutEnding(term, suffixes) {
  for (const suffix of suffixes) {
    if (term.length > suffix.length && term.endsWith(suffix)) {
      const stem = term.slice(0, term.length - suffix.length);
      if (stem.length >= MIN_STEM_LENGTH) return stem;
    }
  }
  return null;
}
function stemTerm(term) {
  let current = term;
  for (let pass = 0; pass < MAX_STEM_PASSES; pass += 1) {
    const ru = cutEnding(current, RU_SUFFIXES);
    if (ru) {
      current = ru;
      continue;
    }
    const en = cutEnding(current, EN_SUFFIXES);
    if (en) {
      current = en;
      continue;
    }
    break;
  }
  return current;
}
function processTerm(term) {
  const norm = normalizeTerm(term);
  if (norm === "") return null;
  const stem = stemTerm(norm);
  return stem === "" ? null : stem;
}
function significantQueryTokens(text) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const raw of tokenize(text)) {
    const acronym = isShortAcronym(raw);
    const norm = normalizeTerm(raw);
    const cjk = isCjkToken(norm);
    if (cjk) {
      if (norm.length < 2) continue;
    } else {
      if (!acronym && norm.length < MIN_TOKEN_LENGTH) continue;
    }
    if (!acronym && STOP_WORDS.has(norm)) continue;
    const stem = stemTerm(norm);
    if (!cjk && !acronym && stem.length < MIN_TOKEN_LENGTH) continue;
    if (seen.has(stem)) continue;
    seen.add(stem);
    out.push(stem);
  }
  return out;
}

// core/index.mjs
var WHY_LIMIT = 160;
var WHY_TERMS_LIMIT = 6;
var FIELD_BOOST = { name: 3, description: 2, headings: 1, aliases: 1 };
var LEXICON_PATH = fileURLToPath(new URL("./lexicon.ru-en.json", import.meta.url));
var WEAK_KEY = "_weak";
var lexiconCache = null;
function loadLexicon() {
  if (lexiconCache) return lexiconCache;
  let map = /* @__PURE__ */ new Map();
  try {
    const raw = JSON.parse(fs2.readFileSync(LEXICON_PATH, "utf8"));
    const weakKeys = new Set(
      (Array.isArray(raw[WEAK_KEY]) ? raw[WEAK_KEY] : []).filter((k) => typeof k === "string")
    );
    for (const [ru, ens] of Object.entries(raw)) {
      if (ru === WEAK_KEY) continue;
      if (!Array.isArray(ens)) continue;
      const ruKey = processTerm(ru);
      const weak = weakKeys.has(ru);
      for (const en of ens) {
        if (typeof en !== "string" || !en) continue;
        if (ruKey) addUnique(map, ruKey, en.toLowerCase(), weak);
        for (const tok of tokenize(en)) {
          const enKey = processTerm(tok);
          if (!enKey || enKey.length < 3 || STOP_WORDS.has(enKey)) continue;
          addUnique(map, enKey, ru.toLowerCase(), weak);
        }
      }
    }
  } catch {
    map = /* @__PURE__ */ new Map();
  }
  lexiconCache = map;
  return map;
}
function addUnique(map, key, value, weak) {
  const list = map.get(key);
  if (!list) {
    map.set(key, [{ term: value, weak }]);
    return;
  }
  const found = list.find((e) => e.term === value);
  if (!found) list.push({ term: value, weak });
  else if (found.weak && !weak) found.weak = false;
}
function buildAliases(text) {
  const lex = loadLexicon();
  if (lex.size === 0) return { all: "", strong: [] };
  const found = /* @__PURE__ */ new Set();
  const strong = /* @__PURE__ */ new Set();
  for (const raw of tokenize(text)) {
    const key = processTerm(raw);
    if (!key) continue;
    const hit = lex.get(key);
    if (!hit) continue;
    for (const e of hit) {
      found.add(e.term);
      if (e.weak) continue;
      for (const tok of tokenize(e.term)) {
        const stem = processTerm(tok);
        if (stem) strong.add(stem);
      }
    }
  }
  return { all: [...found].join(" "), strong: [...strong] };
}
var hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
var MIN_COVERAGE = 2;
function significantTerms(terms) {
  const out = [];
  for (const raw of terms) {
    const t = String(raw).toLowerCase().trim();
    if (t.length <= 1) continue;
    if (STOP_WORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}
function buildIndex(skills) {
  const index = new MiniSearch({
    fields: ["name", "description", "headings", "aliases"],
    storeFields: ["name", "path", "description", "headings", "cover"],
    tokenize,
    processTerm,
    bm25: { k: 1.2, b: 0.7 }
  });
  const docs = skills.map((s, i) => {
    const text = [s.name, s.description || "", (s.bodyHeadings || []).join(" ")].join(" ");
    const aliases = buildAliases(text);
    const cover = /* @__PURE__ */ new Set();
    for (const raw of tokenize(text)) {
      const t = processTerm(raw);
      if (t) cover.add(t);
    }
    for (const t of aliases.strong) cover.add(t);
    return {
      id: s.path || `skill-${i}`,
      name: s.name,
      path: s.path,
      description: s.description || "",
      headings: Array.isArray(s.bodyHeadings) ? s.bodyHeadings.join(" ") : "",
      aliases: aliases.all,
      cover: [...cover]
    };
  });
  index.addAll(docs);
  return index;
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function nameMatches(name, pattern) {
  const lower = String(name).toLowerCase();
  if (pattern.includes("*")) {
    const rx = new RegExp(`^${escapeRegex(pattern).replace(/\\\*/g, ".*")}$`, "i");
    return rx.test(name);
  }
  return lower === String(pattern).toLowerCase();
}
function makeFilter(restrictTo) {
  return (result) => restrictTo.some((p) => nameMatches(result.name, p));
}
function buildWhy(result) {
  const terms = significantTerms(result.terms || []).slice(0, WHY_TERMS_LIMIT);
  const wanted = new Set(terms);
  const fieldHolds = (text) => {
    if (wanted.size === 0) return false;
    for (const raw of tokenize(text)) {
      const term = processTerm(raw);
      if (term !== null && wanted.has(term)) return true;
    }
    return false;
  };
  const haystacks = [
    ["name", String(result.name || "")],
    ["description", String(result.description || "")],
    ["headings", String(result.headings || "")]
  ];
  const fields = haystacks.filter(([, text]) => fieldHolds(text)).map(([field]) => field);
  let why;
  if (terms.length > 0) {
    why = fields.length ? `matched ${fields.join("+")}: ${terms.join(", ")}` : `matched keywords: ${terms.join(", ")}`;
  } else {
    why = "matched keywords";
  }
  why = why.replace(/\s+/g, " ").trim();
  if (why.length > WHY_LIMIT) why = `${why.slice(0, WHY_LIMIT - 3)}...`;
  return why;
}
function compareResults(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}
function compareByScoreThenPath(a, b) {
  const sa = Number.isFinite(a && a.score) ? a.score : -Infinity;
  const sb = Number.isFinite(b && b.score) ? b.score : -Infinity;
  if (sa !== sb) return sb - sa;
  const pa = String(a && a.path || "");
  const pb = String(b && b.path || "");
  if (pa < pb) return -1;
  if (pa > pb) return 1;
  return 0;
}
function dedupeByName(results) {
  const best = /* @__PURE__ */ new Map();
  for (const r of results) {
    const prev = best.get(r.name);
    if (prev === void 0 || compareByScoreThenPath(r, prev) < 0) best.set(r.name, r);
  }
  const emitted = /* @__PURE__ */ new Set();
  const out = [];
  for (const r of results) {
    if (emitted.has(r.name)) continue;
    emitted.add(r.name);
    out.push(best.get(r.name));
  }
  return out;
}
function selectWinner(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i += 1) {
    if (compareByScoreThenPath(candidates[i], best) < 0) best = candidates[i];
  }
  return best;
}
var BOOST_TRIGGER = /(описан|текст|лендинг|копирайт|продукт)/iu;
var BOOST_ORDER = [
  "promo",
  "copywriting",
  "site-copywriting",
  "app-copywriting",
  "documentation-and-adrs",
  "redpolitika"
];
function expandQuery(query) {
  let expanded = query;
  if (/описан|опиш/iu.test(query)) expanded += " \u0442\u0435\u043A\u0441\u0442";
  if (/продукт/iu.test(query)) expanded += " product";
  return expanded;
}
function boostReorder(hits) {
  if (!Array.isArray(hits)) return [];
  const byName = /* @__PURE__ */ new Map();
  for (const h of hits) if (h && typeof h.name === "string" && !byName.has(h.name)) byName.set(h.name, h);
  const out = [];
  for (const name of BOOST_ORDER) {
    const hit = byName.get(name);
    if (hit) out.push(hit);
  }
  const used = new Set(out.map((h) => h.name));
  for (const h of hits) if (!used.has(h.name)) out.push(h);
  return out;
}
function search(index, query, { limit = 5, restrict_to: restrictTo, boost } = {}) {
  if (typeof query !== "string") return [];
  const q = query.trim();
  if (!q) return [];
  if (!/[\p{L}\p{N}]/u.test(q)) return [];
  const expanded = expandQuery(q);
  const sig = significantQueryTokens(expanded);
  if (sig.length === 0) return [];
  const options = { boost: boost ? { ...boost } : { ...FIELD_BOOST } };
  if (Array.isArray(restrictTo) && restrictTo.length > 0) {
    options.filter = makeFilter(restrictTo);
  }
  const matched = index.search(expanded, options);
  const need = sig.length <= 2 ? 1 : Math.min(MIN_COVERAGE, sig.length);
  const withConfidence = matched.map((r) => {
    const cover = Array.isArray(r.cover) ? new Set(r.cover) : null;
    const match = r.match || null;
    if (!cover && !match) return { result: r, confident: false };
    let count = 0;
    for (const t of sig) {
      const hit = cover ? cover.has(t) : hasOwn(match, t);
      if (hit) count += 1;
      if (count >= need) return { result: r, confident: true };
    }
    return { result: r, confident: false };
  });
  withConfidence.sort((a, b) => {
    if (a.confident !== b.confident) return a.confident ? -1 : 1;
    return compareResults(a.result, b.result);
  });
  const unique = dedupeByName(withConfidence.map((e) => ({ ...e.result, confident: e.confident })));
  const capped = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), unique.length) : unique.length;
  const results = unique.slice(0, capped).map((r) => ({
    name: r.name,
    path: r.path,
    score: r.score,
    why: buildWhy(r),
    description: r.description || "",
    confident: r.confident === true
  }));
  return BOOST_TRIGGER.test(q) ? boostReorder(results) : results;
}

// server/index.mjs
var PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"];
var LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];
var MAX_HEADINGS = 40;
var DEFAULT_MAX_LINES = 150;
var MAX_MAX_LINES = 600;
var DEFAULT_LIMIT = 10;
var MIN_LIMIT = 1;
var MAX_LIMIT = 10;
var serverVersion = "0.0.0";
try {
  serverVersion = JSON.parse(fs3.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || "0.0.0";
} catch {
}
function log(...args) {
  if (process.env.SKILL_MCP_DEBUG ?? process.env.SKILL_ROUTER_DEBUG) process.stderr.write(`${args.join(" ")}
`);
}
var TOOLS = [
  {
    name: "find",
    // v0.6.3 (owner task 27.10.2026, item 3 — find visibility): the Code Mode
    // catalog shows the CHEAPEST line of each namespace (opencode L1/f1: one
    // listing per namespace, cost = round(line.length/4), round-robin inside a
    // 2000-cost budget). The old one-line description put find's listing at
    // cost 115 while outline sat at 76, so the catalog showed `outline`. The
    // description now LEADS with a short first line (the only part the catalog
    // renders — first line, ≤120 chars) and the parameter semantics moved from
    // the inputSchema property descriptions (they inflate every signature by
    // one JSDoc comment per property) into the lines below; types, required,
    // default/minimum/maximum are untouched, so the callable schema keeps its
    // validation fields (and `limit` still renders @default/@minimum/@maximum).
    description: "Call this FIRST when a request may need a skill; returns up to 10 candidates.\nRead the descriptions and choose the skill that matches the user's request \u2014 examples: writing text, landing page, design, code, legal, research. confident:true marks the likely match \u2014 verify it against its description before loading. Load the chosen skill with the skill tool before answering and follow its instructions; if no candidate matches, proceed without a skill.\nLocal full-text search over SKILL.md files (BM25 over name, description and headings). Read-only. Returns {ok, items:[{name,path,score,why,description,confident}], next}. limit: how many results (1-10, default 10). restrict_to: keep only these skill names or glob patterns.\nconfident marks positions covering >= need significant query tokens of the expanded query: need = 1 for a 1-2 token query, need = 2 from 3 tokens on (v0.6.3). v0.4.1: \xAB\u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435\xBB adds \xAB\u0442\u0435\u043A\u0441\u0442\xBB, \xAB\u043F\u0440\u043E\u0434\u0443\u043A\u0442\xBB adds \xABproduct\xBB, domain skills from BOOST_ORDER are boosted to the top of the pool. The hint shows up to 5 candidates, confident first.",
    inputSchema: {
      type: "object",
      properties: {
        // No per-property `description` (v0.6.3): they are what made find the
        // priciest listing line in the Code Mode catalog; the meaning of every
        // parameter is spelled out in the tool description above.
        query: { type: "string" },
        limit: {
          type: "integer",
          minimum: MIN_LIMIT,
          maximum: MAX_LIMIT,
          default: DEFAULT_LIMIT
        },
        restrict_to: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "outline",
    description: "Table of contents of one skill: frontmatter name/description plus headings with 1-based line numbers (max 40 headings, truncated:true on overflow).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name." },
        path: { type: "string", description: "Alternative to name: path to a SKILL.md inside a skill root." }
      },
      additionalProperties: false
    }
  },
  {
    name: "read-section",
    description: "Read one section of a skill body: from the heading line up to the next heading of the same level (max 600 lines, truncated:true on overflow).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name." },
        heading: {
          anyOf: [{ type: "string" }, { type: "integer" }],
          description: "Heading text without '#', or its 1-based number in outline order."
        },
        max_lines: {
          type: "integer",
          minimum: 1,
          maximum: MAX_MAX_LINES,
          default: DEFAULT_MAX_LINES,
          description: `Maximum lines to return (default ${DEFAULT_MAX_LINES}, max ${MAX_MAX_LINES}).`
        }
      },
      required: ["name", "heading"],
      additionalProperties: false
    }
  }
];
var ToolError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
var UnavailableError = class extends Error {
};
var state = null;
function getIndex() {
  if (state) return state;
  let roots;
  try {
    roots = defaultRoots();
  } catch (err) {
    throw new UnavailableError(`\u043A\u0430\u0442\u0430\u043B\u043E\u0433\u0438 \u0441\u043A\u0438\u043B\u043B\u043E\u0432 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B: ${err.message}`);
  }
  if (roots.length === 0) {
    throw new UnavailableError("\u043A\u0430\u0442\u0430\u043B\u043E\u0433\u0438 \u0441\u043A\u0438\u043B\u043B\u043E\u0432 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B: \u043D\u0438 \u043E\u0434\u0438\u043D \u043A\u043E\u0440\u0435\u043D\u044C \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
  }
  const { skills } = discoverSkills(roots);
  const index = buildIndex(skills);
  state = { roots, skills, index };
  log(`index built: ${skills.length} skills from ${roots.length} roots`);
  return state;
}
function resolveByName(st, name) {
  const candidates = st.skills.filter((s) => s.name === name);
  if (candidates.length === 0) return null;
  const hits = search(st.index, name, { limit: MAX_LIMIT }).filter((r) => r.name === name);
  const winner = selectWinner(hits) || selectWinner(candidates);
  return candidates.find((s) => s.path === winner.path) || selectWinner(candidates);
}
function resolveByPath(st, target) {
  let forbidden = false;
  for (const root of st.roots) {
    try {
      const real = resolveSkillPath(target, root);
      const skill = st.skills.find((s) => s.path === real);
      if (skill) return skill;
      throw new ToolError("E_NOT_FOUND", "\u0441\u043A\u0438\u043B\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
    } catch (err) {
      if (err instanceof ToolError) throw err;
      if (err.code === "E_FORBIDDEN") forbidden = true;
    }
  }
  if (forbidden) throw new ToolError("E_FORBIDDEN", "\u043F\u0443\u0442\u044C \u0432\u043D\u0435 \u043A\u0430\u0442\u0430\u043B\u043E\u0433\u043E\u0432 \u0441\u043A\u0438\u043B\u043B\u043E\u0432");
  throw new ToolError("E_NOT_FOUND", "\u0441\u043A\u0438\u043B\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
}
function readSkillFile(st, skill) {
  const real = resolveSkillPath(skill.path, skill.root);
  return fs3.readFileSync(real, "utf8");
}
function invalidInput(message) {
  return { ok: false, error: { code: "E_INVALID_INPUT", message } };
}
function notFound() {
  return { ok: false, error: { code: "E_NOT_FOUND", message: "\u0441\u043A\u0438\u043B\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" } };
}
function toolFind(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return invalidInput("find: \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u044B \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u043C");
  }
  if (typeof args.query !== "string") {
    return invalidInput("find: query \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u0441\u0442\u0440\u043E\u043A\u043E\u0439");
  }
  let limit = DEFAULT_LIMIT;
  if (args.limit !== void 0) {
    if (typeof args.limit !== "number" || !Number.isInteger(args.limit)) {
      return invalidInput("find: limit \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u0446\u0435\u043B\u044B\u043C \u0447\u0438\u0441\u043B\u043E\u043C");
    }
    if (args.limit < MIN_LIMIT || args.limit > MAX_LIMIT) {
      return invalidInput(`find: limit \u0432\u043D\u0435 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D\u0430 ${MIN_LIMIT}-${MAX_LIMIT}`);
    }
    limit = args.limit;
  }
  let restrictTo;
  if (args.restrict_to !== void 0) {
    if (!Array.isArray(args.restrict_to) || args.restrict_to.some((x) => typeof x !== "string")) {
      return invalidInput("find: restrict_to \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043C\u0430\u0441\u0441\u0438\u0432\u043E\u043C \u0441\u0442\u0440\u043E\u043A");
    }
    restrictTo = args.restrict_to;
  }
  if (args.query === "") return { ok: true, items: [], note: "\u043F\u0443\u0441\u0442\u043E\u0439 \u0437\u0430\u043F\u0440\u043E\u0441" };
  const st = getIndex();
  const items = search(st.index, args.query, { limit, restrict_to: restrictTo });
  if (items.length === 0) return { ok: true, items: [], note: "\u043D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E" };
  const first = items[0];
  const next = first && first.confident === true ? `likely match: ${first.name} \u2014 verify its description and load it` : "review the candidate descriptions; load the matching skill";
  if (!items.some((it) => it && it.confident === true)) {
    return { ok: true, items, note: "\u0443\u0432\u0435\u0440\u0435\u043D\u043D\u044B\u0445 \u043D\u0435\u0442, \u0432\u043E\u0442 \u0432\u043E\u0437\u043C\u043E\u0436\u043D\u044B\u0435", next };
  }
  return { ok: true, items, next };
}
function toolOutline(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return invalidInput("outline: \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u044B \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u043C");
  }
  if (args.name !== void 0 && typeof args.name !== "string") {
    return invalidInput("outline: name \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u0441\u0442\u0440\u043E\u043A\u043E\u0439");
  }
  if (args.path !== void 0 && typeof args.path !== "string") {
    return invalidInput("outline: path \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u0441\u0442\u0440\u043E\u043A\u043E\u0439");
  }
  const hasName = typeof args.name === "string" && args.name.trim() !== "";
  const hasPath = typeof args.path === "string" && args.path.trim() !== "";
  if (!hasName && !hasPath) {
    return invalidInput("outline: \u0442\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044F name \u0438\u043B\u0438 path");
  }
  const st = getIndex();
  const skill = hasName ? resolveByName(st, args.name.trim()) : resolveByPath(st, args.path.trim());
  if (!skill) return notFound();
  const text = readSkillFile(st, skill);
  const fm = parseFrontmatter(text);
  const entries = extractHeadingEntries(text);
  const overflow = entries.length > MAX_HEADINGS;
  const headings = entries.slice(0, MAX_HEADINGS).map((e) => ({ level: e.level, text: e.text, line: e.line }));
  const description = String(fm.data.description || "").split(/\r?\n/).map((s) => s.trim()).find((s) => s !== "") || "";
  const out = {
    ok: true,
    name: skill.name,
    path: skill.path,
    description,
    headings
  };
  if (overflow) out.truncated = true;
  return out;
}
function toolReadSection(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return invalidInput("read-section: \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u044B \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u043C");
  }
  if (typeof args.name !== "string" || args.name.trim() === "") {
    return invalidInput("read-section: name \u043E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u0435\u043D \u0438 \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u0441\u0442\u0440\u043E\u043A\u043E\u0439");
  }
  const h = args.heading;
  if (h === void 0 || h === null) {
    return invalidInput("read-section: heading \u043E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u0435\u043D");
  }
  if (typeof h !== "string" && typeof h !== "number") {
    return invalidInput("read-section: heading \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u0441\u0442\u0440\u043E\u043A\u043E\u0439 \u0438\u043B\u0438 \u0446\u0435\u043B\u044B\u043C \u0447\u0438\u0441\u043B\u043E\u043C");
  }
  if (typeof h === "number" && !Number.isInteger(h)) {
    return invalidInput("read-section: heading-\u043D\u043E\u043C\u0435\u0440 \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u0446\u0435\u043B\u044B\u043C \u0447\u0438\u0441\u043B\u043E\u043C");
  }
  let maxLines = DEFAULT_MAX_LINES;
  if (args.max_lines !== void 0) {
    if (typeof args.max_lines !== "number" || !Number.isInteger(args.max_lines)) {
      return invalidInput("read-section: max_lines \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u0446\u0435\u043B\u044B\u043C \u0447\u0438\u0441\u043B\u043E\u043C");
    }
    if (args.max_lines < 1 || args.max_lines > MAX_MAX_LINES) {
      return invalidInput(`read-section: max_lines \u0432\u043D\u0435 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D\u0430 1-${MAX_MAX_LINES}`);
    }
    maxLines = args.max_lines;
  }
  const st = getIndex();
  const skill = resolveByName(st, args.name.trim());
  if (!skill) return notFound();
  const text = readSkillFile(st, skill);
  const entries = extractHeadingEntries(text);
  const sectionNotFound = () => ({
    ok: false,
    error: { code: "E_SECTION_NOT_FOUND", message: "\u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" }
  });
  let idx = -1;
  if (typeof h === "number") {
    if (h < 1 || h > entries.length) return sectionNotFound();
    idx = h - 1;
  } else {
    const want = h.trim().replace(/^#+\s*/, "").trim();
    if (want === "") return invalidInput("read-section: heading \u043F\u0443\u0441\u0442");
    idx = entries.findIndex((e) => e.text === want);
    if (idx < 0 && /^\d+$/.test(want)) {
      const n = Number(want);
      if (n >= 1 && n <= entries.length) idx = n - 1;
    }
    if (idx < 0) return sectionNotFound();
  }
  const startLine = entries[idx].line;
  let endLine = text.split(/\r?\n/).length;
  for (let i = idx + 1; i < entries.length; i += 1) {
    if (entries[i].level === entries[idx].level) {
      endLine = entries[i].line - 1;
      break;
    }
  }
  const all = text.split(/\r?\n/).slice(startLine - 1, endLine);
  const truncated = all.length > maxLines;
  const lines = truncated ? all.slice(0, maxLines) : all;
  return {
    ok: true,
    name: skill.name,
    heading: entries[idx].text,
    line_start: startLine,
    lines,
    truncated
  };
}
var TOOL_HANDLERS = { find: toolFind, outline: toolOutline, "read-section": toolReadSection };
function handleInitialize(params) {
  const requested = params && typeof params.protocolVersion === "string" ? params.protocolVersion : null;
  const protocolVersion = requested && PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: "skill-mcp", title: "skill-mcp", version: serverVersion },
    instructions: (
      // v0.6.3 (item 3): lead with `find` — the namespace line the Code Mode
      // catalog renders as `- skill-mcp (…)` starts with this text.
      "Read-only search over local SKILL.md files. Start with find (search), then outline (headings) and read-section (one section)."
    )
  };
}
function handleToolsCall(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { error: { code: -32602, message: "Invalid params: params must be an object" } };
  }
  if (typeof params.name !== "string") {
    return { error: { code: -32602, message: "Invalid params: params.name (string) is required" } };
  }
  const name = params.name;
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
  const args = params.arguments === void 0 ? {} : params.arguments;
  let payload;
  try {
    payload = handler(args);
  } catch (err) {
    if (err instanceof UnavailableError) {
      payload = { ok: false, error: { code: "E_UNAVAILABLE", message: err.message } };
    } else if (err instanceof ToolError) {
      payload = { ok: false, error: { code: err.code, message: err.message } };
    } else if (err && (err.code === "E_NOT_FOUND" || err.code === "E_FORBIDDEN")) {
      payload = { ok: false, error: { code: err.code, message: err.message } };
    } else {
      return { error: { code: -32603, message: `Internal error: ${err && err.message ? err.message : String(err)}` } };
    }
  }
  return {
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      isError: payload.ok === false
    }
  };
}
function dispatch(msg) {
  switch (msg.method) {
    case "initialize":
      return { result: handleInitialize(msg.params) };
    case "ping":
      return { result: {} };
    case "tools/list":
      return { result: { tools: TOOLS } };
    case "tools/call":
      return handleToolsCall(msg.params);
    default:
      return { error: { code: -32601, message: "Method not found", data: { method: msg.method } } };
  }
}
function write(msg) {
  try {
    process.stdout.write(`${JSON.stringify(msg)}
`);
  } catch (err) {
    log(`stdout write failed: ${err.message}`);
  }
}
var rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const raw = line.trim();
  if (raw === "") return;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    const id2 = msg && (typeof msg.id === "string" || typeof msg.id === "number") ? msg.id : null;
    write({ jsonrpc: "2.0", id: id2, error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  if (msg.method.startsWith("notifications/")) return;
  if (!Object.prototype.hasOwnProperty.call(msg, "id")) return;
  const id = msg.id;
  if (id === null || typeof id !== "string" && typeof id !== "number") {
    write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  const out = dispatch(msg);
  if (out.error) write({ jsonrpc: "2.0", id, error: out.error });
  else write({ jsonrpc: "2.0", id, result: out.result });
});
rl.on("close", () => log("stdin closed, exiting"));
