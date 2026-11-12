const CJK_FONTS = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", "DengXian"';
const SANS = `${CJK_FONTS}, sans-serif`;
const MONO = `"Consolas", "Menlo", "DejaVu Sans Mono", ${CJK_FONTS}, monospace`;
const MATH = `"Cambria Math", "STIX Two Math", ${CJK_FONTS}, serif`;
const CLOSING = /^[，。；：！？、）》】〕」』…,.!?;:%)\]}]/u;
const OPENING = /[（《【〔「『(\[{]$/u;
const segments = new Intl.Segmenter('zh', { granularity: 'grapheme' });

export function isTranslatable(kind) {
  return kind === undefined || kind === 'text' || kind === 'heading' || kind === 'caption';
}

function area([l, t, r, b]) {
  return (r - l) * (b - t);
}

function validBox(box) {
  return Array.isArray(box) && box.length === 4 && box.every(Number.isFinite)
    && box[0] >= 0 && box[1] >= 0 && box[2] <= 1 && box[3] <= 1
    && box[0] < box[2] && box[1] < box[3];
}

function overlap([al, at, ar, ab], [bl, bt, br, bb]) {
  return Math.max(0, Math.min(ar, br) - Math.max(al, bl))
    * Math.max(0, Math.min(ab, bb) - Math.max(at, bt));
}

export function documentBodySize(paragraphs) {
  const sizes = paragraphs.filter(p => (p.kind === 'text' || p.kind === undefined)
    && p.text?.length >= 30 && p.style?.size >= 7 && p.style.size <= 18).map(p => p.style.size).sort((a, b) => a - b);
  return sizes.length ? Math.round(sizes[Math.floor(sizes.length / 2)] * 2) / 2 : 10;
}

function sourceBoxes(paragraph) {
  const lines = Array.isArray(paragraph.lines) ? paragraph.lines.filter(validBox) : [];
  return lines.length ? lines : validBox(paragraph.box) ? [paragraph.box] : [];
}

function covered(boxes, obstacles) {
  return boxes.every(box => obstacles.some(obstacle => overlap(box, obstacle) >= area(box) * .9));
}

// Ignore only duplicate copies when checking which translations must be shown.
export function expectedOverlays(paragraphs, translations) {
  const candidates = paragraphs.filter(p => isTranslatable(p.kind) && translations[p.id]?.trim());
  return candidates.filter(p => {
    // Keep malformed candidates in the expected set so export reports them.
    if (!validBox(p.box)) return true;
    const size = area(p.box);
    const boxes = sourceBoxes(p);
    return !candidates.some(q => q !== p && validBox(q.box) && q.text === p.text && overlap(p.box, q.box) > size * .5
      && (area(q.box) > size || (area(q.box) === size && q.id < p.id)) && covered(boxes, sourceBoxes(q)));
  });
}

export function pageOverlays(paragraphs, translations, regions) {
  // Only figure and table regions hide a translation here. Formula blocks are
  // avoided during placement, so a text line that overlaps an equation still
  // gets its translation instead of disappearing from the exported PDF.
  const regionBoxes = regions.filter(region => region.kind !== 'formula' && validBox(region.box)).map(region => region.box);
  return expectedOverlays(paragraphs, translations)
    .filter(p => validBox(p.box) && !covered(sourceBoxes(p), regionBoxes));
}

function protectedAreas(paragraphs, regions, translations) {
  return [
    ...regions.map(region => region.box),
    ...paragraphs.filter(p => !isTranslatable(p.kind) || !translations[p.id]?.trim()).map(p => p.box),
  ].filter(validBox);
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

function translationUnits(text, paragraph, width, height, obstacles) {
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
    const baseline = span.baseline * height;
    const insideLine = sourceBoxes(paragraph).some(box => overlap(span.box, box) >= area(span.box) * .9);
    const safe = insideLine && right > left && bottom > top && span.size > 0 && right - left <= width * .38
      && baseline >= top - span.size * .15 && baseline <= bottom + span.size * .25
      && bottom - top <= span.size * 2.25
      && !obstacles.some(box => overlap(span.box, box) > area(span.box) * .10);
    units.push({
      text: value, math: true,
      ...(safe && { source: { left, top, width: right - left, height: bottom - top, baseline, size: span.size } }),
    });
    cursor = offset + value.length;
  }
  addText(text.slice(cursor));
  return units;
}

function wrap(ctx, units, width, size, font, mathFont) {
  const lines = [];
  let line = [];
  let advance = 0;
  let currentFont;
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
    const nextFont = unit.math && !unit.source ? mathFont : font;
    if (nextFont !== currentFont) ctx.font = currentFont = nextFont;
    const measured = unit.source ? unit.source.width * scale : ctx.measureText(unit.text).width;
    const items = measured > width && !unit.source
      ? [...segments.segment(unit.text)].map(({ segment }) => ({ text: segment, math: unit.math, advance: ctx.measureText(segment).width }))
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

function fit(ctx, units, paragraph, width, height, bodySize) {
  const [left, top, right, bottom] = pixels(paragraph.box, width, height);
  const w = right - left;
  const h = bottom - top;
  const style = paragraph.style ?? {};
  const heading = paragraph.kind === 'heading';
  const sizeLimit = heading ? Math.min(40, Math.max(style.size || 0, bodySize * 1.1))
    : paragraph.kind === 'caption' ? Math.min(bodySize, Math.max(bodySize * .88, style.size || 0)) : bodySize;
  const normalLeading = Math.max(1.23, Math.min(1.43, (style.lineHeight || sizeLimit * 1.28) / (style.size || sizeLimit)));
  const family = style.fontFamily === 'monospace' ? MONO : SANS;
  const layoutAt = size => {
    const font = `${heading ? '700' : '400'} ${size}px ${family}`;
    const mathFont = `400 ${size}px ${MATH}`;
    const lines = wrap(ctx, units, w, size, font, mathFont);
    if (!lines.length || lines.some(line => line.advance > w + .01)) return null;
    ctx.font = font;
    const metrics = ctx.measureText('国Agα');
    const ascent = metrics.actualBoundingBoxAscent || size * .8;
    const descent = metrics.actualBoundingBoxDescent || size * .2;
    for (const line of lines) {
      line.ascent = ascent;
      line.descent = descent;
      for (const { source, scale } of line.items) {
        if (!source) continue;
        line.ascent = Math.max(line.ascent, (source.baseline - source.top) * scale);
        line.descent = Math.max(line.descent, (source.top + source.height - source.baseline) * scale);
      }
    }
    for (const leading of [normalLeading, 1.13]) {
      lines[0].baseline = lines[0].ascent;
      for (let i = 1; i < lines.length; i++) {
        const previous = lines[i - 1];
        lines[i].baseline = previous.baseline + Math.max(size * leading, previous.descent + lines[i].ascent + size * .045);
      }
      const last = lines.at(-1);
      if (last.baseline + last.descent <= h + 1e-8) return { size, lines, font, mathFont, heading };
    }
    return null;
  };
  let best = layoutAt(sizeLimit);
  const minimum = Math.min(sizeLimit, 5.5);
  for (let size = Math.floor((sizeLimit - .001) * 2) / 2; !best && size >= minimum; size -= .5) best = layoutAt(size);
  if (!best) return null;
  const align = heading && ['center', 'right'].includes(style.align) ? style.align : 'left';
  const x = align === 'center' ? (left + right) / 2 : align === 'right' ? right : left;
  const first = best.lines[0];
  const y = top + (best.lines.length === 1 ? Math.max(0, h - first.ascent - first.descent) / 2 : 0);
  return { ...best, x, y, align };
}

function placedLines(layout, width, height) {
  return layout.lines.map(line => {
    const y = layout.y + line.baseline;
    const x = layout.align === 'center' ? layout.x - line.advance / 2 : layout.align === 'right' ? layout.x - line.advance : layout.x;
    const box = [x / width, (y - line.ascent) / height, (x + line.advance) / width, (y + line.descent) / height];
    return { line, x, y, box };
  });
}

function expandBox(paragraph, neighbors, width, height, bodySize) {
  const [l, t, r, b] = paragraph.box;
  const sameColumn = neighbors.filter(box => Math.abs(box[0] - l) <= bodySize / width && box[2] - r <= bodySize * 3 / width);
  let right = Math.min(.96, Math.max(r + bodySize * .38 / width, ...sameColumn.map(box => box[2])));
  const lineCount = paragraph.lines?.length ?? 1;
  let bottom = Math.min(.96, b + bodySize * (lineCount > 1 ? 1.65 : .68) / height);
  for (const box of neighbors) {
    if (overlap([r, t, right, b], box) > 0) right = Math.max(r, box[0] - .65 / width);
  }
  for (const box of neighbors) {
    if (overlap([l, b, right, bottom], box) > 0) bottom = Math.max(b, box[1] - 1 / height);
  }
  return [l, t, Math.max(r, right), Math.max(b, bottom)];
}

function placeTranslation(ctx, units, paragraph, dimensions, obstacles, expanded, bodySize) {
  const { width, height } = dimensions;
  const measure = box => {
    const layout = fit(ctx, units, { ...paragraph, box }, width, height, bodySize);
    if (!layout) return null;
    const lines = placedLines(layout, width, height);
    return lines.some(line => obstacles.some(box => overlap(line.box, box) > 1e-10)) ? null : { layout, lines, frame: box };
  };
  let best = measure(paragraph.box);
  if (best?.layout.size >= bodySize) return best;
  for (const frame of [paragraph.box, expanded]) {
    const next = frame === paragraph.box ? best : measure(frame);
    if (next && (!best || next.layout.size > best.layout.size)) best = next;
    if (next || !obstacles.length) continue;
    for (const box of availableBoxes(frame, obstacles)) {
      const alternative = measure(box);
      if (alternative && (!best || alternative.layout.size > best.layout.size)) best = alternative;
    }
  }
  // Incomplete or overflowing text must fail export preflight. Clipping a
  // partial translation and reporting it as painted silently loses content.
  return best;
}

// Both the reading panel and the PDF exporter paint with PDF point coordinates.
// The source canvas is separate so each repaint starts from the untouched page.
export function paintTranslation(canvas, source, dimensions, paragraphs, translations, regions = [], bodySize = documentBodySize(paragraphs)) {
  const { width, height } = dimensions;
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0);
  ctx.save();
  ctx.scale(canvas.width / width, canvas.height / height);
  const protectedBoxes = protectedAreas(paragraphs, regions, translations);
  const occupied = [];
  const placements = [];
  for (const paragraph of pageOverlays(paragraphs, translations, regions)) {
    // One malformed paragraph (bad box from an upgrade, missing style) must not
    // abort the whole page or the PDF export.
    if (!validBox(paragraph.box)) continue;
    try {
      const neighbors = [...regions.map(region => region.box), ...paragraphs.filter(p => p !== paragraph).map(p => p.box)]
        .filter(validBox);
      const expanded = expandBox(paragraph, neighbors, width, height, bodySize);
      const units = translationUnits(translations[paragraph.id], paragraph, width, height, neighbors);
      const nearby = [...protectedBoxes, ...occupied].filter(box => overlap(expanded, box) > 0);
      const placement = placeTranslation(ctx, units, paragraph, dimensions, nearby, expanded, bodySize);
      if (!placement) continue;
      placements.push({ ...placement, paragraph });
      occupied.push(...placement.lines.map(line => line.box));
    } catch {
      continue;
    }
  }

  // Mask all of the source text first. Overlapping source line boxes must not
  // erase Chinese text drawn for a previous paragraph.
  const maskPadX = .62;
  const maskPadTop = .86;
  const maskPadBottom = .70;
  for (const { paragraph } of placements) {
    const [l, t, r, b] = paragraph.box;
    const padded = [l - maskPadX / width, t - maskPadTop / height, r + maskPadX / width, b + maskPadBottom / height];
    ctx.save();
    for (const obstacle of protectedBoxes.filter(box => overlap(padded, box) > 0)) {
      const [left, top, right, bottom] = pixels(obstacle, width, height);
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      ctx.rect(left, top, right - left, bottom - top);
      ctx.clip('evenodd');
    }
    ctx.fillStyle = '#fff';
    for (const lineBox of sourceBoxes(paragraph)) {
      const [left, top, right, bottom] = pixels(lineBox, width, height);
      ctx.fillRect(left - maskPadX, top - maskPadTop, right - left + maskPadX * 2, bottom - top + maskPadTop + maskPadBottom);
    }
    ctx.restore();
  }

  const textLines = [];
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.lineJoin = 'round';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  for (const { paragraph, layout, lines, frame } of placements) {
    ctx.save();
    // Keep every glyph inside its own block, so a fallback or a wide crop can
    // never bleed over a formula or the neighbouring column.
    const clip = frame ?? paragraph.box;
    const [cl, ct, cr, cb] = pixels(clip, width, height);
    ctx.beginPath();
    ctx.rect(cl - .6, ct - .6, cr - cl + 1.2, cb - ct + 1.2);
    ctx.clip();
    ctx.lineWidth = layout.size * .025;
    for (const { line, x, y } of lines) {
      let cursor = x;
      let run = '';
      let advance = 0;
      let math = false;
      const flush = () => {
        if (run.trim()) {
          ctx.font = math ? layout.mathFont : layout.font;
          if (!math && !layout.heading) ctx.strokeText?.(run, cursor, y, advance);
          ctx.fillText(run, cursor, y, advance);
        }
        cursor += advance;
        run = '';
        advance = 0;
      };
      for (const item of line.items) {
        if (item.source) {
          flush();
          const { left, top, width: w, height: h, baseline } = item.source;
          const sx = source.width / width;
          const sy = source.height / height;
          ctx.drawImage(source, left * sx, top * sy, w * sx, h * sy,
            cursor, y + (top - baseline) * item.scale, item.advance, h * item.scale);
          cursor += item.advance;
          continue;
        }
        if (Boolean(item.math) !== math) flush();
        math = Boolean(item.math);
        run += item.text;
        advance += item.advance;
      }
      flush();
      textLines.push({ paragraphId: paragraph.id, text: line.text, x, y, width: line.advance, size: layout.size });
    }
    ctx.restore();
  }
  ctx.restore();
  return textLines;
}
