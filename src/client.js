/* 阅藏 · 阅读模式面板（单文件 loader 模块）
   ────────────────────────────────────────────────────────────────
   Harness web ModuleLoader 只暴露 require('react')，模块拆分只适用于
   懒加载的 asset 模块（layout.js / presentation.js / pdf-export.js），
   因此本文件保持单模块、按节组织：
     1. 配置（CONFIG）与文案字典（STRINGS + t）
     2. 基础组件（ErrorBoundary / Modal）
     3. 数据层（endpoint / request）
     4. PDF 装载、解析与导出
     5. Markdown-lite 富文本
     6. 阅读面（覆盖模式 Pages / 对照模式 Reflow）
     7. 工作台外壳（ReaderPanel：命令栏 / 阅读区 / 检查器 / 状态栏）
     8. 侧栏文献树（ReaderTree）与插件注册 */
window.__ModuleLoader__.load({
  id: 'dsh-quiet-reader',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } = React;
    const PANEL = 'dsh-quiet-reader';

    /* ═══ 1. 配置与文案 ═══════════════════════════════════════════
       所有产品上限、节奏参数与可调档位集中在这里；改数字不用翻业务代码。 */
    const CONFIG = {
      pdfLimitMB: 40,
      maxPages: 150,
      maxParagraphChars: 2400,
      maxTotalChars: 600_000,
      maxParagraphs: 2500,
      layoutVersion: 16,
      poll: {
        libraryMs: 3000,          // 文献列表轮询（可见时）
        detailMs: 1500,           // 翻译中的详情轮询
        hiddenLibraryMs: 15000,   // 面板隐藏时的列表巡检
        hiddenDetailMs: 10000,    // 面板隐藏时的详情巡检
        failBaseMs: 5000,         // 详情轮询失败退避基数
        backoffMaxMs: 30000,      // 指数退避上限
      },
      toastMs: 4000,
      toastMax: 4,                // 同时可见的 Toast 上限
      zoom: { min: 50, max: 300, step: 25, default: 100 },
      search: { maxResults: 20, snippetLength: 60 },
      questionMaxLength: 1000,
      composerMaxHeight: 160,
      export: {
        rasterLongest: 2100,      // 导出栅格化最长边像素
        rasterMaxScale: 3,
        viewRasterLongest: 1700,  // 面板内查看的栅格化最长边像素
        viewMaxScale: 4,
        jpegQuality: 0.96,
        revokeMs: 5000,           // ObjectURL 延迟回收
      },
      pdfjs: { maxImageSize: 20_000_000 },
      storage: {
        zoom: 'dsh-quiet-reader:zoom',
        position: paperId => `dsh-quiet-reader:pos:${paperId}`,
        lastPaper: workspaceId => `dsh-quiet-reader:last:${workspaceId}`,
      },
    };
    const PDF_LIMIT = CONFIG.pdfLimitMB * 1024 * 1024;

    /* 全部面向用户的文案。新增语言时复制本字典翻译即可；t() 支持 {var} 插值，
       缺失键回退为键名本身，便于在界面上直接发现漏配。 */
    const STRINGS = {
      app: {
        title: '阅藏',
        panelLabel: '阅读模式',
      },
      boundary: {
        title: '阅读模式暂时不可用',
        message: '界面出现异常：{message}。可以重试，已保存的文献与译文不受影响。',
        retry: '重试',
        unknown: '未知错误',
      },
      error: {
        serviceUnavailable: '阅读服务暂时不可用，请检查插件是否已启用。',
        pdfOpen: '无法打开 PDF。请确认文件完整且未加密。',
        pdfOpenFallback: 'PDF 无法打开。请确认文件完整且未加密。',
        pdfParseFallback: 'PDF 无法解析。请确认文件可打开且未加密。',
        pdfFetch: '无法读取原始 PDF。',
        pageLimit: '第一版支持 {max} 页以内的 PDF。',
        rangeInvalid: '页码范围需在 1–{total} 之间，且起始页不能大于结束页。',
        pageRangeOrder: '页码范围需在 1–{total} 之间，且起始页不大于结束页。',
        lineTooLong: '存在过长文本行，请拆分或重新导出 PDF。',
        tooMuchText: '文献文字过多，请拆分 PDF。',
        noText: '所选页码范围未提取到文字。请换一页或上传可选中文本的 PDF。',
        jpeg: '无法生成页面图片。',
        noTranslation: '这篇文献还没有可导出的译文。',
        exportLayout: '第 {page} 页的段落 {ids} 未能完整排版，已停止导出。可先在对照模式查看完整译文。',
        overlayLayout: '段落 {ids} 暂无法在原位置完整排版，请切换对照模式查看完整译文。',
        pageLoad: '原版页面加载失败，请切换文献后重试。',
        pageRender: '当前页渲染失败。',
        workspaceRequired: '请先选择工作区。',
        workspaceChangedPaper: '工作区已切换，请重新打开文献。',
        workspaceChangedPdf: '工作区已切换，请重新选择 PDF。',
        pickerNotReady: '文件夹选择器尚未就绪，请稍后重试。',
        pdfSize: '请选择 {limit} MB 以内的 PDF。',
        saveDialog: '无法打开保存对话框：{message}',
        unknown: '未知错误',
        exportFallback: '导出失败，请重试。',
      },
      busy: {
        pickWorkspace: '正在选择工作区',
        readPdf: '正在读取 PDF',
        readOriginalPdf: '正在读取原始 PDF',
        saveLayout: '正在保存文献版面',
        parseLayout: '正在识别第 {page} / {last} 页的版面',
        exportPage: '正在排版第 {page} / {last} 页',
      },
      toast: {
        imported: '《{title}》已导入，开始全文翻译。',
        settingsSaved: '模型设置已保存，下一次翻译或问答时生效。',
        paused: '翻译已暂停，已完成的译文都已保存。',
        cleared: '译文已清除，原文、问答记录和文献目录已保留。',
        deleted: '已删除《{title}》。',
        exported: 'PDF 已导出。',
        exportCancelled: '已取消导出。',
        copied: '{label}已复制。',
        copyFailed: '复制失败，请手动选择文本复制。',
      },
      labels: {
        retained: {
          formula: '公式',
          table: '表格',
          figure: '图片或图内文字',
          skip: '原文内容',
        },
        kind: { heading: '标题', caption: '图注', formula: '公式', text: '正文' },
        failure: {
          missing: '未收到有效译文',
          invalid: '译文内容异常',
          math: '公式或变量未完整保留',
          incomplete: '译文不完整',
        },
        failureFallback: '待重试',
        source: '原文',
        translation: '译文',
      },
      common: {
        cancel: '取消',
        processing: '正在处理…',
        pageParagraph: '第 {page} 页 · 段 {id}',
      },
      badge: {
        translating: '翻译中 {translated} / {expected}',
        pendingFix: '{count} 段待修复',
        complete: '翻译完成',
        idle: '翻译待继续',
      },
      gate: {
        loading: '正在读取工作区…',
        current: '当前工作区：{path}',
        prompt: '请先选择一个文件夹作为阅读工作区，再上传或打开文献。',
        switch: '切换工作区',
        choose: '选择工作区文件夹',
        hint: '上传后会先让你选择页码范围。只翻译所选页的标题、正文与图注，公式与参考文献保持原样。',
      },
      command: {
        pickerLabel: '文献 ',
        pickerPlaceholder: '选择文献',
        upload: '上传 PDF',
        settings: '设置',
        export: '导出 PDF',
      },
      search: {
        ariaLabel: '全文检索',
        placeholder: '搜索原文或译文…',
        resultsLabel: '搜索结果',
        empty: '没有匹配的段落。',
      },
      range: {
        label: '选择页码范围',
        title: '选择要翻译的页码范围',
        summary: '本篇共 {total} 页，最大不超过 {total} 页。',
        from: '从第 ',
        to: '到第 ',
        pageUnit: ' 页',
        fromLabel: '起始页',
        toLabel: '结束页',
        formatHint: '格式：1–{total} 的整数，起始页不能大于结束页。',
        confirm: '开始解析并翻译',
      },
      settings: {
        label: '阅读设置',
        title: '模型与翻译设置',
        model: '模型 ',
        modelLabel: '翻译模型',
        effort: '推理 ',
        effortLabel: '推理强度',
        effortLoadingTitle: '正在读取该模型的推理强度…',
        effortUnsupportedTitle: '该模型没有可调的推理强度，换用带思考的模型后可调',
        effortLoading: '读取中…',
        effortDefault: '默认',
        effortUnsupported: '不支持',
        mode: '翻译方式 ',
        modeLabel: '翻译方式',
        modeEconomy: '快速省费',
        modeCustom: '使用所选推理强度',
        modeCustomShort: '自定义推理',
        modeHint: '快速省费会在模型支持时关闭翻译的深度思考；论文问答仍使用上方的推理设置。下次开始翻译时生效。',
        done: '完成',
      },
      empty: {
        opening: '正在打开文献…',
        hint: '上传文字型英文 PDF，在所选工作区创建文献子目录并启动全文翻译。只翻译摘要、正文与图表注释，公式和参考文献保留原样。',
      },
      toolbar: {
        pagingLabel: '翻页',
        prevPage: '上一页',
        prevPageTitle: '上一页（←）',
        nextPage: '下一页',
        nextPageTitle: '下一页（→）',
        pageLabel: '页码',
        reflowMode: '对照模式',
        overlayMode: '覆盖模式',
        progress: '全文翻译 {translated} / {expected} 段',
        progressLabel: '全文翻译进度',
        resume: '继续全文翻译',
        pause: '暂停翻译',
        pauseTitle: '停止后续模型请求，保留已完成的译文。',
        relayout: '重新识别版面',
        clear: '清除译文',
        delete: '删除文献',
      },
      zoom: {
        groupLabel: '文献缩放',
        outTitle: '缩小文献（Ctrl+滚轮）',
        outLabel: '缩小文献',
        inTitle: '放大文献（Ctrl+滚轮）',
        inLabel: '放大文献',
        resetTitle: '恢复 100%',
        reset: '重置',
        fit: '适宽',
        fitTitle: '适应面板宽度',
      },
      export: {
        title: '导出 PDF',
        modeOriginal: '原文',
        modeTranslation: '译文',
        modeBilingual: '双语对照',
        fileTypeDescription: 'PDF 文件',
        range: '范围：第 {first}–{last} 页。',
        progress: '译文进度 {translated} / {expected} 段。未译段落随原文保留。',
        incomplete: '第 {pages} 页还有 {count} 段未完成翻译，当前导出会保留这些段落的原文。',
        fillMissing: '补齐缺失译文',
        generating: '正在生成…',
        confirm: '导出',
        cancelExport: '取消导出',
      },
      reading: {
        pageLabel: '第 {page} 页',
        paragraphLabel: '段落 {id}',
        pendingTranslation: '（待翻译）',
        originalHeading: '英文原文',
        translationHeading: '中文译文',
        originalPageLabel: '原文第 {page} 页',
        translationPageLabel: '译文第 {page} 页',
        viewParagraphTitle: '查看第 {id} 段',
        selectParagraph: '选择段落 {id}',
      },
      inspector: {
        label: '检查器',
        tabsLabel: '检查器页签',
        tabParagraph: '段落',
        tabChat: '问答',
        tabIssues: '问题',
        tabIssuesCount: '问题（{count}）',
        emptyParagraph: '点击页面中的段落，在这里查看完整原文与译文；也可以用 [ 和 ] 键前后切换段落。',
        heading: '第 {page} 页 · 段落 {id}',
        kind: '类型：{kind}',
        sourceHeading: '原文',
        translationHeading: '译文',
        retained: '{kind}按原版保留。',
        waiting: '该段正在等待翻译。',
        copySource: '复制原文',
        copyTranslation: '复制译文',
        askAbout: '围绕此段提问',
        prev: '上一段',
        next: '下一段',
      },
      chat: {
        title: '论文问答',
        empty: '暂无问答记录。例如：作者如何验证方法的有效性？',
        asking: '正在检索相关段落并回答…',
        aboutParagraph: '围绕段落 {id} 提问',
        aboutPaper: '围绕当前论文提问',
        placeholder: '输入问题，Enter 发送，Shift+Enter 换行',
        count: '{count} / {max}',
        answering: '正在回答…',
        submit: '提问',
      },
      issues: {
        title: '翻译问题',
        empty: '没有待修复的段落。',
        retryAll: '全部重试（{count} 段）',
        group: '{reason}（{count}）',
      },
      statusbar: {
        repairsTitle: '其中补译 {count} 次',
        calls: '调用 {count} 次',
      },
      confirm: {
        clearLabel: '清除译文确认',
        deleteLabel: '删除文献确认',
        clearTitle: '确定清除全部译文？',
        deleteTitle: '确定删除《{title}》？',
        clearBody: '将清除这篇文献的全部译文；原文、问答记录和文献目录会保留。',
        deleteBody: '原文、译文与问答记录都会被删除，且无法恢复。',
        clearConfirm: '清除译文',
        deleteConfirm: '确认删除',
      },
      tree: {
        label: '阅读工作区文献',
        empty: '暂无文献，请先上传 PDF',
        open: '打开文献',
        hint: '原文 · 译文 · 问答',
      },
    };
    const t = (path, vars) => {
      const value = path.split('.').reduce((node, key) => (node == null ? node : node[key]), STRINGS);
      const template = typeof value === 'string' ? value : path;
      return vars ? template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`) : template;
    };
    const retainedKinds = STRINGS.labels.retained;
    const kindLabels = STRINGS.labels.kind;
    const translationFailureLabels = STRINGS.labels.failure;

    let pdfLibrary;

    /* ═══ 2. 基础组件 ═════════════════════════════════════════════
       Render failures must never blank the whole panel: the boundary degrades
       to a retry card while the rest of Harness keeps running. */
    class ErrorBoundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null }; }
      static getDerivedStateFromError(error) { return { error }; }
      render() {
        if (!this.state.error) return this.props.children;
        return h('div', { className: 'qr-reader', role: 'alert' },
          h('h2', { className: 'qr-title' }, t('boundary.title')),
          h('p', { className: 'qr-inline-alert' },
            t('boundary.message', { message: this.state.error?.message ?? t('boundary.unknown') })),
          h('button', { type: 'button', className: 'qr-primary', onClick: () => this.setState({ error: null }) }, t('boundary.retry')));
      }
    }

    /* Real modal: focus trap, Esc, backdrop click and focus return. The page
       range picker and destructive confirmations both go through this. */
    function Modal({ label, onClose, children }) {
      const box = useRef(null);
      useEffect(() => {
        const node = box.current;
        if (!node) return undefined;
        const previous = document.activeElement;
        const focusable = () => [...node.querySelectorAll('button, input, select, textarea')]
          .filter(el => !el.disabled);
        focusable()[0]?.focus();
        const onKey = event => {
          if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
          if (event.key !== 'Tab') return;
          const items = focusable();
          if (!items.length) return;
          const first = items[0];
          const last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        };
        node.addEventListener('keydown', onKey);
        return () => {
          node.removeEventListener('keydown', onKey);
          previous?.focus?.();
        };
      }, []);
      return h('div', {
        className: 'qr-overlay',
        onMouseDown: event => { if (event.target === event.currentTarget) onClose(); },
      },
        h('div', { className: 'qr-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': label, ref: box },
          children));
    }

    /* ═══ 3. 数据层 ═══════════════════════════════════════════════ */
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
        throw Object.assign(new Error(result?.error ?? t('error.serviceUnavailable')), { code: result?.code });
      }
      return result;
    }

    /* ═══ 4. PDF 装载、解析与导出 ═════════════════════════════════ */
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
        disableFontFace: false, useWasm: false, maxImageSize: CONFIG.pdfjs.maxImageSize,
      });
      task.onPassword = () => { void task.destroy(); };
      try {
        return { pdfjs, task, document: await task.promise };
      } catch {
        await task.destroy().catch(() => {});
        throw new Error(t('error.pdfOpen'));
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
      if (total > CONFIG.maxPages) throw new Error(t('error.pageLimit', { max: CONFIG.maxPages }));
      const first = range?.first ?? 1;
      const last = range?.last ?? total;
      if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > total) {
        throw new Error(t('error.pageRangeOrder', { total }));
      }
      const pages = [];
      const paragraphs = [];
      const regions = [];
      const { extractPageLayout } = await loadLayout();
      let chars = 0;
      for (let page = 1; page <= total; page++) {
        if (page >= first && page <= last) report(t('busy.parseLayout', { page, last }));
        const current = await handle.document.getPage(page);
        const viewport = current.getViewport({ scale: 1 });
        pages.push({ width: viewport.width, height: viewport.height });
        if (page >= first && page <= last) {
          const layout = await extractPageLayout(handle.pdfjs, current, viewport, page);
          regions.push(...layout.regions.map(region => ({ ...region, page })));
          for (const paragraph of layout.paragraphs) {
            if (paragraph.text.length > CONFIG.maxParagraphChars) throw new Error(t('error.lineTooLong'));
            paragraphs.push({ id: paragraphs.length + 1, ...paragraph });
            chars += paragraph.text.length;
          }
        }
        current.cleanup();
        if (chars > CONFIG.maxTotalChars || paragraphs.length > CONFIG.maxParagraphs) throw new Error(t('error.tooMuchText'));
      }
      if (!paragraphs.length) throw new Error(t('error.noText'));
      const metadata = await handle.document.getMetadata().catch(() => ({}));
      const embeddedTitle = metadata.info?.Title;
      const title = (typeof embeddedTitle === 'string' && embeddedTitle.trim()) || String(filename ?? 'paper').replace(/\.pdf$/i, '');
      return { title, pages, paragraphs, regions, layoutVersion: CONFIG.layoutVersion, range: { first, last } };
    }

    function place(box) {
      const [x, y, right, bottom] = box;
      return { left: `${x * 100}%`, top: `${y * 100}%`, width: `${(right - x) * 100}%`, height: `${(bottom - y) * 100}%` };
    }

    function canvasToJpeg(canvas) {
      return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
          if (!blob) { reject(new Error(t('error.jpeg'))); return; }
          blob.arrayBuffer().then(buffer => resolve({
            bytes: new Uint8Array(buffer), jpegWidth: canvas.width, jpegHeight: canvas.height,
          })).catch(reject);
        }, 'image/jpeg', CONFIG.export.jpegQuality);
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

    async function buildPdf(paper, mode, report, signal) {
      const first = paper.range?.first ?? 1;
      const last = paper.range?.last ?? paper.pages.length;
      if (mode !== 'original' && !paper.translated) throw new Error(t('error.noTranslation'));
      const response = await fetch(endpoint('pdf', { id: paper.id, workspaceId: paper.workspaceId }), { signal });
      if (!response.ok) throw new Error(t('error.pdfFetch'));
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
          signal?.throwIfAborted();
          report(t('busy.exportPage', { page: number, last }));
          const page = await handle.document.getPage(number);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(CONFIG.export.rasterMaxScale, CONFIG.export.rasterLongest / Math.max(base.width, base.height)) });
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
              if (omitted.length) throw new Error(t('error.exportLayout', { page: number, ids: omitted.map(p => p.id).join('、') }));
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
      window.setTimeout(() => URL.revokeObjectURL(url), CONFIG.export.revokeMs);
    }

    /* ═══ 5. Markdown-lite 富文本 ═════════════════════════════════
       Minimal safe rich-text for model answers: bold, inline code and lists.
       Everything renders as React text nodes, so no HTML injection surface. */
    function inlineMarkdown(text) {
      return String(text).split(/(\*\*[^*]+\*\*|`[^`\n]+`)/g).map((part, index) => {
        if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return h('strong', { key: index }, part.slice(2, -2));
        if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return h('code', { key: index }, part.slice(1, -1));
        return part;
      });
    }
    function richAnswer(text) {
      return String(text).split(/\n{2,}/).map((block, index) => {
        const lines = block.split('\n').filter(line => line.trim());
        if (lines.length > 1 && lines.every(line => /^\s*(?:[-*•]|\d+[.、)])\s+/.test(line))) {
          return h('ul', { key: index },
            lines.map((line, i) => h('li', { key: i }, inlineMarkdown(line.replace(/^\s*(?:[-*•]|\d+[.、)])\s+/, '')))));
        }
        return h('p', { key: index }, inlineMarkdown(block));
      });
    }

    /* ═══ 6. 阅读面 ═══════════════════════════════════════════════ */
    function Reflow({ paper, number, selected, choose, zoom }) {
      const target = useRef(null);
      useEffect(() => {
        if (selected != null) target.current?.scrollIntoView({ block: 'nearest' });
      }, [selected, number]);
      const rows = paper.paragraphs.filter(p => p.page === number);
      return h('section', { className: 'qr-reflow', style: { fontSize: `${(zoom === 'fit' ? CONFIG.zoom.default : zoom) / 100}em` } },
        h('h3', { className: 'qr-reflow-page' }, t('reading.pageLabel', { page: number })),
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
          }, t('reading.paragraphLabel', { id: paragraph.id })),
          h('p', { className: paragraph.kind === 'formula' ? 'qr-reflow-formula' : 'qr-en', lang: 'en' }, paragraph.text),
          paragraph.kind !== 'formula' &&
            h('p', { className: translated ? 'qr-zh' : 'qr-zh qr-pending', lang: 'zh-CN' }, translated ?? t('reading.pendingTranslation')));
        }));
    }

    function Pages({ paper, number, selected, choose, zoom, onZoom }) {
      const original = useRef(null);
      const translated = useRef(null);
      const viewportRef = useRef(null);
      // Ctrl/⌘ + wheel zooms the spread. React registers wheel handlers as
      // passive at the root, so this needs a real non-passive listener.
      useEffect(() => {
        const node = viewportRef.current;
        if (!node || !onZoom) return undefined;
        const onWheel = event => {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          onZoom((zoom === 'fit' ? CONFIG.zoom.default : zoom) + (event.deltaY < 0 ? CONFIG.zoom.step : -CONFIG.zoom.step));
        };
        node.addEventListener('wheel', onWheel, { passive: false });
        return () => node.removeEventListener('wheel', onWheel);
      }, [zoom, onZoom]);
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
            const response = await fetch(endpoint('pdf', { id: paper.id, workspaceId: paper.workspaceId }), { signal: abort.signal });
            if (!response.ok) throw new Error(t('error.pdfFetch'));
            const presentation = await loadPresentation();
            handle = await openPdf(new Uint8Array(await response.arrayBuffer()));
            await document.fonts?.ready;
            if (abort.signal.aborted) return;
            setRenderer(presentation);
            setPdf(handle.document);
          } catch {
            if (!abort.signal.aborted) setError(t('error.pageLoad'));
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
        const rasterZoom = zoom === 'fit' ? CONFIG.zoom.default : zoom;
        void (async () => {
          let page;
          try {
            page = await pdf.getPage(number);
            if (cancelled) return;
            const base = page.getViewport({ scale: 1 });
            const longest = Math.max(base.width, base.height);
            const viewport = page.getViewport({ scale: Math.min(CONFIG.export.viewMaxScale, (CONFIG.export.viewRasterLongest * rasterZoom) / 100 / longest) });
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
            if (!cancelled) setError(t('error.pageRender'));
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
          setLayoutError(omitted.length ? t('error.overlayLayout', { ids: omitted.map(p => p.id).join('、') }) : '');
        }
      }, [rendered, renderer, number, pageContent]);
      if (!dimensions) return null;
      const sheetStyle = { aspectRatio: `${dimensions.width} / ${dimensions.height}` };
      const paragraphButton = p => h('button', {
        type: 'button', key: p.id, className: 'qr-source' + (selected === p.id ? ' qr-selected' : ''),
        style: place(p.box), title: t('reading.viewParagraphTitle', { id: p.id }),
        'aria-label': t('reading.selectParagraph', { id: p.id }),
        'aria-pressed': selected === p.id, onClick: () => choose(p.id),
      });
      return h(React.Fragment, null,
        error && h('p', { className: 'qr-error', role: 'alert' }, error),
        layoutError && h('p', { className: 'qr-error', role: 'alert' }, layoutError),
        h('div', { className: 'qr-viewport', ref: viewportRef },
          h('div', { className: 'qr-spread', style: { width: zoom === 'fit' ? '100%' : `${zoom}%` } },
            h('section', null, h('h3', null, t('reading.originalHeading')),
              h('div', { className: 'qr-sheet', style: sheetStyle },
                h('canvas', { ref: original, style: { visibility: ready ? 'visible' : 'hidden' }, 'aria-label': t('reading.originalPageLabel', { page: number }) }),
                ...(ready ? paragraphs.map(paragraphButton) : []))),
            h('section', null, h('h3', null, t('reading.translationHeading')),
              h('div', { className: 'qr-sheet', style: sheetStyle },
                h('canvas', { ref: translated, style: { visibility: ready ? 'visible' : 'hidden' }, 'aria-label': t('reading.translationPageLabel', { page: number }) }),
                ...(ready ? paragraphs.filter(p => paper.translations[p.id]).map(paragraphButton) : []))))));
    }

    /* ═══ 7. 工作台外壳与插件注册 ═════════════════════════════════ */
    function apply(ctx) {
      let selectedPaper = '';
      let snapshot = { workspace: null, checked: false, items: [] };
      let workspaceCheck;
      let workspaceGeneration = 0;
      const notify = () => { for (const listener of listeners) listener(); };
      const updateWorkspace = workspace => {
        const changed = workspace?.id !== snapshot.workspace?.id;
        snapshot = { workspace, checked: true, items: changed ? [] : snapshot.items };
        if (changed) selectedPaper = '';
        notify();
      };
      const checkWorkspace = () => {
        if (workspaceCheck) return workspaceCheck;
        const generation = workspaceGeneration;
        workspaceCheck = request('workspace').then(({ workspace }) => {
          if (generation === workspaceGeneration) updateWorkspace(workspace);
          return snapshot.workspace;
        }).finally(() => { workspaceCheck = undefined; });
        return workspaceCheck;
      };
      // Cordis requires an explicit injection before a service can be read.
      let pickDirectory = null;
      let openReader = () => {};
      if (typeof ctx.inject === 'function') {
        ctx.inject(['uiWorkspace'], scoped => {
          pickDirectory = () => scoped.uiWorkspace.pickDirectory();
          return () => { pickDirectory = null; };
        });
        ctx.inject(['layout'], scoped => {
          openReader = () => scoped.layout?.selectPanel(PANEL);
          return () => { openReader = () => {}; };
        });
      }
      const listeners = new Set();
      const refresh = async (signal, workspaceId = snapshot.workspace?.id) => {
        if (!workspaceId) return [];
        const items = await request('list', { workspaceId }, undefined, signal);
        if (!signal?.aborted && snapshot.workspace?.id === workspaceId) {
          snapshot = { ...snapshot, items }; notify();
        }
        return items;
      };
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
        const workspaceState = useWorkspaces ? useWorkspaces(state => state) : null;
        const workspaceView = useSyncExternalStore(subscribe, () => snapshot);
        const workspace = workspaceView.workspace;
        const library = workspaceView.items;
        const workspaceId = workspace?.id;
        const call = async (action, params = {}, body, signal) => {
          if (!workspaceId || snapshot.workspace?.id !== workspaceId) throw new Error(t('error.workspaceRequired'));
          try {
            const value = await request(action, { ...params, workspaceId }, body, signal);
            if (snapshot.workspace?.id !== workspaceId) throw new Error(t('error.workspaceChangedPaper'));
            return value;
          } catch (error) {
            if (['WORKSPACE_REQUIRED', 'WORKSPACE_CHANGED'].includes(error.code)) void checkWorkspace().catch(() => {});
            throw error;
          }
        };
        const [paper, setPaper] = useState(null);
        const [number, setNumber] = useState(1);
        const [selected, setSelected] = useState(null);
        const [question, setQuestion] = useState('');
        // Errors are scoped to the area that raised them (workspace / import /
        // translate / export / ask / settings) so one failing action never
        // overwrites an unrelated message or kicks the whole panel.
        const [errors, setErrors] = useState({});
        const setScopedError = (scope, message) => setErrors(current => {
          const next = { ...current };
          if (message) next[scope] = message;
          else delete next[scope];
          return next;
        });
        const [toasts, setToasts] = useState([]);
        const toastSeq = useRef(0);
        const pushToast = (text, tone = 'ok') => {
          const toastId = ++toastSeq.current;
          setToasts(list => [...list.slice(-(CONFIG.toastMax - 1)), { id: toastId, text, tone }]);
          setTimeout(() => setToasts(list => list.filter(item => item.id !== toastId)), CONFIG.toastMs);
        };
        const [confirming, setConfirming] = useState(null);
        const [inspectorTab, setInspectorTab] = useState('paragraph');
        const [search, setSearch] = useState('');
        const [settingsOpen, setSettingsOpen] = useState(false);
        const [busy, setBusy] = useState('');
        const [asking, setAsking] = useState(false);
        const [revision, setRevision] = useState(0);
        const [pending, setPending] = useState(null);
        const chooseFolder = async () => {
          if (busy || pending) return;
          setScopedError('workspace', '');
          setBusy(t('busy.pickWorkspace'));
          try {
            if (!pickDirectory) throw new Error(t('error.pickerNotReady'));
            const picked = await pickDirectory();
            if (!picked) return;
            await workspaceCheck;
            workspaceGeneration++;
            const result = await request('workspace', {}, { folder: picked });
            workspaceGeneration++;
            updateWorkspace(result.workspace);
            await refresh();
          } catch (e) { setScopedError('workspace', e.message); }
          finally { setBusy(''); }
        };
        const [fromPage, setFromPage] = useState('');
        const [toPage, setToPage] = useState('');
        const [exportOpen, setExportOpen] = useState(false);
        const [exportMode, setExportMode] = useState('bilingual');
        const [exporting, setExporting] = useState(false);
        const exportAbort = useRef(null);
        const [viewMode, setViewMode] = useState('overlay');
        const [models, setModels] = useState({ current: null, providers: [] });
        const [efforts, setEfforts] = useState([]);
        const [effortsLoading, setEffortsLoading] = useState(false);
        const effortRequest = useRef(0);
        // Zoom is either a percentage (50–300) or 'fit' (fit the panel width).
        const [zoom, setZoom] = useState(() => {
          try {
            const stored = localStorage.getItem(CONFIG.storage.zoom);
            if (stored === 'fit') return 'fit';
            const value = Number(stored);
            return value >= CONFIG.zoom.min && value <= CONFIG.zoom.max ? value : CONFIG.zoom.default;
          } catch { return CONFIG.zoom.default; }
        });
        const file = useRef(null);
        const active = useRef('');
        active.current = id;
        useEffect(() => () => {
          if (pending) void pending.handle.task.destroy().catch(() => {});
        }, [pending]);
        useEffect(() => {
          let stopped = false;
          let timer;
          let failures = 0;
          const sync = async () => {
            if (stopped) return;
            // Hidden panels do not poll; they catch up when visible again.
            if (typeof document !== 'undefined' && document.hidden) {
              timer = setTimeout(sync, CONFIG.poll.hiddenLibraryMs);
              return;
            }
            try {
              const current = await checkWorkspace();
              if (!stopped && current) await refresh(undefined, current.id);
              failures = 0;
            } catch (e) {
              failures += 1;
              if (!stopped) setScopedError('workspace', e.message);
            }
            // Exponential backoff keeps a broken backend from a request storm.
            if (!stopped) timer = setTimeout(sync, Math.min(CONFIG.poll.backoffMaxMs, CONFIG.poll.libraryMs * 2 ** failures));
          };
          const resume = () => {
            if (stopped || (typeof document !== 'undefined' && document.hidden)) return;
            clearTimeout(timer);
            void sync();
          };
          document.addEventListener?.('visibilitychange', resume);
          void sync();
          return () => {
            stopped = true;
            clearTimeout(timer);
            document.removeEventListener?.('visibilitychange', resume);
          };
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
        useEffect(() => { void checkWorkspace().catch(e => setScopedError('workspace', e.message)); }, [workspaceState]);
        useEffect(() => {
          setPaper(null);
          setNumber(1);
          setSelected(null);
          setQuestion('');
          setErrors({});
          setConfirming(null);
          setAsking(false);
          setPending(null);
        }, [id, workspaceId]);
        useEffect(() => {
          if (!id || !workspaceId) return;
          const controller = new AbortController();
          let timer;
          let failures = 0;
          const poll = async () => {
            if (controller.signal.aborted) return;
            if (typeof document !== 'undefined' && document.hidden) {
              timer = setTimeout(poll, CONFIG.poll.hiddenDetailMs);
              return;
            }
            try {
              const result = await call('detail', { id }, undefined, controller.signal);
              if (controller.signal.aborted) return;
              failures = 0;
              setPaper(current => current?.id === id ? { ...result, history: current.history } : result);
              if (result.status === 'running') timer = setTimeout(poll, CONFIG.poll.detailMs);
            } catch (e) {
              if (!controller.signal.aborted) {
                failures += 1;
                setScopedError('translate', e.message);
                timer = setTimeout(poll, Math.min(CONFIG.poll.backoffMaxMs, CONFIG.poll.failBaseMs * 2 ** (failures - 1)));
              }
            }
          };
          void poll();
          return () => { controller.abort(); clearTimeout(timer); };
        }, [id, workspaceId, revision]);

        async function chooseFile(event) {
          const chosen = event.currentTarget.files[0];
          event.currentTarget.value = '';
          if (!chosen || busy || !workspaceId) return;
          if (chosen.size === 0 || chosen.size > PDF_LIMIT) {
            setScopedError('import', t('error.pdfSize', { limit: CONFIG.pdfLimitMB }));
            return;
          }
          setScopedError('import', '');
          setBusy(t('busy.readPdf'));
          try {
            const handle = await openPdf(new Uint8Array(await chosen.arrayBuffer()));
            if (handle.document.numPages > CONFIG.maxPages) {
              await handle.task.destroy();
              throw new Error(t('error.pageLimit', { max: CONFIG.maxPages }));
            }
            if (snapshot.workspace?.id !== workspaceId) {
              await handle.task.destroy();
              throw new Error(t('error.workspaceChangedPdf'));
            }
            setPending({ file: chosen, handle, numPages: handle.document.numPages, workspaceId });
            setFromPage('1');
            setToPage(String(handle.document.numPages));
          } catch (e) {
            setScopedError('import', e.message || t('error.pdfOpenFallback'));
          } finally {
            setBusy('');
          }
        }

        function cancelPending() {
          setPending(null);
          setScopedError('import', '');
          setBusy('');
        }

        async function importDocument(chosen, handle, range) {
          const parsed = await parseDocument(handle, setBusy, range, chosen.name);
          setBusy(t('busy.saveLayout'));
          const form = new FormData();
          form.set('pdf', chosen);
          form.set('document', JSON.stringify(parsed));
          return call('import', {}, form);
        }

        async function confirmRange() {
          if (!pending) return;
          if (pending.workspaceId !== workspaceId) {
            setPending(null);
            setScopedError('import', t('error.workspaceChangedPdf'));
            return;
          }
          const { file: chosen, handle, numPages } = pending;
          const first = Number(fromPage);
          const last = Number(toPage);
          if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > numPages) {
            setScopedError('import', t('error.rangeInvalid', { total: numPages }));
            return;
          }
          setScopedError('import', '');
          setBusy(t('busy.readPdf'));
          try {
            const imported = await importDocument(chosen, handle, { first, last });
            if (active.current === imported.id) {
              setPaper(imported);
              setRevision(value => value + 1);
            }
            choosePaper(imported.id);
            setPending(null);
            await refresh();
            pushToast(t('toast.imported', { title: imported.title }));
          } catch (e) {
            setScopedError('import', e.message || t('error.pdfParseFallback'));
          } finally {
            setBusy('');
          }
        }

        async function refreshLayout() {
          if (!paper || busy) return;
          setBusy(t('busy.readOriginalPdf'));
          setScopedError('translate', '');
          let handle;
          try {
            const response = await fetch(endpoint('pdf', { id, workspaceId: paper.workspaceId }));
            if (!response.ok) throw new Error(t('error.pdfFetch'));
            const chosen = new File([await response.blob()], `${paper.title}.pdf`, { type: 'application/pdf' });
            handle = await openPdf(new Uint8Array(await chosen.arrayBuffer()));
            const updated = await importDocument(chosen, handle, { first: firstPage, last: lastPage });
            if (active.current === id) {
              setPaper(updated);
              setRevision(value => value + 1);
            }
          } catch (e) {
            if (active.current === id) setScopedError('translate', e.message);
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
            pushToast(t('toast.settingsSaved'));
          } catch (e) { setScopedError('settings', e.message); }
        }

        async function retry() {
          setScopedError('translate', '');
          try {
            const updated = await call('translate', { id }, {});
            if (active.current === id) {
              setPaper(updated);
              setRevision(value => value + 1);
            }
          } catch (e) { if (active.current === id) setScopedError('translate', e.message); }
        }

        async function pauseTranslation() {
          setScopedError('translate', '');
          try {
            const updated = await call('pause', { id }, {});
            if (active.current === id) {
              setPaper(updated);
              setRevision(value => value + 1);
              pushToast(t('toast.paused'));
            }
          } catch (e) { if (active.current === id) setScopedError('translate', e.message); }
        }

        // Destructive actions never run directly: they open a modal that lists
        // the impact first, so a misclick on the toolbar cannot wipe data.
        function clearTranslations() {
          if (!paper || busy) return;
          setConfirming({ action: 'clear' });
        }

        function deletePaper() {
          if (!paper || busy) return;
          setConfirming({ action: 'delete' });
        }

        async function runConfirmed() {
          const action = confirming?.action;
          setConfirming(null);
          if (!paper || !action) return;
          setScopedError('translate', '');
          try {
            if (action === 'clear') {
              const updated = await call('reset', { id }, {});
              if (active.current === id) {
                setPaper(updated);
                setRevision(value => value + 1);
              }
              pushToast(t('toast.cleared'));
            } else {
              const title = paper.title;
              await call('delete', { id }, {});
              choosePaper('');
              setPaper(null);
              await refresh();
              pushToast(t('toast.deleted', { title }));
            }
          } catch (e) { if (active.current === id) setScopedError('translate', e.message); }
        }

        async function ask(event) {
          event.preventDefault();
          if (asking || !question.trim()) return;
          setAsking(true);
          setScopedError('ask', '');
          try {
            const history = await call('ask', { id }, { question, page: number, selectedId: selected });
            if (active.current === id) {
              setPaper(current => current?.id === id ? { ...current, history } : current);
              setQuestion('');
            }
          } catch (e) { if (active.current === id) setScopedError('ask', e.message); }
          finally { if (active.current === id) setAsking(false); }
        }

        async function exportPdf() {
          if (!paper || exporting) return;
          const label = exportMode === 'original' ? t('export.modeOriginal')
            : exportMode === 'translation' ? t('export.modeTranslation') : t('export.modeBilingual');
          const filename = `${paper.title.replace(/[\\/:*?"<>|]/g, '_')}-${label}.pdf`;
          let target = null;
          if (typeof window.showSaveFilePicker === 'function') {
            try {
              target = await window.showSaveFilePicker({
                suggestedName: filename,
                types: [{ description: t('export.fileTypeDescription'), accept: { 'application/pdf': ['.pdf'] } }],
              });
            } catch (e) {
              if (e && e.name === 'AbortError') return;
              if (!['SecurityError', 'NotSupportedError'].includes(e?.name)) {
                setScopedError('export', t('error.saveDialog', { message: e?.message || e?.name || t('error.unknown') }));
                return;
              }
            }
          }
          setExporting(true);
          setScopedError('export', '');
          const controller = new AbortController();
          exportAbort.current = controller;
          try {
            const bytes = await buildPdf(paper, exportMode, setBusy, controller.signal);
            if (controller.signal.aborted) return;
            if (target) {
              const writable = await target.createWritable();
              await writable.write(new Blob([bytes], { type: 'application/pdf' }));
              await writable.close();
            } else {
              downloadPdf(bytes, filename);
            }
            setExportOpen(false);
            pushToast(t('toast.exported'));
          } catch (e) {
            if (e?.name === 'AbortError') pushToast(t('toast.exportCancelled'));
            else setScopedError('export', e.message || t('error.exportFallback'));
          } finally {
            exportAbort.current = null;
            setBusy('');
            setExporting(false);
          }
        }

        const paragraph = paper?.paragraphs.find(p => p.id === selected);
        const jumpTo = (page, paragraphId = null) => {
          setNumber(page);
          setSelected(paragraphId);
          if (paragraphId != null) setInspectorTab('paragraph');
        };
        const chooseParagraph = paragraphId => {
          const target = paper?.paragraphs.find(p => p.id === paragraphId);
          jumpTo(target?.page ?? number, paragraphId);
        };
        const changePage = page => { setNumber(page); setSelected(null); };
        const orderedParagraphs = paper?.paragraphs ?? [];
        const stepParagraph = delta => {
          if (!orderedParagraphs.length) return;
          const index = orderedParagraphs.findIndex(p => p.id === selected);
          const from = index < 0 ? (delta > 0 ? -1 : orderedParagraphs.length) : index;
          const next = orderedParagraphs[Math.min(orderedParagraphs.length - 1, Math.max(0, from + delta))];
          if (next) jumpTo(next.page, next.id);
        };
        const copyText = async (text, label) => {
          try {
            await navigator.clipboard.writeText(text);
            pushToast(t('toast.copied', { label }));
          } catch {
            pushToast(t('toast.copyFailed'), 'danger');
          }
        };
        const questionBox = useRef(null);
        const askAboutSelected = () => {
          setInspectorTab('chat');
          setTimeout(() => questionBox.current?.focus(), 0);
        };
        const onQuestionKeyDown = event => {
          if (event.key !== 'Enter' || event.shiftKey) return;
          // Never send while an IME composition is in flight.
          if (event.nativeEvent?.isComposing || event.isComposing) return;
          event.preventDefault();
          if (!asking && question.trim()) void ask(event);
        };
        const onPanelKeyDown = event => {
          if (pending || confirming || settingsOpen) return;
          const tag = event.target?.tagName;
          if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
          if (event.ctrlKey || event.metaKey || event.altKey || !paper) return;
          if (event.key === 'ArrowLeft' && number > firstPage) { event.preventDefault(); changePage(number - 1); }
          else if (event.key === 'ArrowRight' && number < lastPage) { event.preventDefault(); changePage(number + 1); }
          else if (event.key === '[') { event.preventDefault(); stepParagraph(-1); }
          else if (event.key === ']') { event.preventDefault(); stepParagraph(1); }
        };
        const expected = paper?.expected ?? paper?.paragraphs.length ?? 0;
        const failures = paper?.failedParagraphs?.length ?? 0;
        const statusBadge = !paper ? null :
          paper.status === 'running' ? { tone: 'busy', text: t('badge.translating', { translated: paper.translated, expected }) } :
          failures ? { tone: 'warn', text: t('badge.pendingFix', { count: failures }) } :
          paper.status === 'complete' ? { tone: 'ok', text: t('badge.complete') } :
          { tone: 'idle', text: t('badge.idle') };
        const searchResults = paper && search.trim()
          ? paper.paragraphs.filter(p =>
              p.text.toLowerCase().includes(search.trim().toLowerCase()) ||
              (paper.translations[p.id] ?? '').includes(search.trim())).slice(0, CONFIG.search.maxResults)
          : [];
        const failureGroups = [];
        for (const failure of paper?.failedParagraphs ?? []) {
          const reason = translationFailureLabels[failure.reason] ?? t('labels.failureFallback');
          let group = failureGroups.find(item => item.reason === reason);
          if (!group) { group = { reason, items: [] }; failureGroups.push(group); }
          group.items.push(failure);
        }
        const currentProvider = (models.providers ?? []).find(item => item.id === models.current?.provider);
        const currentModelName = currentProvider?.models.find(item => item.id === models.current?.model)?.name
          ?? models.current?.model ?? '';
        const firstPage = paper?.range?.first ?? 1;
        const lastPage = paper?.range?.last ?? paper?.pages.length ?? 1;
        const layoutPages = new Set(paper?.layoutPages);
        const needsLayout = paper && (paper.layoutVersion !== CONFIG.layoutVersion ||
          Array.from({ length: lastPage - firstPage + 1 }, (_, i) => firstPage + i).some(page => !layoutPages.has(page)));
        const activeParagraphs = new Set(paper?.paragraphs.map(p => p.id));
        const untranslated = (paper?.paragraphs ?? []).filter(p =>
          [undefined, 'text', 'heading', 'caption'].includes(p.kind) && !paper.translations[p.id]?.trim());
        const untranslatedPages = [...new Set(untranslated.map(p => p.page))];
        // Old imports predate the current layout rules. Re-run layout once per
        // paper so users never test a stale extraction without knowing it.
        const autoLayout = useRef('');
        useEffect(() => {
          if (!paper || !needsLayout || busy || paper.status === 'running') return;
          if (autoLayout.current === paper.id) return;
          autoLayout.current = paper.id;
          void refreshLayout();
        }, [paper?.id, needsLayout, busy]);
        // Reading position: reopening a paper returns to the last page read.
        useEffect(() => {
          if (!paper) return;
          try {
            const saved = Number(localStorage.getItem(CONFIG.storage.position(paper.id)));
            if (Number.isInteger(saved) && saved >= firstPage && saved <= lastPage) setNumber(saved);
          } catch {}
        }, [paper?.id]);
        useEffect(() => {
          if (!paper) return;
          try { localStorage.setItem(CONFIG.storage.position(paper.id), String(number)); } catch {}
        }, [paper?.id, number]);
        useEffect(() => {
          if (!paper) return;
          const first = paper.range?.first ?? 1;
          const last = paper.range?.last ?? paper.pages.length;
          setNumber(value => Math.min(Math.max(value, first), last));
        }, [paper?.id, firstPage, lastPage]);
        // Remember the last open paper per workspace and resume it on reload.
        useEffect(() => {
          try {
            if (id && workspaceId) localStorage.setItem(CONFIG.storage.lastPaper(workspaceId), id);
          } catch {}
        }, [id, workspaceId]);
        const autoOpened = useRef('');
        useEffect(() => {
          if (id || !workspaceId || autoOpened.current === workspaceId) return;
          autoOpened.current = workspaceId;
          try {
            const last = localStorage.getItem(CONFIG.storage.lastPaper(workspaceId));
            if (last && library.some(item => item.id === last)) choosePaper(last);
          } catch {}
        }, [id, workspaceId, library]);
        // Composer grows with its content, capped so long drafts stay usable.
        useEffect(() => {
          const node = questionBox.current;
          if (!node) return;
          node.style.height = 'auto';
          node.style.height = `${Math.min(CONFIG.composerMaxHeight, node.scrollHeight)}px`;
        }, [question, inspectorTab]);
        const changeZoom = value => {
          const next = value === 'fit' ? 'fit' : Math.min(CONFIG.zoom.max, Math.max(CONFIG.zoom.min, Math.round(value)));
          setZoom(next);
          try { localStorage.setItem(CONFIG.storage.zoom, String(next)); } catch {}
        };
        const inlineAlert = message => message && h('p', { className: 'qr-inline-alert', role: 'alert' }, message);
        return h('main', { className: 'qr-reader', role: 'region', 'aria-label': t('app.panelLabel'), lang: 'zh-CN', onKeyDown: onPanelKeyDown },
          h('link', { rel: 'stylesheet', href: endpoint('asset', { name: 'reader.css' }) }),
          h('header', { className: 'qr-command' },
            h('h2', { className: 'qr-title' }, t('app.title')),
            paper && statusBadge && h('span', { className: `qr-badge qr-badge-${statusBadge.tone}`, role: 'status' }, statusBadge.text),
            paper && h('span', { className: 'qr-command-title', title: paper.title }, paper.title),
            paper && h('div', { className: 'qr-search' },
              h('input', {
                type: 'search', value: search, 'aria-label': t('search.ariaLabel'), placeholder: t('search.placeholder'),
                onChange: e => setSearch(e.target.value),
                onKeyDown: e => { if (e.key === 'Escape') setSearch(''); },
              }),
              search.trim() !== '' && h('div', { className: 'qr-search-results', role: 'listbox', 'aria-label': t('search.resultsLabel') },
                searchResults.length === 0 && h('p', { className: 'qr-hint' }, t('search.empty')),
                searchResults.map(item => h('button', {
                  key: item.id, type: 'button', role: 'option', 'aria-selected': item.id === selected,
                  onClick: () => { jumpTo(item.page, item.id); setSearch(''); },
                },
                  h('span', { className: 'qr-search-loc' }, t('common.pageParagraph', { page: item.page, id: item.id })),
                  h('span', { className: 'qr-search-snippet' }, (paper.translations[item.id] || item.text).slice(0, CONFIG.search.snippetLength)))))),
            h('div', { className: 'qr-command-actions' },
              h('label', { className: 'qr-picker' }, t('command.pickerLabel'),
                h('select', { value: id, 'aria-label': t('command.pickerPlaceholder'), onChange: e => choosePaper(e.target.value) },
                  h('option', { value: '' }, t('command.pickerPlaceholder')),
                  ...library.map(item => h('option', { key: item.id, value: item.id }, item.title)))),
              h('input', { ref: file, type: 'file', accept: 'application/pdf,.pdf', hidden: true, onChange: chooseFile }),
              h('button', { type: 'button', className: 'qr-primary', disabled: !workspaceId || !!busy || !!pending, onClick: () => file.current.click() }, t('command.upload')),
              paper && h('button', { type: 'button', onClick: () => setSettingsOpen(true) }, t('command.settings')),
              paper && h('button', { type: 'button', onClick: () => setExportOpen(value => !value), disabled: exporting }, t('command.export')))),
          h('section', { className: 'qr-workspace-gate' },
            h('p', { role: 'status' }, !workspaceView.checked ? t('gate.loading') : workspace ? t('gate.current', { path: workspace.path }) : t('gate.prompt')),
            h('button', { type: 'button', disabled: !!busy || !!pending, onClick: chooseFolder }, workspace ? t('gate.switch') : t('gate.choose'))),
          h('p', { className: 'qr-hint' }, t('gate.hint')),
          inlineAlert(errors.workspace),
          inlineAlert(errors.import),
          pending && h(Modal, { label: t('range.label'), onClose: cancelPending },
            h('h3', null, t('range.title')),
            h('p', null, t('range.summary', { total: pending.numPages })),
            h('div', { className: 'qr-actions' },
              h('label', null, t('range.from'),
                h('input', {
                  type: 'number', min: 1, max: pending.numPages, value: fromPage, 'aria-label': t('range.fromLabel'),
                  onChange: e => setFromPage(e.target.value),
                }), t('range.pageUnit')),
              h('label', null, t('range.to'),
                h('input', {
                  type: 'number', min: 1, max: pending.numPages, value: toPage, 'aria-label': t('range.toLabel'),
                  onChange: e => setToPage(e.target.value),
                }), t('range.pageUnit'))),
            h('p', { className: 'qr-folder' }, workspace?.path),
            h('p', { className: 'qr-hint' }, t('range.formatHint', { total: pending.numPages })),
            h('div', { className: 'qr-modal-actions' },
              h('button', { type: 'button', disabled: !!busy, onClick: cancelPending }, t('common.cancel')),
              h('button', { type: 'button', className: 'qr-primary', disabled: !!busy, onClick: confirmRange },
                busy ? t('common.processing') : t('range.confirm')))),
          settingsOpen && h(Modal, { label: t('settings.label'), onClose: () => setSettingsOpen(false) },
            h('h3', null, t('settings.title')),
            h('label', null, t('settings.model'),
              h('select', {
                value: models.current ? `${models.current.provider}::${models.current.model}` : '',
                'aria-label': t('settings.modelLabel'),
                onChange: e => {
                  const [provider, model] = e.target.value.split('::');
                  void chooseModel({ provider, model, reasoningEffort: '' });
                },
              }, ...(models.providers ?? []).map(provider => h('optgroup', { key: provider.id, label: provider.name },
                provider.models.map(model => h('option', {
                  key: `${provider.id}::${model.id}`, value: `${provider.id}::${model.id}`,
                }, model.name)))))),
            h('label', null, t('settings.effort'),
              h('select', {
                value: models.current?.reasoningEffort ?? '',
                'aria-label': t('settings.effortLabel'),
                disabled: effortsLoading || !efforts.length,
                title: effortsLoading ? t('settings.effortLoadingTitle')
                  : efforts.length ? '' : t('settings.effortUnsupportedTitle'),
                onChange: e => void chooseModel({ reasoningEffort: e.target.value }),
              },
              h('option', { value: '' }, effortsLoading ? t('settings.effortLoading') : efforts.length ? t('settings.effortDefault') : t('settings.effortUnsupported')),
              ...efforts.map(effort => h('option', { key: effort.id, value: effort.id }, effort.name)))),
            h('label', null, t('settings.mode'),
              h('select', {
                value: models.current?.translationMode ?? 'economy', 'aria-label': t('settings.modeLabel'),
                onChange: e => void chooseModel({ translationMode: e.target.value }),
              }, h('option', { value: 'economy' }, t('settings.modeEconomy')),
              h('option', { value: 'custom' }, t('settings.modeCustom')))),
            h('p', { className: 'qr-hint' }, t('settings.modeHint')),
            inlineAlert(errors.settings),
            h('div', { className: 'qr-modal-actions' },
              h('button', { type: 'button', className: 'qr-primary', onClick: () => setSettingsOpen(false) }, t('settings.done')))),
          busy && h('p', { role: 'status' }, busy),
          !paper ? h('p', null, id ? t('empty.opening') : t('empty.hint')) :
            h('div', { className: 'qr-body' },
              h('div', { className: 'qr-reading' },
                h('div', { className: 'qr-toolbar' },
                  h('div', { className: 'qr-actions', role: 'group', 'aria-label': t('toolbar.pagingLabel') },
                    h('button', { type: 'button', 'aria-label': t('toolbar.prevPage'), title: t('toolbar.prevPageTitle'), disabled: number <= firstPage, onClick: () => changePage(number - 1) }, '‹'),
                    h('label', { className: 'qr-range' },
                      h('input', {
                        type: 'number', min: firstPage, max: lastPage, value: number, 'aria-label': t('toolbar.pageLabel'),
                        onChange: e => {
                          const value = Number(e.target.value);
                          if (Number.isInteger(value) && value >= firstPage && value <= lastPage) changePage(value);
                        },
                      }),
                      ` / ${lastPage}`),
                    h('button', { type: 'button', 'aria-label': t('toolbar.nextPage'), title: t('toolbar.nextPageTitle'), disabled: number >= lastPage, onClick: () => changePage(number + 1) }, '›'),
                    h('button', { type: 'button', onClick: () => setViewMode(value => value === 'overlay' ? 'reflow' : 'overlay') },
                      viewMode === 'overlay' ? t('toolbar.reflowMode') : t('toolbar.overlayMode'))),
                  h('div', { className: 'qr-actions qr-zoom', role: 'group', 'aria-label': t('zoom.groupLabel') },
                    h('button', { type: 'button', title: t('zoom.outTitle'), 'aria-label': t('zoom.outLabel'), disabled: zoom !== 'fit' && zoom <= CONFIG.zoom.min, onClick: () => changeZoom((zoom === 'fit' ? CONFIG.zoom.default : zoom) - CONFIG.zoom.step) }, '−'),
                    h('output', { className: 'qr-zoom-value', 'aria-live': 'polite' }, zoom === 'fit' ? t('zoom.fit') : `${zoom}%`),
                    h('button', { type: 'button', title: t('zoom.inTitle'), 'aria-label': t('zoom.inLabel'), disabled: zoom !== 'fit' && zoom >= CONFIG.zoom.max, onClick: () => changeZoom((zoom === 'fit' ? CONFIG.zoom.default : zoom) + CONFIG.zoom.step) }, '＋'),
                    h('button', { type: 'button', title: t('zoom.resetTitle'), disabled: zoom === CONFIG.zoom.default, onClick: () => changeZoom(CONFIG.zoom.default) }, t('zoom.reset')),
                    h('button', { type: 'button', title: t('zoom.fitTitle'), 'aria-pressed': zoom === 'fit', onClick: () => changeZoom(zoom === 'fit' ? CONFIG.zoom.default : 'fit') }, t('zoom.fit'))),
                  h('div', { className: 'qr-actions', role: 'status' },
                    h('span', null, t('toolbar.progress', { translated: paper.translated, expected })),
                    h('progress', { value: paper.translated, max: expected || 1, 'aria-label': t('toolbar.progressLabel') }, `${paper.translated} / ${expected}`),
                    paper.status !== 'running' && paper.status !== 'complete' &&
                      h('button', { type: 'button', onClick: retry, disabled: !!busy }, t('toolbar.resume')),
                    paper.status === 'running' && h('button', {
                      type: 'button', onClick: pauseTranslation, disabled: !!busy,
                      title: t('toolbar.pauseTitle'),
                    }, t('toolbar.pause')),
                    needsLayout && h('button', {
                      type: 'button', onClick: refreshLayout, disabled: !!busy || paper.status === 'running',
                    }, t('toolbar.relayout')),
                    h('button', { type: 'button', className: 'qr-danger', onClick: clearTranslations, disabled: !!busy }, t('toolbar.clear')),
                    h('button', { type: 'button', className: 'qr-danger', onClick: deletePaper, disabled: !!busy }, t('toolbar.delete')))),
                inlineAlert(errors.translate),
                exportOpen && h('section', { className: 'qr-export' },
                  h('h3', null, t('export.title')),
                  h('div', { className: 'qr-export-options' },
                    ...[['original', t('export.modeOriginal')], ['translation', t('export.modeTranslation')], ['bilingual', t('export.modeBilingual')]].map(([value, label]) =>
                      h('label', { key: value },
                        h('input', {
                          type: 'radio', name: 'qr-export-mode', value, checked: exportMode === value,
                          onChange: () => setExportMode(value),
                        }), ` ${label}`))),
                  h('p', { className: 'qr-hint' }, t('export.range', { first: firstPage, last: lastPage })),
                  exportMode !== 'original' && paper.translated < paper.expected &&
                    h('p', { className: 'qr-hint' }, t('export.progress', { translated: paper.translated, expected: paper.expected })),
                  exportMode !== 'original' && untranslated.length > 0 && h('p', { className: 'qr-error' },
                    t('export.incomplete', { pages: untranslatedPages.join('、'), count: untranslated.length }),
                    paper.status !== 'running' && h('button', { type: 'button', onClick: retry, disabled: !!busy }, t('export.fillMissing'))),
                  inlineAlert(errors.export),
                  h('div', { className: 'qr-actions' },
                    h('button', {
                      type: 'button', className: 'qr-primary',
                      disabled: exporting || (exportMode !== 'original' && !paper.translated), onClick: exportPdf,
                    },
                      exporting ? t('export.generating') : t('export.confirm')),
                    exporting
                      ? h('button', { type: 'button', onClick: () => exportAbort.current?.abort() }, t('export.cancelExport'))
                      : h('button', { type: 'button', onClick: () => setExportOpen(false) }, t('common.cancel')))),
                paper.error && h('p', { className: 'qr-error', role: 'alert' }, paper.error),
                viewMode === 'overlay'
                  ? h(Pages, { key: paper.id, paper, number, selected, choose: chooseParagraph, zoom, onZoom: changeZoom })
                  : h(Reflow, { key: `${paper.id}-reflow`, paper, number, selected, choose: chooseParagraph, zoom })),
              h('aside', { className: 'qr-inspector', 'aria-label': t('inspector.label') },
                h('div', { className: 'qr-tabs', role: 'tablist', 'aria-label': t('inspector.tabsLabel') },
                  h('button', {
                    type: 'button', role: 'tab', id: 'qr-tab-paragraph', 'aria-selected': inspectorTab === 'paragraph',
                    className: 'qr-tab' + (inspectorTab === 'paragraph' ? ' qr-tab-active' : ''),
                    onClick: () => setInspectorTab('paragraph'),
                  }, t('inspector.tabParagraph')),
                  h('button', {
                    type: 'button', role: 'tab', id: 'qr-tab-chat', 'aria-selected': inspectorTab === 'chat',
                    className: 'qr-tab' + (inspectorTab === 'chat' ? ' qr-tab-active' : ''),
                    onClick: () => setInspectorTab('chat'),
                  }, t('inspector.tabChat')),
                  h('button', {
                    type: 'button', role: 'tab', id: 'qr-tab-issues', 'aria-selected': inspectorTab === 'issues',
                    className: 'qr-tab' + (inspectorTab === 'issues' ? ' qr-tab-active' : ''),
                    onClick: () => setInspectorTab('issues'),
                  }, failures ? t('inspector.tabIssuesCount', { count: failures }) : t('inspector.tabIssues'))),
                inspectorTab === 'paragraph' && h('section', { role: 'tabpanel', 'aria-labelledby': 'qr-tab-paragraph', className: 'qr-pane' },
                  !paragraph
                    ? h('p', { className: 'qr-hint' }, t('inspector.emptyParagraph'))
                    : h(React.Fragment, null,
                      h('h3', null, t('inspector.heading', { page: paragraph.page, id: paragraph.id })),
                      h('p', { className: 'qr-hint' }, t('inspector.kind', { kind: kindLabels[paragraph.kind] ?? retainedKinds[paragraph.kind] ?? t('labels.kind.text') })),
                      h('h4', null, t('inspector.sourceHeading')),
                      h('p', { className: 'qr-pane-en', lang: 'en' }, paragraph.text),
                      h('h4', null, t('inspector.translationHeading')),
                      paper.translations[paragraph.id]
                        ? h('div', { className: 'qr-pane-zh', lang: 'zh-CN' }, richAnswer(paper.translations[paragraph.id]))
                        : h('p', { className: 'qr-hint', lang: 'zh-CN' }, retainedKinds[paragraph.kind]
                            ? t('inspector.retained', { kind: retainedKinds[paragraph.kind] }) : t('inspector.waiting')),
                      h('div', { className: 'qr-actions' },
                        h('button', { type: 'button', onClick: () => copyText(paragraph.text, t('labels.source')) }, t('inspector.copySource')),
                        paper.translations[paragraph.id] &&
                          h('button', { type: 'button', onClick: () => copyText(paper.translations[paragraph.id], t('labels.translation')) }, t('inspector.copyTranslation')),
                        h('button', { type: 'button', onClick: askAboutSelected }, t('inspector.askAbout')),
                        h('button', { type: 'button', onClick: () => stepParagraph(-1) }, t('inspector.prev')),
                        h('button', { type: 'button', onClick: () => stepParagraph(1) }, t('inspector.next'))))),
                inspectorTab === 'chat' && h('section', { role: 'tabpanel', 'aria-labelledby': 'qr-tab-chat', className: 'qr-pane qr-chat' },
                  h('h3', null, t('chat.title')),
                  paper.history.length === 0 &&
                    h('p', { className: 'qr-hint' }, t('chat.empty')),
                  ...paper.history.map((turn, i) => h('article', { key: i },
                    h('p', { className: 'qr-chat-q', lang: 'zh-CN' }, turn.question),
                    h('div', { className: 'qr-chat-a', lang: 'zh-CN' }, richAnswer(turn.answer)),
                    h('div', { className: 'qr-actions' }, ...turn.references.filter(ref => activeParagraphs.has(ref.id)).map(ref =>
                      h('button', { type: 'button', className: 'qr-chip', key: ref.id, onClick: () => jumpTo(ref.page, ref.id) },
                        t('common.pageParagraph', { page: ref.page, id: ref.id })))))),
                  asking && h('p', { role: 'status', className: 'qr-hint' }, t('chat.asking')),
                  inlineAlert(errors.ask),
                  h('form', { onSubmit: ask },
                    h('label', { htmlFor: 'quiet-reader-question' }, selected ? t('chat.aboutParagraph', { id: selected }) : t('chat.aboutPaper')),
                    h('textarea', {
                      id: 'quiet-reader-question', ref: questionBox, value: question, maxLength: CONFIG.questionMaxLength, rows: 2,
                      onChange: e => setQuestion(e.target.value), onKeyDown: onQuestionKeyDown,
                      placeholder: t('chat.placeholder'),
                      'aria-describedby': 'qr-question-count',
                    }),
                    h('div', { className: 'qr-actions qr-composer' },
                      h('span', { id: 'qr-question-count', className: 'qr-hint' }, t('chat.count', { count: question.length, max: CONFIG.questionMaxLength })),
                      h('button', { className: 'qr-primary', disabled: asking || !question.trim() }, asking ? t('chat.answering') : t('chat.submit')))),
                inspectorTab === 'issues' && h('section', { role: 'tabpanel', 'aria-labelledby': 'qr-tab-issues', className: 'qr-pane' },
                  h('h3', null, t('issues.title')),
                  failureGroups.length === 0 && h('p', { className: 'qr-hint' }, t('issues.empty')),
                  failureGroups.length > 0 && h('button', {
                    type: 'button', className: 'qr-primary', disabled: !!busy || paper.status === 'running', onClick: retry,
                  }, t('issues.retryAll', { count: failures })),
                  failureGroups.map(group => h('div', { key: group.reason, className: 'qr-issue-group' },
                    h('h4', null, t('issues.group', { reason: group.reason, count: group.items.length })),
                    group.items.map(failure => h('button', {
                      key: failure.id, type: 'button', className: 'qr-issue-item',
                      onClick: () => jumpTo(failure.page, failure.id),
                    }, t('common.pageParagraph', { page: failure.page, id: failure.id })))))))),
              ),
          paper && h('footer', { className: 'qr-statusbar' },
            h('span', { className: 'qr-status-path', title: workspace?.path }, workspace?.path ?? ''),
            currentModelName && h('span', null, currentModelName),
            h('span', null, models.current?.translationMode === 'custom' ? t('settings.modeCustomShort') : t('settings.modeEconomy')),
            paper.translationStats?.requests > 0 &&
              h('span', { title: t('statusbar.repairsTitle', { count: paper.translationStats.repairs }) }, t('statusbar.calls', { count: paper.translationStats.requests })),
            h('span', null, zoom === 'fit' ? t('zoom.fit') : `${zoom}%`)),
          confirming && h(Modal, {
            label: confirming.action === 'clear' ? t('confirm.clearLabel') : t('confirm.deleteLabel'),
            onClose: () => setConfirming(null),
          },
            h('h3', null, confirming.action === 'clear' ? t('confirm.clearTitle') : t('confirm.deleteTitle', { title: paper?.title })),
            h('p', null, confirming.action === 'clear' ? t('confirm.clearBody') : t('confirm.deleteBody')),
            h('div', { className: 'qr-modal-actions' },
              h('button', { type: 'button', onClick: () => setConfirming(null) }, t('common.cancel')),
              h('button', { type: 'button', className: 'qr-danger', onClick: runConfirmed },
                confirming.action === 'clear' ? t('confirm.clearConfirm') : t('confirm.deleteConfirm')))),
          toasts.length > 0 && h('div', { className: 'qr-toasts', role: 'status', 'aria-live': 'polite' },
            toasts.map(toast => h('p', {
              key: toast.id,
              className: 'qr-toast' + (toast.tone === 'danger' ? ' qr-toast-danger' : ''),
            }, toast.text))));
      }

      /* ═══ 8. 侧栏文献树 ═══════════════════════════════════════════
         Harness exposes a sidebar list seat, but no per-workspace child seat.
         Keep its native workspaces intact and contribute a separate paper tree. */
      function ReaderTree(props) {
        const view = useSyncExternalStore(subscribe, () => snapshot);
        const currentId = useSyncExternalStore(subscribe, () => selectedPaper);
        const [expanded, setExpanded] = useState(true);
        const active = props.usePanelInfo ? props.usePanelInfo(info => info.activePanelId === PANEL) : true;
        const workspaces = props.useWorkspaces ? props.useWorkspaces(value => value) : null;
        useEffect(() => { void checkWorkspace().catch(() => {}); }, [workspaces]);
        useEffect(() => { setExpanded(true); }, [view.workspace?.id]);
        if (!active || props.wide === false || !view.workspace) return null;
        return h('nav', { 'aria-label': t('tree.label'), style: { width: '100%', minWidth: 0, maxHeight: '42vh', overflow: 'auto', fontSize: 13 } },
          h('details', { key: view.workspace.id, open: expanded, onToggle: event => {
            if (event.target === event.currentTarget) setExpanded(event.currentTarget.open);
          } },
            h('summary', { title: view.workspace.path, style: { cursor: 'pointer', overflowWrap: 'anywhere' } }, '📁 ', view.workspace.title),
            !view.items.length && h('p', { style: { paddingLeft: 16 } }, t('tree.empty')),
            ...view.items.map(item => h('details', { key: item.id, style: { margin: '6px 0 6px 14px' } },
              h('summary', { style: { cursor: 'pointer', overflowWrap: 'anywhere' } }, '📁 ', item.title),
              h('button', { type: 'button', onClick: () => { choosePaper(item.id); openReader(); },
                'aria-current': currentId === item.id ? 'page' : undefined,
                style: { margin: '6px 0 6px 16px', cursor: 'pointer', color: 'inherit', background: 'transparent', border: '1px solid currentColor', borderRadius: 4 } }, t('tree.open')),
              h('div', { style: { paddingLeft: 16, opacity: .75 } }, t('tree.hint'))))));
      }

      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL },
        props => h(ErrorBoundary, null, h(ReaderPanel, props))));
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action', id: PANEL + '-papers', order: 10,
      }, ReaderTree));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL, label: t('app.panelLabel'), order: 62,
      }, ({ size }) => h('span', { style: { fontSize: size || 16 }, 'aria-hidden': true }, '▤')));
    }

    return { inject: ['slots'], apply };
  },
});
