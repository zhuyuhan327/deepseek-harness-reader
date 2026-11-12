# 阅藏 · DeepSeek Harness 阅读插件

[![test](https://github.com/zhuyuhan327/deepseek-harness-reader/actions/workflows/test.yml/badge.svg)](https://github.com/zhuyuhan327/deepseek-harness-reader/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

适配 DeepSeek Harness 0.2.1-rc.5。打开侧栏的「阅读模式」，上传文字型英文 PDF 后，Harness 会为该文献创建一个原生工作区，并在主面板打开双语阅读。上传时启动全文翻译，阅读页会随着进度逐段显示译文。

## 功能

- 双语对照：左右两栏沿用同一份 PDF 的页尺寸和坐标。译文按原段落位置绘制，沿用标题层级、字体类别与对齐方式，必要时缩小字号。点击段落可查看完整原文与译文。
- 中文采用微软雅黑、思源黑体等清晰的无衬线字体，正文加深并使用半粗字重；阅读和导出使用一致的文字样式。原位排版按实际文字范围避让图形，并先遮盖原文再绘制所有译文，防止相邻段落互相擦除。
- 文献缩放：工具栏提供「− / 比例 / ＋ / 重置」，范围 50%–300%。放大后按显示尺寸重新渲染页面，可横向滚动细看图表；比例会记住，下次打开沿用。
- 论文问答：基于当前文献的相关片段回答，选中段落后优先以该段为上下文，回答下的参考片段可跳回对应页。
- 断点续译：每批译文完成即写入磁盘；断网、退出或额度受限后打开文献点「继续全文翻译」即可，不会重复翻译已有段落。
- 翻译调度使用最多两批并发，按实际发送的文本长度分批。相同正文复用已完成译文，失败段落单独重试。服务限流后降低并发并短暂退避，账号额度耗尽时保存进度。
- 译文容错：模型把 JSON 包在解释文字或代码围栏里、缺少结尾括号、返回数组或编号列表、单个段落字段异常时，仍会提取可用段落继续，不会让整篇翻译因一批失败而中断。
- 符号段落：纯符号、数字或单个变量字母（如 `∗`、`13`、`t`）直接沿用原文，不占用模型额度，也不会因为模型跳过这类段落而卡住整批。
- 版面识别：结合字形、双栏阅读顺序和 PDF 绘图指令识别标题、正文、独立公式、表格、图片和图表注。结合相邻正文合并两端对齐产生的碎片，避免引文前后的句子被拆散。标题、正文和图表注参与翻译。图表本体、独立公式、页眉页脚和参考文献沿用原页。
- 页码范围：可重新上传同一 PDF 选择新范围，插件沿用同一个工作区并保留已导入页的译文。旧文献可用「重新识别版面」升级识别规则，再续译；内容未变的段落保留编号与译文，只补译合并、修正或新增的正文。
- 导出 PDF：「译文」在原页原位排版，「双语对照」将原文页和对应译文页并排放置。翻译后的文字可搜索和复制。整篇原文导出直接保存原文件。译文、双语和原文选页按图像排版，适用环境中弹出保存对话框，其余环境使用浏览器下载。
- 公式保护：翻译前保护变量、行内公式、上下标和引文。占位符缺失、重复或乱序时重试，回填后再检查译文完整性。位置匹配明确的行内数学片段使用原 PDF 的字形及上下标布局。
- 译文校验识别论文中的缩写、编号与引文，保存和重新打开使用同一规则。公式段落反复失败时，将文字片段分批翻译，再由本地代码插回公式。空回复、超长回复或未生成完的编号译文按段重试，最终失败的段落会显示页码与原因，可点击定位后继续。
- 文献管理：「清除译文」清除翻译与问答记录并保留原文和工作区。「删除文献」移除文献及其工作区。工作区从侧栏移除后，原文和译文仍可在插件的文献列表打开。
- 对照模式：按当前页的阅读顺序显示「英文原文 → 中文译文」，问答引用可跳到对应页和段落。

## 安装

### 方式一：下载 Release（推荐）

从 [Releases](https://github.com/zhuyuhan327/deepseek-harness-reader/releases/latest) 下载 `dsh-quiet-reader-<version>.tgz`，然后执行：

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

1. 在「阅读模式」上传 PDF。同一文件再次上传会复用该文献的工作区和已有译文。
2. 用工具栏的缩放按钮调整页面大小；点击段落查看完整文本。
3. 在阅读面板的「论文问答」里提问。问答使用当前论文的相关片段，选中段落后优先提供该段作为上下文，回答下的参考片段可跳到对应页。
4. 在「导出 PDF」中选择原文、译文或双语对照。导出未译完的文献时，等待翻译的段落会显示原文。

翻译和问答通过 Harness 的 `deepseek-account` 服务使用当前登录账号的额度，优先选择账号提供的 Flash 文本模型。原始 PDF、段落、译文与问答记录保存在 `$DSH_HOME/plugins/dsh-quiet-reader/papers`；未设置 `DSH_HOME` 时使用 `~/.dsh/plugins/dsh-quiet-reader/papers`。

支持最多 40 MB、150 页的可提取文本 PDF，扫描件需要先做 OCR。段落位置基于 PDF 文本坐标提取，复杂表格和公式可同时查看原页及下方完整译文。首版面向单个 Harness 实例使用，已导入文献从「阅读模式」顶部的文献列表打开。

## 验证

```powershell
node --test
```

测试覆盖 PDF 版面识别、原位 PDF 的文字层、选页重导、翻译续译、行内公式保护、模型输出容错，以及清除译文或删除文献时取消后台任务。

维护者发版：运行 `pnpm pack` 生成 `dsh-quiet-reader-<version>.tgz`，作为 GitHub Release 的附件上传。

## 许可证

本项目采用 [MIT 许可证](LICENSE)，版权归 zhuyuhan327 所有。


