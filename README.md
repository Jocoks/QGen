# QGen Android 1.3.11

**QSP 游戏（`.qsp`）编辑器 · 安卓版**

本项目是把开源桌面程序 [QGen](https://github.com/QSPFoundation/qgen)（QSP Foundation，GPLv2+）的核心能力
搬到 Android 上的一次**重实现**：界面用 WebView + 原生 JS 重写，QSP 文件格式的读写逻辑按 QGen 4.3 的
`game.cpp` 逐字节对齐，Java 侧只保留「读/写字节」的薄壳。

已实测：用本 App 打开 8.6 MB 的 `jack.qsp`（194 个位置、约 421 万字符代码），**原样保存后与原文件 md5 完全一致**
（`7b603abd9df2d71b9f2e0518ec021173`），即读写无损。

> **1.3.11 变更**：修复代码页查找不定位/不高亮的问题（输入法组词、回车提前跳转、切换位置后旧结果未刷新、自动换行时滚动位置）。
>
> **1.3.10 变更**：记录表默认**隐藏空列/空单元格**，新增「▦ 列」勾选隐藏不关心的子属性。
>
> **1.3.9 变更**：**记录表**支持直接修改标量字段/代码块并撤销，窄屏改为逐条卡片布局。
> 自动扫描 QSP 里按 id 聚合的静态数据（数组、helper 参数、代码块），生成可筛选的表格；
> 可人工加列、做标记并导出 CSV。
>
> **1.3.8 变更**：新增只读「记录表」原型。
>
> **1.3.7 变更**：新增 **TXT 工程导出 / 导入**。可以把当前 `.qsp` 拆成「每个位置一个 `.txt`」的工程，
> 连同 `manifest.json` 打包成 `.zip`；也能把这种 `.zip` 还原成 `.qsp`（支持逐字节无损往返）。
>
> **1.3.6 变更**：编辑器只保留**代码页** —— 去掉了「描述」「动作」两个页签，点开位置就直接开始写代码。
> 文件里原有的描述 / 动作数据仍按 QSP 格式完整解析与写回，**保存时不会被改动或丢弃**。

---

## 〇、先看「关于」

App 首页底部点 **关于 / 许可**，里面有一块 **MCP 服务** 面板，直接显示：

- 地址：`http://127.0.0.1:8790/mcp`
- 状态：● 运行中 / 未运行（App 会实时探测，没有服务进程也可以看）
- 工具数：运行中时显示 13 个
- 启动命令（长按可复制）与 APK 内置文件路径

## 一、功能

| 功能 | 说明 |
|---|---|
| 打开 `.qsp` | 通过系统文件选择器（SAF）从下载 / 文档 / 任意目录打开；也可从「最近打开」或应用私有目录打开 |
| 位置列表 | 全部位置一览，显示代码字数；支持按名称、代码搜索过滤 |
| 搜索结果 | 每条结果显示命中次数（按 代码/名称 拆分）；**只命中一处**时直接显示命中行（关键字前后各 15 字，超长以 … 截断，关键字高亮） |
| 编辑位置 | 点开位置**直接进入代码页**（没有页签，进来就是代码） |
| 代码高亮 | QSP 语法着色：注释、字符串、数字、关键字、`$变量`、运算符（默认开启，底部「高亮」可一键关闭；超长代码自动关闭以保证流畅） |
| 字号缩放 | 代码页**双指捏合**直接缩放，或点 `A−` / `A+`（8–28px），偏好会记住 |
| 行距/换行 | `行距` 在 115% / 130% / 145% / 170% 间切换（默认 130%）；可切换「自动换行」（换行时隐藏行号，避免行号错位） |
| 代码内查找 | 右上角 🔍 打开查找条：输入即高亮全部命中并显示 `n/总数`，`↑`/`↓` 跳转，当前命中深黄色 |
| 行号 | 代码页左侧行号，随滚动同步 |
| 位置管理 | 新建位置、重命名、创建副本、删除 |
| 游戏信息 | 位置数、代码字数、密码、文件头；可修改游戏密码 |
| 保存 | 保存回原文件（SAF 持久授权）；**另存为**新建 `.qsp`（默认文件名可在对话框里改） |
| 未保存提示 | 标题 `●` / 底部「未保存」标记；退出、关闭、重新载入前都会确认 |
| 竖屏 | 固定竖屏，不随重力旋转 |
| 最近打开 | 记住最近 12 个文件（含持久读/写授权） |
| **TXT 工程导出** | 把 `.qsp` 拆成每个位置一个 `.txt`，附 `manifest.json` / `README.txt`，打包成 `.zip` 保存 |
| **TXT 工程导入** | 选择 `.zip` 还原成 `.qsp`；有 manifest 时完整恢复密码、描述、动作与文件头，无 manifest 时按文件名兼容导入 |
| **记录表** | 自动发现按 id 聚合的静态记录族（数组/helper/代码块），表格查看/筛选、空值隐藏、列隐藏、单元格修改与撤销、人工加列/标记、导出 CSV |

**有意未实现**（见「已知限制」）：QGen 的文件夹（project .xml）结构、txt2gam 原生格式的完整兼容、
内置 QSP 播放器（需另移植 qspcore）。

## 二、界面与配色

浅色主题：**白底为主、黄色点缀**（主色 `#FFC400`，用于 Logo、主按钮、未保存标记与强调文字），
代码区用等宽字体 + 语法着色，长代码默认不换行（可横向滚动），可一键切换换行。

1.3.6 的界面截图见 `docs/screenshots/`：点开位置即代码页、右上角查找、游戏信息。

## 三、安装

已发布 APK 见 [Releases](https://github.com/Jocoks/QGen/releases) 里的 `QGen-Android-1.3.6.apk`
（minSdk 26 / targetSdk 34，已用 debug 证书签名）。本文档对应的 1.3.11 为源码版本，
需按第九节自行构建（或等待 Release 更新）。

1. 把 APK 传到手机，点开安装；如提示「未知来源」，允许一次即可。
2. 首次打开从「打开 .qsp 文件」开始。

> 签名是自签名（debug keystore），仅用于自用/测试；正式分发请自行换 keystore 重新签名。

## 四、使用

1. **打开**：首页 →「打开 .qsp 文件」→ 选中文件（例如 `/sdcard/Download/game.qsp`）。
2. **浏览**：位置列表 + 顶部搜索框（搜名称/代码）。
3. **编辑**：点位置 → **直接进入代码页**（描述与动作页签已移除）。编辑后标题出现 `●`。
   代码页默认带语法高亮；底部还有 `A−/A+ 字号`、`高亮`、`行距`、`换行` 四个控制。
   代码页：**双指捏合**缩放字号，或底部 `A−` / `A+`；`行距` 切档；`换行` 开关；
   点右上角 🔍 在当前代码里查找，↑/↓ 跳到上一处/下一处。语法高亮随输入实时更新。
4. **保存**：右上 `⋮` → 保存（写回原文件）；或「另存为…」。
5. **搜索定位**：搜索框输入关键字 → 列表只剩命中的位置 → 点开编辑。
6. **导出 TXT 工程**：右上 `⋮` →「📦 导出 TXT 工程（.zip）」→ 选保存位置，得到可解压编辑的 zip。
7. **导入 TXT 工程**：右上 `⋮` →「📥 导入 TXT 工程（.zip）」→ 选 zip；确认未保存修改后导入，
   再「另存为」成 `.qsp`。
8. **记录表**：右上 `⋮` →「🧾 记录表（查看/修改）」→ 选一个候选记录族 → 查看/筛选；
   点带 `✎` 的单元格改值，点「↶ 撤销」回退；点「＋ 添加列」可加人工列；「导出 CSV」保存当前表。

## 五、TXT 工程（.zip）

「TXT 工程」是一个普通 zip，解压后结构如下：

```
manifest.json                 工程清单（格式、版本、游戏头、密码、每个位置的文件名/描述/动作）
README.txt                    给人看的说明
locations/0001_Start.txt      第 1 个位置的代码（UTF-8 纯文本）
locations/0002_....txt        第 2 个位置的代码
...
```

* **导出**：菜单 `⋮` →「📦 导出 TXT 工程（.zip）」。代码按位置拆成独立文本，描述与动作写进
  `manifest.json`，所以再导入时不会丢数据；文件按序号命名，重名位置也不会互相覆盖。
* **导入**：菜单 `⋮` →「📥 导入 TXT 工程（.zip）」，或首页「导入 TXT 工程」按钮。导入结果是
  **未保存的新文档**，需要再「另存为」成 `.qsp`。
* **兼容模式**：zip 里没有 `manifest.json` 时，所有非 `README.txt` 的 `.txt` 都会按文件名当作位置名
  （会去掉 `001_` 这类序号前缀），内容当作代码；此时密码为默认 `No`，描述/动作为空。
* 导出的 zip 使用 UTF-8 文件名与 DEFLATE 压缩；读取同时支持 STORE / DEFLATE，并校验 CRC32 与长度，
  拒绝加密、ZIP64 和未知压缩方式。

命令行验证（Node）：

```bash
$ node tools/test-txt-zip.js /path/to/jack.qsp
  结果: 22 通过, 0 失败
```

实现见 `assets/ui/qsp-text.js`（工程清单与文本拆分）和 `assets/ui/zip.js`（纯 JS ZIP 读写），
不依赖 Java 的 `java.util.zip`，因此浏览器演示模式与 Node 测试也能跑同一套代码。

## 六、记录表（查看与修改）

QSP 里大量“物品/敌人/NPC”并不是用统一字段直接赋值的：常见写法是
`dynamic $ib_cycle, 'id', '名称', 价格, ...` 或 `$item_name['id'] = '...'`。
直接 grep 某个字段会漏掉另一套写法，所以 1.3.8 加了“记录表”，1.3.9 起支持单元格修改，1.3.10 起可隐藏空列/子属性：

* 打开文件 → 右上 `⋮` →「🧾 记录表（查看/修改）」。
* 扫描会按**位置**聚合静态 key（数组下标、`dynamic` 的第一个参数），生成候选记录族；
  每个候选显示记录数、列数和前几个 id。
* 点候选进入表格：首列是 id，其余列来自数组字段、helper 参数、代码块或人工列；缺失值显示 `—`。
* **隐藏空值**：工具栏「空值」开关默认开启，整列都没有值的字段和每条记录里的空单元格不显示；
  点一下可切换为显示。人工列即使为空也会保留，方便填写。
* **隐藏子属性**：点工具栏「▦ 列」，取消勾选不想看的列，确定后立即生效；列设置按记录族保存在本机，
  重新打开同一记录族仍然保留。
* **修改单元格**：点带 `✎` 的单元格，改完确定即写入内存中的 QSP；再点右上「保存」落盘。
  helper 参数会替换对应实参，数组/代码块只替换该条语句的 `=` 右侧；`+=` 等复合赋值不直接改。
  冲突值、缺失值不开放直接改，避免误改；每次修改后可用「↶ 撤销」按后进先出回退。
* **添加列**：表格上方「＋ 添加列」，来源可选：
  * `Helper 参数`：指定 helper 名与参数序号（1 起，主键通常是 1）；
  * `数组字段`：如 `$item_name`，可加二级路径；
  * `代码块`：取 `$item_property['id'] = { ... }` 的整段 `{ ... }`；
  * `固定值` / `人工标记`。
* **人工标记**：人工列的单元格可点击编辑，值保存在本机 `localStorage`，按“文件名 + 描述符 id”区分；
  重新打开同一文件仍保留。人工列会以淡黄色底显示。
* **窄屏自适应**：宽度小于 640px 时，表格自动改为每条记录一张卡片，字段名在左、值在右，不再横向滚动。
* **导出 CSV**：导出当前记录族的全部行（UTF-8 带 BOM，Excel 可直接打开）。

自动扫描只覆盖**静态、按 key 聚合**的数据，不执行 QSP 逻辑；带复杂条件分支、循环动态生成的记录
可能识别不到，需要人工建列或后续扩展描述符。当前修改是**逐条单元格**写入；批量选中/批量替换、
写回前 diff 预览尚未实现。

命令行验证：

```bash
$ node tools/test-records.js /path/to/game.qsp
  结果: 18 通过, 0 失败
```

## 七、QSP 文件格式（实现依据）

依据 `qgen/game.cpp`（QGen 4.3.0-b1）与实测 `jack.qsp` 反推，文件是 **UCS-2LE（UTF-16LE 码元）** 文本：

```
QSPGAME\r\n                 文件标识（不加密）
<日期/版本>\r\n              不加密
<密码>\r\n                   加密（默认 "No"）
<位置数>\r\n                 加密
for each location:
  <名称>\r\n <描述>\r\n <代码>\r\n <动作数>\r\n
  for each action:
    <图片路径>\r\n <动作名>\r\n <动作代码>\r\n
```

加密规则（`QSP_CODREMOV = 5`）：每个码元 `v` 写为 `v-5`；若原字符恰为 `5`，写作 `0xFFFB`（避免产生 `\0`）。
读取时反过来：`0xFFFB → 5`，其余 `+5`。字段内换行以 `\r\n` 存储。

> 编辑器虽然不再显示描述与动作，但 `parse()` / `serialize()` 仍完整读写这两块字段，
> 所以打开旧 `.qsp` 再保存，描述与动作会原样保留。

实现见 `assets/ui/qsp.js`（`parse()` / `serialize()`），并有 Node 测试 `tools/test-qsp.js`：

```
$ node tools/test-qsp.js /path/to/jack.qsp
  解析耗时 80ms，位置 194，动作 0 ...
  ok  未修改时逐字节无损往返
  ok  特殊字符往返（5 / 换行 / emoji / 引号）
  结果: 8 通过, 0 失败
```

## 八、源码结构

```
AndroidManifest.xml            竖屏锁定、SAF/VIEW 入口
java/com/qsp/qgen/MainActivity.java   唯一 Activity：WebView + JS 桥（文件读写、SAF、最近文件）
assets/ui/index.html           界面结构
assets/ui/style.css            浅色主题（白 + 黄）+ 移动端布局
assets/ui/qsp.js               ★ QSP 格式读写核心（浏览器/Node 通用）
assets/ui/syntax.js            QSP 语法高亮（纯函数，可 Node 测试）
assets/ui/native.js            JS ↔ Java 桥接层（浏览器演示模式降级）
assets/ui/zip.js              ★ 纯 JS ZIP 打包/解包（STORE/DEFLATE，CRC 校验）
assets/ui/qsp-text.js         ★ TXT 工程清单与拆分/还原
assets/ui/records.js          ★ 记录表：静态扫描、描述符、建表、CSV
assets/ui/app.js               界面逻辑（列表/代码编辑器/搜索/对话框/保存/TXT 工程/记录表）
mcp/server.js                  ★ MCP 本地服务（stdio，AI 可直接读写 .qsp）
mcp/README.md                  MCP 工具文档
mcp/selftest.js                MCP 自测脚本
res/                          图标（自适应矢量）、主题、字符串
build.sh                       设备内构建脚本
tools/test-qsp.js              Node 端编解码测试
tools/test-txt-zip.js          Node 端 TXT 工程 / ZIP 往返测试
tools/test-records.js          Node 端记录表扫描/建表/人工列测试
```

## 九、构建（在 Android 设备上直接构建，无需 Gradle）

本仓库自带 `build.sh`，使用 Termux 环境里的 `aapt2` + `d8` + `apksigner` + JDK17：

```bash
# 依赖：aapt2、d8.jar、apksigner.jar（Termux: aapt / d8 / apksigner 包）、JDK 17、
#      android.jar（Android platform，例如 platform-35）、一个签名用 keystore
export PREFIX=/data/data/com.termux/files/usr          # 你的 Termux 前缀
export ANDROID_JAR=$HOME/android-sdk/platforms/android-35/android.jar
export KEYSTORE=$HOME/.android/debug.keystore           # 签名证书
./build.sh build/qgen-android.apk
# 产物：build/qgen-android.apk（已签名）
```

`KS_PASS` 可覆盖 keystore 密码（默认 `pass:android`，即 Android 默认 debug keystore 的密码）。

`build.sh` 做四件事：`aapt2 compile/link` → `javac`（对 android.jar）→ `d8` → 打 dex + `apksigner`。

## 十、MCP 本地服务（给 AI 用的，1.1.0 起随 APK 内置）

`mcp/` 里附带一个 stdio MCP 服务，让 AI 直接查找/阅读/修改 `.qsp`：

```bash
# 1) 起 HTTP 服务（只监听 127.0.0.1:8790，端口可改）
#    用 setsid/nohup 让它脱离当前会话，避免一起被回收
setsid nohup sh <项目目录>/mcp/start-http.sh 8790 > ~/qsp-mcp.log 2>&1 < /dev/null &

# 2) 在 DeepSeek Harness 里注册（地址:端口 形式）
mcp_hub_add name=qsp transport=streamable-http url=http://127.0.0.1:8790/mcp

# 或者用 stdio（由客户端拉起进程）：
# mcp_hub_add name=qsp transport=stdio command=<node> args=["<项目目录>/mcp/server.js"]
```

APK 的 `assets/mcp/` 里内置了一份可直接运行的 `server.js`（连同 `qsp.js` 编解码）：
从 APK 里取出后 `node assets/mcp/server.js --http 8790` 即可起 HTTP 版，
不带参数则走 stdio。

13 个工具：`qsp_info` / `qsp_list_locations` / `qsp_get_location` / `qsp_search` /
`qsp_set_location` / `qsp_replace` / `qsp_replace_all` / `qsp_add_location` /
`qsp_rename_location` / `qsp_delete_location` / `qsp_action` / `qsp_create` / `qsp_validate`。

安全：写入前自动 `.bak` 备份、临时文件原子替换、写后重新解析校验、批量替换默认干跑。
详见 [mcp/README.md](mcp/README.md)。

## 十一、已知限制

* 只支持 **UCS-2 新版** `.qsp`（`QSPGAME` 头）。QGen 4 之前的旧 `.gam` 格式会提示不支持。
* 不支持 QGen 的「文件夹」工程结构（`.xml` 工程文件），位置列表是平铺的。
* 没有内置 QSP 运行时，所以**不能试玩**；纯编辑/保存。试玩可把 `.qsp` 交给 FastQSP / QSP 播放器。
* 没有完整兼容 txt2gam 的原生格式；TXT 工程是本项目自己的 zip 约定（可通过 `manifest.json` 往返，
  也可用无 manifest 的「每个位置一个 txt」兼容导入）。
* TXT 工程导出需要浏览器/WebView 支持 `CompressionStream`；不支持时自动退化为不压缩的 STORE，
  仍可正常导出，只是 zip 更大。导入 DEFLATE 工程需要 `DecompressionStream`（较新的 Android System WebView）。
* 记录表只做静态聚合，不执行 QSP 逻辑；标量/代码块修改直接进入当前内存文件，保存后才落盘。
  人工列保存在本机 localStorage。
* 一次只打开一个文件；未做自动保存草稿。

## 十二、许可与致谢

* 本程序以 **GPLv2+** 发布，与 QGen 一致。
* 文件格式实现参考 QGen 4.3（作者 Vladimir Bauer / Nex / Shchannikov Dmitry / Valeriy Argunov），
  项目地址 <https://github.com/QSPFoundation/qgen>。
* QSP 引擎与本编辑器无关，见 <https://github.com/QSPFoundation>。
