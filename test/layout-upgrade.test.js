import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createReader } from '../src/host.js';

test('按页升级旧版面时保留相同段落和译文，旧客户端也不回退已升级的页', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-quiet-reader-layout-upgrade-'));
  const pdf = Buffer.from('%PDF-1.7\nLayout upgrade fixture\n%%EOF');
  const id = createHash('sha256').update(pdf).digest('hex');
  const path = join(root, id);
  const reader = createReader({
    workspaceRegistry: { async create() { return { id: 'fixture-workspace' }; } },
    get llm() { assert.fail('Reopening a paper must not request a translation'); },
  }, root);
  t.after(async () => {
    reader.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const pages = Array.from({ length: 3 }, () => ({ width: 612, height: 792 }));
  const first = 'The first page keeps its existing prose.';
  const previousSecond = 'The second page only contains the continuation.';
  const revisedSecond = 'The second page now includes the start and continuation of its paragraph.';
  const paragraph = (id, page, text, box = [.12, .20, .87, .25]) => ({ id, page, text, box });
  const translations = { 1: '第一页保留了原有正文。', 2: '第二页只包含后续内容。' };
  const manifest = join(path, 'paper.json');
  await mkdir(path);
  await writeFile(join(path, 'original.pdf'), pdf);
  await writeFile(join(path, 'translations.json'), JSON.stringify(translations));
  await writeFile(manifest, JSON.stringify({
    id, title: 'Layout upgrade fixture', workspaceId: 'fixture-workspace', schema: 4,
    layoutVersion: 2, layoutPages: [1, 2], importedPages: [1, 2], lastParagraphId: 2,
    range: { first: 1, last: 2 }, pages,
    paragraphs: [paragraph(1, 1, first), paragraph(2, 2, previousSecond)],
  }));

  async function upload(layoutVersion, source) {
    const form = new FormData();
    form.set('pdf', new File([pdf], 'layout.pdf'));
    form.set('document', JSON.stringify({
      title: 'Layout upgrade fixture', pages, layoutVersion,
      range: { first: source.page, last: source.page },
      paragraphs: [{ ...source, id: 1 }],
    }));
    const response = await reader.fetch(new Request('http://127.0.0.1:8767/api/dsh-quiet-reader?action=import', {
      method: 'POST', headers: { 'x-quiet-reader': '1' }, body: form,
    }));
    const result = await response.json();
    assert.equal(response.status, 201, JSON.stringify(result));
    return result;
  }

  const newBox = [.14, .21, .86, .26];
  const upgradedFirst = await upload(6, paragraph(1, 1, first, newBox));
  assert.equal(upgradedFirst.layoutVersion, 6);
  assert.deepEqual(upgradedFirst.layoutPages, [1]);
  assert.deepEqual(upgradedFirst.translations, { 1: translations[1] });
  assert.deepEqual(upgradedFirst.paragraphs[0].box, newBox);
  const partial = JSON.parse(await readFile(manifest, 'utf8'));
  assert.equal(partial.paragraphs.find(p => p.id === 2).text, previousSecond);

  const legacyThird = await upload(2, paragraph(1, 3, 'The third page is newly imported from the old client.'));
  assert.equal(legacyThird.layoutVersion, 6);
  assert.deepEqual(legacyThird.layoutPages, [1]);
  assert.deepEqual(legacyThird.paragraphs.map(p => p.id), [3]);

  const upgradedSecond = await upload(6, paragraph(1, 2, revisedSecond));
  assert.equal(upgradedSecond.layoutVersion, 6);
  assert.deepEqual(upgradedSecond.layoutPages, [1, 2]);
  assert.deepEqual(upgradedSecond.paragraphs.map(p => [p.id, p.text]), [[4, revisedSecond]]);
  assert.deepEqual(upgradedSecond.translations, {});
  assert.deepEqual(JSON.parse(await readFile(join(path, 'translations.json'), 'utf8')), translations);
});
