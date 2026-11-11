/*
 * Decide which extracted PDF paragraphs are worth translating.
 *
 * Academic PDFs mix prose with material that must keep its original shape:
 * arXiv stamps, author metadata, running heads, page numbers, displayed
 * equations (often split into many one-character runs), table rows and the
 * reference list. Translating those produces garbled overlays that hide the
 * page, so only body text and figure/table captions are marked translatable.
 */

export const KIND_SKIP = 'skip';
export const KIND_TEXT = 'text';
export const KIND_CAPTION = 'caption';

const ARXIV_STAMP = /\barxiv\s*:\s*\d{4}\.\d{4,5}/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const CAPTION = /^(fig(?:ure)?|table|exhibit)\.?\s*[A-Z]?\d+/i;
const ALGORITHM = /^(algorithm|scheme|listing)\s*\d+/i;
const REFERENCE_HEADING = /^(?:\d+\.?\s*)?(references|bibliography|works cited|参考文献)(?:\s*and notes)?\s*(?:\[|$)/i;
const APPENDIX_HEADING = /^(?:appendix|appendices|supplementary|supplemental)\b/i;
const APPENDIX_LETTER = /^[A-H](?:\.\d+)*\.?\s+[A-Z][A-Za-z]/;
const REFERENCE_ENTRY = /^\[\d{1,3}\]/;
const DATE_ONLY = /^(?:\d{1,2}\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}$/i;
const WORD = /[A-Za-z\u4e00-\u9fff]/;
const MATH_SYMBOL = /[=+<>^_{}|×÷±≈≤≥≠∑∏∫√∞∂∇∈∉⊂⊃∪∩→←↔⇒⇔]/;
const GREEK = /[\u0370-\u03ff]/;
const ABSTRACT_HEADING = /^abstract\b/i;

function flat(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function normalize(text) {
  return flat(text).toLowerCase().replace(/\d+/g, '#');
}

function readable(text) {
  const value = flat(text);
  return value.length > 2 && WORD.test(value);
}

/** Displayed equations, table rows and maths-heavy lines. */
export function looksLikeMath(text) {
  const value = flat(text);
  if (!value) return false;
  const symbols = (value.match(MATH_SYMBOL)?.length ?? 0) + (value.match(GREEK)?.length ?? 0);
  const words = value.match(/[A-Za-z\u4e00-\u9fff]/g)?.length ?? 0;
  const spaces = value.match(/\s/g)?.length ?? 0;
  const tokens = value.split(/\s+/).filter(Boolean);
  const tiny = tokens.filter(token => token.length <= 2).length / Math.max(1, tokens.length);
  const density = symbols / value.length;
  const wordRatio = words / Math.max(1, value.length - spaces);
  if (value.length < 12) return density > 0.15 || wordRatio < 0.5;
  return density > 0.06 || (tokens.length >= 5 && tiny > 0.5) || wordRatio < 0.45;
}

/** Legends and axis labels inside figures: short, acronym-heavy, no sentence. */
export function looksLikeLabel(text) {
  const value = flat(text);
  if (!value || value.length > 160) return false;
  if (/[.!?。！？]$/.test(value)) return false;
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return false;
  const upper = tokens.filter(token =>
    token.length >= 2 && /[A-Z]/.test(token) && /^[A-Z0-9][A-Z0-9_\-−/↑↓^]*$/.test(token)).length;
  return upper >= 2 && upper / tokens.length >= 0.4;
}

function appendixHeading(text) {
  if (APPENDIX_HEADING.test(text)) return true;
  // A bare "A Title" heading, never a reference entry such as "A. Author, Title...".
  return text.length < 90 && !/[.,;]|\(\d{4}\)|\b(?:et al|doi|vol\.|pp\.)\b/i.test(text)
    && APPENDIX_LETTER.test(text);
}

function isReferenceHeading(text) {
  return REFERENCE_HEADING.test(text);
}

/**
 * @param paragraphs Extracted paragraphs with `page`, `box` and `text`.
 * @returns One kind per paragraph: 'text', 'caption' or 'skip'.
 */
export function classifyParagraphs(paragraphs) {
  const kinds = new Array(paragraphs.length).fill(KIND_SKIP);
  const pagesByText = new Map();
  for (const paragraph of paragraphs) {
    const key = normalize(paragraph.text);
    if (!key) continue;
    if (!pagesByText.has(key)) pagesByText.set(key, new Set());
    pagesByText.get(key).add(paragraph.page);
  }

  // Titles, authors and affiliations sit between the title and the abstract.
  const authorRange = new Set();
  const title = paragraphs[0];
  if (title) {
    const cover = paragraphs.filter(paragraph => paragraph.page === title.page);
    const abstract = cover.find(paragraph => ABSTRACT_HEADING.test(flat(paragraph.text)));
    if (abstract) {
      for (const paragraph of cover) {
        if (paragraph.id > title.id && paragraph.id < abstract.id) authorRange.add(paragraph.id);
      }
    }
  }

  let inReferences = false;
  paragraphs.forEach((paragraph, index) => {
    const text = flat(paragraph.text);
    if (!readable(text)) return;
    if (ARXIV_STAMP.test(text)) return;
    if (DATE_ONLY.test(text)) return;
    if (isReferenceHeading(text)) {
      inReferences = true;
      return;
    }
    if (inReferences) {
      if (appendixHeading(text)) inReferences = false;
      else return;
    }
    if (authorRange.has(paragraph.id)) return;
    if (EMAIL.test(text)) return;
    if ((pagesByText.get(normalize(text))?.size ?? 0) >= 3) return;

    const [left, top, right, bottom] = paragraph.box;
    const width = right - left;
    const height = bottom - top;
    if ((top < 0.035 || bottom > 0.965) && text.length < 120) return;
    if (REFERENCE_ENTRY.test(text)) return;
    if (ALGORITHM.test(text)) return;
    if (CAPTION.test(text)) {
      kinds[index] = KIND_CAPTION;
      return;
    }
    // Equation fragments and rotated figure labels keep their original glyphs.
    if (width < 0.14 && height < 0.03) return;
    if (width < 0.09) return;
    if (looksLikeMath(text)) return;
    if (looksLikeLabel(text)) return;
    kinds[index] = KIND_TEXT;
  });
  return kinds;
}
