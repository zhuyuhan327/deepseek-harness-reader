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
    const translationFailureLabels = {
      missing: '未收到有效译文', invalid: '译文内容异常',
      math: '公式或变量未完整保留', incomplete: '译文不完整',
    };
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

    let layoutLibrary;
    let presentationLibrary;
    let exportLibrary;
    const loadLayout = () => layoutLibrary ??= import(endpoint('asset', { name: 'layout.js' })).catch(error => {
      layoutLibrary = undefined;
      throw error;
    });
    const loadPresentation = () => presentationLibrary ??= import(endpoint('asset', { name: 'presentation.js' })).catch(error => {
      presentationLibrary = undefined;
      throw error;
    });
    const loadExporter = () => exportLibrary ??= import(endpoint('asset', { name: 'pdf-export.js' })).catch(error => {
      exportLibrary = undefined;
      throw error;
    });

    async function parseDocument(handle, report, range, filename) {
      const total = handle.document.numPages;
      if (total > 150) throw new Error('第一版支持 150 页以内的 PDF。');
      const first = range?.first ?? 1;
      const last = range?.last ?? total;
      if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > total) {
        throw new Error(`页码范围需在 1–${total} 之间，且起始页不大于结束页。`);
      }
      const pages = [];
      const paragraphs = [];
      const regions = [];
      const { extractPageLayout } = await loadLayout();
      let chars = 0;
      for (let page = 1; page <= total; page++) {
        if (page >= first && page <= last) report(`正在识别第 ${page} / ${last} 页的版面`);
        const current = await handle.document.getPage(page);
        const viewport = current.getViewport({ scale: 1 });
        pages.push({ width: viewport.width, height: viewport.height });
        if (page >= first && page <= last) {
          const layout = await extractPageLayout(handle.pdfjs, current, viewport, page);
          regions.push(...layout.regions.map(region => ({ ...region, page })));
          for (const paragraph of layout.paragraphs) {
            if (paragraph.text.length > 2400) throw new Error('存在过长文本行，请拆分或重新导出 PDF。');
            paragraphs.push({ id: paragraphs.length + 1, ...paragraph });
            chars += paragraph.text.length;
          }
        }
        current.cleanup();
        if (chars > 600_000 || paragraphs.length > 2500) throw new Error('文献文字过多，请拆分 PDF。');
      }
      if (!paragraphs.length) throw new Error('所选页码范围未提取到文字。请换一页或上传可选中文本的 PDF。');
      const metadata = await handle.document.getMetadata().catch(() => ({}));
      const embeddedTitle = metadata.info?.Title;
      const title = (typeof embeddedTitle === 'string' && embeddedTitle.trim()) || String(filename ?? 'paper').replace(/\.pdf$/i, '');
      return { title, pages, paragraphs, regions, layoutVersion: 10, range: { first, last } };
    }

    function place(box) {
      const [x, y, right, bottom] = box;
      return { left: `${x * 100}%`, top: `${y * 100}%`, width: `${(right - x) * 100}%`, height: `${(bottom - y) * 100}%` };
    }

    function canvasToJpeg(canvas) {
      return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
          if (!blob) { reject(new Error('无法生成页面图片。')); return; }
          blob.arrayBuffer().then(buffer => resolve({
            bytes: new Uint8Array(buffer), jpegWidth: canvas.width, jpegHeight: canvas.height,
          })).catch(reject);
        }, 'image/jpeg', 0.96);
      });
    }

    async function sourceTextLines(pdfjs, page, viewport) {
      const { items } = await page.getTextContent();
      return items.flatMap(item => {
        if (!item.str?.trim() || !item.transform || !(item.width > 0)) return [];
        const [a, b, c, d, x, y] = pdfjs.Util.transform(viewport.transform, item.transform);
        if (a <= 0 || Math.abs(b) > a * .2) return [];
        return [{ text: item.str, x, y, width: item.width, size: Math.hypot(c, d) }];
      });
    }

    async function buildPdf(paper, mode, report) {
      const first = paper.range?.first ?? 1;
      const last = paper.range?.last ?? paper.pages.length;
      if (mode !== 'original' && !paper.translated) throw new Error('这篇文献还没有可导出的译文。');
      const response = await fetch(endpoint('pdf', { id: paper.id }));
      if (!response.ok) throw new Error('无法读取原始 PDF。');
      const data = new Uint8Array(await response.arrayBuffer());
      if (mode === 'original' && first === 1 && last === paper.pages.length) return data;
      const [{ paintTranslation, documentBodySize, expectedOverlays }, { buildJpegPdf }] = await Promise.all([loadPresentation(), loadExporter()]);
      const bodySize = documentBodySize(paper.paragraphs);
      await document.fonts?.ready;
      const handle = await openPdf(data);
      const pages = [];
      const source = document.createElement('canvas');
      const translated = document.createElement('canvas');
      const spread = document.createElement('canvas');
      try {
        for (let number = first; number <= last; number++) {
          report(`正在排版第 ${number} / ${last} 页`);
          const page = await handle.document.getPage(number);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(3, 2100 / Math.max(base.width, base.height)) });
          source.width = Math.ceil(viewport.width);
          source.height = Math.ceil(viewport.height);
          try {
            await page.render({ canvas: source, viewport }).promise;
            let output = source;
            let textLines;
            if (mode !== 'original') {
              const paragraphs = paper.paragraphs.filter(p => p.page === number);
              const regions = (paper.regions ?? []).filter(region => region.page === number);
              textLines = paintTranslation(translated, source, base, paragraphs, paper.translations, regions, bodySize);
              const painted = new Set(textLines.map(line => line.paragraphId));
              const omitted = expectedOverlays(paragraphs, paper.translations).filter(p => !painted.has(p.id));
              if (omitted.length) throw new Error(`第 ${number} 页的段落 ${omitted.map(p => p.id).join('、')} 未能完整排版，已停止导出。可先在对照模式查看完整译文。`);
              output = translated;
            }
            if (mode === 'bilingual') {
              spread.width = source.width * 2;
              spread.height = source.height;
              const ctx = spread.getContext('2d');
              ctx.drawImage(source, 0, 0);
              ctx.drawImage(translated, source.width, 0);
              textLines = [
                ...await sourceTextLines(handle.pdfjs, page, base),
                ...textLines.map(line => ({ ...line, x: line.x + base.width })),
              ];
              output = spread;
            } else if (mode === 'original') {
              textLines = await sourceTextLines(handle.pdfjs, page, base);
            }
            pages.push({
              ...await canvasToJpeg(output),
              width: base.width * (mode === 'bilingual' ? 2 : 1), height: base.height,
              textLines,
            });
          } finally {
            for (const canvas of [source, translated, spread]) canvas.width = canvas.height = 0;
            page.cleanup();
          }
        }
        return buildJpegPdf(pages);
      } finally {
        await handle.task.destroy();
      }
    }

    function downloadPdf(bytes, filename) {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    const retainedKinds = {
      formula: '公式',
      table: '表格',
      figure: '图片或图内文字',
      skip: '原文内容',
    };

    function Reflow({ paper, number, selected, choose, zoom }) {
      const target = useRef(null);
      useEffect(() => {
        if (selected != null) target.current?.scrollIntoView({ block: 'nearest' });
      }, [selected, number]);
      const rows = paper.paragraphs.filter(p => p.page === number);
      return h('section', { className: 'qr-reflow', style: { fontSize: `${zoom / 100}em` } },
        h('h3', { className: 'qr-reflow-page' }, `第 ${number} 页`),
        ...rows.map(paragraph => {
          if (retainedKinds[paragraph.kind] && paragraph.kind !== 'formula') return null;
          const translated = paper.translations[paragraph.id];
          return h('article', {
            key: paragraph.id, ref: paragraph.id === selected ? target : null,
            className: `qr-pair ${paragraph.kind}`,
          },
          h('button', {
            type: 'button', className: 'qr-reflow-select', onClick: () => choose(paragraph.id),
            'aria-pressed': paragraph.id === selected,
          }, `段落 ${paragraph.id}`),
          h('p', { className: paragraph.kind === 'formula' ? 'qr-reflow-formula' : 'qr-en' }, paragraph.text),
          paragraph.kind !== 'formula' &&
            h('p', { className: translated ? 'qr-zh' : 'qr-zh qr-pending' }, translated ?? '（待翻译）'));
        }));
    }

    function Pages({ paper, number, selected, choose, zoom }) {
      const original = useRef(null);
      const translated = useRef(null);
      const [pdf, setPdf] = useState(null);
      const [renderer, setRenderer] = useState(null);
      const [rendered, setRendered] = useState(null);
      const [error, setError] = useState('');
      const [layoutError, setLayoutError] = useState('');
      useEffect(() => {
        const abort = new AbortController();
        let handle;
        void (async () => {
          try {
            const response = await fetch(endpoint('pdf', { id: paper.id }), { signal: abort.signal });
            if (!response.ok) throw new Error('无法读取原始 PDF。');
            const presentation = await loadPresentation();
            handle = await openPdf(new Uint8Array(await response.arrayBuffer()));
            await document.fonts?.ready;
            if (abort.signal.aborted) return;
            setRenderer(presentation);
            setPdf(handle.document);
          } catch {
            if (!abort.signal.aborted) setError('原版页面加载失败，请切换文献后重试。');
          } finally {
            if (abort.signal.aborted && handle) await handle.task.destroy().catch(() => {});
          }
        })();
        return () => { abort.abort(); if (handle) void handle.task.destroy().catch(() => {}); };
      }, [paper.id]);
      useEffect(() => {
        if (!pdf) return;
        let cancelled = false;
        let rendering;
        const source = original.current;
        const raster = document.createElement('canvas');
        void (async () => {
          let page;
          try {
            page = await pdf.getPage(number);
            if (cancelled) return;
            const base = page.getViewport({ scale: 1 });
            const longest = Math.max(base.width, base.height);
            const viewport = page.getViewport({ scale: Math.min(4, (1700 * zoom) / 100 / longest) });
            raster.width = Math.ceil(viewport.width);
            raster.height = Math.ceil(viewport.height);
            rendering = page.render({ canvas: raster, viewport });
            await rendering.promise;
            if (cancelled) return;
            source.width = raster.width;
            source.height = raster.height;
            source.getContext('2d').drawImage(raster, 0, 0);
            setRendered({ number });
            setError('');
          } catch {
            if (!cancelled) setError('当前页渲染失败。');
          } finally {
            raster.width = raster.height = 0;
            page?.cleanup();
          }
        })();
        return () => { cancelled = true; rendering?.cancel(); };
      }, [pdf, number, zoom]);
      const dimensions = paper.pages[number - 1];
      const paragraphs = paper.paragraphs.filter(p => p.page === number);
      const regions = (paper.regions ?? []).filter(region => region.page === number);
      const ready = rendered?.number === number;
      const bodySize = renderer?.documentBodySize(paper.paragraphs);
      // Polling progress or call counts does not change page pixels.
      const pageContent = JSON.stringify([dimensions, paragraphs, regions, paragraphs.map(p => paper.translations[p.id]), bodySize]);
      useLayoutEffect(() => {
        if (ready && renderer && dimensions) {
          const lines = renderer.paintTranslation(translated.current, original.current, dimensions, paragraphs, paper.translations, regions, bodySize);
          const painted = new Set(lines.map(line => line.paragraphId));
          const omitted = renderer.expectedOverlays(paragraphs, paper.translations).filter(p => !painted.has(p.id));
          setLayoutError(omitted.length ? `段落 ${omitted.map(p => p.id).join('、')} 暂无法在原位置完整排版，请切换对照模式查看完整译文。` : '');
        }
      }, [rendered, renderer, number, pageContent]);
      if (!dimensions) return null;
      const sheetStyle = { aspectRatio: `${dimensions.width} / ${dimensions.height}` };
      const paragraphButton = p => h('button', {
        type: 'button', key: p.id, className: 'qr-source' + (selected === p.id ? ' qr-selected' : ''),
        style: place(p.box), title: `查看第 ${p.id} 段`, 'aria-label': `选择段落 ${p.id}`,
        'aria-pressed': selected === p.id, onClick: () => choose(p.id),
      });
      return h(React.Fragment, null,
        error && h('p', { className: 'qr-error', role: 'alert' }, error),
        layoutError && h('p', { className: 'qr-error', role: 'alert' }, layoutError),
        h('div', { className: 'qr-viewport' },
          h('div', { className: 'qr-spread', style: { width: `${zoom}%` } },
            h('section', null, h('h3', null, '英文原文'),
              h('div', { className: 'qr-sheet', style: sheetStyle },
                h('canvas', { ref: original, style: { visibility: ready ? 'visible' : 'hidden' }, 'aria-label': `原文第 ${number} 页` }),
                ...(ready ? paragraphs.map(paragraphButton) : []))),
            h('section', null, h('h3', null, '中文译文'),
              h('div', { className: 'qr-sheet', style: sheetStyle },
                h('canvas', { ref: translated, style: { visibility: ready ? 'visible' : 'hidden' }, 'aria-label': `译文第 ${number} 页` }),
                ...(ready ? paragraphs.filter(p => paper.translations[p.id]).map(paragraphButton) : []))))));
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
      function ReaderPanel(props) {
        const id = useSyncExternalStore(subscribe, () => selectedPaper);
        const useWorkspaces = props && typeof props.useWorkspaces === 'function' ? props.useWorkspaces : null;
        const useSession = props && typeof props.useSession === 'function' ? props.useSession : null;
        const workspaceState = useWorkspaces ? useWorkspaces(state => state) : null;
        const sessionState = useSession ? useSession(state => state ?? null) : null;
        const [library, setLibrary] = useState([]);
        const [paper, setPaper] = useState(null);
        const [number, setNumber] = useState(1);
        const [selected, setSelected] = useState(null);
        const [question, setQuestion] = useState('');
        const [error, setError] = useState('');
        const [busy, setBusy] = useState('');
        const [asking, setAsking] = useState(false);
        const [revision, setRevision] = useState(0);
        const [pending, setPending] = useState(null);
        const [fromPage, setFromPage] = useState('');
        const [toPage, setToPage] = useState('');
        const [exportOpen, setExportOpen] = useState(false);
        const [exportMode, setExportMode] = useState('bilingual');
        const [exporting, setExporting] = useState(false);
        const [viewMode, setViewMode] = useState('overlay');
        const [models, setModels] = useState({ current: null, providers: [] });
        const [efforts, setEfforts] = useState([]);
        const [effortsLoading, setEffortsLoading] = useState(false);
        const effortRequest = useRef(0);
        const [zoom, setZoom] = useState(() => {
          try {
            const stored = Number(localStorage.getItem('dsh-quiet-reader:zoom'));
            return stored >= 50 && stored <= 300 ? stored : 100;
          } catch { return 100; }
        });
        const file = useRef(null);
        const active = useRef('');
        active.current = id;
        useEffect(() => () => {
          if (pending) void pending.handle.task.destroy().catch(() => {});
        }, [pending]);
        useEffect(() => {
          const controller = new AbortController();
          void refresh(controller.signal).then(setLibrary).catch(e => {
            if (!controller.signal.aborted) setError(e.message);
          });
          return () => controller.abort();
        }, []);
        // Model catalogue and the saved choice: read from Harness on every open
        // so models released later show up without a plugin update.
        useEffect(() => {
          const controller = new AbortController();
          void request('settings', {}, undefined, controller.signal).then(saved => {
            setModels(saved);
            const current = saved?.current;
            if (current?.provider && current?.model) void refreshEfforts(current.provider, current.model);
          }).catch(() => {});
          return () => controller.abort();
        }, []);
        // Workspaces added or removed in the DSH sidebar show up here: refresh
        // the library, follow the selected workspace, and drop a paper whose
        // workspace disappeared.
        useEffect(() => {
          if (!workspaceState) return;
          let cancelled = false;
          void refresh().then(items => {
            if (cancelled) return;
            setLibrary(items);
            const items2 = workspaceState.items ?? [];
            const sessionId = sessionState?.sessionId ?? sessionState?.id;
            const workspace = sessionId !== undefined
              ? items2.find(item => (item.sessionIds ?? []).includes(sessionId))
              : undefined;
            if (workspace) {
              const match = items.find(item => item.workspaceId === workspace.workspaceId);
              if (match && match.id !== selectedPaper) choosePaper(match.id);
            }
            if (selectedPaper && !items.some(item => item.id === selectedPaper)) {
              choosePaper('');
            }
          }).catch(() => {});
          return () => { cancelled = true; };
        }, [workspaceState, sessionState]);
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

        async function chooseFile(event) {
          const chosen = event.currentTarget.files[0];
          event.currentTarget.value = '';
          if (!chosen || busy) return;
          if (chosen.size === 0 || chosen.size > PDF_LIMIT) {
            setError(`请选择 ${PDF_LIMIT_MB} MB 以内的 PDF。`);
            return;
          }
          setError('');
          setBusy('正在读取 PDF');
          try {
            const handle = await openPdf(new Uint8Array(await chosen.arrayBuffer()));
            if (handle.document.numPages > 150) {
              await handle.task.destroy();
              throw new Error('第一版支持 150 页以内的 PDF。');
            }
            setPending({ file: chosen, handle, numPages: handle.document.numPages });
            setFromPage('1');
            setToPage(String(handle.document.numPages));
          } catch (e) {
            setError(e.message || 'PDF 无法打开。请确认文件完整且未加密。');
          } finally {
            setBusy('');
          }
        }

        function cancelPending() {
          setPending(null);
          setBusy('');
        }

        async function importDocument(chosen, handle, range) {
          const parsed = await parseDocument(handle, setBusy, range, chosen.name);
          setBusy('正在保存文献版面');
          const form = new FormData();
          form.set('pdf', chosen);
          form.set('document', JSON.stringify(parsed));
          return request('import', {}, form);
        }

        async function confirmRange() {
          if (!pending) return;
          const { file: chosen, handle, numPages } = pending;
          const first = Number(fromPage);
          const last = Number(toPage);
          if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > numPages) {
            setError(`页码范围需在 1–${numPages} 之间，且起始页不能大于结束页。`);
            return;
          }
          setError('');
          setBusy('正在读取 PDF');
          try {
            const imported = await importDocument(chosen, handle, { first, last });
            if (active.current === imported.id) {
              setPaper(imported);
              setRevision(value => value + 1);
            }
            choosePaper(imported.id);
            setPending(null);
            setLibrary(await refresh());
          } catch (e) {
            setError(e.message || 'PDF 无法解析。请确认文件可打开且未加密。');
          } finally {
            setBusy('');
          }
        }

        async function refreshLayout() {
          if (!paper || busy) return;
          setBusy('正在读取原始 PDF');
          setError('');
          let handle;
          try {
            const response = await fetch(endpoint('pdf', { id }));
            if (!response.ok) throw new Error('无法读取原始 PDF。');
            const chosen = new File([await response.blob()], `${paper.title}.pdf`, { type: 'application/pdf' });
            handle = await openPdf(new Uint8Array(await chosen.arrayBuffer()));
            const updated = await importDocument(chosen, handle, { first: firstPage, last: lastPage });
            if (active.current === id) {
              setPaper(updated);
              setRevision(value => value + 1);
            }
          } catch (e) {
            if (active.current === id) setError(e.message);
          } finally {
            if (handle) await handle.task.destroy().catch(() => {});
            setBusy('');
          }
        }

        async function refreshEfforts(provider, model) {
          const token = ++effortRequest.current;
          setEffortsLoading(true);
          try {
            const info = await request('modelInfo', { provider, model });
            if (effortRequest.current === token) setEfforts(info.efforts ?? []);
          } catch {
            if (effortRequest.current === token) setEfforts([]);
          } finally {
            if (effortRequest.current === token) setEffortsLoading(false);
          }
        }

        async function chooseModel(patch) {
          const next = { ...(models.current ?? {}), ...patch };
          // Update the picker immediately; the effort list follows in parallel.
          setModels(state => ({ ...state, current: next }));
          if (patch.provider || patch.model) void refreshEfforts(next.provider, next.model);
          try {
            const saved = await request('settings', {}, next);
            setModels(saved);
          } catch (e) { setError(e.message); }
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

        async function pauseTranslation() {
          setError('');
          try {
            const updated = await request('pause', { id }, {});
            if (active.current === id) {
              setPaper(updated);
              setRevision(value => value + 1);
            }
          } catch (e) { if (active.current === id) setError(e.message); }
        }

        async function clearTranslations() {
          if (!paper || busy) return;
          if (!window.confirm('确定清除这篇文献的全部译文与问答记录吗？原文和工作区会保留。')) return;
          setError('');
          try {
            const updated = await request('reset', { id }, {});
            if (active.current === id) {
              setPaper(updated);
              setRevision(value => value + 1);
            }
          } catch (e) { if (active.current === id) setError(e.message); }
        }

        async function deletePaper() {
          if (!paper || busy) return;
          if (!window.confirm(`确定删除《${paper.title}》吗？原文、译文与问答记录都会被删除，且无法恢复。`)) return;
          setError('');
          try {
            await request('delete', { id }, {});
            choosePaper('');
            setPaper(null);
            setLibrary(await refresh());
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

        async function exportPdf() {
          if (!paper || exporting) return;
          const label = exportMode === 'original' ? '原文' : exportMode === 'translation' ? '译文' : '双语对照';
          const filename = `${paper.title.replace(/[\\/:*?"<>|]/g, '_')}-${label}.pdf`;
          let target = null;
          if (typeof window.showSaveFilePicker === 'function') {
            try {
              target = await window.showSaveFilePicker({
                suggestedName: filename,
                types: [{ description: 'PDF 文件', accept: { 'application/pdf': ['.pdf'] } }],
              });
            } catch (e) {
              if (e && e.name === 'AbortError') return;
              if (!['SecurityError', 'NotSupportedError'].includes(e?.name)) {
                setError(`无法打开保存对话框：${e?.message || e?.name || '未知错误'}`);
                return;
              }
            }
          }
          setExporting(true);
          setError('');
          try {
            const bytes = await buildPdf(paper, exportMode, setBusy);
            if (target) {
              const writable = await target.createWritable();
              await writable.write(new Blob([bytes], { type: 'application/pdf' }));
              await writable.close();
            } else {
              downloadPdf(bytes, filename);
            }
            setExportOpen(false);
          } catch (e) {
            setError(e.message || '导出失败，请重试。');
          } finally {
            setBusy('');
            setExporting(false);
          }
        }

        const paragraph = paper?.paragraphs.find(p => p.id === selected);
        const changePage = page => { setNumber(page); setSelected(null); };
        const firstPage = paper?.range?.first ?? 1;
        const lastPage = paper?.range?.last ?? paper?.pages.length ?? 1;
        const layoutPages = new Set(paper?.layoutPages);
        const needsLayout = paper && (paper.layoutVersion !== 10 ||
          Array.from({ length: lastPage - firstPage + 1 }, (_, i) => firstPage + i).some(page => !layoutPages.has(page)));
        const activeParagraphs = new Set(paper?.paragraphs.map(p => p.id));
        const untranslated = (paper?.paragraphs ?? []).filter(p =>
          [undefined, 'text', 'heading', 'caption'].includes(p.kind) && !paper.translations[p.id]?.trim());
        const untranslatedPages = [...new Set(untranslated.map(p => p.page))];
        useEffect(() => {
          if (!paper) return;
          const first = paper.range?.first ?? 1;
          const last = paper.range?.last ?? paper.pages.length;
          setNumber(value => Math.min(Math.max(value, first), last));
        }, [paper?.id, firstPage, lastPage]);
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
              h('input', { ref: file, type: 'file', accept: 'application/pdf,.pdf', hidden: true, onChange: chooseFile }),
              h('button', { type: 'button', className: 'qr-primary', disabled: !!busy || !!pending, onClick: () => file.current.click() }, '上传 PDF'))),
          h('p', { className: 'qr-hint' }, '上传后会先让你选择页码范围。只翻译所选页的标题、正文与图注，公式与参考文献保持原样。'),
          pending && h('section', { className: 'qr-dialog', role: 'dialog', 'aria-label': '选择页码范围' },
            h('h3', null, '选择要翻译的页码范围'),
            h('p', null, `本篇共 ${pending.numPages} 页，最大不超过 ${pending.numPages} 页。`),
            h('div', { className: 'qr-actions' },
              h('label', null, '从第 ',
                h('input', {
                  type: 'number', min: 1, max: pending.numPages, value: fromPage, 'aria-label': '起始页',
                  onChange: e => setFromPage(e.target.value),
                }), ' 页'),
              h('label', null, '到第 ',
                h('input', {
                  type: 'number', min: 1, max: pending.numPages, value: toPage, 'aria-label': '结束页',
                  onChange: e => setToPage(e.target.value),
                }), ' 页')),
            h('p', { className: 'qr-hint' }, `格式：1–${pending.numPages} 的整数，起始页不能大于结束页。`),
            h('div', { className: 'qr-actions' },
              h('button', { type: 'button', className: 'qr-primary', disabled: !!busy, onClick: confirmRange },
                busy ? '正在处理…' : '开始解析并翻译'),
              h('button', { type: 'button', disabled: !!busy, onClick: cancelPending }, '取消'))),
          busy && h('p', { role: 'status' }, busy),
          error && h('p', { className: 'qr-error', role: 'alert' }, error),
          !paper ? h('p', null, id ? '正在打开文献…' : '上传文字型英文 PDF，创建专属工作区并启动全文翻译。只翻译摘要、正文与图表注释，公式和参考文献保留原样。') :
            h(React.Fragment, null,
              h('h2', null, paper.title),
              h('div', { className: 'qr-toolbar' },
                h('div', { className: 'qr-actions' },
                  h('button', { type: 'button', disabled: number <= firstPage, onClick: () => changePage(number - 1) }, '上一页'),
                  h('label', null, '页码 ', h('select', { value: number, onChange: e => changePage(Number(e.target.value)) },
                    ...paper.pages.slice(firstPage - 1, lastPage).map((_, i) =>
                      h('option', { key: i + firstPage, value: i + firstPage }, i + firstPage)))),
                  h('button', { type: 'button', disabled: number >= lastPage, onClick: () => changePage(number + 1) }, '下一页'),
                  h('button', { type: 'button', onClick: () => setViewMode(value => value === 'overlay' ? 'reflow' : 'overlay') },
                    viewMode === 'overlay' ? '对照模式' : '覆盖模式')),
                h('div', { className: 'qr-actions qr-zoom', role: 'group', 'aria-label': '文献缩放' },
                  h('button', { type: 'button', title: '缩小文献', 'aria-label': '缩小文献', disabled: zoom <= 50, onClick: () => changeZoom(zoom - 25) }, '−'),
                  h('output', { className: 'qr-zoom-value', 'aria-live': 'polite' }, `${zoom}%`),
                  h('button', { type: 'button', title: '放大文献', 'aria-label': '放大文献', disabled: zoom >= 300, onClick: () => changeZoom(zoom + 25) }, '＋'),
                  h('button', { type: 'button', title: '恢复 100%', disabled: zoom === 100, onClick: () => changeZoom(100) }, '重置')),
                h('div', { className: 'qr-actions qr-model', role: 'group', 'aria-label': '翻译模型' },
                  h('label', null, '模型 ',
                    h('select', {
                      value: models.current ? `${models.current.provider}::${models.current.model}` : '',
                      'aria-label': '翻译模型',
                      onChange: e => {
                        const [provider, model] = e.target.value.split('::');
                        void chooseModel({ provider, model, reasoningEffort: '' });
                      },
                    }, ...(models.providers ?? []).map(provider => h('optgroup', { key: provider.id, label: provider.name },
                      provider.models.map(model => h('option', {
                        key: `${provider.id}::${model.id}`, value: `${provider.id}::${model.id}`,
                      }, model.name)))))),
                  h('label', null, '推理 ',
                    h('select', {
                      value: models.current?.reasoningEffort ?? '',
                      'aria-label': '推理强度',
                      disabled: effortsLoading || !efforts.length,
                      title: effortsLoading ? '正在读取该模型的推理强度…'
                        : efforts.length ? '' : '该模型没有可调的推理强度，换用带思考的模型后可调',
                      onChange: e => void chooseModel({ reasoningEffort: e.target.value }),
                    },
                    h('option', { value: '' }, effortsLoading ? '读取中…' : efforts.length ? '默认' : '不支持'),
                    ...efforts.map(effort => h('option', { key: effort.id, value: effort.id }, effort.name)))),
                  h('label', null, '翻译方式 ',
                    h('select', {
                      value: models.current?.translationMode ?? 'economy', 'aria-label': '翻译方式',
                      title: '省费翻译在模型支持时关闭深度思考；论文问答仍使用上方的推理设置。下次开始翻译时生效。',
                      onChange: e => void chooseModel({ translationMode: e.target.value }),
                    }, h('option', { value: 'economy' }, '快速省费'),
                    h('option', { value: 'custom' }, '使用所选推理强度')))),
                models.current?.translationMode !== 'custom' && h('p', { className: 'qr-hint' },
                  '快速省费会在模型支持时关闭翻译的深度思考；论文问答仍使用上方的推理设置。'),
                h('div', { className: 'qr-actions', role: 'status' },
                  h('span', null, `全文翻译 ${paper.translated} / ${paper.expected ?? paper.paragraphs.length} 段`),
                  paper.translationStats?.requests > 0 && h('span', { className: 'qr-hint' },
                    `本次模型调用 ${paper.translationStats.requests} 次，其中补译 ${paper.translationStats.repairs} 次`),
                  h('progress', { value: paper.translated, max: paper.expected ?? paper.paragraphs.length, 'aria-label': '全文翻译进度' }),
                  paper.status !== 'running' && paper.status !== 'complete' &&
                    h('button', { type: 'button', onClick: retry, disabled: !!busy }, '继续全文翻译'),
                  paper.status === 'running' && h('button', {
                    type: 'button', onClick: pauseTranslation, disabled: !!busy,
                    title: '停止后续模型请求，保留已完成的译文。',
                  }, '暂停翻译'),
                  needsLayout && h('button', {
                    type: 'button', onClick: refreshLayout, disabled: !!busy || paper.status === 'running',
                  }, '重新识别版面'),
                  h('button', { type: 'button', onClick: clearTranslations, disabled: !!busy }, '清除译文'),
                  h('button', { type: 'button', onClick: deletePaper, disabled: !!busy }, '删除文献'),
                  h('button', { type: 'button', onClick: () => setExportOpen(value => !value), disabled: exporting }, '导出 PDF'))),
              exportOpen && h('section', { className: 'qr-export' },
                h('h3', null, '导出 PDF'),
                h('div', { className: 'qr-export-options' },
                  ...[['original', '原文'], ['translation', '译文'], ['bilingual', '双语对照']].map(([value, label]) =>
                    h('label', { key: value },
                      h('input', {
                        type: 'radio', name: 'qr-export-mode', value, checked: exportMode === value,
                        onChange: () => setExportMode(value),
                      }), ` ${label}`))),
                h('p', { className: 'qr-hint' }, `范围：第 ${firstPage}–${lastPage} 页。`),
                exportMode !== 'original' && paper.translated < paper.expected &&
                  h('p', { className: 'qr-hint' }, `译文进度 ${paper.translated} / ${paper.expected} 段。未译段落随原文保留。`),
                exportMode !== 'original' && untranslated.length > 0 && h('p', { className: 'qr-error' },
                  `第 ${untranslatedPages.join('、')} 页还有 ${untranslated.length} 段未完成翻译，当前导出会保留这些段落的原文。`,
                  paper.status !== 'running' && h('button', { type: 'button', onClick: retry, disabled: !!busy }, '补齐缺失译文')),
                h('div', { className: 'qr-actions' },
                  h('button', {
                    type: 'button', className: 'qr-primary',
                    disabled: exporting || (exportMode !== 'original' && !paper.translated), onClick: exportPdf,
                  },
                    exporting ? '正在生成…' : '导出'),
                  h('button', { type: 'button', disabled: exporting, onClick: () => setExportOpen(false) }, '取消'))),
              paper.error && h('p', { className: 'qr-error', role: 'alert' }, paper.error),
              paper.failedParagraphs?.length > 0 && h('div', { className: 'qr-actions' },
                ...paper.failedParagraphs.map(failure => h('button', {
                  key: failure.id, type: 'button',
                  onClick: () => { setNumber(failure.page); setSelected(failure.id); },
                }, `第 ${failure.page} 页 · 段 ${failure.id} · ${translationFailureLabels[failure.reason] ?? '待重试'}`))),
              viewMode === 'overlay'
                ? h(Pages, { key: paper.id, paper, number, selected, choose: setSelected, zoom })
                : h(Reflow, { key: `${paper.id}-reflow`, paper, number, selected, choose: setSelected, zoom }),
              paragraph && h('details', { className: 'qr-selected-text', open: true },
                h('summary', null, `第 ${paragraph.page} 页 · 段落 ${paragraph.id}`),
                h('div', { className: 'qr-spread' }, h('p', null, paragraph.text),
                  h('p', null, paper.translations[paragraph.id] ?? (retainedKinds[paragraph.kind]
                    ? `${retainedKinds[paragraph.kind]}按原版保留。`
                    : '该段正在等待翻译。')))),
              h('section', { className: 'qr-chat' },
                h('h3', null, '论文问答'),
                ...paper.history.map((turn, i) => h('article', { key: i },
                  h('strong', null, turn.question), h('p', null, turn.answer),
                  h('div', { className: 'qr-actions' }, ...turn.references.filter(ref => activeParagraphs.has(ref.id)).map(ref =>
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
