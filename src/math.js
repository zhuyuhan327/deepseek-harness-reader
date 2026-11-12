import { MAX_TRANSLATION_LENGTH, looksComplete, isRefusal } from './translation-response.js';

const MATH_MARKER = /⟦M+:[^⟦⟧\r\n]*(?:⟧|(?=⟦|[\r\n]|$))/g;
const MATH_LETTERS = String.raw`\p{Script=Greek}\u{1D400}-\u{1D7FF}ℂℋℎℓℒℕℙℚℝℤℵ`;
const VARIABLE = String.raw`[A-Za-z${MATH_LETTERS}]`;
const SCRIPT_CHARS = String.raw`¹²³\u1D2C-\u1D6A\u2070-\u209F`;
const SCRIPT_CHAR = `[${SCRIPT_CHARS}]`;
const INDEX = String.raw`(?:${SCRIPT_CHAR}|[_^](?:\{[^{}\r\n]{1,40}\}|[A-Za-z0-9\p{Script=Greek}]+))`;
const FUNCTION = String.raw`${VARIABLE}[A-Za-z0-9_]{0,24}(?:${INDEX})*\((?:[^()\r\n]|\([^()\r\n]{0,40}\)){1,60}\)`;
const ATOM = String.raw`(?:${FUNCTION}|${VARIABLE}\d*|[A-Z]{2,5}|[−+-]?\d+(?:\.\d+)?(?:[eE][−+-]?\d+)?)(?:${INDEX})*`;
const LEFT_BOUNDARY = String.raw`(?<![A-Za-z0-9_\p{Script=Greek}])`;
const RIGHT_BOUNDARY = String.raw`(?![A-Za-z0-9_\p{Script=Greek}])`;
const OPERATOR = String.raw`(?:[<>!=]=|[=<>≤≥≈≠∼∝∈∉⊆⊂⊃⊇±×÷⋅*/+→↦−|]|(?<=\s)-(?=\s))`;
const INLINE_MATH = [
  MATH_MARKER,
  /\[\s*\d+(?:\s*[,;，–-]\s*\d+)*\s*\]/g,
  /\\\([^\r\n]{1,200}?\\\)/g,
  new RegExp(String.raw`\$${ATOM}(?:\s*${OPERATOR}\s*${ATOM})*\$`, 'gu'),
  new RegExp(String.raw`${LEFT_BOUNDARY}${ATOM}(?:[ \t]*${OPERATOR}[ \t]*${ATOM})+${RIGHT_BOUNDARY}`, 'gu'),
  new RegExp(String.raw`${LEFT_BOUNDARY}(?:${FUNCTION}|${VARIABLE}\d*${INDEX}+|(?<!['’])[B-HJ-Zb-z]\d*)${RIGHT_BOUNDARY}`, 'gu'),
  new RegExp(String.raw`${LEFT_BOUNDARY}[A-Za-z0-9_]*[${MATH_LETTERS}][A-Za-z0-9_${MATH_LETTERS}]*(?:${INDEX})*${RIGHT_BOUNDARY}`, 'gu'),
  /(?<=\b(?:let|denote|matrix|variable|parameter|operator|set|vector)\s+)[aAI](?![A-Za-z0-9_])/gi,
  new RegExp(String.raw`[${MATH_LETTERS}${SCRIPT_CHARS}∀∃¬∈∉⊂⊃⊆⊇≤≥≈≠∑∏∫√∞∂∇∥∪∩×÷±−→←↔⇒⇔]+`, 'gu'),
];

// Keep the exact substring reported by PDF layout and use text heuristics for
// plain fonts and older imports that lack layout metadata.
export function protectMath(text, spans = [], paragraphId = 0) {
  const source = String(text ?? '');
  const ranges = spans.map(({ start, end }) => {
    // A PDF may emit a variable or acronym as several styled runs.
    if (/[A-Za-z0-9_]/.test(source.charAt(start))) {
      while (/[A-Za-z0-9_]/.test(source.charAt(start - 1))) start--;
    }
    if (/[A-Za-z0-9_]/.test(source.charAt(end - 1))) {
      while (/[A-Za-z0-9_]/.test(source.charAt(end))) end++;
    }
    return { start, end };
  });
  const abbreviations = [...source.matchAll(/\b(?:e\.g|i\.e)\./gi)];
  for (const pattern of INLINE_MATH) {
    for (const match of source.matchAll(pattern)) {
      let start = match.index;
      let end = start + match[0].length;
      // A section reference such as S3.5 must remain one identifier. Protecting
      // only S3 makes the restored value look like an altered decimal formula.
      if (/^[A-Za-z]\d+$/.test(match[0])) {
        end += source.slice(end).match(/^(?:\.\d+)+/)?.[0].length ?? 0;
      }
      // In "achieve a >1000× speedup", a is an article, not a variable.
      // Keep the comparator and value protected without forcing an English a
      // into Chinese prose. Explicit mathematical definitions remain intact.
      if (/^a\s+[<>≤≥]\s*\d/i.test(match[0]) &&
          /\b(?:achieve[sd]?|provide[sd]?|show[sn]?|offer[sd]?|yield[sd]?)\s+$/i.test(source.slice(0, start))) {
        start += match[0].match(/^a\s+/i)[0].length;
      }
      if (!abbreviations.some(value => start >= value.index && end <= value.index + value[0].length)) ranges.push({ start, end });
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const { start, end } of ranges) {
    const previous = merged.at(-1);
    const adjacentMath = previous && !/[\[⟦]/.test(source[start]) && !/[\[⟦]/.test(source[previous.start]) &&
      /^[ \t]*$/.test(source.slice(previous.end, start));
    if (previous && (start < previous.end || adjacentMath)) previous.end = Math.max(previous.end, end);
    else merged.push({ start, end });
  }
  let prefix = 'M';
  while (source.includes(`⟦${prefix}:`)) prefix += 'M';
  let cursor = 0;
  let protectedText = '';
  const tokens = merged.map(({ start, end }, index) => {
    const marker = `⟦${prefix}:${paragraphId}:${index}⟧`;
    protectedText += source.slice(cursor, start) + marker;
    cursor = end;
    return { marker, value: source.slice(start, end) };
  });
  return { text: protectedText + source.slice(cursor), tokens };
}

export function restoreMath(text, tokens) {
  let index = 0;
  let valid = true;
  const restored = String(text ?? '').replace(MATH_MARKER, marker => {
    const token = tokens[index++];
    if (marker === token?.marker) return token.value;
    valid = false;
    return marker;
  });
  return valid && index === tokens.length ? restored : null;
}

const MARKER_START = String.raw`(?:⟦|【|［|\[\[?)[ \t]*[MmＭｍ]+[ \t]*[:：]`;
const MARKER_FIELDS = String.raw`[ \t]*[0-9０-９]+[ \t]*[:：][ \t]*[0-9０-９]+(?![0-9０-９:：])`;
const MARKER_END = String.raw`(?:[ \t]*(?:⟧|】|］|\]\]?)|(?=$|[\s\p{Script=Han}\p{P}]))`;
const MARKER_PREFIX = new RegExp(MARKER_START, 'u');
const MARKER_PARTS = /([MmＭｍ]+)\s*[:：]\s*([0-9０-９]+)\s*[:：]\s*([0-9０-９]+)/u;
const escapePattern = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function literalMathPattern(value) {
  const standalone = /^[A-Za-z0-9_\p{Script=Greek}]+$/u.test(value);
  const left = standalone ? String.raw`(?<![A-Za-z0-9_\p{Script=Greek}])` : '';
  const right = standalone ? String.raw`(?![A-Za-z0-9_^\p{Script=Greek}${SCRIPT_CHARS}]|\.\d)`
    : /[0-9]$/.test(value) ? String.raw`(?![0-9]|\.\d)` : '';
  return `${left}${escapePattern(value)}${right}`;
}

// Marker IDs must match the requested order. Already-restored formulas can
// follow the word order of the translation, with the same exact multiplicity.
export function restoreMathTolerant(text, tokens) {
  const input = String(text ?? '');
  const literals = new Set(tokens.map(token => token.value));
  const alternatives = [...literals].sort((a, b) => b.length - a.length).map(literalMathPattern);
  const markers = new Map(tokens.map(token => [token.marker, token]));
  const occurrences = new RegExp([`${MARKER_START}${MARKER_FIELDS}${MARKER_END}`, ...alternatives].join('|'), 'gu');
  const found = [];
  let hasMarkers = false;
  let cursor = 0;
  let restored = '';
  for (const match of input.matchAll(occurrences)) {
    const preceding = input.slice(cursor, match.index);
    if (MARKER_PREFIX.test(preceding)) return null;
    const parts = MARKER_PREFIX.test(match[0]) ? match[0].match(MARKER_PARTS) : null;
    const marker = parts && `⟦${parts[1].normalize('NFKC').toUpperCase()}:${parts[2].normalize('NFKC')}:${parts[3].normalize('NFKC')}⟧`;
    const token = markers.get(marker);
    if (!token && !literals.has(match[0])) return null;
    hasMarkers ||= Boolean(token);
    found.push(token ?? { value: match[0] });
    restored += preceding + (token?.value ?? match[0]);
    cursor = match.index + match[0].length;
  }
  const remaining = input.slice(cursor);
  if (found.length !== tokens.length || MARKER_PREFIX.test(remaining)) return null;
  if (hasMarkers) {
    if (!found.every((token, index) => token.marker ? token.marker === tokens[index].marker : token.value === tokens[index].value)) return null;
  } else {
    const counts = new Map();
    for (const { value } of tokens) counts.set(value, (counts.get(value) ?? 0) + 1);
    for (const { value } of found) {
      if (!counts.get(value)) return null;
      counts.set(value, counts.get(value) - 1);
    }
  }
  return restored + remaining;
}

export function validateTranslation(paragraph, value, tokens) {
  if (typeof value !== 'string' || !value.trim()) return { reason: 'missing' };
  if (value.length > MAX_TRANSLATION_LENGTH || value.includes('\uFFFD') || isRefusal(value)) return { reason: 'invalid' };
  const math = tokens ?? protectMath(paragraph.text, paragraph.mathSpans, paragraph.id).tokens;
  const restored = restoreMathTolerant(value, math);
  if (restored === null) return { reason: 'math' };
  const text = restored.trim();
  if (text.length > MAX_TRANSLATION_LENGTH || text.includes('\uFFFD')) return { reason: 'invalid' };
  if (restored !== value && restoreMathTolerant(text, math) === null) return { reason: 'math' };
  if (!looksComplete(paragraph.text, text)) return { reason: 'incomplete' };
  return { text };
}

export function translationFragments(paragraph) {
  const { text, tokens } = protectMath(paragraph.text, paragraph.mathSpans, paragraph.id);
  const paragraphs = [];
  const sequence = [];
  const addProse = value => {
    const prose = value.trim();
    if (!/[A-Za-z]/.test(prose)) {
      sequence.push(value);
      return;
    }
    const id = paragraphs.length + 1;
    paragraphs.push({ id, text: prose });
    sequence.push(value.slice(0, value.length - value.trimStart().length), id, value.slice(value.trimEnd().length));
  };
  if (tokens.length) {
    let cursor = 0;
    for (const token of tokens) {
      const next = text.indexOf(token.marker, cursor);
      addProse(text.slice(cursor, next));
      sequence.push(token.value);
      cursor = next + token.marker.length;
    }
    addProse(text.slice(cursor));
  } else {
    const segments = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)];
    if (segments.length > 1) for (const { segment } of segments) addProse(segment);
  }
  const prompt = '把 paragraphs 中的各个片段完整翻译为简体中文。context 是原段落，仅用于理解上下文。片段可能是一个句子的局部，只译该片段，勿补充相邻片段、公式或引文。只返回一个 JSON 对象，键为 id，值为该片段的译文。';
  return { paragraphs, sequence, prompt, data: { context: paragraph.text, paragraphs } };
}

export function assembleFragments(paragraph, fragments, values) {
  for (const part of fragments.paragraphs) {
    const value = values.get(part.id);
    if (typeof value !== 'string' || !value.trim()) return { reason: 'missing' };
    if (isRefusal(value)) return { reason: 'invalid' };
    if (!looksComplete(part.text, value)) return { reason: 'incomplete' };
  }
  const text = fragments.sequence.map(part => typeof part === 'number' ? values.get(part).trim() : part).join('');
  return validateTranslation(paragraph, text);
}

