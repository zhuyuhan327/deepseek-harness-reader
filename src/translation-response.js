export const MAX_TRANSLATION_LENGTH = 12_000;

function sentenceCount(text) {
  const prose = text.replace(/\([^()]*\)|（[^（）]*）/g, '')
    .replace(/\b(?:et\s+al|e\.g|i\.e|figs?|eqs?|secs?|refs?|pp?|vs|cf|no|vol|dr|mr|ms)\.(?=\s*\S)/gi, '')
    .replace(/\b(?:[A-Za-z]\.){2,}(?=\s*\S)|\b[A-Z]\.(?=\s+[A-Z][a-z])/g, '');
  return (prose.match(/[。！？]+|[.!?]+(?=["'”’\])]*(?:\s|$|\p{Script=Han}))/gu) ?? []).length;
}

// A translation that keeps far fewer sentences than the source has almost
// certainly dropped a clause; ask for that paragraph again instead of storing it.
export function looksComplete(source, translated) {
  const src = String(source ?? '').trim();
  const out = String(translated ?? '').trim();
  if (!out) return false;
  // A clipped answer often starts mid-formula ("= 1 e− 4}。…") while its source
  // starts with a word; identical leading symbols are legitimate.
  if (/^[=,;:.)\]}】]/.test(out) && !/^[=,;:.)\]}】]/.test(src)) return false;
  const sentences = sentenceCount(src);
  const target = sentenceCount(out);
  // A concise Chinese answer keeps the source's sentence count even when its
  // character count is well below a quarter of the English text.
  if (sentences >= 2 && target >= Math.max(1, Math.ceil(sentences * 0.6))) return true;
  // Chinese is normally 0.3–0.7× the length of its English source; far less
  // than that means most of the paragraph was dropped.
  if (src.length >= 120 && out.length / src.length < 0.25) return false;
  if (sentences < 3) return true;
  // Formula-heavy paragraphs count periods inside numbers as sentences, so the
  // sentence rule only applies to prose.
  const letters = (src.match(/[A-Za-z]/g) ?? []).length;
  if (letters / src.length <= 0.6 || /[=∈∉⊂⊃≤≥∑∏∫√∞∂∇]/.test(src)) return true;
  return target >= Math.max(1, Math.ceil(sentences * 0.6));
}

export function isRefusal(text) {
  return /^(?:(?:抱歉|对不起|很抱歉)[，,。]|我(?:无法|不能|不会)(?:翻译|完成|处理)|(?:I'm sorry|I (?:cannot|can't) translate)\b)/iu.test(text.trim());
}

function firstJsonSpan(text) {
  const start = text.search(/\{(?=\s*(?:["}]|\d+\s*:))|\[(?=\s*["{[\]])/);
  if (start < 0) return '';
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth++;
    else if (char === close && --depth === 0) return text.slice(start, index + 1);
  }
  return text.slice(start);
}

// Escape raw control characters inside strings and drop trailing commas. Models
// routinely emit both, which turns otherwise usable JSON into a parse error.
function sanitizeJson(text) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        result += char;
        escaped = false;
      } else if (char === '\\') {
        result += char;
        escaped = true;
      } else if (char === '"') {
        result += char;
        inString = false;
      } else if (char === '\n') {
        result += '\\n';
      } else if (char === '\r') {
        result += '\\r';
      } else if (char === '\t') {
        result += '\\t';
      } else {
        result += char;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === ',') {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] === '}' || text[next] === ']') continue;
    } else if (char >= '0' && char <= '9') {
      // Quote bare numeric keys, which some models emit as {1:"..."}.
      let back = result.length - 1;
      while (back >= 0 && /\s/.test(result[back])) back--;
      if (result[back] === '{' || result[back] === ',') {
        let end = index;
        while (end < text.length && text[end] >= '0' && text[end] <= '9') end++;
        let next = end;
        while (next < text.length && /\s/.test(text[next])) next++;
        if (text[next] === ':') {
          result += '"' + text.slice(index, end) + '"';
          index = end - 1;
          continue;
        }
      }
    }
    result += char;
  }
  return result;
}

function jsonCandidates(text) {
  const candidates = [];
  const push = value => {
    const trimmed = value?.trim();
    if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
  };
  push(text);
  for (const block of text.matchAll(/```[a-zA-Z]*\s*([\s\S]*?)```/g)) push(block[1]);
  for (const candidate of [...candidates]) push(firstJsonSpan(candidate));
  return candidates;
}

function parseJson(text) {
  for (const candidate of jsonCandidates(text)) {
    try {
      return { value: JSON.parse(candidate), source: candidate };
    } catch {}
    const repaired = sanitizeJson(candidate);
    try {
      return { value: JSON.parse(repaired), source: repaired };
    } catch {}
  }
  return undefined;
}

const WRAPPERS = ['translations', 'result', 'data', 'paragraphs', 'output'];
const ID_FIELDS = ['id', 'index', 'number', 'paragraph', 'key'];
const VALUE_FIELDS = ['translation', 'text', 'zh', 'chinese', 'content', 'value'];

function valueText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of VALUE_FIELDS) {
      if (typeof value[key] === 'string') return value[key];
    }
  }
  return '';
}

function unwrapPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  for (const key of WRAPPERS) {
    if (value[key] && typeof value[key] === 'object') return value[key];
  }
  return value;
}

function paragraphId(key) {
  if (typeof key === 'number') return Number.isSafeInteger(key) && key > 0 ? key : undefined;
  const match = /^(?:(?:段落|paragraph|id|p)\s*[:#：]?\s*)?(\d+)$/i.exec(String(key ?? '').trim());
  const id = Number(match?.[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function addTranslation(values, key, value) {
  const id = paragraphId(key);
  if (id !== undefined) values.set(id, values.has(id) ? '' : value);
}

// JSON.parse keeps the last duplicate field. Detect duplicate keys in each
// object before accepting an otherwise syntactically valid response.
function duplicateFields(source) {
  const duplicates = new Set();
  const stack = [];
  for (const match of source.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]]/gs)) {
    const token = match[0];
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else {
      const object = stack.at(-1);
      if (!object) continue;
      let next = match.index + token.length;
      while (/\s/.test(source.charAt(next))) next++;
      if (source[next] !== ':') continue;
      const key = JSON.parse(token);
      if (object.has(key)) duplicates.add(key);
      object.add(key);
    }
  }
  return duplicates;
}

function collectTranslations(parsed, batch) {
  const values = new Map();
  const accept = (key, value) => addTranslation(values, key, valueText(value));
  const addRecord = item => {
    const ids = new Set(ID_FIELDS.map(field => paragraphId(item[field])).filter(id => id !== undefined));
    if (ids.size === 1) accept(ids.values().next().value, item);
    else for (const id of ids) values.set(id, '');
  };
  const addList = list => {
    if (list.every(item => typeof item === 'string')) {
      if (list.length === batch.length) list.forEach((item, index) => accept(batch[index].id, item));
      return;
    }
    for (const item of list) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      addRecord(item);
    }
  };
  const root = unwrapPayload(parsed);
  if (Array.isArray(root)) addList(root);
  else if (root && typeof root === 'object') {
    if (ID_FIELDS.some(field => Object.hasOwn(root, field)) && valueText(root)) addRecord(root);
    else for (const [key, value] of Object.entries(root)) accept(key, value);
  }
  return values;
}

function alignTranslations(entries, batch, complete) {
  const ids = new Set(batch.map(paragraph => paragraph.id));
  const keys = [...entries.keys()];
  const positional = complete && entries.size === batch.length && batch.every((_, index) => entries.has(index + 1)) &&
    keys.every(id => !ids.has(id));
  const hasUnexpectedOrdinal = keys.some(id => id <= batch.length && !ids.has(id));
  const values = new Map();
  for (const [key, value] of entries) {
    // An unexpected ordinal makes overlapping keys unsafe when the positional
    // and exact-id interpretations point to different paragraphs.
    if (!positional && hasUnexpectedOrdinal && key <= batch.length && batch[key - 1]?.id !== key) continue;
    const id = positional ? batch[key - 1].id : key;
    const text = value.trim();
    if (ids.has(id) && text && text.length <= MAX_TRANSLATION_LENGTH && !text.includes('\uFFFD')) values.set(id, text);
  }
  return values;
}

// Salvage complete pairs from a truncated object: {"12":"全文","13":"未完
function salvagePairs(text) {
  const values = new Map();
  let source = sanitizeJson(text);
  const wrapper = /^\{\s*"([a-z]+)"\s*:\s*(?=\{)/i.exec(source);
  if (wrapper && WRAPPERS.includes(wrapper[1])) source = source.slice(wrapper[0].length);
  if (!source.startsWith('{')) return values;
  const key = /\s*"([^"\\]+)"\s*:\s*/y;
  const quoted = /"(?:[^"\\]|\\.)*"\s*/ys;
  let cursor = 1;
  while (cursor < source.length) {
    key.lastIndex = cursor;
    const field = key.exec(source);
    if (!field || paragraphId(field[1]) === undefined) break;
    quoted.lastIndex = key.lastIndex;
    const value = quoted.exec(source);
    const delimiter = value && source[quoted.lastIndex];
    if (!value || (delimiter !== undefined && delimiter !== ',' && delimiter !== '}')) {
      // Retain the unfinished key to disambiguate positional numbering.
      addTranslation(values, field[1], '');
      break;
    }
    try { addTranslation(values, field[1], JSON.parse(value[0])); }
    catch { addTranslation(values, field[1], ''); }
    if (delimiter !== ',') break;
    cursor = quoted.lastIndex + 1;
  }
  return values;
}

// Last resort for models that answer with a numbered list instead of JSON.
function lineTranslations(text, finished) {
  const values = new Map();
  const lines = [...text.matchAll(/^[ \t]*(\d+)[ \t]*(?:\.(?!\d)|[、:：)])[ \t]*/gm)];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const next = lines[index + 1];
    // The final item lacks an end delimiter. Keep its ID for alignment checks.
    const translation = finished || next ? text.slice(line.index + line[0].length, next?.index).trim() : '';
    addTranslation(values, line[1], translation);
  }
  return values;
}

/**
 * Read a translation batch response defensively.
 *
 * Accepts fenced or prose-wrapped JSON, nested payloads, arrays, positional
 * numbering, truncated objects and numbered lists. Values are only returned for
 * requested paragraph ids, so a partially usable answer still saves progress.
 */
export function parseTranslations(output, batch, { allowPlainText = false, finished = true } = {}) {
  const text = String(output ?? '').replace(/\r\n?/g, '\n');
  const json = parseJson(text);
  const parsed = json?.value;
  const duplicates = json ? duplicateFields(json.source) : new Set();
  const ambiguous = [...WRAPPERS, ...ID_FIELDS, ...VALUE_FIELDS].some(key => duplicates.has(key));
  let entries;
  if (ambiguous) entries = new Map();
  else if (!json) {
    entries = salvagePairs(firstJsonSpan(text));
    if (!entries.size) entries = lineTranslations(text, finished);
  } else {
    entries = collectTranslations(parsed, batch);
    for (const key of duplicates) {
      const id = paragraphId(key);
      if (entries.has(id)) entries.set(id, '');
    }
  }
  const values = alignTranslations(entries, batch, Boolean(json));
  if (!duplicates.size && finished && allowPlainText && batch.length === 1 && !values.size && !entries.size) {
    let candidate = '';
    if (typeof parsed === 'string') candidate = parsed;
    else if (parsed && !Array.isArray(parsed) && Object.keys(parsed).length === 1) candidate = valueText(parsed);
    else if (parsed === undefined && !/^\s*[{"`]/.test(text) && !firstJsonSpan(text) &&
        (!/^\s*\[/.test(text) || /^\s*\[\s*\d+(?:\s*[,;，–-]\s*\d+)*\s*\]/.test(text))) candidate = text;
    candidate = candidate.trim().replace(/^(?:译文|翻译结果|简体中文译文|(?:以下是|这是)[^\r\n：:]{0,24}(?:译文|翻译(?:结果)?))[：:]\s*/, '');
    if (candidate.length <= MAX_TRANSLATION_LENGTH && !candidate.includes('\uFFFD') && /\p{Script=Han}/u.test(candidate) &&
        !isRefusal(candidate) && !/^(?:无法翻译|好的[，。]|当然[，。])/u.test(candidate)) {
      values.set(batch[0].id, candidate);
    }
  }
  const missing = batch.filter(paragraph => !values.has(paragraph.id)).map(paragraph => paragraph.id);
  return { values, missing };
}

