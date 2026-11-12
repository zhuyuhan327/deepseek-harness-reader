const IDENTITY = [1, 0, 0, 1, 0, 0];
const UNIT_BOX = [0, 0, 1, 1];
const CAPTION = /^(?:fig(?:ure)?\.?|table|exhibit)\s*[A-Z]?\d+\b/i;
const LIST_ITEM = /^(?:[•▪●]|\d+[.)]\s)/;
const NEW_BLOCK = /^(?:[•▪●]|\[\d{1,3}\]\s|\d+[.)]\s)/;
const MATH_FONT = /^(?:CM(?:MI|SY|EX)|[LMT]M(?:MI|SY|EX)|MS[AB]M|EU(?:FM|RM)|RSFS|WASY)|(?:math|symbol|stmary|mathtime)/i;
const MATH_CHAR = /[\p{Math_Symbol}\p{Script=Greek}]/u;

function median(values, fallback = 0) {
  if (!values.length) return fallback;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

function width(box) { return box[2] - box[0]; }
function height(box) { return box[3] - box[1]; }
function area(box) { return Math.max(0, width(box)) * Math.max(0, height(box)); }
function center(box) { return (box[0] + box[2]) / 2; }

function union(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function intersect(a, b) {
  const box = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return width(box) >= 0 && height(box) >= 0 ? box : null;
}

function overlaps(box, region, fraction = .64) {
  const common = intersect(box, region);
  return common && area(common) >= area(box) * fraction;
}

function transformBox(box, [a, b, c, d, e, f]) {
  const [x, y, right, bottom] = box;
  const xs = [a * x + c * y + e, a * right + c * y + e, a * x + c * bottom + e, a * right + c * bottom + e];
  const ys = [b * x + d * y + f, b * right + d * y + f, b * x + d * bottom + f, b * right + d * bottom + f];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function detectGraphics(pdfjs, viewport, operators) {
  const ops = pdfjs.OPS;
  const figures = [];
  const rules = [];
  if (!ops || !operators) return { figures, rules };

  const bounds = [0, 0, viewport.width, viewport.height];
  let matrix = viewport.transform;
  let clip = bounds;
  let form = null;
  const stack = [];
  const graphicSize = box => width(box) > viewport.width * .025 && height(box) > viewport.height * .018
    && area(box) > area(bounds) * .001 && area(box) < area(bounds) * .84;
  const paintImage = transform => {
    const box = clip && intersect(clip, transformBox(UNIT_BOX, transform));
    if (!box || !graphicSize(box)) return;
    if (figures.length < 500) figures.push(box);
    for (let group = form; group; group = group.parent) {
      group.images++;
      group.ink = group.ink ? union(group.ink, box) : box;
    }
  };
  const push = () => stack.push({ matrix, clip, form });
  const pop = () => {
    const frame = stack.pop();
    if (frame) ({ matrix, clip, form } = frame);
  };

  for (let index = 0; index < operators.fnArray.length; index++) {
    const op = operators.fnArray[index];
    const args = operators.argsArray[index] ?? [];
    switch (op) {
      case ops.save:
        push();
        break;
      case ops.restore:
      case ops.endGroup:
        pop();
        break;
      case ops.transform:
        matrix = pdfjs.Util.transform(matrix, args);
        break;
      case ops.beginGroup:
        push();
        // A transparency group's matrix maps its clip. Its drawing operations
        // still use the enclosing transform, including an explicit Form matrix.
        if (clip && args[0]?.bbox) {
          clip = intersect(clip, transformBox(args[0].bbox, pdfjs.Util.transform(matrix, args[0].matrix ?? IDENTITY)));
        }
        break;
      case ops.paintFormXObjectBegin:
        push();
        if (args[0]) matrix = pdfjs.Util.transform(matrix, args[0]);
        if (clip && args[1]) clip = intersect(clip, transformBox(args[1], matrix));
        form = { parent: form, paths: 0, images: 0, ink: null };
        break;
      case ops.paintFormXObjectEnd:
        if (form?.ink && (form.paths >= 10 || form.images >= 3) && graphicSize(form.ink) && figures.length < 500) figures.push(form.ink);
        pop();
        break;
      case ops.paintImageXObject:
      case ops.paintInlineImageXObject:
      case ops.paintImageMaskXObject:
        paintImage(matrix);
        break;
      case ops.paintImageXObjectRepeat:
        for (let i = 0; i < (args[3]?.length ?? 0); i += 2) {
          paintImage(pdfjs.Util.transform(matrix, [args[1], 0, 0, args[2], args[3][i], args[3][i + 1]]));
        }
        break;
      case ops.paintInlineImageXObjectGroup:
        for (const image of args[1] ?? []) paintImage(pdfjs.Util.transform(matrix, image.transform));
        break;
      case ops.paintImageMaskXObjectGroup:
        for (const image of args[0] ?? []) paintImage(pdfjs.Util.transform(matrix, image.transform));
        break;
      case ops.paintImageMaskXObjectRepeat:
        for (let i = 0; i < (args[5]?.length ?? 0); i += 2) {
          paintImage(pdfjs.Util.transform(matrix, [...args.slice(1, 5), args[5][i], args[5][i + 1]]));
        }
        break;
      case ops.constructPath: {
        if (!clip || !args[2] || args[0] === ops.endPath) break;
        const box = intersect(clip, transformBox(args[2], matrix));
        if (!box) break;
        if (width(box) >= viewport.width * .15 && height(box) < 1.4 && rules.length < 500) rules.push(box);
        for (let group = form; group; group = group.parent) {
          // Ignore page-sized backgrounds when estimating the vector artwork.
          if (area(box) >= area(bounds) * .84) continue;
          group.paths++;
          group.ink = group.ink ? union(group.ink, box) : box;
        }
        break;
      }
    }
  }
  return { figures, rules };
}

function fontDetails(page, styles, key) {
  const object = page.commonObjs?.has(key) ? page.commonObjs.get(key) : null;
  const name = String(object?.name ?? key ?? '').replace(/^[A-Z]{6}\+/, '');
  const style = styles[key] ?? {};
  const fallback = style.fontFamily;
  let family = ['serif', 'sans-serif', 'monospace'].includes(fallback) ? fallback : 'serif';
  if (/times|nimbusrom|computer.modern.roman|^CMR|^LMRoman|palatino|garamond|libertine/i.test(name)) family = 'serif';
  if (/helvetica|arial|^CMSS|^LMSans|nimbussan/i.test(name)) family = 'sans-serif';
  if (/^CMTT|courier|nimbusmon|^LMMono/i.test(name)) family = 'monospace';
  const math = MATH_FONT.test(name);
  return {
    family,
    bold: !!(object?.bold || object?.black || /bold|black|heavy|demi|semibold|medi(?:um)?(?:ital)?$|^CMBX/i.test(name)),
    italic: !!(object?.italic || /italic|ital$|oblique|slanted|^CMTI|^CMSL/i.test(name)),
    math,
    mathBase: /^(?:CM|LMR)BX/i.test(name),
    largeOperator: /^(?:CM|[LMT]M)EX/i.test(name),
    ascent: Number.isFinite(style.ascent) ? Math.min(1.35, Math.max(math ? .05 : .72, style.ascent + .03)) : .82,
    descent: Number.isFinite(style.descent) ? Math.min(.8, Math.max(.18, -style.descent + .015)) : .21,
  };
}

function textRuns(pdfjs, page, viewport, content) {
  const fonts = new Map();
  const runs = [];
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;
    // Symbol-font glyphs often extract as NUL/replacement characters; drop them
    // before they reach the translator or the overlay painter.
    const str = item.str.replace(/[\u0000\uFFFD\u200B]/gu, '');
    if (!str.trim()) continue;
    const [a, b, c, d, x, baseline] = pdfjs.Util.transform(viewport.transform, item.transform);
    const size = Math.hypot(c, d);
    if (![x, baseline, size, item.width].every(Number.isFinite) || size < 1 || item.width <= 0) continue;
    // Vertical margin stamps and rotated axis labels remain in the source image.
    if (Math.abs(b) > Math.abs(a) * .2 || a <= 0 || content.styles[item.fontName]?.vertical) continue;
    let font = fonts.get(item.fontName);
    if (!font) {
      font = fontDetails(page, content.styles, item.fontName);
      fonts.set(item.fontName, font);
    }
    const box = [x, baseline - size * font.ascent, x + item.width * (viewport.scale ?? 1), baseline + size * font.descent];
    if (width(box) <= 0) continue;
    runs.push({ text: str.trim(), leading: /^\s/u.test(str), trailing: /\s$/u.test(str), box, baseline, size, font });
  }
  return runs;
}

function buildLine(runs) {
  let box = runs[0].box;
  const main = runs.filter(run => !run.font.math);
  const anchors = main.length ? main : runs;
  const size = median(anchors.map(run => run.size));
  const baseline = median(anchors.map(run => run.baseline));
  const mathSpans = [];
  const families = new Map();
  let bold = 0;
  let italic = 0;
  let text = '';
  let previous;
  let previousStart = 0;
  for (const run of runs) {
    if (previous?.text === run.text && Math.abs(run.box[0] - previous.box[0]) < .35) continue;
    const spacing = previous && run.box[0] - previous.box[2];
    if (previous && !/^[,.;:!?%)\]}]/u.test(run.text) && !/[([{]$/u.test(text) &&
      (spacing > size * .16 || (spacing >= -size * .18 && (run.leading || previous.trailing)))) text += ' ';
    const start = text.length;
    text += run.text;
    const scripted = run.text.length <= 8 && run.size < size * .84 && Math.abs(baseline - run.baseline) > size * .10;
    const variable = /^[\p{Script=Latin}\p{Script=Greek}\p{Number}]$/u;
    if (run.font.math || scripted || (run.font.mathBase && variable.test(run.text))
        || (run.text.length <= 4 && MATH_CHAR.test(run.text))) {
      const attached = scripted && previous && variable.test(previous.text)
        && start === previousStart + previous.text.length && spacing <= size * .16;
      const mathStart = attached ? previousStart : start;
      const mathBox = attached ? union(previous.box, run.box) : run.box;
      const last = mathSpans.at(-1);
      if (last && mathStart - last.end <= 1) {
        last.end = text.length;
        last.box = union(last.box, mathBox);
      } else {
        mathSpans.push({ start: mathStart, end: text.length, box: mathBox });
      }
    }
    if (!run.font.math) {
      const length = run.text.length;
      families.set(run.font.family, (families.get(run.font.family) ?? 0) + length);
      if (run.font.bold) bold += length;
      if (run.font.italic) italic += length;
    }
    box = union(box, run.box);
    previous = run;
    previousStart = start;
  }
  return {
    box, text, baseline, size, mathSpans,
    runs: mathSpans.length ? runs : undefined,
    mathRatio: mathSpans.reduce((count, span) => count + span.end - span.start, 0) / text.length,
    bold: bold > text.length * .52, italic: italic > text.length * .52,
    fontFamily: [...families].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'serif',
  };
}

function makeRows(runs, typical) {
  const rows = [];
  // Establish the main baselines first so superscripts cannot start a new
  // paragraph or shift the baseline used for subsequent body runs.
  const deferredOperator = run => run.font.largeOperator || run.text === '√';
  const baselineAnchor = run => run.size >= typical * .82 && !deferredOperator(run);
  const main = runs.filter(baselineAnchor);
  const small = runs.filter(run => !baselineAnchor(run));
  for (const run of main.sort((a, b) => a.baseline - b.baseline || a.box[0] - b.box[0])) {
    const row = rows.at(-1);
    if (row && Math.abs(run.baseline - row.baseline) <= Math.min(run.size, row.size) * .23) row.runs.push(run);
    else rows.push({ baseline: run.baseline, size: run.size, runs: [run] });
  }
  for (const run of small.sort((a, b) => a.baseline - b.baseline || a.box[0] - b.box[0])) {
    let closest;
    let distance = Infinity;
    for (const row of rows) {
      const delta = Math.abs(row.baseline - run.baseline);
      if (delta >= distance || delta > row.size * (deferredOperator(run) ? .81 : .6)) continue;
      const sameBaseline = delta <= run.size * .2;
      const nearText = row.runs.some(other => other.box[0] - run.box[2] <= row.size * .65
        && run.box[0] - other.box[2] <= row.size * .65);
      const underProse = deferredOperator(run) && row.runs.some(other => !other.font.math && other.text.length > 12
        && other.box[0] < run.box[0] && other.box[2] > run.box[2]);
      if (!sameBaseline && (!nearText || underProse)) continue;
      distance = delta;
      closest = row;
    }
    if (closest) closest.runs.push(run);
    else rows.push({ baseline: run.baseline, size: run.size, runs: [run] });
  }
  return rows.sort((a, b) => a.baseline - b.baseline).map(row => {
    const segments = [];
    let right = -Infinity;
    for (const run of row.runs.sort((a, b) => a.box[0] - b.box[0] || a.baseline - b.baseline)) {
      const segment = segments.at(-1);
      const sectionNumber = segment?.length === 1 && segment[0].font.bold && run.font.bold
        && /^(?:\d+|[A-H])(?:\.\d+)*\.?$/.test(segment[0].text);
      const limit = Math.max(4, Math.min(run.size, row.size) * (sectionNumber ? 1.35 : .94));
      if (run.box[0] - right <= limit) {
        segment.push(run);
        right = Math.max(right, run.box[2]);
      } else {
        segments.push([run]);
        right = run.box[2];
      }
    }
    return segments.map(buildLine);
  });
}

function tableBoxes(rows, rules, viewport, typical) {
  const boxes = [];
  for (const top of rules) {
    const aligned = rules.filter(bottom => bottom[1] - top[1] > typical * 2
      && bottom[1] - top[1] < viewport.height * .38
      && Math.abs(bottom[0] - top[0]) < typical && Math.abs(bottom[2] - top[2]) < typical);
    for (const bottom of aligned.sort((a, b) => b[1] - a[1])) {
      const box = union(top, bottom);
      const contained = rows.map(row => row.filter(line => overlaps(line.box, box, .68))).filter(row => row.length);
      if (contained.length < 2 || contained.filter(row => row.length >= 2).length < 2) continue;
      if (contained.some(row => row.some(line => CAPTION.test(line.text) || line.text.length >= 95))) continue;
      boxes.push(box);
      break;
    }
  }

  // Unruled tables have stable cell anchors and a concentration of numeric
  // values across multiple short rows. Require all cues before suppressing text.
  // Exclude ruled cells before grouping a baseline shared with another column.
  const ruled = boxes.slice();
  const numeric = /^[+−-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:\s*(?:[%±×]|\(\d+\)))?/u;
  let block = [];
  const add = () => {
    if (block.length >= 3) boxes.push(block.flat().map(line => line.box).reduce(union));
    block = [];
  };
  for (const row of rows) {
    const cells = row.filter(line => line.text.length < 36 && !CAPTION.test(line.text)
      && !ruled.some(box => overlaps(line.box, box, .68)));
    const previous = block.at(-1);
    const likely = cells.length >= 3 && cells.filter(line => numeric.test(line.text)).length >= 2;
    const connected = likely && previous && cells[0].baseline - previous[0].baseline < typical * 2.35
      && cells.filter(cell => previous.some(old => Math.abs(old.box[0] - cell.box[0]) < typical * .6
        || Math.abs(old.box[2] - cell.box[2]) < typical * .6)).length >= 3;
    if (!likely || (previous && !connected)) add();
    if (likely) block.push(cells);
  }
  add();
  return boxes;
}

function regionsFor(figures, tables, viewport, typical) {
  const regions = [];
  const bounds = [0, 0, viewport.width, viewport.height];
  for (const [kind, boxes] of [['table', tables], ['figure', figures]]) {
    const kept = [];
    for (const original of [...boxes].sort((a, b) => area(b) - area(a))) {
      if (kept.some(box => overlaps(original, box, .9))) continue;
      const pad = kind === 'figure' ? Math.min(2, typical * .18) : 1;
      const box = intersect(bounds, [original[0] - pad, original[1] - pad, original[2] + pad, original[3] + pad]);
      if (box && area(box) > 0) kept.push(box);
    }
    regions.push(...kept.map(box => ({ kind, box })));
  }
  return regions;
}

function findGutter(lines, pageWidth, typical) {
  const candidates = lines.filter(line => !line.region && line.text.length >= 24 && width(line.box) >= pageWidth * .15);
  let best = null;
  let score = 0;
  for (let position = .29; position <= .71; position += .015) {
    const x = pageWidth * position;
    const left = candidates.filter(line => line.box[2] <= x - typical * .15);
    const right = candidates.filter(line => line.box[0] >= x + typical * .15);
    if (left.length < 3 || right.length < 3) continue;
    const paired = left.filter(line => right.some(other => Math.abs(other.baseline - line.baseline) < typical * 1.25));
    if (paired.length < 3) continue;
    const crossing = candidates.length - left.length - right.length;
    const value = paired.length * 2 + Math.min(left.length, right.length) - crossing * .55 - Math.abs(position - .5);
    if (value > score) {
      best = x;
      score = value;
    }
  }
  return best;
}

function orderLines(lines, gutter, pageWidth, typical, pageNumber) {
  const byPosition = (a, b) => a.baseline - b.baseline || a.box[0] - b.box[0];
  if (gutter === null) return lines.sort(byPosition);
  const spanning = [];
  const columns = [];
  const title = pageNumber === 1 && lines.find(line => line.bold && line.size > typical * 1.25
    && line.box[0] < gutter && line.box[2] > gutter);
  const firstColumnLine = title && lines.find(line => line.baseline > title.baseline && line.text.length > 45
    && width(line.box) > pageWidth * .20 && (line.box[2] < gutter || line.box[0] > gutter));
  for (const line of lines) {
    const across = line.box[0] < gutter - typical * .55 && line.box[2] > gutter + typical * .55;
    const central = Math.abs(center(line.box) - pageWidth / 2) < typical * .5 && width(line.box) < pageWidth * .12;
    if (across || central || (firstColumnLine && line.baseline < firstColumnLine.baseline)) spanning.push(line);
    else columns.push(line);
  }
  spanning.sort(byPosition);
  columns.sort((a, b) => Number(center(a.box) >= gutter) - Number(center(b.box) >= gutter) || byPosition(a, b));
  const ordered = [];
  const emitted = new Set();
  for (const line of spanning) {
    for (const item of columns) {
      if (item.baseline >= line.baseline || emitted.has(item)) continue;
      ordered.push(item);
      emitted.add(item);
    }
    ordered.push(line);
  }
  ordered.push(...columns.filter(line => !emitted.has(line)));
  return ordered;
}

function sameFontSize(first, second) {
  return Math.abs(first.size - second.size) <= Math.max(first.size, second.size) * .12;
}

function sameTextStyle(first, second) {
  return sameFontSize(first, second) && first.bold === second.bold
    && first.italic === second.italic && first.fontFamily === second.fontFamily;
}

function markRunInHeadings(rows) {
  for (const row of rows) {
    row.forEach((line, index) => {
      const next = row[index + 1];
      if (!line.bold || line.region || !next || next.bold || next.region) return;
      const gap = next.box[0] - line.box[2];
      if (/^[A-Z][^.]{1,84}\.$/.test(line.text) && /^[A-Za-z]{2}/.test(next.text)
          && gap >= 0 && gap <= line.size * 2 && sameFontSize(line, next)
          && line.fontFamily === next.fontFamily) line.runInHeading = true;
    });
  }
}

function rejoinJustifiedRows(rows, gutter, regions) {
  return rows.flatMap((row, index) => {
    const groups = [];
    for (const line of row) {
      const group = groups.at(-1);
      const previous = group?.at(-1);
      const gap = previous && line.box[0] - previous.box[2];
      const crossesGutter = gutter !== null && previous && center(previous.box) < gutter && center(line.box) >= gutter;
      if (previous && !crossesGutter && !previous.region && !line.region
          && !previous.mathSpans.length && !line.mathSpans.length && sameTextStyle(previous, line)
          && gap >= 0 && gap <= Math.min(previous.size, line.size) * 1.1) {
        group.push(line);
      } else {
        groups.push([line]);
      }
    }
    return groups.flatMap(group => {
      if (group.length < 3) return group;
      const text = group.map(line => line.text).join(' ');
      if ((text.match(/[A-Za-z]{3,}/g)?.length ?? 0) < 3) return group;
      const joined = { ...group[0], text, box: group.map(line => line.box).reduce(union) };
      if (regions.some(({ box }) => overlaps(joined.box, box, .25))) return group;
      // Justification can put a full em between words. An aligned continuation
      // distinguishes those runs from separate labels on the same baseline.
      const continuation = rows.slice(index + 1, index + 3).some(nextRow => nextRow.some(line =>
        (line.text.match(/[A-Za-z]{3,}/g)?.length ?? 0) >= 4 && joinLines(joined, line, [joined])));
      return continuation ? [joined] : group;
    });
  });
}

function splitEquationProse(lines) {
  const tails = new Map();
  const result = [];
  for (const [index, line] of lines.entries()) {
    if (tails.has(index)) result.push(tails.get(index));
    const split = line.region ? -1 : (line.runs?.findIndex((run, i) => i >= 2 && !run.font.math
      && !run.font.mathBase && /^[,.]\s+(?:where|as)\b/i.test(run.text)) ?? -1);
    if (split < 0) {
      result.push(line);
      continue;
    }
    const formula = line.runs.slice(0, split);
    const hasProse = formula.some(run => run.size >= line.size * .84 && !run.font.math && !run.font.mathBase
      && /[A-Za-z]{3}/.test(run.text));
    if (hasProse || formula.filter(run => run.font.math || run.font.mathBase).length < 2) {
      result.push(line);
      continue;
    }
    const tailRuns = line.runs.slice(split);
    // Keep a numeric operand in the same original crop as its arrow.
    const suffix = tailRuns.map((run, i) => /^\d+$/.test(run.text) && /[→←]$/.test(tailRuns[i - 1]?.text ?? '')
      ? { ...run, font: { ...run.font, math: true } } : run);
    const tail = { ...buildLine(suffix), equationProse: true };
    let following = index + 1;
    while (following < lines.length && following <= index + 6) {
      const candidate = lines[following];
      const near = Math.abs(candidate.baseline - line.baseline) < line.size * .6;
      if (!near || candidate.region || !candidate.mathSpans.length || candidate.mathRatio < .62
          || candidate.box[0] < line.box[0] - line.size * 15 || candidate.box[2] > tail.box[2] + line.size) break;
      following++;
    }
    const continuation = lines[following];
    if (continuation && !tails.has(following) && (continuation.text.match(/[A-Za-z]{3,}/g)?.length ?? 0) >= 4
        && joinLines(tail, continuation, [tail])) {
      result.push(buildLine(formula));
      tails.set(following, tail);
    } else {
      result.push(line);
    }
  }
  return result;
}

function attachTrailingIndices(lines) {
  const ordered = [];
  for (const line of lines) {
    const script = ordered.at(-1);
    const variable = line.mathSpans.at(-1);
    if (!line.region && script && !script.region && script.mathSpans.length && line.mathSpans.length === 1
        && variable && /^[a-z]{2,} [A-Za-z]$/.test(line.text)
        && variable.start === line.text.length - 1 && variable.end === line.text.length
        && script.size < line.size * .84 && /^\([a-z0-9]{1,3}\)$/.test(script.text)
        && script.baseline < line.baseline && line.baseline - script.baseline < line.size * .82) {
      const gap = script.box[0] - variable.box[2];
      if (gap >= -line.size * .08 && gap <= line.size * .28) {
        const text = line.text + script.text;
        const span = { ...variable, end: text.length, box: union(variable.box, script.box) };
        ordered.pop();
        ordered.push({ ...line, text, box: union(line.box, script.box), mathSpans: [span],
          mathRatio: (span.end - span.start) / text.length });
        continue;
      }
    }
    ordered.push(line);
  }
  return ordered;
}

function orderInlineContinuations(lines, gutter) {
  const ordered = [];
  for (const line of lines) {
    let position = ordered.length;
    // Superscripts can sort ahead of the prose on the baseline they belong to.
    if (!line.region && !line.mathSpans.length && width(line.box) < line.size * 8
        && /^(?:[a-z]{2,} ){1,3}(?:as|by|of|with)$/.test(line.text)) {
      while (position > 0) {
        const fragment = ordered[position - 1];
        const gap = fragment.box[0] - line.box[2];
        const sameColumn = gutter === null || (center(fragment.box) < gutter) === (center(line.box) < gutter);
        if (fragment.region || !fragment.mathSpans.length || fragment.text.length > 20 || !sameColumn
            || gap < 0 || gap > line.size * 8 || Math.abs(fragment.baseline - line.baseline) > line.size * .82) break;
        position--;
      }
      const preceding = ordered[position - 1];
      if (position < ordered.length && preceding && /\b(?:a|an|the)$/i.test(preceding.text)
          && Math.abs(preceding.box[0] - line.box[0]) <= line.size * .25
          && ordered.slice(position).every(fragment => fragment.box[2] <= preceding.box[2] + line.size * .2)
          && joinLines(preceding, line, [preceding])) {
        ordered.splice(position, 0, line);
        continue;
      }
    }
    ordered.push(line);
  }
  return ordered;
}

function joinLines(previous, line, block) {
  const dy = line.baseline - previous.baseline;
  const size = Math.max(previous.size, line.size);
  const dx = line.box[0] - previous.box[0];
  const shared = Math.min(previous.box[2], line.box[2]) - Math.max(previous.box[0], line.box[0]);
  const shortLine = block.length > 1 && previous.box[2] < Math.max(...block.map(item => item.box[2])) - size * 3.5;
  const indent = block.length === 1 && LIST_ITEM.test(previous.text) ? size * 2.4 : size * .8;
  // A sentence can start in the space to the right of an inline heading or at
  // the end of the preceding sentence, then wrap to the left column margin.
  const wrapsFromRight = block.length === 1 && !previous.bold && dx <= -size * 2.3
    && (previous.equationProse || (/^[A-Z]/.test(previous.text)
      && previous.text.split(/\s+/).length <= 3 && width(previous.box) < size * 8))
    && !/[.!?;:]$/.test(previous.text) && /^[a-z]{2}/.test(line.text)
    && Math.abs(previous.box[2] - line.box[2]) <= size * .35 && width(previous.box) < width(line.box) * .75;
  return !line.region && !previous.region && !line.runInHeading && !previous.runInHeading
    && line.mathRatio < .62 && previous.mathRatio < .62 && dy > size * .52 && dy < size * 1.61
    && ((dx > -size * 2.3 && dx < indent) || wrapsFromRight)
    && sameTextStyle(previous, line)
    && shared > Math.min(width(line.box), width(previous.box)) * .52
    && !CAPTION.test(line.text) && !NEW_BLOCK.test(line.text)
    && !(shortLine && /[.!?。！？]$/.test(previous.text));
}

function assembleParagraphs(lines, viewport, number, normalize) {
  const blocks = [];
  let chars = 0;
  for (const line of lines) {
    const block = blocks.at(-1);
    if (block && chars + line.text.length < 2200 && joinLines(block.at(-1), line, block)) {
      block.push(line);
      chars += line.text.length + 1;
    } else {
      blocks.push([line]);
      chars = line.text.length;
    }
  }
  return blocks.map(block => {
    const box = block.map(line => line.box).reduce(union);
    const first = block[0];
    const lineHeight = median(block.slice(1).map((line, index) => line.baseline - block[index].baseline), first.size * 1.18);
    const centered = block.length <= 2 && Math.abs(center(box) - viewport.width / 2) < viewport.width * .055
      && width(box) < viewport.width * .8;
    const mathSpans = [];
    let text = '';
    for (const line of block) {
      // An end-of-line soft hyphen denotes a split word. A visible hyphen can
      // belong to a compound word, so retain it and join the two fragments.
      if (text.endsWith('\u00ad') && !mathSpans.some(span => span.end === text.length)) text = text.slice(0, -1);
      else if (text && !(/\p{Letter}-$/u.test(text) && /^\p{Ll}/u.test(line.text))) text += ' ';
      const start = text.length;
      text += line.text;
      for (const span of line.mathSpans) mathSpans.push({
        start: start + span.start, end: start + span.end, box: normalize(span.box),
        baseline: line.baseline / viewport.height, size: line.size,
      });
    }
    const paragraph = {
      page: number, text, box: normalize(box), lines: block.map(line => normalize(line.box)),
      style: { size: first.size, bold: first.bold, italic: first.italic, fontFamily: first.fontFamily,
        align: centered ? 'center' : 'left', lineHeight },
    };
    if (mathSpans.length) paragraph.mathSpans = mathSpans;
    return paragraph;
  });
}

function crossesGutter(line, gutter, typical) {
  return gutter !== null && line.box[0] < gutter - typical * .55 && line.box[2] > gutter + typical * .55;
}

function mergeFragments(left, right, gutter, typical) {
  if (left.region || right.region) return false;
  if (crossesGutter(left, gutter, typical) || crossesGutter(right, gutter, typical)) return false;
  if (gutter !== null && (center(left.box) < gutter) !== (center(right.box) < gutter)) return false;
  const gap = right.box[0] - left.box[2];
  if (gap > typical * 2.6 || gap < -typical * .8) return false;
  if (Math.abs(left.size - right.size) > Math.max(left.size, right.size) * .2) return false;
  if (CAPTION.test(right.text)) return false;
  // A finished sentence followed by a capitalised new block is a real break,
  // even when the two boxes sit close together on one baseline.
  if (gap > typical * .5 && /[.!?]["'”’)]?$/u.test(left.text) && /^[A-Z0-9]/u.test(right.text)) return false;
  return /[A-Za-z]{2}/u.test(left.text) || /[A-Za-z]{2}/u.test(right.text);
}

function mergeInline(left, right) {
  const glue = /\p{Letter}-$/u.test(left.text) && /^\p{Ll}/u.test(right.text) ? '' : ' ';
  const offset = left.text.length + glue.length;
  left.text += glue + right.text;
  left.box = union(left.box, right.box);
  for (const span of right.mathSpans ?? []) {
    left.mathSpans.push({ start: span.start + offset, end: span.end + offset, box: span.box });
  }
  left.mathRatio = left.mathSpans.reduce((count, span) => count + span.end - span.start, 0) / Math.max(1, left.text.length);
  left.runs = undefined;
}

/**
 * Rows split at every gap wider than a word space, so an inline formula or a
 * column-local word gap leaves one-line fragments that later become separate
 * "paragraphs". Merge those neighbours back into one line first.
 */
function mergeBaselineFragments(lines, gutter, typical) {
  const sorted = [...lines].sort((a, b) => a.baseline - b.baseline || a.box[0] - b.box[0]);
  const result = [];
  let row = [];
  const flush = () => {
    if (!row.length) return;
    const kept = [];
    for (const line of row.sort((a, b) => a.box[0] - b.box[0])) {
      const previous = kept.at(-1);
      if (previous && mergeFragments(previous, line, gutter, typical)) mergeInline(previous, line);
      else kept.push(line);
    }
    result.push(...kept);
    row = [];
  };
  for (const line of sorted) {
    if (row.length && Math.abs(line.baseline - row[0].baseline) > typical * .45) flush();
    row.push(line);
  }
  flush();
  return result;
}

export async function extractPageLayout(pdfjs, page, viewport, number) {
  const [content, operators] = await Promise.all([
    page.getTextContent(),
    page.getOperatorList?.({ annotationMode: pdfjs.AnnotationMode?.DISABLE }).catch(() => null),
  ]);
  const normalize = box => box.map((n, index) => Math.min(1, Math.max(0, n / (index % 2 ? viewport.height : viewport.width))));
  const runs = textRuns(pdfjs, page, viewport, content);
  const typical = median(runs.filter(run => !run.font.math && run.text.length >= 4).map(run => run.size), 10);
  const rows = makeRows(runs, typical);
  const { figures, rules } = detectGraphics(pdfjs, viewport, operators);
  const tables = tableBoxes(rows, rules, viewport, typical);
  const regions = regionsFor(figures, tables, viewport, typical);
  const validRows = rows.map(row => row.filter(line => area(normalize(line.box)) > 0));
  const lines = validRows.flat();
  for (const line of lines) {
    if (!CAPTION.test(line.text)) line.region = regions.find(({ box }) => overlaps(line.box, box));
  }
  markRunInHeadings(validRows);
  const gutter = findGutter(lines, viewport.width, typical);
  const joined = rejoinJustifiedRows(validRows, gutter, regions);
  const merged = mergeBaselineFragments(joined, gutter, typical);
  const ordered = orderLines(merged, gutter, viewport.width, typical, number);
  const separated = splitEquationProse(ordered);
  const paragraphs = assembleParagraphs(orderInlineContinuations(attachTrailingIndices(separated), gutter), viewport, number, normalize);
  return { paragraphs, regions: regions.map(({ kind, box }) => ({ kind, box: normalize(box) })) };
}
