/* The Harness web module loader provides React and the Cordis client context. */
window.__ModuleLoader__.load({
  id: 'dsh-quiet-reader',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } = React;
    const PANEL = 'dsh-quiet-reader';
    const PDF_LIMIT_MB = 40;
    const PDF_LIMIT = PDF_LIMIT_MB * 1024 * 1024;
    let pdfLibrary;

    function endpoint(action, params = {}, write = false) {
      const url = new URL(write ? 'api/dsh-quiet-reader/write' : 'api/dsh-quiet-reader', document.baseURI);
      url.search = new URLSearchParams({ action, ...params }).toString();
      return url.href;
    }

    async function request(action, params, body, signal) {
      const options = { signal };
      if (body !== undefined) {
        options.method = 'POST';
        options.headers = { 'x-quiet-reader': '1' };
        if (body instanceof FormData) options.body = body;
        else {
          options.headers['content-type'] = 'application/json';
          options.body = JSON.stringify(body);
        }
      }
      const response = await fetch(endpoint(action, params, body !== undefined), options);
      const result = await response.json().catch(() => null);
      if (!response.ok || result === null) {
        throw new Error(result?.error ?? '阅读服务暂时不可用，请检查插件是否已启用。');
      }
      return result;
    }

    async function openPdf(data) {
      pdfLibrary ??= import(endpoint('asset', { name: 'pdf.mjs' })).then(pdfjs => {
        pdfjs.GlobalWorkerOptions.workerSrc = endpoint('asset', { name: 'pdf.worker.mjs' });
        return pdfjs;
      }).catch(error => {
        pdfLibrary = undefined;
        throw error;
      });
      const pdfjs = await pdfLibrary;
      const standardFontDataUrl = endpoint('asset', { name: 'standard_fonts/' })
        .replace('standard_fonts%2F', 'standard_fonts/');
      const task = pdfjs.getDocument({
        data, isEvalSupported: false, standardFontDataUrl, useSystemFonts: true,
        disableFontFace: false, useWasm: false, maxImageSize: 20_000_000,
      });
      task.onPassword = () => { void task.destroy(); };
      try {
        return { pdfjs, task, document: await task.promise };
      } catch {
        await task.destroy().catch(() => {});
        throw new Error('无法打开 PDF。请确认文件完整且未加密。');
      }
    }

    function combinePageText(pdfjs, viewport, items, number) {
      const runs = [];
      for (const item of items) {
        if (typeof item.str !== 'string' || !item.str.trim()) continue;
        const matrix = pdfjs.Util.transform(viewport.transform, item.transform);
        const height = Math.hypot(matrix[2], matrix[3]);
        if (height < 1 || !Number.isFinite(matrix[4]) || !Number.isFinite(matrix[5])) continue;
        const x = matrix[4];
        const baseline = matrix[5];
        runs.push({
          text: item.str.trim(), x, right: x + Math.max(item.width, height / 3),
          baseline, top: baseline - height * .86, bottom: baseline + height * .22, height,
        });
      }
      runs.sort((a, b) => a.baseline - b.baseline || a.x - b.x);
      const rows = [];
      for (const run of runs) {
        const row = rows.at(-1);
        if (row && Math.abs(row.baseline - run.baseline) <= 2) row.items.push(run);
        else rows.push({ baseline: run.baseline, items: [run] });
      }
      const lines = [];
      for (const row of rows) {
        row.items.sort((a, b) => a.x - b.x);
        let line;
        for (const run of row.items) {
          const gap = line ? run.x - line.right : Infinity;
          if (line && gap <= Math.max(8, run.height * 1.25)) {
            if (run.text === line.text && Math.abs(run.x - line.x) < .2) continue;
            line.text += gap < run.height * .13 && !/^[\p{Letter}\p{Number}]/u.test(run.text) ? run.text : ' ' + run.text;
            line.right = Math.max(line.right, run.right);
            line.top = Math.min(line.top, run.top);
            line.bottom = Math.max(line.bottom, run.bottom);
          } else {
            line = { ...run };
            lines.push(line);
          }
        }
      }
      const blocks = [];
      for (const line of lines) {
        let match;
        for (let i = blocks.length - 1; i >= 0; i--) {
          const block = blocks[i];
          const gap = line.top - block.bottom;
          if (gap < -.4 || gap > line.height * .7) continue;
          const overlap = Math.min(line.right, block.right) - Math.max(line.x, block.x);
          if (Math.abs(line.x - block.lastX) <= line.height * 1.25 &&
              overlap > Math.min(line.right - line.x, block.right - block.x) * .55 &&
              Math.abs(line.height - block.height) < 2 &&
              !/^[•▪●]/.test(line.text) && block.text.length + line.text.length < 2200) {
            match = block;
            break;
          }
        }
        if (match) {
          match.text += ' ' + line.text;
          match.bottom = line.bottom;
          match.right = Math.max(match.right, line.right);
          match.x = Math.min(match.x, line.x);
          match.lastX = line.x;
        } else {
          blocks.push({ ...line, lastX: line.x });
        }
      }
      const clamp = n => Math.min(1, Math.max(0, n));
      return blocks.map(block => ({
        page: number, text: block.text,
        box: [block.x / viewport.width, block.top / viewport.height,
          block.right / viewport.width, block.bottom / viewport.height].map(clamp),
      })).filter(p => p.box[2] > p.box[0] && p.box[3] > p.box[1]);
    }

    async function parseFile(file, report) {
      if (!file || file.size === 0 || file.size > PDF_LIMIT) {
        throw new Error(`请选择 ${PDF_LIMIT_MB} MB 以内的 PDF。`);
      }
      let handle;
      try {
        handle = await openPdf(new Uint8Array(await file.arrayBuffer()));
        if (handle.document.numPages > 150) throw new Error('第一版支持 150 页以内的 PDF。');
        const pages = [];
        const paragraphs = [];
        let chars = 0;
        for (let page = 1; page <= handle.document.numPages; page++) {
          report(`正在提取第 ${page} / ${handle.document.numPages} 页`);
          const current = await handle.document.getPage(page);
          const viewport = current.getViewport({ scale: 1 });
          pages.push({ width: viewport.width, height: viewport.height });
          const text = await current.getTextContent();
          for (const paragraph of combinePageText(handle.pdfjs, viewport, text.items, page)) {
            if (paragraph.text.length > 2400) throw new Error('存在过长文本行，请拆分或重新导出 PDF。');
            paragraphs.push({ id: paragraphs.length + 1, ...paragraph });
            chars += paragraph.text.length;
          }
          current.cleanup();
          if (chars > 600_000 || paragraphs.length > 2500) throw new Error('文献文字过多，请拆分 PDF。');
        }
        if (!paragraphs.length) throw new Error('这份 PDF 未提取到文字。请上传可选中文本的 PDF。');
        const metadata = await handle.document.getMetadata().catch(() => ({}));
        const embeddedTitle = metadata.info?.Title;
        const title = (typeof embeddedTitle === 'string' && embeddedTitle.trim()) || file.name.replace(/\.pdf$/i, '');
        return { title, pages, paragraphs };
      } finally {
        await handle?.task.destroy();
      }
    }

    function place(box) {
      const [x, y, right, bottom] = box;
      return { left: `${x * 100}%`, top: `${y * 100}%`, width: `${(right - x) * 100}%`, height: `${(bottom - y) * 100}%` };
    }

    function Translation({ paragraph, text, selected, choose }) {
      const ref = useRef(null);
      useLayoutEffect(() => {
        const block = ref.current;
        const measure = () => {
          const { width, height } = block.getBoundingClientRect();
          if (width <= 0 || height <= 0) return;
          let low = .05;
          let high = Math.max(width, height);
          const lineBox = block.firstElementChild;
          for (let i = 0; i < 17; i++) {
            const size = (low + high) / 2;
            block.style.fontSize = size + 'px';
            if (lineBox.getBoundingClientRect().height <= height && lineBox.scrollWidth <= Math.ceil(width)) low = size;
            else high = size;
          }
          block.style.fontSize = Math.floor(low * 100) / 100 + 'px';
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(block);
        return () => observer.disconnect();
      }, [text]);
      return h('div', {
        ref, className: 'qr-translation' + (selected ? ' qr-selected' : ''), style: place(paragraph.box),
        onClick: () => choose(paragraph.id),
      }, h('span', null, text));
    }

    function Pages({ paper, number, selected, choose, zoom }) {
      const original = useRef(null);
      const translated = useRef(null);
      const [pdf, setPdf] = useState(null);
      const [renderedPage, setRenderedPage] = useState(0);
      const [error, setError] = useState('');
      const shownNumber = useRef(number);
      // Hidden translations belong to the page that finished rasterising; only a
      // page change resets that marker, so zooming keeps the current overlay.
      useEffect(() => {
        if (shownNumber.current !== number) {
          shownNumber.current = number;
          setRenderedPage(0);
        }
      }, [number]);
      useEffect(() => {
        const abort = new AbortController();
        let handle;
        setPdf(null);
        setError('');
        void (async () => {
          try {
            const response = await fetch(endpoint('pdf', { id: paper.id }), { signal: abort.signal });
            if (!response.ok) throw new Error('无法读取原始 PDF。');
            handle = await openPdf(new Uint8Array(await response.arrayBuffer()));
            if (abort.signal.aborted) await handle.task.destroy();
            else setPdf(handle.document);
          } catch {
            if (!abort.signal.aborted) setError('原版页面加载失败，请切换文献后重试。');
          }
        })();
        return () => { abort.abort(); if (handle) void handle.task.destroy(); };
      }, [paper.id]);
      useEffect(() => {
        if (!pdf) return;
        let cancelled = false;
        let rendering;
        const source = original.current;
        const copy = translated.current;
        for (const canvas of [source, copy]) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
        // A private canvas prevents a cancelled render from racing a new page.
        const raster = document.createElement('canvas');
        void (async () => {
          try {
            const page = await pdf.getPage(number);
            if (cancelled) return;
            const base = page.getViewport({ scale: 1 });
            const longest = Math.max(base.width, base.height);
            // Rasterise at the displayed size so enlarged pages stay sharp.
            const viewport = page.getViewport({ scale: Math.min(3, (1700 * zoom) / 100 / longest) });
            raster.width = Math.ceil(viewport.width);
            raster.height = Math.ceil(viewport.height);
            rendering = page.render({ canvas: raster, viewport });
            await rendering.promise;
            if (cancelled) return;
            for (const canvas of [source, copy]) {
              canvas.width = raster.width;
              canvas.height = raster.height;
              canvas.getContext('2d').drawImage(raster, 0, 0);
            }
            setRenderedPage(number);
            setError('');
          } catch {
            if (!cancelled) setError('当前页渲染失败。');
          }
        })();
        return () => { cancelled = true; rendering?.cancel(); };
      }, [pdf, number, zoom]);
      const dimensions = paper.pages[number - 1];
      const paragraphs = paper.paragraphs.filter(p => p.page === number);
      const sheetStyle = { aspectRatio: `${dimensions.width} / ${dimensions.height}` };
      return h(React.Fragment, null,
        error && h('p', { className: 'qr-error', role: 'alert' }, error),
        h('div', { className: 'qr-viewport' },
          h('div', { className: 'qr-spread', style: { width: `${zoom}%` } },
          h('section', null, h('h3', null, '英文原文'),
            h('div', { className: 'qr-sheet', style: sheetStyle },
              h('canvas', { ref: original, 'aria-label': `原文第 ${number} 页` }),
              ...paragraphs.map(p => h('button', {
                type: 'button', key: p.id, className: 'qr-source' + (selected === p.id ? ' qr-selected' : ''),
                style: place(p.box), title: `选中段落 ${p.id}`, 'aria-label': `选择段落 ${p.id}`,
                onClick: () => choose(p.id),
              })))),
          h('section', null, h('h3', null, '中文译文'),
            h('div', { className: 'qr-sheet', style: sheetStyle },
              h('canvas', { ref: translated, 'aria-label': `译文底图第 ${number} 页` }),
              ...paragraphs.filter(p => p.kind !== 'skip' && renderedPage === number && paper.translations[p.id]).map(p =>
                h(Translation, { key: p.id, paragraph: p, text: paper.translations[p.id], selected: selected === p.id, choose })))))));
    }

    function apply(ctx) {
      let selectedPaper = '';
      const listeners = new Set();
      const refresh = signal => request('list', {}, undefined, signal);
      const choosePaper = id => {
        selectedPaper = id;
        for (const listener of listeners) listener();
      };
      const subscribe = listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      function ReaderPanel() {
        const id = useSyncExternalStore(subscribe, () => selectedPaper);
        const [library, setLibrary] = useState([]);
        const [paper, setPaper] = useState(null);
        const [number, setNumber] = useState(1);
        const [selected, setSelected] = useState(null);
        const [question, setQuestion] = useState('');
        const [error, setError] = useState('');
        const [busy, setBusy] = useState('');
        const [asking, setAsking] = useState(false);
        const [revision, setRevision] = useState(0);
        const [zoom, setZoom] = useState(() => {
          try {
            const stored = Number(localStorage.getItem('dsh-quiet-reader:zoom'));
            return stored >= 50 && stored <= 300 ? stored : 100;
          } catch { return 100; }
        });
        const file = useRef(null);
        const active = useRef('');
        active.current = id;
        useEffect(() => {
          const controller = new AbortController();
          void refresh(controller.signal).then(setLibrary).catch(e => {
            if (!controller.signal.aborted) setError(e.message);
          });
          return () => controller.abort();
        }, []);
        useEffect(() => {
          setPaper(null);
          setNumber(1);
          setSelected(null);
          setQuestion('');
          setError('');
          setAsking(false);
        }, [id]);
        useEffect(() => {
          if (!id) return;
          const controller = new AbortController();
          let timer;
          const poll = async () => {
            try {
              const result = await request('detail', { id }, undefined, controller.signal);
              if (controller.signal.aborted) return;
              setPaper(current => current?.id === id ? { ...result, history: current.history } : result);
              if (result.status === 'running') timer = setTimeout(poll, 1500);
            } catch (e) {
              if (!controller.signal.aborted) {
                setError(e.message);
                timer = setTimeout(poll, 5000);
              }
            }
          };
          void poll();
          return () => { controller.abort(); clearTimeout(timer); };
        }, [id, revision]);

        async function upload(event) {
          const chosen = event.currentTarget.files[0];
          event.currentTarget.value = '';
          if (!chosen || busy) return;
          setError('');
          setBusy('正在读取 PDF');
          try {
            const document = await parseFile(chosen, setBusy);
            setBusy('正在创建文献工作区');
            const form = new FormData();
            form.set('pdf', chosen);
            form.set('document', JSON.stringify(document));
            const imported = await request('import', {}, form);
            choosePaper(imported.id);
            setLibrary(await refresh());
          } catch (e) {
            setError(e.message || 'PDF 无法解析。请确认文件可打开且未加密。');
          } finally {
            setBusy('');
          }
        }

        async function retry() {
          setError('');
          try {
            const updated = await request('translate', { id }, {});
            if (active.current === id) {
              setPaper(updated);
              setRevision(value => value + 1);
            }
          } catch (e) { if (active.current === id) setError(e.message); }
        }

        async function ask(event) {
          event.preventDefault();
          if (asking || !question.trim()) return;
          setAsking(true);
          setError('');
          try {
            const history = await request('ask', { id }, { question, page: number, selectedId: selected });
            if (active.current === id) {
              setPaper(current => current?.id === id ? { ...current, history } : current);
              setQuestion('');
            }
          } catch (e) { if (active.current === id) setError(e.message); }
          finally { if (active.current === id) setAsking(false); }
        }

        const paragraph = paper?.paragraphs.find(p => p.id === selected);
        const changePage = page => { setNumber(page); setSelected(null); };
        const changeZoom = value => {
          const next = Math.min(300, Math.max(50, Math.round(value)));
          setZoom(next);
          try { localStorage.setItem('dsh-quiet-reader:zoom', String(next)); } catch {}
        };
        return h('main', { className: 'qr-reader' },
          h('link', { rel: 'stylesheet', href: endpoint('asset', { name: 'reader.css' }) }),
          h('header', { className: 'qr-header' },
            h('h1', null, '阅藏 · 阅读模式'),
            h('div', { className: 'qr-actions' },
              h('label', null, '文献 ', h('select', { value: id, onChange: e => choosePaper(e.target.value) },
                h('option', { value: '' }, '选择文献'),
                ...library.map(item => h('option', { key: item.id, value: item.id }, item.title)))),
              h('input', { ref: file, type: 'file', accept: 'application/pdf,.pdf', hidden: true, onChange: upload }),
              h('button', { type: 'button', className: 'qr-primary', disabled: !!busy, onClick: () => file.current.click() }, '上传 PDF'))),
          busy && h('p', { role: 'status' }, busy),
          error && h('p', { className: 'qr-error', role: 'alert' }, error),
          !paper ? h('p', null, id ? '正在打开文献…' : '上传文字型英文 PDF，创建专属工作区并启动全文翻译。只翻译摘要、正文与图表注释，公式和参考文献保留原样。') :
            h(React.Fragment, null,
              h('h2', null, paper.title),
              h('div', { className: 'qr-toolbar' },
                h('div', { className: 'qr-actions' },
                  h('button', { type: 'button', disabled: number === 1, onClick: () => changePage(number - 1) }, '上一页'),
                  h('label', null, '页码 ', h('select', { value: number, onChange: e => changePage(Number(e.target.value)) },
                    ...paper.pages.map((_, i) => h('option', { key: i + 1, value: i + 1 }, i + 1)))),
                  h('button', { type: 'button', disabled: number === paper.pages.length, onClick: () => changePage(number + 1) }, '下一页')),
                h('div', { className: 'qr-actions qr-zoom', role: 'group', 'aria-label': '文献缩放' },
                  h('button', { type: 'button', title: '缩小文献', 'aria-label': '缩小文献', disabled: zoom <= 50, onClick: () => changeZoom(zoom - 25) }, '−'),
                  h('output', { className: 'qr-zoom-value', 'aria-live': 'polite' }, `${zoom}%`),
                  h('button', { type: 'button', title: '放大文献', 'aria-label': '放大文献', disabled: zoom >= 300, onClick: () => changeZoom(zoom + 25) }, '＋'),
                  h('button', { type: 'button', title: '恢复 100%', disabled: zoom === 100, onClick: () => changeZoom(100) }, '重置')),
                h('div', { className: 'qr-actions', role: 'status' },
                  h('span', null, `全文翻译 ${paper.translated} / ${paper.expected ?? paper.paragraphs.length} 段`),
                  h('progress', { value: paper.translated, max: paper.expected ?? paper.paragraphs.length, 'aria-label': '全文翻译进度' }),
                  paper.status !== 'running' && paper.status !== 'complete' &&
                    h('button', { type: 'button', onClick: retry }, '继续全文翻译'))),
              paper.error && h('p', { className: 'qr-error', role: 'alert' }, paper.error),
              h(Pages, { key: paper.id, paper, number, selected, choose: setSelected, zoom }),
              paragraph && h('details', { className: 'qr-selected-text', open: true },
                h('summary', null, `第 ${paragraph.page} 页 · 段落 ${paragraph.id}`),
                h('div', { className: 'qr-spread' }, h('p', null, paragraph.text),
                  h('p', null, paper.translations[paragraph.id] ?? (paragraph.kind === 'skip'
                    ? '该段不翻译（公式、参考文献或页眉），保留原文。'
                    : '该段正在等待翻译。')))),
              h('section', { className: 'qr-chat' },
                h('h3', null, '论文问答'),
                ...paper.history.map((turn, i) => h('article', { key: i },
                  h('strong', null, turn.question), h('p', null, turn.answer),
                  h('div', { className: 'qr-actions' }, h('span', null, '参考片段'), ...turn.references.map(ref =>
                    h('button', { type: 'button', key: ref.id, onClick: () => { setNumber(ref.page); setSelected(ref.id); } },
                      `第 ${ref.page} 页 · 段 ${ref.id}`))))),
                h('form', { onSubmit: ask },
                  h('label', { htmlFor: 'quiet-reader-question' }, selected ? `围绕段落 ${selected} 提问` : '围绕当前论文提问'),
                  h('textarea', { id: 'quiet-reader-question', value: question, maxLength: 1000, rows: 3,
                    onChange: e => setQuestion(e.target.value), placeholder: '例如：作者如何验证方法的有效性？' }),
                  h('button', { className: 'qr-primary', disabled: asking || !question.trim() }, asking ? '正在回答…' : '提问')))));
      }

      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, ReaderPanel));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL, label: '阅读模式', order: 62,
      }, ({ size }) => h('span', { style: { fontSize: size || 16 }, 'aria-hidden': true }, '▤')));
    }

    return { inject: ['slots'], apply };
  },
});
