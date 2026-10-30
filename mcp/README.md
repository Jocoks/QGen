# qsp-mcp —— QGen Android 的本地 MCP 服务

让 AI（DeepSeek Harness / Claude 等支持 MCP 的客户端）直接**查找、阅读、修改** `.qsp` 游戏文件，
不用打开 App、不用手工复制粘贴。

- 传输：**Streamable HTTP**（`POST /mcp`）与 **stdio** 两种，同一份代码
  - HTTP：默认 `http://127.0.0.1:8790/mcp`（只监听回环，不对外网开放）
  - stdio：`node server.js`（不带参数）
- 实现：单个 Node 脚本 `server.js`，复用 App 的 `assets/ui/qsp.js` 编解码（与 App 完全同源的格式实现）
- 依赖：只需要 `node`（≥ 16），无 npm 依赖

## 安装 / 注册

### 方式 A：HTTP（地址:端口）

```bash
# 1) 启动常驻服务（只监听 127.0.0.1，端口可改）
#    setsid/nohup 让它脱离终端会话，否则调用结束可能被一起回收
setsid nohup sh /path/to/mcp/start-http.sh 8790 > ~/qsp-mcp.log 2>&1 < /dev/null &

# 2) 注册
mcp_hub_add name=qsp transport=streamable-http url=http://127.0.0.1:8790/mcp
```

停止：`sh /path/to/mcp/stop-http.sh`；查看状态：`curl http://127.0.0.1:8790/`。
App 的「关于」里也会显示这个地址和实时状态（运行中 / 未运行、工具数）。

### 方式 B：stdio（由客户端拉起进程）

```
mcp_hub_add  name=qsp  transport=stdio
  command=node
  args=["/path/to/mcp/server.js"]
```

Claude Desktop 等的等价配置：

```json
{ "mcpServers": { "qsp": { "command": "node", "args": ["/path/to/mcp/server.js"] } } }
```

> 注意：进程以启动它的 App 的 uid 运行，能访问哪些文件取决于该 App 的存储权限。
> HTTP 服务默认只绑定 127.0.0.1，端口用 `--http <port>` 或环境变量 `QSP_MCP_PORT` 修改。

## 工具一览（13 个）

| 工具 | 作用 |
|---|---|
| `qsp_info` | 文件概要：大小、位置数、动作数、密码、文件头、md5 |
| `qsp_list_locations` | 位置列表（序号/名称/字数/动作数），可按名称过滤 |
| `qsp_get_location` | 读取位置完整内容（描述、代码、动作） |
| `qsp_search` | 全文搜索（名称/描述/代码/动作），返回**命中次数 + 上下文行片段**（`⟦关键字⟧`），支持正则 |
| `qsp_set_location` | 整体替换描述/代码 |
| `qsp_replace` | 单字段查找替换（单处/全部、正则、捕获组） |
| `qsp_replace_all` | 全游戏批量替换（默认 dryRun） |
| `qsp_add_location` | 新增位置（可指定插入位置） |
| `qsp_rename_location` | 重命名位置 |
| `qsp_delete_location` | 删除位置 |
| `qsp_action` | 动作管理：list / get / set / delete |
| `qsp_create` | 新建空白游戏（含 Start） |
| `qsp_validate` | 写后自检：能否解析、位置/动作数、无名位置告警 |

### 例子

```jsonc
// 搜一段代码
{"tool":"qsp_search","arguments":{"path":"/storage/emulated/0/Download/game.qsp","query":"main_menu","snippetsPerLocation":2}}

// 把某位置的代码里所有旧变量名换掉（先干跑）
{"tool":"qsp_replace","arguments":{"path":"...","location":"Start","field":"code","find":"$old_var","replace":"$new_var","all":true,"dryRun":true}}

// 全游戏替换（默认干跑，确认后 dryRun=false 才写）
{"tool":"qsp_replace_all","arguments":{"path":"...","find":"Consolas","replace":"ConsolasMCP"}}
```

## 安全设计

1. **写入前备份**：自动生成 `<文件名>.bak`（每次覆盖为「上一次写入前」的版本）。
2. **原子写入**：先写同目录临时文件，再 `rename` 覆盖；失败则回退直接写。
3. **写后校验**：序列化结果会重新解析，位置数量对不上就放弃写入。
4. **干跑**：`qsp_replace` / `qsp_replace_all` 支持 `dryRun`；批量替换**默认** `dryRun=true`。
5. **只碰 .qsp**：解析失败直接报错，不会把非 QSP 文件写坏。

## 性能

- 8.6 MB / 194 个位置 / 421 万字符代码的游戏：`qsp_info` ≈ 90 ms，`qsp_search` ≈ 100–200 ms，
  写回 ≈ 50–100 ms（手机端实测）。
- 搜索默认每个位置最多 3 条片段、最多 50 个位置，可用参数放大。

## 自测

```bash
node mcp/selftest.js
```

会依次验证：握手 → 工具列表 → 读概要 → 过滤列表 → 搜索 → 读位置 →
干跑替换（文件 md5 不变）→ 真替换（生成 .bak、位置数不变）→ 读回校验 → 用 .bak 还原后 md5 与原始一致。
