/* dsh-terminal-workbench 文件面板 chunk：与 client.terminal.js 同样的 __ModuleLoader__ 包装。
   独立成 chunk 的原因：面板带编辑器与列表渲染，约 20KB，不打进主 client.js，
   用户没打开文件面板就不会下载它。 */
window.__ModuleLoader__.load({
  id: "dsh-terminal-workbench",
  chunk: "client.fs-panel.js",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /**
     * dsh-terminal-workbench — 文件面板（前端抽屉）。
     *
     * 定位：挂在终端面板里的**可切换抽屉**，不是独立的侧栏标签页。
     *
     * 为什么不做成 sidebarRightTabs 里的一种标签：
     *   sidebarRightTabs 的每个标签都绑定 `contentId` 体系，需要参与宿主的分栏
     *   宽度协商、激活态、拖拽换位、会话恢复。终端文件面板是"某个终端的附属
     *   视图"——它天然属于某个 tabId，跟着终端开关才符合直觉。做成顶层标签会
     *   出现"终端关了，文件面板还挂着一台已断开的机器"这种状态。
     *
     * 数据通路：浏览器拿不到 `ctx.fs`（那是宿主侧对象），所以全部走 HTTP：
     *   GET  /__dsh-terminal-workbench/fs/remotes
     *   GET  /__dsh-terminal-workbench/fs/list?path=remote:别名:/绝对路径
     *   GET  /__dsh-terminal-workbench/fs/read?path=…
     *   POST /__dsh-terminal-workbench/fs/{write,mkdir,move,copy,remove}
     * 路径一律由**前端拼字符串、宿主侧解析**——前端不做任何路径归一化，
     * 避免两处实现漂移出"前端认为能删、宿主认为不能删"的口径差。
     */

    /** 路径前缀：`remote:boxa:/etc` —— 三段的空路径（`remote:boxa:`）不合法。 */
    var REMOTE_PREFIX = 'remote:'

    /**
     * 解析 `remote:别名:/绝对路径`。
     *
     * 只做形状校验，不做归一化（`..`、`//` 交给宿主）。返回 null 表示不是远端路径。
     * 允许别名含 `_`/`.`/`-`：远端别名可能是主机名或 `prod-db_1` 这种。
     */
    function parseRemotePath(raw) {
      if (typeof raw !== 'string') return null
      /* 别名允许中文、`+`、空格等书签名常见字符，只排除 `:` 与 `/`。 */
      var match = /^remote:([^:/]+):(\/.*)$/.exec(raw)
      if (match === null) return null
      return { alias: match[1], path: match[2] }
    }

    /** 组装 `remote:别名:/路径`；路径不以 `/` 开头时补上。 */
    function makeRemotePath(alias, path) {
      var name = String(alias === undefined || alias === null ? '' : alias).trim()
      if (name === '') return ''
      /* 路径不做 trim：Unix 允许文件名/目录名首尾带空格，裁掉会让
         "看到的条目"与"实际操作的路径"不是同一个（重命名/删除会打空）。
         只补前导斜杠；空路径归到根。 */
      var p = String(path === undefined || path === null ? '' : path)
      if (p === '') p = '/'
      if (p.charAt(0) !== '/') p = '/' + p
      return REMOTE_PREFIX + name + ':' + p
    }

    /**
     * 目录 + 条目名 → 新路径。
     *
     * 单独写而不是 `dir + '/' + name`：根目录 `/` 拼接会变成 `//name`，
     * 虽然后端能容忍，但显示出来很脏，而且会让"同一目录两种字符串"传到前端
     * 比较逻辑里（比如判断当前目录是否高亮）。
     */
    function joinRemotePath(dir, name) {
      var base = String(dir === undefined || dir === null ? '/' : dir)
      var leaf = String(name === undefined || name === null ? '' : name)
      if (leaf === '') return base
      return base.charAt(base.length - 1) === '/' ? base + leaf : base + '/' + leaf
    }

    /** 取父目录；已经在根上返回 `/`（不返回空串，否则上层要额外判空）。 */
    function parentOf(path) {
      var p = String(path === undefined || path === null ? '/' : path)
      if (p === '' || p === '/') return '/'
      var trimmed = p.charAt(p.length - 1) === '/' ? p.slice(0, -1) : p
      var cut = trimmed.lastIndexOf('/')
      if (cut <= 0) return '/'
      return trimmed.slice(0, cut)
    }

    /** 取路径最后一段（用于标题、重命名初始值）。根目录返回 `/`。 */
    function baseNameOf(path) {
      var p = String(path === undefined || path === null ? '' : path)
      if (p === '' || p === '/') return '/'
      var trimmed = p.charAt(p.length - 1) === '/' ? p.slice(0, -1) : p
      var cut = trimmed.lastIndexOf('/')
      return cut === -1 ? trimmed : trimmed.slice(cut + 1)
    }

    /**
     * 文件大小 → 人读字符串。
     * 用 1024 进制（与 ls -h / Finder 一致），不是 1000。
     */
    function formatSize(bytes) {
      if (bytes === undefined || bytes === null) return ''
      var n = Number(bytes)
      if (!Number.isFinite(n) || n < 0) return ''
      if (n < 1024) return Math.round(n) + ' B'
      var units = ['KB', 'MB', 'GB', 'TB']
      var value = n
      var index = -1
      do {
        value /= 1024
        index += 1
      } while (value >= 1024 && index < units.length - 1)
      var digits = value < 10 ? 1 : 0
      var text = value.toFixed(digits)
      /* 1048575 B 先得到 1023.999… KB，四舍五入成 "1024 KB" 很怪；
         跨过阈值就进位到下一单位。 */
      if (Number(text) >= 1024 && index < units.length - 1) {
        value /= 1024
        index += 1
        text = value.toFixed(value < 10 ? 1 : 0)
      }
      return text + ' ' + units[index]
    }

    /**
     * 删除前要不要再问一遍。
     *
     * 规则刻意保守：文件也问——远端没有回收站，`rm` 之后就没了。
     * 函数存在的意义是让"为什么总要问"在代码里有个明确落点，
     * 将来若要加"空目录不问"之类的白名单就改这里。
     */
    function needsConfirmBeforeRemove() {
      return true
    }

    /** 面板可编辑的文件大小上限：与宿主侧 MAX_BODY_BYTES（8MB）对齐，再留 JSON 转义余量。 */
    var MAX_EDIT_BYTES = 6 * 1024 * 1024

    /**
     * 这个文件能不能在面板里直接编辑。
     *
     * 大文件不打开编辑器，而是提示用终端里的 vim——在浏览器 textarea 里
     * 编辑几十 MB 的日志，卡的是用户自己的浏览器。
     */
    function canEditFile(entry) {
      if (entry === null || entry === undefined) return false
      if (entry.type !== 'file') return false
      if (typeof entry.size === 'number' && entry.size > MAX_EDIT_BYTES) return false
      return true
    }

    /** 文件类型 → 图标字形。用文字符号而不是 SVG：列表行多，SVG 太重。 */
    function iconOf(entry) {
      if (entry === null || entry === undefined) return '·'
      if (entry.type === 'directory') return '▸'
      if (entry.type !== 'file') return '◇'
      var name = String(entry.name === undefined ? '' : entry.name)
      if (/\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(name)) return '▣'
      if (/\.(zip|tar|gz|bz2|xz|7z|rar)$/i.test(name)) return '▤'
      if (/\.(js|cjs|mjs|ts|tsx|jsx|py|go|rs|java|c|h|cpp|rb|php|sh|zsh|lua)$/i.test(name)) return '⌗'
      if (/\.(json|ya?ml|toml|ini|conf|env|xml)$/i.test(name)) return '⚙'
      if (/\.(md|txt|log|rst)$/i.test(name)) return '≡'
      return '·'
    }

    /** 请求后端。统一把 `{ok:false}` 变成 throw，调用方只写 happy path。 */
    async function callApi(method, route, payload) {
      var init = { method: method, headers: {} }
      var url = '/__dsh-terminal-workbench/fs' + route
      if (method === 'GET') {
        if (payload !== undefined && payload !== null) {
          var query = new URLSearchParams()
          Object.keys(payload).forEach(function (key) {
            var value = payload[key]
            if (value !== undefined && value !== null) query.set(key, String(value))
          })
          var text = query.toString()
          if (text !== '') url += '?' + text
        }
      } else {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(payload === undefined || payload === null ? {} : payload)
      }
      var response
      try {
        response = await fetch(url, init)
      } catch (error) {
        throw new Error('网络请求失败：' + (error && error.message !== undefined ? error.message : error))
      }
      var json
      try {
        json = await response.json()
      } catch (error) {
        throw new Error('服务端返回了非 JSON（HTTP ' + response.status + '）')
      }
      if (json === null || json === undefined || json.ok !== true) {
        /* 带上 code 一起报：`FS_NOT_FOUND` 与 `FS_IO_ERROR` 对用户意味着完全不同的
           下一步动作（前者"刷新一下"，后者"检查网络/权限"）。 */
        var suffix = json === null || json === undefined || json.code === undefined ? '' : '（' + json.code + '）'
        var message = json === null || json === undefined ? '未知错误' : json.error === undefined ? '未知错误' : json.error
        var error = new Error(message + suffix)
        /* 带上 code：上传遇到 FS_EXISTS 要弹覆盖确认，不能靠解析中文文案。 */
        error.code = json === null || json === undefined ? undefined : json.code
        throw error
      }
      return json
    }

    var fsApi = {
      remotes: function () { return callApi('GET', '/remotes') },
      /* 登记当前 SSH 书签的连接：宿主只放内存，面板随后就能按别名连 SFTP。 */
      connect: function (connection) { return callApi('POST', '/connect', connection) },
      /* 注销动态登记（只影响宿主内存里的书签连接，不动 remotes.json）。
         主要给回归测试收尾用：测试注入的假别名不能留在宿主进程里。 */
      disconnect: function (alias) { return callApi('POST', '/disconnect', { alias: alias }) },
      list: function (path) { return callApi('GET', '/list', { path: path }) },
      read: function (path) { return callApi('GET', '/read', { path: path }) },
      write: function (path, content, version) { return callApi('POST', '/write', { path: path, content: content, version: version }) },
      mkdir: function (path) { return callApi('POST', '/mkdir', { path: path }) },
      move: function (from, to) { return callApi('POST', '/move', { from: from, to: to }) },
      copy: function (from, to) { return callApi('POST', '/copy', { from: from, to: to }) },
      remove: function (path, recursive) { return callApi('POST', '/remove', { path: path, recursive: recursive, confirm: true }) },
      /* 上传走原始二进制体：文件不经过 JSON/base64，内存占用与文件大小无关。 */
      upload: function (dir, file, overwrite) {
        var url =
          '/__dsh-terminal-workbench/fs/upload?path=' +
          encodeURIComponent(dir) +
          '&name=' +
          encodeURIComponent(file.name) +
          (overwrite === true ? '&overwrite=1' : '')
        return fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: file,
        }).then(function (response) {
          return response.json().then(function (json) {
            if (json === null || json === undefined || json.ok !== true) {
              var suffix = json === null || json === undefined || json.code === undefined ? '' : '（' + json.code + '）'
              var message =
                json === null || json === undefined
                  ? '上传失败（HTTP ' + response.status + '）'
                  : json.error === undefined
                    ? '上传失败（HTTP ' + response.status + '）'
                    : json.error
              var error = new Error(message + suffix)
              error.code = json === null || json === undefined ? undefined : json.code
              throw error
            }
            return json
          })
        })
      },
      /* 下载直接用浏览器导航：由宿主流式回传，前端不把整文件读进内存。 */
      downloadUrl: function (path) {
        return '/__dsh-terminal-workbench/fs/download?path=' + encodeURIComponent(path)
      },
    }

    /**
     * 抽屉初始锚点：尽量落到 ssh 会话记到的远端 $PWD。
     *
     * 用户按面板的时机几乎总是"我刚 cd 到这儿，想看看文件"，所以能借到会话的
     * cwd 就别从根目录开始翻。
     *
     * 关键约束：当前书签的别名不在宿主清单里时，**绝不回落到清单里的第一台**。
     * 那等于"书签没登记成功，就随便连另一台机器"——现场会看到完全无关的主机
     * 报错（甚至误操作别人的文件）。这里返回 `missing`，由调用方明确报错。
     * 只有会话本身没给别名时，才允许用清单第一台做手动浏览的起点。
     */
    function initialPathOf(aliases, preferred) {
      if (typeof preferred === 'string' && preferred !== '') {
        var parsed = parseRemotePath(preferred)
        if (parsed !== null) {
          if (aliases.indexOf(parsed.alias) !== -1) return parsed
          return { alias: '', path: '/', missing: parsed.alias }
        }
      }
      if (aliases.length === 0) return { alias: '', path: '/' }
      return { alias: aliases[0], path: '/' }
    }

    /**
     * 生成面板组件。
     *
     * 用工厂而不是直接导出组件：组件要用宿主的 `react` 实例（插件跑在宿主的
     * 模块系统里，自己 import 一份会导致 hooks 报 "Invalid hook call"）。
     * 这里用 createElement 而不是 jsx 运行时：chunk 由 __ModuleLoader__ 加载，
     * 拿不到主 client.js 里的 jsx 变量。
     */
    function createFsPanel(deps) {
      var react = deps.react
      var t = deps.t
      var h = react.createElement

      function FsPanel(props) {
        var aliasesState = react.useState([])
        var cwdState = react.useState({ alias: '', path: '/' })
        var entriesState = react.useState([])
        var loadingState = react.useState(false)
        var errorState = react.useState('')
        var truncatedState = react.useState(false)
        var selectedState = react.useState('')
        var editorState = react.useState(null)
        var busyState = react.useState(false)
        /* 上传进度：{ name, index, total }；null 表示空闲。 */
        var uploadingState = react.useState(null)
        /* 隐藏的 <input type=file>：点「上传」按钮时由代码触发。 */
        var uploadRef = react.useRef(null)

        var aliases = aliasesState[0]
        var setAliases = aliasesState[1]
        var cwd = cwdState[0]
        var setCwd = cwdState[1]
        var entries = entriesState[0]
        var setEntries = entriesState[1]
        var loading = loadingState[0]
        var setLoading = loadingState[1]
        var error = errorState[0]
        var setError = errorState[1]
        var truncated = truncatedState[0]
        var setTruncated = truncatedState[1]
        var selected = selectedState[0]
        var setSelected = selectedState[1]
        var editor = editorState[0]
        var setEditor = editorState[1]
        var busy = busyState[0]
        var setBusy = busyState[1]
        var uploading = uploadingState[0]
        var setUploading = uploadingState[1]

        /* 组件卸载后不能再 setState（React 会警告，且可能写入已销毁的树）。
           用 ref 做闸门，所有异步回调先看它。 */
        var aliveRef = react.useRef(true)
        /* 目录请求序号，见 loadDir。 */
        var loadSeqRef = react.useRef(0)
        react.useEffect(function () {
          aliveRef.current = true
          return function () { aliveRef.current = false }
        }, [])

        var fail = function (err) {
          if (!aliveRef.current) return
          setError(String(err && err.message !== undefined ? err.message : err))
        }

        var text = function (key, fallback) {
          if (typeof t !== 'function') return fallback
          var value = t(key)
          return typeof value === 'string' && value !== '' && value !== key ? value : fallback
        }

        /* ---------- 登记书签连接 + 载入远端清单 ----------
           文件面板不再要求用户手写 remotes.json：把当前 SSH 书签的连接
           交给宿主登记（只在内存），随后按书签名当别名直接连 SFTP。
           登记失败不立刻报错——如果 remotes.json 里已有同名配置，仍可用。 */
        var connection = props.connection
        var connectionKey =
          connection === undefined || connection === null
            ? ''
            : [
                connection.alias,
                connection.host,
                connection.port,
                connection.username,
                connection.auth,
                connection.password,
                connection.keyPath,
              ].join('\u0000')
        react.useEffect(function () {
          var registerError = null
          var registered =
            connectionKey === ''
              ? Promise.resolve()
              : fsApi.connect(connection).catch(function (error) {
                  registerError = error
                })
          registered
            .then(function () { return fsApi.remotes() })
            .then(function (json) {
              if (!aliveRef.current) return
              var list = Array.isArray(json.aliases) ? json.aliases : []
              var next = initialPathOf(list, props.initialPath)
              setAliases(list)
              if (next.alias === '' && next.missing !== undefined) {
                /* 当前书签没登记成功：明确报错，不拿清单里的别的机器顶替。 */
                fail(
                  registerError !== null
                    ? registerError
                    : new Error(
                        '当前书签「' +
                          next.missing +
                          '」没有登记到宿主' +
                          (list.length === 0 ? '（宿主还没有任何远端）' : '（已配置：' + list.join('、') + '）'),
                      ),
                )
                return
              }
              setCwd(next)
              if (list.length === 0 && registerError !== null) fail(registerError)
            })
            .catch(fail)
        }, [connectionKey])

        /** 载入某个目录的条目。cwd 为空表示还没定锚，什么都不做。 */
        var loadDir = react.useCallback(function (nextCwd) {
          if (nextCwd.alias === '') return
          var target = makeRemotePath(nextCwd.alias, nextCwd.path)
          /* 请求序号：用户连点目录时先发的请求可能后回，慢响应会把
             新目录的 entries 覆盖成旧目录的。只认最后一次请求。 */
          loadSeqRef.current += 1
          var seq = loadSeqRef.current
          setLoading(true)
          setError('')
          fsApi
            .list(target)
            .then(function (json) {
              if (!aliveRef.current || seq !== loadSeqRef.current) return
              /* 用宿主返回的 path 回填：远端可能做了 realpath 归一（软链解析），
                 以宿主为准才不会出现"面包屑写着 /a，实际列的是 /b"。 */
              var real = typeof json.path === 'string' ? json.path : nextCwd.path
              setCwd({ alias: nextCwd.alias, path: real })
              setEntries(Array.isArray(json.entries) ? json.entries : [])
              setTruncated(json.truncated === true)
              setLoading(false)
            })
            .catch(function (err) {
              if (!aliveRef.current || seq !== loadSeqRef.current) return
              setLoading(false)
              fail(err)
            })
        }, [])

        /* 目录变了就重拉。用 alias+路径拼 key：cwd 每次都是新对象，
           直接依赖对象会无限重拉。 */
        var cwdKey = cwd.alias + '\u0000' + cwd.path
        react.useEffect(function () {
          if (cwd.alias !== '') loadDir(cwd)
        }, [cwdKey])

        /**
         * 刷新当前目录。
         * 所有写操作的收尾都要调它：新建/删除/改名之后列表必须反映真实状态，
         * 让用户自己再点一次刷新等于把锅甩给用户。
         */
        var refresh = function () {
          if (cwd.alias !== '') loadDir(cwd)
        }

        var openDir = function (nextCwd) {
          setSelected('')
          setCwd(nextCwd)
        }

        var enter = function (entry) {
          if (entry.type !== 'directory') return
          openDir({ alias: cwd.alias, path: joinRemotePath(cwd.path, entry.name) })
        }

        var goUp = function () {
          if (cwd.path === '/') return
          openDir({ alias: cwd.alias, path: parentOf(cwd.path) })
        }

        /* ---------- 打开编辑器 ---------- */
        var openFile = function (entry) {
          if (entry.type !== 'file') return
          if (!canEditFile(entry)) {
            setError(entry.name + ' 太大（' + formatSize(entry.size) + '），请在终端里用 vim 打开')
            return
          }
          var target = makeRemotePath(cwd.alias, joinRemotePath(cwd.path, entry.name))
          setBusy(true)
          fsApi
            .read(target)
            .then(function (json) {
              if (!aliveRef.current) return
              setBusy(false)
              setEditor({
                path: target,
                name: entry.name,
                content: String(json.content === undefined ? '' : json.content),
                version: json.version,
                dirty: false,
              })
            })
            .catch(function (err) {
              if (!aliveRef.current) return
              setBusy(false)
              fail(err)
            })
        }

        var saveFile = function () {
          if (editor === null) return
          setBusy(true)
          fsApi
            .write(editor.path, editor.content, editor.version)
            .then(function () {
              if (!aliveRef.current) return
              setBusy(false)
              setEditor(null)
              setError('')
              refresh()
            })
            .catch(function (err) {
              if (!aliveRef.current) return
              setBusy(false)
              fail(err)
            })
        }

        /* ---------- 新建目录 ---------- */
        var makeDir = function () {
          var name = window.prompt(text('fs.newFolderName', '新建文件夹'))
          if (name === null || name.trim() === '') return
          if (name.indexOf('/') !== -1) {
            setError('目录名不能包含 /')
            return
          }
          var target = makeRemotePath(cwd.alias, joinRemotePath(cwd.path, name.trim()))
          setBusy(true)
          fsApi
            .mkdir(target)
            .then(function () {
              if (!aliveRef.current) return
              setBusy(false)
              refresh()
            })
            .catch(function (err) {
              if (!aliveRef.current) return
              setBusy(false)
              fail(err)
            })
        }

        /* ---------- 重命名 ---------- */
        var renameEntry = function (entry) {
          var name = window.prompt(text('fs.renameTo', '重命名为'), entry.name)
          if (name === null || name.trim() === '' || name.trim() === entry.name) return
          if (name.indexOf('/') !== -1) {
            setError('名称不能包含 /')
            return
          }
          var from = makeRemotePath(cwd.alias, joinRemotePath(cwd.path, entry.name))
          var to = makeRemotePath(cwd.alias, joinRemotePath(cwd.path, name.trim()))
          setBusy(true)
          fsApi
            .move(from, to)
            .then(function () {
              if (!aliveRef.current) return
              setBusy(false)
              refresh()
            })
            .catch(function (err) {
              if (!aliveRef.current) return
              setBusy(false)
              fail(err)
            })
        }

        /* ---------- 删除 ---------- */
        var removeEntry = function (entry) {
          var target = makeRemotePath(cwd.alias, joinRemotePath(cwd.path, entry.name))
          if (needsConfirmBeforeRemove()) {
            var what = entry.type === 'directory' ? text('fs.confirmDir', '整个目录') : text('fs.confirmFile', '这个文件')
            var ok = window.confirm(
              text('fs.confirmRemove', '确认删除') + what + '：\n' + target + '\n\n' + text('fs.confirmWarn', '远端没有回收站，删除后无法恢复。'),
            )
            if (!ok) return
          }
          setBusy(true)
          fsApi
            .remove(target, entry.type === 'directory')
            .then(function () {
              if (!aliveRef.current) return
              setBusy(false)
              setSelected('')
              refresh()
            })
            .catch(function (err) {
              if (!aliveRef.current) return
              setBusy(false)
              fail(err)
            })
        }

        /* ---------- 下载 ---------- */
        var downloadEntry = function (entry) {
          if (entry.type !== 'file') return
          var target = makeRemotePath(cwd.alias, joinRemotePath(cwd.path, entry.name))
          var link = document.createElement('a')
          link.href = fsApi.downloadUrl(target)
          link.download = entry.name
          link.style.display = 'none'
          document.body.appendChild(link)
          link.click()
          link.remove()
        }

        /* ---------- 上传 ----------
           逐个文件串行传：并行上传会让进度条和错误归属都变乱。
           同名先按当前清单确认再传；清单之外的同名文件由宿主 409 兜底。 */
        var uploadFiles = function (files) {
          if (files.length === 0) return
          var dir = makeRemotePath(cwd.alias, cwd.path)
          var index = 0
          var run = function () {
            if (!aliveRef.current) return
            if (index >= files.length) {
              setUploading(null)
              setBusy(false)
              refresh()
              return
            }
            var file = files[index]
            setUploading({ name: file.name, index: index + 1, total: files.length })
            /* 先按当前目录清单预判同名：确认后再传，避免整份文件传完才收到
               409、用户点“覆盖”又从头传一遍。清单被截断或期间新增同名文件时，
               下面的 409 兜底仍然有效。 */
            var exists = entries.some(function (entry) {
              return entry.type === 'file' && entry.name === file.name
            })
            if (exists) {
              var ok = window.confirm(
                text('fs.confirmOverwrite', '远端已存在同名文件，覆盖？') + '\n' + file.name,
              )
              if (!ok) {
                index += 1
                run()
                return
              }
            }
            var send = function (overwrite) {
              return fsApi.upload(dir, file, overwrite).catch(function (err) {
                if (err && err.code === 'FS_EXISTS') {
                  var retry = window.confirm(
                    text('fs.confirmOverwrite', '远端已存在同名文件，覆盖？') + '\n' + file.name,
                  )
                  if (retry) return fsApi.upload(dir, file, true)
                  return undefined
                }
                throw err
              })
            }
            send(exists)
              .then(function () {
                index += 1
                run()
              })
              .catch(function (err) {
                if (!aliveRef.current) return
                setUploading(null)
                setBusy(false)
                fail(err)
              })
          }
          setBusy(true)
          run()
        }

        var pickUpload = function () {
          if (uploadRef.current !== null && typeof uploadRef.current.click === 'function') uploadRef.current.click()
        }

        var onUploadChange = function (event) {
          var files = Array.prototype.slice.call(event.target.files || [])
          /* 清空 value：同一个文件改完再传一次也能触发 change。 */
          event.target.value = ''
          uploadFiles(files)
        }

        /* ---------- 渲染 ---------- */
        if (aliases.length === 0 && error === '') {
          return h('div', { className: 'tp-fs' },
            h('div', { className: 'tp-fs-empty' }, text('fs.noRemotes', '还没有可用的远端：用 SSH 书签打开终端后，面板会自动使用该书签的连接')))
        }

        /* 面包屑：每段都能点。分段时保留绝对路径语义，点第 n 段就到第 n 层。 */
        var crumbs = []
        crumbs.push(h('button', {
          key: 'root',
          type: 'button',
          className: 'tp-fs-crumb',
          onClick: function () { openDir({ alias: cwd.alias, path: '/' }) },
        }, '/'))
        var acc = ''
        var parts = cwd.path === '/' ? [] : cwd.path.split('/').filter(function (p) { return p !== '' })
        parts.forEach(function (part) {
          acc += '/' + part
          var target = acc
          /* key 用 'seg:路径' 前缀：单用路径会与上面的 'root' 或彼此撞车
             （`/a` 这一段的路径恰好是 '/a'，和标题文本无关但容易写错）。 */
          crumbs.push(h('span', { key: 'sep:' + target, className: 'tp-fs-crumb-sep' }, '›'))
          crumbs.push(h('button', {
            key: 'seg:' + target,
            type: 'button',
            className: 'tp-fs-crumb',
            onClick: function () { openDir({ alias: cwd.alias, path: target }) },
          }, part))
        })

        var rows = entries.map(function (entry) {
          return h('div', {
            key: entry.name,
            className: 'tp-fs-row',
            'data-type': entry.type,
            'data-selected': selected === entry.name ? 'true' : undefined,
            title: entry.name,
            onClick: function () { setSelected(entry.name) },
            onDoubleClick: function () {
              if (entry.type === 'directory') enter(entry)
              else openFile(entry)
            },
          }, [
            h('span', { key: 'i', className: 'tp-fs-icon' }, iconOf(entry)),
            h('span', { key: 'n', className: 'tp-fs-name' }, entry.name),
            h('span', { key: 's', className: 'tp-fs-size' }, entry.type === 'file' ? formatSize(entry.size) : ''),
            h('span', { key: 'o', className: 'tp-fs-ops' }, [
              entry.type === 'file'
                ? h('button', {
                    key: 'dl',
                    type: 'button',
                    className: 'tp-fs-op',
                    title: text('fs.download', '下载'),
                    onClick: function (event) { event.stopPropagation(); downloadEntry(entry) },
                  }, '↓')
                : null,
              h('button', {
                key: 'r',
                type: 'button',
                className: 'tp-fs-op',
                title: text('fs.rename', '重命名'),
                onClick: function (event) { event.stopPropagation(); renameEntry(entry) },
              }, '✎'),
              h('button', {
                key: 'd',
                type: 'button',
                className: 'tp-fs-op',
                title: text('fs.remove', '删除'),
                onClick: function (event) { event.stopPropagation(); removeEntry(entry) },
              }, '✕'),
            ]),
          ])
        })

        var body
        if (loading) body = h('div', { className: 'tp-fs-empty' }, text('fs.loading', '载入中…'))
        else if (entries.length === 0) body = h('div', { className: 'tp-fs-empty' }, text('fs.emptyDir', '空目录'))
        else body = h('div', { className: 'tp-fs-list' }, rows)

        var editorView = editor === null ? null : h('div', { className: 'tp-fs-editor' }, [
          h('div', { key: 'head', className: 'tp-fs-editor-head' }, [
            h('span', { key: 't', className: 'tp-fs-editor-title' }, editor.name),
            editor.dirty ? h('span', { key: 'd', className: 'tp-fs-dirty' }, '●') : null,
            h('button', {
              key: 'c',
              type: 'button',
              className: 'tp-fs-btn',
              onClick: function () { setEditor(null) },
            }, text('fs.cancel', '取消')),
            h('button', {
              key: 's',
              type: 'button',
              className: 'tp-fs-btn tp-fs-btn-primary',
              disabled: busy,
              onClick: saveFile,
            }, text('fs.save', '保存')),
          ]),
          h('textarea', {
            key: 'body',
            className: 'tp-fs-textarea',
            value: editor.content,
            spellCheck: false,
            /* 同一个处理器同时挂 onChange 与 onInput：
               浏览器里受控组件走 onChange（React 归一化的事件，输入法合成阶段
               会被正确抑制），onInput 只是兜底。之所以两个都挂，是因为
               jsdom 环境下 React 的 ChangeEventPlugin 不触发 onChange
               （测试里能复现），只挂一个就没法自动化验证这条链路。
               两者都指向同一函数，重复触发时 setState 内容相同，无副作用。 */
            onChange: function (event) {
              var next = event.target.value
              setEditor(function (prev) { return Object.assign({}, prev, { content: next, dirty: true }) })
            },
            onInput: function (event) {
              var next = event.target.value
              /* 用函数式更新而不是闭包里的 editor：两个事件可能在同一次 tick 里
                 先后到达，闭包里的 editor 会是旧的，后到的会把先到的覆盖掉。 */
              setEditor(function (prev) { return Object.assign({}, prev, { content: next, dirty: true }) })
            },
          }),
        ])

        /* 选择器选项：正常情况下就是宿主返回的别名。cwd.alias 为空表示
           当前书签没登记成功（上面已报错），给一个禁用的占位项，避免
           浏览器默认选中第一台机器，看起来像"已经连上别的机器"。 */
        var aliasOptions = aliases.slice()
        if (cwd.alias === '') {
          aliasOptions.unshift('')
        } else if (aliasOptions.indexOf(cwd.alias) === -1) {
          aliasOptions.push(cwd.alias)
        }

        return h('div', { className: 'tp-fs' }, [
          h('input', {
            key: 'upload-input',
            ref: uploadRef,
            type: 'file',
            multiple: true,
            style: { display: 'none' },
            onChange: onUploadChange,
          }),
          h('div', { key: 'head', className: 'tp-fs-head' }, [
            h('select', {
              key: 'a',
              className: 'tp-fs-alias',
              value: cwd.alias,
              onChange: function (event) { openDir({ alias: event.target.value, path: '/' }) },
            }, aliasOptions.map(function (alias) {
              if (alias === '') {
                return h('option', { key: '__none', value: '', disabled: true }, text('fs.pickAlias', '选择远端…'))
              }
              return h('option', { key: alias, value: alias }, alias)
            })),
            h('button', {
              key: 'u',
              type: 'button',
              className: 'tp-fs-btn',
              title: text('fs.up', '上一级'),
              disabled: cwd.path === '/',
              onClick: goUp,
            }, '↑'),
            h('button', {
              key: 'r',
              type: 'button',
              className: 'tp-fs-btn',
              title: text('fs.refresh', '刷新'),
              onClick: refresh,
            }, '↻'),
            h('button', {
              key: 'n',
              type: 'button',
              className: 'tp-fs-btn',
              title: text('fs.newFolder', '新建目录'),
              onClick: makeDir,
            }, '＋'),
            h('button', {
              key: 'up',
              type: 'button',
              className: 'tp-fs-btn',
              title: text('fs.upload', '上传文件'),
              disabled: busy || uploading !== null || cwd.alias === '',
              onClick: pickUpload,
            }, '⇪'),
          ]),
          h('div', { key: 'path', className: 'tp-fs-path' }, crumbs),
          uploading === null
            ? null
            : h(
                'div',
                { key: 'uploading', className: 'tp-fs-note' },
                text('fs.uploading', '上传中') +
                  ' ' +
                  uploading.name +
                  '（' +
                  uploading.index +
                  '/' +
                  uploading.total +
                  '）',
              ),
          error === '' ? null : h('div', { key: 'err', className: 'tp-fs-error' }, [
            h('span', { key: 't' }, error),
            h('button', {
              key: 'x',
              type: 'button',
              className: 'tp-fs-op',
              onClick: function () { setError('') },
            }, '✕'),
          ]),
          h('div', { key: 'body', className: 'tp-fs-body' }, body),
          truncated ? h('div', { key: 'note', className: 'tp-fs-note' }, text('fs.truncated', '条目过多，只显示前 2000 个')) : null,
          /* 这里必须包一层带 key 的元素：editorView 本身是 h() 的产物，
             它的 key 在数组里得由自己带——直接放对象进数组 React 会报
             "unique key prop" 警告。 */
          h(react.Fragment, { key: 'editor' }, editorView),
        ])
      }

      return FsPanel
    }

    module.exports.parseRemotePath = parseRemotePath
    module.exports.makeRemotePath = makeRemotePath
    module.exports.joinRemotePath = joinRemotePath
    module.exports.parentOf = parentOf
    module.exports.baseNameOf = baseNameOf
    module.exports.formatSize = formatSize
    module.exports.needsConfirmBeforeRemove = needsConfirmBeforeRemove
    module.exports.canEditFile = canEditFile
    module.exports.iconOf = iconOf
    module.exports.MAX_EDIT_BYTES = MAX_EDIT_BYTES
    module.exports.fsApi = fsApi
    module.exports.initialPathOf = initialPathOf
    module.exports.createFsPanel = createFsPanel

    return module.exports
  }
});
