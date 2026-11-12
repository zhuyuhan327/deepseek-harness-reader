/*
 * Classify the extracted text in an academic PDF.
 *
 * Academic PDFs mix prose with material that must keep its original shape:
 * arXiv stamps, author metadata, running heads, page numbers, displayed
 * equations (often split into many one-character runs), table rows and the
 * reference list. Translating those produces garbled overlays that hide the
 * page, so only body text, headings and captions are marked translatable.
 */

export const KIND_SKIP = 'skip';
export const KIND_TEXT = 'text';
export const KIND_CAPTION = 'caption';
export const KIND_HEADING = 'heading';
export const KIND_FORMULA = 'formula';
export const KIND_TABLE = 'table';
export const KIND_FIGURE = 'figure';

export function isTranslatable(kind = KIND_TEXT) {
  return kind === KIND_TEXT || kind === KIND_HEADING || kind === KIND_CAPTION;
}

const ARXIV_STAMP = /\barxiv\s*:\s*\d{4}\.\d{4,5}/i;
const PROCEEDINGS_WATERMARK = /^(?:This (?:CVPR|ICCV|WACV) paper is the Open Access version\b|Except for this watermark, it is identical to the accepted version\b)/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const CAPTION_LABEL = /^(?:fig(?:ure)?|table|exhibit)\.?\s*(?:[A-Z]?\d+(?:[.-]\d+)*|[IVX]+)(?=$|[\s.:)–—-])/i;
const ALGORITHM = /^(?:algorithm|scheme|listing)\s*\d+\s*[:.]/i;
const REFERENCE_HEADING = /^(?:\d+(?:\.\d+)*\.?\s+)?(?:references|bibliography|works cited|参考文献)(?:\s+and notes)?\s*(?:[:.]?\s*$|\[)/i;
const APPENDIX_HEADING = /^(?:appendix|appendices|supplementary|supplemental)\b/i;
const APPENDIX_LETTER = /^[A-H](?:\.\d+)*\.?\s+\p{Lu}\p{L}/u;
const REFERENCE_ENTRY = /^\[\d{1,3}\].*(?:\(\d{4}\)|\b(?:doi|vol\.|pp\.)|https?:\/\/)/i;
const DATE_ONLY = /^(?:\d{1,2}\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}$/i;
const MATH_SYMBOL = /[=+<>^_{}|×÷±≈≤≥≠∑∏∫√∞∂∇∈∉⊂⊃∪∩→←↔⇒⇔∥−\u0370-\u03ff\u2070-\u209f]/g;
const OPTIMIZATION_OPERATOR = /\barg\s*(?:min|max)(?=$|[\sA-Z_([{\p{Script=Greek}])/gu;
const NUMERIC_CELL = /^[+−-]?(?:\d+(?:[.,]\d+)?|\.\d+)(?:%|[eE][+−-]?\d+)?$/;
const EQUATION_TAG = /^\([A-Z]?\d+(?:\.\d+)*[a-z]?\)$/;
const EQUATION_BRACE = /[⏟⏞]|\{+\s*z/u;
const COMPLEXITY_RANGE = /^from O\([A-Za-z0-9²³^/]+\) to O\([A-Za-z0-9²³^/]+\)?$/;
const ABSTRACT_START = /^abstract\b/i;
// Section headings are recognizable without font data: short, no closing period,
// either an outline number/letter plus a capitalised word or a standard section
// name. Formula lines and table headers are rejected by size/format checks.
const OUTLINE_HEADING = /^(\d+(?:\.\d+)*)\.?\s+\p{Lu}/u;
const PROSE_START = /^(?:\d+\.\s+)?(?:where|let|since|when|if|we|our|here|note|then|for|the|this|these|they|first|next|consider|sample|set|repeat|compute)\s/i;
const KEYWORD_HEADING = /^(?:abstract|introduction|related work|background|methods?|methodology|experiments?|(?:experimental )?results|discussion|conclusions?|appendix(?:\s+[A-H])?|acknowledg(?:e)?ments?)\s*[:.]?$/i;
const HEADING_MATH = /[=<>∈∉⊂⊃∑∏∫√∞∂∇σϵθ∥↑↓×]/;

function headingCandidate(text) {
  if (KEYWORD_HEADING.test(text)) return true;
  if (text.length > 100 || /[.!?]$/.test(text) || HEADING_MATH.test(text)) return false;
  const outline = text.match(OUTLINE_HEADING);
  if (!outline && !APPENDIX_LETTER.test(text)) return false;
  if (outline && Number.parseInt(outline[1], 10) > 99) return false;
  const tokens = text.split(/\s+/);
  const acronyms = tokens.filter(token => token.length >= 2 && /^[A-Z0-9]+$/.test(token)).length;
  return !(tokens.length >= 3 && acronyms / tokens.length >= 0.3);
}

function flat(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function normalize(text) {
  return flat(text).toLowerCase().replace(/\d+/g, '#');
}

function readable(text) {
  return /[A-Za-z]{2,}|[\u4e00-\u9fff]/.test(text);
}

function hasProse(text) {
  return (text.match(/[A-Za-z]{3,}/g)?.length ?? 0) >= 4 || /[\u4e00-\u9fff]{4,}/.test(text);
}

function numericRow(text) {
  const tokens = text.split(/\s+/);
  return tokens.length >= 3 && tokens.filter(token => NUMERIC_CELL.test(token)).length / tokens.length >= 2 / 3;
}

function isCaption(text) {
  const label = text.match(CAPTION_LABEL);
  if (!label) return false;
  const remainder = text.slice(label[0].length).trimStart();
  return !remainder || /^[:.)–—-]/.test(remainder);
}

/** Displayed equations, table rows and maths-heavy lines. */
export function looksLikeMath(text) {
  const value = flat(text);
  if (!value || hasProse(value.replace(OPTIMIZATION_OPERATOR, ''))) return false;
  // A run of digits/operators/single letters carries no translatable words.
  if (!/[A-Za-z]{3,}|\p{Script=Han}/u.test(value) && value.length <= 60) return true;
  if (EQUATION_TAG.test(value) || COMPLEXITY_RANGE.test(value) || numericRow(value)) return true;
  if (PROSE_START.test(value)) return false;
  const symbols = value.match(MATH_SYMBOL)?.length ?? 0;
  const tokens = value.split(/\s+/);
  const tiny = tokens.filter(token => token.length <= 2).length / tokens.length;
  const density = symbols / value.length;
  return (symbols >= 2 && density >= 0.08) || (symbols > 0 && (/[=≤≥≈]/.test(value) || tiny > 0.65));
}

/** Legends and axis labels inside figures: short, acronym-heavy, no sentence. */
export function looksLikeLabel(text) {
  const value = flat(text);
  if (!value || value.length > 160) return false;
  if (/[.!?。！？]$/.test(value)) return false;
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return false;
  if (tokens.filter(token => /[a-z]{2,}/.test(token)).length > 1) return false;
  const upper = tokens.filter(token =>
    token.length >= 2 && /[A-Z]/.test(token) && /^[A-Z0-9][A-Z0-9_\-−/↑↓^]*$/.test(token)).length;
  return upper >= 2 && upper / tokens.length >= 0.4;
}

function appendixHeading(text) {
  if (APPENDIX_HEADING.test(text)) return true;
  // A bare "A Title" heading, never a reference entry such as "A. Author, Title...".
  return APPENDIX_LETTER.test(text) && headingCandidate(text)
    && !/[,;]|\(\d{4}\)|\b(?:et al|doi|vol\.|pp\.)\b/i.test(text);
}

function splitAppendixHeading(marker, title) {
  if (!title || marker.page !== title.page || !/^[A-H](?:\.\d+)*\.?$/.test(flat(marker.text))) return false;
  const gap = title.box[0] - marker.box[2];
  const aligned = Math.abs(marker.box[1] - title.box[1]) < 0.01 && gap >= -0.005 && gap < 0.10;
  return aligned && marker.style?.bold && title.style?.bold
    && appendixHeading(`${flat(marker.text)} ${flat(title.text)}`);
}

function marginSide(box) {
  if (box[1] < 0.12) return 'top';
  if (box[3] > 0.90) return 'bottom';
}

function repeatedMarginText(paragraph, text, matches) {
  const side = marginSide(paragraph.box);
  if (!side || !matches || text.length > 120 || /[.!?]$/.test(text)) return false;
  const position = side === 'top' ? 1 : 3;
  const pages = new Set(matches.filter(other => marginSide(other.box) === side
    && Math.abs(paragraph.box[position] - other.box[position]) <= 0.025).map(other => other.page));
  return pages.size >= 3;
}

function pageRegionsByNumber(pageRegions) {
  const byPage = new Map();
  for (const region of pageRegions) {
    if (region.kind !== KIND_FIGURE && region.kind !== KIND_TABLE) continue;
    if (!byPage.has(region.page)) byPage.set(region.page, []);
    byPage.get(region.page).push(region);
  }
  return byPage;
}

function regionKind(box, regions) {
  if (!regions?.length) return;
  const [left, top, right, bottom] = box;
  const area = (right - left) * (bottom - top);
  let bestCoverage = 0.65;
  let best;
  for (const { kind, box: region } of regions) {
    // Displayed-equation bands only guide painting; they must not swallow the
    // prose paragraphs that happen to sit inside their bounding box.
    if (kind === KIND_FORMULA) continue;
    const width = Math.max(0, Math.min(right, region[2]) - Math.max(left, region[0]));
    const height = Math.max(0, Math.min(bottom, region[3]) - Math.max(top, region[1]));
    const coverage = width * height / area;
    if (coverage >= bestCoverage) {
      bestCoverage = coverage;
      best = kind;
    }
  }
  return best;
}

function explainsInlineMath(paragraph, next, regions) {
  if (next?.page !== paragraph.page) return false;
  const leadingMath = next.mathSpans?.some(span => span.start <= 2);
  const trailingVariable = paragraph.mathSpans?.some(span => span.start > 5 && span.end === paragraph.text.length);
  if (!leadingMath && !trailingVariable) return false;
  const size = paragraph.style?.size;
  const nextSize = next.style?.size;
  if (!size || !nextSize || Math.abs(size - nextSize) > size * .12) return false;
  const [, top, right, bottom] = paragraph.box;
  const [left, nextTop] = next.lines?.[0] ?? next.box;
  return left >= right && left - right < 0.12 && Math.abs(nextTop - top) < (bottom - top) * .35
    && readable(next.text) && !looksLikeMath(next.text) && !regionKind(next.box, regions);
}

function runInHeading(paragraph, text, next, regions) {
  const style = paragraph.style;
  const body = next?.style;
  if (!style?.bold || !style.size || next?.page !== paragraph.page || body?.bold || !body?.size
      || !/^[A-Z][^.]{1,84}\.$/.test(text) || !/^[A-Za-z]{2}/.test(next.text)
      || Math.abs(style.size - body.size) > style.size * .12 || style.fontFamily !== body.fontFamily) return false;
  const [, top, right, bottom] = paragraph.box;
  const [left, nextTop] = next.lines?.[0] ?? next.box;
  const gap = left - right;
  return gap >= 0 && gap < .07 && Math.abs(nextTop - top) < (bottom - top) * .28
    && !regionKind(next.lines?.[0] ?? next.box, regions);
}

function equationAnnotation(paragraph, text, index, paragraphs, kinds, bodySize) {
  const size = paragraph.style?.size;
  if (!size || size > bodySize * .82 || text.length > 48 || !/^[A-Za-z]+(?: [A-Za-z]+)+$/.test(text)) return false;
  const [left, top, right, bottom] = paragraph.box;
  const height = bottom - top;
  for (let i = index - 1; i >= Math.max(0, index - 8); i--) {
    const equation = paragraphs[i];
    if (equation.page !== paragraph.page) break;
    if (kinds[i] !== KIND_FORMULA || !EQUATION_BRACE.test(equation.text)) continue;
    const [eqLeft, eqTop, eqRight, eqBottom] = equation.box;
    const gap = top - eqBottom;
    const shared = Math.min(right, eqRight) - Math.max(left, eqLeft);
    if (shared > (right - left) * .5 && top - eqTop > height && gap >= -height * .6 && gap <= height * .8) return true;
  }
  return false;
}

/**
 * @param paragraphs Extracted paragraphs with `page`, `box` and `text`.
 * @param pageRegions Optional figure and table boxes, with their page numbers.
 * @returns One kind per paragraph, in input order.
 */
export function classifyParagraphs(paragraphs, pageRegions = []) {
  const kinds = new Array(paragraphs.length).fill(KIND_SKIP);
  const regions = pageRegionsByNumber(pageRegions);
  const marginText = new Map();
  for (const paragraph of paragraphs) {
    if (!marginSide(paragraph.box)) continue;
    const key = normalize(paragraph.text);
    if (!key) continue;
    if (!marginText.has(key)) marginText.set(key, []);
    marginText.get(key).push(paragraph);
  }

  // Body size per page gives a baseline for "this line is bigger than prose".
  const sizesByPage = new Map();
  for (const paragraph of paragraphs) {
    const size = Number(paragraph.style?.size);
    if (!Number.isFinite(size) || size <= 0 || !hasProse(paragraph.text)) continue;
    if (!sizesByPage.has(paragraph.page)) sizesByPage.set(paragraph.page, []);
    sizesByPage.get(paragraph.page).push(size);
  }
  const bodySize = new Map();
  for (const [page, sizes] of sizesByPage) {
    sizes.sort((a, b) => a - b);
    bodySize.set(page, sizes[Math.floor(sizes.length / 2)]);
  }

  const cover = paragraphs.filter(paragraph => paragraph.page === 1);
  const abstractIndex = cover.findIndex(paragraph => ABSTRACT_START.test(flat(paragraph.text)));
  const titleCandidates = (abstractIndex < 0 ? cover : cover.slice(0, abstractIndex)).filter(paragraph => {
    const text = flat(paragraph.text);
    return paragraph.box[1] >= 0.035 && paragraph.box[1] < 0.30
      && (text.match(/[A-Za-z]{3,}/g)?.length ?? 0) >= 2
      && !/[.!?]$/.test(text) && !ARXIV_STAMP.test(text) && !EMAIL.test(text)
      && !repeatedMarginText(paragraph, text, marginText.get(normalize(text)));
  });
  const title = titleCandidates.find(paragraph => paragraph.style?.size >= (bodySize.get(1) ?? 10) * 1.18)
    ?? (abstractIndex >= 0 ? titleCandidates[0] : undefined);
  const authorRange = new Set(title && abstractIndex >= 0 ? cover.slice(cover.indexOf(title) + 1, abstractIndex) : []);

  let inReferences = false;
  let appendixTitle;
  paragraphs.forEach((paragraph, index) => {
    const text = flat(paragraph.text);
    if (!text || ARXIV_STAMP.test(text) || DATE_ONLY.test(text)) return;
    if (paragraph.page === 1 && paragraph.box[1] < .08 && PROCEEDINGS_WATERMARK.test(text)) return;
    if (REFERENCE_HEADING.test(text)) {
      inReferences = true;
      return;
    }
    if (inReferences) {
      if (appendixHeading(text)) inReferences = false;
      else if (splitAppendixHeading(paragraph, paragraphs[index + 1])) {
        inReferences = false;
        appendixTitle = paragraphs[index + 1];
        return;
      }
      else return;
    }
    const [left, top, right, bottom] = paragraph.box;
    const width = right - left;
    const height = bottom - top;
    if (EMAIL.test(text) || REFERENCE_ENTRY.test(text) || ALGORITHM.test(text)) return;
    // Publication footers (conference/proceedings lines) are page furniture, not body text.
    if (marginSide(paragraph.box) === 'bottom' && text.length <= 140
        && /(proceedings of|conference on|neurips|icml|iclr|cvpr|iccv|eccv|copyright|©|arxiv:|preprint)/i.test(text)) return;
    if ((top < 0.035 || bottom > 0.965) && text.length < 120) return;
    if (repeatedMarginText(paragraph, text, marginText.get(normalize(text)))) return;
    if (isCaption(text)) {
      kinds[index] = KIND_CAPTION;
      return;
    }
    if (authorRange.has(paragraph)) return;
    const onPage = regions.get(paragraph.page);
    const within = regionKind(paragraph.box, onPage);
    if (within || numericRow(text)) {
      kinds[index] = within ?? KIND_TABLE;
      return;
    }
    const base = bodySize.get(paragraph.page) ?? 0;
    if (looksLikeMath(text) || equationAnnotation(paragraph, text, index, paragraphs, kinds, base)) {
      kinds[index] = KIND_FORMULA;
      return;
    }
    if (!readable(text)) return;
    const headingStyle = paragraph.style;
    const biggerThanBody = base > 0 && Number(headingStyle?.size) >= base * 1.15;
    // A section heading can share its line with the following body sentence
    // ("4.1 Implementation Details Datasets for ..."). Only bold, larger, or
    // short candidates keep the heading kind; otherwise the line stays body.
    const runInBody = text.length > 70 && /[.!?]\s+\S/u.test(text);
    const headingLike = !PROSE_START.test(text) && headingCandidate(text) && !runInBody
      && (Boolean(headingStyle?.bold) || biggerThanBody || text.length <= 60);
    if (paragraph === title || paragraph === appendixTitle || headingLike
        || runInHeading(paragraph, text, paragraphs[index + 1], onPage)) {
      kinds[index] = KIND_HEADING;
      return;
    }
    const style = paragraph.style;
    if (style && text.length <= 160 && base > 0 && !PROSE_START.test(text) && !/[.!?。！？]$/.test(text)) {
      const bigger = Number(style.size) >= base * 1.18;
      const boldHead = Boolean(style.bold) && Number(style.size) >= base * 0.98;
      const runInBody = text.length > 70 && /[.!?]\s+\S/u.test(text);
      if ((bigger || boldHead) && !runInBody) {
        kinds[index] = KIND_HEADING;
        return;
      }
    }
    if (looksLikeLabel(text)) {
      kinds[index] = KIND_FIGURE;
      return;
    }
    const narrow = width < 0.09 || (width < 0.14 && height < 0.03);
    const connective = /^where(?: [A-Za-z]\w{0,3}(?:\([a-z0-9]{1,3}\))?)?$/i.test(text)
      && explainsInlineMath(paragraph, paragraphs[index + 1], onPage);
    if (narrow && !hasProse(text) && !connective) return;
    kinds[index] = KIND_TEXT;
  });
  return kinds;
}
