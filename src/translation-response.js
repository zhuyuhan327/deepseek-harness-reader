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
      return JSON.parse(candidate);
    } catch {}
    try {
      return JSON.parse(sanitizeJson(candidate));
    } catch {}
  }
  return undefined;
}

function valueText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['translation', 'text', 'zh', 'chinese', 'content', 'value']) {
      if (typeof value[key] === 'string') return value[key];
    }
  }
  return '';
}

function unwrapPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  for (const key of ['translations', 'result', 'data', 'paragraphs', 'output']) {
    if (value[key] && typeof value[key] === 'object') return value[key];
  }
  return value;
}

function collectTranslations(parsed, batch) {
  const values = new Map();
  const accept = (key, value) => {
    let id = typeof key === 'number' ? key : Number(String(key ?? '').trim());
    if (!Number.isInteger(id)) {
      const digits = String(key ?? '').match(/\d{1,6}/);
      id = digits ? Number(digits[0]) : NaN;
    }
    if (Number.isInteger(id) && id > 0 && !values.has(id)) values.set(id, valueText(value));
  };
  const addList = list => {
    if (list.every(item => typeof item === 'string')) {
      if (list.length === batch.length) list.forEach((item, index) => accept(batch[index].id, item));
      return;
    }
    for (const item of list) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      accept(item.id ?? item.index ?? item.number ?? item.paragraph ?? item.key, item);
    }
  };
  const root = unwrapPayload(parsed);
  if (Array.isArray(root)) addList(root);
  else if (root && typeof root === 'object') {
    for (const [key, value] of Object.entries(root)) accept(key, value);
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
  const pair = /"(\d{1,6})"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (const match of text.matchAll(pair)) {
    const id = Number(match[1]);
    let value;
    try {
      value = JSON.parse('"' + match[2] + '"');
    } catch {
      continue;
    }
    if (id > 0 && typeof value === 'string' && value.trim() && !values.has(id)) values.set(id, value);
  }
  return values;
}

// Last resort for models that answer with a numbered list instead of JSON.
function lineTranslations(text, finished) {
  const values = new Map();
  const lines = [...text.matchAll(/^[ \t]*(\d{1,6})[ \t]*[.、:：)][ \t]*/gm)];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const id = Number(line[1]);
    const next = lines[index + 1];
    // The final item lacks an end delimiter. Keep its ID for alignment checks.
    const translation = finished || next ? text.slice(line.index + line[0].length, next?.index).trim() : '';
    if (id > 0 && !values.has(id)) values.set(id, translation);
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
  const parsed = parseJson(text);
  let entries;
  if (parsed === undefined) {
    entries = salvagePairs(firstJsonSpan(text));
    if (!entries.size) entries = lineTranslations(text, finished);
  } else {
    entries = collectTranslations(parsed, batch);
  }
  const values = alignTranslations(entries, batch, parsed !== undefined);
  if (finished && allowPlainText && batch.length === 1 && !values.size && !entries.size) {
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

