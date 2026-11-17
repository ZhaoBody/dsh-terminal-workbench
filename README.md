# dsh-terminal-workbench

把 DeepSeek Harness 改造成一个**终端工作台**：左边会话、中间真终端、右边对话，
并且让模型能用一组工具在自己的终端里干活——但**碰别人的终端、删远端文件、开隧道要你点头**。

单插件实现，替代内置的 `ui-layout` 与 `ui-sidebar-terminal`。

## 它做了什么

**布局**
- 三栏：左侧会话列表、中间自绘 xterm、右侧对话。
- 中栏支持多个终端标签，每个会话有自己的专属终端。
- 兼容承诺：对外提供与内置同名的 `layout` 服务，`ui-sidebar` / `conversation` /
  `plugin-manager` 等插件零改动继续工作。

**网页标签**（v0.9.5）
- 右栏加号菜单新增「网页」：输入网址回车，就在终端同一列打开一个 iframe 标签。
- 地址栏可继续导航、刷新；↗ 交给系统浏览器打开。
- 支持 `localhost:3080`、`127.0.0.1:3080` 和裸域名；普通文本走 Bing 搜索。
- 站点若用 `X-Frame-Options` / CSP `frame-ancestors` 拒绝嵌入，会显示空白提示；
  这不是插件故障，点 ↗ 在浏览器打开即可。
- 主输入框里直接粘贴 `http(s)://` / `www.` / `localhost` 开头的地址也会开网页标签。

**相机标签：统一 RTSP + 悬浮按钮**（v0.12.0）
- 相机入口从加号面板拆成**可展开的移动悬浮按钮**：x 始终跟随终端列与主区的分界线，
  上下可拖动（位置记在 localStorage）；点击展开，点面板外或 Esc 收起。
- 展开后第一项是 **IP 末位**输入：前缀自动取当前 SSH 终端主机的 `/24`
  （如终端 `192.168.1.5` → 前缀 `192.168.1.`，输入 `20` 打开 `192.168.1.20`）。
- 终端 ↔ 相机前缀是**显式映射**：SSH 书签新增「相机前缀」字段，留空按主机前三段推导；
  填 `192.168.2.` 就能让同一台终端打开另一网段的相机。没有 SSH 终端时沿用上次前缀。
- 同一 IP 已有相机书签就复用（保留账号、口令、流路径），没有才新建空白书签。
- **相机密码组**（v0.13.2）：书签只记「车号 / 项目 / 是否吊具」，密码集中放在
  `dsh-terminal-workbench.cameraPasswordGroups`。普通相机按**车号**共用一组，
  吊具相机按**项目**共用一组；同组相机密码留空即复用，改一次全组生效。
  车号自动取 **SSH 书签标题**，项目自动取**书签分组名**（默认分组不算项目），
  相机表单只显示归属、不再手填；绑定密码组的相机书签不再重复保存明文密码。
  组密码和书签一样只存在浏览器 localStorage；密码输入框按现场要求**明文显示**，
  便于核对，不进 URL、日志或临时文件。
- **统一按 RTSP 取流**：宿主用 go2rtc 拉流，浏览器用 MSE 播放；不需要 ffmpeg。
- **同源 WebSocket 代理**：浏览器只连 DSH 的 `/camera/ws`，宿主转发到本机 go2rtc。
  浏览器与 DSH 不同机、DSH 走 HTTPS 时都能用；不额外暴露 go2rtc 端口。
- go2rtc 按需启动，只监听 `127.0.0.1` 的随机端口，空闲 180 秒自动退出；
  临时配置目录权限 0700、配置 0600，退出时一起删掉。目录优先放 `/dev/shm`（tmpfs），
  go2rtc 回写的活动流地址（含口令）只存在内存里；没有 tmpfs 的平台才退回系统临时目录。
- **后台标签暂停**：相机标签切走 5 秒后停止拉流，切回来自动重连；多相机场景不占看不见的带宽。
- **低延迟播放**：MSE 只保留最近 2 秒缓冲，缓冲差 0.45 秒内按 1 倍速，超过才轻微追赶，
  落后 1.2 秒以上直接跳到直播点；海康 `102`、大华 `subtype=1` 子码流预设可进一步降码率。
- **流复用**：流名取 RTSP 地址的哈希，同一台相机多开标签共享一条 go2rtc 流，
  引用计数归零才删除，不会重复拉流 / 转封装。
- **播放器缓存**：`player.js` 只在首次读取并预压缩，URL 带构建号后可长期缓存，
  支持 gzip 与 `304 Not Modified`。
- 安装位置按优先级：`DSH_GO2RTC_BIN` → `~/.dsh/tools/go2rtc/go2rtc` →
  插件 `bin/go2rtc` → `PATH`。本机已装在 `~/.dsh/tools/go2rtc/go2rtc`。
- RTSP 地址里的账号 / 口令自动百分号编码；口令带 `@` 也不会被误解析成主机名。
- 内置安讯士 / 韩华 / 海康 / 大华 RTSP 预设：安讯士大车（38-45）走
  `/axis-media/media.amp?videocodec=h264`，安讯士吊具走同路径加 `&camera=5`，
  韩华大车走 `/profile3/media.smp`；MJPEG / JPEG 快照保留为兼容模式，
  只给没有 RTSP 的老相机用。
- **自动识别品牌**（v0.13.6）：宿主发**不带口令**的 RTSP `DESCRIBE`，
  路径回 401/200 判为存在、404 判为品牌不对，再按候选表自动切到正确路径。
  只纠正内置默认路径，用户手填的路径不动；识别结果会写回相机书签。
  相机表单也有「自动识别品牌」按钮，保存前就能确认路径。
- **H.265 自动找 H.264**（v0.13.7）：浏览器 MSE 只稳定支持 H.264。宿主建立
  RTSP 会话前会对韩华 `/profile1..6/media.smp`、海康 `101`、大华 `subtype=0`
  等可能输出 H.265 的路径做**带 Digest 认证的 DESCRIBE**，读 SDP 里的
  `a=rtpmap` 判断编码；发现 H.265 就在同一品牌内自动切到 H.264 profile
  （韩华 `profile2`、海康 `102`、大华 `subtype=1`），并把新路径写回书签。
  相机表单也有「找 H.264 码流」按钮；播放器仍报 H.265 时会自动重试一次，
  错误浮层提供「自动换 H.264」。相机确实没有 H.264 码流时，会明确提示去
  相机 Web 改码流，而不是只显示 go2rtc 的原始错误。
- **相机书签跟随终端**（v0.13.8）：相机书签记住来源 SSH 书签 id。SSH 书签改名或换分组后，
  相机车号、项目、密码组自动同步；旧密码组里的口令会带到新组（新组已有密码则以新组为准）。
  老相机书签首次加载时按「车号 + 项目」唯一匹配补链接，匹配到多条（归属有歧义）不硬绑；
  来源书签删除后保留上次归属快照。相机表单会显示「跟随 SSH 书签「…」」。
- **相机面板列表跟随终端**（v0.13.9）：悬浮面板先列「当前终端」的相机（普通相机按车号、
  吊具相机按项目），再列同网段相机；两者都没有时才兜底显示其他书签。
  切换终端标签后列表随之更新，不再把别的车、别的项目的相机混在最前面。
  从 SSH 书签打开终端时，会话会保留书签的 `id` 与 `groupId`，项目归属和来源链接
  不会因为命令反查而丢失。
- **RTSP 认证探测复用连接**（v0.13.10）：401 挑战和带 Digest 认证的 `DESCRIBE`
  改在同一条 TCP 连接上完成，`CSeq` 按 1 → 2 → 3 递增；不再每次请求新开连接。
  韩华 iPOLiS 这类把 nonce 绑在连接上的相机不会再被误判成「账号密码错误」。
  绝对 URI 认证失败时，仍在同一连接上改用路径形式重试；相机若在 401 后主动断开，
  会自动换连接重新挑战，兼容不绑定 nonce 的相机。
- **相机前缀跟随最后使用的终端**（v0.13.11）：相机标签激活时终端标签不再处于
  `aria-selected=true`，旧逻辑会退回 DOM 里第一个终端，导致从 A 车终端打开相机却
  显示 B 车终端的前缀。现在记住最后一次选中的终端（按激活分栏判断），相机/网页
  标签激活时继续沿用；切回终端标签后立即跟随新终端。
- **SSH 假绿兜底**（v0.13.12）：刷新、WebSocket 重连或标签重新挂载会丢掉 OSC777
  断线信标，恢复会话又默认按「已连接」显示，导致 ssh 已退出、右上角胶囊仍亮绿。
  现在所有书签会话都会检查屏幕尾部：只有「最后一行是空提示符」且「最后 4 行内
  出现强断线文本」才判开；裸 `Broken pipe`、提示符后已敲新命令、旧输出里的断线词
  都不会误判。恢复/重挂载时还会主动补查一次，不必等下一次输出。
- **右栏全屏真正铺满**（v0.13.13）：宿主右栏面板的「全屏」按钮只把
  `rightbarFullscreen` 写进 store，旧布局从不读它，点了等于没反应。现在全屏时网格
  切成 `0px minmax(0px, 1fr) 0px`：左右列归零并隐藏，终端列吃满视口，相机浮层和
  两根拖拽把手一并收起；宿主面板原本写死的 `100vw` 改成贴合列宽的 `100%`，
  不再横向溢出。再点一次「退出全屏」即可回到原来的三栏宽度。
- **文件面板跟随 SSH 书签 + 空白页修复**（v0.13.14）：文件面板过去只认
  `.dsh-terminal-workbench/remotes.json`，现场没这份清单就永远「远端未配置」。
  现在打开面板时把当前 SSH 书签的 host/port/username/auth/password 经
  `POST /fs/connect` 登记给宿主，密码只走请求体、宿主只放内存、不落盘不进日志；
  别名直接用书签名（中文、`+`、空格都支持），`remotes.json` 显式配置仍然优先。
  同时修掉面板 chunk 文件名不合规导致的整块空白：宿主只接受
  `client.<name>.js`，旧名 `client-fs-panel.js` 会让 `require.async` 抛错，
  连终端渲染树一起崩掉；现在改名为 `client.fs-panel.js` 并加了装载契约回归。
- **文件按钮让位抽屉**（v0.13.15）：面板打开后「文件」按钮不再停在原地压住面板
  头部，而是退到面板左外侧当抽屉把手（偏移量与面板宽度同用
  `min(380px, 72%)`），面板头部原本为悬浮按钮预留的 34px 顶部内边距也收回到 8px。
- **面板连接与错误展示**（v0.13.16）：书签别名未登记时不再回落到第一台机器，
  而是明确提示「远端未配置」；登记失败会显示宿主返回的原因；新增
  `POST /fs/disconnect` 主动释放连接；连回环地址失败时提示检查 SSH 隧道。
- **上传 / 下载**（v0.13.17）：文件面板支持多文件队列上传与流式下载，上传同名
  先确认、宿主 409 兜底；写临时文件再原子 rename，失败不留下半成品。
- **传输健壮性与大目录**（v0.13.18）：SSH 连接加 keepalive，空闲 NAT 断链后
  不再挂到内核超时；临时文件名加随机后缀，同毫秒并发写不撞名；大目录首屏
  只渲染 300 条、滚动追加；目录/读文件请求带 30 秒超时与取消，上传可中途取消。
- **展现方式**：适应 / 铺满切换、双击画面或按钮全屏（原生全屏不可用时自动退到窗口内全屏）、保存当前画面、
  分辨率与播放模式角标、暂停 / 重连；适应 / 铺满按相机书签记住。
- 口令只在建立会话的请求体里，会话 id 随机、内存态、30 分钟 TTL，
  URL 里不出现密码；标签关闭时会主动释放相机连接和 go2rtc 流。
- 标签绑定按「会话 + 标签」持久化，刷新后仍回到同一台相机。

**SSH 稳定性与重连**（v0.9.7，对齐 electerm 的连接策略）
- 保活：`ServerAliveInterval=10` × `ServerAliveCountMax=10`（约 100 秒才判死，
  原来 60 秒），并开启 `TCPKeepAlive=yes`、`ConnectTimeout=15`。
- 首次连接自动接受新主机密钥（`StrictHostKeyChecking=accept-new`），不会卡在
  `yes/no` 提示；已记录过的密钥发生变化仍然拒绝。
- 自动重连：3s → 6s → 12s → 24s → 30s 指数退避，最多 5 次；连上后计数清零。
- 认证失败（`Permission denied` / 主机密钥校验失败等）不自动重试，避免白重试
  和账号锁定；用户主动 `exit` 也不重试。
- 连接卡死兜底：50 秒仍未收到远端提示符就判定失败并进入重连流程。
- 书签按命令指纹持久化到 localStorage：刷新页面后胶囊与「重连」入口仍在，
  重连仍会回到断开前的远端目录。
- 标签标题刷新后回退到持久会话里的书签名，不会因为 xterm 的 live title 变回
  `bash`；相机归属仍按书签标题 / 分组读取（v0.13.3 / v0.13.4）。
- 手输 / 快捷命令的 `ssh` 也能用：从按键流识别 `ssh user@host`，生成临时会话，
  胶囊与「重连」照常出现；重连原样重放用户命令，不丢 `-i` / `-J` / `-L` 等参数。
  没有远端钩子时靠屏幕尾部的 `client_loop` / `Broken pipe` 等断线文本兜底。

**反向通道：终端 → 对话**
- 在终端里**用鼠标选中一段输出**，右下角会出现「发给对话 / Send to chat」按钮；
  点它或按 **⌘/Ctrl+Shift+Enter**，就把选区原文（加一行来源标注）发到会话。
- **没选中也能发**：直接按快捷键会把当前可见的整屏发过去（提示会明确说
  "发了整屏"）。盯着一段报错想问模型时，"拖选"这一步本来就是多余的。
- 发完自动清除选区，避免连着把同一段发两遍。
- 投递目标**优先是这个终端所属的会话**，拿不到才退回"当前正在看的会话"。
- 消息以 queue 模式入队，不打断正在跑的轮次。
- 焦点在聊天输入框时该快捷键完全让位，不会被抢走。
- 这是 electerm 类工具没有的能力：终端输出一句话就能递给模型。

**终端配色**（v0.5.0）
- 内置 10 套配色：终端默认 / Dracula / Nord / Tokyo Night / One Dark / Monokai /
  Solarized Dark / Solarized Light / Gruvbox Dark / Matrix。
- 设置里改完**立刻生效**，不用重开标签；刷新后仍然记得。
- 只改终端屏幕，跟界面主题各管各的——界面可以是浅色，终端照样 Dracula。

**远端文件：模型的读写工具直达 SSH 远端**（v0.6.0）
- dsh 的文件服务 `ctx.fs` 被包成**本地 + 远端复合后端**：模型在 read / write / edit /
  list 等内置文件工具里把路径写成 `remote:别名:/绝对/路径`，就走 SFTP 落到那台机器；
  普通本地路径一字不改地走原后端。
- 远端清单在宿主侧 `<profile>/.dsh-terminal-workbench/remotes.json`，改文件即时生效：

  ```json
  {
    "vps":  { "host": "1.2.3.4", "port": 22, "username": "root",
              "auth": "key", "keyPath": "~/.ssh/id_rsa" },
    "prod": { "host": "example.com", "username": "deploy",
              "auth": "password", "password": "…" }
  }
  ```
- 新工具 `remote_fs_list`（只读免审批）让模型先问一句"有哪些别名、连不连得通"，
  `probe: true` 会做一次真实握手。
- 完整保留 dsh-fs 的守卫语义：版本守卫（远端文件被别人改了会报 `FS_STALE_VERSION`）、
  `createIfAbsent`、字面编辑不唯一拒绝、原子写（临时文件 + rename）、UTF-8/二进制判负、
  大小闸门。连接按别名懒建立、断线自动重连、改配置自动换连接。
- 为什么不是开槽接管：Cordis 服务槽单注册，重复 `provide('fs')` 直接抛错；
  本插件改为**包装现有实例的方法**做路由，本地行为零改动。

**远端文件工具补全**（v0.8.0）

内置的 read / write / edit / list 已经能读写远端，但增删改目录仍要回终端敲命令。
v0.8.0 补上四个模型侧工具（写操作不重复造 read/write，避免两套守卫逻辑漂移）：

| 工具 | 作用 | 审批 |
|---|---|---|
| `remote_fs_mkdir` | 建目录，递归且幂等 | 否 |
| `remote_fs_move` | 同机移动 / 改名；跨机明确拒绝 | 否 |
| `remote_fs_copy` | 同机复制；跨机走两个 SFTP 流直传，不落本地磁盘 | 否 |
| `remote_fs_remove` | 删除文件 / 目录；递归必须显式传 | **是** |

删除的审批闸门与终端输入同源：走 `tools/pre-execute`，`approval=never` 时确定性
拒绝并提示 `/permission`，不会让模型收到一句无来由的 rejected。

**SSH 端口转发 / 跳板**（v0.8.0）

模型可以按 `remotes.json` 里的别名开隧道，跳板按 `jumpHost` / `jump` / `proxyJump`
自动解析（最多 4 跳，显式环检测）：

| 工具 | 作用 | 审批 |
|---|---|---|
| `forward_open` | 开 `L` 本地 / `R` 远端 / `D` SOCKS5 隧道，`bind` 省略时 `127.0.0.1:0` | **是** |
| `forward_close` | 关闭指定隧道并释放端口 | 否（只减少影响面） |
| `forward_list` | 列出隧道、绑定地址、目标、链路 | 否（只读） |

审批面板会写清完整暴露面（类型、监听地址、目标、跳板链）。注意 `bind: '*'` 会映射
到 `0.0.0.0`，`D` 是无认证 SOCKS5——默认建议只用 `127.0.0.1`，别把隧道开成公网入口。

**设置页分组收纳**（v0.7.0）

设置里的五个区块（外观 / 行为 / 快捷命令 / 书签分组 / SSH 书签）改成了**可折叠抽屉**：

- 标题行整行可点，右侧带条数摘要（如 `快捷命令 · 3 条`、`SSH 书签 · 5 条`），
  收起来也能一眼看到每类配了几个。
- 外观、行为默认展开（高频小项）；快捷命令、书签分组、SSH 书签默认收纳（低频大块）。
- 折叠状态记在本地，刷新后保持；设置对话框（标签右键 → 设置…）和原生设置页
  的「终端工作台」页签共用同一份，两边折的是同一个抽屉。
- 全部收起时面板高度约 430px，全部展开约 660px——管理十几个书签和命令时
  不用再滚一屏找开关。

**SSH 连接状态：看得见、点得回**（v0.7.0）

终端标签右上角有一枚**状态胶囊**，三态：

| 状态 | 外观 | 含义 |
|---|---|---|
| `connecting` | 琥珀色圆点 + 闪烁，`SSH 连接中…` | 命令已交给终端，远端还没报到 |
| `connected` | 绿色圆点，`SSH 已连接` | 远端 shell 的提示符已经回来 |
| `disconnected` | 红色圆点，`SSH 已断开（rc=137）` + **重连**按钮 | ssh 进程没了 |

- **断开立刻可见**：掉线、`exit`、被 `kill`、网络断，胶囊都会在提示符回来的同一刻变红，
  并带上退出码。不用再对着一个"看起来还活着"的终端反复敲命令。
- **一键重连**：点红色胶囊上的「重连」，新 ssh 会**自动 `cd` 回你断开前所在的远端目录**。
  目录是跟着远端提示符走的（见下），不是你打开书签时的初始目录。
- **Tab 补全 / 交互程序可用**：本地 PTY 的 `TERM=dumb` 会被 ssh 带到远端、让 readline
  关掉补全。引导脚本检测到 dumb/空 TERM 时自动修成 `xterm-256color`，Tab 补全、
  上下键历史、htop/vim 这类全屏程序在远端正常工作。
- **链路保活（对齐 electerm）**：ssh 命令带 `-o ServerAliveInterval=10 -o ServerAliveCountMax=6`，
  每 10 秒发一个加密心跳。组网/中继/NAT 链路会回收空闲 TCP 流——不发心跳的连接放几分钟
  不动就被掐成「半开」，表现为「放着不动就断了」。60 秒无响应则主动判死，胶囊立刻亮红。
- **强制远端 PTY（`-t`）**：ssh 带命令执行时不会自动分配远端 PTY，远端 readline 会整体
  关闭、Tab 补全失效。插件显式加 `-t`，保证补全、历史、vim/htop 与直连行为一致。
- **不会假装连上**：初始状态是 `connecting` 而不是绿色。ssh 因为密钥不对、端口不通而
  立刻退出时，你会看到它先琥珀、再变红（本地 shell 收到退出后发信标），而不是先绿一下。

机制（两段 OSC 序列，都是终端自己吐出来的，不额外占端口）：

- **`OSC 7`** —— 远端 shell 每次画提示符前上报 `$PWD`。bash 注入
  `PROMPT_COMMAND='printf "\033]7;%s\007" "$PWD"'`，zsh 用 `precmd`，都是往**本会话专用**的
  rc 文件里写，不改你的 `~/.bashrc` / `~/.zshrc`。其它 shell（fish、csh…）只保证 `cd`，不装钩子。
- **`OSC 777`** —— 本地 shell 在 ssh 退出后立刻打一条 `twb-ssh-exit;rc=<退出码>` 的私用序列，
  这就是"断开"的判定源，比轮询进程状态即时得多。

> **为什么能区分"远端的 pwd"和"本机的 pwd"**：本地 shell 钩子发的 OSC 7 带 `file://<主机名>/`
> 前缀，远端 bash/zsh 发的是裸路径。掉线后本地 shell 也会立刻发一条 OSC 7，如果不加区分，
> 断开状态会被瞬间翻回绿色——胶囊就永远红不了。所以 `file://` 开头的 OSC 7 被整条忽略，
> 连"记目录"这一步都不参与（否则重连会 `cd` 到本机的 `/workspace` 而不是远端的 `/tmp/twb-e2e`）。

**自动重连**：设置里开启后，断开 3 秒会自动尝试一次（胶囊显示 `SSH 断开，自动重连中…`）。
密码错这类"重连也没用"的场景建议关掉，手动点重连。

**文件面板：在终端里直接翻远端文件**（v0.8.0）

ssh 标签连上后，右上角出现「文件」按钮，点开是右侧抽屉：

- **自动落到你正在看的目录**——面板打开时落在远端 `$PWD`（就是状态胶囊一直在记的那个），
  不用从根目录一层层点进去。
- 连接选择器可在多个远端之间切，面包屑每一段都能点。
- **双击目录**进去，**双击文件**在面板里直接编辑保存；悬停出「重命名 / 删除」。
- 新建目录、上一级、刷新都在顶部一行。
- **上传 / 下载**：上传按队列逐个传（不并行），同名先确认再传，传输中可随时
  「取消上传」；下载走浏览器原生另存，服务端流式回传，不落盘缓存。
- 目录条目多时首屏只渲染 300 条，滚动到底自动追加，底部另有「显示更多」按钮，
  2000 条的大目录也不会一次铺满 DOM。
- 所有写操作完成后**自动刷新列表**，不需要手动再点一次。

几条刻意的取舍：

| 决定 | 原因 |
|---|---|
| 是终端内抽屉，不是侧栏标签页 | 文件面板是"某个终端的附属视图"，天然属于某个 `tabId`。做成顶层标签会出现"终端关了，面板还挂着一台已断开的机器" |
| 只在 ssh 会话显示 | 本地终端没有"远端"概念，开了会让人以为在浏览本机文件 |
| 超过 6MB 的文件不打开编辑器 | 在浏览器 textarea 里编辑几十 MB 日志，卡的是用户自己的浏览器；改为提示用 vim |
| 删除**总是**二次确认 | 远端没有回收站，`rm` 之后就没了 |
| 保存带版本守卫 | 面板开着的时候你在终端里 `vim` 改过同一个文件，面板保存会明确失败，而不是静默覆盖你的改动 |

前端拿不到 `ctx.fs`（那是宿主侧对象），所以面板走 HTTP 回到宿主执行：
`/__dsh-terminal-workbench/fs/{remotes,list,read,write,mkdir,move,copy,remove,upload,download}`。
**路径只在宿主侧解析**，前端传的是完整地址 —— 浏览器的 `../..` 逃不出远端语义，
写权限也留在宿主侧（前端直操文件系统意味着任何 XSS 都能读写远端）。

面板是独立 chunk（约 46KB），没打开就不下载。

**命令块：看得见每条命令的边界与成败**（v0.8.0 / S4）

远端 bash / zsh 会收到一小段 shell 集成（OSC 133 标记），终端左侧因此多出一条
命令块边距：

- **每条命令一根竖条**：正常灰蓝、执行中黄色、失败红色；点击竖条跳到该命令开头。
- **`⌘/Ctrl+Shift+↑/↓` 块间跳转**：首尾环回，焦点在终端里才接管。
- **块头**：跳转后显示 `$ 命令`、耗时与退出码；带上一个/下一个/关闭。
- **不改终端的渲染**：边距是终端文字左侧的一层独立 DOM，xterm 仍照常画字符流，
  配色、字体、选区、zsh-syntax-highlighting / zsh-vi-mode 都不受影响。
- **不覆盖你的 shell 钩子**：bash 的 `PROMPT_COMMAND`（标量/数组都兼容）与
  zsh 的 `precmd_functions` / `preexec_functions` 都是**前置**，原有主题、
  direnv、vi-mode 钩子继续运行；`PS1` 只在末尾追加不可见的 B 标记，且防重复注入。

块结构是 `{ id, command, cwd, startedAt, endedAt, exitCode, startLine, endLine }`，
行号用 xterm marker 锚定，回滚缓冲裁行后不会漂。每个标签最多留 500 块。

**给模型的工具**

终端控制（5 个）：

| 工具 | 作用 | 需要审批 |
|---|---|---|
| `terminal_list` | 列出所有终端：#序号、标题、id、归属、shell、状态、**屏幕最后一行** | 否（只读） |
| `terminal_run` | 在终端里执行一条命令，返回**本次新增的输出**；装包/拉镜像/编译这类慢命令会自动放宽等待 | 目标不是自己的专属终端时 |
| `terminal_send` | 原样写入按键（vim / ssh / Ctrl-C） | 同上 |
| `terminal_read` | 只读看屏幕 | 否（不写入） |
| `terminal_blocks` | 只读回看命令块（命令、退出码、耗时、输出） | 否（只读） |

远端文件（5 个）：

| 工具 | 作用 | 需要审批 |
|---|---|---|
| `remote_fs_list` | 列出 SSH 远端别名、地址、认证方式；`probe: true` 做真实连接探测 | 否（只读） |
| `remote_fs_mkdir` | 建目录（递归、幂等） | 否 |
| `remote_fs_move` | 同机移动 / 改名 | 否 |
| `remote_fs_copy` | 同机复制 / 跨机 SFTP 直传 | 否 |
| `remote_fs_remove` | 删除文件 / 目录（递归要显式） | **是** |

SSH 隧道（3 个）：

| 工具 | 作用 | 需要审批 |
|---|---|---|
| `forward_open` | 开 `L` / `R` / `D` 隧道，可走跳板链 | **是** |
| `forward_close` | 关闭隧道并释放端口 | 否 |
| `forward_list` | 列出当前隧道 | 否（只读） |

**模型怎么"迅速定位"到某个终端**（v0.5.0）

终端 id 是 `agent-<24 位后缀>` 这种机器串，而标题常常全一样（三个标签都叫 `zsh`），
`cwd` 又是**创建时的初始目录**、`cd` 之后并不更新——模型以前只能靠猜。
现在四种写法都认，按下面的顺序判：

1. 精确 id（老写法一字不改地继续工作）
2. `#2` 或裸 `2`——序号就是 `terminal_list` 展示的顺序，来回不用换算
3. 标题片段（唯一命中才算，歧义不瞎猜）
4. id 前缀

都定位不到时，工具会把**带清单的报错**回给模型，它下一次就能点对：
```
没有这个终端：nope。当前会话的终端是：
#1 zsh｜id=agent-aaa…｜我的专属｜zsh｜running｜最后一行：$
#2 zsh｜id=terminal-1111｜外部终端 · 主人正在用｜zsh｜running｜最后一行：ready in 812ms
可以用 #序号、标题，或上面列出的 id 来指定。
```
清单里那句"最后一行"是区分同名终端最快的一眼信息——它读的是屏幕，不是 `cwd`。

**审批闸门**
- 专属终端 id 由 `agent.id` 推导，模型**没法靠传参**把自己伪装成别人。
- 闸门**先把定位串解析成确定 id 再判越界**：`#1` 明明指的是自己的终端，就不会
  再弹一个莫名其妙的框。
- 目标是外部终端时，**完全跟随 DSH 权限预设**：
  - `ask` 预设：走 dsh 审批服务弹面板，框上写的是**终端标题 + id**，不是机器串，
    `Allow once` 才放行；
  - `danger-full-access`（`approval=never`）：DSH 本身不弹审批，终端写入也直接放行；
  - 读不到策略：按 `ask` 处理，宁可多问一句。
- 目标终端不存在时不打扰你，直接让工具报错并把可用清单回给模型。
- 插件不再维护独立的终端授权表，也没有 `/terminal-access grant` / `revoke`。

**访问角标（2026-11-07 起跟随 DSH）**
- 终端标签标题右侧显示访问级别：`助手专属` / `可写` / `需审批` / `已退出`。
  角标只是状态，不可点击，也不再提供撤销。
- 宿主 API 只剩只读快照：
  `GET /__dsh-terminal-workbench/terminal-access?sessionId=…`；
  任何写操作（POST / PUT / DELETE …）一律 405。助手即使能用专属终端 `curl`
  本机 HTTP，也没有提权或改权限的通道。
- 没有授权表就没有“清授权”生命周期：会话结束、页面重载、新窗口报到、
  WebSocket 重连都不再影响权限；`boot.gif` 只负责看门狗报到。
- 客户端按会话缓存快照，10 秒低频轮询，页面隐藏时暂停；并发请求去重。

**自救**
- 本插件禁用了内置布局；万一客户端半侧起不来，宿主看门狗会把 `ui-layout` 与
  `ui-sidebar-terminal` 改回启用，**同时禁用本插件（`terminal-workbench`）**——
  只还原布局会留下两个 `root` 槽注册者，下次启动直接白屏（v0.9.0 及以前的缺陷）；
  不还原内置终端则恢复出来的界面没有终端。重启 dsh 即可回到内置布局；修好插件后，
  把 `.dsh-terminal-workbench/ui-layout.original.yml`（以及 `profile-patch.original.yml`，
  如果存在）覆盖回对应的 `cordis.patch.yml` 可恢复工作台布局。
- 看门狗只认**文档导航和客户端静态资源**请求（`sec-fetch-mode: navigate` /
  `Accept: text/html` / `/assets/` / `/plugins/`）：服务器重启后没人开页面、旧页面的
  API 轮询、favicon、探活和报到信标都不会被误判成“客户端加载失败”。
- 判定用“加载静默期”而不是固定秒表：只要还有客户端资源在途，或最后一次加载活动
  结束还没超过 60 秒，就继续等；晚打开的页面、慢机器上的冷启动都会被等到。
- 单个在途请求超过 5 分钟视为挂死，不再永久阻塞自救；判定与写补丁之间会二次确认，
  客户端刚好报到时绝不会误禁用。补丁用“临时文件 + rename”原子写入，崩溃不会留下
  半截 YAML。
- 每次插件实例最多自救一次（自救后插件已禁用），不会和手动重新启用拉锯。高级用户
  可在 `.dsh-terminal-workbench/rescue.disabled` 放一个文件彻底关闭自动自救。
- 安装方式不同也能救：bundle 补丁从包自己的 `dsh.bundle.patch` 解析；如果 profile
  用户补丁里显式覆盖了 `ui-layout` / `terminal-workbench`，会一并改写，避免覆盖层
  把自救结果又顶回去。
- 报到通道（v0.6.1 修复）：浏览器半侧加载成功后请求 `/__dsh-terminal-workbench/boot.gif`，
  host 侧用 `webServer.register()` 接住并解除看门狗——之前只有信标没有接收端，
  `loadedByClient` 永远为 false，120 秒必然误回滚。
- 浏览器侧还有一块兜底面板，先占住屏幕并给出三条自救路径，真面板一到就让位。

## 安装

从源码目录安装（需要 Node.js 20+）：

```bash
git clone <你的仓库地址> dsh-terminal-workbench
cd dsh-terminal-workbench
npm install
npm run build
dsh plugin --profile <profile> add "file:$(pwd)"
dsh <profile> --no-open --port 3080
```

如果使用发布 zip，解压后把 `file:` 指向解压目录即可：

```bash
unzip dsh-terminal-workbench-<version>.zip
dsh plugin --profile <profile> add "file:$(pwd)/dsh-terminal-workbench-<version>"
```

## 项目结构

仓库根目录只保留入口文件、源码、测试和发布配置：

```text
.
├── lib/                    # 宿主侧（Node.js）
├── src/                    # 前端构建源（xterm 渲染）
├── verify/                 # 回归测试（node verify/run-all.mjs）
├── locale/                 # 中英文文案
├── client.js               # 浏览器半侧入口
├── client.terminal.js      # xterm 渲染 chunk（构建产物）
├── client.fs-panel.js      # 文件面板 chunk（按需加载）
├── build.mjs               # esbuild 构建脚本
├── cordis.patch.yml        # DSH bundle 补丁
├── icon.svg                # 插件图标
├── package.json
├── package-lock.json
├── README.md
├── LICENSE
└── .github/workflows/ci.yml
```

宿主半侧按职责拆分，入口只做接线：

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 插件入口：续话轮询、启动看门狗、书签文件路由、子插件接线 |
| `lib/agent-terminal.js` | 终端控制工具（5 个）+ 外部终端审批闸门（跟随 DSH）+ OSC 133 桥接 |
| `lib/approval-policy.js` | 终端 / 隧道 / 远端文件三模块共用的审批策略读取；never 判定供隧道与远端文件使用 |
| `lib/terminal-access-api.js` | 终端访问状态只读快照（GET；写操作一律 405） |
| `lib/remote-fs.js` | `ctx.fs` 复合后端（本地 + SFTP）、连接池、路径归一化、跨机直传 |
| `lib/remote-fs-tools.js` | 远端文件工具（5 个）+ 删除审批 |
| `lib/forward.js` | SSH 隧道管理器：链路解析、L/R/D、SOCKS5、端口与连接清理 |
| `lib/forward-tools.js` | 隧道工具（3 个）+ 开隧道审批 |
| `lib/fs-api.js` | 文件面板唯一的宿主侧 HTTP API（前端只发意图） |
| `lib/camera-api.js` | 相机取流代理：RTSP 会话 + go2rtc 管理、Digest/Basic 认证、MJPEG/快照兼容 |
| `lib/go2rtc-player.js` | go2rtc VideoRTC 播放器（MIT，vendored；MSE 播放与断线重连） |
| `client.js` | 浏览器半侧：三栏布局、终端编排、设置、书签、文件面板入口 |
| `src/terminal.js` | xterm 渲染源码（构建入口） |
| `build.mjs` | esbuild 构建脚本：产物 + `client.js` 缓存标记 |
| `client.terminal.js` | xterm 渲染 chunk（构建产物，勿手改） |
| `client.fs-panel.js` | 文件面板 chunk（按需下载） |

回归入口只有一条：

```bash
npm test          # 等价于 node verify/run-all.mjs
```

当前基线：**语法 14/14，测试 29 个文件 / 475 项全绿**。

| 测试 | 项数 | 覆盖 |
|---|---:|---|
| `agent-terminal-test.mjs` | 39 | 终端权限跟随 DSH、专属终端重建、OSC 133 工具桥接 |
| `approval-policy-test.mjs` | 15 | 审批策略读取、never 判定、模块接线与判定顺序 |
| `bookmarks-file-test.mjs` | 8 | `bookmarks.json` 合并与去重 |
| `bookmarks-render-test.mjs` | 4 | 书签分组渲染（children / 折叠 / 搜索） |
| `browser-signal-test.mjs` | 12 | 看门狗只认页面导航与静态资源，API 轮询不算客户端加载 |
| `camera-test.cjs` | 50 | 相机书签归一化、RTSP 默认值（安讯士大车 / 吊具 camera=5 / 韩华大车）、自动识别品牌入口、H.264 码流查找入口、密码明文输入、适应/铺满记忆、IP 前缀/末位、终端前缀映射、前缀来源比较、前缀记忆与排序、数字属性选择器引号、标签绑定、主/子码流标签、密码组归属与复用、来源 SSH 书签跟随与密码组迁移、面板归属判断 |
| `camera-api-test.mjs` | 40 | 相机代理会话、RTSP 地址编码、品牌路径探测与自动纠正、H.265→H.264 编码探测与自动切换、同连接 Digest 认证、go2rtc 流复用/引用计数、tmpfs 临时目录、播放器缓存与 gzip、低延迟缓冲、Digest/Basic、MJPEG/快照、错误路径 |
| `camera-ws-proxy-test.mjs` | 6 | 同源 WebSocket 代理：Upgrade 透传、Origin 拒绝、非法流名、go2rtc 未运行、registerUpgrade 精确路径、旧 webServer 跳过 |
| `client-blocks-test.cjs` | 15 | 前端命令块解析与跳转 |
| `client-fs-panel-test.cjs` | 27 | chunk 装载契约、面板纯函数、增量渲染、超时/取消；SSH 契约需 `TWB_E2E=1` |
| `client-p1-test.cjs` | 11 | IPv6 转发解析、askpass 并发隔离 |
| `client-terminal-access-test.cjs` | 10 | 访问角标映射、终端身份解析、快照隔离、无授权/撤销入口 |
| `forward-parse-test.mjs` | 31 | 转发规格、跳板链、管理器边界 |
| `fullscreen-layout-test.cjs` | 15 | 右栏全屏网格（左右归零、中列吃满、脏值不触发）、退出复原、DOM 接线与宿主面板宽度 |
| `fs-api-test.mjs` | 11 | 文件面板 HTTP 契约 |
| `fs-transfer-test.mjs` | 6 | 上传/下载路由：二进制体、409 覆盖、`../` 文件名拒绝 |
| `host-tools-contract-test.mjs` | 20 | 宿主工具注册、参数路由、审批分支 |
| `remote-fs-options-test.mjs` | 6 | SSH 保活参数、密码/私钥认证、临时文件名唯一性 |
| `remote-fs-path-test.mjs` | 16 | 远端 POSIX 路径归一化 |
| `sftp-stream-test.mjs` | 10 | 假 SFTP 真实链路：流式读写、原子发布、源流中断清理 |
| `rescue-patch-test.mjs` | 11 | 启动自救补丁改写：只启用 ui-layout、必须禁用本插件 |
| `sftp-bookmark-test.mjs` | 15 | 书签名当别名（中文/`+`/空格）、`/fs/connect` 登记、密码不回传、面板接线 |
| `ssh-stability-test.cjs` | 40 | 保活参数、自动重连退避、认证失败不重试、书签指纹、相机前缀持久化、刷新后标题回退到书签名、tabId 重分配后按稳定内容地址恢复、手输 ssh 解析与 rawCommand 重连、断线文本识别、屏幕兜底（强断线 + 空提示符 / 折行提示符 / 裸 Broken pipe 与旧输出不误判）、恢复/onWriteParsed 接线 |
| `terminal-access-api-test.mjs` | 9 | 访问快照、ask/never、只读 405、旧参数兼容 |
| `terminal-build-test.cjs` | 9 | 构建源/产物/`chunk-rev` 一致性与终端关键能力 |
| `terminal-close-policy-test.mjs` | 16 | 启动裁剪、重试预算、`missingTerminal` 判定与关闭清理 |
| `watchdog-grace-test.mjs` | 11 | 加载静默期 + 在途请求，慢启动不误判 |
| `watchdog-inflight-test.mjs` | 7 | 挂死请求的最长寿命，不永久阻塞自救 |
| `web-tab-test.cjs` | 12 | 网页标签地址栏归一化与网址识别 |

文件面板的 HTTP 契约需要一台测试 sshd（默认 `127.0.0.1:2222`）：

```bash
TWB_E2E=1 TWB_E2E_HOST=127.0.0.1 TWB_E2E_PORT=2222 \
TWB_E2E_USER=root TWB_E2E_KEY=~/.ssh/twb_test_key \
node verify/client-fs-panel-test.cjs
```

> **构建源与产物（重要）**：`client.terminal.js` 由 `src/terminal.js` 经 `build.mjs`
> 打包，源码与构建脚本已随包发布。0.8.0 从 0.1.0 备份恢复构建源，并把部署版 chunk
> 里手工补的主题解析、`__dshXterm` 句柄、分段初始输入、快捷指令焦点恢复回迁到源码。
> `npm install && npm run build` 可重复产出同一哈希（当前
> `4995dea6fdacdbc819c3f2c5df0ed2fdfff33e8663a1457b6782c97e660a3a42`）。
>
> 部署版旧 chunk（`96ea86e3…`）含手工注入代码，字节不可复现，只作行为对照；新构建
> 是当前源码基线。构建会重写 `client.js` 末尾的 `chunk-rev`，不要手改
> `client.terminal.js`。改渲染逻辑时先改 `src/terminal.js`，再跑 `npm run build`。
>
> 发布包冒烟：`npm pack` 产出 26 个文件、约 417 kB（解包约 1.5 MB）；解包后
> `npm install && npm run build` 仍得到同一 chunk 哈希，`node --check` 与
> `import('./lib/index.js')` 均通过。

## 注意事项

- **权限预设直接决定终端写入。** `danger-full-access` = `approval: never`，DSH 不弹
  审批，外部终端写入也直接放行；`ask` 预设下外部终端写入会逐次弹出 DSH 审批面板。
  终端不再有独立的 `/terminal-access grant`，不需要为了终端输入去单独放宽文件沙箱。
- **改源码后要同步副本。** `~/.dsh/profiles/<p>/node_modules/dsh-terminal-workbench/`
  是 pnpm 复制出来的独立目录，不是符号链接：

  ```bash
  cp -r /path/to/term-wb/. ~/.dsh/profiles/<p>/node_modules/dsh-terminal-workbench/
  ```

## 已知限制

- 判停仍是启发式：普通命令输出静止 700ms 视为完成；装包 / 拉镜像 / 编译 / 克隆
  这类命中特征表的命令放宽到 4 秒、上限 5 分钟。全屏程序（vim / htop）请用
  `terminal_send` + `terminal_read` 组合。
- 续话监听优先用文件事件，另留 30 秒一次的安全网；监听起不来（网络盘 / 容器挂载）
  会打印一行日志并退回 2 秒轮询。
- 反向通道优先发给**终端所属会话**，拿不到才退回当前会话。UIL 上每个会话的终端
  标签是隔离的，所以两者通常一致——这条主要是保证语义正确。
- 远端文件的限制：`watch` 不支持（远端目录变动不会触发监听，会明确报错而不是
  静默）；`streamText` 是"整读 + 分块"（远端文件有 64MB 大小闸门，先整读再切块，
  语义与本地一致）；原子写依赖 SFTP 服务端对 `rename` 的语义（OpenSSH 同目录
  rename 是原子的，个别第三方服务端可能不是）。终端仍是本地 PTY——连远端靠的
  是 ssh 书签或 `remote:` 文件路径，不是把 PTY 开在对端。
- SSH 书签的密码认证：密码写进本机 askpass 脚本（base64 写入、`umask 077` 仅当前
  用户可读），不进命令行、不进环境变量；ssh 退出后立即 `rm` 焚毁。残余风险是
  连接期间那一个 0600 临时文件（同用户可读）——彻底防御需要宿主侧密钥托管（未做）。
- 远端原子写优先走 OpenSSH `posix-rename` 扩展；服务端不支持时退回
  "unlink 旧文件 → rename"，中间存在极短的文件缺失窗口（v0.6.2 已尽量收窄）。
- 配色只覆盖 xterm 的 16 色 + 前景/背景/光标/选区，不含需要 `allowProposedApi`
  的实验字段；终端开了 `minimumContrastRatio: 4.5`，极端配色会被自动拉回可读对比度。
- 文件面板的边界：**书签名要和远端别名一致**才能落在正确目录（面板用
  `remote:书签名:` 拼路径；别名未登记时明确提示「远端未配置」，不再回落到
  别的机器）；只支持文本编辑，不做二进制预览、拖拽上传、断点续传——这些属于
  "传输工具"而不是"终端工作台"。上传/下载本身是流式的，不经过浏览器内存整份缓冲。
- 连接状态靠远端 shell 上报 `$PWD` 才算连上，所以**远端 shell 必须是 bash 或 zsh**；
  fish / csh / 极简 sh 只做 `cd`，胶囊会一直停在"连接中"（终端本身可用）。
  另外，如果用户在远端又套了一层 `su` / `docker exec` 进了别的 shell，那一层不会再报 OSC 7，
  目录会停在切换之前——重连仍能回到你进入那层之前的目录。
- 命令块同样只覆盖 bash / zsh，并且 **bash 需要 4.4+**（`PS0` 钩子）；更老的 bash
  没有 C 标记，块功能静默消失，OSC7 / 状态胶囊不受影响。**tmux 默认会吞 OSC 133**
  （需要 `allow-passthrough`），块也会降级为不可用。浏览器侧块表与宿主侧
  `terminal_blocks` 是两套独立解析（宿主直接读终端流），模型侧不依赖浏览器在线；
  两边的块 id 不互通。
- 块头**不折叠输出**：折叠需要隐藏或重排 xterm 的行，和 S4「只记录、不接管渲染」
  的取舍冲突；现在只提供跳转和元数据。
- 断开的判定源是**本地 shell** 的那条 OSC 777。如果本地 shell 被自定义成 `exec ssh ...`
  （没有外层 shell 可回），或者用户 `Ctrl-D` 直接把整个标签关掉，就收不到信标。
- 终端的"最后一行"取自当前屏幕：滚到历史里的东西不在其中，全屏程序（vim / htop）
  看到的是它的界面而不是 shell 提示符。
