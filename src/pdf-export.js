const GLYPHS_PER_FONT = 255;
const UNICODE_BLOCK_SIZE = 100;

function hex(value, digits) {
  return value.toString(16).padStart(digits, '0');
}

function unicodeCMap(characters) {
  const lines = [
    '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /QuietReaderUnicode def', '/CMapType 2 def',
    '1 begincodespacerange', '<00> <ff>', 'endcodespacerange',
  ];
  for (let first = 0; first < characters.length; first += UNICODE_BLOCK_SIZE) {
    const last = Math.min(first + UNICODE_BLOCK_SIZE, characters.length);
    lines.push(`${last - first} beginbfchar`);
    for (let index = first; index < last; index++) {
      const character = characters[index];
      let utf16 = '';
      for (let unit = 0; unit < character.length; unit++) utf16 += hex(character.charCodeAt(unit), 4);
      lines.push(`<${hex(index + 1, 2)}> <${utf16}>`);
    }
    lines.push('endbfchar');
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end', '');
  return lines.join('\n');
}

function textLayer(lines, height, glyphs) {
  let content = '';
  const fonts = new Set();
  for (const { text, x, y, size, width } of lines) {
    const characters = [...text];
    const scale = width / (size * characters.length);
    content += `BT\n3 Tr\n${scale.toFixed(6)} 0 0 1 ${x.toFixed(2)} ${(height - y).toFixed(2)} Tm\n`;
    let currentFont;
    let encoded = '';
    for (const character of characters) {
      const { font, code } = glyphs.get(character);
      if (font !== currentFont) {
        if (encoded) content += `<${encoded}> Tj\n`;
        content += `/F${font} ${size.toFixed(2)} Tf\n`;
        fonts.add(font);
        currentFont = font;
        encoded = '';
      }
      encoded += code;
    }
    content += `<${encoded}> Tj\nET\n`;
  }
  return { content, fonts };
}

// The visible page is the existing JPEG. PDF-native blank Type 3 glyphs
// provide selection geometry, and their ToUnicode maps preserve the text.
export function buildJpegPdf(pages) {
  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let size = 0;
  const push = data => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    chunks.push(bytes);
    size += bytes.length;
  };
  const begin = number => { offsets[number] = size; push(`${number} 0 obj\n`); };
  const stream = (number, contents, attributes = '') => {
    const bytes = typeof contents === 'string' ? encoder.encode(contents) : contents;
    begin(number);
    push(`<< ${attributes}/Length ${bytes.length} >>\nstream\n`);
    push(bytes);
    push('\nendstream\nendobj\n');
  };

  const glyphs = new Map();
  const fontCharacters = [];
  const pageLines = pages.map(page => (page.textLines ?? []).flatMap(line => {
    if (typeof line.text !== 'string' || ![line.x, line.y, line.size, line.width].every(Number.isFinite) ||
        line.size <= 0 || line.width <= 0) return [];
    const text = line.text.replace(/\p{Cc}/gu, ' ').toWellFormed();
    if (!text.trim()) return [];
    for (const character of text) {
      if (glyphs.has(character)) continue;
      const font = Math.floor(glyphs.size / GLYPHS_PER_FONT);
      const index = glyphs.size % GLYPHS_PER_FONT;
      if (!index) fontCharacters.push([]);
      fontCharacters[font].push(character);
      glyphs.set(character, { font, code: hex(index + 1, 2) });
    }
    return [{ ...line, text }];
  }));
  const blankGlyphId = 3 + pages.length * 3;
  const fontId = index => blankGlyphId + 1 + index * 2;

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));
  begin(1); push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  const kids = pages.map((_, index) => `${3 + index * 3} 0 R`).join(' ');
  begin(2); push(`<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>\nendobj\n`);
  pages.forEach((page, index) => {
    const pageId = 3 + index * 3;
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    const width = page.width.toFixed(2);
    const height = page.height.toFixed(2);
    const layer = textLayer(pageLines[index], page.height, glyphs);
    const fonts = [...layer.fonts].map(font => `/F${font} ${fontId(font)} 0 R`).join(' ');
    const resources = fonts ? `/Font << ${fonts} >> /ProcSet [/PDF /ImageC /Text]` : '/ProcSet [/PDF /ImageC]';
    begin(pageId);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      `/Resources << /XObject << /Im0 ${imageId} 0 R >> ${resources} >> /Contents ${contentId} 0 R >>\nendobj\n`);
    stream(contentId, `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n${layer.content}`);
    stream(imageId, page.bytes, `/Type /XObject /Subtype /Image /Width ${page.jpegWidth} /Height ${page.jpegHeight} ` +
      '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ');
  });
  if (fontCharacters.length) {
    stream(blankGlyphId, '1000 0 0 -200 1000 800 d1\n');
    fontCharacters.forEach((characters, index) => {
      const id = fontId(index);
      const names = characters.map((_, code) => `/g${code + 1}`);
      const procedures = names.map(name => `${name} ${blankGlyphId} 0 R`).join(' ');
      const widths = characters.map(() => '1000').join(' ');
      begin(id);
      push('<< /Type /Font /Subtype /Type3 /FontBBox [0 -200 1000 800] /FontMatrix [0.001 0 0 0.001 0 0] ' +
        `/CharProcs << /.notdef ${blankGlyphId} 0 R ${procedures} >> ` +
        `/Encoding << /Type /Encoding /Differences [1 ${names.join(' ')}] >> ` +
        `/FirstChar 1 /LastChar ${characters.length} /Widths [${widths}] /Resources << >> /ToUnicode ${id + 1} 0 R >>\nendobj\n`);
      stream(id + 1, unicodeCMap(characters));
    });
  }
  const xref = size;
  push(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (let index = 1; index < offsets.length; index++) {
    push(`${String(offsets[index]).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
