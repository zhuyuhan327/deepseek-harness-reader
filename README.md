# 阅藏 · DeepSeek Harness 阅读插件

[![test](https://github.com/zhuyuhan327/deepseek-harness-reader/actions/workflows/test.yml/badge.svg)](https://github.com/zhuyuhan327/deepseek-harness-reader/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

适配 DeepSeek Harness 0.2.1-rc.5。打开侧栏的「阅读模式」，上传文字型英文 PDF 后，Harness 会为该文献创建一个原生工作区，并在主面板打开双语阅读。上传时启动全文翻译，阅读页会随着进度逐段显示译文。

## 功能

- 双语对照：左右两栏共用同一份 PDF 页面底图，译文按段落位置覆盖，字号随区域大小自动调整；点击段落可在下方查看完整原文与译文。
- 文献缩放：工具栏提供「− / 比例 / ＋ / 重置」，范围 50%–300%。放大后按显示尺寸重新渲染页面，可横向滚动细看图表；比例会记住，下次打开沿用。
- 论文问答：基于当前文献的相关片段回答，选中段落后优先以该段为上下文，回答下的参考片段可跳回对应页。
- 断点续译：每批译文完成即写入磁盘；断网、退出或额度受限后打开文献点「继续全文翻译」即可，不会重复翻译已有段落。
- 译文容错：模型把 JSON 包在解释文字或代码围栏里、缺少结尾括号、返回数组或编号列表、单个段落字段异常时，仍会提取可用段落继续，不会让整篇翻译因一批失败而中断。
- 符号段落：纯符号、数字或单个变量字母（如 `∗`、`13`、`t`）直接沿用原文，不占用模型额度，也不会因为模型跳过这类段落而卡住整批。
- 只译该译的内容：上传后按段落自动分类，只翻译摘要、正文与图注/表注；arXiv 页眉、作者与单位、公式与表格数值、图内坐标轴与图例、页眉页脚、编号以及参考文献都保留原样，不生成译文覆盖层，因此不会出现乱码或遮挡。旧文献在打开时也会自动重新分类。

## 安装

需要 Node.js ≥ 22.19.0、pnpm，以及 DeepSeek Harness 桌面端（本插件按 0.2.1-rc.5 的插件 API 编写）。

1. 在插件目录安装依赖：

   ```powershell
   pnpm install --no-optional
   ```

2. 用 Harness 自带的 CLI 把插件装进你的 profile。把 `<Harness 安装目录>` 换成实际路径（桌面端一般在 `...\resources\runtime\cli\bin\dsh.cmd`）：

   ```powershell
   $readerPath = (Get-Location).Path.Replace('\', '/')
   & '<Harness 安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add "link:$readerPath"
   ```

3. 完全退出并重新打开 Harness（安装时已经在运行的实例不会自动加载新插件），登录 DeepSeek 后从侧栏进入「阅读模式」。

已把 `dsh` 加入 PATH 时可以直接执行 `dsh plugin --profile desktop add "link:$readerPath"`。使用 Harness 的 Web profile 时，把 `--profile desktop` 换成 `--profile web`。

## 打包发布

```powershell
node --test
pnpm pack
```

生成的 `dsh-quiet-reader-<version>.tgz` 可以用 `dsh plugin --profile desktop add ./dsh-quiet-reader-<version>.tgz` 安装。发布到别处时请确认 `package.json` 的 `files` 覆盖 `src`、`cordis.patch.yml` 与 `README.md`。

## 使用

1. 在「阅读模式」上传 PDF。同一文件再次上传会复用该文献的工作区和已有译文。
2. 用工具栏的缩放按钮调整页面大小；点击段落查看完整文本。
3. 在阅读面板的「论文问答」里提问。问答使用当前论文的相关片段，选中段落后优先提供该段作为上下文，回答下的参考片段可跳到对应页。

翻译和问答通过 Harness 的 `deepseek-account` 服务使用当前登录账号的额度，优先选择账号提供的 Flash 文本模型。原始 PDF、段落、译文与问答记录保存在 `$DSH_HOME/plugins/dsh-quiet-reader/papers`；未设置 `DSH_HOME` 时使用 `~/.dsh/plugins/dsh-quiet-reader/papers`。

支持最多 40 MB、150 页的可提取文本 PDF，扫描件需要先做 OCR。段落位置基于 PDF 文本坐标提取，复杂表格和公式可同时查看原页及下方完整译文。首版面向单个 Harness 实例使用，已导入文献从「阅读模式」顶部的文献列表打开。

## 验证

```powershell
node --test
```

测试覆盖：全文翻译断网续译、重复导入复用工作区、问答隔离、译文围栏/截断/数组/编号列表容错、不可解析输出时的失败路径，以及宿主拒绝跨站请求。

## 许可证

本项目采用 [MIT 许可证](LICENSE)，版权归 zhuyuhan327 所有。
