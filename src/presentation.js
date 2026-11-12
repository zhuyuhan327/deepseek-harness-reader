const CJK_FONTS = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", "DengXian"';
const SANS = `${CJK_FONTS}, sans-serif`;
const MONO = `"Consolas", "Menlo", "DejaVu Sans Mono", ${CJK_FONTS}, monospace`;
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
  const sourceBoxes = paragraph => paragraph.lines?.length ? paragraph.lines : [paragraph.box];
  const covered = (boxes, obstacles, minimum) => boxes.every(box =>
    obstacles.some(obstacle => overlap(box, obstacle) >= area(box) * minimum));
  return candidates.filter(p => {
    const size = area(p.box);
    const boxes = sourceBoxes(p);
    return !covered(boxes, protectedBoxes, .9)
      && !candidates.some(q => q !== p && q.text === p.text && overlap(p.box, q.box) > size * .5
        && (area(q.box) > size || (area(q.box) === size && q.id < p.id)) && covered(boxes, sourceBoxes(q), .9));
  });
}

function protectedAreas(paragraphs, regions) {
  return [
    ...regions.map(region => region.box),
    ...paragraphs.filter(p => !isTranslatable(p.kind)).map(p => p.box),
  ];
}

function availableBoxes(source, obstacles) {
  let boxes = [source];
  for (const obstacle of obstacles) {
    const parts = boxes.flatMap(box => {
      if (!overlap(box, obstacle)) return [box];
      const [l, t, r, b] = box;
      const [ol, ot, or, ob] = obstacle;
      return [[l, t, ol, b], [or, t, r, b], [l, t, r, ot], [l, ob, r, b]].filter(piece => area(piece) > 0);
    });
    boxes = [];
    for (const box of parts.sort((a, b) => area(b) - area(a))) {
      if (boxes.some(previous => overlap(box, previous) >= area(box))) continue;
      boxes.push(box);
      if (boxes.length === 12) break;
    }
    if (!boxes.length) break;
  }
  return boxes;
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
  // 600 selects the bold system face on Windows CJK families with 400 and 700
  // only, while retaining a semibold face on systems that provide one.
  const family = style.fontFamily === 'monospace' ? MONO : SANS;
  const format = size => `${style.italic ? 'italic ' : ''}${bold ? '700' : '600'} ${size}px ${family}`;
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

function placedLines(layout, width, height) {
  return layout.lines.map((line, index) => {
    const y = layout.firstBaseline + index * layout.lineHeight;
    const x = layout.align === 'center' ? layout.x - line.advance / 2 : layout.align === 'right' ? layout.x - line.advance : layout.x;
    const box = [x / width, (y - layout.ascent) / height, (x + line.advance) / width, (y + layout.descent) / height];
    return { line, x, y, box };
  });
}

function placeTranslation(ctx, units, paragraph, width, height, obstacles) {
  const measure = box => {
    const layout = fit(ctx, units, { ...paragraph, box }, width, height);
    if (!layout) return null;
    const lines = placedLines(layout, width, height);
    return lines.some(line => obstacles.some(box => overlap(line.box, box) > 1e-10)) ? null : { layout, lines };
  };
  const full = measure(paragraph.box);
  if (full || !obstacles.length) return full;
  let best = null;
  for (const box of availableBoxes(paragraph.box, obstacles)) {
    const next = measure(box);
    if (next && (!best || next.layout.size > best.layout.size)) best = next;
  }
  return best;
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
  const occupied = [];
  const placements = [];
  for (const paragraph of pageOverlays(paragraphs, translations, regions)) {
    const units = translationUnits(translations[paragraph.id], paragraph, width, height);
    const nearby = [...protectedBoxes, ...occupied].filter(box => overlap(paragraph.box, box) > 0);
    const placement = placeTranslation(ctx, units, paragraph, width, height, nearby);
    if (!placement) continue;
    placements.push({ ...placement, paragraph });
    occupied.push(...placement.lines.map(line => line.box));
  }

  // Mask all of the source text first. Overlapping source line boxes must not
  // erase Chinese text drawn for a previous paragraph.
  for (const { paragraph } of placements) {
    const [l, t, r, b] = paragraph.box;
    const padded = [l - .35 / width, t - .28 / height, r + .35 / width, b + .28 / height];
    ctx.save();
    for (const obstacle of protectedBoxes.filter(box => overlap(padded, box) > 0)) {
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
    ctx.restore();
  }

  const textLines = [];
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  for (const { paragraph, layout, lines } of placements) {
    ctx.font = layout.font;
    for (const { line, x, y } of lines) {
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
      textLines.push({ paragraphId: paragraph.id, text: line.text, x, y, width: line.advance, size: layout.size });
    }
  }
  ctx.restore();
  return textLines;
}
