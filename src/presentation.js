const SERIF = '"Times New Roman", "SimSun", "Songti SC", "Noto Serif CJK SC", "Cambria Math", serif';
const BOLD_SERIF = '"Times New Roman", "Noto Serif CJK SC", "Songti SC", "Microsoft YaHei", "PingFang SC", serif';
const SANS = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
const MONO = '"Consolas", "Microsoft YaHei", monospace';
const CLOSING = /^[，。；：！？、）》】〕」』…,.!?;:%)\]}]/u;
const OPENING = /[（《【〔「『(\[{]$/u;
const segments = new Intl.Segmenter('zh', { granularity: 'grapheme' });

export function isTranslatable(kind) {
  return kind === undefined || kind === 'text' || kind === 'heading' || kind === 'caption';
}

function area([l, t, r, b]) {
  return (r - l) * (b - t);
}

function overlap([al, at, ar, ab], [bl, bt, br, bb]) {
  return Math.max(0, Math.min(ar, br) - Math.max(al, bl))
    * Math.max(0, Math.min(ab, bb) - Math.max(at, bt));
}

export function pageOverlays(paragraphs, translations, regions) {
  const candidates = paragraphs.filter(p => isTranslatable(p.kind) && translations[p.id]?.trim());
  const protectedBoxes = protectedAreas(paragraphs, regions);
  return candidates.filter(p => {
    const size = area(p.box);
    return !protectedBoxes.some(box => overlap(p.box, box) >= size * .9)
      && !candidates.some(q => q !== p && (area(q.box) > size || (area(q.box) === size && q.id < p.id))
        && overlap(p.box, q.box) > size * .5);
  });
}

function protectedAreas(paragraphs, regions) {
  return [
    ...regions.map(region => region.box),
    ...paragraphs.filter(p => !isTranslatable(p.kind)).map(p => p.box),
  ];
}

function availableBox(source, obstacles) {
  let box = source;
  for (const obstacle of obstacles) {
    if (!overlap(box, obstacle)) continue;
    const [l, t, r, b] = box;
    const [ol, ot, or, ob] = obstacle;
    const pieces = [[l, t, ol, b], [or, t, r, b], [l, t, r, ot], [l, ob, r, b]]
      .filter(([x, y, right, bottom]) => right > x && bottom > y)
      .sort((a, b) => area(b) - area(a));
    if (!pieces.length) return null;
    box = pieces[0];
  }
  return box;
}

function translationUnits(text, paragraph, width, height) {
  const groups = new Map();
  for (const span of paragraph.mathSpans ?? []) {
    if (!span.box) continue;
    const value = paragraph.text.slice(span.start, span.end);
    if (!value.trim()) continue;
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(span);
  }
  const word = /[\p{Script=Latin}\p{Script=Greek}\p{Number}_]/u;
  const matches = [];
  for (const [value, spans] of groups) {
    const positions = [];
    for (let offset = text.indexOf(value); offset >= 0; offset = text.indexOf(value, offset + value.length)) {
      const before = text[offset - 1] ?? '';
      const after = text[offset + value.length] ?? '';
      if (word.test(before) && word.test(value[0])) continue;
      if (word.test(after) && word.test(value.at(-1))) continue;
      positions.push(offset);
    }
    // A repeated symbol may also appear in an acronym or an English term.
    // Use a source crop only when every occurrence can be matched in order.
    if (positions.length !== spans.length) continue;
    positions.forEach((offset, i) => matches.push({ offset, value, span: spans[i] }));
  }
  matches.sort((a, b) => a.offset - b.offset || b.value.length - a.value.length);
  const units = [];
  const addText = value => {
    const tokens = value.match(/\r\n|[\r\n]|[\p{Script=Latin}\p{Script=Greek}\p{Number}_]+(?:[-.'’][\p{Script=Latin}\p{Script=Greek}\p{Number}_]+)*|[^\S\r\n]+|[^\s]/gu);
    if (tokens) units.push(...tokens.map(text => ({ text })));
  };
  let cursor = 0;
  for (const { offset, value, span } of matches) {
    if (offset < cursor) continue;
    addText(text.slice(cursor, offset));
    const [left, top, right, bottom] = pixels(span.box, width, height);
    units.push({
      text: value,
      source: { left, top, width: right - left, height: bottom - top, baseline: span.baseline * height, size: span.size },
    });
    cursor = offset + value.length;
  }
  addText(text.slice(cursor));
  return units;
}

function wrap(ctx, units, width, size) {
  const lines = [];
  let line = [];
  let advance = 0;
  const append = item => { line.push(item); advance += item.advance; };
  const flush = () => {
    while (line.length && !line.at(-1).text.trim()) advance -= line.pop().advance;
    if (line.length) lines.push({ items: line, advance, text: line.map(item => item.text).join('') });
    line = [];
    advance = 0;
  };
  for (const unit of units) {
    if (/^[\r\n]/u.test(unit.text)) {
      flush();
      continue;
    }
    const scale = unit.source ? size / unit.source.size : 1;
    const measured = unit.source ? unit.source.width * scale : ctx.measureText(unit.text).width;
    const items = measured > width && !unit.source
      ? [...segments.segment(unit.text)].map(({ segment }) => ({ text: segment, advance: ctx.measureText(segment).width }))
      : [{ ...unit, advance: measured, scale }];
    for (const item of items) {
      if (line.length && advance + item.advance > width) {
        if (!item.text.trim()) continue;
        if (line.length > 1 && (CLOSING.test(item.text) || OPENING.test(line.at(-1).text))) {
          const moved = line.pop();
          advance -= moved.advance;
          flush();
          append(moved);
        } else {
          flush();
        }
      }
      if (line.length || item.text.trim()) append(item);
    }
  }
  flush();
  return lines;
}

function pixels([l, t, r, b], width, height) {
  return [l * width, t * height, r * width, b * height];
}

function fit(ctx, units, paragraph, width, height) {
  const [left, top, right, bottom] = pixels(paragraph.box, width, height);
  const w = right - left;
  const h = bottom - top;
  const style = paragraph.style ?? {};
  const originalSize = style.size || Math.min(h, paragraph.kind === 'heading' ? 16 : 11);
  const leading = Math.max(1.12, Math.min(1.55, (style.lineHeight || originalSize * 1.22) / originalSize));
  const bold = style.bold || paragraph.kind === 'heading';
  // Chinese translations are far easier to read in a UI sans font; the serif
  // stack (SimSun/Songti) renders thin and faint at overlay sizes.
  const family = style.fontFamily === 'monospace' ? MONO : SANS;
  const format = size => `${style.italic ? 'italic ' : ''}${bold ? '700' : '500'} ${size}px ${family}`;
  const layoutAt = size => {
    ctx.font = format(size);
    const lines = wrap(ctx, units, w, size);
    const metrics = ctx.measureText('国Agα');
    let ascent = metrics.actualBoundingBoxAscent || size * .8;
    let descent = metrics.actualBoundingBoxDescent || size * .2;
    for (const { source } of units) {
      if (!source) continue;
      const scale = size / source.size;
      ascent = Math.max(ascent, (source.baseline - source.top) * scale);
      descent = Math.max(descent, (source.top + source.height - source.baseline) * scale);
    }
    const lineHeight = Math.max(size * leading, ascent + descent);
    return { size, lines, ascent, descent, lineHeight, font: ctx.font };
  };
  const fits = layout => layout.ascent + layout.descent + (layout.lines.length - 1) * layout.lineHeight <= h
    && layout.lines.every(line => line.advance <= w + .01);
  let best = layoutAt(originalSize);
  if (!fits(best)) {
    let lower = .25;
    let upper = originalSize;
    best = layoutAt(lower);
    for (let i = 0; i < 12; i++) {
      const candidate = layoutAt((lower + upper) / 2);
      if (fits(candidate)) {
        lower = candidate.size;
        best = candidate;
      } else {
        upper = candidate.size;
      }
    }
  }
  if (!best.lines.length) return null;
  ctx.font = best.font;
  if (!fits(best)) return null;
  const align = style.align === 'center' ? 'center' : style.align === 'right' ? 'right' : 'left';
  const x = align === 'center' ? (left + right) / 2 : align === 'right' ? right : left;
  const firstBaseline = top + best.ascent
    + (best.lines.length === 1 ? Math.max(0, h - best.ascent - best.descent) / 2 : 0);
  return { ...best, left, top, right, bottom, x, align, firstBaseline };
}

// Both the reading panel and the PDF exporter paint with PDF point coordinates.
// The source canvas is separate so each repaint starts from the untouched page.
export function paintTranslation(canvas, source, dimensions, paragraphs, translations, regions = []) {
  const { width, height } = dimensions;
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0);
  ctx.save();
  ctx.scale(canvas.width / width, canvas.height / height);
  const protectedBoxes = protectedAreas(paragraphs, regions);
  const textLines = [];
  for (const paragraph of pageOverlays(paragraphs, translations, regions)) {
    const nearby = protectedBoxes.filter(box => overlap(paragraph.box, box) > 0);
    const box = availableBox(paragraph.box, nearby);
    if (!box) continue;
    const units = translationUnits(translations[paragraph.id], paragraph, width, height);
    const layout = fit(ctx, units, { ...paragraph, box }, width, height);
    if (!layout) continue;
    ctx.save();
    // A text block can touch the edge of an equation or a table. Mask the source
    // line by line and leave those regions intact, including their descenders.
    for (const obstacle of nearby) {
      const [left, top, right, bottom] = pixels(obstacle, width, height);
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      ctx.rect(left, top, right - left, bottom - top);
      ctx.clip('evenodd');
    }
    ctx.fillStyle = '#fff';
    for (const lineBox of paragraph.lines?.length ? paragraph.lines : [paragraph.box]) {
      const [left, top, right, bottom] = pixels(lineBox, width, height);
      ctx.fillRect(left - .35, top - .28, right - left + .7, bottom - top + .56);
    }
    ctx.fillStyle = '#161616';
    ctx.font = layout.font;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    layout.lines.forEach((line, index) => {
      const y = layout.firstBaseline + index * layout.lineHeight;
      const x = layout.align === 'center' ? layout.x - line.advance / 2 : layout.align === 'right' ? layout.x - line.advance : layout.x;
      let cursor = x;
      for (const item of line.items) {
        if (item.source) {
          const { left, top, width: w, height: h, baseline } = item.source;
          const sx = source.width / width;
          const sy = source.height / height;
          ctx.drawImage(source, left * sx, top * sy, w * sx, h * sy,
            cursor, y + (top - baseline) * item.scale, item.advance, h * item.scale);
        } else if (item.text.trim()) {
          ctx.fillText(item.text, cursor, y);
        }
        cursor += item.advance;
      }
      textLines.push({ text: line.text, x, y, width: line.advance, size: layout.size });
    });
    ctx.restore();
  }
  ctx.restore();
  return textLines;
}
