# 阅藏 · DeepSeek Harness 阅读插件

[![test](https://github.com/zhuyuhan327/dsh-translation-reader/actions/workflows/test.yml/badge.svg)](https://github.com/zhuyuhan327/dsh-translation-reader/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

打开侧栏的「阅读模式」后，必须先选择工作区文件夹。该文件夹登记为 Harness 的根工作区，每篇上传的文字型 PDF 存入其中独立的文献子目录，并在主面板打开双语阅读。上传时启动全文翻译，阅读页会随着进度逐段显示译文。

## 功能

- **原位双语翻译**：译文按原段落位置、字号与对齐方式绘制，中文使用清晰黑体；公式保留原页，空间不足时自动缩小字号。
- **对照阅读**：左右分栏或按页顺序查看「原文 → 译文」，点击段落可查看完整原文与译文。
- **论文问答**：基于当前文献的相关片段回答，选中段落时优先以该段为上下文，参考片段可跳回原文位置。
- **断点续译**：每批译文即时写入磁盘，断网、退出或额度用尽后点「继续全文翻译」即可，不重复翻译已有段落。
- **翻译调度与省费**：最多两批并发，先完成首轮再小批补译；默认「快速省费」（翻译关闭深度思考，问答仍用所选推理强度），模型可选，显示调用次数，支持暂停。
- **公式与校验**：翻译前保护变量、行内公式、上下标与引文；校验失败按段重试，纯符号段落直接沿用原文，不占用模型额度。
- **版面识别**：自动识别双栏顺序、标题、正文、公式、图表与图注，合并对齐碎片和公式前后正文；旧文献可「重新识别版面」，已译段落尽量保留。
- **导出 PDF**：「译文」原位排版、「双语对照」并排、原文直接保存；导出前检查未译段落与无法完整排版的位置。
- **工作区与文献树**：先选择根文件夹，每篇文献存入独立子目录；侧栏文献树支持展开、打开、清除译文与删除文献。
## 安装

### 方式一：下载 Release（推荐）

从 [Releases](https://github.com/zhuyuhan327/dsh-translation-reader/releases/latest) 下载 `dsh-quiet-reader-<version>.tgz`，然后执行：

```powershell
dsh plugin --profile desktop add ./dsh-quiet-reader-<version>.tgz
```

完全退出并重新打开 Harness，登录 DeepSeek 后从侧栏进入「阅读模式」。

### 方式二：从源码 link 安装

需要 Node.js ≥ 22.19.0 与 pnpm，以及 DeepSeek Harness 桌面端（本插件按 0.2.1-rc.5 的插件 API 编写）。

1. 在插件目录安装依赖：

   ```powershell
   pnpm install --no-optional
   ```

2. 用 Harness 自带的 CLI 把插件装进你的 profile。把 `<Harness 安装目录>` 换成实际路径（桌面端一般在 `...\resources\runtime\cli\bin\dsh.cmd`）：

   ```powershell
   $readerPath = (Get-Location).Path.Replace('\', '/')
   & '<Harness 安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add "link:$readerPath"
   ```

3. 完全退出并重新打开 Harness。

已把 `dsh` 加入 PATH 时可以直接执行 `dsh plugin --profile desktop add "link:$readerPath"`。使用 Harness 的 Web profile 时，把 `--profile desktop` 换成 `--profile web`。

## 使用

1. 在「阅读模式」先选择工作区文件夹，再上传 PDF。同一工作区内再次上传相同文件，会复用对应文献子目录和已有译文；不同工作区分别保存。
2. 用工具栏的缩放按钮调整页面大小；点击段落查看完整文本。
3. 在阅读面板的「论文问答」里提问。问答使用当前论文的相关片段，选中段落后优先提供该段作为上下文，回答下的参考片段可跳到对应页。
4. 在「导出 PDF」中选择原文、译文或双语对照。导出未译完的文献时，等待翻译的段落会显示原文。

翻译和问答可使用 Harness 中已配置的文本模型；未指定时优先使用 `deepseek-account` 的 Flash 模型。实际计费由模型服务决定，插件显示的调用次数不等于账单金额。模型和推理选项切换后在下一次启动翻译时生效。原始 PDF、段落、译文与问答记录保存在所选工作区的文献子目录内；插件设置保存在 `$DSH_HOME/plugins/dsh-quiet-reader`，未设置 `DSH_HOME` 时使用 `~/.dsh/plugins/dsh-quiet-reader`。旧版集中存储的文献可通过选择原来的 `papers` 文件夹重新识别，无需重新上传原文。

支持最多 40 MB、150 页的可提取文本 PDF，扫描件需要先做 OCR。段落位置基于 PDF 文本坐标提取，复杂表格和公式可同时查看原页及下方完整译文。首版面向单个 Harness 实例使用，已导入文献从「阅读模式」顶部的文献列表打开。

## 验证

```powershell
node --test
```

测试覆盖工作区必选、目录重新发现、切换后的旧请求隔离、删除边界、PDF 版面识别、字号与碰撞、原位 PDF 的文字层、选页重导、暂停续译、公式保护、模型输出容错、补译请求上限和不响应取消的模型流。持续集成在 Windows 与 Linux 上运行测试。

## 代码结构

- `layout.js` / `classify.js`：版面几何提取和段落分类。
- `math.js`：变量、公式、引文保护及完整性校验。
- `translation-response.js`：模型输出解析和正文完整性检查。
- `translation.js`：缓存复用、并发队列、分批补译与请求预算。
- `model.js`：模型路由、流式请求、提示词和问答检索。
- `presentation.js` / `pdf-export.js`：预览与导出共用排版，以及 PDF 文字层。
- `workspace.js`：工作区选择、文献目录发现、文件身份与目录边界检查。
- `host.js` / `client.js`：存储、任务生命周期和阅读界面。

维护者发版：运行 `pnpm pack` 生成 `dsh-quiet-reader-<version>.tgz`，作为 GitHub Release 的附件上传。

## 许可证

本项目采用 [MIT 许可证](LICENSE)，版权归 zhuyuhan327 所有。


