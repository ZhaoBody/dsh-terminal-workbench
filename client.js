/**
 * dsh-workbench-layout — 终端工作台三栏布局（浏览器半侧）。
 *
 * 形态：
 *   ┌──────────┬──────────────┬──────────────┐
 *   │ 会话列表  │ 终端面板      │ 对话          │
 *   │ (sidebar)│ (rightbar)   │ (main)       │
 *   └──────────┴──────────────┴──────────────┘
 *
 * 替换内置 @deepseek-ai/dsh-client-ui-layout（patch 里按 id 禁用），
 * 由本插件接管 root 槽，并向其他插件提供同名 `layout` 服务，保证
 * ui-sidebar / ui-sidebar-right / conversation / plugin-manager 等
 * 现有插件无需改动即可继续工作。
 *
 * 设计取舍（用户确认）：
 *   - 中栏复用现有 rightbar 槽（终端面板自带多 tab / shell 选择 / 关闭）；
 *   - 右栏保留 main 槽的 keyed 面板（对话 / 轨迹 / 插件管理等）；
 *   - 中栏可折叠（拖拽手柄双击切换）。
 *
 * 宪法自查：单一职责（只负责三栏布局与列宽）；数据有主（布局状态本插件独占）；
 * 依赖单向（inject 官方服务，provide layout 给对方）；封闭新建（不改内置文件）；
 * 副作用全部挂 ctx.effect，卸载逆序释放。
 *
 * @module dsh-workbench-layout/client
 */
window.__ModuleLoader__.load({
  id: "dsh-terminal-workbench",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /* 执行进度信标（v0.9.4）：宿主看门狗靠它区分“还在下载”和“脚本已开始
       执行”。放在 factory 最前面，任何后续装配异常都不会漏报。 */
    try {
      if (typeof Image !== "undefined") {
        var bootProgress = new Image();
        bootProgress.src =
          "/__dsh-terminal-workbench/boot-progress?t=" + Date.now();
      }
    } catch (error) {
      /* 进度信标失败不影响装配 */
    }

    var react = require("react");
    var reactDom = require("react-dom");
    var jsxRuntime = require("react/jsx-runtime");
    var clientStore = require("@deepseek-ai/dsh-client-store");

    var jsx = jsxRuntime.jsx;
    var jsxs = jsxRuntime.jsxs;

    /* apply 期间捕获的插件上下文：空状态的重开按钮需要按需取 sidebarRight 服务。 */
    var pluginCtx = null;

    /* ── 终端关闭意图策略 ──────────────────────────────────────────────
       关闭意图不是日志，它只在「宿主上可能还有这个终端」时有意义。两条约束
       缺一就会重演「启动时重放上千个 close、界面转圈几十秒」：

       1) 队列有界。宿主每个会话最多 maxTerminals 个终端（默认 8），所以一个
          会话的待确认关闭超过这个数，多出来的必然已经不存在；解析不了的值
          也不可用。启动时按会话截断，只留最新的 8 条，全局最多 64 条。
          这一步只做本地字典裁剪，不发任何请求，正常关闭路径完全不变。
       2) 明确不存在的终端不进入重试。视图状态 issue='missingTerminal' 表示
          宿主已确认终端不存在（terminal/view 或 terminal/unavailable）；这时
          关闭只是丢标签，留标记只会让下次启动再发一遍注定失败的请求。 */
    var TERMINAL_CLOSE_PREFIX = 'dsh.terminal.close.v1.'
    var TERMINAL_CLOSE_PER_SESSION = 8
    var TERMINAL_CLOSE_TOTAL = 64
    /* 重试预算：一条关闭意图最多跨一次启动重放。下次启动还在，说明它不可能
       成功（终端已不存在 / 宿主不再接受），丢掉而不是永远重试。 */
    var TERMINAL_CLOSE_RETRY_KEY = 'dsh-terminal-workbench.close-retry.v1'

    function readTerminalCloseKeys(storage) {
      var keys = []
      try {
        if (storage === undefined || storage === null) return keys
        if (typeof storage.length !== 'number' || typeof storage.key !== 'function') return keys
        for (var index = 0; index < storage.length; index += 1) {
          var key = storage.key(index)
          if (typeof key === 'string' && key.indexOf(TERMINAL_CLOSE_PREFIX) === 0) keys.push(key)
        }
      } catch (error) {
        /* localStorage 不可用时视为没有 */
      }
      return keys
    }

    function boundTerminalCloseRequests(storage, limits, retriedIds) {
      var keys = readTerminalCloseKeys(storage)
      var perSession =
        limits !== undefined && limits !== null && typeof limits.perSession === 'number'
          ? limits.perSession
          : TERMINAL_CLOSE_PER_SESSION
      var globalMax =
        limits !== undefined && limits !== null && typeof limits.global === 'number'
          ? limits.global
          : TERMINAL_CLOSE_TOTAL
      var retried = Object.create(null)
      if (Array.isArray(retriedIds)) {
        for (var retriedIndex = 0; retriedIndex < retriedIds.length; retriedIndex += 1) {
          if (typeof retriedIds[retriedIndex] === 'string') retried[retriedIds[retriedIndex]] = true
        }
      }
      var alive = []
      var bySession = Object.create(null)
      var invalid = 0
      var expired = 0
      for (var index = 0; index < keys.length; index += 1) {
        var key = keys[index]
        var parsed
        try {
          parsed = JSON.parse(String(storage.getItem(key)))
        } catch (error) {
          parsed = undefined
        }
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          typeof parsed.sessionId !== 'string' ||
          parsed.sessionId === '' ||
          typeof parsed.id !== 'string' ||
          !/^[\w-]{1,128}$/u.test(parsed.id) ||
          typeof parsed.title !== 'string' ||
          key !== TERMINAL_CLOSE_PREFIX + parsed.id
        ) {
          try {
            storage.removeItem(key)
          } catch (error) {
            /* 忽略 */
          }
          invalid += 1
          continue
        }
        if (retried[parsed.id] === true) {
          try {
            storage.removeItem(key)
          } catch (error) {
            /* 忽略 */
          }
          expired += 1
          continue
        }
        var entry = { key: key, sessionId: parsed.sessionId, id: parsed.id }
        alive.push(entry)
        var bucket = bySession[parsed.sessionId]
        if (bucket === undefined) {
          bucket = []
          bySession[parsed.sessionId] = bucket
        }
        bucket.push(entry)
      }
      var dropped = 0
      var drop = function (entry) {
        if (entry.dropped === true) return
        try {
          storage.removeItem(entry.key)
          entry.dropped = true
          dropped += 1
        } catch (error) {
          /* 忽略 */
        }
      }
      var sessionIds = Object.keys(bySession)
      for (var sessionIndex = 0; sessionIndex < sessionIds.length; sessionIndex += 1) {
        var list = bySession[sessionIds[sessionIndex]]
        for (var excess = 0; excess < list.length - perSession; excess += 1) drop(list[excess])
      }
      var kept = []
      for (var aliveIndex = 0; aliveIndex < alive.length; aliveIndex += 1) {
        if (alive[aliveIndex].dropped !== true) kept.push(alive[aliveIndex])
      }
      for (var over = 0; over < kept.length - globalMax; over += 1) drop(kept[over])
      var keptIds = []
      for (var keptIndex = 0; keptIndex < kept.length; keptIndex += 1) {
        if (kept[keptIndex].dropped !== true) keptIds.push(kept[keptIndex].id)
      }
      return {
        seen: keys.length,
        kept: alive.length - dropped,
        dropped: dropped,
        invalid: invalid,
        expired: expired,
        sessions: sessionIds.length,
        keptIds: keptIds,
      }
    }

    function readRetriedTerminalCloseIds(storage) {
      try {
        var raw = storage === undefined || storage === null ? null : storage.getItem(TERMINAL_CLOSE_RETRY_KEY)
        if (typeof raw !== 'string') return []
        var parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        var ids = []
        for (var index = 0; index < parsed.length; index += 1) {
          if (typeof parsed[index] === 'string') ids.push(parsed[index])
        }
        return ids
      } catch (error) {
        return []
      }
    }

    function writeRetriedTerminalCloseIds(storage, ids) {
      try {
        if (storage === undefined || storage === null) return
        storage.setItem(TERMINAL_CLOSE_RETRY_KEY, JSON.stringify(Array.isArray(ids) ? ids : []))
      } catch (error) {
        /* quota / 隐私模式下忽略 */
      }
    }

    /* 一次启动只做一次：过期清理 → 容量裁剪 → 记录本轮保留的 id，供下次启动
       判断「它已经跨过一次启动还没成功」。 */
    function applyTerminalClosePolicy(storage, limits) {
      var report = boundTerminalCloseRequests(storage, limits, readRetriedTerminalCloseIds(storage))
      writeRetriedTerminalCloseIds(storage, report.keptIds)
      return report
    }

    /* 宿主上还有没有这个终端：只认视图状态，不猜。核心服务没暴露视图表时
       返回 undefined，调用方按「可能有」处理（保守，保留关闭标记）。 */
    function terminalViewOf(ctx, sessionId, key) {
      try {
        var terminals = ctx === undefined || ctx === null ? undefined : ctx.webTerminals
        var views = terminals === undefined || terminals === null ? undefined : terminals.views
        if (views === undefined || views === null || typeof views.get !== 'function') return undefined
        var bucket = views.get(sessionId)
        return bucket !== undefined && bucket !== null && typeof bucket.get === 'function'
          ? bucket.get(key)
          : undefined
      } catch (error) {
        return undefined
      }
    }

    function terminalClosePolicy(view) {
      var state
      try {
        state =
          view !== undefined &&
          view !== null &&
          view.state !== undefined &&
          typeof view.state.getSnapshot === 'function'
            ? view.state.getSnapshot()
            : undefined
      } catch (error) {
        state = undefined
      }
      var id = view !== undefined && view !== null && typeof view.id === 'string' ? view.id : undefined
      if (state !== undefined && state !== null && state.issue === 'missingTerminal') {
        return { retry: false, reason: 'missing', terminalId: id }
      }
      return {
        retry: true,
        reason: state !== undefined && state !== null && state.phase === 'failed' ? 'failed' : 'unknown',
        terminalId: id,
      }
    }

    /* 关闭一个终端标签。missingTerminal 时仍然调用核心 close（释放视图与
       binding，避免内存里留空壳），但紧接着抹掉它刚写入的重试标记：这个请求
       如果被持久化，下次启动就会为一个已经不存在的终端再发一次。 */
    function closeTerminalTab(ctx, sessionId, tab, fallbackTerminalId) {
      var view = terminalViewOf(ctx, sessionId, tab.id)
      var policy = terminalClosePolicy(view)
      var terminals = ctx === undefined || ctx === null ? undefined : ctx.webTerminals
      if (terminals === undefined || terminals === null || typeof terminals.close !== 'function') return policy
      terminals.close(sessionId, tab.id, tab.contentId, fallbackTerminalId)
      if (policy.retry === false && policy.terminalId !== undefined) {
        try {
          var requests = terminals.requests
          if (requests !== undefined && requests !== null && typeof requests.remove === 'function') {
            requests.remove(policy.terminalId)
            console.info(
              '[terminal-workbench] 终端已不存在，丢弃标签且不保留关闭重试：' + policy.terminalId,
            )
          }
        } catch (error) {
          console.warn('[terminal-workbench] 清理已不存在的终端关闭标记失败：', error)
        }
      }
      return policy
    }

    ;(function boundStaleTerminalCloseRequests() {
      try {
        var result = applyTerminalClosePolicy(window.localStorage, {
          perSession: TERMINAL_CLOSE_PER_SESSION,
          global: TERMINAL_CLOSE_TOTAL,
        })
        if (result.dropped > 0 || result.invalid > 0 || result.expired > 0) {
          console.warn(
            '[terminal-workbench] 启动裁剪关闭重试：丢弃 ' +
              result.dropped +
              ' 条超限、' +
              result.expired +
              ' 条已重试过、' +
              result.invalid +
              ' 条无效（保留 ' +
              result.kept +
              ' 条，涉及 ' +
              result.sessions +
              ' 个会话）',
          )
        }
      } catch (error) {
        /* localStorage 不可用时跳过 */
      }
    })();

    /* ---------- 常量 ---------- */

    var SIDEBAR_AUTO_COLLAPSE = 1024;
    var RIGHTBAR_MAX_RATIO = 0.7;
    var RIGHTBAR_DEFAULT_RATIO = 0.45;
    var SIDEBAR_MIN = 264;
    var SIDEBAR_MAX = 420;
    var RIGHTBAR_MIN = 300;
    var CENTER_MIN = 400;

    /* ---------- 纯函数（可独立测试） ---------- */

    function clampWidth(px, min, max) {
      return Math.min(max, Math.max(min, Math.round(px)));
    }

    /**
     * 解三栏宽度：左栏、中栏（终端）、右栏（对话）。
     * 中栏请求宽度不足或对话区将低于最小值时，中栏让位为 0（折叠）。
     */
    function computeColumns(viewport, sidebar, rightbar, collapsedWidth) {
      var s = sidebar === 0 ? collapsedWidth : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX);
      var available = viewport - s - CENTER_MIN;
      var r =
        rightbar === 0 || available < RIGHTBAR_MIN
          ? 0
          : Math.min(available, clampWidth(rightbar, RIGHTBAR_MIN, viewport * RIGHTBAR_MAX_RATIO));
      return { sidebar: s, center: Math.max(0, viewport - s - r), rightbar: r };
    }

    /**
     * 解整帧网格。原生右栏的「全屏」经 layout.openRightbar(track, fullscreen)
     * 落到 layoutInfo.rightbarFullscreen；只存不用于布局的话按钮点了没反应，
     * 所以这里把它翻成「左右列收成 0、中列吃满」的网格。
     */
    function computeFrame(layoutInfo, viewport, sidebar, rightbar, collapsedWidth) {
      var fullscreen =
        layoutInfo.rightbarFullscreen === true && layoutInfo.rightbarShown === true;
      if (fullscreen) {
        return {
          fullscreen: true,
          sidebar: 0,
          center: viewport,
          rightbar: viewport,
          gridTemplate: "0px minmax(0px, 1fr) 0px"
        };
      }
      var cols = computeColumns(viewport, sidebar, rightbar, collapsedWidth);
      return {
        fullscreen: false,
        sidebar: cols.sidebar,
        center: cols.center,
        rightbar: cols.rightbar,
        gridTemplate:
          cols.sidebar + "px minmax(0px, " + cols.rightbar + "px) minmax(400px, 1fr)"
      };
    }

    /* ---------- 样式 ---------- */

    var LAYOUT_CSS = [
      /* 用户指定：工作区表面统一为近黑 #121214（终端画布同色）。浮层/菜单/设置面板跟它走，不用比它更亮的中灰层。 */
      ":root{--tp-surface:#121214}",
      ".wb-frame{background:var(--tp-surface,#121214);grid-template-rows:100%;height:100%;display:grid;position:relative;overflow:hidden}",
      ".wb-frame[data-dragging]{transition:none}",
      ".wb-frame[data-rightbar-fullscreen='1'] .wb-sidebar-col,.wb-frame[data-rightbar-fullscreen='1'] .wb-main-col{visibility:hidden;border:0}",
      ".wb-sidebar-col{background:var(--dsw-specific-sidebar-fill);border-right:.5px solid var(--dsw-alias-border-l1);min-width:0;overflow:hidden}",
      ".wb-terminal-col{min-width:0;position:relative;overflow:hidden;border-right:.5px solid var(--dsw-alias-border-l1)}",
      ".wb-terminal-col[data-fullscreen='1']{border-right:0}",
      /* 原生右栏全屏把面板宽度写成 100vw；工作台里它挂在终端列内，
         用 100% 贴合列宽，避免多出滚动条宽度被裁掉。 */
      ".wb-terminal-col[data-fullscreen='1'] [data-sidebar-right-panel='fullscreen']{width:100%!important;--dsh-sidebar-width:100%!important}",
      ".wb-main-col{flex-direction:column;min-width:0;display:flex;overflow:hidden}",
      ".wb-handle{cursor:col-resize;z-index:11;touch-action:none;width:8px;margin-left:-4px;position:absolute;top:0;bottom:0}",
      ".wb-handle:hover,.wb-handle[data-active]{background:var(--dsw-alias-brand-primary,#4f6ef2);opacity:.35}",
      ".wb-pop{box-sizing:border-box;z-index:1000;position:fixed;display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,#2c2c2e);background:var(--tp-surface,#121214);box-shadow:0 18px 48px rgba(0,0,0,.55);max-height:calc(100vh - 16px);overflow:auto}",
      ".wb-pop-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#111827)}",
      ".wb-pop-input{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l1);background:var(--tp-surface,#121214);color:var(--dsw-alias-label-primary,#111827);font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;outline:none}",
      ".wb-pop-input:focus{border-color:var(--dsw-alias-brand-primary,#4f6ef2)}",
      ".wb-pop-row{display:flex;flex-wrap:wrap;gap:6px}",
      ".wb-pop-chip{padding:4px 9px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary,#111827);cursor:pointer;font-size:13px}",
      ".wb-pop-chip:hover{background:var(--dsw-alias-bg-layer-2,#f3f4f6)}",
      ".wb-pop-chip[data-selected]{border-color:var(--dsw-alias-brand-primary,#4f6ef2);color:var(--dsw-alias-brand-primary,#4f6ef2)}",
      ".wb-pop-section{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#9ca3af)}",
      ".wb-bookmark-groups{display:flex;flex-direction:column;gap:2px}",
      ".wb-bookmark-group{display:flex;flex-direction:column;gap:2px}",
      ".wb-bookmark-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:2px}",
      ".wb-pop-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-primary,#111827);border:0;background:transparent;text-align:left;width:100%;min-width:0}",
      ".wb-pop-item:hover{background:var(--dsw-alias-bg-layer-2,#f3f4f6)}",
      ".wb-pop-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
      ".wb-pop-dot{width:8px;height:8px;border-radius:2px;flex:none}",
      ".wb-pop-empty{font-size:12px;color:var(--dsw-alias-label-secondary,#9ca3af)}",
      /* 标签栏溢出时让标签横向滚动，加号固定在右端，永远不被裁掉。 */
      ".wb-terminal-col div:has(> [data-dockkit-add-tab]){overflow-x:auto;overflow-y:hidden;scrollbar-width:none}",
      ".wb-terminal-col div:has(> [data-dockkit-add-tab])::-webkit-scrollbar{height:0}",
      ".wb-terminal-col [data-dockkit-add-tab]{position:sticky;right:0;z-index:2;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))}",
      /* electerm 式标签：100–200px 定宽、36px 栏高、标题省略号。 */
      ".wb-terminal-col [data-dockkit-strip]{min-height:36px}",
      /* 终端标签与普通文件标签分两行：终端（带 .tp-badge）排第一行，其余第二行。
         只有两种标签同时存在时才折行，单类标签保持原单行滚动行为。 */
      ".wb-terminal-col [data-dockkit-strip-tabs]:has(> [data-tp-strip-break]){flex-wrap:wrap;align-content:flex-start;row-gap:4px}",
      ".wb-terminal-col [data-dockkit-strip-tabs] > [role=\"tab\"]:has(.tp-badge){order:-2}",
      ".wb-terminal-col [data-dockkit-strip-tabs] > [data-tp-strip-break]{order:-1;flex:0 0 100%;height:0;margin:0;padding:0;pointer-events:none}",
      ".wb-terminal-col [data-dockkit-strip]:has([data-tp-strip-break]){min-height:0;height:auto;align-items:flex-start;overflow-x:hidden;overflow-y:auto}",
      ".wb-terminal-col [data-dockkit-strip-tabs][data-tp-files-collapsed=\"1\"] > [role=\"tab\"]:not(:has(.tp-badge)){display:none}",
      ".wb-terminal-col [data-dockkit-strip-tabs][data-tp-files-collapsed=\"1\"] > [data-tp-strip-break]{display:none}",
      ".wb-terminal-col [data-dockkit-strip-tabs][data-tp-files-collapsed=\"1\"]{flex-wrap:nowrap;row-gap:0;align-content:normal}",
      ".wb-terminal-col [data-dockkit-strip]:has([data-tp-files-collapsed=\"1\"]){height:36px;min-height:36px;overflow-y:hidden;align-items:center}",
      ".wb-terminal-col [data-dockkit-tab]{min-width:100px;max-width:200px}",
      ".wb-terminal-col [data-dockkit-tab] .tp-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".tp-badge{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:4px;font-size:10px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}",
      ".tp-pin{flex:none;font-size:10px;line-height:1}",
      ".tp-access{flex:none;height:16px;padding:0 5px;border-radius:5px;border:1px solid transparent;font-family:inherit;font-size:9px;line-height:14px;letter-spacing:.2px;white-space:nowrap}",
      ".tp-access-own{background:#45a9f91f;color:#45a9f9;border-color:#45a9f940}",
      ".tp-access-read{background:#ffffff10;color:#9ca3af;border-color:#ffffff1a}",
      ".tp-access-writable{background:#22c55e24;color:#4ade80;border-color:#22c55e55}",
      ".tp-access-approval{background:#f59e0b24;color:#fbbf24;border-color:#f59e0b55}",
      ".tp-access-exited{background:#ffffff0a;color:#6b7280;border-color:#ffffff14}",
      ".tp-search{position:absolute;top:8px;right:12px;z-index:5;display:flex;align-items:center;gap:4px;padding:4px 6px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#1b1b1f);box-shadow:0 8px 24px #0000003d}",
      ".tp-search-input{width:180px;height:24px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1,#3f3f46);border-radius:5px;background:transparent;color:inherit;font-size:12px;outline:none}",
      ".tp-search-btn{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:5px;background:transparent;color:inherit;font-size:12px;cursor:pointer}",
      ".tp-search-btn:hover{background:#ffffff1f}",
      ".wb-form{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:10px;background:#00000006}",
      ".wb-form-row{display:flex;align-items:center;gap:10px}",
      ".wb-form-label{flex:0 0 96px;font-size:12px;opacity:.72}",
      ".wb-form-row .wb-set-input{flex:1}",
      ".wb-set-port-inline{flex:0 0 88px !important}",
      ".wb-form-auth{display:flex;gap:6px}",
      ".wb-form-auth-btn{padding:4px 10px;border:1px solid var(--dsw-alias-border-l1,#d4d4d8);border-radius:6px;background:transparent;color:inherit;font-size:12px;cursor:pointer}",
      ".wb-form-auth-btn.is-active{background:var(--dsw-alias-brand-primary,#45a9f9);border-color:var(--dsw-alias-brand-primary,#45a9f9);color:#08131f;font-weight:600}",
      ".wb-form-step{display:flex;align-items:center;gap:8px}",
      ".wb-form-delay{flex:0 0 64px;text-align:right}",
      ".wb-form-check{display:flex;align-items:center;gap:8px;font-size:12px;opacity:.85;cursor:pointer}",
      ".wb-form-hint{font-size:11px;opacity:.5}",
      ".wb-form-primary{height:30px;padding:0 16px;border-radius:7px;border:0;background:#45a9f9;color:#08131f;font-size:12px;cursor:pointer}",
      ".wb-form-cancel{height:30px;padding:0 14px;border-radius:7px;border:1px solid #0000001a;background:transparent;font-size:12px;cursor:pointer;opacity:.8}",
      /* 端口转发编辑器：一行一条，窄屏下自动换行（不横向溢出）。 */
      ".wb-form-row-block{align-items:flex-start}",
      ".wb-fwd-list{display:flex;flex-direction:column;gap:5px;flex:1;min-width:0}",
      ".wb-fwd-item{display:flex;align-items:center;gap:5px;min-width:0;flex-wrap:wrap}",
      ".wb-fwd-type{flex:none;height:26px;padding:0 4px;border:1px solid var(--dsw-alias-border-l1,#d4d4d8);border-radius:6px;background:transparent;color:inherit;font-size:12px}",
      ".wb-fwd-item>.wb-set-input{flex:1 1 120px;min-width:0}",
      ".wb-fwd-note{flex:1;font-size:11px;opacity:.45}",
      ".wb-fwd-del{flex:none;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;font-size:15px;line-height:1;opacity:.5;cursor:pointer}",
      ".wb-fwd-del:hover{opacity:1;background:#ef44441a;color:#ef4444}",
      ".wb-fwd-add{align-self:flex-start;height:24px;padding:0 8px;font-size:11px}",
      ".wb-set-sub{font-size:11px;opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".tp-quick-label{flex:0 1 160px;min-width:86px;max-width:160px;height:30px;padding:0 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;outline:none}",
      ".tp-quick-label option{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}",
      ".wb-form-actions{display:flex;gap:6px;padding-top:4px}",
      ".wb-set-btn-ghost{height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,#d4d4d8);border-radius:6px;background:transparent;color:inherit;font-size:12px;cursor:pointer}",
      ".wb-set-groups{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}",
      ".wb-set-group-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 8px;border-radius:6px;background:#00000006}",
      ".wb-set-groupblock{display:flex;flex-direction:column;gap:4px}",
      ".wb-set-groupname{display:flex;align-items:center;gap:6px;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#9ca3af);font-size:11px;font-weight:600;padding:2px 2px 0;cursor:pointer;font-family:inherit;text-align:left}\n.wb-set-groupname:hover{color:var(--dsw-alias-label-primary,#111827)}",
      ".wb-set-actions{display:flex;gap:4px}",
      ".wb-set-edit{border:0;border-radius:6px;padding:4px 8px;background:transparent;color:inherit;font-size:11px;cursor:pointer;opacity:.75}",
      ".wb-set-edit:hover{background:#00000014;opacity:1}",
      ".wb-set-select{flex:0 0 96px;height:26px;padding:0 4px;border:1px solid var(--dsw-alias-border-l1,#d4d4d8);border-radius:6px;background:transparent;color:inherit;font-size:12px}",
      ".wb-set-bookmark-edit{flex-wrap:wrap}",
      ".wb-pop-groupname{display:flex;align-items:center;gap:6px;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#9ca3af);padding:6px 10px 2px;font-size:12px;text-align:left;cursor:pointer;font-family:inherit}\n.wb-pop-groupname:hover{color:var(--dsw-alias-label-primary,#111827)}\n.wb-pop-caret{width:10px;flex:none;opacity:.7;font-size:11px}\n.wb-pop-count{margin-left:auto;opacity:.5;font-variant-numeric:tabular-nums}",
      ".wb-set-bookmarks{display:flex;flex-direction:column;gap:6px;margin-bottom:8px}",
      ".wb-set-bookmark{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 8px;border-radius:8px;background:#00000008}",
      ".wb-set-del{border:0;border-radius:6px;padding:4px 8px;background:transparent;color:var(--dsw-alias-state-error-primary,#e5484d);font-size:11px;cursor:pointer}",
      ".wb-set-del:hover{background:#e5484d1f}",
      ".wb-set-add{display:flex;gap:6px;align-items:center}",
      ".wb-set-input{flex:1;min-width:0;height:26px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1,#d4d4d8);border-radius:6px;background:transparent;color:inherit;font-size:12px}",
      ".wb-set-port{flex:0 0 54px}",
      ".wb-set-add-btn{flex:none;height:26px;padding:0 10px;border:0;border-radius:6px;background:#45a9f9;color:#08131f;font-size:12px;font-weight:600;cursor:pointer}",
      ".wb-set-add-btn:disabled{opacity:.45;cursor:not-allowed}",
      ".tp-copy-tip{position:absolute;right:14px;bottom:52px;z-index:7;padding:4px 10px;border-radius:12px;background:var(--dsw-alias-state-success-primary,#16a34ad9);color:#f0fff4;font-size:12px;line-height:18px;pointer-events:none;box-shadow:0 6px 18px #0000004d;animation:tp-tip-in 160ms ease-out}",
      ".tp-copy-tip[data-tp-notice]{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;line-height:1.5;pointer-events:auto}",
      ".tp-copy-tip[data-tp-notice=error]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
      "@keyframes tp-tip-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}",
      ".tp-quickbar{flex:none;box-sizing:border-box;display:flex;align-items:flex-start;align-content:flex-start;flex-wrap:wrap;gap:8px 10px;height:56px;min-height:34px;padding:8px 14px;background:var(--tp-surface,#121214);overflow-x:hidden;overflow-y:auto;white-space:normal}",
      ".tp-quickbar-handle{flex:none;height:6px;cursor:ns-resize;background:transparent;border-top:1px solid #ffffff14}",
      ".tp-quickbar-handle:hover{background:#3b82f659}",
      ".tp-quickbar-label{flex:0 0 auto;align-self:center;font-size:12px;opacity:.5;letter-spacing:0}",
      ".tp-quick-chip{flex:1 1 120px;min-width:72px;max-width:240px;min-height:30px;height:auto;padding:6px 12px;border:1px solid #ffffff1f;border-radius:8px;background:#ffffff0a;color:#d8d8dc;font-size:13px;line-height:1.25;white-space:normal;overflow-wrap:anywhere;cursor:pointer;overflow:hidden;text-overflow:ellipsis}",
      ".tp-quick-chip:hover{background:#ffffff1a;border-color:#ffffff33;color:#ffffff}",
      ".tp-quick-chip:disabled{opacity:.45;cursor:not-allowed}",
      ".tp-quick-progress{height:auto;min-height:36px;white-space:normal;flex-wrap:wrap;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border-block:1px solid var(--dsw-alias-border-l1);font-size:12px}",
      ".tp-quick-progress .tp-quick-chip{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}",
      ".wb-set-backdrop{position:fixed;inset:0;z-index:1300;display:flex;align-items:center;justify-content:center;background:#00000059}",
      ".wb-set-panel{width:420px;max-width:calc(100vw - 32px);max-height:calc(100vh - 64px);overflow:auto;padding:14px 16px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 24px 60px #0000003d;color:var(--dsw-alias-label-primary,#111827);font-size:13px}",
      ".wb-set-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}",
      ".wb-set-title{font-size:14px;font-weight:600}",
      ".wb-set-close{width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:inherit;font-size:16px;cursor:pointer}",
      ".wb-set-close:hover{background:#00000014}",
      ".wb-set-group{margin:12px 0 6px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;opacity:.55}",
      /* 设置页分组收纳：每组是一个抽屉。标题行整行可点，右侧摘要显示条数，
         折叠状态记在 localStorage（key 见 SET_SECTIONS_KEY）。 */
      ".wb-set-sec{border-bottom:1px solid #00000010}",
      ".wb-set-sec-head{display:flex;align-items:center;gap:6px;width:100%;padding:9px 0;border:0;background:transparent;color:inherit;font:inherit;font-size:11px;letter-spacing:.04em;text-transform:uppercase;opacity:.85;cursor:pointer;text-align:left}",
      ".wb-set-sec-head:hover{opacity:1}",
      ".wb-set-sec-caret{flex:none;font-size:9px;opacity:.6;transition:transform .15s ease}",
      ".wb-set-sec[data-open='1'] .wb-set-sec-caret{transform:rotate(90deg)}",
      ".wb-set-sec-title{flex:1;min-width:0}",
      ".wb-set-sec-sum{flex:none;font-size:11px;letter-spacing:0;text-transform:none;opacity:.55}",
      ".wb-set-sec-body{padding-bottom:4px}",
      ".wb-set-sec[data-open='0'] .wb-set-sec-body{display:none}",
      ".wb-set-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #00000010}",
      ".wb-set-text{display:flex;flex-direction:column;gap:2px}",
      ".wb-set-label{font-size:13px}",
      ".wb-set-hint{font-size:11px;opacity:.6}",
      ".wb-set-number{width:72px;height:26px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1,#d4d4d8);border-radius:6px;background:transparent;color:inherit;font-size:13px}",
      ".wb-set-check{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary,#45a9f9)}",
      ".wb-set-select{width:168px;height:26px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1,#d4d4d8);border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font-size:13px}",
      ".wb-set-foot{margin-top:12px;font-size:11px;opacity:.55}",
      ".wb-tabmenu{position:fixed;z-index:1200;min-width:168px;padding:6px;display:flex;flex-direction:column;gap:2px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--tp-surface,#121214);box-shadow:0 10px 30px #0000002b}",
      ".wb-menu-item{display:flex;align-items:center;width:100%;padding:6px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#111827);font-size:12px;text-align:left;cursor:pointer;font:inherit}",
      ".wb-menu-item:hover{background:var(--dsw-alias-bg-layer-2,#f3f4f6)}",
      ".wb-pop-webrow{display:flex;gap:6px;align-items:center}",
      ".wb-pop-webrow .wb-pop-input{flex:1;min-width:0}",
      ".wb-web{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#fff)}",
      ".wb-web-bar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#f9fafb)}",
      ".wb-web-btn{flex:0 0 auto;padding:4px 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l1,#e5e7eb);background:transparent;color:var(--dsw-alias-label-primary,#111827);cursor:pointer;font-size:12px;line-height:1.2;text-decoration:none}",
      ".wb-web-btn:hover{background:var(--dsw-alias-bg-layer-2,#f3f4f6)}",
      ".wb-web-input{flex:1;min-width:0;padding:5px 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111827);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;outline:none}",
      ".wb-web-input:focus{border-color:var(--dsw-alias-brand-primary,#4f6ef2)}",
      ".wb-web-hint{padding:4px 8px;font-size:11px;color:var(--dsw-alias-label-secondary,#9ca3af);border-bottom:.5px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#f9fafb)}",
      ".wb-web-frame{flex:1;width:100%;min-height:0;border:0;background:#fff}",
      ".wb-web-empty{flex:1;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;color:var(--dsw-alias-label-secondary,#9ca3af);font-size:13px}",
      /* ---------- 相机标签（v0.10.0） ----------
         画面由宿主代理转成同源 MJPEG；这里只负责显示与编辑书签参数。 */
      ".wb-cam{display:flex;flex-direction:column;height:100%;min-height:0;background:#0b0b0d;color:#e5e7eb}",
      ".wb-cam-bar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:.5px solid #ffffff14;background:#141417}",
      ".wb-cam-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}",
      ".wb-cam-dot{width:7px;height:7px;border-radius:50%;background:#34d399;flex:none}",
      ".wb-cam-dot[data-state=connecting],.wb-cam-dot[data-state=loading]{background:#fbbf24;animation:tp-ssh-blink 1.2s steps(2) infinite}",
      ".wb-cam-dot[data-state=error]{background:#f87171}",
      ".wb-cam-dot[data-state=paused]{background:#6b7280}",
      ".wb-cam-btn{flex:none;padding:3px 8px;border-radius:6px;border:.5px solid #ffffff26;background:transparent;color:#e5e7eb;cursor:pointer;font-size:11px;line-height:1.4}",
      ".wb-cam-btn:hover{background:#ffffff12}",
      ".wb-cam-view{position:relative;flex:1;min-height:0;background:#000;overflow:hidden}",
      ".wb-cam-view[data-fullscreen='1']{position:fixed;inset:0;z-index:9999;background:#000;border-radius:0}",
      ".wb-cam-view:fullscreen{width:100vw;height:100vh}",
      ".wb-cam-view:fullscreen::backdrop{background:#000}",
      ".wb-cam-stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden}",
      ".wb-cam-img{width:100%;height:100%;object-fit:contain;display:block}",
      ".wb-cam-view[data-fit=cover] .wb-cam-img{object-fit:cover}",
      ".wb-cam-player-host{position:absolute;inset:0;background:#000}",
      ".wb-cam-player{position:absolute;inset:0;display:block}",
      ".wb-cam-player video{width:100%;height:100%;object-fit:contain;display:block;background:#000}",
      ".wb-cam-view[data-fit=cover] .wb-cam-player video{object-fit:cover}",
      ".wb-cam-meta{flex:none;font-size:10px;color:#8b93a1;font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".wb-cam-tools{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);display:flex;align-items:center;gap:4px;padding:5px 6px;border-radius:999px;border:.5px solid #ffffff24;background:#111114d9;backdrop-filter:blur(8px);opacity:0;pointer-events:none;transition:opacity .16s ease;z-index:3;max-width:calc(100% - 16px)}",
      ".wb-cam-view:hover .wb-cam-tools,.wb-cam-view:focus-within .wb-cam-tools,.wb-cam-view[data-paused='1'] .wb-cam-tools,.wb-cam-view[data-fullscreen='1'] .wb-cam-tools{opacity:1;pointer-events:auto}",
      ".wb-cam-tool{flex:none;padding:4px 8px;border-radius:999px;border:0;background:transparent;color:#e5e7eb;cursor:pointer;font-size:11px;line-height:1.3}",
      ".wb-cam-tool:hover{background:#ffffff1a}",
      ".wb-cam-toast{position:absolute;left:50%;top:10px;transform:translateX(-50%);padding:4px 10px;border-radius:999px;background:#111114e6;border:.5px solid #ffffff24;color:#d1d5db;font-size:11px;z-index:4;pointer-events:none;white-space:nowrap}",
      ".wb-cam-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:16px;text-align:center;background:#000000b8;font-size:12px;color:#9ca3af}",
      ".wb-cam-overlay[data-kind=error]{color:#ff9d9d}",
      ".wb-cam-overlay .wb-cam-btn{border-color:#ffffff40;color:inherit}",
      ".wb-cam-form{flex:1;min-height:0;overflow:auto;padding:10px 12px;background:#121214}",
      ".wb-cam-row{display:flex;align-items:center;gap:8px;padding:4px 0}",
      ".wb-cam-label{width:74px;flex:none;font-size:12px;color:#9ca3af}",
      ".wb-cam-input{flex:1;min-width:0;padding:5px 8px;border-radius:6px;border:.5px solid #ffffff1f;background:#0b0b0d;color:#e5e7eb;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;outline:none}",
      ".wb-cam-input:focus{border-color:#4f6ef2}",
      ".wb-cam-select{flex:1;min-width:0;padding:5px 8px;border-radius:6px;border:.5px solid #ffffff1f;background:#0b0b0d;color:#e5e7eb;font-size:12px;outline:none}",
      ".wb-cam-actions{display:flex;gap:6px;flex-wrap:wrap;padding-top:10px}",
      ".wb-cam-action{padding:5px 10px;border-radius:6px;border:.5px solid #ffffff26;background:transparent;color:#e5e7eb;cursor:pointer;font-size:12px}",
      ".wb-cam-action:hover{background:#ffffff12}",
      ".wb-cam-action[data-primary]{border-color:#4f6ef2;color:#93b4ff}",
      ".wb-cam-action[data-danger]{border-color:#5c2b2b;color:#ff9d9d}",
      ".wb-cam-hint{padding-top:8px;font-size:11px;line-height:1.55;color:#9ca3af}",
      ".wb-cam-check{flex:1;min-width:0;display:flex;align-items:center;gap:6px;font-size:12px;color:#d4d4d8;cursor:pointer}",
      ".wb-cam-check input{flex:none;accent-color:#4f6ef2}",
      ".wb-cam-owner{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;font-size:12px;color:#d4d4d8}",
      ".wb-cam-owner-hint{font-size:11px;line-height:1.45;color:#8b93a1}",
      ".wb-cam-group-hint{padding:0 0 4px 82px;font-size:11px;line-height:1.5;color:#8b93a1}",
      ".wb-cam-presets{display:flex;gap:6px;flex-wrap:wrap;padding:2px 0 4px 82px}",
      ".wb-cam-preset{padding:2px 8px;border-radius:999px;border:.5px solid #ffffff26;background:transparent;color:#9ca3af;cursor:pointer;font-size:11px}",
      ".wb-cam-preset:hover{color:#e5e7eb;border-color:#ffffff4d}",
      ".wb-cam-preset[disabled]{opacity:.55;cursor:default}",
      ".wb-pop-camlist{display:flex;flex-direction:column;gap:1px;max-height:180px;overflow:auto}",
      ".wb-pop-camitem{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;border:0;background:transparent;color:inherit;cursor:pointer;font-size:13px;text-align:left}",
      ".wb-pop-camitem:hover{background:var(--dsw-alias-bg-layer-2,#f3f4f6)}",
      ".wb-pop-camitem .wb-pop-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      /* 相机悬浮按钮：x 固定在终端/主区分界线上，y 可上下拖动。 */
      ".wb-cam-fab{position:absolute;z-index:30;transform:translate(-50%,-50%);width:38px;height:38px;padding:0;border-radius:50%;border:1px solid var(--dsw-alias-border-l2,#2c2c2e);background:var(--tp-surface,#121214);color:var(--dsw-alias-label-primary,#e5e7eb);display:flex;align-items:center;justify-content:center;cursor:grab;box-shadow:0 8px 22px rgba(0,0,0,.5);touch-action:none;user-select:none}",
      ".wb-cam-fab:hover{border-color:var(--dsw-alias-brand-primary,#4f6ef2);color:var(--dsw-alias-brand-primary,#4f6ef2)}",
      ".wb-cam-fab[data-open]{border-color:var(--dsw-alias-brand-primary,#4f6ef2);color:var(--dsw-alias-brand-primary,#4f6ef2);box-shadow:0 0 0 3px rgba(79,110,242,.18),0 8px 22px rgba(0,0,0,.5)}",
      ".wb-cam-fab svg{width:19px;height:19px;pointer-events:none}",
      ".wb-cam-fab-panel{position:fixed;z-index:1001;box-sizing:border-box;max-height:calc(100vh - 16px);overflow:auto;display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,#2c2c2e);background:var(--tp-surface,#121214);box-shadow:0 18px 48px rgba(0,0,0,.6);color:var(--dsw-alias-label-primary,#e5e7eb)}",
      ".wb-cam-fab-head{display:flex;align-items:center;gap:8px}",
      ".wb-cam-fab-head svg{width:16px;height:16px;flex:none;color:#38bdf8}",
      ".wb-cam-fab-title{flex:1;font-size:13px;font-weight:600}",
      ".wb-cam-fab-close{width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:16px;line-height:1}",
      ".wb-cam-fab-close:hover{background:#ffffff14}",
      ".wb-cam-fab-ip{display:flex;align-items:center;gap:5px}",
      ".wb-cam-fab-prefix,.wb-cam-fab-octet{box-sizing:border-box;height:30px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l1,#3f3f46);background:#00000033;color:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;outline:none;padding:0 8px}",
      ".wb-cam-fab-prefix{flex:1;min-width:0}",
      ".wb-cam-fab-octet{width:58px;flex:none;text-align:center}",
      ".wb-cam-fab-prefix:focus,.wb-cam-fab-octet:focus{border-color:var(--dsw-alias-brand-primary,#4f6ef2)}",
      ".wb-cam-fab-open{flex:none;height:30px;padding:0 12px;border-radius:7px;border:0;background:#38bdf8;color:#06121c;font-size:12px;font-weight:600;cursor:pointer}",
      ".wb-cam-fab-open:hover{background:#7dd3fc}",
      ".wb-cam-fab-meta{font-size:11px;line-height:1.5;color:#9ca3af;display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".wb-cam-fab-meta b{color:#e5e7eb;font-weight:600}",
      ".wb-cam-fab-reset{padding:0;border:0;background:transparent;color:#93b4ff;cursor:pointer;font-size:11px}",
      ".wb-cam-fab-section{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#9ca3af;padding-top:2px}",
      ".wb-cam-fab-list{display:flex;flex-direction:column;gap:1px}",
      ".wb-cam-fab-item{display:flex;align-items:center;gap:8px;padding:5px 7px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:12px;text-align:left}",
      ".wb-cam-fab-item:hover{background:#ffffff12}",
      ".wb-cam-fab-host{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#7dd3fc;flex:none}",
      ".wb-cam-fab-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.78}",
      ".wb-cam-fab-notice{font-size:11px;line-height:1.45;color:#fbbf24}",
      ".wb-cam-fab-hint{font-size:10px;line-height:1.45;color:#6b7280;border-top:1px solid #ffffff14;padding-top:7px}",
      ".wb-overlay{z-index:20;pointer-events:none;position:absolute;inset:0}",
      ".wb-overlay>*{pointer-events:auto}"
    ].join("");

    /* ---------- 列容器 ---------- */

    var Fragment = jsxRuntime.Fragment

    var KIND = 'terminal'
    /* 网页标签：和终端共用右栏 dock，只是内容换成 iframe。 */
    var WEB_KIND = 'web'
    var WEB_TYPE_ID = 'dsh-terminal-web'
    /* 相机标签：RTSP 走宿主 go2rtc 转 WebSocket，MJPEG/快照是兼容模式。 */
    var CAMERA_KIND = 'camera'
    var CAMERA_TYPE_ID = 'dsh-terminal-camera'
    var CAMERA_STORE_KEY = 'dsh-terminal-workbench.cameras'
    var CAMERA_EVENT = 'dsh-terminal-workbench:cameras'
    var CAMERA_API = '/__dsh-terminal-workbench/camera'
    var CAMERA_DEFAULT_RTSP_PATH = '/axis-media/media.amp?videocodec=h264'
    /* 吊具相机走 Axis 的第 5 路（现场一拖四 .34 主机）。 */
    var CAMERA_DEFAULT_SPREADER_RTSP_PATH = '/axis-media/media.amp?videocodec=h264&camera=5'
    /* 韩华大车相机：profile3 主码流。 */
    var CAMERA_DEFAULT_HANWHA_RTSP_PATH = '/profile3/media.smp'
    var CAMERA_DEFAULT_MJPEG_PATH = '/axis-cgi/mjpg/video.cgi?fps=15'
    var CAMERA_DEFAULT_PATH = CAMERA_DEFAULT_RTSP_PATH
    var CAMERA_DEFAULT_SNAPSHOT = '/axis-cgi/jpg/image.cgi'
    var CAMERA_RTSP_PORT = 554
    var CAMERA_FIT_KEY = 'dsh-terminal-workbench.cameraFit'
    /* 相机密码组：同车普通相机 / 同项目吊具相机各一组，改一次全组生效。 */
    var CAMERA_PASSWORD_GROUPS_KEY = 'dsh-terminal-workbench.cameraPasswordGroups'
    /* 悬浮相机按钮：x 跟随终端/主区分界线，y 可拖动；前缀取当前 SSH 终端网段。 */
    var CAMERA_PREFIX_KEY = 'dsh-terminal-workbench.cameraPrefix'
    var CAMERA_FLOAT_Y_KEY = 'dsh-terminal-workbench.cameraFloatY'
    var CAMERA_FAB_SIZE = 38
    var CAMERA_FAB_PANEL_WIDTH = 300
    /* RTSP 播放器（go2rtc 的 VideoRTC）同源加载一次，多个相机标签共用。 */
    var RTSP_PLAYER_TAG = 'twb-camera-rtc'
    var RTSP_PLAYER_PROMISE = null
    /* 新建相机标签时，标签创建和首次渲染之间没有可靠的参数通道：
       和网页地址一样，先放一份待领 id。 */
    var PENDING_CAMERA_ID = ''
    var CAMERA_CACHE = null
    /* 构建版本戳：自测用它判断浏览器加载的是否为磁盘上的最新构建。
       每次实质性改动手动 bump，避免拿旧产物当证据。 */
    var BUILD_STAMP = '2026-11-15.02'
    var FILES_COLLAPSED_KEY = 'dsh-terminal-workbench.fileRowCollapsed'

    function readFilesCollapsed() {
      try {
        return window.localStorage.getItem(FILES_COLLAPSED_KEY) === '1'
      } catch (error) {
        return false
      }
    }

    function writeFilesCollapsed(value) {
      try {
        window.localStorage.setItem(FILES_COLLAPSED_KEY, value ? '1' : '0')
      } catch (error) {
        /* 存不下只影响下次打开 */
        console.warn('[terminal-workbench] 存不下只影响下次打开：', error)
      }
    }

    /**
     * 把地址栏输入整理成可用的 URL。
     * - 已有 http(s) 协议：原样返回；
     * - localhost / 127.0.0.1：补 http://；
     * - 像域名的（含点、无空格）：补 https://；
     * - 其余当搜索词，走 Bing。
     */
    function normalizeWebUrl(value) {
      var text = typeof value === 'string' ? value.trim() : ''
      if (text === '') return ''
      if (/^https?:\/\//i.test(text)) return text
      if (/^localhost(:\d+)?(\/|$)/i.test(text) || /^127\.0\.0\.1(:\d+)?(\/|$)/.test(text)) return 'http://' + text
      if (/^[\w.-]+(:\d+)?(\/|$)/.test(text) && text.indexOf('.') !== -1 && text.indexOf(' ') === -1) return 'https://' + text
      return 'https://www.bing.com/search?q=' + encodeURIComponent(text)
    }

    /** 主输入框里像网址的输入直接开网页标签，而不是当 shell 命令跑。 */
    function looksLikeUrl(value) {
      var text = typeof value === 'string' ? value.trim() : ''
      return /^https?:\/\//i.test(text) || /^www\./i.test(text) || /^localhost(:\d+)?(\/|$)/i.test(text) || /^127\.0\.0\.1(:\d+)?(\/|$)/.test(text)
    }

    /* 网页地址按「会话 + 标签」落到 localStorage：导航参数只在内存里，
       刷新后靠这份副本恢复地址栏与 iframe。 */
    var WEB_URL_EVENT = 'dsh-terminal-workbench:web-url'
    /* 刚点「打开」时的地址。标签创建和首次渲染之间没有可靠的参数通道，
       由新建的网页标签自己领走一次。 */
    var PENDING_WEB_URL = ''
    var WEB_URL_CACHE = Object.create(null)
    var WEB_URL_LISTENERS = new Set()

    function webUrlKey(sessionId, tabId) {
      return 'dsh-terminal-workbench.webUrl.' + String(sessionId) + '.' + String(tabId)
    }

    function readStoredWebUrl(sessionId, tabId) {
      var key = webUrlKey(sessionId, tabId)
      if (typeof WEB_URL_CACHE[key] === 'string') return WEB_URL_CACHE[key]
      try {
        return window.localStorage.getItem(key) || ''
      } catch (error) {
        return ''
      }
    }

    function storeWebUrl(sessionId, tabId, url) {
      var key = webUrlKey(sessionId, tabId)
      WEB_URL_CACHE[key] = url
      try {
        window.localStorage.setItem(key, url)
      } catch (error) {
        /* 存不下只影响刷新恢复 */
      }
      WEB_URL_LISTENERS.forEach(function (listener) {
        try {
          listener(key, url)
        } catch (error) {
          /* 单个订阅者出错不影响其它标题 */
        }
      })
      try {
        window.dispatchEvent(
          new CustomEvent(WEB_URL_EVENT, {
            detail: { sessionId: sessionId, tabId: tabId, url: url },
          }),
        )
      } catch (error) {
        /* 事件只用于跨组件通知 */
      }
    }

    function subscribeWebUrl(listener) {
      WEB_URL_LISTENERS.add(listener)
      return function () {
        WEB_URL_LISTENERS.delete(listener)
      }
    }

    /** 标签关闭：连同持久化的地址一起清掉，别在 localStorage 里留垃圾。 */
    function forgetWebUrl(sessionId, tabId) {
      var key = webUrlKey(sessionId, tabId)
      delete WEB_URL_CACHE[key]
      try {
        window.localStorage.removeItem(key)
      } catch (error) {
        /* 删不掉只影响存储体积 */
      }
    }

    /* ---------- 相机密码组（v0.13.1） ----------
       现场规则：
       - 同一台车的普通相机密码相同；
       - 同一项目不同车的吊具相机密码相同。
       书签只记归属（车号 / 项目 / 是否吊具）和一个组 key，
       密码集中放在组里；改一次组密码，全组相机生效。
       组密码和书签一样只存在浏览器 localStorage。 */
    function cameraPasswordGroupKey(record) {
      if (record === null || typeof record !== 'object') return ''
      var project = String(record.project ?? '').trim()
      var vehicle = String(record.vehicle ?? '').trim()
      if (record.spreader === true) {
        return project === '' ? '' : 'project:' + project + ':spreader'
      }
      return vehicle === '' ? '' : 'vehicle:' + vehicle
    }

    function cameraPasswordGroupLabel(key) {
      var text = String(key ?? '')
      if (text.indexOf('vehicle:') === 0) return '车号 ' + text.slice('vehicle:'.length)
      if (text.indexOf('project:') === 0 && text.slice(-':spreader'.length) === ':spreader') {
        return '项目 ' + text.slice('project:'.length, -':spreader'.length) + ' · 吊具'
      }
      return ''
    }

    function normalizeCameraPasswordGroup(raw) {
      if (raw === null || typeof raw !== 'object') return null
      var password = String(raw.password ?? '')
      if (password === '') return null
      return { user: String(raw.user ?? '').trim(), password: password }
    }

    function readCameraPasswordGroups() {
      try {
        var raw = JSON.parse(window.localStorage.getItem(CAMERA_PASSWORD_GROUPS_KEY) ?? '{}')
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
        var groups = {}
        Object.keys(raw).forEach(function (key) {
          var group = normalizeCameraPasswordGroup(raw[key])
          if (group !== null) groups[key] = group
        })
        return groups
      } catch (error) {
        return {}
      }
    }

    function writeCameraPasswordGroups(groups) {
      var next = {}
      var source = groups !== null && typeof groups === 'object' ? groups : {}
      Object.keys(source).forEach(function (key) {
        var group = normalizeCameraPasswordGroup(source[key])
        if (group !== null) next[key] = group
      })
      try {
        window.localStorage.setItem(CAMERA_PASSWORD_GROUPS_KEY, JSON.stringify(next))
      } catch (error) {
        /* 存不下只影响下次打开 */
      }
      /* 通知同页其它相机标签：组密码变了，重新解析凭证并重连。 */
      try {
        window.dispatchEvent(new CustomEvent(CAMERA_EVENT))
      } catch (error) {
        /* 事件只用于同页通知 */
      }
      return next
    }

    /**
     * 解析相机实际使用的账号密码：绑定密码组时以组为准。
     * 返回 groupKey / groupLabel 供 UI 提示；密码只在这里解密，不参与展示。
     */
    function resolveCameraCredentials(camera) {
      var record = camera !== null && typeof camera === 'object' ? camera : {}
      var key = cameraPasswordGroupKey(record)
      var group = key === '' ? undefined : readCameraPasswordGroups()[key]
      if (group === undefined) {
        return {
          user: String(record.user ?? ''),
          password: String(record.password ?? ''),
          groupKey: '',
          groupLabel: '',
        }
      }
      return {
        user: group.user !== '' ? group.user : String(record.user ?? ''),
        password: group.password,
        groupKey: key,
        groupLabel: cameraPasswordGroupLabel(key),
      }
    }

    /**
     * 保存前的密码组处理（无交互）：
     * - 填了新密码：写入组，书签不再重复存密码；
     * - 留空且组已存在：复用组密码；
     * - 留空且组不存在：保持空密码，由调用方提示。
     * 返回 { record, groupKey, updated, reused }。
     */
    function applyCameraPasswordGroup(record) {
      var next = Object.assign({}, record)
      var key = cameraPasswordGroupKey(next)
      next.passwordGroup = key
      if (key === '') return { record: next, groupKey: '', updated: false, reused: false }
      var groups = readCameraPasswordGroups()
      var existing = groups[key]
      var typed = String(next.password ?? '')
      if (typed !== '') {
        groups[key] = { user: String(next.user ?? '').trim(), password: typed }
        writeCameraPasswordGroups(groups)
        next.password = ''
        return {
          record: next,
          groupKey: key,
          updated: existing !== undefined && existing.password !== typed,
          reused: false,
        }
      }
      if (existing !== undefined) {
        next.password = ''
        if (String(next.user ?? '').trim() === '' || next.user === 'root') {
          next.user = existing.user !== '' ? existing.user : next.user
        }
        return { record: next, groupKey: key, updated: false, reused: true }
      }
      return { record: next, groupKey: key, updated: false, reused: false }
    }

    /* ---------- 相机书签（v0.10.0） ----------
       相机书签就是一条普通数据：IP、端口、账号、流路径、模式。
       用户或大模型都可以填；插件只负责把流取回来播放。
       密码和 SSH 书签一样存在浏览器 localStorage，不上传。 */
    function cameraDefaultRtspPath(spreader) {
      return spreader === true ? CAMERA_DEFAULT_SPREADER_RTSP_PATH : CAMERA_DEFAULT_RTSP_PATH
    }

    function normalizeCamera(raw) {
      if (raw === null || typeof raw !== 'object') return null
      var host = String(raw.host ?? '').trim()
      if (host === '') return null
      var modeText = String(raw.mode ?? '').toLowerCase()
      var mode = modeText === 'mjpeg' || modeText === 'snapshot' ? modeText : 'rtsp'
      var port = Number(raw.port)
      var fallbackPort = mode === 'rtsp' ? CAMERA_RTSP_PORT : 80
      var vehicle = String(raw.vehicle ?? '').trim()
      var project = String(raw.project ?? '').trim()
      var spreader = raw.spreader === true || raw.spreader === 1 || raw.spreader === 'true'
      var path = String(raw.path ?? '').trim()
      if (path === '') {
        path =
          mode === 'rtsp'
            ? cameraDefaultRtspPath(spreader)
            : CAMERA_DEFAULT_MJPEG_PATH
      }
      return {
        id:
          typeof raw.id === 'string' && raw.id !== ''
            ? raw.id
            : 'cam-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        name: String(raw.name ?? '').trim(),
        host: host,
        port: Number.isFinite(port) && port >= 1 && port <= 65535 ? port : fallbackPort,
        scheme: String(raw.scheme ?? '').toLowerCase() === 'https' ? 'https' : 'http',
        user: String(raw.user ?? ''),
        password: String(raw.password ?? ''),
        path: path,
        snapshotPath: String(raw.snapshotPath ?? '').trim(),
        mode: mode,
        /* 密码组归属：普通相机按车号，吊具相机按项目。 */
        vehicle: vehicle,
        project: project,
        spreader: spreader,
        /* 来源 SSH 书签：有它就一直跟随书签标题/分组，而不是只记创建时的快照。 */
        terminalBookmarkId: String(raw.terminalBookmarkId ?? '').trim(),
        passwordGroup: cameraPasswordGroupKey({ vehicle: vehicle, project: project, spreader: spreader }),
      }
    }

    function readCameras() {
      if (CAMERA_CACHE !== null) return CAMERA_CACHE.slice()
      var list = readRawCameras()
      var map = cameraTerminalBookmarkMap()
      list = list.map(function (record) {
        return hydrateCameraTerminalOwner(record, map)
      })
      CAMERA_CACHE = list
      return list.slice()
    }

    function writeCameras(list) {
      var next = (Array.isArray(list) ? list : [])
        .map(normalizeCamera)
        .filter(function (item) { return item !== null })
        .slice(0, 100)
      CAMERA_CACHE = next
      try {
        window.localStorage.setItem(CAMERA_STORE_KEY, JSON.stringify(next))
      } catch (error) {
        /* 存不下只影响下次打开 */
      }
      try {
        window.dispatchEvent(new CustomEvent(CAMERA_EVENT))
      } catch (error) {
        /* 事件只用于同页通知 */
      }
    }

    /** 丢掉模块级缓存，下次读取重新解析 localStorage。 */
    function resetCameraCache() {
      CAMERA_CACHE = null
    }

    function cameraById(id) {
      if (typeof id !== 'string' || id === '') return undefined
      return readCameras().filter(function (item) { return item.id === id })[0]
    }

    function upsertCamera(record) {
      var normalized = normalizeCamera(record)
      if (normalized === null) return undefined
      var list = readCameras()
      var exists = list.some(function (item) { return item.id === normalized.id })
      writeCameras(
        exists
          ? list.map(function (item) { return item.id === normalized.id ? normalized : item })
          : list.concat([normalized]),
      )
      return normalized
    }

    function removeCamera(id) {
      writeCameras(readCameras().filter(function (item) { return item.id !== id }))
    }

    function blankCamera(host, defaults) {
      var text = typeof host === 'string' ? host.trim() : ''
      var source = defaults !== null && typeof defaults === 'object' ? defaults : {}
      var vehicle = String(source.vehicle ?? '').trim()
      var project = String(source.project ?? '').trim()
      var spreader = source.spreader === true
      return {
        id: 'cam-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        name: text,
        host: text,
        port: CAMERA_RTSP_PORT,
        scheme: 'http',
        user: 'root',
        password: '',
        path: cameraDefaultRtspPath(spreader),
        snapshotPath: '',
        mode: 'rtsp',
        vehicle: vehicle,
        project: project,
        spreader: spreader,
        terminalBookmarkId: String(source.terminalBookmarkId ?? '').trim(),
        passwordGroup: cameraPasswordGroupKey({ vehicle: vehicle, project: project, spreader: spreader }),
      }
    }

    /** 每个相机书签记住「适应 / 铺满」的选择，刷新后保持。 */
    function readCameraFit(cameraId) {
      try {
        var raw = JSON.parse(window.localStorage.getItem(CAMERA_FIT_KEY) ?? '{}')
        return raw !== null && typeof raw === 'object' && raw[String(cameraId)] === 'cover'
          ? 'cover'
          : 'contain'
      } catch (error) {
        return 'contain'
      }
    }

    function writeCameraFit(cameraId, fit) {
      if (typeof cameraId !== 'string' || cameraId === '') return
      try {
        var raw = JSON.parse(window.localStorage.getItem(CAMERA_FIT_KEY) ?? '{}')
        var next = raw !== null && typeof raw === 'object' ? raw : {}
        next[String(cameraId)] = fit === 'cover' ? 'cover' : 'contain'
        window.localStorage.setItem(CAMERA_FIT_KEY, JSON.stringify(next))
      } catch (error) {
        /* 存不下只影响下次打开 */
      }
    }

    function cameraLabel(camera) {
      if (camera === undefined || camera === null) return '相机'
      return camera.name || camera.host || '相机'
    }

    /**
     * 从流路径猜主/子码流，只用于顶栏提示。
     * 海康 /Streaming/Channels/102、大华 subtype=1 是子码流，码率低、更流畅。
     */
    function cameraStreamLabel(camera) {
      if (camera === undefined || camera === null) return ''
      var path = String(camera.path || '')
      if (/\/Streaming\/Channels\/\d*02(?:[?&]|$)/.test(path)) return '子码流'
      if (/\/Streaming\/Channels\/\d*01(?:[?&]|$)/.test(path)) return '主码流'
      if (/[?&]subtype=1(?:&|$)/.test(path)) return '子码流'
      if (/[?&]subtype=0(?:&|$)/.test(path)) return '主码流'
      return ''
    }

    function cameraTabKey(sessionId, tabId) {
      return 'dsh-terminal-workbench.cameraTab.' + String(sessionId) + '.' + String(tabId)
    }

    function readStoredCameraId(sessionId, tabId) {
      try {
        return window.localStorage.getItem(cameraTabKey(sessionId, tabId)) || ''
      } catch (error) {
        return ''
      }
    }

    function storeCameraId(sessionId, tabId, cameraId) {
      try {
        window.localStorage.setItem(cameraTabKey(sessionId, tabId), String(cameraId))
      } catch (error) {
        /* 存不下只影响刷新恢复 */
      }
    }

    function forgetCameraTab(sessionId, tabId) {
      try {
        window.localStorage.removeItem(cameraTabKey(sessionId, tabId))
      } catch (error) {
        /* 删不掉只影响存储体积 */
      }
    }

    function subscribeCameras(listener) {
      var handler = function () {
        listener(readCameras())
      }
      window.addEventListener(CAMERA_EVENT, handler)
      return function () {
        window.removeEventListener(CAMERA_EVENT, handler)
      }
    }

    /* ---------- 相机悬浮按钮：IP 前缀 / 末位 / 终端映射 ---------- */

    /** IPv4 主机取 /24 前缀（192.168.10.20 → 192.168.10.）。非 IPv4 返回空串。 */
    function ipv4Prefix(host) {
      var text = String(host ?? '').trim()
      var match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
      if (match === null) return ''
      for (var index = 1; index <= 4; index += 1) {
        if (Number(match[index]) > 255) return ''
      }
      return match[1] + '.' + match[2] + '.' + match[3] + '.'
    }

    /** 前缀输入归一化：接受 192.168.10 / 192.168.10.，输出带尾点的三段。 */
    function normalizeCameraPrefix(value) {
      var text = String(value ?? '').trim().replace(/\.+$/, '')
      var match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
      if (match === null) return ''
      for (var index = 1; index <= 3; index += 1) {
        if (Number(match[index]) > 255) return ''
      }
      return match[1] + '.' + match[2] + '.' + match[3] + '.'
    }

    /** 末位只接受 1–254；0/255 是网络号与广播地址，相机不会用。 */
    function normalizeLastOctet(value) {
      var text = String(value ?? '').trim()
      if (!/^\d{1,3}$/.test(text)) return null
      var octet = Number(text)
      return octet >= 1 && octet <= 254 ? octet : null
    }

    /** 前缀 + 末位拼成完整 IPv4；任一段非法返回空串。 */
    function cameraHostFromOctet(prefix, octetValue) {
      var normalizedPrefix = normalizeCameraPrefix(prefix)
      var octet = normalizeLastOctet(octetValue)
      if (normalizedPrefix === '' || octet === null) return ''
      return normalizedPrefix + String(octet)
    }

    /**
     * 终端书签映射到相机前缀：优先用书签里显式填的「相机前缀」，
     * 留空则按主机前三段推导。这样终端在 192.168.10.5、相机在
     * 192.168.10.20 时，悬浮按钮只需要输入末位 20。
     */
    function cameraPrefixForTerminalBookmark(bookmark) {
      if (bookmark === undefined || bookmark === null || typeof bookmark !== 'object') return ''
      var explicit = normalizeCameraPrefix(bookmark.cameraPrefix)
      if (explicit !== '') return explicit
      return ipv4Prefix(bookmark.host)
    }

    /**
     * 终端书签的相机归属：新建相机书签时自动带出，省得每台相机重复填。
     * 车号取书签标题，项目取书签分组名——现场就是按项目给书签分组的。
     * 默认分组不算项目，避免所有未分组书签错误共享同一个吊具密码。
     */
    function cameraOwnerForTerminalBookmarkWithGroups(bookmark, groups) {
      if (bookmark === undefined || bookmark === null || typeof bookmark !== 'object') {
        return { vehicle: '', project: '' }
      }
      var vehicle = String(bookmark.name ?? '').trim()
      var project = ''
      var groupId = groupIdOf(bookmark)
      if (groupId !== DEFAULT_GROUP.id) {
        var list = Array.isArray(groups) ? groups : []
        for (var index = 0; index < list.length; index += 1) {
          if (list[index].id !== groupId) continue
          var groupName = String(list[index].name ?? '').trim()
          if (groupName !== '' && groupName !== DEFAULT_GROUP.name) project = groupName
          break
        }
      }
      return { vehicle: vehicle, project: project }
    }

    function cameraOwnerForTerminalBookmark(bookmark) {
      return cameraOwnerForTerminalBookmarkWithGroups(bookmark, bookmarkGroupsOf(readSettings()))
    }

    /** 来源 SSH 书签映射：按 id 索引，归属只算一次，批量同步时不重复读设置。 */
    function cameraTerminalBookmarkMap() {
      var map = Object.create(null)
      var groups = bookmarkGroupsOf(readSettings())
      readBookmarks().forEach(function (bookmark) {
        if (typeof bookmark.id !== 'string' || bookmark.id === '') return
        map[bookmark.id] = {
          bookmark: bookmark,
          owner: cameraOwnerForTerminalBookmarkWithGroups(bookmark, groups),
        }
      })
      return map
    }

    /**
     * 找相机书签的来源 SSH 书签：
     *   1. 有 terminalBookmarkId 且还能找到，直接用它；
     *   2. 老书签没有链接时，按「车号 + 项目」唯一匹配回填；
     *   3. 找不到或匹配到多条（归属有歧义）就不硬绑。
     */
    function cameraTerminalBookmarkForRecord(record, map) {
      if (record === null || typeof record !== 'object') return undefined
      var id = String(record.terminalBookmarkId ?? '').trim()
      if (id !== '' && map[id] !== undefined) return map[id]
      var vehicle = String(record.vehicle ?? '').trim()
      var project = String(record.project ?? '').trim()
      if (vehicle === '' && project === '') return undefined
      var hits = []
      Object.keys(map).forEach(function (key) {
        var entry = map[key]
        if (entry.owner.vehicle !== vehicle || entry.owner.project !== project) return
        hits.push(entry)
      })
      return hits.length === 1 ? hits[0] : undefined
    }

    /** 把来源 SSH 书签的当前归属灌进相机书签；来源没了就保留上次快照。 */
    function hydrateCameraTerminalOwner(record, map) {
      var entry = cameraTerminalBookmarkForRecord(record, map)
      if (entry === undefined) return record
      var next = Object.assign({}, record, {
        terminalBookmarkId: entry.bookmark.id,
        vehicle: entry.owner.vehicle,
        project: entry.owner.project,
      })
      next.passwordGroup = cameraPasswordGroupKey(next)
      return next
    }

    function readRawCameras() {
      try {
        var raw = JSON.parse(window.localStorage.getItem(CAMERA_STORE_KEY) ?? '[]')
        return Array.isArray(raw)
          ? raw.map(normalizeCamera).filter(function (item) {
              return item !== null
            })
          : []
      } catch (error) {
        return []
      }
    }

    /**
     * 把相机书签的归属同步到来源 SSH 书签（v0.13.8）。
     * - 老书签按「车号 + 项目」唯一匹配补上 terminalBookmarkId；
     * - 书签改名/换组后，车号、项目、密码组跟着变；
     * - 旧组有密码而新组没有时把密码带过去，避免改个名就丢口令。
     */
    function syncCameraTerminalOwners() {
      var records = readRawCameras()
      if (records.length === 0) return { linked: 0, changed: 0 }
      var map = cameraTerminalBookmarkMap()
      var groups = null
      var groupsChanged = false
      var linked = 0
      var changed = 0
      var next = records.map(function (record) {
        var entry = cameraTerminalBookmarkForRecord(record, map)
        if (entry === undefined) return record
        var oldKey = String(record.passwordGroup ?? '')
        var nextRecord = Object.assign({}, record, {
          terminalBookmarkId: entry.bookmark.id,
          vehicle: entry.owner.vehicle,
          project: entry.owner.project,
        })
        var newKey = cameraPasswordGroupKey(nextRecord)
        nextRecord.passwordGroup = newKey
        var linkChanged = record.terminalBookmarkId !== entry.bookmark.id
        var ownerChanged =
          record.vehicle !== entry.owner.vehicle || record.project !== entry.owner.project
        var keyChanged = oldKey !== newKey
        if (!linkChanged && !ownerChanged && !keyChanged) return record
        if (oldKey !== '' && newKey !== '' && oldKey !== newKey) {
          if (groups === null) groups = readCameraPasswordGroups()
          if (groups[newKey] === undefined && groups[oldKey] !== undefined) {
            groups[newKey] = groups[oldKey]
            groupsChanged = true
          }
        }
        if (linkChanged) linked += 1
        changed += 1
        return nextRecord
      })
      if (groupsChanged) writeCameraPasswordGroups(groups)
      if (changed > 0) writeCameras(next)
      return { linked: linked, changed: changed }
    }

    function readCameraPrefix() {
      try {
        return normalizeCameraPrefix(window.localStorage.getItem(CAMERA_PREFIX_KEY))
      } catch (error) {
        return ''
      }
    }

    function writeCameraPrefix(prefix) {
      var normalized = normalizeCameraPrefix(prefix)
      if (normalized === '') return ''
      try {
        window.localStorage.setItem(CAMERA_PREFIX_KEY, normalized)
      } catch (error) {
        /* 存不下只影响下次打开时的默认值 */
      }
      return normalized
    }

    function cameraForHost(host) {
      var text = String(host ?? '').trim()
      if (text === '') return undefined
      return readCameras().filter(function (item) {
        return item.host === text
      })[0]
    }

    /**
     * 相机是否属于当前终端：
     * - 普通相机按车号匹配；
     * - 吊具相机按项目匹配（同项目不同车共用）。
     * 没有车号/项目时不做归属判断，避免把无关相机算进来。
     */
    function cameraBelongsToTerminal(camera, info) {
      if (camera === null || typeof camera !== 'object') return false
      if (info === null || typeof info !== 'object') return false
      var vehicle = String(info.vehicle ?? '').trim()
      var project = String(info.project ?? '').trim()
      if (vehicle === '' && project === '') return false
      if (vehicle !== '' && String(camera.vehicle ?? '').trim() === vehicle) return true
      if (
        project !== '' &&
        camera.spreader === true &&
        String(camera.project ?? '').trim() === project
      ) {
        return true
      }
      return false
    }

    /** 当前可见右栏会话 id；多会话时只认用户眼前这一块。 */
    function visibleRightSessionId() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return undefined
      var nodes = document.querySelectorAll('[data-sidebar-right-session]')
      for (var index = 0; index < nodes.length; index += 1) {
        var node = nodes[index]
        if (node.closest('[hidden]') !== null || node.getAttribute('aria-hidden') === 'true') continue
        var id = node.getAttribute('data-sidebar-right-session')
        if (typeof id === 'string' && id !== '') return id
      }
      return undefined
    }

    /** 当前可见的终端标签元素（排除隐藏会话、网页/相机标签由调用方再筛）。 */
    function visibleTerminalTabElements() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return []
      var session = visibleRightSessionId()
      var tabs = document.querySelectorAll('.wb-terminal-col [data-dockkit-tab]')
      var output = []
      for (var index = 0; index < tabs.length; index += 1) {
        var el = tabs[index]
        if (el.closest('[hidden]') !== null || el.getAttribute('aria-hidden') === 'true') continue
        var owner = el.closest('[data-sidebar-right-session]')
        if (session !== undefined && owner !== null && owner.getAttribute('data-sidebar-right-session') !== session) continue
        output.push(el)
      }
      return output
    }

    function terminalBookmarkForTab(tabId, contentId) {
      if (typeof tabId !== 'string' || tabId === '') return undefined
      var session = SSH_SESSIONS[tabId]
      if (session !== undefined && session.bookmark !== undefined) return session.bookmark
      var persisted = persistedSshSession(tabId, contentId ?? sshContentIdOf(tabId))
      return persisted === undefined ? undefined : persisted.bookmark
    }

    /**
     * 终端标签标题：优先用打开标签时带的标题，刷新后参数丢了就回退到
     * 持久会话里的书签名。没有这个兜底，xterm 的 liveTitle 会把标题
     * 变成 "bash"——用户会以为 SSH 书签丢了，相机归属也跟着不敢信。
     */
    function terminalTitleForTab(tabId, paramsTitle, contentId) {
      var explicit = String(paramsTitle ?? '').trim()
      if (explicit !== '') return explicit
      var bookmark = terminalBookmarkForTab(tabId, contentId)
      if (bookmark === undefined) return undefined
      var name = String(bookmark.name ?? '').trim()
      return name === '' ? undefined : name
    }

    function terminalLabelForTab(tabId, bookmark) {
      var meta = tabMetaOf(tabId)
      if (meta !== undefined && typeof meta.title === 'string' && meta.title !== '') return meta.title
      if (bookmark !== undefined && typeof bookmark.name === 'string' && bookmark.name !== '') return bookmark.name
      if (bookmark !== undefined && typeof bookmark.host === 'string') return bookmark.host
      return '终端'
    }

    /* 最近一次真正选中的终端标签。相机/网页标签激活时，终端标签都不再是
       aria-selected=true；没有这份记忆就会退回 DOM 里的第一个终端，
       从 2107 打开相机却显示 2105 的前缀。 */
    var LAST_ACTIVE_TERMINAL_TAB = { sessionId: '', tabId: '' }

    function activeDockPaneOf(element) {
      if (element === null || typeof element.closest !== 'function') return null
      return element.closest('[data-dockkit-pane-active], [data-dockkit-float-active]')
    }

    /**
     * 记住最后一次选中的终端标签。
     *
     * 右栏每个分栏都有自己的 aria-selected=true，但只有 data-dockkit-pane-active
     * 那一栏是用户眼前的。优先记激活分栏里的终端；激活的是相机/网页标签时
     * 保持上一次的终端，不被其它分栏里“自己那一格选中的终端”带跑。
     */
    function rememberActiveTerminalTab() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return
      var session = visibleRightSessionId()
      var tabs = document.querySelectorAll('.wb-terminal-col [data-dockkit-tab][aria-selected="true"]')
      var fallback = null
      for (var index = 0; index < tabs.length; index += 1) {
        var el = tabs[index]
        if (el.closest('[hidden]') !== null || el.getAttribute('aria-hidden') === 'true') continue
        var owner = el.closest('[data-sidebar-right-session]')
        var ownerId = owner === null ? '' : String(owner.getAttribute('data-sidebar-right-session') ?? '')
        if (session !== undefined && ownerId !== '' && ownerId !== session) continue
        var tabId = el.getAttribute('data-dockkit-tab')
        if (typeof tabId !== 'string' || tabId === '') continue
        var bookmark = terminalBookmarkForTab(tabId)
        if (bookmark === undefined || cameraPrefixForTerminalBookmark(bookmark) === '') continue
        var entry = { sessionId: ownerId, tabId: tabId }
        if (activeDockPaneOf(el) !== null) {
          LAST_ACTIVE_TERMINAL_TAB = entry
          return entry
        }
        if (fallback === null) fallback = entry
      }
      /* 没有任何激活分栏标记（例如刚加载）时才用第一个，避免初始为空。 */
      var hasActivePane =
        typeof document.querySelector === 'function' &&
        document.querySelector('[data-dockkit-pane-active], [data-dockkit-float-active]') !== null
      if (fallback !== null && !hasActivePane) LAST_ACTIVE_TERMINAL_TAB = fallback
      return LAST_ACTIVE_TERMINAL_TAB
    }

    /**
     * 相机前缀的终端优先级：最近使用的终端 > 当前选中的终端 > 其余。
     * 抽成纯函数，测试能直接覆盖“相机标签激活时不退回第一个终端”。
     */
    function orderTabsForCameraPrefix(entries, rememberedTabId) {
      var remembered = null
      var selected = []
      var rest = []
      for (var index = 0; index < entries.length; index += 1) {
        var entry = entries[index]
        if (entry === null || typeof entry !== 'object') continue
        if (remembered === null && entry.tabId === rememberedTabId) remembered = entry
        else if (entry.selected === true) selected.push(entry)
        else rest.push(entry)
      }
      return (remembered === null ? [] : [remembered]).concat(selected, rest)
    }

    /**
     * 解析相机前缀来源：
     *   1. 最近使用的 SSH 终端（相机标签激活时仍能跟着打开它的那台车）；
     *   2. 当前激活的 SSH 终端；
     *   3. 上次成功使用的前缀（刷新/切到非终端标签后仍能继续打开相机）；
     *   4. 空串（面板提示先连 SSH 或手填前缀）。
     */
    function resolveCameraPrefixInfo() {
      rememberActiveTerminalTab()
      var tabs = visibleTerminalTabElements()
      var entries = []
      for (var index = 0; index < tabs.length; index += 1) {
        entries.push({
          tabId: tabs[index].getAttribute('data-dockkit-tab'),
          selected: tabs[index].getAttribute('aria-selected') === 'true',
          element: tabs[index],
        })
      }
      var ordered = orderTabsForCameraPrefix(entries, LAST_ACTIVE_TERMINAL_TAB.tabId)
      for (var cursor = 0; cursor < ordered.length; cursor += 1) {
        var tabId = ordered[cursor].tabId
        var bookmark = terminalBookmarkForTab(tabId)
        var prefix = cameraPrefixForTerminalBookmark(bookmark)
        if (prefix === '') continue
        var owner = cameraOwnerForTerminalBookmark(bookmark)
        return {
          prefix: prefix,
          host: typeof bookmark.host === 'string' ? bookmark.host : '',
          title: terminalLabelForTab(tabId, bookmark),
          source: 'terminal',
          tabId: tabId,
          terminalBookmarkId: typeof bookmark.id === 'string' ? bookmark.id : '',
          vehicle: owner.vehicle,
          project: owner.project,
        }
      }
      var saved = readCameraPrefix()
      if (saved !== '') {
        return {
          prefix: saved,
          host: '',
          title: '',
          source: 'memory',
          tabId: '',
          terminalBookmarkId: '',
          vehicle: '',
          project: '',
        }
      }
      return {
        prefix: '',
        host: '',
        title: '',
        source: 'none',
        tabId: '',
        terminalBookmarkId: '',
        vehicle: '',
        project: '',
      }
    }

    /** 前缀来源没变时复用旧对象，避免每秒轮询都触发悬浮面板重渲染。 */
    function sameCameraPrefixInfo(left, right) {
      if (left === right) return true
      if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
      return (
        left.prefix === right.prefix &&
        left.host === right.host &&
        left.title === right.title &&
        left.source === right.source &&
        left.tabId === right.tabId &&
        left.terminalBookmarkId === right.terminalBookmarkId &&
        left.vehicle === right.vehicle &&
        left.project === right.project
      )
    }

    function clampCameraFloatY(value) {
      var height = typeof window === 'undefined' ? 800 : window.innerHeight
      var min = CAMERA_FAB_SIZE / 2 + 8
      var max = height - CAMERA_FAB_SIZE / 2 - 8
      var next = Number(value)
      if (!Number.isFinite(next)) next = min
      return Math.max(min, Math.min(max, next))
    }

    function readCameraFloatY() {
      try {
        var value = Number(window.localStorage.getItem(CAMERA_FLOAT_Y_KEY))
        return Number.isFinite(value) && value > 0 ? value : 0
      } catch (error) {
        return 0
      }
    }

    function writeCameraFloatY(value) {
      try {
        window.localStorage.setItem(CAMERA_FLOAT_Y_KEY, String(Math.round(clampCameraFloatY(value))))
      } catch (error) {
        /* 存不下只影响下次打开的位置 */
      }
    }

    /** 打开一个相机书签标签。返回 false 表示右栏服务未就绪。 */
    function openCameraTab(record) {
      if (record === undefined || record === null || typeof record.id !== 'string' || record.id === '') return false
      var right = pluginCtx !== null && typeof pluginCtx.get === 'function' ? pluginCtx.get('sidebarRight') : undefined
      if (right === undefined || right === null || typeof right.openTab !== 'function') return false
      PENDING_CAMERA_ID = record.id
      try {
        right.openTab(CAMERA_KIND, { params: { cameraId: record.id } })
        return true
      } catch (error) {
        PENDING_CAMERA_ID = ''
        console.warn('[terminal-workbench] 打开相机失败：', error)
        return false
      }
    }

    /**
     * 悬浮按钮的主入口：前缀 + 末位打开指定相机。
     * 同一 IP 已有书签就复用（保留账号/口令/路径），没有就建一条空白书签，
     * 标签打开后由用户补参数。
     */
    function openCameraByOctet(prefix, octetValue, context) {
      var normalizedPrefix = normalizeCameraPrefix(prefix)
      if (normalizedPrefix === '') return { ok: false, error: '先填完整 IP 前缀，如 192.168.10.' }
      var host = cameraHostFromOctet(normalizedPrefix, octetValue)
      if (host === '') return { ok: false, error: '末位需为 1–254 的数字' }
      var source = context !== null && typeof context === 'object' ? context : {}
      var record = cameraForHost(host)
      var created = record === undefined
      if (created) {
        record = upsertCamera(blankCamera(host, source))
        if (record === undefined) return { ok: false, error: '相机书签创建失败' }
      } else if (
        String(record.terminalBookmarkId ?? '') === '' &&
        String(source.terminalBookmarkId ?? '') !== ''
      ) {
        /* 老书签第一次从终端打开时补上来源链接，之后改名/换组就能跟随。 */
        record = upsertCamera(
          Object.assign({}, record, { terminalBookmarkId: source.terminalBookmarkId }),
        )
      }
      writeCameraPrefix(normalizedPrefix)
      if (!openCameraTab(record)) return { ok: false, error: '右栏未就绪，无法打开相机标签' }
      return { ok: true, host: host, created: created, record: record }
    }

    /* 其它标签页改了相机书签或密码组时，清掉本页缓存并通知订阅者。 */
    try {
      window.addEventListener('storage', function (event) {
        if (event.key === SETTINGS_KEY) {
          resetCameraCache()
          try {
            syncCameraTerminalOwners()
          } catch (error) {
            console.warn('[terminal-workbench] 相机归属同步失败：', error)
          }
          try {
            window.dispatchEvent(new CustomEvent(CAMERA_EVENT))
          } catch (error) {
            /* 忽略 */
          }
          return
        }
        if (event.key !== CAMERA_STORE_KEY && event.key !== CAMERA_PASSWORD_GROUPS_KEY) return
        CAMERA_CACHE = null
        try {
          window.dispatchEvent(new CustomEvent(CAMERA_EVENT))
        } catch (error) {
          /* 忽略 */
        }
      })
    } catch (error) {
      /* 隐私模式可能禁用 storage 事件 */
    }

    /* 最近一次渲染终端所属会话（自绘菜单在拿不到 DOM 会话钩子时兜底）。 */
    var LAST_SESSION_ID = undefined

    var NS = 'sidebarTerminalPlus'

    var TERMINAL_CSS = [
      /* 底色跟 electerm 主题一致，避免画布与内边距之间露出 DSH 的黑。 */
      '.tp-root{position:relative;height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:#121214}',
      '.tp-screen{flex:1;min-height:0;padding:6px 0 0 8px;overflow:hidden}',
      '.tp-screen .xterm{height:100%}',
      /* xterm.css 给 viewport 的默认底色是纯黑，画布行数不足时会露出黑边，统一成主题背景。 */
      '.tp-screen .xterm .xterm-viewport{background-color:#121214 !important}',
      /* 空态不跟随终端主题：否则没有终端时整块面板都是暗紫红，像画错了色。 */
      '.tp-empty{height:100%;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-base)}',
      '.tp-empty-btn{padding:7px 16px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay,transparent);color:var(--dsw-alias-label-primary,#111827);cursor:pointer;font-size:13px}',
      '.tp-empty-btn:hover{background:var(--dsw-alias-bg-layer-2,#f3f4f6)}',
      '.tp-recovery-failed{height:100%;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;text-align:center}',
      /* 新建页：electerm 式弹层卡片（居中浮起，而非铺满整页）。 */
      '.tp-guide{height:100%;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-base)}',
      '.tp-card{width:min(560px,100%);max-height:100%;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:16px 18px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));box-shadow:0 8px 24px rgba(0,0,0,.18)}',
      '.tp-card-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#111827)}',
      '.tp-card-input{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1);background:var(--tp-surface,#121214);color:var(--dsw-alias-label-primary,#111827);font-size:14px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;outline:none}',
      '.tp-card-input:focus{border-color:var(--dsw-alias-brand-primary,#4f6ef2)}',
      '.tp-card-row{display:flex;gap:6px;flex-wrap:wrap}',
      '.tp-chip{padding:5px 10px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary,#111827);cursor:pointer;font-size:13px}',
      '.tp-chip:hover{background:var(--dsw-alias-bg-layer-2,#f3f4f6)}',
      '.tp-chip[data-selected]{border-color:var(--dsw-alias-brand-primary,#4f6ef2);color:var(--dsw-alias-brand-primary,#4f6ef2)}',
      '.tp-card-section{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#9ca3af);margin-top:2px}',
      '.tp-recent{display:flex;flex-direction:column;gap:1px;overflow:auto;min-height:0}',
      '.tp-recent-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:14px;color:var(--dsw-alias-label-primary,#111827);text-align:left}',
      '.tp-recent-item:hover{background:var(--dsw-alias-bg-layer-2,#f3f4f6)}',
      '.tp-recent-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.tp-dot{width:8px;height:8px;border-radius:2px;flex:none}',
      '.tp-recent-empty{font-size:13px;color:var(--dsw-alias-label-secondary,#9ca3af);padding:2px 0}',
       '.tp-recent-clear,.wb-recent-clear{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#9ca3af);font-size:13px;padding:4px 8px;cursor:pointer;text-align:left}',
       '.tp-recent-clear:hover,.wb-recent-clear:hover{color:var(--dsw-alias-label-primary,#111827)}',
      '.tp-shell{text-align:left;padding:8px 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay,transparent);color:var(--dsw-alias-label-primary,#111827);cursor:pointer;font-size:13px}',
      '.tp-shell:hover{background:var(--dsw-alias-bg-layer-2,#f3f4f6)}',
      '.tp-shell[data-selected]{border-color:var(--dsw-alias-brand-primary,#4f6ef2)}',
      '.tp-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      /* 反向通道：选中终端输出 → 发给对话。容器自带定位上下文，按钮浮在终端**右下角**。
         放右下而不是右上：右上是 SSH 状态胶囊的地盘，两者一起出现会叠在一起；
         而且用户的阅读动线停在屏幕底部（最新输出处），按钮跟着视线走更顺手。
         底部留 12px 避开滚动条末端与最后一行提示符。
         container-type 让下面能按**面板自身宽度**（而非视口）收起提示文字：
         中栏被拖窄时只留按钮，提示改由 title 承担。 */
      '.tp-wrap{position:relative;height:100%;min-height:0;display:flex;flex-direction:column;container-type:inline-size}',
      '.tp-wrap>.tp-root{flex:1;min-height:0}',
      '.tp-send{position:absolute;right:16px;bottom:12px;z-index:40;display:flex;align-items:center;gap:8px;pointer-events:auto}',
      '.tp-send-btn{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l2,#2c2c2e);background:rgba(18,18,20,.92);color:#e5e7eb;font-size:12px;line-height:1.4;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.45)}',
      '.tp-send-btn:hover{border-color:var(--dsw-alias-brand-primary,#4f6ef2);color:#fff}',
      '.tp-send-btn[data-busy]{opacity:.6;cursor:progress}',
      '.tp-send-btn>svg{flex:none}',
      '.tp-send-hint{font-size:11px;color:#9ca3af;text-shadow:0 1px 2px rgba(0,0,0,.6);white-space:nowrap}',
      /* 提示条放在按钮正下方：底部留给终端末行、快捷指令栏与复制提示，
         居中浮层会正好压住用户正在看的那几行。 */
      '.tp-toast{position:absolute;right:16px;top:46px;z-index:41;max-width:min(60%,420px);padding:6px 12px;border-radius:8px;background:rgba(18,18,20,.95);border:.5px solid var(--dsw-alias-border-l2,#2c2c2e);color:#e5e7eb;font-size:12px;box-shadow:0 6px 18px rgba(0,0,0,.5);overflow-wrap:anywhere;animation:tp-tip-in 160ms ease-out}',
      '.tp-toast[data-kind=error]{color:#ff9d9d;border-color:#5c2b2b}',
      /* SSH 连接状态胶囊（v0.7.0）：默认收在左上角不碍事，断开时亮红并给重连按钮。 */
      '.tp-ssh{position:absolute;left:16px;top:8px;z-index:40;display:flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;background:rgba(18,18,20,.85);border:.5px solid var(--dsw-alias-border-l2,#2c2c2e);color:#a1a1aa;font-size:11px;pointer-events:auto}',
      '.tp-ssh-dot{width:7px;height:7px;border-radius:50%;background:#34d399;flex:none}',
      '.tp-ssh[data-state=connecting] .tp-ssh-dot{background:#fbbf24;animation:tp-ssh-blink 1.2s steps(2) infinite}',
      '.tp-ssh[data-state=disconnected] .tp-ssh-dot{background:#f87171;animation:tp-ssh-blink 1s steps(2) infinite}',
      '.tp-ssh[data-state=disconnected]{color:#ff9d9d;border-color:#5c2b2b}',
      '@keyframes tp-ssh-blink{50%{opacity:.25}}',
      '.tp-ssh-btn{height:20px;padding:0 10px;border-radius:6px;border:1px solid #5c2b2b;background:transparent;color:#ff9d9d;font-size:11px;cursor:pointer}',
      '.tp-ssh-btn:hover{background:#3a1d1d}',
      /* ---------- OSC 133 命令块（v0.9.0 / S4） ----------
         边距条画在终端文字左侧的 padding 里，不进入 xterm 渲染树。
         失败块红色、执行中黄色、正常块灰蓝；选中加宽。 */
      '.tp-blocks{position:absolute;z-index:34;pointer-events:none;overflow:hidden}',
      '.tp-block-bar{position:absolute;left:1px;min-width:4px;border:0;border-radius:2px;padding:0;margin:0;background:#4b5563;opacity:.72;cursor:pointer;pointer-events:auto;transition:opacity .12s,background .12s}',
      '.tp-block-bar:hover{opacity:1;background:#9ca3af}',
      '.tp-block-bar[data-state=running]{background:#fbbf24}',
      '.tp-block-bar[data-state=fail]{background:#ef4444}',
      '.tp-block-bar[data-state=unknown]{background:#6b7280}',
      '.tp-block-bar[data-selected=true]{background:#7aa2f7;opacity:1;box-shadow:0 0 0 1px rgba(122,162,247,.45)}',
      '.tp-block-head{position:absolute;left:16px;bottom:12px;z-index:42;display:flex;align-items:center;gap:10px;max-width:min(72%,560px);padding:6px 8px 6px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,#2c2c2e);background:rgba(18,18,20,.96);color:#e5e7eb;font-size:11px;box-shadow:0 6px 18px rgba(0,0,0,.5);pointer-events:auto}',
      '.tp-block-head[data-state=fail]{border-color:#5c2b2b}',
      '.tp-block-head-main{display:flex;align-items:center;gap:6px;min-width:0;flex:1}',
      '.tp-block-prompt{color:#7aa2f7;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;flex:none}',
      '.tp-block-cmd{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.tp-block-meta{display:flex;align-items:center;gap:6px;flex:none;color:#9ca3af;white-space:nowrap}',
      '.tp-block-rc{padding:0 5px;border-radius:4px;background:#26262b;color:#d4d4d8}',
      '.tp-block-head[data-state=fail] .tp-block-rc{background:#3a1d1d;color:#ff9d9d}',
      '.tp-block-actions{display:flex;align-items:center;gap:2px;flex:none}',
      '.tp-block-act{width:18px;height:18px;border:0;border-radius:4px;background:transparent;color:#9ca3af;font-size:11px;line-height:1;cursor:pointer;padding:0}',
      '.tp-block-act:hover{background:#3a3a42;color:#e5e7eb}',
      '@container (max-width: 560px){.tp-send-hint{display:none}}',
      /* ---------- 文件面板抽屉（v0.8.0 / S3） ----------
         从右侧滑出，宽度跟随面板：面板很窄时不硬撑，直接占满省得两个都挤。 */
      '.tp-fs-toggle{position:absolute;right:16px;top:8px;z-index:40;display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,#2c2c2e);background:rgba(18,18,20,.85);color:#a1a1aa;font-size:11px;cursor:pointer;pointer-events:auto}',
      '.tp-fs-toggle:hover{color:#e5e7eb;border-color:var(--dsw-alias-brand-primary,#4f6ef2)}',
      '.tp-fs-toggle[data-open=true]{color:#e5e7eb;border-color:var(--dsw-alias-brand-primary,#4f6ef2);background:rgba(30,32,48,.92)}',
      '.tp-fs{position:absolute;right:0;top:0;bottom:0;z-index:39;width:min(380px,72%);display:flex;flex-direction:column;background:rgba(14,14,16,.97);border-left:.5px solid var(--dsw-alias-border-l2,#2c2c2e);box-shadow:-8px 0 24px rgba(0,0,0,.45);pointer-events:auto;animation:tp-fs-in 140ms ease-out}',
      '@keyframes tp-fs-in{from{transform:translateX(12px);opacity:0}to{transform:none;opacity:1}}',
      '.tp-fs-head{display:flex;align-items:center;gap:4px;padding:34px 8px 6px 8px;flex:none}',
      '.tp-fs-alias{flex:1;min-width:0;height:22px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2,#2c2c2e);background:#1a1a1d;color:#e5e7eb;font-size:11px;padding:0 4px}',
      '.tp-fs-btn{height:22px;min-width:22px;padding:0 6px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2,#2c2c2e);background:transparent;color:#a1a1aa;font-size:11px;cursor:pointer;flex:none}',
      '.tp-fs-btn:hover:not(:disabled){color:#e5e7eb;border-color:var(--dsw-alias-brand-primary,#4f6ef2)}',
      '.tp-fs-btn:disabled{opacity:.35;cursor:default}',
      '.tp-fs-btn-primary{border-color:var(--dsw-alias-brand-primary,#4f6ef2);color:#e5e7eb}',
      '.tp-fs-path{display:flex;align-items:center;flex-wrap:wrap;gap:1px;padding:2px 8px 6px 8px;flex:none;font-size:11px;color:#6b7280}',
      '.tp-fs-crumb{background:transparent;border:none;color:#9ca3af;font-size:11px;padding:1px 2px;border-radius:4px;cursor:pointer;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tp-fs-crumb:hover{color:#e5e7eb;background:#26262b}',
      '.tp-fs-crumb-sep{color:#4b5563;font-size:10px}',
      '.tp-fs-error{display:flex;align-items:flex-start;gap:6px;margin:0 8px 6px 8px;padding:5px 8px;border-radius:6px;background:#3a1d1d;border:.5px solid #5c2b2b;color:#ff9d9d;font-size:11px;overflow-wrap:anywhere}',
      '.tp-fs-error>span{flex:1}',
      '.tp-fs-body{flex:1;min-height:0;overflow:auto}',
      '.tp-fs-list{display:flex;flex-direction:column}',
      '.tp-fs-row{display:flex;align-items:center;gap:6px;padding:3px 8px;font-size:12px;color:#d4d4d8;cursor:default;user-select:none}',
      '.tp-fs-row:hover{background:#1c1c20}',
      '.tp-fs-row[data-selected=true]{background:#26262b}',
      '.tp-fs-icon{flex:none;width:12px;text-align:center;color:#6b7280;font-size:10px}',
      '.tp-fs-row[data-type=directory] .tp-fs-icon{color:#7aa2f7}',
      '.tp-fs-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tp-fs-size{flex:none;color:#6b7280;font-size:10px}',
      '.tp-fs-ops{flex:none;display:none;gap:2px}',
      '.tp-fs-row:hover .tp-fs-ops,.tp-fs-row[data-selected=true] .tp-fs-ops{display:flex}',
      '.tp-fs-op{width:18px;height:18px;border:none;border-radius:4px;background:transparent;color:#9ca3af;font-size:11px;line-height:1;cursor:pointer;padding:0}',
      '.tp-fs-op:hover{background:#3a3a42;color:#e5e7eb}',
      '.tp-fs-empty{padding:16px 12px;color:#6b7280;font-size:11px;text-align:center}',
      '.tp-fs-note{padding:4px 8px;color:#6b7280;font-size:10px;flex:none}',
      '.tp-fs-editor{position:absolute;left:0;right:0;top:0;bottom:0;z-index:2;display:flex;flex-direction:column;background:#0e0e10}',
      '.tp-fs-editor-head{display:flex;align-items:center;gap:4px;padding:6px 8px;flex:none;border-bottom:.5px solid var(--dsw-alias-border-l2,#2c2c2e)}',
      '.tp-fs-editor-title{flex:1;min-width:0;font-size:11px;color:#e5e7eb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tp-fs-dirty{color:#fbbf24;font-size:9px;flex:none}',
      '.tp-fs-textarea{flex:1;min-height:0;resize:none;border:none;outline:none;background:#0e0e10;color:#e5e7eb;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;padding:8px}',
    ].join('')

    /* 渲染层单独成 chunk：xterm + addons 约 500 KB，只在第一次打开终端时下载。 */
    var LoadedTerminalBody = react.lazy(async () => ({
      default: (await require.async('./client.terminal.js')).TerminalBody,
    }))

    function LazyTerminalBody(props) {
      return jsx(react.Suspense, { fallback: null, children: jsx(LoadedTerminalBody, props) })
    }

    /**
     * 文件面板抽屉：把 lazy chunk 拉进来并注入宿主 react / t。
     *
     * 注入为什么不写在 lazy 里：`t` 依赖 ctx.locale，lazy 的 loader 只在第一次
     * 求值时跑一次，拿不到最新闭包。放这里每次渲染都新建一个包装组件，
     * 代价可忽略（面板本身有状态，不会因外层包装变化而丢）。
     */
    function FsPanelDrawer(props) {
      var Panel = react.useMemo(function () {
        return react.lazy(async function () {
          var mod = await require.async('./client-fs-panel.js')
          return { default: mod.createFsPanel({ react: react, t: props.t }) }
        })
      }, [])
      return jsx(react.Suspense, {
        fallback: jsx('div', { className: 'tp-fs', children: jsx('div', { className: 'tp-fs-empty', children: '载入文件面板…' }) }),
        children: jsx(Panel, { initialPath: props.initialPath }),
      })
    }

    function TerminalIcon() {
      return jsxs('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        children: [
          jsx('path', { d: 'M3 4L7 8L3 12', stroke: 'currentColor' }),
          jsx('path', { d: 'M9 12H13', stroke: 'currentColor' }),
        ],
      })
    }

    /** 标签标题：优先取终端进程标题，拿不到退回 tab 标题。 */
    /* electerm 式标签序号配色：按标签顺序取色，文字自动选黑/白保证对比。 */
    var BADGE_COLORS = ['#45A9F9', '#19f9d8', '#FFB86C', '#FF75B5', '#B084EB', '#6FC1FF']

    function badgeInk(hex) {
      var value = hex.replace('#', '')
      var r = parseInt(value.slice(0, 2), 16)
      var g = parseInt(value.slice(2, 4), 16)
      var b = parseInt(value.slice(4, 6), 16)
      /* 相对亮度近似：超过阈值用深色字，否则用白字。 */
      return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#121214' : '#ffffff'
    }

    /* ---------- 终端访问状态：宿主只读快照（写入权限跟随 DSH） ---------- */

    var TERMINAL_ACCESS_URL = '/__dsh-terminal-workbench/terminal-access'
    var TERMINAL_ACCESS_POLL_MS = 15000
    var TERMINAL_ACCESS = {
      sessionId: undefined,
      items: [],
      byId: {},
      policy: null,
      at: 0,
      version: 0,
      inflight: undefined,
      timer: undefined,
      listeners: new Set(),
    }

    function resetTerminalAccess() {
      if (TERMINAL_ACCESS.timer !== undefined) {
        window.clearInterval(TERMINAL_ACCESS.timer)
        TERMINAL_ACCESS.timer = undefined
      }
      TERMINAL_ACCESS.sessionId = undefined
      TERMINAL_ACCESS.items = []
      TERMINAL_ACCESS.byId = {}
      TERMINAL_ACCESS.policy = null
      TERMINAL_ACCESS.at = 0
      TERMINAL_ACCESS.inflight = undefined
      TERMINAL_ACCESS.listeners.clear()
      TERMINAL_ACCESS.version += 1
    }

    function notifyTerminalAccess() {
      TERMINAL_ACCESS.version += 1
      TERMINAL_ACCESS.listeners.forEach(function (listener) {
        try {
          listener()
        } catch (error) {
          console.warn('[terminal-workbench] 终端访问状态订阅者失败：', error)
        }
      })
    }

    function setTerminalAccessSnapshot(sessionId, payload) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      /* 迟到的旧会话响应不能把当前会话切回去。 */
      if (TERMINAL_ACCESS.sessionId !== undefined && TERMINAL_ACCESS.sessionId !== sessionId) return
      TERMINAL_ACCESS.sessionId = sessionId
      var terminals = Array.isArray(payload?.terminals) ? payload.terminals : []
      var byId = {}
      var items = []
      terminals.forEach(function (item) {
        if (item === null || typeof item !== 'object' || typeof item.id !== 'string') return
        byId[item.id] = item
        items.push(item)
      })
      TERMINAL_ACCESS.items = items
      TERMINAL_ACCESS.byId = byId
      TERMINAL_ACCESS.policy = typeof payload?.policy === 'string' ? payload.policy : null
      TERMINAL_ACCESS.at = Date.now()
      notifyTerminalAccess()
    }

    /* 终端身份解析：新建标签的导航参数里没有 terminalId，真实 id 在
       webTerminals 的已挂载视图或持久绑定里。顺序：显式参数 > 视图 > 绑定。 */
    function resolveTerminalId(params, view, binding) {
      if (
        params !== undefined &&
        params !== null &&
        typeof params.terminalId === 'string' &&
        params.terminalId !== ''
      ) {
        return params.terminalId
      }
      if (view !== undefined && view !== null && typeof view.id === 'string' && view.id !== '') return view.id
      if (typeof binding === 'string' && binding !== '') return binding
      return undefined
    }

    function terminalAccessEntry(sessionId, terminalId) {
      if (typeof terminalId !== 'string' || terminalId === '') return undefined
      if (TERMINAL_ACCESS.sessionId !== sessionId) return undefined
      return TERMINAL_ACCESS.byId[terminalId]
    }

    function terminalAccessSnapshotOf(sessionId) {
      if (TERMINAL_ACCESS.sessionId !== sessionId) return { policy: null, terminals: [] }
      return { policy: TERMINAL_ACCESS.policy, terminals: TERMINAL_ACCESS.items.slice() }
    }

    function terminalAccessBadge(entry, terminalId) {
      if (typeof terminalId !== 'string' || terminalId === '') return undefined
      if (entry === undefined || entry === null) return undefined
      if (entry.state !== undefined && entry.state !== 'running') {
        return {
          key: 'exited',
          text: '已退出',
          title: '终端已退出，助手只能读',
          tone: 'exited',
        }
      }
      if (entry.own === true) {
        return {
          key: 'own',
          text: '助手专属',
          title: '助手专属终端：可读可写，不需要审批',
          tone: 'own',
        }
      }
      if (entry.access === 'writable') {
        return {
          key: 'writable',
          text: '可写',
          title: '当前 DSH 预设为 full-access（不弹审批），助手可直接写入此终端',
          tone: 'writable',
        }
      }
      if (entry.access === 'approval') {
        return {
          key: 'approval',
          text: '需审批',
          title: '助手写入此终端时会走 DSH 审批，由你逐次允许或拒绝',
          tone: 'approval',
        }
      }
      return {
        key: 'read',
        text: '可读',
        title: '助手可读；终端访问状态尚未就绪',
        tone: 'read',
      }
    }

    function ensureTerminalAccess(sessionId, force) {
      if (typeof sessionId !== 'string' || sessionId === '') return Promise.resolve()
      if (TERMINAL_ACCESS.sessionId !== sessionId) {
        TERMINAL_ACCESS.sessionId = sessionId
        TERMINAL_ACCESS.items = []
        TERMINAL_ACCESS.byId = {}
        TERMINAL_ACCESS.policy = null
        TERMINAL_ACCESS.at = 0
        notifyTerminalAccess()
      }
      if (TERMINAL_ACCESS.inflight !== undefined) return TERMINAL_ACCESS.inflight
      if (force !== true && TERMINAL_ACCESS.at !== 0 && Date.now() - TERMINAL_ACCESS.at < 2000) {
        return Promise.resolve()
      }
      var fetcher = typeof window.fetch === 'function' ? window.fetch : undefined
      if (fetcher === undefined) return Promise.resolve()
      var requestSession = sessionId
      var url = TERMINAL_ACCESS_URL + '?sessionId=' + encodeURIComponent(sessionId)
      TERMINAL_ACCESS.inflight = fetcher(url, { cache: 'no-store', credentials: 'same-origin' })
        .then(function (response) {
          if (response === undefined || response.ok !== true) return undefined
          return response.json()
        })
        .then(function (payload) {
          if (TERMINAL_ACCESS.sessionId !== requestSession) return
          if (payload?.ok === true) setTerminalAccessSnapshot(requestSession, payload)
        })
        .catch(function () {
          /* 网络抖动/宿主未就绪时保持旧快照，不打断终端使用。 */
        })
        .finally(function () {
          TERMINAL_ACCESS.inflight = undefined
          /* 请求期间换了会话：旧响应已丢弃，立刻补一次新请求。 */
          if (TERMINAL_ACCESS.sessionId !== requestSession) {
            ensureTerminalAccess(TERMINAL_ACCESS.sessionId, true)
          }
        })
      return TERMINAL_ACCESS.inflight
    }

    function subscribeTerminalAccess(sessionId, listener) {
      TERMINAL_ACCESS.listeners.add(listener)
      ensureTerminalAccess(sessionId, true)
      if (TERMINAL_ACCESS.timer === undefined) {
        TERMINAL_ACCESS.timer = window.setInterval(function () {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          ensureTerminalAccess(TERMINAL_ACCESS.sessionId, true)
        }, TERMINAL_ACCESS_POLL_MS)
      }
      return function () {
        TERMINAL_ACCESS.listeners.delete(listener)
        if (TERMINAL_ACCESS.listeners.size === 0 && TERMINAL_ACCESS.timer !== undefined) {
          window.clearInterval(TERMINAL_ACCESS.timer)
          TERMINAL_ACCESS.timer = undefined
        }
      }
    }

    function useTerminalAccessEntry(sessionId, terminalId) {
      var state = react.useState(function () {
        return terminalAccessEntry(sessionId, terminalId)
      })
      var entry = state[0]
      var setEntry = state[1]
      react.useEffect(
        function () {
          if (typeof sessionId !== 'string' || sessionId === '' || typeof terminalId !== 'string' || terminalId === '') {
            setEntry(undefined)
            return undefined
          }
          var sync = function () {
            setEntry(terminalAccessEntry(sessionId, terminalId))
          }
          sync()
          return subscribeTerminalAccess(sessionId, sync)
        },
        [sessionId, terminalId],
      )
      return entry
    }

    function TerminalTitle(props) {
      var tab = props.useTabInfo().tab
      var openTabs = props.useTabs(function (list) {
        return list
      })
      var meta = useTabMeta(tab.id)
      var sshTitleTick = react.useState(0)
      var setSshTitleTick = sshTitleTick[1]
      react.useEffect(
        function () {
          var onSshState = function (event) {
            var detail = event !== null && typeof event === 'object' ? event.detail : undefined
            if (
              detail !== null &&
              typeof detail === 'object' &&
              typeof detail.tabId === 'string' &&
              detail.tabId !== tab.id
            ) {
              return
            }
            setSshTitleTick(function (value) {
              return value + 1
            })
          }
          window.addEventListener('dsh-terminal-workbench:ssh-state', onSshState)
          return function () {
            window.removeEventListener('dsh-terminal-workbench:ssh-state', onSshState)
          }
        },
        [tab.id, setSshTitleTick],
      )
      var sessionId = typeof props.sessionId === 'string' ? props.sessionId : LAST_SESSION_ID
      var terminalId = typeof props.terminalId === 'function' ? props.terminalId(tab.id) : undefined
      var accessEntry = useTerminalAccessEntry(sessionId, terminalId)
      var accessBadge = terminalAccessBadge(accessEntry, terminalId)
      /* 清单快照元素是 {sessionId, tabId, kind, contentId}，不是 {id}；
         再退一层用 DOM 顺序兜底，保证徽标总能在渲染后出现。 */
      /* 序号必须是「当前面板内第几个」：清单是跨会话的扁平列表，
         直接拿它算会得到 50、51 这类全局编号。DOM 顺序才是用户看到的样子。 */
      var index = -1
      if (typeof document !== 'undefined') {
        var domTabs = document.querySelectorAll('.wb-terminal-col [data-dockkit-tab]')
        index = Array.prototype.findIndex.call(domTabs, function (el) {
          return el.getAttribute('data-dockkit-tab') === tab.id
        })
      }
      if (index < 0 && Array.isArray(openTabs)) {
        index = openTabs.findIndex(function (item) {
          var id = item !== null && typeof item === 'object' ? (item.id ?? item.tabId) : item
          return id === tab.id
        })
      }
      /* 必须无条件调用：hook 数量随改名变化会让 React 抛错，标题整块消失。 */
      var liveTitle = props.useTerminal(tab.id, function (state) {
        return state?.info?.title ?? state?.title
      })
      var custom = meta !== undefined && typeof meta.title === 'string' && meta.title !== '' ? meta.title : undefined
      var bookmarkTitle = typeof props.bookmarkTitle === 'function' ? props.bookmarkTitle(tab.id) : undefined
      var title = custom ?? bookmarkTitle ?? liveTitle ?? tab.title
      var color = index >= 0 ? BADGE_COLORS[index % BADGE_COLORS.length] : undefined
      return jsxs(Fragment, {
        children: [
          color === undefined
            ? jsx(TerminalIcon, {})
            : jsx('span', {
                className: 'tp-badge',
                'data-index': String(index + 1),
                style: { background: color, color: badgeInk(color) },
                children: String(index + 1),
              }),
          meta !== undefined && meta.pinned === true
            ? jsx('span', { className: 'tp-pin', title: '已固定', children: '📌' })
            : null,
          jsx('span', { className: 'tp-title', children: title }),
          accessBadge === undefined
            ? null
            : jsx('span', {
                className: 'tp-access tp-access-' + accessBadge.tone,
                title: accessBadge.title,
                'data-access': accessBadge.key,
                children: accessBadge.text,
              }),
        ],
      })
    }

    /* ---------- 标签元数据（重命名 / 固定 / 顺序），本地状态，不碰官方标签结构 ---------- */

    var TAB_META_KEY = 'dsh-terminal-workbench.tab-meta.v1'
    var TAB_META = new Map()
    var TAB_META_LISTENERS = new Set()

    function readTabMetaStore() {
      try {
        var raw = window.localStorage.getItem(TAB_META_KEY)
        var value = raw === null ? {} : JSON.parse(raw)
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
        return value
      } catch (error) {
        console.warn('[terminal-workbench] 读取标签状态失败，使用空状态：', error)
        return {}
      }
    }

    function writeTabMetaStore() {
      try {
        var output = {}
        TAB_META.forEach(function (value, key) { output[key] = value })
        window.localStorage.setItem(TAB_META_KEY, JSON.stringify(output))
      } catch (error) {
        console.warn('[terminal-workbench] 保存标签状态失败：', error)
      }
    }

    var persistedTabMeta = readTabMetaStore()
    Object.keys(persistedTabMeta).forEach(function (id) {
      var value = persistedTabMeta[id]
      if (value !== null && typeof value === 'object') TAB_META.set(id, value)
    })

    function tabMetaOf(id) {
      return TAB_META.get(id)
    }

    function subscribeTabMeta(listener) {
      TAB_META_LISTENERS.add(listener)
      return function () {
        TAB_META_LISTENERS.delete(listener)
      }
    }

    function setTabMeta(id, patch) {
      var previous = TAB_META.get(id) ?? {}
      var next = Object.assign({}, previous, patch)
      if (next.title === undefined && next.pinned !== true && next.order === undefined) TAB_META.delete(id)
      else TAB_META.set(id, next)
      writeTabMetaStore()
      TAB_META_LISTENERS.forEach(function (listener) { listener() })
    }

    function useTabMeta(id) {
      return react.useSyncExternalStore(
        subscribeTabMeta,
        function () {
          return TAB_META.get(id)
        },
        function () {
          return TAB_META.get(id)
        },
      )
    }

    /* ---------- 标签右键菜单（electerm 式：重命名 / 固定 / 复制 / 关闭其他 / 关闭右侧） ---------- */

    function menuItem(label, onClick) {
      return jsx(
        'button',
        {
          role: 'menuitem',
          className: 'wb-menu-item',
          'data-dockkit-menu-close': true,
          onClick: function () {
            try {
              onClick()
            } catch (error) {
              /* 单个菜单动作失败不应让整个菜单挂掉 */
              console.warn('[terminal-workbench] 单个菜单动作失败不应让整个菜单挂掉：', error)
            }
          },
          children: label,
        },
        label,
      )
    }

    function TabMenu(props) {
      var tab = props.tab
      var meta = useTabMeta(tab.id)
      var pinned = meta !== undefined && meta.pinned === true
      var listTabs = function () {
        try {
          var tabs = props.openTabs()
          return Array.isArray(tabs) ? tabs : []
        } catch (error) {
          return []
        }
      }
      return jsxs(Fragment, {
        children: [
          menuItem('重命名', function () {
            var fallback = (meta !== undefined && meta.title) || tab.title || 'terminal'
            var input = window.prompt('重命名终端', fallback)
            if (input === null) return
            var next = input.trim()
            setTabMeta(tab.id, { title: next === '' ? undefined : next })
          }),
          menuItem(pinned ? '取消固定' : '固定标签', function () {
            setTabMeta(tab.id, { pinned: !pinned })
          }),
          menuItem('复制标签', function () {
            props.duplicateTab(tab.id)
          }),
          menuItem('关闭其他', function () {
            listTabs().forEach(function (item) {
              if (item !== undefined && item.id !== tab.id) props.closeTab(item.id)
            })
          }),
          menuItem('关闭右侧', function () {
            var tabs = listTabs()
            var at = tabs.findIndex(function (item) {
              return item !== undefined && item.id === tab.id
            })
            if (at < 0) return
            tabs.slice(at + 1).forEach(function (item) {
              if (item !== undefined) props.closeTab(item.id)
            })
          }),
        ],
      })
    }

    /* ---------- 统一设置（本地存储 + 变更事件，终端侧监听即生效） ---------- */

    var SETTINGS_KEY = 'dsh-terminal-workbench.settings'
    var SETTINGS_EVENT = 'dsh-terminal-workbench:settings-changed'

    var SETTINGS_DEFAULTS = { fontSize: 13, copyOnSelect: true, theme: 'default', bookmarks: [], quickCommands: [], sshAutoReconnect: false }

    /* ---------- 终端配色：内置调色板 ----------
     *
     * 为什么要自带一套：终端的配色和界面主题是两件事——主人可能整个界面是浅色，
     * 却想在终端里看 Dracula；也可能反过来。`theme: null` 那一项表示"沿用终端
     * 组件的内置默认"，这样默认值只在终端 chunk 里写一份，不会两边各写一套后悄悄漂移。
     *
     * 字段是 xterm 的 ITheme：16 色 + 前景/背景/光标/选区，都是标准项，
     * 不含需要 allowProposedApi 的实验字段，换 xterm 版本也不会炸。
     */
    var TERMINAL_THEMES = [
      { id: 'default', label: '终端默认', colors: null },
      {
        id: 'dracula',
        label: 'Dracula',
        colors: {
          background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36',
          selectionBackground: 'rgba(68, 71, 90, 0.75)',
          black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
          blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
          brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
          brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
        },
      },
      {
        id: 'nord',
        label: 'Nord',
        colors: {
          background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440',
          selectionBackground: 'rgba(67, 76, 94, 0.8)',
          black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
          blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
          brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
          brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
        },
      },
      {
        id: 'tokyo-night',
        label: 'Tokyo Night',
        colors: {
          background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', cursorAccent: '#1a1b26',
          selectionBackground: 'rgba(65, 72, 104, 0.8)',
          black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
          blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
          brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68',
          brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
        },
      },
      {
        id: 'one-dark',
        label: 'One Dark',
        colors: {
          background: '#282c34', foreground: '#abb2bf', cursor: '#abb2bf', cursorAccent: '#282c34',
          selectionBackground: 'rgba(92, 99, 112, 0.7)',
          black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
          blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
          brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b',
          brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
        },
      },
      {
        id: 'monokai',
        label: 'Monokai',
        colors: {
          background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#272822',
          selectionBackground: 'rgba(117, 113, 94, 0.7)',
          black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75',
          blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
          brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75',
          brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
        },
      },
      {
        id: 'solarized-dark',
        label: 'Solarized Dark',
        colors: {
          background: '#002b36', foreground: '#839496', cursor: '#93a1a1', cursorAccent: '#002b36',
          selectionBackground: 'rgba(7, 54, 66, 0.85)',
          black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
          blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
          brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
          brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
        },
      },
      {
        id: 'solarized-light',
        label: 'Solarized Light',
        colors: {
          background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', cursorAccent: '#fdf6e3',
          selectionBackground: 'rgba(238, 232, 213, 0.9)',
          black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
          blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
          brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
          brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
        },
      },
      {
        id: 'gruvbox-dark',
        label: 'Gruvbox Dark',
        colors: {
          background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828',
          selectionBackground: 'rgba(80, 73, 69, 0.85)',
          black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
          blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
          brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f',
          brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
        },
      },
      {
        id: 'matrix',
        label: 'Matrix（黑底绿字）',
        colors: {
          background: '#000000', foreground: '#00ff41', cursor: '#00ff41', cursorAccent: '#000000',
          selectionBackground: 'rgba(0, 255, 65, 0.3)',
          black: '#002200', red: '#00cc33', green: '#00ff41', yellow: '#00cc33',
          blue: '#008f11', magenta: '#00cc33', cyan: '#00ff41', white: '#00ff41',
          brightBlack: '#004400', brightRed: '#00ff41', brightGreen: '#66ff99', brightYellow: '#00ff41',
          brightBlue: '#008f11', brightMagenta: '#00ff41', brightCyan: '#66ff99', brightWhite: '#ccffdd',
        },
      },
    ]

    /**
     * 按 id 取调色板；`default` 与任何不认识的 id 都返回 null，交给终端侧用自己的内置默认。
     * 终端 chunk 是独立打包的，看不到这里的变量，所以函数一起挂到 window 上共享。
     * @param id - 配色 id
     * @returns xterm ITheme，或 null 表示"用你自己的默认"
     */
    function resolveTerminalTheme(id) {
      var hit = TERMINAL_THEMES.find(function (item) {
        return item.id === id
      })
      return hit === undefined ? null : hit.colors
    }

    /* 渲染 chunk（client.terminal.js）是独立打包的模块，看不到这里的变量。
       键名与默认值统一挂到 window 单点共享，避免两边各写一套关键字面量后悄悄漂移。 */
    var LEGACY_FONT_KEY = 'dsh-terminal-workbench.fontSize'
    var LEGACY_COPY_KEY = 'dsh-terminal-workbench.copyOnSelect'
    window.__dshTerminalWorkbenchSettings = {
      key: SETTINGS_KEY,
      event: SETTINGS_EVENT,
      defaults: SETTINGS_DEFAULTS,
      legacyFontSizeKey: LEGACY_FONT_KEY,
      legacyCopyOnSelectKey: LEGACY_COPY_KEY,
    }

    /* 调色板挂到 window：终端 chunk 独立打包，看不到这里的 TERMINAL_THEMES。
       两个 chunk 的加载顺序没有保证，所以补一个 ready 事件——先加载完的那侧
       会在事件到达时重新取一次配色，不会出现"先开的终端没配色"。 */
    var THEMES_READY_EVENT = 'dsh-terminal-workbench:themes-ready'
    window.__dshTerminalWorkbenchThemes = {
      list: TERMINAL_THEMES,
      readyEvent: THEMES_READY_EVENT,
      resolve: resolveTerminalTheme,
    }

    /* 书签文件同步的测试缝：纯函数 + 可注入 fetch，不依赖 React/DOM。 */
    window.__dshTerminalWorkbenchBookmarks = {
      sync: syncFileBookmarks,
      normalize: normalizeFileBookmark,
      identity: bookmarkIdentityOf,
      render: renderBookmarkGroups,
    }
    /* 关闭意图策略的测试缝：启动裁剪、视图判定、带标记清理的关闭。 */
    window.__dshTerminalWorkbenchClosePolicy = {
      bound: boundTerminalCloseRequests,
      apply: applyTerminalClosePolicy,
      classify: terminalClosePolicy,
      viewOf: terminalViewOf,
      closeTab: closeTerminalTab,
      prefix: TERMINAL_CLOSE_PREFIX,
      retryKey: TERMINAL_CLOSE_RETRY_KEY,
      perSession: TERMINAL_CLOSE_PER_SESSION,
      total: TERMINAL_CLOSE_TOTAL,
    }
    window.dispatchEvent(new CustomEvent(THEMES_READY_EVENT))


    function readSettings() {
      var stored = {}
      try {
        var raw = window.localStorage.getItem(SETTINGS_KEY)
        if (raw !== null) stored = JSON.parse(raw) ?? {}
      } catch (error) {
        stored = {}
      }
      /* 兼容早期独立键（字号、选中即复制已各自存过）。
         注意：Number(null) === 0，全新配置下会把默认字号冲成 0，所以必须先判空再转。 */
      try {
        var legacyFont = window.localStorage.getItem(LEGACY_FONT_KEY)
        var fontSize = legacyFont === null || legacyFont === '' ? Number.NaN : Number(legacyFont)
        if (Number.isFinite(fontSize) && stored.fontSize === undefined) stored.fontSize = fontSize
        var copy = window.localStorage.getItem(LEGACY_COPY_KEY)
        if (copy !== null && stored.copyOnSelect === undefined) stored.copyOnSelect = copy === 'true'
      } catch (error) {
        /* 存储不可用时用默认值 */
        console.warn('[terminal-workbench] 存储不可用时用默认值：', error)
      }
      return Object.assign({}, SETTINGS_DEFAULTS, stored)
    }

    function writeSettings(patch) {
      var next = Object.assign({}, readSettings(), patch)
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
        window.localStorage.setItem(LEGACY_FONT_KEY, String(next.fontSize))
        window.localStorage.setItem(LEGACY_COPY_KEY, String(next.copyOnSelect))
      } catch (error) {
        /* 存储不可用时仍然广播，让当前会话生效 */
        console.warn('[terminal-workbench] 存储不可用时仍然广播，让当前会话生效：', error)
      }
      window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: next }))
      return next
    }

    /* SSH 书签改名/换组后，相机书签的归属和密码组要跟着走；缓存也要失效。 */
    try {
      window.addEventListener(SETTINGS_EVENT, function () {
        resetCameraCache()
        try {
          syncCameraTerminalOwners()
        } catch (error) {
          console.warn('[terminal-workbench] 相机归属同步失败：', error)
        }
      })
    } catch (error) {
      /* 隐私模式可能禁用事件 */
    }

    /**
     * 合并 electerm 导出的快捷命令数组。
     * electerm 字段：{ id, name, commands:[{command,delay}], labels:[], inputOnly }
     * 同 id 覆盖、新 id 追加；没有可用命令的条目直接跳过。
     */
    function importElectermQuickCommands(text, current) {
      var parsed = JSON.parse(text)
      if (!Array.isArray(parsed)) throw new Error('不是 electerm 快捷命令数组')
      var list = Array.isArray(current) ? current.slice() : []
      var indexById = Object.create(null)
      list.forEach(function (item, index) {
        indexById[item.id] = index
      })
      var added = 0
      parsed.forEach(function (raw, rawIndex) {
        if (raw === null || typeof raw !== 'object' || typeof raw.name !== 'string') return
        var steps = (Array.isArray(raw.commands) ? raw.commands : [])
          .filter(function (step) {
            return step !== null && typeof step === 'object'
          })
          .map(function (step) {
            return {
              command: typeof step.command === 'string' ? step.command : '',
              delay: Number(step.delay) || 0,
            }
          })
          .filter(function (step) {
            return step.command !== ''
          })
        if (steps.length === 0) return
        var labels = Array.isArray(raw.labels)
          ? raw.labels.filter(function (name) {
              return typeof name === 'string' && name !== ''
            })
          : []
        var id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : 'qc-import-' + rawIndex
        var entry = {
          id: id,
          name: raw.name,
          label: labels[0] ?? '',
          labels: labels,
          inputOnly: raw.inputOnly === true,
          commands: steps,
        }
        if (indexById[id] !== undefined) list[indexById[id]] = entry
        else {
          indexById[id] = list.length
          list.push(entry)
        }
        added += 1
      })
      return { list: list, added: added, skipped: parsed.length - added }
    }

    var DEFAULT_GROUP = { id: 'default', name: '默认分组' }

    /* 书签分组折叠：点组名收起/展开，状态记在本地，浮层与设置页共用同一份。 */
    var COLLAPSED_GROUPS_KEY = 'dsh-terminal-workbench.collapsed-groups'
    var COLLAPSED_GROUPS_EVENT = 'dsh-terminal-workbench:collapsed-groups'

    function readCollapsedGroups() {
      try {
        var raw = JSON.parse(window.localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? '[]')
        return Array.isArray(raw)
          ? raw.filter(function (id) {
              return typeof id === 'string'
            })
          : []
      } catch (error) {
        console.warn('[terminal-workbench] 折叠状态读取失败：', error)
        return []
      }
    }

    function toggleCollapsedGroup(groupId) {
      var list = readCollapsedGroups()
      var next =
        list.indexOf(groupId) >= 0
          ? list.filter(function (id) {
              return id !== groupId
            })
          : list.concat([groupId])
      try {
        window.localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(next))
      } catch (error) {
        console.warn('[terminal-workbench] 折叠状态保存失败：', error)
      }
      window.dispatchEvent(new CustomEvent(COLLAPSED_GROUPS_EVENT, { detail: next }))
      return next
    }

    /** 订阅折叠状态：跨组件同步（浮层与设置页同时打开时也一致）。 */
    function useCollapsedGroups() {
      var state = react.useState(readCollapsedGroups)
      react.useEffect(function () {
        var on = function () {
          state[1](readCollapsedGroups())
        }
        window.addEventListener(COLLAPSED_GROUPS_EVENT, on)
        return function () {
          window.removeEventListener(COLLAPSED_GROUPS_EVENT, on)
        }
      }, [])
      return state[0]
    }

    function importElectermBookmarks(raw, current) {
      if (raw === null || typeof raw !== 'object') throw new Error('JSON 根节点必须是对象')
      var sourceGroups = Array.isArray(raw.bookmarkGroups) ? raw.bookmarkGroups : []
      var sourceBookmarks = Array.isArray(raw.bookmarks) ? raw.bookmarks : []
      var groups = bookmarkGroupsOf(current)
      var marks = Array.isArray(current.bookmarks) ? current.bookmarks.slice() : []
      var groupMap = new Map()
      groups.forEach(function (group) { groupMap.set(String(group.name).trim().toLowerCase(), group) })
      var sourceGroupMap = new Map()
      sourceGroups.forEach(function (group) {
        ;(Array.isArray(group.bookmarkIds) ? group.bookmarkIds : []).forEach(function (bookmarkId) {
          sourceGroupMap.set(String(bookmarkId), group)
        })
      })
      var idMap = new Map()
      sourceGroups.forEach(function (group) {
        var name = String(group.title || '').trim() || '导入分组'
        var target = groupMap.get(name.toLowerCase())
        if (target === undefined) {
          target = { id: 'bg-' + Date.now().toString(36) + '-' + groups.length, name: name }
          groups.push(target)
          groupMap.set(name.toLowerCase(), target)
        }
        idMap.set(String(group.id), target.id)
      })
      var imported = 0
      sourceBookmarks.forEach(function (item, index) {
        if (item === null || typeof item !== 'object' || typeof item.host !== 'string' || item.host.trim() === '') return
        var sourceGroup = sourceGroupMap.get(String(item.id))
        var groupId = sourceGroup === undefined ? (groups[0] || DEFAULT_GROUP).id : (idMap.get(String(sourceGroup.id)) || groups[0].id)
        var name = String(item.title || item.name || item.host).trim()
        var user = String(item.username || item.user || '').trim()
        var host = item.host.trim()
        var duplicate = marks.some(function (old) {
          return groupIdOf(old) === groupId && String(old.name || '').trim() === name && String(old.host || '').trim() === host && String(old.user || '').trim() === user
        })
        if (duplicate) return
        marks.push({
          id: 'bm-' + Date.now().toString(36) + '-' + index,
          name: name,
          host: host,
          port: String(Number(item.port) || 22),
          user: user,
          groupId: groupId,
          groupName: groups.find(function (entry) { return entry.id === groupId })?.name || '',
          auth: item.authType === 'password' ? 'password' : item.authType === 'publicKey' || item.authType === 'key' ? 'key' : 'agent',
          keyPath: String(item.privateKeyPath || item.privateKey || item.keyPath || '').trim(),
          password: String(item.password || ''),
          remoteDir: String(item.remotePath || item.remoteDir || '').trim(),
          script: Array.isArray(item.runScripts) ? item.runScripts.map(function (run) { return String(run?.script || '').trim() }).filter(Boolean).join('\n') : '',
          setEnv: '',
          lang: String(item.envLang || '').trim(),
          localDir: String(item.localPath || item.localDir || '').trim(),
          description: String(item.description || '').trim(),
        })
        imported += 1
      })
      return { bookmarkGroups: groups, bookmarks: marks, imported: imported }
    }

    /** 书签分组；没有配置过就给一个默认分组，保证永远至少有一组。 */
    function bookmarkGroupsOf(settings) {
      var groups =
        settings !== null && typeof settings === 'object' && Array.isArray(settings.bookmarkGroups)
          ? settings.bookmarkGroups
          : []
      groups = groups.filter(function (group) {
        return group !== null && typeof group === 'object' && typeof group.id === 'string' && group.id !== ''
      })
      return groups.length === 0 ? [DEFAULT_GROUP] : groups
    }

    /** 老数据没有 groupId 时归到默认分组。 */
    function groupIdOf(mark) {
      return typeof mark.groupId === 'string' && mark.groupId !== '' ? mark.groupId : DEFAULT_GROUP.id
    }

    /** 读取 SSH 书签（一条：{id,name,user,host,port,groupId}）。 */
    function readBookmarks() {
      var list = readSettings().bookmarks
      if (!Array.isArray(list)) return []
      return list
        .filter(function (item) {
          return item !== null && typeof item === 'object' && typeof item.host === 'string'
        })
        .map(function (item) {
          return Object.assign({}, item, { groupId: groupIdOf(item) })
        })
    }

    /** 快速命令归一化：兼容早期单命令写法，统一成 {id,name,label,inputOnly,commands:[{command,delay}]}。 */
    function normalizeQuickCommandList(list) {
      if (!Array.isArray(list)) return []
      var out = []
      list.forEach(function (item) {
        if (item === null || typeof item !== 'object' || typeof item.name !== 'string') return
        var steps = Array.isArray(item.commands)
          ? item.commands
              .filter(function (step) {
                return step !== null && typeof step === 'object'
              })
              .map(function (step) {
                return {
                  command: typeof step.command === 'string' ? step.command : '',
                  delay: Number(step.delay) || 0,
                }
              })
          : typeof item.command === 'string' && item.command !== ''
            ? [{ command: item.command, delay: 0 }]
            : []
        if (steps.length === 0) return
        out.push({
          id: typeof item.id === 'string' ? item.id : 'qc-' + out.length,
          name: item.name,
          label: typeof item.label === 'string' ? item.label : '',
          /* 编辑保存时保留 electerm 的多标签，避免只剩首个分类。 */
          labels: Array.isArray(item.labels)
            ? item.labels.filter(function (name) { return typeof name === 'string' && name !== '' })
            : [],
          inputOnly: item.inputOnly === true,
          commands: steps,
        })
      })
      return out
    }

    function bookmarksOfGroup(list, groupId) {
      return list.filter(function (item) {
        return groupIdOf(item) === groupId
      })
    }

    /* ---------- 书签文件（bookmarks.json） ----------
       文件放在 `<插件目录>/.dsh-terminal-workbench/bookmarks.json`，浏览器启动时拉取。
       只补/更新文件里声明过的条目：UI 里新增的书签不会被文件覆盖，删掉的书签
       也不会因为文件没变而被重新加回来。文件内容改了，对应条目才重新生效。 */

    var FILE_BOOKMARKS_URL = '/__dsh-terminal-workbench/bookmarks.json'
    var FILE_BOOKMARKS_SEEN_KEY = 'dsh-terminal-workbench.file-bookmarks-seen'

    function fileBookmarkHash(text) {
      var hash = 2166136261
      for (var index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
      }
      return (hash >>> 0).toString(36)
    }

    function bookmarkIdentityOf(mark) {
      if (typeof mark.id === 'string' && mark.id !== '') return 'id:' + mark.id
      return ['endpoint', mark.user || '', mark.host || '', mark.port || 22].join('|')
    }

    function readSeenFileBookmarks() {
      try {
        var raw = JSON.parse(window.localStorage.getItem(FILE_BOOKMARKS_SEEN_KEY) ?? '{}')
        return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
      } catch (error) {
        return {}
      }
    }

    function normalizeFileBookmark(raw, groups) {
      if (raw === null || typeof raw !== 'object') return undefined
      var host = String(raw.host ?? '').trim()
      if (host === '') return undefined
      var port = Number(raw.port) || 22
      var user = String(raw.user ?? '').trim()
      var endpoint = [user, host, port].join('|')
      var groupName = String(raw.group ?? raw.groupName ?? '').trim()
      var groupId =
        typeof raw.groupId === 'string' && raw.groupId.trim() !== '' ? raw.groupId.trim() : undefined
      if (groupName !== '') {
        var hit = groups.filter(function (group) {
          return String(group.name).trim().toLowerCase() === groupName.toLowerCase()
        })[0]
        if (hit === undefined) {
          hit = { id: 'bg-' + fileBookmarkHash(groupName), name: groupName }
          groups.push(hit)
        }
        groupId = hit.id
      }
      return {
        id:
          typeof raw.id === 'string' && raw.id.trim() !== ''
            ? raw.id.trim()
            : 'bm-file-' + fileBookmarkHash(endpoint),
        name: String(raw.name ?? '').trim(),
        user: user,
        host: host,
        port: port,
        groupId: groupId ?? groupIdOf(raw),
        auth: String(raw.auth ?? 'agent'),
        keyPath: String(raw.keyPath ?? '').trim(),
        password: String(raw.password ?? ''),
        remoteDir: String(raw.remoteDir ?? raw.remotePath ?? '').trim(),
        script: String(raw.script ?? '').trim(),
        setEnv: String(raw.setEnv ?? '').trim(),
        lang: String(raw.lang ?? '').trim(),
        localDir: String(raw.localDir ?? raw.localPath ?? '').trim(),
        description: String(raw.description ?? '').trim(),
      }
    }

    /**
     * 拉取并合并书签文件。返回 Promise<boolean>；文件不存在或格式不对时静默跳过。
     * 合并规则：文件里的条目按 id（没 id 按 user@host:port）对号入座；只有文件内容
     * 与上次导入时不同才覆盖，避免每次刷新把 UI 里的修改冲掉。
     */
    function syncFileBookmarks() {
      if (typeof fetch !== 'function') return Promise.resolve(false)
      return fetch(FILE_BOOKMARKS_URL, { cache: 'no-store' })
        .then(function (response) {
          return response !== undefined && response.ok ? response.text() : undefined
        })
        .then(function (text) {
          if (typeof text !== 'string' || text.trim() === '') return false
          /* Windows 记事本可能带 BOM，JSON.parse 不认。 */
          text = text.replace(/^\uFEFF/, '')
          var payload
          try {
            payload = JSON.parse(text)
          } catch (error) {
            console.warn('[terminal-workbench] 书签文件不是合法 JSON，已跳过：', error)
            return false
          }
          var source = Array.isArray(payload) ? { bookmarks: payload } : payload
          if (
            source === null ||
            typeof source !== 'object' ||
            !Array.isArray(source.bookmarks)
          ) {
            console.warn('[terminal-workbench] 书签文件缺少 bookmarks 数组，已跳过')
            return false
          }
          var settings = readSettings()
          var groups = bookmarkGroupsOf(settings).slice()
          var marks = Array.isArray(settings.bookmarks) ? settings.bookmarks.slice() : []
          var seen = readSeenFileBookmarks()
          var nextSeen = {}
          var changed = false

          ;(Array.isArray(source.bookmarkGroups) ? source.bookmarkGroups : []).forEach(function (group) {
            if (group === null || typeof group !== 'object') return
            if (typeof group.id !== 'string' || group.id.trim() === '') return
            var id = group.id.trim()
            var name = String(group.name ?? '').trim() || id
            var at = groups.map(function (item) { return item.id }).indexOf(id)
            if (at < 0) {
              groups.push({ id: id, name: name })
              changed = true
            } else if (String(groups[at].name).trim() !== name) {
              groups[at] = Object.assign({}, groups[at], { name: name })
              changed = true
            }
          })

          source.bookmarks.forEach(function (raw) {
            var mark = normalizeFileBookmark(raw, groups)
            if (mark === undefined) return
            if (
              groups.filter(function (group) {
                return group.id === mark.groupId
              }).length === 0
            ) {
              groups.push({ id: mark.groupId, name: mark.groupId })
              changed = true
            }
            var key = bookmarkIdentityOf(mark)
            var stamp = JSON.stringify(mark)
            if (seen[key] === stamp) {
              nextSeen[key] = stamp
              return
            }
            var at = marks.map(bookmarkIdentityOf).indexOf(key)
            if (at < 0) marks.push(mark)
            else marks[at] = Object.assign({}, marks[at], mark)
            nextSeen[key] = stamp
            changed = true
          })

          try {
            window.localStorage.setItem(FILE_BOOKMARKS_SEEN_KEY, JSON.stringify(nextSeen))
          } catch (error) {
            /* 记不住"上次导入"只会导致下次重复合并，不影响本次 */
          }
          if (changed) writeSettings({ bookmarkGroups: groups, bookmarks: marks })
          return changed
        })
        .catch(function (error) {
          console.warn('[terminal-workbench] 书签文件读取失败，已跳过：', error)
          return false
        })
    }

    /**
     * 书签分组 + 网格。启动页和加号浮层共用同一份渲染。
     *
     * 车号/名字通常很短，竖着一行一个太浪费高度；用 auto-fill 网格，
     * 320px 浮层一行放 3 个、560px 启动卡一行放 5 个左右。
     * 分组标题仍占整行，折叠状态与设置页共用。
     *
     * @param {{ keyword?: string, collapsedGroups?: string[], emptyText?: string, onOpen: function }} options
     * @returns React 节点
     */
    function renderBookmarkGroups(options) {
      var keyword = String((options && options.keyword) || '').trim().toLowerCase()
      var all = readBookmarks().filter(function (mark) {
        if (keyword === '') return true
        return [mark.name, mark.host, mark.user, mark.description]
          .map(function (part) {
            return String(part ?? '')
          })
          .join(' ')
          .toLowerCase()
          .indexOf(keyword) >= 0
      })
      var emptyText =
        options && typeof options.emptyText === 'string'
          ? options.emptyText
          : keyword === ''
            ? '在设置里添加书签'
            : '没有匹配的书签'
      if (all.length === 0) return jsx('div', { className: 'wb-pop-empty', children: emptyText })

      var groups = bookmarkGroupsOf(readSettings()).filter(function (group) {
        return bookmarksOfGroup(all, group.id).length > 0
      })
      if (groups.length === 0) return jsx('div', { className: 'wb-pop-empty', children: emptyText })

      var collapsed = Array.isArray(options && options.collapsedGroups) ? options.collapsedGroups : []
      /* 注意：react/jsx-runtime 的签名是 jsx(type, props, key)，第三个参数是 key，
         不是 children。子节点必须放进 props.children，否则会渲染成空元素。 */
      return jsx('div', {
        className: 'wb-bookmark-groups',
        children: groups.map(function (group) {
          var list = bookmarksOfGroup(all, group.id)
          /* 搜索时强制展开，避免“搜到但看不见”。 */
          var folded = keyword === '' && collapsed.indexOf(group.id) >= 0
          return jsxs(
            'div',
            {
              className: 'wb-bookmark-group',
              'data-bookmark-group': group.id,
              'data-folded': folded ? 'true' : 'false',
              children: [
                jsxs('button', {
                  type: 'button',
                  className: 'wb-pop-groupname',
                  'data-group-toggle': group.id,
                  'aria-expanded': folded ? 'false' : 'true',
                  onClick: function () {
                    toggleCollapsedGroup(group.id)
                  },
                  children: [
                    jsx('span', { className: 'wb-pop-caret', children: folded ? '▸' : '▾' }),
                    jsx('span', { children: group.name }),
                    jsx('span', { className: 'wb-pop-count', children: String(list.length) }),
                  ],
                }),
                folded
                  ? null
                  : jsx('div', {
                      className: 'wb-bookmark-grid',
                      children: list.map(function (mark) {
                        return jsxs(
                          'button',
                          {
                            type: 'button',
                            className: 'wb-pop-item',
                            title: bookmarkTarget(mark),
                            onClick: function () {
                              options.onOpen(mark)
                            },
                            children: [
                              jsx('span', {
                                className: 'wb-pop-dot',
                                style: { background: groupColor(group.id) },
                              }),
                              jsx('span', {
                                className: 'wb-pop-text',
                                children: mark.name || mark.host,
                              }),
                            ],
                          },
                          mark.id ?? mark.host,
                        )
                      }),
                    }),
              ],
            },
            group.id,
          )
        }),
      })
    }

    /* ---------- SSH 会话状态（v0.7.0） ----------
       目标：看得见连接状态、断开能重连、重连回到上次远端目录。
       机制：sshCommand 给远端装一个 OSC7 钩子（bash PROMPT_COMMAND / zsh precmd），
       每次提示符都把 $PWD 用 OSC7 报给 xterm；ssh 进程退出时本地 shell 打一条
       OSC777 信标。SelectionSend 里拿到 xterm 实例后注册这两个 OSC 处理器，
       状态进 SSH_SESSIONS，胶囊 UI 与重连按钮都从这里读。 */

    /** tabId → { bookmark, state:'connected'|'disconnected', rc, cwd, reconnecting }。 */
    var SSH_SESSIONS = {}
    /** tabId → 稳定内容地址（sidebar://terminal/<uuid>）。标签重挂载换了 tabId
        后，靠它把持久会话找回来——否则标题会退回 bash、相机归属也会变空。 */
    var SSH_CONTENT_ID_BY_TAB = {}
    /** 完整 ssh 命令串 → 书签（重连时按命令反查）。 */
    var SSH_BOOKMARK_BY_COMMAND = {}
    /* 命令指纹 → 书签的持久表。刷新页面后 initialInput 已经投递过、不会重发，
       但标签参数里还留着那条命令；内存表却是空的。没有这份兜底，刷新后
       SSH 会话就彻底"失忆"——胶囊消失、重连按钮消失（实测）。只存指纹键，
       值里保留书签原样（与设置里的书签同一敏感级别）。 */
    var SSH_BOOKMARK_STORE_KEY = 'dsh-terminal-workbench.ssh-bookmarks'
    var SSH_BOOKMARK_STORE_LIMIT = 40
    /* tabId → 最近一次 ssh 会话（书签 + 最后目录）。标签 ID 随右栏布局一起
       持久化，刷新后仍是同一个；参数（initialInput）却不是。没有这份记录，
       刷新后 SSH 标签就退化成普通终端：胶囊没了、重连入口也没了。 */
    var SSH_SESSION_STORE_KEY = 'dsh-terminal-workbench.ssh-sessions'
    var SSH_SESSION_STORE_LIMIT = 40
    /** tabId → 当前 xterm 实例（读屏幕尾部判断认证失败用）。 */
    var SSH_TERM_BY_TAB = {}

    function sshTextFingerprint(text) {
      var hash = 2166136261
      var value = String(text)
      for (var index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
      }
      return (hash >>> 0).toString(16)
    }

    function rememberSshBookmark(command, bookmark) {
      SSH_BOOKMARK_BY_COMMAND[command] = bookmark
      try {
        var raw = window.localStorage.getItem(SSH_BOOKMARK_STORE_KEY)
        var store = raw === null ? {} : JSON.parse(raw)
        if (store === null || typeof store !== 'object') store = {}
        store[sshTextFingerprint(command)] = { at: Date.now(), bookmark: bookmark }
        var keys = Object.keys(store)
        if (keys.length > SSH_BOOKMARK_STORE_LIMIT) {
          keys.sort(function (left, right) {
            return Number(store[left]?.at || 0) - Number(store[right]?.at || 0)
          })
          for (var index = 0; index < keys.length - SSH_BOOKMARK_STORE_LIMIT; index += 1) delete store[keys[index]]
        }
        window.localStorage.setItem(SSH_BOOKMARK_STORE_KEY, JSON.stringify(store))
      } catch (error) {
        /* 隐私模式 / 配额满：内存表仍然可用，不影响本次页面内的重连。 */
      }
    }

    function persistedSshBookmark(command) {
      try {
        var raw = window.localStorage.getItem(SSH_BOOKMARK_STORE_KEY)
        if (raw === null) return undefined
        var store = JSON.parse(raw)
        var entry = store[sshTextFingerprint(command)]
        if (entry !== null && typeof entry === 'object' && entry.bookmark !== null && typeof entry.bookmark === 'object') {
          return entry.bookmark
        }
      } catch (error) {
        /* 存储损坏就当没有，别让重连入口跟着挂掉。 */
      }
      return undefined
    }

    function rememberSshContentId(tabId, contentId) {
      if (tabId === undefined || tabId === null) return
      var key = String(tabId)
      var text = typeof contentId === 'string' ? contentId.trim() : ''
      if (text === '') delete SSH_CONTENT_ID_BY_TAB[key]
      else SSH_CONTENT_ID_BY_TAB[key] = text
    }

    function sshContentIdOf(tabId) {
      if (tabId === undefined || tabId === null) return undefined
      var value = SSH_CONTENT_ID_BY_TAB[String(tabId)]
      return typeof value === 'string' && value !== '' ? value : undefined
    }

    function rememberSshSession(tabId, session) {
      if (tabId === undefined || tabId === null) return
      if (session === undefined || session === null || session.bookmark === undefined) return
      try {
        var raw = window.localStorage.getItem(SSH_SESSION_STORE_KEY)
        var store = raw === null ? {} : JSON.parse(raw)
        if (store === null || typeof store !== 'object') store = {}
        store[String(tabId)] = {
          at: Date.now(),
          /* 稳定地址随条目一起存：布局恢复换了 tabId 也能按内容地址找回。 */
          contentId: sshContentIdOf(tabId) ?? '',
          bookmark: session.bookmark,
          cwd: typeof session.cwd === 'string' ? session.cwd : '',
          rawCommand: typeof session.rawCommand === 'string' ? session.rawCommand : '',
          manual: session.manual === true,
          /* 断开状态也要记：刷新页面后如果 ssh 已经死了，恢复成"已断开"，
             重连入口才不会被"已连接"的假象藏起来。 */
          state:
            session.state === 'disconnected' || session.state === 'connecting'
              ? session.state
              : 'connected',
        }
        var keys = Object.keys(store)
        if (keys.length > SSH_SESSION_STORE_LIMIT) {
          keys.sort(function (left, right) {
            return Number(store[left]?.at || 0) - Number(store[right]?.at || 0)
          })
          for (var index = 0; index < keys.length - SSH_SESSION_STORE_LIMIT; index += 1) delete store[keys[index]]
        }
        window.localStorage.setItem(SSH_SESSION_STORE_KEY, JSON.stringify(store))
      } catch (error) {
        /* 隐私模式 / 配额满：只影响刷新恢复。 */
      }
    }

    function sshSessionEntry(raw) {
      var entry = raw
      if (entry === null || typeof entry !== 'object') return undefined
      if (entry.bookmark === null || typeof entry.bookmark !== 'object') return undefined
      return {
        bookmark: entry.bookmark,
        cwd: typeof entry.cwd === 'string' && entry.cwd !== '' ? entry.cwd : undefined,
        rawCommand: typeof entry.rawCommand === 'string' && entry.rawCommand !== '' ? entry.rawCommand : undefined,
        manual: entry.manual === true,
        state:
          entry.state === 'disconnected' || entry.state === 'connecting'
            ? entry.state
            : 'connected',
        storedKey: undefined,
      }
    }

    /**
     * 取回持久会话。先按 tabId 找；找不到再按稳定内容地址找——右栏恢复时
     * tabId 可能重新分配（tab9 → tab10），内容地址不变，会话就不该丢。
     * 命中旧键时把 storedKey 带回去，调用方可以顺手把旧条目迁走。
     */
    function persistedSshSession(tabId, contentId) {
      try {
        var raw = window.localStorage.getItem(SSH_SESSION_STORE_KEY)
        if (raw === null) return undefined
        var store = JSON.parse(raw)
        if (store === null || typeof store !== 'object') return undefined
        var exactKey = String(tabId)
        var entry = sshSessionEntry(store[exactKey])
        if (entry !== undefined) {
          entry.storedKey = exactKey
          return entry
        }
        var address = typeof contentId === 'string' ? contentId.trim() : ''
        if (address === '') return undefined
        var matchedKey
        Object.keys(store).forEach(function (key) {
          var candidate = store[key]
          if (candidate === null || typeof candidate !== 'object') return
          if (candidate.contentId !== address) return
          if (sshSessionEntry(candidate) === undefined) return
          if (matchedKey === undefined || Number(candidate.at || 0) > Number(store[matchedKey]?.at || 0)) {
            matchedKey = key
          }
        })
        if (matchedKey === undefined) return undefined
        entry = sshSessionEntry(store[matchedKey])
        if (entry !== undefined) entry.storedKey = matchedKey
        return entry
      } catch (error) {
        /* 存储损坏就当没有。 */
      }
      return undefined
    }

    /** 只删指定键：迁移时用，不能把刚写入的新 tabId 条目一起清掉。 */
    function forgetPersistedSshSessionKey(tabId) {
      if (tabId === undefined || tabId === null) return
      try {
        var raw = window.localStorage.getItem(SSH_SESSION_STORE_KEY)
        if (raw === null) return
        var store = JSON.parse(raw)
        if (store === null || typeof store !== 'object') return
        if (!Object.prototype.hasOwnProperty.call(store, String(tabId))) return
        delete store[String(tabId)]
        window.localStorage.setItem(SSH_SESSION_STORE_KEY, JSON.stringify(store))
      } catch (error) {
        /* 删除失败不影响当前会话。 */
      }
    }

    function forgetPersistedSshSession(tabId) {
      forgetPersistedSshSessionKey(tabId)
    }

    /** 标签真正关闭时，把同一稳定地址的残留条目一起清掉。 */
    function forgetPersistedSshSessionByContentId(contentId) {
      var address = typeof contentId === 'string' ? contentId.trim() : ''
      if (address === '') return
      try {
        var raw = window.localStorage.getItem(SSH_SESSION_STORE_KEY)
        if (raw === null) return
        var store = JSON.parse(raw)
        if (store === null || typeof store !== 'object') return
        var changed = false
        Object.keys(store).forEach(function (key) {
          var candidate = store[key]
          if (candidate !== null && typeof candidate === 'object' && candidate.contentId === address) {
            delete store[key]
            changed = true
          }
        })
        if (changed) window.localStorage.setItem(SSH_SESSION_STORE_KEY, JSON.stringify(store))
      } catch (error) {
        /* 删除失败不影响当前会话。 */
      }
    }

    /* 关页/刷新前把最后目录写回：否则刷新后重连只能回到打开标签时的目录。 */
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('beforeunload', function () {
        Object.keys(SSH_SESSIONS).forEach(function (tabId) {
          rememberSshSession(tabId, SSH_SESSIONS[tabId])
        })
      })
    }

    /* 自动重连退避：electerm 是固定 3 秒一次；我们在同样的 3 秒起手上加指数
       退避与上限，避免断网时每 3 秒刷一次认证/连接日志。3s → 6s → 12s →
       24s → 30s，最多 5 次。认证失败与用户主动 exit 不自动重试。 */
    var SSH_RETRY_DELAYS = [3000, 6000, 12000, 24000, 30000]
    /* 连接超时（对齐 electerm 默认 sshReadyTimeout=50s）：TCP 层由
       ConnectTimeout=15 兜住，这里兜"握手/认证卡死"——没有它，一次卡住的
       连接会让胶囊永远停在"连接中"，自动重连也不会触发。 */
    var SSH_CONNECT_TIMEOUT = 50000

    function clearSshRetry(session) {
      if (session === undefined || session === null) return
      if (session.retryTimer !== undefined) {
        window.clearTimeout(session.retryTimer)
        session.retryTimer = undefined
      }
    }

    function clearSshConnectTimer(session) {
      if (session === undefined || session === null) return
      if (session.connectTimer !== undefined) {
        window.clearTimeout(session.connectTimer)
        session.connectTimer = undefined
      }
    }

    /** 手输 ssh 没有远端 OSC7 钩子，连上后靠一个短计时器把"连接中"翻成"已连接"。 */
    function clearSshManualTimer(session) {
      if (session === undefined || session === null) return
      if (session.manualTimer !== undefined) {
        window.clearTimeout(session.manualTimer)
        session.manualTimer = undefined
      }
    }

    function markSshConnected(tabId) {
      var session = SSH_SESSIONS[tabId]
      if (session === undefined || session.state !== 'connecting') return false
      session.state = 'connected'
      session.rc = undefined
      session.failure = undefined
      session.reconnecting = false
      clearSshConnectTimer(session)
      clearSshManualTimer(session)
      clearSshRetry(session)
      session.retryCount = 0
      session.retryExhausted = false
      emitSshState(tabId)
      return true
    }

    function armSshManualConnectedTimer(tabId, session) {
      if (session === undefined || session === null || session.manual !== true) return
      clearSshManualTimer(session)
      session.manualTimer = window.setTimeout(function () {
        session.manualTimer = undefined
        var now = SSH_SESSIONS[tabId]
        if (now === undefined || now !== session || now.state !== 'connecting') return
        /* 认证失败 / 连接错误会先出现在屏幕尾部：别把它误翻成已连接。 */
        if (looksLikeAuthFailure(tabId) || looksLikeSshDisconnect(tabId)) {
          markSshDisconnected(tabId, 255)
          return
        }
        markSshConnected(tabId)
      }, 1200)
    }

    function armSshConnectTimer(tabId, session) {
      if (session === undefined || session === null) return
      clearSshConnectTimer(session)
      session.connectTimer = window.setTimeout(function () {
        session.connectTimer = undefined
        if (session.state !== 'connecting') return
        if (typeof window !== 'undefined' && window.__TWB_DEBUG_SSH) {
          console.log('[twb-ssh] connect timeout tabId=' + tabId)
        }
        markSshDisconnected(tabId, undefined)
      }, SSH_CONNECT_TIMEOUT)
    }

    /* 已绑过 OSC 处理器的 xterm 实例 → 绑定记录。用 WeakMap 而不是 WeakSet：
       SelectionSend 会因为 props 变化反复重跑 effect，若每次 dispose+重注册，
       就会与渲染 chunk 自己的 OSC7 处理器抢位置（后来者覆盖），出现"信标到了
       但胶囊不动"。实例只要还在，处理器就该一直在——但**标签身份会变**
       （标签复用 / 重挂载到新 tabId），所以记录的是可变对象 { tabId }，
       处理器每次触发时读 record.tabId，而不是永久闭包首次绑定的那个值。
       （v0.7.1 修复：旧实现闭包捕获 tabId，实例被另一个标签复用后信标仍投递
       到旧标签，当前标签状态永远不更新——表现为"已断开但仍显示已连接"。） */
    var SSH_BOUND = new WeakMap()

    /**
     * 标签销毁：清掉该标签的会话状态与重连登记。
     * 之前没有任何清理——模块级 SSH_SESSIONS 以 tabId 为键，标签关掉后条目
     * 还在；若宿主复用了同一个 tabId，新标签会直接继承旧的 connected 状态，
     * 表现就是"明明没连却显示已连接"（刷新才恢复，因为模块内存被重建）。
     */
    function forgetSshSession(tabId) {
      if (tabId === undefined || tabId === null) return
      var had = Object.prototype.hasOwnProperty.call(SSH_SESSIONS, tabId)
      var session = SSH_SESSIONS[tabId]
      var contentId = sshContentIdOf(tabId)
      if (session !== undefined) {
        clearSshRetry(session)
        clearSshConnectTimer(session)
        clearSshManualTimer(session)
      }
      delete SSH_SESSIONS[tabId]
      delete SSH_RECONNECT[tabId]
      delete SSH_TERM_BY_TAB[tabId]
      forgetPersistedSshSession(tabId)
      if (contentId !== undefined) forgetPersistedSshSessionByContentId(contentId)
      delete SSH_CONTENT_ID_BY_TAB[String(tabId)]
      if (had) emitSshState(tabId)
    }

    /** 会话状态变了：通知 UI。 */
    function emitSshState(tabId) {
      window.dispatchEvent(new CustomEvent('dsh-terminal-workbench:ssh-state', { detail: { tabId: tabId } }))
    }

    /* ---------- OSC 133 命令块（v0.9.0 / S4） ----------
       目标：只**记录**命令块的行号区间，不接管渲染。
       远端 bootstrap 打 A/B/C/D 四个标记；这里把 C→D 之间的输出区间记成
       一条 Block，边距条、块跳转、块头都从这份数据读。xterm 仍照常渲染字符流，
       所以 zsh-syntax-highlighting / zsh-vi-mode / tmux 都不会被我们改坏。

       行号用 xterm 的 marker 锚定，而不是裸数字：回滚缓冲达到上限开始裁行时，
       数字会整体漂移，marker 会跟着内容走。marker 失效（行已被裁掉）时再退回
       数字，只影响早已滚出缓冲的块。 */
    var TERMINAL_BLOCKS = Object.create(null)
    var TERMINAL_BLOCK_OPEN = Object.create(null)
    var TERMINAL_BLOCK_PROMPT = Object.create(null)
    var TERMINAL_CWD = Object.create(null)
    var TERMINAL_BLOCK_SEQ = 0
    var TERMINAL_BLOCK_LIMIT = 500

    /** 解析 OSC 133 的 payload（`A` / `B` / `C` / `D;1`）。无法识别返回 null。 */
    function parseOsc133(data) {
      var text = String(data === undefined || data === null ? '' : data)
      if (text === '') return null
      var cut = text.indexOf(';')
      var kind = cut === -1 ? text : text.slice(0, cut)
      var rest = cut === -1 ? '' : text.slice(cut + 1)
      if (kind !== 'A' && kind !== 'B' && kind !== 'C' && kind !== 'D') return null
      if (kind !== 'D') return { kind: kind, payload: rest }
      var rcText = rest.split(';')[0]
      var rc = rcText === '' ? null : Number(rcText)
      return { kind: 'D', exitCode: Number.isFinite(rc) ? rc : null, payload: rest }
    }

    /** 毫秒 → 块头耗时。短命令不显示 `0.0s` 这种没有信息量的文本。 */
    function formatBlockDuration(ms) {
      var n = Number(ms)
      if (!Number.isFinite(n) || n < 0) return ''
      if (n < 1000) return Math.round(n) + 'ms'
      if (n < 60000) {
        var seconds = n / 1000
        return (seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))) + 's'
      }
      var minutes = Math.floor(n / 60000)
      var rest = Math.round((n % 60000) / 1000)
      if (rest === 60) {
        minutes += 1
        rest = 0
      }
      return minutes + 'm' + (rest < 10 ? '0' : '') + rest + 's'
    }

    /**
     * 从 buffer 里截命令文本：B 标记之后到 C 标记之前。
     * 纯函数，给测试用；buffer 只需实现 `getLine(y)`，行只需实现
     * `translateToString(trimRight)`。
     */
    function extractCommandBetween(buffer, fromLine, fromX, toLine, toX) {
      if (buffer === undefined || buffer === null || typeof buffer.getLine !== 'function') return ''
      var start = Math.max(0, Math.min(fromLine, toLine))
      var end = Math.max(fromLine, toLine)
      var lines = []
      for (var y = start; y <= end; y += 1) {
        var line = buffer.getLine(y)
        var text = ''
        if (line !== undefined && line !== null) {
          text = typeof line.translateToString === 'function' ? line.translateToString(true) : String(line)
        }
        if (y === fromLine && fromX > 0) text = text.slice(fromX)
        if (y === toLine) {
          /* toX 是**原始行**上的绝对列；同一行截取时已经切掉 fromX，
             这里要按剩余长度截，不能再拿绝对列当长度。 */
          var limit = toX - (y === fromLine ? Math.max(0, fromX) : 0)
          if (limit >= 0) text = text.slice(0, limit)
        }
        lines.push(text)
      }
      /* 命令末尾的回车/空行不属于命令本身；行内缩进保留（可能有 heredoc）。 */
      return lines.join('\n').replace(/[ \t]+$/gm, '').replace(/^\n+/, '').replace(/\n+$/, '')
    }

    function bufferOf(term) {
      return term === undefined || term === null ? undefined : term.buffer?.active
    }

    function cursorLineOf(buffer) {
      if (buffer === undefined || buffer === null) return -1
      var base = Number(buffer.baseY)
      var cursor = Number(buffer.cursorY)
      if (!Number.isFinite(base) || !Number.isFinite(cursor)) return -1
      return base + cursor
    }

    function createMarker(term, offset) {
      try {
        if (term !== undefined && term !== null && typeof term.registerMarker === 'function') {
          var marker = term.registerMarker(offset === undefined ? 0 : offset)
          if (marker !== undefined && marker !== null && typeof marker.line === 'number') return marker
        }
      } catch (error) {
        /* 没有 marker API 时退回裸行号 */
      }
      return undefined
    }

    function markerLineOf(marker, fallback) {
      if (marker !== undefined && marker !== null && typeof marker.line === 'number' && marker.line >= 0) {
        return marker.line
      }
      return typeof fallback === 'number' ? fallback : -1
    }

    function disposeMarker(marker) {
      try {
        if (marker !== undefined && marker !== null && typeof marker.dispose === 'function') marker.dispose()
      } catch (error) {
        /* terminal 已销毁时 dispose 可能抛错，忽略 */
      }
    }

    function blockStartLineOf(block) {
      if (block === undefined || block === null) return -1
      return markerLineOf(block.startMarker, block.startLine)
    }

    function blockEndLineOf(block, term) {
      if (block === undefined || block === null) return -1
      if (block.endMarker !== undefined && block.endMarker !== null) {
        return markerLineOf(block.endMarker, block.endLine)
      }
      if (block.endedAt === undefined) {
        var buffer = bufferOf(term)
        if (buffer !== undefined) return cursorLineOf(buffer)
      }
      return typeof block.endLine === 'number' ? block.endLine : -1
    }

    function blockStateOf(block) {
      if (block === undefined || block === null) return 'unknown'
      if (block.endedAt === undefined) return 'running'
      if (block.exitCode === 0) return 'ok'
      if (Number.isFinite(block.exitCode)) return 'fail'
      return 'unknown'
    }

    function emitTerminalBlocks(tabId) {
      try {
        window.dispatchEvent(
          new CustomEvent('dsh-terminal-workbench:blocks', { detail: { tabId: tabId } }),
        )
      } catch (error) {
        /* 测试环境没有 CustomEvent 时不影响块记录 */
      }
    }

    /** 已结束的块 + 正在执行的块（执行中的块排在最后）。 */
    function terminalBlocksOf(tabId) {
      var list = TERMINAL_BLOCKS[tabId]
      var result = list === undefined ? [] : list.slice()
      var open = TERMINAL_BLOCK_OPEN[tabId]
      if (open !== undefined) result.push(open)
      return result
    }

    function findTerminalBlock(tabId, id) {
      var list = terminalBlocksOf(tabId)
      for (var index = 0; index < list.length; index += 1) {
        if (list[index].id === id) return list[index]
      }
      return undefined
    }

    /**
     * 关闭当前块并入库。exitCode 为 null/undefined 表示未知
     * （例如下一条命令开始时还没收到上一条的 D）。
     */
    function closeTerminalBlock(tabId, term, exitCode, reason) {
      var block = TERMINAL_BLOCK_OPEN[tabId]
      if (block === undefined) return undefined
      delete TERMINAL_BLOCK_OPEN[tabId]
      var buffer = bufferOf(term)
      block.endedAt = Date.now()
      block.exitCode = Number.isFinite(exitCode) ? exitCode : undefined
      block.endMarker = createMarker(term, 0)
      block.endLine = buffer === undefined ? block.outputStartLine : cursorLineOf(buffer)
      if (reason !== undefined) block.reason = reason
      var list = TERMINAL_BLOCKS[tabId]
      if (list === undefined) {
        list = []
        TERMINAL_BLOCKS[tabId] = list
      }
      list.push(block)
      while (list.length > TERMINAL_BLOCK_LIMIT) {
        var removed = list.shift()
        disposeMarker(removed.startMarker)
        disposeMarker(removed.endMarker)
      }
      emitTerminalBlocks(tabId)
      return block
    }

    /** OSC 133 主状态机：与 xterm 实例解耦，方便单测直接驱动。 */
    function handleOsc133(tabId, term, data) {
      if (tabId === undefined || tabId === null || term === undefined || term === null) return false
      var event = parseOsc133(data)
      if (event === null) return false
      var buffer = bufferOf(term)
      if (buffer === undefined) return false
      var line = cursorLineOf(buffer)

      if (event.kind === 'A') {
        /* 上一条命令的 D 落在"新提示符所在行"（命令以换行结尾时的空行）。
           边距条不应该吃进下一行的提示符：把上一块的结束行回退一行。
           只在光标位于行首（cursorX === 0）时做——`printf foo` 这种输出
           不换行、提示符接在同一行的情况必须保留原结束行。 */
        var history = TERMINAL_BLOCKS[tabId]
        var previous = history === undefined ? undefined : history[history.length - 1]
        if (
          previous !== undefined &&
          buffer.cursorX === 0 &&
          line > 0 &&
          line >= previous.outputStartLine &&
          markerLineOf(previous.endMarker, previous.endLine) === line
        ) {
          disposeMarker(previous.endMarker)
          previous.endMarker = createMarker(term, -1)
          previous.endLine = line - 1
        }
        var oldPrompt = TERMINAL_BLOCK_PROMPT[tabId]
        if (oldPrompt !== undefined) {
          disposeMarker(oldPrompt.startMarker)
          disposeMarker(oldPrompt.endMarker)
        }
        TERMINAL_BLOCK_PROMPT[tabId] = {
          startMarker: createMarker(term, 0),
          startLine: line,
          cwd: TERMINAL_CWD[tabId],
        }
        return true
      }

      if (event.kind === 'B') {
        var prompt = TERMINAL_BLOCK_PROMPT[tabId]
        if (prompt === undefined) {
          prompt = { startMarker: createMarker(term, 0), startLine: line, cwd: TERMINAL_CWD[tabId] }
          TERMINAL_BLOCK_PROMPT[tabId] = prompt
        }
        prompt.endMarker = createMarker(term, 0)
        prompt.endLine = line
        prompt.endX = Number.isFinite(buffer.cursorX) ? buffer.cursorX : 0
        return true
      }

      if (event.kind === 'C') {
        var started = TERMINAL_BLOCK_PROMPT[tabId]
        var fromLine = line
        var fromX = 0
        if (started !== undefined) {
          fromLine = markerLineOf(
            started.endMarker,
            typeof started.endLine === 'number' ? started.endLine : started.startLine,
          )
          fromX = Number.isFinite(started.endX) ? started.endX : 0
        }
        var command = started === undefined
          ? ''
          : extractCommandBetween(buffer, fromLine, fromX, line, buffer.cursorX)
        /* 少数 shell 集成会把命令塞在 C 的 payload 里（`133;C;ls`）；
           缓冲区截不到时用 payload 兜底，避免块头只有空命令。 */
        if (command === '' && event.payload !== '') command = event.payload

        /* 没收到 D 就又来 C（集成不完整/命令被信号打断）：先把上一条收尾，
           不能让它永远停在 running。 */
        if (TERMINAL_BLOCK_OPEN[tabId] !== undefined) {
          closeTerminalBlock(tabId, term, null, 'interrupted')
        }

        var startLine = started === undefined ? line : started.startLine
        var block = {
          id: ++TERMINAL_BLOCK_SEQ,
          tabId: tabId,
          command: command,
          cwd: started !== undefined && started.cwd !== undefined ? started.cwd : TERMINAL_CWD[tabId],
          startedAt: Date.now(),
          endedAt: undefined,
          exitCode: undefined,
          startMarker:
            started !== undefined && started.startMarker !== undefined
              ? started.startMarker
              : createMarker(term, 0),
          startLine: startLine,
          outputStartLine: line,
          endMarker: undefined,
          endLine: undefined,
        }
        if (started !== undefined) disposeMarker(started.endMarker)
        delete TERMINAL_BLOCK_PROMPT[tabId]
        TERMINAL_BLOCK_OPEN[tabId] = block
        emitTerminalBlocks(tabId)
        return true
      }

      /* D：命令结束。首个提示符的 D 没有对应 C，直接忽略。 */
      closeTerminalBlock(tabId, term, event.exitCode, undefined)
      return true
    }

    /** 标签销毁：块、未闭合的块、未消费的提示符一起清掉，marker 一并释放。 */
    function forgetTerminalBlocks(tabId) {
      if (tabId === undefined || tabId === null) return
      var list = TERMINAL_BLOCKS[tabId]
      if (list !== undefined) {
        for (var index = 0; index < list.length; index += 1) {
          disposeMarker(list[index].startMarker)
          disposeMarker(list[index].endMarker)
        }
        delete TERMINAL_BLOCKS[tabId]
      }
      var open = TERMINAL_BLOCK_OPEN[tabId]
      if (open !== undefined) {
        disposeMarker(open.startMarker)
        disposeMarker(open.endMarker)
        delete TERMINAL_BLOCK_OPEN[tabId]
      }
      var prompt = TERMINAL_BLOCK_PROMPT[tabId]
      if (prompt !== undefined) {
        disposeMarker(prompt.startMarker)
        disposeMarker(prompt.endMarker)
        delete TERMINAL_BLOCK_PROMPT[tabId]
      }
      delete TERMINAL_CWD[tabId]
    }

    /**
     * 预览位置 → 上一个/下一个块。找不到时环回另一端，
     * 键盘导航在第一个块上按 ↑ 会落到最后一个块。
     */
    function neighborTerminalBlock(tabId, anchorLine, direction) {
      var list = terminalBlocksOf(tabId).filter(function (block) {
        return blockStartLineOf(block) >= 0
      })
      if (list.length === 0) return undefined
      list.sort(function (a, b) { return blockStartLineOf(a) - blockStartLineOf(b) })
      if (direction < 0) {
        var previous
        for (var index = 0; index < list.length; index += 1) {
          if (blockStartLineOf(list[index]) < anchorLine) previous = list[index]
          else break
        }
        return previous === undefined ? list[list.length - 1] : previous
      }
      for (var next = 0; next < list.length; next += 1) {
        if (blockStartLineOf(list[next]) > anchorLine) return list[next]
      }
      return list[0]
    }

    /**
     * 把 ssh 退出码翻译成用户能懂的原因。
     * ssh 退出码是有语义的（OpenSSH 手册 EXIT STATUS）：255 是 ssh 自身出错
     * （连接失败/认证失败/主机不可达），1 是远端命令失败，0 是正常退出。
     * 之前一律显示"已断开（rc=255）"，用户拿不到任何可行动信息。
     */
    function sshFailureOf(rc) {
      if (!Number.isFinite(rc)) return undefined
      if (rc === 0) return 'closed'
      if (rc === 255) return 'connect'
      if (rc === 1) return 'remote'
      return 'unknown'
    }

    /**
     * 读 xterm 屏幕尾部文本。ssh 把认证失败、主机密钥不匹配都归到退出码 255，
     * 唯一能区分的地方就是屏幕上的 stderr——不看它就只能把"密码错"也当成
     * 网络抖动去自动重试（重试 5 次全错，还可能触发账号锁定）。
     */
    function sshTailText(tabId, count) {
      var term = SSH_TERM_BY_TAB[tabId]
      if (term === undefined || term === null) return ''
      try {
        var buffer = term.buffer?.active
        if (buffer === undefined || buffer === null) return ''
        var end = buffer.baseY + buffer.cursorY
        var start = Math.max(0, end - count + 1)
        var lines = []
        for (var index = start; index <= end; index += 1) {
          var line = buffer.getLine(index)
          if (line !== undefined) lines.push(line.translateToString(true))
        }
        return lines.join('\n')
      } catch (error) {
        return ''
      }
    }

    var SSH_AUTH_FAILURE_PATTERNS = [
      /Permission denied/i,
      /Authentication failed/i,
      /Too many authentication failures/i,
      /Host key verification failed/i,
      /No supported authentication methods available/i,
      /Load key .*: invalid format/i,
      /Bad permissions/i,
    ]

    /* 手输 ssh 没有 OSC777 信标：靠 ssh 自己打到屏幕上的断线文本兜底。
       只收明确表示连接结束的句子，避免把用户在远端 grep 到的普通文本误判。 */
    var SSH_DISCONNECT_PATTERNS = [
      /client_loop:\s*send disconnect/i,
      /Broken pipe/i,
      /Connection to .* closed/i,
      /Connection closed by/i,
      /Connection reset by peer/i,
      /Connection timed out/i,
      /Disconnected from/i,
      /packet_write_wait/i,
      /Timeout, server .* not responding/i,
      /kex_exchange_identification/i,
      /No route to host/i,
      /Network is unreachable/i,
      /Connection refused/i,
    ]

    /* 屏幕兜底用的强断线信号：不把裸 `Broken pipe` 算进来，避免远端
       日志里正常出现这个词时误判。`client_loop: send disconnect` 已经
       覆盖了 ssh 自己打的那行。 */
    var SSH_DISCONNECT_PROMPT_PATTERNS = [
      /client_loop:\s*send disconnect/i,
      /Connection to .* closed/i,
      /Connection closed by/i,
      /Connection reset by peer/i,
      /packet_write_wait/i,
      /Timeout, server .* not responding/i,
      /kex_exchange_identification/i,
      /No route to host/i,
      /Network is unreachable/i,
      /ssh: connect to host .* Connection refused/i,
    ]

    /* 屏幕兜底里的认证失败信号。比 authFailureText 窄：`Permission denied`
       单独出现可能只是用户 sudo 被拒，不能据此判断 ssh 掉了。 */
    var SSH_AUTH_PROMPT_PATTERNS = [
      /Permission denied \((?:publickey|password|keyboard-interactive)/i,
      /Authentication failed/i,
      /Too many authentication failures/i,
      /Host key verification failed/i,
      /No supported authentication methods available/i,
      /Load key .*: invalid format/i,
    ]

    /* 弱信号：本地 shell 对被杀进程打的一行。只允许出现在最后几行，
       否则翻到很久以前的 "Terminated" 会误判断线。 */
    var SSH_DISCONNECT_WEAK = /^\s*(?:已终止|Terminated|Killed|Hangup|已挂断)\s*$/m

    function authFailureText(text) {
      if (typeof text !== 'string' || text === '') return false
      for (var index = 0; index < SSH_AUTH_FAILURE_PATTERNS.length; index += 1) {
        if (SSH_AUTH_FAILURE_PATTERNS[index].test(text)) return true
      }
      return false
    }

    function strongAuthFailureText(text) {
      if (typeof text !== 'string' || text === '') return false
      for (var index = 0; index < SSH_AUTH_PROMPT_PATTERNS.length; index += 1) {
        if (SSH_AUTH_PROMPT_PATTERNS[index].test(text)) return true
      }
      return false
    }

    function disconnectText(text) {
      if (typeof text !== 'string' || text === '') return false
      for (var index = 0; index < SSH_DISCONNECT_PATTERNS.length; index += 1) {
        if (SSH_DISCONNECT_PATTERNS[index].test(text)) return true
      }
      var lines = text
        .split('\n')
        .map(function (line) { return line.trim() })
        .filter(function (line) { return line !== '' })
      if (lines.length === 0) return false
      var last = lines[lines.length - 1]
      /* 本地 shell 刚打完「已终止」：立即算断开。 */
      if (SSH_DISCONNECT_WEAK.test(last)) return true
      /* 或者「已终止」后面已经跟了一个空提示符（没有新命令）。
         提示符可能因为窗口窄折成多行，所以在最后 3 行里找弱信号，
         但最后一行必须只剩提示符——带命令就不算。 */
      var promptOnly = /(?:[$#%>]|❯)$/.test(last)
      if (promptOnly && lines.slice(-3).some(function (line) { return SSH_DISCONNECT_WEAK.test(line) })) {
        return true
      }
      return false
    }

    /* 空提示符：只有提示符本身，后面没有跟命令。用于区分「ssh 退出后本地
       shell 已回到前台」和「屏幕上只是留着一条旧提示符 + 用户刚敲的新命令」。 */
    function promptOnlyLine(line) {
      if (typeof line !== 'string') return false
      var text = line.trim()
      if (text === '') return false
      /* user@host:path$ / (venv) user@host:~# / root@host:/tmp% */
      if (/^(?:\([^)]*\)\s*)*[^\s@]+@[^\s:]+(?::[^#$%❯]*)?[$#%❯]$/.test(text)) return true
      /* RHEL 风格：[user@host ~]$ / [root@host ~]# */
      if (/^\[[^\]]+\][$#%❯]$/.test(text)) return true
      /* 裸提示符 $ / # / % / ❯ / > */
      if (/^(?:\([^)]*\)\s*)?[$#%❯>]$/.test(text)) return true
      return false
    }

    /**
     * 屏幕兜底用的断线判定：强断线文本 + 最后一行是空提示符，两个条件
     * 同时成立才算。只看最后 5 个非空行（提示符 + 前面 4 行），避免翻到
     * 很久以前的旧输出；裸 `Broken pipe` 不在强信号里，远端日志正常出现
     * 该词时不会误判。
     */
    function disconnectTextAtPrompt(text) {
      if (typeof text !== 'string' || text === '') return false
      var lines = text
        .split('\n')
        .map(function (line) { return line.trim() })
        .filter(function (line) { return line !== '' })
      if (lines.length < 2) return false
      var last = lines[lines.length - 1]
      var promptStart = lines.length - 1
      if (!promptOnlyLine(last)) {
        /* 提示符比终端宽时会折成两行：末行只剩路径尾巴，上一行是
           user@host:path 前缀。两行合起来仍要求后面没有新命令。 */
        if (
          lines.length >= 3 &&
          /^\S*[$#%❯]$/.test(last) &&
          /^(?:\([^)]*\)\s*)*[^\s@]+@[^\s:]+(?::.*[^#$%❯])?$/.test(lines[lines.length - 2])
        ) {
          promptStart = lines.length - 2
        } else {
          return false
        }
      }
      var start = Math.max(0, promptStart - 4)
      for (var index = start; index < promptStart; index += 1) {
        for (var pattern = 0; pattern < SSH_DISCONNECT_PROMPT_PATTERNS.length; pattern += 1) {
          if (SSH_DISCONNECT_PROMPT_PATTERNS[pattern].test(lines[index])) return true
        }
      }
      return strongAuthFailureText(lines.slice(start, promptStart).join('\n'))
    }

    function looksLikeAuthFailure(tabId) {
      return authFailureText(sshTailText(tabId, 24))
    }

    function looksLikeSshDisconnect(tabId) {
      return disconnectText(sshTailText(tabId, 30))
    }

    /**
     * 书签会话的屏幕兜底（500ms 节流）。OSC777 是实时信标，刷新、WebSocket
     * 重连、标签后台、xterm 重建都会丢；丢了以后只能看屏幕尾部。
     */
    function checkSshTailForDisconnect(tabId, session) {
      var current = session === undefined ? SSH_SESSIONS[tabId] : session
      if (current === undefined || current === null) return false
      if (current.state !== 'connected' && current.state !== 'connecting') return false
      var now = Date.now()
      if (current.tailCheckAt !== undefined && now - current.tailCheckAt < 500) return false
      current.tailCheckAt = now
      var text = sshTailText(tabId, 30)
      if (!disconnectTextAtPrompt(text)) return false
      /* 屏幕上能认出认证失败就按 255 记，避免自动重连把密码错重试到锁号。 */
      markSshDisconnected(tabId, strongAuthFailureText(text) ? 255 : undefined)
      return true
    }

    /**
     * 标记断开（信标与兜底两条路径共用）。rc 未知时传 undefined。
     */
    function markSshDisconnected(tabId, rc) {
      var session = SSH_SESSIONS[tabId]
      if (session === undefined) return false
      if (session.state === 'disconnected') return true
      clearSshRetry(session)
      clearSshConnectTimer(session)
      clearSshManualTimer(session)
      session.state = 'disconnected'
      session.rc = Number.isFinite(rc) ? rc : undefined
      session.failure = sshFailureOf(rc)
      /* 退出码 255 把认证失败和网络失败混在一起，读屏幕尾部再细分。 */
      if (session.failure === 'connect' && looksLikeAuthFailure(tabId)) session.failure = 'auth'
      session.reconnecting = false
      /* 断开时把最后目录写回持久表：刷新后重连能回到原目录。 */
      rememberSshSession(tabId, session)
      emitSshState(tabId)
      /* 自动重连：设置开启才生效；认证失败与用户主动 exit 不重试。 */
      var auto = false
      try { auto = readSettings().sshAutoReconnect === true } catch (error) { auto = false }
      if (!auto || session.failure === 'auth' || session.failure === 'closed') return true
      var attempt = Number.isFinite(session.retryCount) ? session.retryCount : 0
      if (attempt >= SSH_RETRY_DELAYS.length) {
        session.retryExhausted = true
        emitSshState(tabId)
        return true
      }
      var delay = SSH_RETRY_DELAYS[attempt]
      session.retryCount = attempt + 1
      session.reconnecting = true
      emitSshState(tabId)
      session.retryTimer = window.setTimeout(function () {
        session.retryTimer = undefined
        if (session.state !== 'disconnected') return
        session.reconnecting = false
        emitSshState(tabId)
        var fn = SSH_RECONNECT[tabId]
        /* false = 自动重试：保留 retryCount，退避才能逐级加长。 */
        if (typeof fn === 'function') fn(false)
      }, delay)
      return true
    }

      /**
       * 断开兜底：不依赖信标，直接看**本地 shell 是否已经回到前台**。
       * 原理：ssh 是前台阻塞进程，它活着时本地 shell 不显示提示符；它一退出
       * （无论 rc 多少、信标有没有被吞），本地 shell 立刻打自己的提示符
       * （OSC7，file:// 前缀）——本地 OSC7 是可靠的第二信号源。
       * 做法：收到本地 OSC7 时，若仍以为连着，等一小段再核实一次：本地 shell
       * 提示符在这段时间里**没有再次回到远端**就判断开。
       * 注意：本地 OSC7 绝不能写 cwd（会把远端目录顶掉，重连回错目录）。
       */
      function noteLocalPrompt(tabId) {
        var session = SSH_SESSIONS[tabId]
        if (session === undefined) return
        if (session.state !== 'connected' && session.state !== 'connecting') return
        if (session.localPromptSeen === true) return
        session.localPromptSeen = true
        window.setTimeout(function () {
          session.localPromptSeen = false
          var now = SSH_SESSIONS[tabId]
          if (now === undefined || now !== session) return
          /* 这段时间里远端又报了 OSC7（裸路径）说明还连着；没报就是断开了。 */
          if (now.remoteSeenAfterLocal === true) {
            now.remoteSeenAfterLocal = false
            return
          }
          if (now.state === 'connected' || now.state === 'connecting') markSshDisconnected(tabId, undefined)
        }, 1500)
    }

    /**
     * 当前输入行 → ssh 命令。用于用户按 ↑ 从历史里调出 ssh 命令的场景：
     * 这时 onData 只收到方向键转义序列，攒不到命令文本，只能读屏幕上的
     * 光标行。只在行尾/提示符后出现独立 `ssh ` 时才认，避免误把输出当命令。
     */
    function sshCommandFromTermLine(term) {
      try {
        var buffer = term?.buffer?.active
        if (buffer === undefined || buffer === null) return ''
        var line = buffer.getLine(buffer.baseY + buffer.cursorY)
        if (line === undefined || line === null) return ''
        var text = line.translateToString(true)
        var match = /^\s*(?:.*?[$#%>❯]\s*)?(ssh(?:\s|$).*)$/.exec(text)
        if (match === null) return ''
        return match[1].trim()
      } catch (error) {
        return ''
      }
    }

    /**
     * 在终端回滚缓冲里找最后一条可解析的 ssh 命令。
     * 用于刷新后的现场恢复：旧版本没有持久化手输会话，但屏幕上还留着
     * 断开前的命令与断线文本；从后往前找，拿到最近一条能解析的命令。
     */
    function sshCommandFromBuffer(term, maxLines) {
      try {
        var buffer = term?.buffer?.active
        if (buffer === undefined || buffer === null) return ''
        var limit = Number.isFinite(maxLines) && maxLines > 0 ? maxLines : 200
        var end = buffer.baseY + buffer.cursorY
        var start = Math.max(0, end - limit + 1)
        for (var index = end; index >= start; index -= 1) {
          var line = buffer.getLine(index)
          if (line === undefined || line === null) continue
          var text = line.translateToString(true)
          var match = /^\s*(?:.*?[$#%>❯]\s*)?(ssh(?:\s|$).*)$/.exec(text)
          if (match === null) continue
          var command = match[1].trim()
          if (parseSshCommandLine(command) !== undefined) return command
        }
        return ''
      } catch (error) {
        return ''
      }
    }

    /**
     * 现场恢复：没有持久记录、但屏幕尾部有断线文本时，用缓冲区里的
     * ssh 命令建一份「已断开」会话，让「重连」按钮立刻可用。
     */
    function recoverManualSshSession(tabId, command) {
      if (tabId === undefined || tabId === null) return false
      if (SSH_SESSIONS[tabId] !== undefined) return false
      /* 恢复现场时也优先用完整书签，别让刷新后的相机归属退回默认分组。 */
      var bookmark = sshBookmarkByInput(command)
      if (bookmark === undefined) return false
      var session = {
        bookmark: bookmark,
        rawCommand: command,
        manual: true,
        state: 'disconnected',
        rc: undefined,
        /* 现场恢复的是「连过又断了」，不是建连失败：不要显示认证/网络错误。 */
        failure: undefined,
        cwd: undefined,
        reconnecting: false,
        retryCount: 0,
        retryExhausted: false,
      }
      SSH_SESSIONS[tabId] = session
      rememberSshSession(tabId, session)
      emitSshState(tabId)
      return true
    }

    /**
     * 手输 / 快捷命令的 ssh 会话登记。
     *
     * 没有书签就没有 SSH_SESSIONS，胶囊和重连入口都不会出现。这里按解析出的
     * 最小书签建一份 manual 会话：先 connecting，1.2 秒后翻 connected；
     * 断线由屏幕尾部文本兜底（见 SSH_DISCONNECT_PATTERNS）。
     */
    function beginManualSshSession(tabId, command) {
      if (tabId === undefined || tabId === null) return false
      /* 先按命令反查完整书签（带 id / groupId / cameraPrefix）；
         查不到才退回解析出的最小书签，保证手输 ssh 也能登记会话。 */
      var bookmark = sshBookmarkByInput(command)
      if (bookmark === undefined) return false
      var existing = SSH_SESSIONS[tabId]
      if (existing !== undefined && existing.state !== 'disconnected') return false
      var session = existing === undefined ? {} : existing
      session.bookmark = bookmark
      session.rawCommand = command
      session.manual = true
      session.state = 'connecting'
      session.rc = undefined
      session.failure = undefined
      session.cwd = undefined
      session.reconnecting = false
      session.retryCount = 0
      session.retryExhausted = false
      /* 刚敲下 ssh 时屏幕上还留着本地提示符：先跳过 500ms，等命令回显/远端
         输出把尾部顶掉，避免拿旧提示符把新连接误判成断开。 */
      session.tailCheckAt = Date.now()
      SSH_SESSIONS[tabId] = session
      rememberSshSession(tabId, session)
      armSshConnectTimer(tabId, session)
      armSshManualConnectedTimer(tabId, session)
      emitSshState(tabId)
      return true
    }

    /**
     * 在 xterm 实例上挂 OSC7（远端 $PWD）/ OSC777（断开信标）处理器。
     * 幂等：同一实例只挂一次；tabId 变了（标签被复用）也按实例去重。
     */
    function attachSshSession(tabId, term) {
      if (term === undefined || term === null || tabId === undefined) return false
      /* 实例可能已创建但还没 open()/fit 完成：此时它的 parser 尚未接管数据流，
         注册了也收不到任何东西（实测如此）。等尺寸定下来再说。 */
      if (!(term.cols > 0) || !(term.rows > 0)) return false
      var bound = SSH_BOUND.get(term)
      if (bound !== undefined) {
        /* 实例已挂过处理器：只更新绑定身份（标签复用场景），不重复注册。 */
        if (bound.tabId !== tabId) {
          if (SSH_TERM_BY_TAB[bound.tabId] === term) delete SSH_TERM_BY_TAB[bound.tabId]
          bound.tabId = tabId
          term.__twbSshBound = tabId
        }
        SSH_TERM_BY_TAB[tabId] = term
        /* 刷新/标签重挂载后缓冲可能已经回放完毕，onWriteParsed 不会再触发：
           这里补查一次屏幕尾部，避免胶囊一直停在「已连接」。 */
        checkSshTailForDisconnect(tabId)
        return true
      }
      if (typeof term.parser?.registerOscHandler !== 'function') return false
      var record = { tabId: tabId }
      SSH_BOUND.set(term, record)
      SSH_TERM_BY_TAB[tabId] = term
      /* 诊断钩子：调试时可在控制台看有没有真的挂上（不影响行为）。 */
      term.__twbSshBound = tabId
      term.parser.registerOscHandler(7, function (data) {
        /* 读当前绑定身份而非闭包快照：标签复用后信标/目录必须落到新标签。 */
        var tabId = record.tabId
        var session = SSH_SESSIONS[tabId]
        if (typeof window !== 'undefined' && window.__TWB_DEBUG_SSH) {
          console.log('[twb-ssh] osc7 tabId=' + tabId + ' session=' + (session ? session.state : 'MISSING') + ' data=' + String(data))
        }
        var path = String(data ?? '')
        /* 常见形态 file://host/path 或裸路径；取 path 部分。 */
        if (path.startsWith('file://')) {
          var rest = path.slice('file://'.length)
          var slash = rest.indexOf('/')
          path = slash >= 0 ? rest.slice(slash) : '/'
        }
        try { path = decodeURIComponent(path) } catch (error) { /* 原样用 */ }
        /* 即使不是 ssh 会话也记一份 cwd：本地 shell（自带 OSC7 集成）的
           OSC 133 块同样应该有 cwd。ssh 会话的 cwd 仍以 session.cwd 为准。 */
        TERMINAL_CWD[tabId] = path
        if (session === undefined) return false
        /* 收到远端提示符的 $PWD 才算真的连上（此前只是命令投递成功）。
           但**绝不能**把 disconnected 翻回 connected：ssh 掉线后本地 shell 会
           立刻打自己的提示符，它的钩子同样发 OSC7（形如 file://<本机名>/path），
           一旦误判成全绿，断开状态就永远亮不出来（实测踩过）。
           区分办法：远端报的是裸路径，本地报的是 file://<host>/path。
           注意 cwd 也必须在过滤**之后**才写：本地 shell 那条 OSC7 记的是本机
           目录（/workspace），先写进去会把远端 cwd 顶掉，重连就回不到原目录了
           （实测踩过：断开前在 /tmp/twb-e2e，重连却落在 /workspace）。 */
        var fromLocalShell = /^file:\/\//.test(String(data ?? ''))
        if (fromLocalShell) {
          /* 本地 shell 提示符出现 = ssh 可能已退出（兜底信号的触发点）；
             绝不写 cwd——那是本机目录，写进去会让重连回错目录。 */
          noteLocalPrompt(tabId)
          return false
        }
        /* 远端提示符：证明 ssh 还活着，抵消可能误触的本地兜底。 */
        session.remoteSeenAfterLocal = true
        session.cwd = path
        if (session.state === 'connecting') {
          session.state = 'connected'
          session.rc = undefined
          session.failure = undefined
          session.reconnecting = false
          /* 连上了：清掉连接超时与退避计数，下一次掉线重新从 3 秒开始。 */
          clearSshConnectTimer(session)
          clearSshRetry(session)
          session.retryCount = 0
          session.retryExhausted = false
          emitSshState(tabId)
        }
        return false /* 不拦截，让链上其它处理器也看得到 */
      })
      var markDisconnected = markSshDisconnected
      term.parser.registerOscHandler(777, function (data) {
        var tabId = record.tabId
        var text = String(data ?? '')
        if (typeof window !== 'undefined' && window.__TWB_DEBUG_SSH) {
          console.log('[twb-ssh] osc777 tabId=' + tabId + ' session=' + (SSH_SESSIONS[tabId] ? SSH_SESSIONS[tabId].state : 'MISSING') + ' data=' + text)
        }
        if (!text.startsWith('twb-ssh-exit')) return false
        var rc = Number(text.slice('twb-ssh-exit;rc='.length))
        markDisconnected(tabId, Number.isFinite(rc) ? rc : undefined)
        return true /* 消费掉，别让这条控制序列漏进屏幕 */
      })
      /* OSC 133：命令块标记。和 OSC7/777 共用同一个实例绑定记录，
         标签复用后 record.tabId 会自动指向新的块表。 */
      term.parser.registerOscHandler(133, function (data) {
        var tabId = record.tabId
        if (typeof window !== 'undefined' && window.__TWB_DEBUG_SSH) {
          console.log('[twb-blocks] osc133 tabId=' + tabId + ' data=' + String(data))
        }
        return handleOsc133(tabId, term, data)
      })
      /* 手输 ssh 的输入捕获：书签命令在开标签时就能反查到书签；用户直接
         敲 `ssh user@host` 或跑快捷命令时没有书签，只能从按键流里认。
         行缓冲只在本地 shell 侧有效，Enter 时尝试登记 manual 会话；登记
         失败（不是 ssh 命令）就静默丢弃，绝不影响正常输入。 */
      record.line = ''
      if (typeof term.onData === 'function') {
        term.onData(function (data) {
          var text = String(data ?? '')
          if (text === '') return
          /* 一次 onData 可能带多行（粘贴整段命令）：按换行拆开逐段处理，
             否则整段会被当成一次回车，命令文本丢失。 */
          var parts = text.split(/\r\n|\r|\n/)
          for (var partIndex = 0; partIndex < parts.length; partIndex += 1) {
            var part = parts[partIndex]
            if (partIndex > 0) {
              var line = record.line
              record.line = ''
              var tabId = record.tabId
              /* 历史命令（↑ 调出）不会经过可打印字符分支：行缓冲是空的，
                 改读光标行兜底。只在没有缓冲时读，避免误读屏幕输出。 */
              if (line.trim() === '') line = sshCommandFromTermLine(term)
              if (line.trim() !== '') beginManualSshSession(tabId, line)
            }
            if (part === '\u0003' || part === '\u001b') {
              record.line = ''
              continue
            }
            /* 只攒可打印字符，避免方向键/粘贴控制序列污染命令。 */
            if (/^[\x20-\x7e]+$/.test(part)) {
              record.line = (record.line + part).slice(-4096)
            }
          }
        })
      }
      /* 屏幕兜底：手输 ssh 没有 OSC777 信标，书签会话的信标也会在刷新/
         重连/标签重挂载时丢。写入后看屏幕尾部，命中断线特征就翻红。
         节流到 500ms，避免高输出时每帧扫缓冲。 */
      if (typeof term.onWriteParsed === 'function') {
        term.onWriteParsed(function () {
          var tabId = record.tabId
          var session = SSH_SESSIONS[tabId]
          if (session === undefined) {
            /* 刷新后的现场恢复：旧版本没存手输会话，但屏幕尾部还留着
               断线文本。节流扫描，找到最后一条 ssh 命令就建「已断开」会话。 */
            var nowRecover = Date.now()
            if (record.recoveryAt !== undefined && nowRecover - record.recoveryAt < 500) return
            record.recoveryAt = nowRecover
            if (!disconnectText(sshTailText(tabId, 30))) return
            var recovered = sshCommandFromBuffer(term, 200)
            if (recovered !== '') recoverManualSshSession(tabId, recovered)
            return
          }
          if (session.manual === true) {
            /* 手输 ssh 没有书签信标，保留原有宽匹配（含裸 Broken pipe）。 */
            if (session.state !== 'connected') return
            var now = Date.now()
            if (session.tailCheckAt !== undefined && now - session.tailCheckAt < 500) return
            session.tailCheckAt = now
            if (looksLikeSshDisconnect(tabId) || looksLikeAuthFailure(tabId)) {
              markSshDisconnected(tabId, undefined)
            }
            return
          }
          /* 书签会话没有 manual 标记，但同样需要屏幕兜底：信标在刷新/重连/
             标签重挂载时会丢，屏幕上的「断线文本 + 空提示符」是最后一道保险。 */
          checkSshTailForDisconnect(tabId, session)
        })
      }
      /* 现场恢复的同步尝试：刷新后缓冲可能已经回放完毕，onWriteParsed
         不一定会再触发；这里先查一次，能救就直接把「重连」亮出来。 */
      if (SSH_SESSIONS[tabId] === undefined && disconnectText(sshTailText(tabId, 30))) {
        var recoveredCommand = sshCommandFromBuffer(term, 200)
        if (recoveredCommand !== '') recoverManualSshSession(tabId, recoveredCommand)
      }
      /* 已有会话（含刷新恢复的 connected）也先查一次。 */
      checkSshTailForDisconnect(tabId)
      return true
    }

    /** tabId → 重连函数（组件挂载时登记，卸载时摘掉）。 */
    var SSH_RECONNECT = {}

    /** UTF-8 安全 base64：远端引导脚本经 base64 投递，绕开三层 shell 引号嵌套。 */
    function b64utf8(text) {
      var bytes = new TextEncoder().encode(String(text))
      var bin = ''
      for (var index = 0; index < bytes.length; index += 1) bin += String.fromCharCode(bytes[index])
      return btoa(bin)
    }

    /**
     * 远端会话引导（经 base64 落到远端执行）：
     * cd 到起始目录 → 按 $SHELL 装 OSC7 钩子 → exec 用户 shell（保持交互会话）。
     * bash 用 --rcfile（用户 bashrc + PROMPT_COMMAND 钩子），zsh 用 ZDOTDIR，
     * 其它 shell 只保证 cd，不做钩子。钩子只写本会话用的文件，不动用户点文件。
     */
    function remoteBootstrap(remoteDir) {
      var lines = []
      /* TERM 修正：本地 PTY 的 TERM=dumb 会经 ssh 原样带到远端，readline 在
         dumb 终端下不启用交互式补全（Tab 直接失效，实测踩过）。远端是
         伪终端、有能力处理光标控制序列，统一修成 xterm-256color；
         用户显式设置的其它 TERM 不动。 */
      lines.push('case "$TERM" in dumb | "" | unknown) export TERM=xterm-256color ;; esac')
      /* 清屏：ssh 命令本体很长（base64 引导脚本 + 保活 + askpass），本地 shell
         的行编辑器（zsh 的 zle 不走 tty echo，stty -echo 挡不住它）会把投递
         内容显示在屏上；渲染层重挂载还会重放一次投递。与其逐层堵回显，不如
         在远端 shell 就绪瞬间把整屏清掉——用户看到的连接过程是干净的。用
         ANSI 序列而非 clear 命令，不依赖远端 terminfo。 */
      lines.push("printf '\\033[2J\\033[H'")
      if (typeof remoteDir === 'string' && remoteDir !== '') {
        lines.push("cd " + shellQuote(remoteDir) + " 2>/dev/null")
      }
      lines.push('case "$(basename "${SHELL:-/bin/sh}")" in')
      lines.push('*zsh*)')
      lines.push('  d="$HOME/.dsh-twb-zsh"; mkdir -p "$d"')
      lines.push("  { cat \"$HOME/.zshrc\" 2>/dev/null; cat <<'TWBH'")
      /* zsh：precmd_functions / preexec_functions 是官方钩子数组，
         用 prepend 而不是覆盖 `precmd()`，用户自己的钩子（主题、direnv、
         zsh-vi-mode）继续执行。precmd 放最前面，才能拿到上一条命令真实的 $?。 */
      lines.push('__twb_precmd() {')
      lines.push('  local __twb_rc=$?')
      lines.push('  printf \'\\033]133;D;%s\\007\' "$__twb_rc"')
      lines.push('  printf \'\\033]133;A\\007\'')
      lines.push('  printf \'\\033]7;%s\\007\' "$PWD"')
      lines.push('}')
      lines.push('__twb_preexec() {')
      lines.push('  printf \'\\033]133;C\\007\'')
      lines.push('}')
      /* 用户可能在 .zshrc 里 setopt nounset；先判断数组存在再展开，
         否则 `${precmd_functions:#...}` 会把整个会话打断。 */
      lines.push('if (( ${+precmd_functions} )); then')
      lines.push('  precmd_functions=(__twb_precmd ${precmd_functions:#__twb_precmd})')
      lines.push('else')
      lines.push('  precmd_functions=(__twb_precmd)')
      lines.push('fi')
      lines.push('if (( ${+preexec_functions} )); then')
      lines.push('  preexec_functions=(__twb_preexec ${preexec_functions:#__twb_preexec})')
      lines.push('else')
      lines.push('  preexec_functions=(__twb_preexec)')
      lines.push('fi')
      /* B 标记必须贴在提示符末尾：A 在 precmd 里打，B 只能借 PS1 的
         非打印区输出，否则拿不到"提示符结束、命令输入开始"的列位置。 */
      lines.push('if [[ -n "${PS1-}" && "${PS1-}" != *"133;B"* ]]; then')
      lines.push('  PS1="$PS1%{$(printf \'\\033]133;B\\007\')%}"')
      lines.push('fi')
      lines.push('TWBH')
      lines.push('  } > "$d/.zshrc"')
      lines.push('  ZDOTDIR="$d" exec "${SHELL:-zsh}" ;;')
      lines.push('*bash*)')
      lines.push('  h="$HOME/.dsh-twb-bashrc.$$"')
      lines.push("  { cat \"$HOME/.bashrc\" 2>/dev/null; cat <<'TWBH'")
      /* bash：PROMPT_COMMAND 负责 D/A/OSC7（prepend，先拿到真实 $?），
         PS0 负责 C（bash 4.4+ 的"读完命令、执行前"钩子，比 DEBUG trap 干净，
         不会和用户已有的 DEBUG trap 打架）。 */
      lines.push('__twb_precmd() {')
      lines.push('  local __twb_rc=$?')
      lines.push('  printf \'\\033]133;D;%s\\007\' "$__twb_rc"')
      lines.push('  printf \'\\033]133;A\\007\'')
      lines.push('  printf \'\\033]7;%s\\007\' "$PWD"')
      lines.push('}')
      lines.push('if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then')
      lines.push('  PROMPT_COMMAND=(__twb_precmd "${PROMPT_COMMAND[@]}")')
      lines.push('else')
      lines.push('  PROMPT_COMMAND="__twb_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"')
      lines.push('fi')
      /* ${PS0-}/${PS1-}：用户 .bashrc 可能开了 set -u。 */
      lines.push('case "${PS0-}" in')
      lines.push('  *"133;C"*) ;;')
      /* PS0 不走 readline 的提示符宽度计算，不能用 \\[ \\]（会留下
         SOH/STX 控制字节）；直接让 prompt 展开把八进制转成 ESC/BEL。 */
      lines.push('  *) PS0=\'\\033]133;C\\007\'"${PS0-}" ;;')
      lines.push('esac')
      lines.push('case "${PS1-}" in')
      lines.push('  *"133;B"*) ;;')
      lines.push('  *) PS1="${PS1-}\\[\\033]133;B\\007\\]" ;;')
      lines.push('esac')
      /* rcfile 读完即可删：exec 后 PID 不变，$$ 仍指向生成时的那个文件。
         不删的话每连一次就在 $HOME 留一个 .dsh-twb-bashrc.<pid>。 */
      lines.push('rm -f "$HOME/.dsh-twb-bashrc.$$"')
      lines.push('TWBH')
      lines.push('  } > "$h"')
      lines.push('  exec bash --rcfile "$h" -i ;;')
      lines.push('*)')
      lines.push('  exec "${SHELL:-/bin/sh}" ;;')
      lines.push('esac')
      return lines.join('\n')
    }

    /** 本地 shell 里的断开信标：ssh 一退出（掉线/exit/被踢）就发一条 OSC777。 */
    var SSH_EXIT_MARKER = "; printf '\\033]777;twb-ssh-exit;rc=%s\\007' \"$?\""

    /** 重连命令：书签会话复用 sshCommand；手输命令原样重放，保留用户的全部参数。 */
    function sshReconnectCommand(session) {
      if (session === undefined || session === null) return ''
      if (typeof session.rawCommand === 'string' && session.rawCommand.trim() !== '') {
        return session.rawCommand
      }
      if (session.bookmark === undefined || session.bookmark === null) return ''
      var bookmark = Object.assign({}, session.bookmark)
      if (typeof session.cwd === 'string' && session.cwd !== '') bookmark.remoteDir = session.cwd
      return sshCommand(bookmark)
    }

    /** ssh 命令是否走回显抑制：命令里有断开信标字面量即视为 ssh 投递。 */
    var SSH_ECHO_MARK = 'twb-ssh-exit'

    /**
     * 把用户手输 / 快捷命令里的 ssh 命令解析成最小书签。
     *
     * 背景：书签会话有 OSC777 断开信标和完整重连命令；但用户直接在输入框
     * 敲 `ssh user@host`、或用快捷命令连机器时，没有书签可反查，标签就退化
     * 成普通终端——断开后既没有状态胶囊，也没有重连入口（现场实测）。
     *
     * 这里只解析出 host/user/port 用于显示和兜底；重连时优先原样重放
     * `rawCommand`，不重写用户的 -i/-J/-L 等参数，避免"重连后行为变了"。
     * 只认单行、以 ssh 开头的命令；管道/重定向/多行交给用户自己处理。
     */
    function parseSshCommandLine(text) {
      var value = String(text ?? '').trim()
      if (value === '') return undefined
      if (/[\r\n]/.test(value)) return undefined
      /* 工作台生成的命令带断开信标/引导脚本，已经由书签路径处理。 */
      if (value.indexOf(SSH_ECHO_MARK) !== -1) return undefined
      var match = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*ssh(?:\s|$)(.*)$/.exec(value)
      if (match === null) return undefined
      var rest = match[1].trim()
      if (rest === '') return undefined
      /* 管道/重定向/命令串联/命令替换：不接管，用户自己组合的语义原样交给 shell，
         我们只负责纯 ssh 连接（否则重连会重放整条管道，行为不可预期）。 */
      if (/[|&;<>`]|\$\(/.test(rest)) return undefined
      var tokens = rest.split(/\s+/)
      var port = 22
      var user = ''
      var host = ''
      var skipNext = false
      for (var index = 0; index < tokens.length; index += 1) {
        var token = tokens[index]
        if (skipNext) {
          skipNext = false
          continue
        }
        if (token === '-p' || token === '-l') {
          var next = tokens[index + 1] ?? ''
          if (token === '-p') {
            var parsedPort = Number(next)
            if (Number.isFinite(parsedPort) && parsedPort > 0) port = parsedPort
          } else {
            user = next
          }
          skipNext = true
          continue
        }
        var shortPort = /^-p(\d+)$/.exec(token)
        if (shortPort !== null) {
          port = Number(shortPort[1])
          continue
        }
        var shortUser = /^-l(.+)$/.exec(token)
        if (shortUser !== null) {
          user = shortUser[1]
          continue
        }
        /* 这些 ssh 选项都带一个参数：跳过参数，别把参数当成主机。 */
        if (
          token === '-i' || token === '-o' || token === '-J' || token === '-L' ||
          token === '-R' || token === '-D' || token === '-F' || token === '-E' ||
          token === '-b' || token === '-c' || token === '-m' || token === '-O' ||
          token === '-Q' || token === '-S' || token === '-W' || token === '-w'
        ) {
          skipNext = true
          continue
        }
        if (token.charAt(0) === '-') continue
        host = token
        break
      }
      if (host === '') return undefined
      var at = host.lastIndexOf('@')
      if (at >= 0) {
        user = host.slice(0, at)
        host = host.slice(at + 1)
      }
      host = host.replace(/^\[|\]$/g, '')
      if (host === '' || /[;&|<>`$]/.test(host)) return undefined
      var name = host
      var octets = host.split('.')
      if (
        octets.length === 4 &&
        octets.every(function (part) { return /^\d{1,3}$/.test(part) })
      ) {
        name = octets[3]
      }
      return {
        rawCommand: value,
        bookmark: {
          host: host,
          user: user,
          port: port,
          name: name,
          manual: true,
          rawCommand: value,
        },
      }
    }

        /**
     * ssh 命令投递：直投原命令。曾试过「stty -echo + head 吞行」两段式隐藏
     * 回显，实测在 zsh 下不可靠——zle 一次性大块读 tty，第二段可能被 zle
     * 缓冲截走而不是交给 head，连接变成竞态（时好时坏）。回显抑制最终交给
     * remoteBootstrap 开头的 ANSI 清屏：连接完成瞬间整屏清空，回显串只在
     * 连接过程中闪现不到一秒，屏幕不留长串。
     */
    function sshInitialInput(command) {
      return command
    }

    /**
     * 按 initialInput 反查 ssh 书签：原始命令直接查；回显抑制包装形式
     * （' stty -echo\r' + 命令）解包后查。查不到返回 undefined。
     */
    function sshBookmarkByInput(input) {
      if (typeof input !== 'string' || input === '') return undefined
      var direct = SSH_BOOKMARK_BY_COMMAND[input]
      if (direct !== undefined) return direct
      /* 刷新页面后内存表是空的：按命令指纹从 localStorage 兜底取回。 */
      var persisted = persistedSshBookmark(input)
      if (persisted !== undefined) return persisted
      if (input.indexOf(SSH_ECHO_MARK) === -1) {
        /* 没有书签的手输 / 快捷命令：解析成最小书签，至少让胶囊和重连入口存在。 */
        var parsed = parseSshCommandLine(input)
        if (parsed !== undefined) return parsed.bookmark
        return undefined
      }
      /* 回显抑制包装形式：第 1 行（head 吞行脚本）\r 第 2 行（ssh 命令本体）。
         ssh 命令本身不含 \r，取第一个 \r 之后的部分查表。 */
      var cut = input.indexOf('\r')
      var inner = cut === -1 ? input : input.slice(cut + 1)
      return SSH_BOOKMARK_BY_COMMAND[inner] ?? persistedSshBookmark(inner)
    }

    /** 需要时才加引号，避免把简单参数也套上引号。 */
    function shellQuote(value) {
      var text = String(value)
      if (text === '' || /^[\w@%+.,:/-]+$/.test(text)) return text
      /* 一律用单引号：交互式 bash 里双引号内的 ! 会触发历史展开（!# 之类直接报错）。 */
      return "'" + text.replace(/'/g, "'\\''") + "'"
    }

    /** 把书签拼成系统 ssh 命令：端口/用户名/私钥/环境变量/目录/脚本按需拼接。 */
    function bookmarkTarget(bookmark) {
      var host = typeof bookmark.host === 'string' ? bookmark.host.trim() : ''
      var user = typeof bookmark.user === 'string' ? bookmark.user.trim() : ''
      return user === '' ? host : user + '@' + host
    }

    /**
     * 把 jumpHost 解析成 ssh -J 要的 `user@host:port` 串。
     *
     * 允许两种写法：
     *   1. 别名（推荐）—— 从书签表里查，取它的 host/user/port。改跳板配置时
     *      所有引用它的书签一起生效，不用逐条改。
     *   2. 直接写 user@host:port —— 给临时用，不强制建书签。
     *
     * 为什么要支持别名而不是只存地址：跳板机的地址会变（换机、加端口），
     * 存字面值意味着每条书签都要跟着改一遍，漏一条就连不上。
     *
     * @returns {string} 空串表示没配跳板
     */
    function jumpHostSpec(raw) {
      var value = typeof raw === 'string' ? raw.trim() : ''
      if (value === '') return ''
      var marks = readSettings().bookmarks
      for (var i = 0; i < marks.length; i += 1) {
        var item = marks[i]
        if (item !== null && typeof item === 'object' && item.name === value) {
          var user = typeof item.user === 'string' ? item.user.trim() : ''
          var host = typeof item.host === 'string' ? item.host.trim() : ''
          if (host === '') return ''
          var port = Number(item.port)
          var spec = (user === '' ? '' : user + '@') + host
          /* ssh 的 -J 里省略 22 才干净：`:22` 虽合法但会让命令串变长。 */
          if (Number.isFinite(port) && port > 0 && port !== 22) spec += ':' + port
          return spec
        }
      }
      /* 不是别名就原样当地址用。 */
      return value
    }

    /**
     * 把书签里的转发规则转成 ssh 参数对 `[['-L','8080:host:80'], ...]`。
     *
     * 支持三种输入形态，因为用户来源不同：
     *   - 对象 `{type:'L', bind:'…', dest:'…'}` —— 表单产出
     *   - 字符串 `'L 8080:host:80'` —— 手写
     *   - 字符串 `'-L 8080:host:80'` —— 从别处抄来
     *
     * 校验放在这里而不是只在表单：书签可能是导入的，
     * 坏数据不能变成"命令拼出来但 ssh 报错看不懂"。
     */
    function forwardArgsOf(raw) {
      var list = Array.isArray(raw) ? raw : []
      var out = []
      for (var i = 0; i < list.length; i += 1) {
        var spec = parseForwardSpec(list[i])
        if (spec === null) continue
        out.push([spec.flag, spec.text])
      }
      return out
    }

    /**
     * 按冒号切转发串，但忽略方括号里的冒号。
     * `8080:[::1]:80` → ['8080','[::1]','80']；普通 `8080:db:5432` 行为不变。
     */
    function splitForwardColons(text) {
      var parts = []
      var start = 0
      var depth = 0
      for (var index = 0; index < text.length; index += 1) {
        var ch = text.charAt(index)
        if (ch === '[') depth += 1
        else if (ch === ']' && depth > 0) depth -= 1
        else if (ch === ':' && depth === 0) {
          parts.push(text.slice(start, index))
          start = index + 1
        }
      }
      parts.push(text.slice(start))
      return parts
    }

    /** 单条转发 → { flag:'-L', text:'8080:host:80' }；不合法返回 null。 */
    function parseForwardSpec(raw) {
      var type = ''
      var bind = ''
      var dest = ''
      if (typeof raw === 'string') {
        var text = raw.trim()
        if (text === '') return null
        var m = /^-?([LRD])[ ]+(.+)$/i.exec(text)
        if (m === null) return null
        type = m[1].toUpperCase()
        var rest = m[2].trim().split(/\s+/)
        if (rest.length >= 2) {
          /* 空格分两段：`8080 db:5432`（照抄 ssh 命令行参数的写法） */
          bind = rest[0]
          dest = rest.slice(1).join(' ')
        } else {
          /* 单段：`8080:db:5432` 是 bind:dest 合写，`1080` 是纯 bind。
             D 型只有一个端口，剩下两种靠冒号个数判断——
             不能简单按第一个冒号切，因为 bind 可能是 127.0.0.1:8080 这种
             带点带冒号的地址，那样会把主机名切进端口里。 */
          var only = rest[0]
          if (type === 'D') {
            bind = only
          } else {
            /* 从右往左切：目标一定是 host:port 两段，剩下的才是 bind。
               `8080:db:5432` → bind=8080 dest=db:5432
               `127.0.0.1:8080:db:5432` → bind=127.0.0.1:8080 dest=db:5432
               不能从左切（会把 127.0.0.1 当 bind、把 8080 当目标主机）。
               IPv6 必须方括号感知：`8080:[::1]:80` 里的冒号不能当分隔符，
               否则会切成 bind=8080:[、dest=1]:80。 */
            var parts = splitForwardColons(only)
            if (parts.length >= 3) {
              dest = parts.slice(-2).join(':')
              bind = parts.slice(0, -2).join(':')
            } else {
              bind = only
            }
          }
        }
      } else if (raw !== null && typeof raw === 'object') {
        type = String(raw.type || 'L').toUpperCase()
        bind = typeof raw.bind === 'string' ? raw.bind.trim() : ''
        dest = typeof raw.dest === 'string' ? raw.dest.trim() : ''
      } else {
        return null
      }
      if (type !== 'L' && type !== 'R' && type !== 'D') return null
      if (bind === '') return null
      if (type === 'D') return { flag: '-D', text: bind }
      if (dest === '') return null
      return { flag: '-' + type, text: bind + ':' + dest }
    }

    /**
     * 表单里的转发草稿 → 存储用的规范对象数组。
     *
     * 草稿是「一行一条」的宽松输入，存储要的是干净结构：
     * 空行丢弃、不合法丢弃、`L`/`-L` 两种写法归一。这样 `sshCommand`
     * 拼参数时不需要再做判断，坏数据也不会落进 localStorage 变成
     * 下次连接的隐性故障。
     */
    function normalizeForwardDrafts(list) {
      var drafts = Array.isArray(list) ? list : []
      var out = []
      for (var i = 0; i < drafts.length; i += 1) {
        var item = drafts[i]
        if (item === null || typeof item !== 'object') continue
        var type = String(item.type || 'L').toUpperCase()
        if (type !== 'L' && type !== 'R' && type !== 'D') continue
        var bind = typeof item.bind === 'string' ? item.bind.trim() : ''
        var dest = typeof item.dest === 'string' ? item.dest.trim() : ''
        if (bind === '') continue
        if (type === 'D') {
          out.push({ type: 'D', bind: bind })
          continue
        }
        if (dest === '') continue
        out.push({ type: type, bind: bind, dest: dest })
      }
      return out
    }

    /**
     * 无 sshpass 也能把密码喂给 ssh：写一个 0600 的 askpass 脚本，密码内嵌在文件
     * 本体里（经 base64 写入，不进命令行、不进环境变量）。旧方案把密码放在
     * SSH_PW= 环境变量里——那会随命令行进入 ps（任何用户可见）、随进程环境常驻
     * /proc/<pid>/environ；文件方案下 ps 只看得到文件名，且 ssh 退出后立即焚毁
     * （见 sshCommand 尾部的 rm -f）。只在本机落一个临时脚本，不改远端任何配置。
     */
    function askpassBootstrap(password) {
      /* 按本地 shell 的 PID 分文件：两个密码会话同时连接时，
         固定文件名会互相覆盖，先退出的那个还会把另一个正在用的脚本删掉。
         `$$` 在 create/env/rm 三处都由**同一个** shell 展开，指向同一个文件。 */
      var script = '$HOME/.dsh-askpass.$$.sh'
      /* 文件层单引号转义：askpass 是 /bin/sh 执行的，密码里的 ' 要写成 '\''。 */
      var pwLiteral = String(password).replace(/'/g, "'\\''")
      var content = '#!/bin/sh\nprintf \'%s\\n\' \'' + pwLiteral + '\'\n'
      /* base64 写入：密码所有字节原样落盘，绕开 %b 反斜杠解释与多层引号嵌套。 */
      var create =
        'umask 077 && printf %s ' + b64utf8(content) + ' | base64 -d > ' + script + ' && chmod 700 ' + script
      return {
        create: create,
        script: script,
        env: ['SSH_ASKPASS=' + script, 'SSH_ASKPASS_REQUIRE=force'],
      }
    }

    function sshCommand(bookmark) {
      var port = Number(bookmark.port)
      var auth = typeof bookmark.auth === 'string' ? bookmark.auth : 'agent'
      var body = ['ssh']
      if (Number.isFinite(port) && port > 0 && port !== 22) body.push('-p', String(port))
      body.push('-t')
      /* 保活与超时（对齐 electerm 默认 keepaliveInterval=10s / CountMax=10）：
         组网/中继/NAT 链路会回收空闲 TCP 流——不发心跳的连接放几分钟不动就被
         悄悄掐成"半开"，下次敲键才发现死了或被 RST（用户实测：同一台机器
         electerm 不断、本插件总断）。ServerAliveInterval 每 10 秒发一个加密
         心跳保住映射；CountMax=10 表示约 100 秒无响应才判定死链（比原来的
         60 秒更耐短暂抖动，与 electerm 一致）。TCPKeepAlive 让内核也在 TCP
         层保活；ConnectTimeout=15 避免不可达地址把"连接中"拖到几分钟。 */
      body.push(
        '-o', 'ServerAliveInterval=10',
        '-o', 'ServerAliveCountMax=10',
        '-o', 'TCPKeepAlive=yes',
        '-o', 'ConnectTimeout=15',
        /* 首次连接自动接受新主机密钥（TOFU），避免卡在交互式 yes/no 提示；
           已记录过的密钥发生变化仍然拒绝。electerm 的 ssh2 后端默认不做主机
           密钥校验，这里比它更严格一点。 */
        '-o', 'StrictHostKeyChecking=accept-new',
      )
      if (auth === 'key' && typeof bookmark.keyPath === 'string' && bookmark.keyPath !== '') {
        body.push('-i', shellQuote(bookmark.keyPath))
      }
      if (typeof bookmark.setEnv === 'string' && bookmark.setEnv.trim() !== '') {
        body.push('-o', 'SetEnv=' + shellQuote(bookmark.setEnv.trim()))
      }
      var target = bookmark.host
      if (typeof bookmark.user === 'string' && bookmark.user !== '') target = bookmark.user + '@' + target

      /* 跳板（对齐 ssh -J）：书签里存的是别名，这里展开成 user@host:port。
         解析不到就把原文当普通地址用（允许直接填 user@host）。 */
      var jumpSpec = jumpHostSpec(bookmark.jumpHost)
      if (jumpSpec !== '') body.push('-J', shellQuote(jumpSpec))

      /* 端口转发：映射成 -L/-R/-D，交给 ssh 自己管生命周期——
         终端关掉 ssh 退掉，端口自然释放。比自己维护一套监听可靠得多
         （自己管就得处理进程被杀、页面刷新、浏览器崩溃等所有路径）。 */
      var forwardArgs = forwardArgsOf(bookmark.forwards)
      /* 端口被占用/远端拒绝转发时，ssh 默认仍会建立会话，胶囊显示"已连接"
         但隧道实际没起来——现场最容易误判成网络问题。只在真的配了转发时加。 */
      if (forwardArgs.length > 0) body.push('-o', 'ExitOnForwardFailure=yes')
      for (var fi = 0; fi < forwardArgs.length; fi += 1) {
        body.push(forwardArgs[fi][0], shellQuote(forwardArgs[fi][1]))
      }

      /* 书签可能来自 electerm JSON 导入（host/user 零过滤）：这里也必须过 shellQuote，
         否则 host=`x;cmd` 这类值会被整条命令原样执行。 */
      body.push(shellQuote(target))
      var hasScript = typeof bookmark.script === 'string' && bookmark.script.trim() !== ''
      if (hasScript) {
        /* 带脚本：保持旧语义——远端非交互执行后退出（断开信标照样会响）。 */
        var remote = []
        if (typeof bookmark.remoteDir === 'string' && bookmark.remoteDir.trim() !== '') {
          remote.push('cd ' + shellQuote(bookmark.remoteDir.trim()))
        }
        remote.push(bookmark.script.trim())
        body.push(shellQuote(remote.join(' && ')))
      } else {
        /* 无脚本（v0.7.0）：远端引导——cd 起始目录、装 OSC7 目录钩子、exec 用户
           shell 保持交互。引导脚本走 base64，避开 ssh『命令参数即非交互』与
           多层引号两个坑；远端没有 bash/base64 的极端环境退化为普通 ssh 也无害
           （base64 缺失时远端命令失败，ssh 会带着非零 rc 断开，胶囊会亮）。 */
        var script64 = b64utf8(remoteBootstrap(typeof bookmark.remoteDir === 'string' ? bookmark.remoteDir.trim() : ''))
        body.push(
          shellQuote('bash -c "$(printf %s ' + script64 + ' | base64 -d)"'),
        )
      }

      var env = []
      if (typeof bookmark.lang === 'string' && bookmark.lang.trim() !== '') env.push('LANG=' + shellQuote(bookmark.lang.trim()))
      var bootstrap = null
      if (auth === 'password' && typeof bookmark.password === 'string' && bookmark.password !== '') {
        bootstrap = askpassBootstrap(bookmark.password)
        env = env.concat(bootstrap.env)
      }
      var command = (env.length > 0 ? env.join(' ') + ' ' : '') + body.join(' ')
      if (bootstrap !== null) command = ' ' + bootstrap.create + ' && ' + command
      if (typeof bookmark.localDir === 'string' && bookmark.localDir.trim() !== '') {
        command = 'cd ' + shellQuote(bookmark.localDir.trim()) + ' && ' + command
      }
      /* ssh 退出即发断开信标。前台直跑即可：ssh 被 KILL / 掉线 / 正常 exit
         后本地 shell 都会拿回控制权（实测），信标随即输出。
         不要改成 `{ ssh & } ; wait`——交互式 ssh 放后台会立刻因读 tty 而
         suspended (tty input)，反而拖死整个终端。 */
      command = command + SSH_EXIT_MARKER
      /* 密码认证：ssh 退出后立即焚毁 askpass 文件（放在信标之后，不影响 "$?"）。 */
      if (bootstrap !== null) command = command + '; rm -f ' + bootstrap.script
      /* 登记书签，重连按钮按命令反查；同时持久化，刷新页面后仍能恢复。 */
      rememberSshBookmark(command, {
        /* id / groupId 必须一起带：相机书签靠 id 跟随来源 SSH 书签，
           项目归属靠 groupId 解析；少了这两项，面板会把吊具相机分到
           「同一网段」，相机也无法建立来源链接。 */
        id: typeof bookmark.id === 'string' ? bookmark.id : '',
        groupId: typeof bookmark.groupId === 'string' ? bookmark.groupId : '',
        host: bookmark.host,
        user: bookmark.user,
        port: bookmark.port,
        auth: bookmark.auth,
        keyPath: bookmark.keyPath,
        password: bookmark.password,
        remoteDir: bookmark.remoteDir,
        localDir: bookmark.localDir,
        script: bookmark.script,
        lang: bookmark.lang,
        setEnv: bookmark.setEnv,
        name: bookmark.name,
        /* 相机前缀映射也要带进记录表：悬浮按钮按当前 SSH 会话取前缀，
           少了这一项，书签里填的「相机前缀」在连接后就会失效。 */
        cameraPrefix: bookmark.cameraPrefix,
        /* 跳板与转发也要带进记录表：重连时按同一条命令重建，
           少了这两项就会出现"重连后跳板/隧道莫名其妙没了"。 */
        jumpHost: bookmark.jumpHost,
        forwards: bookmark.forwards,
      })
      return command
    }

    /** 设置内容本体：原生设置分区与右键对话框共用这一份。 */
    function SettingsBody(props) {
      var collapsedGroups = useCollapsedGroups()
      var noticeState = react.useState('')
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      var valueState = react.useState(readSettings)
      var settings = valueState[0]
      var setSettings = valueState[1]
      var commandEditState = react.useState(null)
      var commandEditing = commandEditState[0]
      var setCommandEditing = commandEditState[1]
      var editingState = react.useState(null)
      var editing = editingState[0]
      var setEditing = editingState[1]

      react.useEffect(function () {
        var refresh = function () {
          setSettings(readSettings())
        }
        document.addEventListener('dsh-terminal-workbench:open-settings', refresh)
        return function () {
          document.removeEventListener('dsh-terminal-workbench:open-settings', refresh)
        }
      }, [])

      var apply = function (patch) {
        setSettings(writeSettings(patch))
      }

      var importElecterm = function (event) {
        var file = event.target.files && event.target.files[0]
        event.target.value = ''
        if (file === undefined) return
        file.text().then(function (text) {
          var result = importElectermBookmarks(JSON.parse(text), settings)
          var next = writeSettings({ bookmarkGroups: result.bookmarkGroups, bookmarks: result.bookmarks })
          setSettings(next)
          window.alert('已导入 ' + result.imported + ' 条 electerm 书签')
        }).catch(function (error) {
          window.alert('导入失败：' + (error && error.message ? error.message : 'JSON 格式不正确'))
        })
      }

      var groups = bookmarkGroupsOf(settings)
      var quickList = normalizeQuickCommandList(settings.quickCommands)
      var marks = Array.isArray(settings.bookmarks) ? settings.bookmarks : []

      var blankBookmark = function () {
        return {
          id: 'bm-' + Date.now().toString(36),
          name: '',
          host: '',
          port: '22',
          user: '',
          groupId: groups[0].id,
          groupName: groups[0].name,
          auth: 'agent',
          keyPath: '',
          password: '',
          remoteDir: '',
          script: '',
          setEnv: '',
          lang: '',
          localDir: '',
          description: '',
          jumpHost: '',
          forwards: [],
        }
      }

      var bookmarkForm = function () {
        var setEdit = function (key, value) {
          var next = Object.assign({}, editing)
          next[key] = value
          setEditing(next)
        }
        var field = function (label, key, placeholder, extraClass) {
          return jsxs('div', {
            className: 'wb-form-row',
            children: [
              jsx('span', { className: 'wb-form-label', children: label }),
              jsx('input', {
                className: 'wb-set-input' + (extraClass === undefined ? '' : extraClass),
                placeholder: placeholder,
                value: editing[key] ?? '',
                onChange: function (event) {
                  setEdit(key, event.target.value)
                },
              }),
            ],
          })
        }
        var auth = editing.auth ?? 'agent'
        /* 分组名 → 分组：同名（忽略大小写/首尾空格）复用，没有就新建一个。 */
        var resolveGroup = function (rawName) {
          var name = String(rawName ?? '').trim()
          if (name === '') return { id: groups[0].id, name: groups[0].name, created: null }
          for (var index = 0; index < groups.length; index += 1) {
            if (String(groups[index].name).trim().toLowerCase() === name.toLowerCase()) {
              return { id: groups[index].id, name: groups[index].name, created: null }
            }
          }
          var created = { id: 'bg-' + Date.now().toString(36), name: name }
          return { id: created.id, name: name, created: created }
        }
        var save = function () {
          var host = String(editing.host ?? '').trim()
          if (host === '') return null
          var resolved = resolveGroup(editing.groupName)
          var record = {
            id: editing.id,
            name: String(editing.name ?? '').trim(),
            user: String(editing.user ?? '').trim(),
            host: host,
            port: Number(editing.port) || 22,
            groupId: resolved.id,
            auth: auth,
            keyPath: String(editing.keyPath ?? '').trim(),
            password: String(editing.password ?? ''),
            remoteDir: String(editing.remoteDir ?? '').trim(),
            script: String(editing.script ?? '').trim(),
            setEnv: String(editing.setEnv ?? '').trim(),
            /* 相机悬浮按钮的前缀映射：留空按主机前三段推导。 */
            cameraPrefix: normalizeCameraPrefix(editing.cameraPrefix),
            lang: String(editing.lang ?? '').trim(),
            localDir: String(editing.localDir ?? '').trim(),
            description: String(editing.description ?? '').trim(),
            jumpHost: String(editing.jumpHost ?? '').trim(),
            /* 只存合法的转发规则：坏数据在这里被挡掉，
                免得拼出一条 ssh 看不懂的命令（报错信息还很有误导性）。 */
            forwards: normalizeForwardDrafts(editing.forwards),
          }
          var exists = marks.some(function (item) {
            return item.id === record.id
          })
          var patch = {
            bookmarks: exists
              ? marks.map(function (item) {
                  return item.id === record.id ? record : item
                })
              : marks.concat([record]),
          }
          if (resolved.created !== null && resolved.created !== undefined) {
            patch.bookmarkGroups = groups.concat([resolved.created])
          }
          apply(patch)
          return record
        }
        var authChoice = function (value, text) {
          return jsx('button', {
            type: 'button',
            className: 'wb-form-auth-btn' + (auth === value ? ' is-active' : ''),
            'data-auth': value,
            onClick: function () {
              setEdit('auth', value)
            },
            children: text,
          })
        }
        return jsxs('div', {
          className: 'wb-form',
          'data-bookmark-form': '1',
          children: [
            field('标题', 'name', '可留空，默认显示主机'),
            jsxs('div', {
              className: 'wb-form-row',
              children: [
                jsx('span', { className: 'wb-form-label', children: '书签分类' }),
                jsx('input', {
                  className: 'wb-set-input',
                  list: 'tp-bookmark-groups',
                  placeholder: '选已有分组，或输入新名称直接新建',
                  value: editing.groupName ?? '',
                  onChange: function (event) {
                    setEdit('groupName', event.target.value)
                  },
                }),
                jsx('datalist', {
                  id: 'tp-bookmark-groups',
                  children: groups.map(function (item) {
                    return jsx('option', { value: item.name }, item.id)
                  }),
                }),
              ],
            }),
            field('主机地址', 'host', 'hostname 或 IP'),
            field('相机前缀', 'cameraPrefix', '留空按主机前三段，如 192.168.10.'),
            field('端口', 'port', '22', ' wb-set-port-inline'),
            field('用户名', 'user', 'root'),
            jsxs('div', {
              className: 'wb-form-row',
              children: [
                jsx('span', { className: 'wb-form-label', children: '认证方式' }),
                jsxs('div', {
                  className: 'wb-form-auth',
                  children: [authChoice('agent', 'SSH Agent'), authChoice('key', '私钥证书'), authChoice('password', '密码')],
                }),
              ],
            }),
            auth === 'key' ? field('私钥路径', 'keyPath', '~/.ssh/id_rsa') : null,
            auth === 'password'
              ? field('密码', 'password', '明文存在浏览器本地；连接走 SSH_ASKPASS 兜底，无需安装 sshpass')
              : null,
            field('描述', 'description', '备注'),
            field('远程起始目录', 'remoteDir', '/home/user'),
            field('本地起始目录', 'localDir', '/home/user/project'),
            /* 跳板：用 datalist 而不是 select——既能选已有书签，也能直接敲地址。
               为什么只让选**别的**书签：引用自己会造成环，链一出环，
               解析时就得报错，不如在源头就不给选。 */
            jsxs('div', {
              className: 'wb-form-row',
              children: [
                jsx('span', { className: 'wb-form-label', children: '跳板机' }),
                jsx('input', {
                  className: 'wb-set-input',
                  list: 'tp-jump-hosts',
                  placeholder: '留空直连；可填书签名或 user@host:port',
                  value: editing.jumpHost ?? '',
                  onChange: function (event) {
                    setEdit('jumpHost', event.target.value)
                  },
                }),
                jsx('datalist', {
                  id: 'tp-jump-hosts',
                  children: marks
                    .filter(function (item) {
                      return item.id !== editing.id && typeof item.host === 'string' && item.host !== ''
                    })
                    .map(function (item) {
                      return jsx('option', { value: item.name || item.host }, item.host)
                    }),
                }),
              ],
            }),
            /* 端口转发：一行一条，三种类型。默认 L（最常用：连内网服务）。 */
            jsxs('div', {
              className: 'wb-form-row wb-form-row-block',
              children: [
                jsx('span', { className: 'wb-form-label', children: '端口转发' }),
                jsxs('div', {
                  className: 'wb-fwd-list',
                  children: [
                    (Array.isArray(editing.forwards) ? editing.forwards : []).map(function (item, index) {
                      var setFwd = function (key, value) {
                        var next = (editing.forwards || []).slice()
                        next[index] = Object.assign({}, next[index], { [key]: value })
                        setEdit('forwards', next)
                      }
                      var type = String(item.type || 'L').toUpperCase()
                      return jsxs(
                        'div',
                        {
                          className: 'wb-fwd-item',
                          children: [
                            jsx('select', {
                              className: 'wb-fwd-type',
                              value: type,
                              onChange: function (event) {
                                setFwd('type', event.target.value)
                              },
                              children: [
                                jsx('option', { value: 'L' }, '-L 本地'),
                                jsx('option', { value: 'R' }, '-R 远端'),
                                jsx('option', { value: 'D' }, '-D 代理'),
                              ],
                            }),
                            jsx('input', {
                              className: 'wb-set-input',
                              placeholder: '本地 127.0.0.1:8080',
                              value: item.bind ?? '',
                              onChange: function (event) {
                                setFwd('bind', event.target.value)
                              },
                            }),
                            type === 'D'
                              ? jsx('span', { className: 'wb-fwd-note', children: 'SOCKS5' })
                              : jsx('input', {
                                  className: 'wb-set-input',
                                  placeholder: '目标 db.internal:5432',
                                  value: item.dest ?? '',
                                  onChange: function (event) {
                                    setFwd('dest', event.target.value)
                                  },
                                }),
                            jsx('button', {
                              type: 'button',
                              className: 'wb-fwd-del',
                              title: '删除这条转发',
                              onClick: function () {
                                var next = (editing.forwards || []).slice()
                                next.splice(index, 1)
                                setEdit('forwards', next)
                              },
                              children: '×',
                            }),
                          ],
                        },
                        'fwd-' + index,
                      )
                    }),
                    jsx('button', {
                      type: 'button',
                      className: 'wb-set-add-btn wb-fwd-add',
                      onClick: function () {
                        var next = (editing.forwards || []).slice()
                        next.push({ type: 'L', bind: '', dest: '' })
                        setEdit('forwards', next)
                      },
                      children: '+ 添加转发',
                    }),
                  ],
                }),
              ],
            }),
            field('运行脚本', 'script', '连接成功后执行，如 cd app && ls'),
            field('环境变量 SetEnv', 'setEnv', 'SEC=xxx DEC=xxx'),
            field('编码 LANG', 'lang', 'en_US.UTF-8'),
            jsxs('div', {
              className: 'wb-form-actions',
              children: [
                jsx('button', {
                  type: 'button',
                  className: 'wb-set-add-btn',
                  'data-form-save': '1',
                  onClick: function () {
                    if (save() === null) return
                    setEditing(null)
                  },
                  children: '保存',
                }),
                jsx('button', {
                  type: 'button',
                  className: 'wb-set-add-btn',
                  'data-form-connect': '1',
                  onClick: function () {
                    var record = save()
                    if (record === null) return
                    setEditing(null)
                    document.dispatchEvent(
                      new CustomEvent('dsh-terminal-workbench:open-ssh', {
                        detail: { command: sshCommand(record), name: record.name || '' },
                      }),
                    )
                  },
                  children: '保存并连接',
                }),
                jsx('button', {
                  type: 'button',
                  className: 'wb-set-btn-ghost',
                  onClick: function () {
                    if (save() === null) return
                    setEditing(blankBookmark())
                  },
                  children: '保存并新建',
                }),
                jsx('button', {
                  type: 'button',
                  className: 'wb-set-btn-ghost',
                  onClick: function () {
                    setEditing(null)
                  },
                  children: '取消',
                }),
              ],
            }),
          ],
        })
      }

      var row = function (label, hint, control) {
        return jsxs('div', {
          className: 'wb-set-row',
          children: [
            jsxs('div', {
              className: 'wb-set-text',
              children: [
                jsx('span', { className: 'wb-set-label', children: label }),
                hint === undefined ? null : jsx('span', { className: 'wb-set-hint', children: hint }),
              ],
            }),
            control,
          ],
        })
      }

      /* ---------- 分组收纳：五个抽屉，折叠状态记在本地 ---------- */

      var SET_SECTIONS_KEY = 'dsh-terminal-workbench.settings-sections.v1'
      /** 默认收纳的组：低频的大块（命令/书签管理）收起来，外观/行为保持展开。 */
      var SET_SECTIONS_DEFAULT_CLOSED = ['quick', 'groups', 'bookmarks']

      var readSetSections = function () {
        try {
          var raw = JSON.parse(window.localStorage.getItem(SET_SECTIONS_KEY) ?? '{}')
          return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
        } catch (error) {
          return {}
        }
      }

      var secState = react.useState(readSetSections)
      var secMap = secState[0]
      var setSecMap = secState[1]
      var secOpen = function (id) {
        var saved = secMap[id]
        return typeof saved === 'boolean' ? saved : SET_SECTIONS_DEFAULT_CLOSED.indexOf(id) < 0
      }
      var toggleSec = function (id) {
        var next = Object.assign({}, readSetSections())
        next[id] = !secOpen(id)
        try {
          window.localStorage.setItem(SET_SECTIONS_KEY, JSON.stringify(next))
        } catch (error) {
          console.warn('[terminal-workbench] 设置分组状态保存失败：', error)
        }
        setSecMap(next)
      }

      /** 一个可折叠的设置分组。sum 是收起时标题右侧的摘要（条数等）。 */
      var SetSection = function (id, title, sum, children) {
        var open = secOpen(id)
        return jsxs('div', {
          className: 'wb-set-sec',
          'data-open': open ? '1' : '0',
          'data-sec': id,
          children: [
            jsxs('button', {
              type: 'button',
              className: 'wb-set-sec-head',
              'aria-expanded': open ? 'true' : 'false',
              'data-sec-toggle': id,
              onClick: function () {
                toggleSec(id)
              },
              children: [
                jsx('span', { className: 'wb-set-sec-caret', children: '▶' }),
                jsx('span', { className: 'wb-set-sec-title', children: title }),
                sum === undefined || sum === null
                  ? null
                  : jsx('span', { className: 'wb-set-sec-sum', children: sum }),
              ],
            }),
            jsx('div', { className: 'wb-set-sec-body', children: children }),
          ],
        })
      }

      return jsx('div', {
        className: 'wb-set-body',
        'data-tp-settings': '1',
        children: [
              SetSection('appearance', '外观', undefined, [
              row(
                '终端字号',
                '9–28，Ctrl+滚轮也可临时调整',
                jsx('input', {
                  type: 'number',
                  className: 'wb-set-number',
                  min: 9,
                  max: 28,
                  value: settings.fontSize,
                  onChange: function (event) {
                    var next = Math.min(28, Math.max(9, Number(event.target.value) || SETTINGS_DEFAULTS.fontSize))
                    apply({ fontSize: next })
                  },
                }),
              ),
              row(
                '终端配色',
                '只改终端屏幕，不影响界面主题',
                jsx('select', {
                  className: 'wb-set-select',
                  'data-tp-theme': '1',
                  value: settings.theme,
                  onChange: function (event) {
                    apply({ theme: event.target.value })
                  },
                  children: TERMINAL_THEMES.map(function (item) {
                    return jsx('option', { key: item.id, value: item.id, children: item.label })
                  }),
                }),
              ),
              ]),
              SetSection('behavior', '行为', undefined, [
              row(
                '选中即复制',
                '关闭后需要 Ctrl+C 复制',
                jsx('input', {
                  type: 'checkbox',
                  className: 'wb-set-check',
                  checked: settings.copyOnSelect,
                  onChange: function (event) {
                    apply({ copyOnSelect: event.target.checked })
                  },
                }),
              ),
              row(
                'SSH 断线自动重连',
                '断开后按 3s→6s→12s→24s→30s 退避重试，最多 5 次，并回到断开前的远端目录；认证失败不重试',
                jsx('input', {
                  type: 'checkbox',
                  className: 'wb-set-check',
                  checked: settings.sshAutoReconnect === true,
                  onChange: function (event) {
                    apply({ sshAutoReconnect: event.target.checked })
                  },
                }),
              ),
              ]),
              SetSection(
                'quick',
                '快捷命令',
                normalizeQuickCommandList(settings.quickCommands).length + ' 条',
                [
              jsxs('div', {
                className: 'wb-set-group',
                children: [
                  jsx('button', {
                    type: 'button',
                    className: 'wb-set-add-btn',
                    'data-import-quick': '1',
                    onClick: function () {
                      var input = document.querySelector('[data-import-quick-file]')
                      if (input !== null) input.click()
                    },
                    children: '导入 electerm',
                  }),
                  jsx('input', {
                    type: 'file',
                    accept: '.json,application/json',
                    style: { display: 'none' },
                    'data-import-quick-file': '1',
                    onChange: function (event) {
                      var target = event.target
                      var file = target.files && target.files[0]
                      if (!file) return
                      var reader = new FileReader()
                      reader.onload = function () {
                        try {
                          var result = importElectermQuickCommands(
                            String(reader.result ?? ''),
                            readSettings().quickCommands,
                          )
                          apply({ quickCommands: result.list })
                          setNotice(
                            '已导入 ' + result.added + ' 条快捷命令' +
                              (result.skipped > 0 ? '，跳过 ' + result.skipped + ' 条空白或无效记录' : ''),
                          )
                        } catch (error) {
                          console.warn('[terminal-workbench] 快捷命令导入失败：', error)
                          setNotice('导入失败：' + (error instanceof Error ? error.message : '文件格式不对'))
                        }
                        target.value = ''
                      }
                      reader.onerror = function () {
                        console.warn('[terminal-workbench] 读取快捷命令文件失败：', reader.error)
                        setNotice('读取文件失败')
                        target.value = ''
                      }
                      reader.readAsText(file)
                    },
                  }),
                  notice === ''
                    ? null
                    : jsx('span', { className: 'wb-set-hint', 'data-import-notice': '1', children: notice }),
                ],
              }),
              commandEditing !== null
                ? jsxs('div', {
                    className: 'wb-form',
                    'data-quick-form': '1',
                    children: [
                      jsx('div', { className: 'wb-form-label', children: '快速命令名称' }),
                      jsx('input', {
                        className: 'wb-form-input',
                        'data-form': 'name',
                        placeholder: '例如 重启服务',
                        value: commandEditing.name,
                        onChange: function (event) {
                          setCommandEditing(Object.assign({}, commandEditing, { name: event.target.value }))
                        },
                      }),
                      jsx('div', {
                        className: 'wb-form-label',
                        children: '快速命令（按顺序执行，Delay 为下一条前的等待毫秒）',
                      }),
                      ...commandEditing.commands.map(function (step, index) {
                        return jsxs('div', {
                          className: 'wb-form-step',
                          'data-step': String(index),
                          children: [
                            jsx('input', {
                              className: 'wb-form-input wb-form-delay',
                              'data-step-delay': String(index),
                              type: 'number',
                              min: 0,
                              value: String(step.delay),
                              onChange: function (event) {
                                var next = commandEditing.commands.map(function (entry, entryIndex) {
                                  return entryIndex === index
                                    ? { command: entry.command, delay: Number(event.target.value) || 0 }
                                    : entry
                                })
                                setCommandEditing(Object.assign({}, commandEditing, { commands: next }))
                              },
                            }),
                            jsx('input', {
                              className: 'wb-form-input',
                              'data-step-command': String(index),
                              placeholder: '命令，可用 {{clipboard}} / {{time}} / {{date}}',
                              value: step.command,
                              onChange: function (event) {
                                var next = commandEditing.commands.map(function (entry, entryIndex) {
                                  return entryIndex === index
                                    ? { command: event.target.value, delay: entry.delay }
                                    : entry
                                })
                                setCommandEditing(Object.assign({}, commandEditing, { commands: next }))
                              },
                            }),
                            jsx('button', {
                              type: 'button',
                              className: 'wb-set-del',
                              'data-step-remove': String(index),
                              onClick: function () {
                                setCommandEditing(
                                  Object.assign({}, commandEditing, {
                                    commands: commandEditing.commands.filter(function (_entry, entryIndex) {
                                      return entryIndex !== index
                                    }),
                                  }),
                                )
                              },
                              children: '×',
                            }),
                          ],
                        })
                      }),
                      jsx('button', {
                        type: 'button',
                        className: 'wb-set-add-btn',
                        'data-form-add-step': '1',
                        onClick: function () {
                          setCommandEditing(
                            Object.assign({}, commandEditing, {
                              commands: commandEditing.commands.concat([{ command: '', delay: 0 }]),
                            }),
                          )
                        },
                        children: '+ 快速命令',
                      }),
                      jsx('label', {
                        className: 'wb-form-check',
                        children: [
                          jsx('input', {
                            type: 'checkbox',
                            'data-form': 'input-only',
                            checked: commandEditing.inputOnly === true,
                            onChange: function (event) {
                              setCommandEditing(Object.assign({}, commandEditing, { inputOnly: event.target.checked }))
                            },
                          }),
                          jsx('span', { children: '仅输入（不自动回车）' }),
                        ],
                      }),
                      jsx('div', { className: 'wb-form-label', children: '标签（逗号分隔，底部栏筛选用）' }),
                      jsx('input', {
                        className: 'wb-form-input',
                        'data-form': 'label',
                        placeholder: '例如 底座, 适配',
                        value: commandEditing.label,
                        onChange: function (event) {
                          setCommandEditing(Object.assign({}, commandEditing, { label: event.target.value }))
                        },
                      }),
                      jsx('div', {
                        className: 'wb-form-hint',
                        children: '模板变量：{{clipboard}} {{time}} {{date}}',
                      }),
                      jsxs('div', {
                        className: 'wb-form-actions',
                        children: [
                          jsx('button', {
                            type: 'button',
                            className: 'wb-form-primary',
                            'data-quick-save': '1',
                            onClick: function () {
                              var name = commandEditing.name.trim()
                              var steps = commandEditing.commands.filter(function (step) {
                                return step.command.trim() !== ''
                              })
                              if (name === '' || steps.length === 0) return
                              var labels = Array.from(new Set(commandEditing.label.split(/[,，]/).map(function (label) {
                                return label.trim()
                              }).filter(function (label) { return label !== '' })))
                              var entry = {
                                id: commandEditing.id,
                                name: name,
                                label: labels[0] ?? '',
                                labels: labels,
                                inputOnly: commandEditing.inputOnly === true,
                                commands: steps,
                              }
                              var list = normalizeQuickCommandList(settings.quickCommands)
                              var exists = list.some(function (item) {
                                return item.id === entry.id
                              })
                              apply({
                                quickCommands: exists
                                  ? list.map(function (item) {
                                      return item.id === entry.id ? entry : item
                                    })
                                  : list.concat([entry]),
                              })
                              setCommandEditing(null)
                            },
                            children: '保存',
                          }),
                          jsx('button', {
                            type: 'button',
                            className: 'wb-form-cancel',
                            onClick: function () {
                              setCommandEditing(null)
                            },
                            children: '取消',
                          }),
                        ],
                      }),
                    ],
                  })
                : jsxs('div', {
                    className: 'wb-set-groups',
                    children: [
                      quickList.length === 0
                        ? jsx('div', { className: 'wb-set-hint', children: '还没有快速命令。' })
                        : jsx('div', {
                            className: 'wb-set-bookmarks',
                            children: quickList.map(function (item) {
                              return jsxs('div', {
                                className: 'wb-set-bookmark',
                                'data-quick-id': item.id,
                                children: [
                                  jsxs('div', {
                                    className: 'wb-set-bookmark-main',
                                    children: [
                                      jsx('span', { className: 'wb-set-label', children: item.name }),
                                      jsx('span', {
                                        className: 'wb-set-sub',
                                        children: item.commands
                                          .map(function (step) {
                                            return step.command
                                          })
                                          .join(' ↵ '),
                                      }),
                                    ],
                                  }),
                                  jsxs('div', {
                                    className: 'wb-set-actions',
                                    children: [
                                      jsx('button', {
                                        type: 'button',
                                        className: 'wb-set-edit',
                                        'data-edit-quick': item.id,
                                        onClick: function () {
                                          setCommandEditing(
                                            Object.assign({}, item, {
                                              label: Array.isArray(item.labels) && item.labels.length > 0
                                                ? item.labels.join(', ') : item.label,
                                              commands: item.commands.map(function (step) {
                                                return { command: step.command, delay: step.delay }
                                              }),
                                            }),
                                          )
                                        },
                                        children: '编辑',
                                      }),
                                      jsx('button', {
                                        type: 'button',
                                        className: 'wb-set-del',
                                        onClick: function () {
                                          apply({
                                            quickCommands: normalizeQuickCommandList(settings.quickCommands).filter(
                                              function (entry) {
                                                return entry.id !== item.id
                                              },
                                            ),
                                          })
                                        },
                                        children: '删除',
                                      }),
                                    ],
                                  }),
                                ],
                              })
                            }),
                          }),
                      jsx('button', {
                        type: 'button',
                        className: 'wb-set-add-btn',
                        'data-add-quick': '1',
                        onClick: function () {
                          setCommandEditing({
                            id: 'qc-' + Date.now().toString(36),
                            name: '',
                            label: '',
                            inputOnly: false,
                            commands: [{ command: '', delay: 0 }],
                          })
                        },
                        children: '+ 新建快速命令',
                      }),
                ],
              }),
                ],
              ),
              SetSection('groups', '书签分组', groups.length + ' 组', [
              jsxs('div', {
                className: 'wb-set-groups',
                children: groups.map(function (group) {
                  var count = bookmarksOfGroup(marks, group.id).length
                  return jsxs('div', {
                    className: 'wb-set-group-row',
                    'data-group-id': group.id,
                    children: [
                      jsx('span', { className: 'wb-set-label', children: group.name + '（' + count + '）' }),
                      group.id === DEFAULT_GROUP.id
                        ? null
                        : jsx('button', {
                            type: 'button',
                            className: 'wb-set-del',
                            'aria-label': '删除分组',
                            onClick: function () {
                              apply({
                                bookmarkGroups: groups.filter(function (item) {
                                  return item.id !== group.id
                                }),
                                bookmarks: marks.map(function (item) {
                                  return groupIdOf(item) === group.id
                                    ? Object.assign({}, item, { groupId: DEFAULT_GROUP.id })
                                    : item
                                }),
                              })
                            },
                            children: '删除分组',
                          }),
                    ],
                  })
                }),
              }),
              ]),
              SetSection('bookmarks', 'SSH 书签', marks.length + ' 条', [
              jsx('label', {
                className: 'wb-set-add-btn',
                children: [
                  '导入 electerm JSON',
                  jsx('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' }, onChange: importElecterm }),
                ],
              }),
              editing !== null
                ? bookmarkForm()
                : jsxs('div', {
                    className: 'wb-set-groups',
                    children: [
                      marks.length === 0
                        ? jsx('div', { className: 'wb-set-hint', children: '还没有书签，点下面「新建书签」。' })
                        : jsx('div', {
                            className: 'wb-set-groups',
                            children: groups.map(function (group) {
                              var list = bookmarksOfGroup(marks, group.id)
                              var folded = collapsedGroups.indexOf(group.id) >= 0
                              return jsxs('div', {
                                className: 'wb-set-groupblock',
                                'data-bookmark-group': group.id,
                                'data-folded': folded ? 'true' : 'false',
                                children: [
                                  jsxs('button', {
                                    type: 'button',
                                    className: 'wb-set-groupname',
                                    'data-group-toggle': group.id,
                                    'aria-expanded': folded ? 'false' : 'true',
                                    onClick: function () {
                                      toggleCollapsedGroup(group.id)
                                    },
                                    children: [
                                      jsx('span', { className: 'wb-pop-caret', children: folded ? '▸' : '▾' }),
                                      jsx('span', { children: group.name }),
                                      jsx('span', { className: 'wb-pop-count', children: String(list.length) }),
                                    ],
                                  }),
                                  folded ? null : list.length === 0
                                    ? jsx('div', { className: 'wb-set-hint', children: '（空）' })
                                    : jsx('div', {
                                        className: 'wb-set-bookmarks',
                                        children: list.map(function (mark) {
                                          return jsxs('div', {
                                            className: 'wb-set-bookmark',
                                            children: [
                                              jsxs('div', {
                                                className: 'wb-set-text',
                                                children: [
                                                  jsx('span', { className: 'wb-set-label', children: mark.name || mark.host }),
                                                  jsx('span', { className: 'wb-set-hint', children: bookmarkTarget(mark) }),
                                                ],
                                              }),
                                              jsxs('div', {
                                                className: 'wb-set-actions',
                                                children: [
                                                  jsx('button', {
                                                    type: 'button',
                                                    className: 'wb-set-edit',
                                                    'aria-label': '编辑书签',
                                                    onClick: function () {
                                                      setEditing(
                                                        Object.assign({}, blankBookmark(), mark, {
                                                          port: String(mark.port ?? 22),
                                                          groupName: (function () {
                                                            var hit = groups.filter(function (item) {
                                                              return item.id === groupIdOf(mark)
                                                            })[0]
                                                            return hit === undefined ? groups[0].name : hit.name
                                                          })(),
                                                        }),
                                                      )
                                                    },
                                                    children: '编辑',
                                                  }),
                                                  jsx('button', {
                                                    type: 'button',
                                                    className: 'wb-set-del',
                                                    'aria-label': '删除书签',
                                                    onClick: function () {
                                                      apply({
                                                        bookmarks: marks.filter(function (item) {
                                                          return item.id !== mark.id
                                                        }),
                                                      })
                                                    },
                                                    children: '删除',
                                                  }),
                                                ],
                                              }),
                                            ],
                                          })
                                        }),
                                      }),
                                ],
                              })
                            }),
                          }),
                      jsx('button', {
                        type: 'button',
                        className: 'wb-set-add-btn',
                        'data-add-bookmark': '1',
                        onClick: function () {
                          setEditing(blankBookmark())
                        },
                        children: '+ 新建书签',
                      }),
                    ],
                  }),
              ]),
        jsx('div', { className: 'wb-set-foot', children: '书签用系统 ssh 直连：点击后在新标签里执行 ssh 命令。' }),
        ],
      })
    }

    /** 右键菜单里的快捷设置对话框：原生设置分区之外的第二入口。 */
    function SettingsDialog() {
      var openState = react.useState(false)
      var open = openState[0]
      var setOpen = openState[1]

      react.useEffect(function () {
        var onOpen = function () {
          setOpen(true)
        }
        var onKey = function (event) {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('dsh-terminal-workbench:open-settings', onOpen)
        document.addEventListener('keydown', onKey, true)
        return function () {
          document.removeEventListener('dsh-terminal-workbench:open-settings', onOpen)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [])

      if (!open) return null

      return reactDom.createPortal(
        jsx('div', {
          className: 'wb-set-backdrop',
          onClick: function (event) {
            if (event.target === event.currentTarget) setOpen(false)
          },
          children: jsxs('div', {
            className: 'wb-set-panel',
            role: 'dialog',
            'aria-label': '终端工作台设置',
            children: [
              jsxs('div', {
                className: 'wb-set-head',
                children: [
                  jsx('span', { className: 'wb-set-title', children: '终端工作台设置' }),
                  jsx('button', {
                    type: 'button',
                    className: 'wb-set-close',
                    'aria-label': '关闭',
                    onClick: function () {
                      setOpen(false)
                    },
                    children: '×',
                  }),
                ],
              }),
              jsx(SettingsBody, {}),
            ],
          }),
        }),
        document.body,
      )
    }

    /* ---------- 最近连接（本地存储，最多 8 条） ---------- */

    var RECENT_KEY = 'dsh-terminal-workbench.recent'
    var DOT_COLORS = ['#e5484d', '#f5a524', '#30a46c', '#0ea5e9', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316']

    /**
     * 最近连接统一成 `{ command, label? }`。
     *
     * 旧版本只存命令串；现在书签启动时额外记下书签名，列表里就不会再出现
     * `umask 077 && printf %s IyEv...` 这种把真实命令露出来的长串。
     * 旧数据原样兼容：字符串转成 `{ command }`，没有 label 时显示命令本身。
     */
    function normalizeRecent(item) {
      if (typeof item === 'string') {
        return item === '' ? undefined : { command: item }
      }
      if (item === null || typeof item !== 'object') return undefined
      var command = typeof item.command === 'string' ? item.command : ''
      if (command === '') return undefined
      var label = typeof item.label === 'string' ? item.label.trim() : ''
      return label === '' ? { command: command } : { command: command, label: label }
    }

    function recentLabelOf(item) {
      return item.label || item.command
    }

    function readRecent() {
      try {
        var raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(RECENT_KEY)
        var list = raw === null ? [] : JSON.parse(raw)
        if (!Array.isArray(list)) return []
        return list.map(normalizeRecent).filter(Boolean).slice(0, 8)
      } catch (error) {
        return []
      }
    }

    function rememberRecent(command, label) {
      var entry = normalizeRecent({ command: command, label: label })
      if (entry === undefined) return readRecent()
      var list = [entry]
        .concat(
          readRecent().filter(function (item) {
            return item.command !== entry.command
          })
        )
        .slice(0, 8)
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(RECENT_KEY, JSON.stringify(list))
      } catch (error) {
        /* 隐私模式下写入失败：本次仍展示，只是不持久化 */
        console.warn('[terminal-workbench] 隐私模式下写入失败：本次仍展示，只是不持久化：', error)
      }
      return list
    }

    function clearRecent() {
      try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(RECENT_KEY)
      } catch (error) {
        /* 隐私模式下删除失败：仍清空当前内存列表 */
        console.warn('[terminal-workbench] 隐私模式下删除失败：仍清空当前内存列表：', error)
      }
      try {
        window.dispatchEvent(new CustomEvent('dsh-terminal-workbench:recent-cleared'))
      } catch (error) {
        /* 非浏览器测试环境没有事件对象时忽略 */
        console.warn('[terminal-workbench] 非浏览器测试环境没有事件对象时忽略：', error)
      }
      return []
    }

    /** 用命令串哈希取一个稳定的颜色，作最近项的标识点。 */
    function dotColor(text) {
      var hash = 0
      for (var i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 100000
      return DOT_COLORS[hash % DOT_COLORS.length]
    }

    function groupColor(groupId) {
      return dotColor('bookmark-group:' + String(groupId))
    }

    /**
     * 新建终端卡片（原引导页）：electerm 式浮层卡片——
     * 一个快捷输入框（本地回车或输入 ssh/命令）、可用 shell 快捷按钮、最近连接列表。
     * 带命令时通过 params.initialInput 交给渲染层，在首屏落定后写入一次。
     */
    function TerminalGuide(props) {
      var tab = props.useTabInfo().tab
      var t = props.t
      var shellsState = react.useState({ phase: 'loading', shells: [], selected: undefined })
      var shellsValue = shellsState[0]
      var setShells = shellsState[1]
      var recentState = react.useState(readRecent)
      var recent = recentState[0]
      var setRecent = recentState[1]
      react.useEffect(function () {
        var onClear = function () { setRecent([]) }
        window.addEventListener('dsh-terminal-workbench:recent-cleared', onClear)
        return function () { window.removeEventListener('dsh-terminal-workbench:recent-cleared', onClear) }
      }, [])
      var draftState = react.useState('')
      var draft = draftState[0]
      var setDraft = draftState[1]
      var collapsedGroups = useCollapsedGroups()
      /* 设置页改了书签时，启动页保持挂载也能立刻刷新。 */
      var settingsRevisionState = react.useState(0)
      var settingsRevision = settingsRevisionState[0]
      react.useEffect(function () {
        var onSettings = function () {
          settingsRevisionState[1](function (value) {
            return value + 1
          })
        }
        window.addEventListener(SETTINGS_EVENT, onSettings)
        return function () {
          window.removeEventListener(SETTINGS_EVENT, onSettings)
        }
      }, [])

      react.useEffect(function () {
        var controller = new AbortController()
        Promise.resolve()
          .then(function () {
            return props.loadShells(controller.signal)
          })
          .then(function (launch) {
            var shells = launch && Array.isArray(launch.shells) ? launch.shells : []
            setShells({ phase: 'ready', shells: shells, selected: launch && launch.selectedShell })
          })
          .catch(function () {
            setShells({ phase: 'error', shells: [], selected: undefined })
          })
        return function () {
          controller.abort()
        }
      }, [props.loadShells])

      var open = function (shellPath, initialInput, recentLabel) {
        if (shellPath !== undefined) props.selectShell(shellPath)
        var params = {}
        if (shellPath !== undefined) params.shellPath = shellPath
        if (typeof initialInput === 'string' && initialInput !== '') {
          var forRecent = initialInput
          /* ssh 投递走回显抑制（sshInitialInput）；recent 列表仍记原始命令。 */
          if (initialInput.indexOf(SSH_ECHO_MARK) !== -1) initialInput = sshInitialInput(initialInput)
          params.initialInput = initialInput
          setRecent(rememberRecent(forRecent, recentLabel))
        }
        tab.actions.openTab('terminal', {
          replaceTab: true,
          params: Object.keys(params).length === 0 ? undefined : params,
        })
      }

      var submit = function () {
        var text = draft.trim()
        if (text === '') {
          open(undefined, undefined)
          return
        }
        open(undefined, text)
      }

      var shells = shellsValue.phase === 'ready' ? shellsValue.shells : []

      return jsx('div', {
        className: 'tp-guide',
        children: jsxs('div', {
          className: 'tp-card',
          children: [
            jsx('div', { className: 'tp-card-title', children: t('title') }),
            jsx('input', {
              className: 'tp-card-input',
              autoFocus: true,
              spellCheck: false,
              value: draft,
              placeholder: t('placeholder'),
              onChange: function (event) {
                setDraft(event.target.value)
              },
              onKeyDown: function (event) {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submit()
                }
              },
            }),
            jsx('div', {
              className: 'tp-card-row',
              children:
                shells.length === 0
                  ? [
                      jsx(
                        'button',
                        {
                          className: 'tp-chip',
                          onClick: function () {
                            open(undefined, undefined)
                          },
                          children: t('new'),
                        },
                        'default'
                      ),
                    ]
                  : shells.map(function (shell) {
                      return jsx(
                        'button',
                        {
                          className: 'tp-chip',
                          'data-selected': shell.path === shellsValue.selected ? '' : undefined,
                          onClick: function () {
                            open(shell.path, undefined)
                          },
                          children: shell.name,
                        },
                        shell.path
                      )
                    }),
            }),
            jsx('div', { className: 'tp-card-section', children: t('bookmarks') }),
            jsx('div', {
              'data-settings-revision': settingsRevision,
              children: renderBookmarkGroups({
                collapsedGroups: collapsedGroups,
                emptyText: t('bookmarksEmpty'),
                onOpen: function (mark) {
                  open(undefined, sshCommand(mark), mark.name || bookmarkTarget(mark))
                },
              }),
            }),
            jsx('div', { className: 'tp-card-section', children: t('recent') }),
            recent.length === 0
              ? jsx('div', { className: 'tp-recent-empty', children: t('recentEmpty') })
              : jsx('div', {
                  className: 'tp-recent',
                  children: recent.map(function (item) {
                    return jsxs(
                      'div',
                      {
                        className: 'tp-recent-item',
                        title: item.command,
                        onClick: function () {
                          open(undefined, item.command, item.label)
                        },
                        children: [
                          jsx('span', { className: 'tp-dot', style: { background: dotColor(item.command) } }),
                          jsx('span', { className: 'tp-recent-text', children: recentLabelOf(item) }),
                        ],
                      },
                      item.command
                    )
                  }),
                }),
            recent.length === 0 ? null : jsx('button', {
              type: 'button',
              className: 'tp-recent-clear',
              onClick: function () { setRecent(clearRecent()) },
              children: t('recentClear'),
            }),
          ],
        }),
      })
    }

    /**
     * 终端主体入口：把懒加载 chunk 的 TerminalBody 挂进 Suspense。
     * 顺带把「新建时携带的初始命令」按当前标签解析成字符串交给渲染层。
     */
    /* ---------- 反向通道：终端选区 → 对话 ---------- */

    /**
     * 由 applyTerminal 注入的两个运行时能力（一个插件只有一个 ctx，沿用 pluginCtx 的既有做法）：
     *   sendSelection — 把文本投递到当前会话；
     *   terminalText  — 本插件命名空间的文案函数。
     */
    var sendSelection = null
    var terminalText = null

    /** 文案插值：不依赖宿主 locale 是否支持参数，占位符未命中时原样保留。 */
    function fillText(template, values) {
      return String(template).replace(/\{(\w+)\}/g, function (whole, key) {
        return values !== undefined && values[key] !== undefined ? String(values[key]) : whole
      })
    }

    /** 「发给对话」的图标：一支往右上的箭头，暗示"把东西递出去"。 */
    function SendIcon() {
      return jsxs('svg', {
        width: 13,
        height: 13,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        children: [
          jsx('path', { d: 'M2.5 8H11', stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round' }),
          jsx('path', { d: 'M7.5 4.5L11 8L7.5 11.5', stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round', strokeLinejoin: 'round' }),
        ],
      })
    }

    /**
     * 读当前可见的整屏文本（无选区时的兜底内容）。
     *
     * 走 xterm 的 buffer 而不是 DOM：DOM 里字符被按样式切成 span，拼回来丢空格、
     * 还会带上折行造成的错位；buffer 行是终端的真实逻辑行。
     * 只取 viewport 那一段（viewportY 起 rows 行），不把回滚历史也发出去——
     * 用户看到什么就发什么。
     * @param term - xterm 实例
     * @returns 整屏文本，末尾空行已去掉；读不到时返回空串
     */
    function visibleScreenOf(term) {
      try {
        var buffer = term.buffer === undefined ? undefined : term.buffer.active
        if (buffer === undefined || typeof buffer.getLine !== 'function') return ''
        var top = typeof buffer.viewportY === 'number' ? buffer.viewportY : 0
        var rows = typeof term.rows === 'number' ? term.rows : 24
        var lines = []
        for (var index = 0; index < rows; index += 1) {
          var line = buffer.getLine(top + index)
          if (line === undefined || line === null) continue
          lines.push(line.translateToString().replace(/\s+$/, ''))
        }
        while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
        return lines.join('\n')
      } catch (error) {
        return ''
      }
    }

    /**
     * 从容器 DOM 就近取 xterm 实例。
     * xterm 自绘选区（原生 window.getSelection 在终端里取不到文本），渲染层在
     * open() 之后把实例挂到容器上（client.terminal.js 的 __dshXterm）；取不到就
     * 整条通道降级，不抛错、不回退到不可靠的 DOM 抓取。
     */
    function xtermIn(host) {
      if (host === null || host === undefined) return undefined
      /* 先走常规路径：.xterm 的父节点就是 open() 容器。 */
      var screen = host.querySelector('.xterm')
      if (screen !== null && screen.parentElement !== null) {
        var quick = screen.parentElement.__dshXterm
        if (quick !== undefined && typeof quick.getSelection === 'function') return quick
      }
      /* 退路：终端可能挂在更深的节点上（渲染层改过 DOM 层级）。
         在子树里找任意带 __dshXterm 的节点，取最后一个还连在 DOM 上的——
         重建时旧实例会先被摘下来，新的才是活的。 */
      var found
      var walk = function (el) {
        var children = el.children
        for (var index = 0; index < children.length; index += 1) walk(children[index])
        var term = el.__dshXterm
        if (term !== undefined && typeof term.getSelection === 'function') {
          if (term.element === undefined || term.element === null || term.element.isConnected !== false) found = term
        }
      }
      walk(host)
      return found
    }

    /**
     * 命令块边距条（S4）。
     *
     * 刻意不做成 xterm 的 decoration：这里只在自己的一层绝对定位 DOM 上画
     * 竖条，位置由 `viewportY / rows / .xterm-screen 高度` 推出来。好处是
     * 完全不碰 xterm 的渲染树，终端字体、主题、选区、折行都不会被影响；
     * 代价是滚动/重绘时要用 rAF 合并重算（每个渲染事件重建一次 DOM 太贵）。
     */
    function BlockMargin(props) {
      var host = props.host
      var term = props.term
      var tabId = props.tabId
      var selectedId = props.selectedId
      var layerRef = react.useRef(null)
      var onSelectRef = react.useRef(function () {})
      onSelectRef.current = typeof props.onSelect === 'function' ? props.onSelect : function () {}
      var tRef = react.useRef(function (key) { return key })
      tRef.current = typeof props.t === 'function' ? props.t : tRef.current

      react.useEffect(
        function () {
          var layer = layerRef.current
          if (layer === null) return undefined
          if (host === null || host === undefined) return undefined
          if (term === undefined || term === null || tabId === undefined) return undefined

          var frame = 0
          var update = function () {
            var buffer = bufferOf(term)
            var element = term.element
            if (buffer === undefined || element === undefined || element === null) {
              layer.textContent = ''
              return
            }
            var screen = typeof element.querySelector === 'function' ? element.querySelector('.xterm-screen') : null
            if (screen === null) {
              layer.textContent = ''
              return
            }
            var hostRect = host.getBoundingClientRect()
            var screenRect = screen.getBoundingClientRect()
            var rows = Number(term.rows)
            if (!(screenRect.height > 0) || !(rows > 0)) {
              layer.textContent = ''
              return
            }
            var rowHeight = screenRect.height / rows
            var leftOffset = screenRect.left - hostRect.left
            layer.style.top = (screenRect.top - hostRect.top) + 'px'
            layer.style.height = screenRect.height + 'px'
            /* 左侧没有足够留白就不画：宁可没有边距条，也不压住第一列文字。 */
            if (!(leftOffset >= 6)) {
              layer.textContent = ''
              layer.style.width = '0px'
              return
            }
            layer.style.left = Math.max(0, leftOffset - 10) + 'px'
            layer.style.width = Math.min(10, leftOffset) + 'px'
            layer.textContent = ''

            var viewTop = Number(buffer.viewportY)
            if (!Number.isFinite(viewTop)) viewTop = 0
            var viewBottom = viewTop + rows - 1
            var list = terminalBlocksOf(tabId)
            var visible = 0
            for (var index = 0; index < list.length; index += 1) {
              var block = list[index]
              /* 空回车也发 C/D；没有命令文本又没有失败码的块不画，避免边距
                 被一串无意义的短条塞满。 */
              if (block.command === '' && blockStateOf(block) !== 'fail') continue
              var start = blockStartLineOf(block)
              var end = blockEndLineOf(block, term)
              if (start < 0 || end < 0 || end < viewTop || start > viewBottom) continue
              var from = Math.max(start, viewTop)
              var to = Math.min(end, viewBottom)
              var top = (from - viewTop) * rowHeight
              var height = Math.max(3, (to - from + 1) * rowHeight - 1)
              var state = blockStateOf(block)
              var bar = document.createElement('button')
              bar.type = 'button'
              bar.className = 'tp-block-bar'
              bar.dataset.state = state
              bar.dataset.selected = selectedId === block.id ? 'true' : 'false'
              bar.style.top = top + 'px'
              bar.style.height = height + 'px'
              var command = block.command === '' ? tRef.current('blocks.empty') : block.command
              bar.title = '$ ' + command + (state === 'running'
                ? ' · ' + tRef.current('blocks.running')
                : block.exitCode !== undefined
                  ? ' · rc=' + block.exitCode
                  : '')
              bar.setAttribute('aria-label', bar.title)
              bar.addEventListener('click', function (id) {
                return function () { onSelectRef.current(id) }
              }(block.id))
              layer.appendChild(bar)
              visible += 1
              if (visible >= 200) break
            }
          }
          var schedule = function () {
            if (frame !== 0) return
            var raf = window.requestAnimationFrame
            if (typeof raf !== 'function') {
              update()
              return
            }
            frame = raf(function () {
              frame = 0
              update()
            })
          }

          var subscriptions = []
          var subscribe = function (name) {
            if (typeof term[name] !== 'function') return
            try {
              var subscription = term[name](schedule)
              if (subscription !== undefined && subscription !== null) subscriptions.push(subscription)
            } catch (error) {
              /* 某个事件不存在不影响其它事件 */
            }
          }
          subscribe('onRender')
          subscribe('onScroll')
          subscribe('onResize')
          var onBlocks = function (event) {
            if (event?.detail?.tabId === tabId) schedule()
          }
          window.addEventListener('dsh-terminal-workbench:blocks', onBlocks)
          window.addEventListener('resize', schedule)
          var observer
          if (typeof ResizeObserver === 'function') {
            observer = new ResizeObserver(schedule)
            observer.observe(host)
          }
          update()

          return function () {
            if (frame !== 0 && typeof window.cancelAnimationFrame === 'function') {
              window.cancelAnimationFrame(frame)
              frame = 0
            }
            window.removeEventListener('dsh-terminal-workbench:blocks', onBlocks)
            window.removeEventListener('resize', schedule)
            if (observer !== undefined) observer.disconnect()
            for (var index = 0; index < subscriptions.length; index += 1) {
              try {
                if (typeof subscriptions[index].dispose === 'function') subscriptions[index].dispose()
              } catch (error) {
                /* 忽略释放失败 */
              }
            }
            /* 不删节点：它是 React 渲染出来的，卸载时 React 自己会摘。 */
            layer.textContent = ''
          }
        },
        [host, term, tabId, selectedId],
      )
      return jsx('div', {
        className: 'tp-blocks',
        'data-tp-build': BUILD_STAMP,
        ref: layerRef,
      })
    }

    /** 终端面板外框：包住渲染层，并在右上角挂「发给对话」入口。 */
    function SelectionSend(props) {
      var hostState = react.useState(null)
      var termState = react.useState(undefined)
      var selState = react.useState(false)
      var busyState = react.useState(false)
      var toastState = react.useState(null)
      /* S4：块表是模块级数据，完成/新增时用事件推进一次渲染；
         边距条位置由 BlockMargin 自己按滚动/重绘更新，不经过 React。 */
      var blockTickState = react.useState(0)
      var setBlockTick = blockTickState[1]
      var selectedBlockState = react.useState(null)
      var selectedBlockId = selectedBlockState[0]
      var setSelectedBlockId = selectedBlockState[1]

      var host = hostState[0]
      var setHost = hostState[1]
      var term = termState[0]
      var setTerm = termState[1]
      var hasSelection = selState[0]
      var setHasSelection = selState[1]
      var busy = busyState[0]
      var setBusy = busyState[1]
      var toast = toastState[0]
      var setToast = toastState[1]
      /* host 的镜像 ref：OSC 换绑轮询要在 effect 里读最新 DOM 节点。 */
      var hostRef = react.useRef(null)
      var hostCb = react.useCallback(
        function (el) { hostRef.current = el; setHost(el) },
        [],
      )

      var send = props.send === undefined ? sendSelection : props.send
      var translate = props.t === undefined ? terminalText : props.t
      var t =
        typeof translate === 'function'
          ? function (key, values) { return fillText(translate(key), values) }
          : function (key) { return key }

      var toastTimer = react.useRef(0)
      var flash = function (message, kind) {
        setToast({ message: message, kind: kind === 'error' ? 'error' : 'ok' })
        window.clearTimeout(toastTimer.current)
        toastTimer.current = window.setTimeout(
          function () { setToast(null) },
          kind === 'error' ? 3400 : 2000,
        )
      }

      /* 终端 chunk 懒加载、xterm 又要等 open() 之后才有实例：轮询等待，最多 20 秒。 */
      react.useEffect(
        function () {
          if (host === null) return undefined
          var attempts = 0
          var timer = window.setInterval(function () {
            attempts += 1
            var found = xtermIn(host)
            if (found === undefined) {
              if (attempts >= 80) window.clearInterval(timer)
              return
            }
            window.clearInterval(timer)
            setTerm(found)
          }, 250)
          return function () { window.clearInterval(timer) }
        },
        [host],
      )

      /* 选区变化：只在真的选了东西时露出按钮，避免长期占据终端右上角。 */
      react.useEffect(
        function () {
          if (term === undefined) return undefined
          var read = function () {
            return typeof term.hasSelection === 'function' ? term.hasSelection() : true
          }
          setHasSelection(read())
          if (typeof term.onSelectionChange !== 'function') return undefined
          var subscription = term.onSelectionChange(function () { setHasSelection(read()) })
          return function () {
            try { if (subscription !== undefined && typeof subscription.dispose === 'function') subscription.dispose() }
            catch (error) { /* 订阅释放失败不影响卸载 */ }
          }
        },
        [term],
      )

      /* ---------- SSH 连接状态（v0.7.0） ----------
         状态存模块级 SSH_SESSIONS（tabId 键），标签重挂载不丢。
         OSC7（远端 $PWD）与 OSC777（ssh 退出信标）都由本组件在拿到 xterm
         实例后注册处理器——xterm 实例归渲染 chunk，但句柄从 host.__dshXterm
         就能拿到，不必动 bundle。 */
      var tabId = typeof props.tabId === 'string' ? props.tabId : undefined
      var sshState = react.useState(undefined)
      var ssh = sshState[0]
      var setSsh = sshState[1]
      var sshRef = react.useRef(null)
      sshRef.current = ssh
      /* 重连函数的重载 ref：模块级信标处理器要通过它回调到最新闭包。 */
      var reconnectRef = react.useRef(function () {})

      react.useState(function () {
        /* 首帧登记：这次挂载带的是 ssh 命令（且能在命令表里反查到书签），
           就为这个标签建一份会话状态；已有状态（重挂载）则沿用。 */
        if (tabId === undefined) return undefined
        /* 稳定内容地址先登记：后面无论是新建还是恢复，持久条目都带上它。 */
        rememberSshContentId(tabId, props.contentId)
        var existing = SSH_SESSIONS[tabId]
        if (existing !== undefined) return existing
        var command = typeof props.initialInput === 'string' ? props.initialInput : ''
        var bookmark = sshBookmarkByInput(command)
        /* 刷新页面后 initialInput 已标记投递、不会重发（props.initialInput 为空），
           但标签参数里还留着原命令；从持久化的命令表里把书签找回来，胶囊与
           重连按钮才能继续存在。此时无法确知 ssh 是否还活着，先按"已连接"
           恢复——用户一敲回车，远端/本地 OSC7 会立刻把真实状态纠正过来。 */
        var restored = false
        if (bookmark === undefined && typeof props.restoredInput === 'string' && props.restoredInput !== '') {
          bookmark = sshBookmarkByInput(props.restoredInput)
          restored = bookmark !== undefined
        }
        /* 刷新后标签参数不会保留（右栏布局只存 tab id/kind/title），所以
           最后一道兜底是按 tabId / 稳定内容地址取回上次的 SSH 书签与目录。 */
        var restoredCwd
        var restoredRawCommand
        var restoredManual = false
        var restoredState = 'connected'
        if (bookmark === undefined) {
          var persisted = persistedSshSession(tabId, props.contentId)
          if (persisted !== undefined) {
            bookmark = persisted.bookmark
            restoredCwd = persisted.cwd
            restoredRawCommand = persisted.rawCommand
            restoredManual = persisted.manual === true
            /* 老条目可能没有 state：按「已连接」恢复，交给屏幕兜底纠正。 */
            restoredState =
              persisted.state === 'connecting' || persisted.state === 'disconnected'
                ? persisted.state
                : 'connected'
            restored = true
            /* 布局恢复换了 tabId：把旧键迁到当前标签，旧条目别留着让下一个
               复用这个 id 的普通终端误继承。 */
            if (persisted.storedKey !== undefined && persisted.storedKey !== String(tabId)) {
              forgetPersistedSshSessionKey(persisted.storedKey)
            }
          }
        }
        /* tabId 复用到非 ssh 标签：清掉旧条目的残留状态，避免胶囊亮着
           "已连接"而实际是个普通终端。 */
        if (bookmark === undefined) {
          if (existing !== undefined) forgetSshSession(tabId)
          return undefined
        }
        /* 命令已交给终端，但远端还没报到：先记 connecting。
           收到 OSC7（远端提示符的 $PWD）才升级成 connected——
           否则 ssh 起不来时也会亮绿，等于骗人。 */
        var session = {
          bookmark: bookmark,
          state: restored ? restoredState : 'connecting',
          rc: undefined,
          cwd: restoredCwd,
          reconnecting: false,
          retryCount: 0,
          restored: restored,
          rawCommand:
            typeof restoredRawCommand === 'string' && restoredRawCommand !== ''
              ? restoredRawCommand
              : typeof bookmark.rawCommand === 'string'
                ? bookmark.rawCommand
                : undefined,
          manual: restoredManual || bookmark.manual === true,
          /* 新建会话刚把 ssh 命令写进 PTY：先跳过 500ms，等命令回显把旧屏幕
             顶掉；恢复会话则立即补查（这正是假绿的修复点）。 */
          tailCheckAt: restored ? undefined : Date.now(),
        }
        SSH_SESSIONS[tabId] = session
        rememberSshSession(tabId, session)
        /* 恢复成"连接中"说明刷新发生在建连过程中：PTY 还在，继续等它出结果；
           恢复成"已断开"则保持断开，把「重连」按钮直接亮出来。 */
        if (!restored || restoredState === 'connecting') {
          armSshConnectTimer(tabId, session)
          armSshManualConnectedTimer(tabId, session)
        }
        return session
      })

      react.useEffect(
        function () {
          if (tabId === undefined) return undefined
          /* 渲染层（chunk）成功写完初始命令后也会回写会话登记，这里兜底同步一次。
             注意必须传**新对象**：SSH_SESSIONS 里那个对象是原地改字段的，
             直接 setSsh(sameRef) 会被 React 的 Object.is 判成"没变"而跳过重渲染——
             表现就是状态机在跑、胶囊却一动不动（实测坑过一次）。 */
          var sync = function () {
            var session = SSH_SESSIONS[tabId]
            setSsh(session === undefined ? undefined : Object.assign({}, session))
          }
          sync()
          window.addEventListener('dsh-terminal-workbench:ssh-state', sync)
          return function () { window.removeEventListener('dsh-terminal-workbench:ssh-state', sync) }
        },
        [tabId],
      )

      /* OSC 处理器挂在模块级 attachSshSession 上（按 xterm 实例去重），
         本组件只负责：把当前实例交过去、把重连函数登记好、订阅状态变化。
         不在这里反复 dispose/重注册——那会和渲染 chunk 自己的 OSC7 抢位置。 */
      react.useEffect(
        function () {
          if (tabId === undefined) return undefined
          var attach = function () {
            var term = xtermIn(hostRef.current)
            if (term !== undefined) attachSshSession(tabId, term)
          }
          attach()
          /* 400ms 而不是 1s：实例可能在建好后立刻被渲染层重建（快照恢复、
             尺寸变化触发 open 重来）。间隔太长会整段漏掉远端提示符，
             OSC7 收不到就一直停在"连接中"。attach 本身幂等，重复调用无副作用。
             前 10 秒保持 400ms 抓首屏；之后降到 2 秒——已绑定的实例只需
             更新 tabId 映射，没必要让每个终端标签永久 400ms 唤醒一次。 */
          var startedAt = Date.now()
          var timer = window.setInterval(function () {
            if (!hostRef.current?.isConnected) return
            attach()
            if (Date.now() - startedAt > 10000) {
              window.clearInterval(timer)
              timer = window.setInterval(function () {
                if (!hostRef.current?.isConnected) return
                attach()
              }, 2000)
            }
          }, 400)
          return function () { window.clearInterval(timer) }
        },
        [tabId],
      )

      /* 重连函数登记：模块级信标处理器按 tabId 找到它。
         参数 manual=true 表示用户点的「重连」；自动重试传 false，
         这样退避计数不会被手动重置。 */
      react.useEffect(
        function () {
          if (tabId === undefined) return undefined
          SSH_RECONNECT[tabId] = function (manual) { reconnectRef.current(manual === true) }
          return function () { delete SSH_RECONNECT[tabId] }
        },
        [tabId],
      )

      /* 命令块变化：只推一次 React 渲染（块头/选中态），边距条自己走 DOM。 */
      react.useEffect(
        function () {
          if (tabId === undefined) return undefined
          var sync = function (event) {
            if (event?.detail?.tabId === tabId) setBlockTick(function (value) { return value + 1 })
          }
          window.addEventListener('dsh-terminal-workbench:blocks', sync)
          return function () { window.removeEventListener('dsh-terminal-workbench:blocks', sync) }
        },
        [tabId],
      )

      /** 立即重连：把重建的 ssh 命令写进 PTY（本地 shell 正停在提示符上等输入）。 */
      var reconnectNow = function (manual) {
        /* 必须改模块里那份**真身**：sshRef.current 是 React 状态快照（sync 时
           Object.assign 出来的副本），在它上面改字段不会回流到 SSH_SESSIONS，
           下次任何 sync 都会用旧值把它盖回去——表现就是点了重连、命令发了、
           胶囊却永远停在"已断开"（实测踩过）。 */
        var session = tabId !== undefined ? SSH_SESSIONS[tabId] : undefined
        if (session === undefined) session = sshRef.current
        if (session === undefined || session.state !== 'disconnected') return
        var viewFn = typeof props.view === 'function' ? props.view : undefined
        if (viewFn === undefined) return
        var viewObj = viewFn(tabId)
        if (viewObj === undefined || typeof viewObj.write !== 'function') return
        var command = sshReconnectCommand(session)
        if (window.__TWB_DEBUG_SSH) {
          console.log('[twb-ssh] reconnect tabId=' + tabId + ' manual=' + (manual === true) + ' from=' + session.cwd + ' len=' + command.length)
        }
        viewObj.write(sshInitialInput(command) + '\r')
        /* 手动重连视作重新开始：取消挂起的自动重试，退避从 3 秒重新计。
           自动重试不能清计数，否则每次都回到"第 1/5 次"，上限永远到不了。 */
        clearSshRetry(session)
        clearSshManualTimer(session)
        if (manual === true) {
          session.retryCount = 0
          session.retryExhausted = false
        }
        session.state = 'connecting'
        session.rc = undefined
        session.failure = undefined
        session.reconnecting = false
        /* 旧会话的提示符/断线文本还在屏幕上：先跳过 500ms，等重连命令回显。 */
        session.tailCheckAt = Date.now()
        armSshConnectTimer(tabId, session)
        armSshManualConnectedTimer(tabId, session)
        window.dispatchEvent(new CustomEvent('dsh-terminal-workbench:ssh-state', { detail: { tabId: tabId } }))
      }
      reconnectRef.current = reconnectNow

      var submitRef = react.useRef(function () {})
      var submit = function () {
        if (busy) return
        var current = xtermIn(host)
        if (current === undefined) current = term
        if (current === undefined || send === null || send === undefined) {
          flash(t('send.unavailable'), 'error')
          return
        }
        var raw = current.getSelection()
        /* 终端折行会让每行末尾带空格，去掉行尾空白与收尾空行，保留行内缩进。 */
        var text = typeof raw === 'string' ? raw.replace(/[ \t]+$/gm, '').replace(/\s+$/, '') : ''
        /* 没选中就退而求其次：把当前可见的整屏发过去。用户盯着一段报错想问模型时，
           "拖选"这一步其实是多余的——他看到的就是屏幕上的东西。 */
        var scope = 'selection'
        if (text === '') {
          text = visibleScreenOf(current)
          scope = 'screen'
        }
        if (text === '') {
          flash(t('send.empty'), 'error')
          return
        }
        setBusy(true)
        Promise.resolve()
          .then(function () {
            return send(text, props.terminalTitle, { sessionId: props.sessionId, scope: scope })
          })
          .then(
            function () {
              /* 发完清掉选区：否则按钮一直在，容易连着把同一段发两遍。 */
              try {
                if (typeof current.clearSelection === 'function') current.clearSelection()
              } catch (error) {
                /* 清不掉只是按钮不消失，不影响已经发出去的消息 */
              }
              setHasSelection(false)
              flash(scope === 'screen' ? t('send.okScreen') : t('send.ok'))
            },
            function (error) {
              flash(t('send.fail', { message: error === undefined ? '' : error.message ?? String(error) }), 'error')
            },
          )
          .then(function () { setBusy(false) })
      }
      submitRef.current = submit

      /* ---------- 命令块跳转（S4） ----------
         边距点击与 ⌘/Ctrl+Shift+↑/↓ 共用同一条路径：滚到块首行并亮出块头。
         块头只显示命令/耗时/退出码，不折叠输出——折叠必须动 xterm 的行，
         和 S4「只记录、不接管渲染」的取舍冲突。 */
      var selectedBlock =
        tabId === undefined || selectedBlockId === null
          ? undefined
          : findTerminalBlock(tabId, selectedBlockId)
      var selectBlock = function (id) {
        var block = tabId === undefined ? undefined : findTerminalBlock(tabId, id)
        if (block === undefined) return
        var line = blockStartLineOf(block)
        if (line >= 0 && term !== undefined && typeof term.scrollToLine === 'function') {
          try { term.scrollToLine(line) } catch (error) { /* 终端刚销毁时忽略 */ }
        }
        setSelectedBlockId(id)
      }
      var blockNavRef = react.useRef(function () { return false })
      blockNavRef.current = function (direction) {
        if (tabId === undefined || term === undefined) return false
        var buffer = bufferOf(term)
        var anchor = buffer === undefined ? 0 : Number(buffer.viewportY)
        if (!Number.isFinite(anchor)) anchor = 0
        var block = neighborTerminalBlock(tabId, anchor, direction)
        if (block === undefined) return false
        selectBlock(block.id)
        return true
      }
      var stepSelectedBlock = function (direction) {
        if (selectedBlock === undefined || tabId === undefined) return
        var block = neighborTerminalBlock(tabId, blockStartLineOf(selectedBlock), direction)
        if (block !== undefined) selectBlock(block.id)
      }

      /* 快捷键：⌘/Ctrl+Shift+Enter。
         挂在 document 的捕获阶段而不是面板内：拖选完终端后浏览器焦点常常落回 body，
         面板内的监听收不到按键。代价是要自己界定适用范围——
           1. 本面板必须可见（多标签时被隐藏的面板 getClientRects 为空，自动让位）；
           2. 事件要么来自面板内部，要么来自页面空白处（body/html，即刚拖选完的状态）；
           3. 焦点在别的输入框（聊天输入等）时完全不接管。
         另：面板内但没有选区时仍然提示，页面空白处没有选区则静默让位。 */
      var selectionRef = react.useRef(false)
      selectionRef.current = hasSelection
      react.useEffect(
        function () {
          if (host === null) return undefined
          var onKeyDown = function (event) {
            /* 块间跳转：只在焦点确实落在本终端里时接管。
               不能像发送快捷键那样放宽到 body——方向键在页面上还有滚动语义。 */
            if (
              (event.ctrlKey || event.metaKey) &&
              event.shiftKey &&
              (event.key === 'ArrowUp' || event.key === 'ArrowDown')
            ) {
              if (!host.isConnected || host.getClientRects().length === 0) return
              var arrowTarget = event.target
              if (!(arrowTarget instanceof Node && host.contains(arrowTarget))) return
              if (blockNavRef.current(event.key === 'ArrowUp' ? -1 : 1)) {
                event.preventDefault()
                event.stopPropagation()
              }
              return
            }
            if (event.key !== 'Enter' || !event.shiftKey) return
            if (!event.ctrlKey && !event.metaKey) return
            if (!host.isConnected || host.getClientRects().length === 0) return
            var target = event.target
            var inside = target instanceof Node && host.contains(target)
            var idle = target === document.body || target === document.documentElement
            if (!inside && !idle) return
            if (!inside && !selectionRef.current) return
            event.preventDefault()
            event.stopPropagation()
            submitRef.current()
          }
          document.addEventListener('keydown', onKeyDown, true)
          return function () { document.removeEventListener('keydown', onKeyDown, true) }
        },
        [host],
      )

      react.useEffect(
        function () { return function () { window.clearTimeout(toastTimer.current) } },
        [],
      )

      /* ---------- 文件面板抽屉（v0.8.0 / S3） ----------
         只在 ssh 书签会话里出现：普通本地终端没有"远端"这个概念，
         给本地终端也开文件面板会让人以为在浏览本机文件（其实是远端），
         语义混乱。本地文件浏览用编辑器自带的就够了。 */
      var fsOpenState = react.useState(false)
      var fsOpen = fsOpenState[0]
      var setFsOpen = fsOpenState[1]
      /* 打开面板时的锚点：优先 ssh 会话的 cwd（远端 $PWD），
         用 remote:别名: 前缀让面板直接落到那台机器那个目录。
         别名取书签名——设置里的远端清单也是按名字建的，同名才连得上。 */
      var fsInitialPath = ''
      if (ssh !== undefined && typeof ssh.bookmark?.name === 'string' && ssh.bookmark.name !== '') {
        var fsDir = typeof ssh.cwd === 'string' && ssh.cwd !== '' ? ssh.cwd : '/'
        fsInitialPath = 'remote:' + ssh.bookmark.name + ':' + fsDir
      }
      var fsToggle =
        ssh === undefined
          ? null
          : jsx('button', {
              type: 'button',
              className: 'tp-fs-toggle',
              'data-open': fsOpen ? 'true' : 'false',
              title: t('fs.toggle'),
              onClick: function () { setFsOpen(!fsOpen) },
              children: t('fs.toggle'),
            })

      return jsxs('div', {
        className: 'tp-wrap',
        ref: hostCb,
        children: [
          jsx(LazyTerminalBody, props),
          jsx(BlockMargin, {
            host: host,
            term: term,
            tabId: tabId,
            selectedId: selectedBlockId,
            onSelect: selectBlock,
            t: t,
          }),
          fsToggle,
          fsOpen
            ? jsx(FsPanelDrawer, { t: t, initialPath: fsInitialPath })
            : null,
          /* 块头：边距点击/快捷键跳转后出现，显示命令、耗时与退出码。
             不做"折叠输出"：那需要改 xterm 的行渲染，和 S4 的取舍冲突。 */
          selectedBlock === undefined
            ? null
            : jsxs('div', {
                className: 'tp-block-head',
                'data-state': blockStateOf(selectedBlock),
                children: [
                  jsxs('div', {
                    className: 'tp-block-head-main',
                    children: [
                      jsx('span', { className: 'tp-block-prompt', children: '$' }),
                      jsx('span', {
                        className: 'tp-block-cmd',
                        title: selectedBlock.command,
                        children:
                          selectedBlock.command === ''
                            ? t('blocks.empty')
                            : selectedBlock.command,
                      }),
                    ],
                  }),
                  jsxs('div', {
                    className: 'tp-block-meta',
                    children: [
                      jsx('span', {
                        className: 'tp-block-time',
                        children:
                          selectedBlock.endedAt === undefined
                            ? t('blocks.running')
                            : t('blocks.duration', {
                                value: formatBlockDuration(
                                  (selectedBlock.endedAt ?? Date.now()) - selectedBlock.startedAt,
                                ),
                              }),
                      }),
                      selectedBlock.exitCode !== undefined
                        ? jsx('span', {
                            className: 'tp-block-rc',
                            children: t('blocks.exit', { code: String(selectedBlock.exitCode) }),
                          })
                        : selectedBlock.endedAt === undefined
                          ? null
                          : jsx('span', {
                              className: 'tp-block-rc',
                              children: t('blocks.exitUnknown'),
                            }),
                    ],
                  }),
                  jsxs('div', {
                    className: 'tp-block-actions',
                    children: [
                      jsx('button', {
                        type: 'button',
                        className: 'tp-block-act',
                        title: t('blocks.prev'),
                        'aria-label': t('blocks.prev'),
                        onClick: function () { stepSelectedBlock(-1) },
                        children: '↑',
                      }),
                      jsx('button', {
                        type: 'button',
                        className: 'tp-block-act',
                        title: t('blocks.next'),
                        'aria-label': t('blocks.next'),
                        onClick: function () { stepSelectedBlock(1) },
                        children: '↓',
                      }),
                      jsx('button', {
                        type: 'button',
                        className: 'tp-block-act',
                        title: t('blocks.close'),
                        'aria-label': t('blocks.close'),
                        onClick: function () { setSelectedBlockId(null) },
                        children: '×',
                      }),
                    ],
                  }),
                ],
              }),
          /* SSH 连接状态胶囊：ssh 书签会话才有；断开时亮红并提供重连
             （重连命令会 cd 回 OSC7 记到的最后一个远端目录）。 */
          ssh === undefined
            ? null
            : jsxs('div', {
                className: 'tp-ssh',
                'data-state': ssh.state,
                title:
                  ssh.failure === 'auth'
                    ? t('ssh.failAuthHint')
                    : ssh.failure === 'connect'
                      ? t('ssh.failConnectHint')
                      : ssh.failure === 'remote'
                        ? t('ssh.failRemoteHint')
                        : ssh.failure === 'closed'
                          ? t('ssh.closedHint')
                          : ssh.retryExhausted === true
                            ? t('ssh.retryExhaustedHint')
                            : undefined,
                children: [
                  jsx('span', { className: 'tp-ssh-dot' }),
                  jsx('span', {
                    className: 'tp-ssh-label',
                    children:
                      ssh.state === 'connected'
                        ? t('ssh.on')
                        : ssh.state === 'connecting'
                          ? t('ssh.connecting')
                          : ssh.reconnecting === true
                            ? t('ssh.auto', { n: String(ssh.retryCount || 1), max: String(5) })
                            : ssh.failure === 'auth'
                              ? t('ssh.failAuth')
                              : ssh.failure === 'connect'
                                ? t('ssh.failConnect')
                                : ssh.failure === 'remote'
                                  ? t('ssh.failRemote')
                                  : t('ssh.off') + (ssh.rc !== undefined ? `（rc=${ssh.rc}）` : ''),
                  }),
                  ssh.state === 'disconnected' && ssh.reconnecting !== true
                    ? jsx('button', {
                        type: 'button',
                        className: 'tp-ssh-btn',
                        onClick: function () { reconnectRef.current(true) },
                        children: t('ssh.retry'),
                      })
                    : null,
                ],
              }),
          /* 有选区时才露出：不选中也不代表没事可做（快捷键会发整屏），
             但常驻按钮会一直占着右上角，所以只在"真的选了东西"时给个明确入口。 */
          hasSelection
            ? jsxs('div', {
                className: 'tp-send',
                children: [
                  jsx('span', { className: 'tp-send-hint', children: t('send.hint') }),
                  jsx('button', {
                    type: 'button',
                    className: 'tp-send-btn',
                    title: t('send.hint'),
                    'data-busy': busy ? 'true' : undefined,
                    disabled: busy,
                    onClick: submit,
                    children: [
                      SendIcon(),
                      t('send.selection'),
                    ],
                  }),
                ],
              })
            : null,
          toast === null
            ? null
            : jsx('div', { className: 'tp-toast', 'data-kind': toast.kind, children: toast.message }),
        ],
      })
    }

    /** 网页标签标题：优先显示主机名，地址还没写时退回“网页”。 */
    function WebTitle(props) {
      var tab = props.useTabInfo().tab
      var nav =
        tab.navigation && typeof tab.navigation.getSnapshot === 'function'
          ? tab.navigation.getSnapshot()
          : undefined
      var navUrl =
        nav !== undefined && nav.params !== undefined && typeof nav.params.url === 'string'
          ? nav.params.url
          : ''
      /* 导航参数只在内存里；标题同时订阅本地副本，刷新后也能显示主机名。 */
      var storedState = react.useState(function () {
        return readStoredWebUrl(props.sessionId, tab.id)
      })
      var stored = storedState[0]
      var setStored = storedState[1]
      react.useEffect(
        function () {
          var refresh = function () {
            setStored(readStoredWebUrl(props.sessionId, tab.id))
          }
          /* 标题可能先于标签主体挂载：挂载后再读一次，避免错过写入。 */
          refresh()
          var unsubscribe = subscribeWebUrl(function (key) {
            if (key === webUrlKey(props.sessionId, tab.id)) refresh()
          })
          return unsubscribe
        },
        [props.sessionId, tab.id],
      )
      var url = navUrl !== '' ? navUrl : stored
      var label = '网页'
      if (url !== '') {
        try {
          var parsed = new URL(url)
          label = parsed.host || url
        } catch (error) {
          label = url
        }
      }
      return jsx('span', { className: 'tp-title', children: label })
    }

    /**
     * 网页标签主体：地址栏 + iframe。
     *
     * 站点若用 X-Frame-Options / CSP frame-ancestors 拒绝嵌入，iframe 会空白；
     * 地址栏右侧的 ↗ 始终可以交给系统浏览器打开。URL 会写回标签导航参数，
     * 刷新页面后仍能恢复。
     */
    function WebPaneRoot(props) {
      var tab = props.useTabInfo().tab
      var nav =
        tab.navigation && typeof tab.navigation.getSnapshot === 'function'
          ? tab.navigation.getSnapshot()
          : undefined
      var navUrl =
        nav !== undefined && nav.params !== undefined && typeof nav.params.url === 'string'
          ? nav.params.url
          : ''
      var storedUrl = readStoredWebUrl(props.sessionId, tab.id)
      var pendingRef = react.useRef(null)
      if (
        pendingRef.current === null &&
        navUrl === '' &&
        storedUrl === '' &&
        PENDING_WEB_URL !== ''
      ) {
        pendingRef.current = PENDING_WEB_URL
      }
      var initialUrl =
        navUrl !== ''
          ? navUrl
          : pendingRef.current !== null
            ? pendingRef.current
            : storedUrl !== '' ? storedUrl : ''
      react.useEffect(
        function () {
          if (pendingRef.current !== null) {
            PENDING_WEB_URL = ''
            pendingRef.current = null
          }
          if (initialUrl !== '') storeWebUrl(props.sessionId, tab.id, initialUrl)
        },
        [],
      )
      var urlState = react.useState(initialUrl)
      var url = urlState[0]
      var setUrl = urlState[1]
      var draftState = react.useState(initialUrl)
      var draft = draftState[0]
      var setDraft = draftState[1]
      var nonceState = react.useState(0)
      var nonce = nonceState[0]
      var setNonce = nonceState[1]

      var persist = function (next) {
        try {
          var right =
            pluginCtx && typeof pluginCtx.get === 'function' ? pluginCtx.get('sidebarRight') : undefined
          var current =
            tab.navigation && typeof tab.navigation.getSnapshot === 'function'
              ? tab.navigation.getSnapshot()
              : undefined
          if (
            right &&
            right.tabDomain &&
            typeof right.tabDomain.navigate === 'function' &&
            current &&
            typeof current.address === 'string'
          ) {
            right.tabDomain.navigate(props.sessionId, tab.id, {
              address: current.address,
              params: { url: next },
            })
          }
        } catch (error) {
          /* 写回导航参数失败不影响当前显示 */
        }
      }

      var go = function (value) {
        var next = normalizeWebUrl(value)
        if (next === '') return
        setUrl(next)
        setDraft(next)
        setNonce(nonce + 1)
        storeWebUrl(props.sessionId, tab.id, next)
        persist(next)
      }

      return jsxs('div', {
        className: 'wb-web',
        'data-web-url': url,
        'data-nav-url': navUrl,
        children: [
        jsxs('div', {
          className: 'wb-web-bar',
          children: [
          jsx('button', {
            type: 'button',
            className: 'wb-web-btn',
            title: '刷新',
            onClick: function () {
              setNonce(nonce + 1)
            },
            children: '⟳',
          }),
          jsx('input', {
            className: 'wb-web-input',
            spellCheck: false,
            value: draft,
            placeholder: '输入网址，回车打开',
            onChange: function (event) {
              setDraft(event.target.value)
            },
            onKeyDown: function (event) {
              if (event.key === 'Enter') {
                event.preventDefault()
                go(draft)
              }
            },
          }),
          jsx('button', {
            type: 'button',
            className: 'wb-web-btn',
            title: '打开',
            onClick: function () {
              go(draft)
            },
            children: '打开',
          }),
          jsx('a', {
            className: 'wb-web-btn',
            href: url === '' ? undefined : url,
            target: '_blank',
            rel: 'noreferrer noopener',
            title: '在浏览器打开',
            children: '↗',
          }),
          ],
        }),
        url === ''
          ? null
          : jsx('div', {
              className: 'wb-web-hint',
              children: '站点若禁止嵌入会显示空白；可点 ↗ 在浏览器打开',
            }),
        url === ''
          ? jsx('div', { className: 'wb-web-empty', children: '输入网址后回车，在右栏打开网页' })
          : jsx('iframe', {
              key: url + '#' + nonce,
              className: 'wb-web-frame',
              src: url,
              title: '网页',
              referrerPolicy: 'no-referrer',
              sandbox:
                'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals',
              allow: 'clipboard-read; clipboard-write; fullscreen',
            }),
        ],
      })
    }

    /**
     * 加载 go2rtc 的 VideoRTC（同源 /camera/player.js）。
     *
     * 为什么不在客户端直接写播放逻辑：RTSP 浏览器不能直接播，go2rtc 负责
     * 拉流并把 H.264 转成 MSE 分片；VideoRTC 负责协商和断线重连。
     * 播放器是 MIT，已 vendor 到 lib/go2rtc-player.js。
     */
    function loadRtspPlayer() {
      if (RTSP_PLAYER_PROMISE !== null) return RTSP_PLAYER_PROMISE
      /* 带构建号：播放器可被浏览器长期缓存，升级插件后 URL 自动变化。 */
      RTSP_PLAYER_PROMISE = import(CAMERA_API + '/player.js?v=' + encodeURIComponent(BUILD_STAMP))
        .then(function (module) {
          if (customElements.get(RTSP_PLAYER_TAG) === undefined) {
            var TwbCameraRtc = class extends module.VideoRTC {
              oninit() {
                super.oninit()
                this.video.controls = false
                this.video.muted = true
                this.video.setAttribute('playsinline', '')
                var self = this
                var reportResolution = function () {
                  self.dispatchEvent(
                    new CustomEvent('twb-resolution', {
                      detail: { width: self.video.videoWidth, height: self.video.videoHeight },
                    }),
                  )
                }
                this.video.addEventListener('playing', function () {
                  self.dispatchEvent(new CustomEvent('twb-playing'))
                  reportResolution()
                })
                this.video.addEventListener('loadedmetadata', reportResolution)
                this.video.addEventListener('resize', reportResolution)
              }

              onopen() {
                var result = super.onopen()
                var self = this
                this.onmessage['stream'] = function (msg) {
                  self.dispatchEvent(new CustomEvent('twb-stream', { detail: msg }))
                }
                return result
              }

              onpcvideo(event) {
                super.onpcvideo(event)
                this.dispatchEvent(new CustomEvent('twb-mode', { detail: 'RTC' }))
              }
            }
            customElements.define(RTSP_PLAYER_TAG, TwbCameraRtc)
          }
          return module
        })
        .catch(function (error) {
          RTSP_PLAYER_PROMISE = null
          throw error
        })
      return RTSP_PLAYER_PROMISE
    }

    /** RTSP 画面：自定义元素里是 go2rtc 的 VideoRTC，外层只负责生命周期。 */
    function CameraRtspPlayer(props) {
      var hostRef = react.useRef(null)
      react.useEffect(
        function () {
          var host = hostRef.current
          if (host === null || props.wsUrl === '') return undefined
          var cancelled = false
          var element = null
          var onStream = function (event) {
            var msg = event.detail || {}
            if (msg.type === 'error') {
              props.onError(String(msg.value || 'go2rtc 拉流失败'))
            } else if (msg.type === 'mse' || msg.type === 'hls' || msg.type === 'mjpeg') {
              props.onMode(String(msg.type).toUpperCase())
            }
          }
          var onPlaying = function () {
            props.onPlaying()
          }
          var onResolution = function (event) {
            var detail = event.detail || {}
            props.onResolution(Number(detail.width) || 0, Number(detail.height) || 0)
          }
          var onMode = function (event) {
            props.onMode(String(event.detail || ''))
          }
          loadRtspPlayer()
            .then(function () {
              if (cancelled) return
              element = document.createElement(RTSP_PLAYER_TAG)
              element.className = 'wb-cam-player'
              /* 只走 MSE：go2rtc 的 WebRTC 监听已关闭，MSE 不需要 ffmpeg。 */
              element.setAttribute('mode', 'mse')
              /* 相机标签切到后台 5 秒后停流，切回来自动重连。
                 多相机场景下避免看不见的标签一直占带宽。 */
              element.visibilityThreshold = 0.01
              element.addEventListener('twb-stream', onStream)
              element.addEventListener('twb-playing', onPlaying)
              element.addEventListener('twb-resolution', onResolution)
              element.addEventListener('twb-mode', onMode)
              host.appendChild(element)
              element.src = props.wsUrl
            })
            .catch(function (error) {
              if (cancelled) return
              props.onError(
                '播放器加载失败：' + String(error && error.message ? error.message : error),
              )
            })
          return function () {
            cancelled = true
            if (element !== null) {
              try {
                element.ondisconnect()
              } catch (error) {
                /* 已经断开 */
              }
              element.remove()
            }
          }
        },
        [props.wsUrl],
      )
      return jsx('div', { ref: hostRef, className: 'wb-cam-player-host' })
    }

    /** 相机标签标题：书签名，退回主机地址。 */
    function CameraTitle(props) {
      var tab = props.useTabInfo().tab
      var nav =
        tab.navigation && typeof tab.navigation.getSnapshot === 'function'
          ? tab.navigation.getSnapshot()
          : undefined
      var navId =
        nav !== undefined && nav.params !== undefined && typeof nav.params.cameraId === 'string'
          ? nav.params.cameraId
          : ''
      var listState = react.useState(readCameras)
      var cameras = listState[0]
      var setCameras = listState[1]
      react.useEffect(function () {
        var refresh = function () {
          setCameras(readCameras())
        }
        refresh()
        return subscribeCameras(refresh)
      }, [])
      var id = navId !== '' ? navId : readStoredCameraId(props.sessionId, tab.id)
      var camera = cameras.filter(function (item) {
        return item.id === id
      })[0]
      return jsx('span', { className: 'tp-title', children: cameraLabel(camera) })
    }

    /**
     * 相机标签主体：参数编辑器 + 同源 MJPEG 画面。
     *
     * 参数就是相机书签：IP、端口、账号、流路径、模式。用户或大模型都可以填；
     * 插件只负责把流取回来。取流走宿主代理（Digest/Basic 认证在宿主完成），
     * 浏览器只看到同源的 multipart 流，因此不会被相机的 X-Frame-Options 拦住。
     */
    function CameraPaneRoot(props) {
      var tab = props.useTabInfo().tab
      var nav =
        tab.navigation && typeof tab.navigation.getSnapshot === 'function'
          ? tab.navigation.getSnapshot()
          : undefined
      var navId =
        nav !== undefined && nav.params !== undefined && typeof nav.params.cameraId === 'string'
          ? nav.params.cameraId
          : ''
      var pendingRef = react.useRef(null)
      if (pendingRef.current === null && navId === '' && PENDING_CAMERA_ID !== '') {
        pendingRef.current = PENDING_CAMERA_ID
        PENDING_CAMERA_ID = ''
      }
      var initialId =
        navId !== ''
          ? navId
          : pendingRef.current !== null
            ? pendingRef.current
            : readStoredCameraId(props.sessionId, tab.id)
      var idState = react.useState(initialId)
      var cameraId = idState[0]
      var setCameraId = idState[1]
      var listState = react.useState(readCameras)
      var cameras = listState[0]
      var setCameras = listState[1]
      react.useEffect(function () {
        var refresh = function () {
          setCameras(readCameras())
        }
        refresh()
        return subscribeCameras(refresh)
      }, [])
      var camera = cameras.filter(function (item) {
        return item.id === cameraId
      })[0]
      /* 实际取流用组密码；书签本身只留归属和组引用。 */
      var credentials = resolveCameraCredentials(camera)

      var editingState = react.useState(
        camera === undefined || camera.host === '' || credentials.password === '',
      )
      var editing = editingState[0]
      var setEditing = editingState[1]
      var draftState = react.useState(camera === undefined ? blankCamera('') : camera)
      var draft = draftState[0]
      var setDraft = draftState[1]
      var nonceState = react.useState(0)
      var nonce = nonceState[0]
      var setNonce = nonceState[1]
      var pausedState = react.useState(false)
      var paused = pausedState[0]
      var setPaused = pausedState[1]
      var streamState = react.useState({ status: 'idle', url: '', wsUrl: '', error: '' })
      var stream = streamState[0]
      var setStream = streamState[1]
      var fitState = react.useState(function () {
        return readCameraFit(initialId)
      })
      var fit = fitState[0]
      var setFit = fitState[1]
      var resolutionState = react.useState({ width: 0, height: 0 })
      var resolution = resolutionState[0]
      var setResolution = resolutionState[1]
      var modeState = react.useState('')
      var playbackMode = modeState[0]
      var setPlaybackMode = modeState[1]
      var noticeState = react.useState('')
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      var probeState = react.useState('')
      var probeNote = probeState[0]
      var setProbeNote = probeState[1]
      var probingState = react.useState(false)
      var probing = probingState[0]
      var setProbing = probingState[1]
      var codecNoteState = react.useState('')
      var codecNote = codecNoteState[0]
      var setCodecNote = codecNoteState[1]
      var codecProbingState = react.useState(false)
      var codecProbing = codecProbingState[0]
      var setCodecProbing = codecProbingState[1]
      var codecRetryRef = react.useRef('')
      var fullscreenState = react.useState(false)
      var pseudoFullscreen = fullscreenState[0]
      var setPseudoFullscreen = fullscreenState[1]
      var viewRef = react.useRef(null)
      var noticeTimer = react.useRef(0)
      var fullscreenTimer = react.useRef(0)

      react.useEffect(
        function () {
          setFit(readCameraFit(cameraId))
          setResolution({ width: 0, height: 0 })
          setPlaybackMode('')
          setPseudoFullscreen(false)
        },
        [cameraId],
      )

      react.useEffect(
        function () {
          return function () {
            if (noticeTimer.current !== 0) window.clearTimeout(noticeTimer.current)
            if (fullscreenTimer.current !== 0) window.clearTimeout(fullscreenTimer.current)
          }
        },
        [],
      )

      /* 原生全屏真正生效后，清掉窗口内全屏兜底和等待计时器。 */
      react.useEffect(
        function () {
          var onChange = function () {
            var view = viewRef.current
            if (view === null || document.fullscreenElement !== view) return
            if (fullscreenTimer.current !== 0) {
              window.clearTimeout(fullscreenTimer.current)
              fullscreenTimer.current = 0
            }
            setPseudoFullscreen(false)
          }
          document.addEventListener('fullscreenchange', onChange)
          return function () {
            document.removeEventListener('fullscreenchange', onChange)
          }
        },
        [],
      )

      react.useEffect(
        function () {
          if (!pseudoFullscreen) return undefined
          var onKey = function (event) {
            if (event.key === 'Escape') setPseudoFullscreen(false)
          }
          window.addEventListener('keydown', onKey)
          return function () {
            window.removeEventListener('keydown', onKey)
          }
        },
        [pseudoFullscreen],
      )

      react.useEffect(
        function () {
          if (editing) setPseudoFullscreen(false)
        },
        [editing],
      )

      var flash = function (text) {
        setNotice(text)
        if (noticeTimer.current !== 0) window.clearTimeout(noticeTimer.current)
        noticeTimer.current = window.setTimeout(function () {
          noticeTimer.current = 0
          setNotice('')
        }, 2200)
      }

      /** 表单里的密码可能留空复用密码组；探测要用实际生效的账号口令。 */
      var effectiveCameraCredentials = function (record) {
        var resolved = resolveCameraCredentials(record)
        var typedPassword = String(record.password ?? '')
        return {
          user: resolved.user,
          password: typedPassword !== '' ? typedPassword : resolved.password,
        }
      }

      /** 请宿主带认证读 SDP，找同一台相机里的 H.264 码流。口令只在请求体里。 */
      var requestH264Path = function (record, creds) {
        var host = String(record.host ?? '').trim()
        if (host === '') return Promise.reject(new Error('先填相机 IP'))
        if (String(creds.password ?? '') === '') return Promise.reject(new Error('先填相机密码'))
        return fetch(CAMERA_API + '/codec', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            host: host,
            port: record.port,
            path: record.path,
            user: creds.user,
            password: creds.password,
          }),
        }).then(function (response) {
          return response
            .json()
            .catch(function () {
              return {}
            })
            .then(function (body) {
              if (!response.ok) {
                if (response.status === 404 || response.status === 405) {
                  throw new Error('宿主版本还是旧的，重启 DSH 后可用')
                }
                throw new Error(
                  body && body.error ? String(body.error) : '查找 H.264 码流失败',
                )
              }
              return body
            })
        })
      }

      var isH265PlaybackError = function (text) {
        return /codecs not matched/i.test(text) && /H265|HEVC/i.test(text)
      }

      var formatStreamError = function (message) {
        var text = String(message || '')
        if (isH265PlaybackError(text)) {
          return (
            '相机输出 H.265，浏览器 MSE 播不了。已尝试自动换 H.264 码流；若仍失败，' +
            '请在相机 Web 把码流改成 H.264，或点「参数」→「找 H.264 码流」。' +
            '（原始错误：' +
            text +
            '）'
          )
        }
        /* go2rtc 的原始错误对现场不直观：DESCRIBE 失败基本都是路径与
           品牌不匹配，直接给出可操作提示，同时保留原始错误便于排查。 */
        if (/DESCRIBE/i.test(text)) {
          return (
            '相机拒绝 RTSP 描述请求，多半是流路径与品牌不匹配：韩华用 /profile3/media.smp，安讯士用 /axis-media/media.amp。点「参数」→「自动识别品牌」可自动修正。（原始错误：' +
            text +
            '）'
          )
        }
        return text
      }

      var showStreamError = function (message) {
        var text = formatStreamError(message)
        setStream(function (prev) {
          return Object.assign({}, prev, { status: 'error', error: text })
        })
      }

      /**
       * 播放器报 H.265 时自动找 H.264 profile 并重连一次。
       * 同一条路径只自动试一次，避免相机确实没有 H.264 时来回重连。
       */
      var autoSwitchH264 = function (record, creds, originalText) {
        var key = String(record.id ?? '') + '|' + String(record.path ?? '')
        if (codecRetryRef.current === key) {
          showStreamError(originalText)
          return
        }
        codecRetryRef.current = key
        setStream({ status: 'loading', url: '', wsUrl: '', error: '' })
        requestH264Path(record, creds)
          .then(function (body) {
            var nextPath = body && body.path ? String(body.path) : ''
            if (body && body.changed === true && nextPath !== '') {
              var corrected = Object.assign({}, record, { path: nextPath })
              upsertCamera(corrected)
              setDraft(corrected)
              flash('相机输出 H.265，已自动切到 H.264：' + nextPath)
              return
            }
            if (body && (body.authFailed === true || body.authRequired === true)) {
              showStreamError(
                '相机输出 H.265，浏览器播不了；自动切换需要相机密码，请点「参数」填写密码后点「找 H.264 码流」。',
              )
              return
            }
            if (body && String(body.codec ?? '') === 'H265') {
              showStreamError(
                '这台相机只输出 H.265，浏览器 MSE 不支持。请在相机 Web 把码流改成 H.264，或换一个有 H.264 子码流的相机。',
              )
              return
            }
            showStreamError(originalText)
          })
          .catch(function (error) {
            showStreamError(
              '相机输出 H.265，自动切换失败：' +
                String(error && error.message ? error.message : error) +
                '。请在相机 Web 把码流改成 H.264，或点「参数」→「找 H.264 码流」。',
            )
          })
      }

      /** 表单里的「找 H.264 码流」：只改草稿路径，保存后才重连。 */
      var probeCodec = function () {
        if (codecProbing) return
        var record = Object.assign({}, draft)
        var creds = effectiveCameraCredentials(record)
        if (String(record.host ?? '').trim() === '') {
          setCodecNote('先填相机 IP')
          return
        }
        if (String(creds.password ?? '') === '') {
          setCodecNote('先填相机密码')
          return
        }
        setCodecProbing(true)
        setCodecNote('查找中…')
        requestH264Path(record, creds)
          .then(function (body) {
            if (body && (body.authFailed === true || body.authRequired === true)) {
              throw new Error('相机拒绝账号或密码')
            }
            var nextPath = body && body.path ? String(body.path) : ''
            if (body && body.changed === true && nextPath !== '') {
              setDraft(function (prev) {
                return Object.assign({}, prev, { path: nextPath })
              })
              setCodecNote('已找到 H.264：' + nextPath)
              return
            }
            if (body && String(body.codec ?? '') === 'H264') {
              setCodecNote('当前路径已经是 H.264')
              return
            }
            if (body && String(body.codec ?? '') === 'H265') {
              setCodecNote('这台相机没有 H.264 码流；请在相机 Web 把码流改成 H.264')
              return
            }
            setCodecNote('没读到视频编码，确认路径和密码')
          })
          .catch(function (error) {
            setCodecNote(
              '查找失败：' + String(error && error.message ? error.message : error),
            )
          })
          .then(function () {
            setCodecProbing(false)
          })
      }

      var toggleFit = function () {
        var next = fit === 'cover' ? 'contain' : 'cover'
        setFit(next)
        writeCameraFit(cameraId, next)
        flash(next === 'cover' ? '画面铺满' : '画面适应')
      }

      var toggleFullscreen = function () {
        var view = viewRef.current
        if (view === null) return
        if (document.fullscreenElement === view) {
          if (typeof document.exitFullscreen === 'function') {
            document.exitFullscreen().catch(function () {
              /* 浏览器拒绝退出时保持现状 */
            })
          }
          return
        }
        if (pseudoFullscreen) {
          setPseudoFullscreen(false)
          return
        }
        var enterPseudo = function () {
          if (document.fullscreenElement === view) return
          setPseudoFullscreen(true)
          flash('已切换为窗口内全屏')
        }
        if (typeof view.requestFullscreen !== 'function') {
          enterPseudo()
          return
        }
        if (fullscreenTimer.current !== 0) window.clearTimeout(fullscreenTimer.current)
        try {
          var request = view.requestFullscreen()
          if (request !== undefined && typeof request.then === 'function') {
            request.catch(function () {
              if (fullscreenTimer.current !== 0) {
                window.clearTimeout(fullscreenTimer.current)
                fullscreenTimer.current = 0
              }
              enterPseudo()
            })
          }
          /* 嵌入式 webview 里 requestFullscreen 可能一直不 resolve，不能让它没反应。 */
          fullscreenTimer.current = window.setTimeout(function () {
            fullscreenTimer.current = 0
            enterPseudo()
          }, 1500)
        } catch (error) {
          enterPseudo()
        }
      }

      /** 下载当前画面：RTSP 从 video 截，兼容模式从 img 截，都是同源画面。 */
      var captureFrame = function () {
        var view = viewRef.current
        if (view === null) return
        var video = view.querySelector('video')
        var image = view.querySelector('.wb-cam-img')
        var source = video !== null ? video : image
        if (source === null) {
          flash('还没有画面')
          return
        }
        var width = Number(video !== null ? video.videoWidth : image.naturalWidth) || 0
        var height = Number(video !== null ? video.videoHeight : image.naturalHeight) || 0
        if (width === 0 || height === 0) {
          flash('还没有画面')
          return
        }
        var canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        var context = canvas.getContext('2d')
        if (context === null) {
          flash('浏览器不支持截图')
          return
        }
        context.drawImage(source, 0, 0, width, height)
        canvas.toBlob(
          function (blob) {
            if (blob === null) {
              flash('截图失败')
              return
            }
            var url = URL.createObjectURL(blob)
            var link = document.createElement('a')
            link.href = url
            link.download =
              (cameraLabel(camera) || 'camera') +
              '-' +
              new Date().toISOString().replace(/[:.]/g, '-') +
              '.jpg'
            document.body.appendChild(link)
            link.click()
            link.remove()
            window.setTimeout(function () {
              URL.revokeObjectURL(url)
            }, 1000)
            flash('已保存当前画面')
          },
          'image/jpeg',
          0.92,
        )
      }

      react.useEffect(
        function () {
          if (cameraId !== '') storeCameraId(props.sessionId, tab.id, cameraId)
        },
        [cameraId],
      )

      /* 书签在别处被改动（设置页/另一个标签）时，把编辑器同步到最新值。 */
      react.useEffect(
        function () {
          if (camera === undefined) return
          setDraft(camera)
          if (camera.host === '' || credentials.password === '') setEditing(true)
        },
        [
          camera === undefined ? '' : camera.id,
          camera === undefined ? '' : camera.host,
          credentials.password,
          camera === undefined ? '' : camera.path,
          camera === undefined ? '' : camera.mode,
          camera === undefined ? '' : camera.vehicle,
          camera === undefined ? '' : camera.project,
          camera === undefined ? false : camera.spreader,
          camera === undefined ? '' : camera.passwordGroup,
          camera === undefined ? '' : camera.terminalBookmarkId,
        ],
      )

      var stopSession = function (id) {
        if (typeof id !== 'string' || id === '') return
        try {
          fetch(CAMERA_API + '/close', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: id }),
          }).catch(function () {
            /* 关不掉只影响宿主内存，TTL 会回收 */
          })
        } catch (error) {
          /* 页面卸载时 fetch 可能直接抛 */
        }
      }

      react.useEffect(
        function () {
          if (paused || editing || camera === undefined || camera.host === '') {
            setStream({ status: 'idle', url: '', wsUrl: '', error: '' })
            return undefined
          }
          var cancelled = false
          var createdId = ''
          setStream({ status: 'connecting', url: '', wsUrl: '', error: '' })
          setResolution({ width: 0, height: 0 })
          setPlaybackMode('')
          fetch(CAMERA_API + '/session', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              host: camera.host,
              port: camera.port,
              scheme: camera.scheme,
              user: credentials.user,
              password: credentials.password,
              path: camera.path,
              snapshotPath: camera.snapshotPath,
              mode: camera.mode,
            }),
          })
            .then(function (response) {
              return response.json().then(function (body) {
                return { ok: response.ok, body: body }
              })
            })
            .then(function (result) {
              if (result.ok !== true) {
                throw new Error(
                  result.body && result.body.error ? result.body.error : '建立相机会话失败',
                )
              }
              createdId = String(result.body.id)
              if (cancelled) {
                stopSession(createdId)
                return
              }
              /* 宿主识别到品牌路径不匹配（例如韩华相机配了安讯士路径）时会自动
                 纠正；把纠正后的路径写回书签，下次打开就不用再探测。 */
              var detectedPath = result.body.path ? String(result.body.path) : ''
              if (
                camera.mode === 'rtsp' &&
                detectedPath !== '' &&
                detectedPath !== camera.path
              ) {
                var corrected = Object.assign({}, camera, { path: detectedPath })
                upsertCamera(corrected)
                setDraft(corrected)
                flash(
                  result.body.codecChanged === true
                    ? '相机输出 H.265，已自动切到 H.264：' + detectedPath
                    : '已识别为 ' +
                        (result.body.brand ? String(result.body.brand) : '相机') +
                        '，流路径改为 ' +
                        detectedPath,
                )
                return
              }
              if (camera.mode === 'rtsp') {
                var wsUrl = result.body.wsUrl ? String(result.body.wsUrl) : ''
                if (wsUrl === '') throw new Error('宿主没有返回 RTSP 播放地址')
                setStream({ status: 'loading', url: '', wsUrl: wsUrl, error: '' })
                return
              }
              setStream({
                status: 'loading',
                url:
                  CAMERA_API +
                  '/stream?id=' +
                  encodeURIComponent(createdId) +
                  '&t=' +
                  Date.now(),
                wsUrl: '',
                error: '',
              })
            })
            .catch(function (error) {
              if (cancelled) return
              setStream({
                status: 'error',
                url: '',
                wsUrl: '',
                error: String(error && error.message ? error.message : error),
              })
            })
          return function () {
            cancelled = true
            stopSession(createdId)
          }
        },
        [
          camera === undefined ? '' : camera.host,
          camera === undefined ? 0 : camera.port,
          camera === undefined ? '' : camera.scheme,
          credentials.user,
          credentials.password,
          camera === undefined ? '' : camera.path,
          camera === undefined ? '' : camera.snapshotPath,
          camera === undefined ? '' : camera.mode,
          editing,
          paused,
          nonce,
        ],
      )

      /* 12 秒还没出画面就给出可操作的错误，别让人对着黑屏等。 */
      react.useEffect(
        function () {
          if (stream.status !== 'connecting' && stream.status !== 'loading') return undefined
          var timer = window.setTimeout(function () {
            setStream(function (prev) {
              if (prev.status !== 'connecting' && prev.status !== 'loading') return prev
              return {
                status: 'error',
                url: '',
                wsUrl: '',
                error: '12 秒内没有收到相机画面。检查地址、端口、账号或流路径。',
              }
            })
          }, 12000)
          return function () {
            window.clearTimeout(timer)
          }
        },
        [stream.status, stream.url],
      )

      var save = function () {
        var record = normalizeCamera(
          Object.assign({}, draft, { id: camera === undefined ? draft.id : camera.id }),
        )
        if (record === null) {
          window.alert('请填写相机地址')
          return
        }
        if (record.name === '') record.name = record.host
        /* 密码组：填了新密码且组已存在时，先确认再覆盖全组。 */
        var groupKey = cameraPasswordGroupKey(record)
        var groups = readCameraPasswordGroups()
        var existingGroup = groupKey === '' ? undefined : groups[groupKey]
        var typedPassword = String(record.password ?? '')
        if (
          groupKey !== '' &&
          typedPassword !== '' &&
          existingGroup !== undefined &&
          existingGroup.password !== typedPassword &&
          !window.confirm(
            '「' + cameraPasswordGroupLabel(groupKey) + '」已有密码组。保存会用新密码更新该组全部相机，继续？',
          )
        ) {
          return
        }
        var prepared = applyCameraPasswordGroup(record)
        var saved = upsertCamera(prepared.record)
        if (saved === undefined) return
        setCameraId(saved.id)
        storeCameraId(props.sessionId, tab.id, saved.id)
        setDraft(saved)
        /* 既没新密码、组里也没有：保存书签但留在编辑页，别让人对着黑屏猜。 */
        if (typedPassword === '' && existingGroup === undefined) {
          flash('已保存书签；填写密码后才能取流')
          return
        }
        setEditing(false)
        setPaused(false)
        setNonce(nonce + 1)
      }

      var remove = function () {
        if (camera === undefined) return
        if (!window.confirm('删除相机书签「' + cameraLabel(camera) + '」？')) return
        removeCamera(camera.id)
        forgetCameraTab(props.sessionId, tab.id)
        if (typeof props.closeTab === 'function') props.closeTab(tab.id)
      }

      var field = function (label, key, placeholder, type) {
        return jsxs('div', {
          className: 'wb-cam-row',
          children: [
            jsx('span', { className: 'wb-cam-label', children: label }),
            jsx('input', {
              className: 'wb-cam-input',
              type: type === undefined ? 'text' : type,
              spellCheck: false,
              placeholder: placeholder,
              value: draft[key] === undefined ? '' : draft[key],
              onChange: function (event) {
                var next = Object.assign({}, draft)
                next[key] = event.target.value
                setDraft(next)
              },
            }),
          ],
        })
      }

      var preset = function (label, patch) {
        return jsx('button', {
          type: 'button',
          className: 'wb-cam-preset',
          onClick: function () {
            setDraft(Object.assign({}, draft, patch))
          },
          children: label,
        })
      }

      /** 切换模式时顺手把端口和默认路径带到对应协议，少让人手改。 */
      var changeMode = function (nextMode) {
        var next = Object.assign({}, draft, { mode: nextMode })
        if (nextMode === 'rtsp') {
          if (Number(next.port) === 80 || next.port === '') next.port = CAMERA_RTSP_PORT
          if (
            next.path === '' ||
            next.path === CAMERA_DEFAULT_MJPEG_PATH ||
            next.path === CAMERA_DEFAULT_SNAPSHOT
          ) {
            next.path = cameraDefaultRtspPath(next.spreader)
          }
        } else {
          if (Number(next.port) === CAMERA_RTSP_PORT) next.port = 80
          if (
            nextMode === 'mjpeg' &&
            (next.path === '' ||
              next.path === CAMERA_DEFAULT_RTSP_PATH ||
              next.path === CAMERA_DEFAULT_SPREADER_RTSP_PATH ||
              next.path === CAMERA_DEFAULT_HANWHA_RTSP_PATH)
          ) {
            next.path = CAMERA_DEFAULT_MJPEG_PATH
          }
          if (
            nextMode === 'snapshot' &&
            (next.path === '' ||
              next.path === CAMERA_DEFAULT_RTSP_PATH ||
              next.path === CAMERA_DEFAULT_SPREADER_RTSP_PATH ||
              next.path === CAMERA_DEFAULT_HANWHA_RTSP_PATH ||
              next.path === CAMERA_DEFAULT_MJPEG_PATH)
          ) {
            next.path = CAMERA_DEFAULT_SNAPSHOT
          }
        }
        setDraft(next)
      }

      /** 自动识别品牌：宿主发不带口令的 DESCRIBE，按 401/404 判断路径是否存在。 */
      var probeCamera = function () {
        var host = String(draft.host ?? '').trim()
        if (host === '') {
          setProbeNote('先填相机 IP')
          return
        }
        if (probing) return
        setProbing(true)
        setProbeNote('识别中…')
        fetch(CAMERA_API + '/probe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            host: host,
            port: draft.port,
            path: draft.mode === 'rtsp' ? draft.path : '',
          }),
        })
          .then(function (response) {
            return response
              .json()
              .catch(function () {
                return {}
              })
              .then(function (body) {
                return { ok: response.ok, status: response.status, body: body }
              })
          })
          .then(function (result) {
            if (result.ok !== true) {
              /* 宿主还没重启时 /probe 路由不存在（404/405）：给一句能照做的提示。 */
              if (result.status === 404 || result.status === 405) {
                throw new Error('宿主版本还是旧的，重启 DSH 后可用；现在请直接点品牌预设')
              }
              throw new Error(
                result.body && result.body.error ? result.body.error : '识别失败',
              )
            }
            var brand = result.body.brand ? String(result.body.brand) : '未知品牌'
            var nextPath = result.body.path ? String(result.body.path) : ''
            if (nextPath !== '' && nextPath !== draft.path) {
              setDraft(function (prev) {
                return Object.assign({}, prev, { path: nextPath })
              })
              setProbeNote('识别为 ' + brand + '，已填入 ' + nextPath)
            } else {
              setProbeNote('识别为 ' + brand + '，当前路径可用')
            }
          })
          .catch(function (error) {
            setProbeNote('识别失败：' + String(error && error.message ? error.message : error))
          })
          .then(function () {
            setProbing(false)
          })
      }

      /* 归属不让手填：车号就是 SSH 书签标题，项目就是书签分组名。 */
      var ownerParts = []
      if (draft.vehicle !== '') ownerParts.push('车号 ' + draft.vehicle)
      if (draft.project !== '') ownerParts.push('项目 ' + draft.project)
      var ownerText = ownerParts.length === 0 ? '未识别' : ownerParts.join(' · ')
      var ownerHint =
        ownerParts.length === 0
          ? '从 SSH 终端悬浮按钮打开相机会自动带出车号（书签标题）和项目（分组名）。'
          : draft.project === ''
            ? draft.spreader === true
              ? '项目未识别：请从对应项目的 SSH 书签分组打开相机（默认分组不算项目）。'
              : '车号来自 SSH 书签标题；同车普通相机可复用密码。'
            : '车号取 SSH 书签标题，项目取书签分组名，不用手填。'
      /* 有来源链接时明确告诉用户：归属不是快照，会跟着 SSH 书签走。 */
      if (String(draft.terminalBookmarkId ?? '') !== '') {
        var linkedBookmark = readBookmarks().filter(function (mark) {
          return mark.id === draft.terminalBookmarkId
        })[0]
        ownerHint =
          linkedBookmark === undefined
            ? '来源 SSH 书签已删除，暂按上次归属显示；重新从终端打开可恢复跟随。'
            : '跟随 SSH 书签「' +
              (String(linkedBookmark.name ?? '').trim() || linkedBookmark.host) +
              '」：书签改名或换分组后，车号、项目和密码组会自动同步。'
      }

      /* 密码组提示：让用户知道现在是在复用、创建，还是单独存。 */
      var draftGroupKey = cameraPasswordGroupKey(draft)
      var draftGroup = draftGroupKey === '' ? undefined : readCameraPasswordGroups()[draftGroupKey]
      var draftGroupLabel = cameraPasswordGroupLabel(draftGroupKey)
      var passwordHint =
        draftGroupKey === ''
          ? draft.spreader === true
            ? '项目未识别：从对应项目的 SSH 书签分组打开相机后，可与同项目其他车共用密码。'
            : '车号未识别：从 SSH 终端悬浮按钮打开相机后，同车普通相机可复用密码。'
          : draftGroup !== undefined
            ? '已绑定「' + draftGroupLabel + '」密码组：留空即复用；填写新密码会更新该组全部相机。'
            : '保存后会用当前密码创建「' + draftGroupLabel + '」密码组，之后同组相机留空即可复用。'

      var form = jsxs('div', {
        className: 'wb-cam-form',
        'data-camera-form': '1',
        children: [
          field('名称', 'name', '可留空，默认显示 IP'),
          field('主机', 'host', '相机 IP，如 192.168.10.20'),
          field('端口', 'port', draft.mode === 'rtsp' ? '554' : '80'),
          draft.mode === 'rtsp'
            ? null
            : jsxs('div', {
                className: 'wb-cam-row',
                children: [
                  jsx('span', { className: 'wb-cam-label', children: '协议' }),
                  jsxs('select', {
                    className: 'wb-cam-select',
                    value: draft.scheme,
                    onChange: function (event) {
                      setDraft(Object.assign({}, draft, { scheme: event.target.value }))
                    },
                    children: [
                      jsx('option', { value: 'http', children: 'http' }, 'http'),
                      jsx('option', { value: 'https', children: 'https' }, 'https'),
                    ],
                  }),
                ],
              }),
          jsxs('div', {
            className: 'wb-cam-row',
            children: [
              jsx('span', { className: 'wb-cam-label', children: '归属' }),
              jsxs('div', {
                className: 'wb-cam-owner',
                children: [
                  jsx('span', { children: ownerText }),
                  jsx('span', { className: 'wb-cam-owner-hint', children: ownerHint }),
                ],
              }),
            ],
          }),
          jsxs('div', {
            className: 'wb-cam-row',
            children: [
              jsx('span', { className: 'wb-cam-label', children: '吊具相机' }),
              jsxs('label', {
                className: 'wb-cam-check',
                children: [
                  jsx('input', {
                    type: 'checkbox',
                    checked: draft.spreader === true,
                    onChange: function (event) {
                      var checked = event.target.checked
                      var next = Object.assign({}, draft, { spreader: checked })
                      /* 勾选吊具时顺手切到 camera=5；取消时切回大车默认。
                         用户手改过的路径不动，避免覆盖现场特殊配置。 */
                      if (next.mode === 'rtsp') {
                        if (checked && (next.path === '' || next.path === CAMERA_DEFAULT_RTSP_PATH)) {
                          next.path = CAMERA_DEFAULT_SPREADER_RTSP_PATH
                        } else if (!checked && next.path === CAMERA_DEFAULT_SPREADER_RTSP_PATH) {
                          next.path = CAMERA_DEFAULT_RTSP_PATH
                        }
                      }
                      setDraft(next)
                    },
                  }),
                  jsx('span', { children: '一拖四 .34 主机（密码按项目共用）' }),
                ],
              }),
            ],
          }),
          field('用户名', 'user', 'root'),
          jsxs('div', {
            className: 'wb-cam-row',
            children: [
              jsx('span', { className: 'wb-cam-label', children: '密码' }),
              jsx('input', {
                className: 'wb-cam-input',
                /* 现场要求明文显示：密码只存浏览器 localStorage，不进 URL / 日志。 */
                type: 'text',
                autoComplete: 'off',
                spellCheck: false,
                placeholder: draftGroup !== undefined ? '留空复用密码组' : '相机密码（明文，只存浏览器本地）',
                value: draft.password === undefined ? '' : draft.password,
                onChange: function (event) {
                  setDraft(Object.assign({}, draft, { password: event.target.value }))
                },
              }),
            ],
          }),
          jsx('div', { className: 'wb-cam-group-hint', children: passwordHint }),
          field('流路径', 'path', draft.mode === 'rtsp' ? cameraDefaultRtspPath(draft.spreader) : CAMERA_DEFAULT_MJPEG_PATH),
          jsxs('div', {
            className: 'wb-cam-row',
            children: [
              jsx('span', { className: 'wb-cam-label', children: '模式' }),
              jsxs('select', {
                className: 'wb-cam-select',
                value: draft.mode,
                onChange: function (event) {
                  changeMode(event.target.value)
                },
                children: [
                  jsx('option', { value: 'rtsp', children: 'RTSP 流（推荐）' }, 'rtsp'),
                  jsx('option', { value: 'mjpeg', children: 'MJPEG 流（兼容）' }, 'mjpeg'),
                  jsx('option', { value: 'snapshot', children: 'JPEG 快照（兼容）' }, 'snapshot'),
                ],
              }),
            ],
          }),
          draft.mode === 'rtsp'
            ? null
            : field('快照路径', 'snapshotPath', '留空按 Axis 规则推导'),
          jsx('div', {
            className: 'wb-cam-presets',
            children: [
              preset('安讯士 大车（38-45）', {
                port: CAMERA_RTSP_PORT,
                scheme: 'http',
                user: 'root',
                path: CAMERA_DEFAULT_RTSP_PATH,
                mode: 'rtsp',
              }),
              preset('安讯士 吊具（camera=5）', {
                port: CAMERA_RTSP_PORT,
                scheme: 'http',
                user: 'root',
                path: CAMERA_DEFAULT_SPREADER_RTSP_PATH,
                mode: 'rtsp',
              }),
              preset('韩华 大车', {
                port: CAMERA_RTSP_PORT,
                scheme: 'http',
                user: 'root',
                path: CAMERA_DEFAULT_HANWHA_RTSP_PATH,
                mode: 'rtsp',
              }),
              preset('海康 RTSP', {
                port: CAMERA_RTSP_PORT,
                scheme: 'http',
                user: 'admin',
                path: '/Streaming/Channels/101',
                mode: 'rtsp',
              }),
              preset('海康 102 子码流（流畅）', {
                port: CAMERA_RTSP_PORT,
                scheme: 'http',
                user: 'admin',
                path: '/Streaming/Channels/102',
                mode: 'rtsp',
              }),
              preset('大华 RTSP', {
                port: CAMERA_RTSP_PORT,
                scheme: 'http',
                user: 'admin',
                path: '/cam/realmonitor?channel=1&subtype=0',
                mode: 'rtsp',
              }),
              preset('大华 子码流（流畅）', {
                port: CAMERA_RTSP_PORT,
                scheme: 'http',
                user: 'admin',
                path: '/cam/realmonitor?channel=1&subtype=1',
                mode: 'rtsp',
              }),
              preset('Axis MJPEG（兼容）', {
                port: 80,
                scheme: 'http',
                user: 'root',
                path: CAMERA_DEFAULT_MJPEG_PATH,
                mode: 'mjpeg',
              }),
            ],
          }),
          draft.mode !== 'rtsp'
            ? null
            : jsxs('div', {
                className: 'wb-cam-row',
                children: [
                  jsx('span', { className: 'wb-cam-label', children: '识别' }),
                  jsxs('div', {
                    className: 'wb-cam-owner',
                    children: [
                      jsx('button', {
                        type: 'button',
                        className: 'wb-cam-preset',
                        disabled: probing,
                        onClick: probeCamera,
                        children: probing ? '识别中…' : '自动识别品牌',
                      }),
                      jsx('button', {
                        type: 'button',
                        className: 'wb-cam-preset',
                        disabled: codecProbing,
                        onClick: probeCodec,
                        children: codecProbing ? '查找中…' : '找 H.264 码流',
                      }),
                      probeNote === ''
                        ? null
                        : jsx('span', { className: 'wb-cam-owner-hint', children: probeNote }),
                      codecNote === ''
                        ? null
                        : jsx('span', { className: 'wb-cam-owner-hint', children: codecNote }),
                    ],
                  }),
                ],
              }),
          jsxs('div', {
            className: 'wb-cam-actions',
            children: [
              jsx('button', {
                type: 'button',
                className: 'wb-cam-action',
                'data-primary': '1',
                onClick: save,
                children: '保存并播放',
              }),
              camera === undefined
                ? null
                : jsx('button', {
                    type: 'button',
                    className: 'wb-cam-action',
                    onClick: function () {
                      setDraft(camera)
                      setEditing(false)
                      setNonce(nonce + 1)
                    },
                    children: '取消',
                  }),
              camera === undefined
                ? null
                : jsx('button', {
                    type: 'button',
                    className: 'wb-cam-action',
                    'data-danger': '1',
                    onClick: remove,
                    children: '删除书签',
                  }),
            ],
          }),
          jsx('div', {
            className: 'wb-cam-hint',
            children:
              '统一走 RTSP：宿主用 go2rtc 拉流，浏览器用 MSE 播放，不需要 ffmpeg。密码只存在浏览器 localStorage；车号自动取 SSH 书签标题、项目自动取书签分组名，同车普通相机共用密码组，同项目吊具相机共用，组内留空即复用。go2rtc 按需启动、空闲 180 秒退出。MJPEG/JPEG 是兼容模式，留给只提供 HTTP 流的老相机。画面卡顿或延迟大时，优先点「海康 102 子码流」或「大华 子码流」——子码流码率低，通常比主码流流畅得多。浏览器 MSE 只稳定支持 H.264；相机输出 H.265 时播放器会自动找同品牌 H.264 profile，找不到就点「找 H.264 码流」或到相机 Web 把码流改成 H.264。',
          }),
        ],
      })

      var overlay = null
      if (editing) {
        overlay = null
      } else if (paused) {
        overlay = jsxs('div', {
          className: 'wb-cam-overlay',
          children: [
            jsx('span', { children: '已暂停' }),
            jsx('button', {
              type: 'button',
              className: 'wb-cam-btn',
              onClick: function () {
                setPaused(false)
              },
              children: '继续播放',
            }),
          ],
        })
      } else if (stream.status === 'error') {
        overlay = jsxs('div', {
          className: 'wb-cam-overlay',
          'data-kind': 'error',
          children: [
            jsx('span', { children: stream.error || '画面加载失败' }),
            jsxs('div', {
              className: 'wb-cam-actions',
              children: [
                jsx('button', {
                  type: 'button',
                  className: 'wb-cam-btn',
                  onClick: function () {
                    codecRetryRef.current = ''
                    setNonce(nonce + 1)
                  },
                  children: '重试',
                }),
                camera !== undefined && /H\.?265/i.test(stream.error)
                  ? jsx('button', {
                      type: 'button',
                      className: 'wb-cam-btn',
                      onClick: function () {
                        codecRetryRef.current = ''
                        autoSwitchH264(camera, credentials, stream.error)
                      },
                      children: '自动换 H.264',
                    })
                  : null,
                jsx('button', {
                  type: 'button',
                  className: 'wb-cam-btn',
                  onClick: function () {
                    setDraft(camera === undefined ? blankCamera('') : camera)
                    setEditing(true)
                  },
                  children: '参数',
                }),
              ],
            }),
          ],
        })
      } else if (stream.status === 'connecting' || stream.status === 'loading') {
        overlay = jsx('div', {
          className: 'wb-cam-overlay',
          children: jsx('span', {
            children: stream.status === 'connecting' ? '正在连接相机…' : '等待画面…',
          }),
        })
      } else if (camera === undefined) {
        overlay = jsxs('div', {
          className: 'wb-cam-overlay',
          children: [
            jsx('span', { children: '相机书签不存在或已被删除' }),
            jsx('button', {
              type: 'button',
              className: 'wb-cam-btn',
              onClick: function () {
                setDraft(blankCamera(''))
                setEditing(true)
              },
              children: '新建相机',
            }),
          ],
        })
      }

      var image =
        stream.url === ''
          ? null
          : jsx('img', {
              key: stream.url,
              className: 'wb-cam-img',
              src: stream.url,
              alt: cameraLabel(camera),
              onLoad: function (event) {
                var target = event.target
                var width = Number(target.naturalWidth) || 0
                var height = Number(target.naturalHeight) || 0
                setResolution({ width: width, height: height })
                setPlaybackMode(camera !== undefined && camera.mode === 'snapshot' ? '快照' : 'MJPEG')
                setStream(function (prev) {
                  return prev.status === 'error'
                    ? prev
                    : Object.assign({}, prev, { status: 'playing' })
                })
              },
              onError: function () {
                setStream(function (prev) {
                  return Object.assign({}, prev, {
                    status: 'error',
                    error: '画面加载失败：检查地址、账号、流路径，或相机是否可达。',
                  })
                })
              },
            })

      var rtspPlayer =
        editing || camera === undefined || camera.mode !== 'rtsp' || stream.wsUrl === ''
          ? null
          : jsx(CameraRtspPlayer, {
              wsUrl: stream.wsUrl,
              onPlaying: function () {
                setStream(function (prev) {
                  return prev.status === 'playing'
                    ? prev
                    : Object.assign({}, prev, { status: 'playing', error: '' })
                })
              },
              onError: function (message) {
                var text = String(message || '')
                if (
                  camera !== undefined &&
                  camera.mode === 'rtsp' &&
                  isH265PlaybackError(text)
                ) {
                  autoSwitchH264(camera, credentials, text)
                  return
                }
                showStreamError(text)
              },
              onResolution: function (width, height) {
                setResolution(function (prev) {
                  return prev.width === width && prev.height === height
                    ? prev
                    : { width: width, height: height }
                })
              },
              onMode: function (mode) {
                setPlaybackMode(function (prev) {
                  return prev === mode ? prev : mode
                })
              },
            })

      var metaText = ''
      if (!editing) {
        if (resolution.width > 0 && resolution.height > 0) {
          metaText = resolution.width + '×' + resolution.height
        }
        if (playbackMode !== '') metaText += (metaText === '' ? '' : ' · ') + playbackMode
        var streamLabel = cameraStreamLabel(camera)
        if (streamLabel !== '') metaText += (metaText === '' ? '' : ' · ') + streamLabel
      }

      var tools = editing
        ? null
        : jsxs('div', {
            className: 'wb-cam-tools',
            children: [
              jsx('button', {
                type: 'button',
                className: 'wb-cam-tool',
                title: paused ? '继续播放' : '暂停',
                onClick: function () {
                  setPaused(!paused)
                },
                children: paused ? '▶' : '⏸',
              }),
              jsx('button', {
                type: 'button',
                className: 'wb-cam-tool',
                title: '重新连接',
                onClick: function () {
                  setNonce(nonce + 1)
                },
                children: '⟳',
              }),
              jsx('button', {
                type: 'button',
                className: 'wb-cam-tool',
                title: fit === 'cover' ? '切换为适应窗口' : '切换为铺满窗口',
                onClick: toggleFit,
                children: fit === 'cover' ? '铺满' : '适应',
              }),
              jsx('button', {
                type: 'button',
                className: 'wb-cam-tool',
                title: '保存当前画面',
                onClick: captureFrame,
                children: '⤓',
              }),
              jsx('button', {
                type: 'button',
                className: 'wb-cam-tool',
                title: pseudoFullscreen ? '退出全屏' : '全屏（双击画面也可以）',
                onClick: toggleFullscreen,
                children: '⛶',
              }),
            ],
          })

      return jsxs('div', {
        className: 'wb-cam',
        'data-camera-id': cameraId,
        children: [
          jsxs('div', {
            className: 'wb-cam-bar',
            children: [
              jsx('span', {
                className: 'wb-cam-dot',
                'data-state': editing ? 'paused' : paused ? 'paused' : stream.status,
              }),
              jsx('span', {
                className: 'wb-cam-name',
                children:
                  camera === undefined
                    ? '相机'
                    : cameraLabel(camera) +
                      (camera.name !== '' && camera.host !== '' ? ' · ' + camera.host : ''),
              }),
              metaText === ''
                ? null
                : jsx('span', { className: 'wb-cam-meta', children: metaText }),
              jsx('button', {
                type: 'button',
                className: 'wb-cam-btn',
                title: '相机参数',
                onClick: function () {
                  if (editing) {
                    setEditing(false)
                  } else {
                    setDraft(camera === undefined ? blankCamera('') : camera)
                    setEditing(true)
                  }
                },
                children: '⚙',
              }),
            ],
          }),
          editing
            ? form
            : jsxs('div', {
                className: 'wb-cam-view',
                ref: viewRef,
                'data-fit': fit,
                'data-paused': paused ? '1' : '0',
                'data-error': stream.status === 'error' ? '1' : '0',
                'data-fullscreen': pseudoFullscreen ? '1' : '0',
                children: [
                  jsxs('div', {
                    className: 'wb-cam-stage',
                    onDoubleClick: toggleFullscreen,
                    children: [rtspPlayer, image],
                  }),
                  overlay,
                  tools,
                  notice === ''
                    ? null
                    : jsx('div', { className: 'wb-cam-toast', children: notice }),
                ],
              }),
        ],
      })
    }

    function TerminalPaneRoot(props) {
      var tab = props.useTabInfo().tab
      var initialInput =
        typeof props.initialInput === 'function' ? props.initialInput(tab.id) : undefined
      /* 原始命令（不管是否已投递）：刷新后 initialInput 会被 sessionStorage
         标记挡掉，但标签参数里还留着它，用它恢复 SSH 会话状态。 */
      var restoredInput =
        typeof props.initialInputRaw === 'function' ? props.initialInputRaw(tab.id) : undefined
      var meta = useTabMeta(tab.id)
      var bookmarkTitle = typeof props.bookmarkTitle === 'function' ? props.bookmarkTitle(tab.id) : undefined
      var next = Object.assign({}, props, {
        initialInput: initialInput,
        restoredInput: restoredInput,
        markInitialInputSent: props.markInitialInputSent,
        terminalTitle: meta?.title ?? bookmarkTitle,
        tabId: tab.id,
        contentId: typeof tab.contentId === 'string' ? tab.contentId : undefined,
      })
      return jsx(SelectionSend, next)
    }

    var terminalInject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'webTerminals', 'theme', 'shortcuts']

    function applyTerminal(ctx) {
      var t = ctx.locale.bind(NS)

      ctx.effect(() => {
        var el = document.createElement('style')
        el.setAttribute('data-terminal-plus', '')
        el.setAttribute('data-tp-build', BUILD_STAMP)
        el.textContent = TERMINAL_CSS
        document.head.appendChild(el)
        return () => {
          el.remove()
        }
      }, 'terminal-plus: styles')

      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh: {
              title: '新建终端',
              description: '选择一个 shell 开始新的会话',
              new: '新建终端',
              loading: '正在加载可用 shell…',
              placeholder: '输入命令或 ssh user@host，回车新建终端',
              recent: '最近连接',
              recentEmpty: '还没有记录：用上面的输入框跑一次命令就会出现在这里',
              recentClear: '清除最近连接',
              bookmarks: 'SSH 书签',
              bookmarksEmpty: '在设置里添加 SSH 书签',
              rename: '重命名终端',
              shortcut: '新建终端',
              'shortcut.noSession': '当前没有可用的会话',
              'send.selection': '发给对话',
              'send.hint': '发送选中内容；不选中则发整屏（⌘/Ctrl+Shift+Enter）',
              'send.empty': '终端里还没有可发送的内容',
              'send.ok': '已发给当前对话',
              'send.okScreen': '已把整屏发给当前对话（未选中内容）',
              'send.fail': '发送失败：{message}',
              'send.unavailable': '终端还没就绪，稍后再试',
              'send.noSession': '当前没有可接收的对话会话',
              'send.noChannel': '会话通道不可用（缺少 remote.session）',
              'send.prefix': '来自终端「{title}」的输出：',
              'send.untitled': '终端',
              'ssh.connecting': 'SSH 连接中…',
              'ssh.on': 'SSH 已连接',
              'ssh.off': 'SSH 已断开',
              'ssh.failConnect': 'SSH 连接失败（认证或网络）',
              'ssh.failConnectHint': 'ssh 退出码 255：主机不可达、端口不通或认证被拒。请检查地址/端口/密钥/密码后点「重连」。',
              'ssh.failAuth': 'SSH 认证失败',
              'ssh.failAuthHint': '认证被拒绝或主机密钥校验失败（见屏幕上的 ssh 报错）。认证错误重试无意义，已停止自动重连；请修正密码/密钥后点「重连」。',
              'ssh.retryExhaustedHint': '自动重连已达到 5 次上限，已停止。请检查网络后点「重连」。',
              'ssh.failRemoteHint': 'ssh 退出码 1：远端命令执行失败，连接本身已结束。',
              'ssh.closedHint': '远端会话正常结束（退出码 0）。点「重连」可回到上次所在目录。',
              'ssh.failRemote': 'SSH 已断开（远端命令失败）',
              'ssh.retry': '重连',
              'ssh.auto': 'SSH 断开，自动重连中…（第 {n}/{max} 次）',
              'ssh.setting': 'SSH 断线自动重连（3s→6s→12s→24s→30s，最多 5 次；认证失败不重试）',
              'blocks.empty': '（空命令）',
              'blocks.running': '执行中…',
              'blocks.duration': '耗时 {value}',
              'blocks.exit': '退出码 {code}',
              'blocks.exitUnknown': '退出码未知',
              'blocks.prev': '上一个命令块（⌘/Ctrl+Shift+↑）',
              'blocks.next': '下一个命令块（⌘/Ctrl+Shift+↓）',
              'blocks.close': '关闭块头',
              'fs.toggle': '文件',
              'fs.loading': '载入中…',
              'fs.emptyDir': '空目录',
              'fs.noRemotes': '还没有配置远端：先在设置里添加一台机器',
              'fs.up': '上一级',
              'fs.refresh': '刷新',
              'fs.newFolder': '新建目录',
              'fs.newFolderName': '新建文件夹',
              'fs.rename': '重命名',
              'fs.renameTo': '重命名为',
              'fs.remove': '删除',
              'fs.confirmRemove': '确认删除',
              'fs.confirmDir': '整个目录',
              'fs.confirmFile': '这个文件',
              'fs.confirmWarn': '远端没有回收站，删除后无法恢复。',
              'fs.save': '保存',
              'fs.cancel': '取消',
              'fs.truncated': '条目过多，只显示前 2000 个',
            },
            en: {
              title: 'New terminal',
              description: 'Pick a shell to start a new session',
              new: 'New terminal',
              loading: 'Loading available shells…',
              placeholder: 'Type a command or ssh user@host, press Enter to open',
              recent: 'Recent',
              recentEmpty: 'Nothing yet: run a command above and it will show up here',
              bookmarks: 'SSH bookmarks',
              bookmarksEmpty: 'Add SSH bookmarks in Settings',
              rename: 'Rename terminal',
              shortcut: 'New terminal',
              'shortcut.noSession': 'No session available',
              'send.selection': 'Send to chat',
              'send.hint': 'Send selection, or the whole screen if none (⌘/Ctrl+Shift+Enter)',
              'send.empty': 'Nothing to send in this terminal yet',
              'send.ok': 'Sent to the current conversation',
              'send.okScreen': 'Sent the whole screen (nothing was selected)',
              'send.fail': 'Send failed: {message}',
              'send.unavailable': 'Terminal not ready yet, try again',
              'send.noSession': 'No conversation available to receive it',
              'send.noChannel': 'Conversation channel unavailable (missing remote.session)',
              'send.prefix': 'Output from terminal "{title}":',
              'send.untitled': 'terminal',
              'ssh.connecting': 'SSH connecting…',
              'ssh.on': 'SSH connected',
              'ssh.off': 'SSH disconnected',
              'ssh.failConnect': 'SSH connect failed (auth or network)',
              'ssh.failConnectHint': 'ssh exit 255: host unreachable, port closed, or auth rejected. Check address/port/key/password, then Retry.',
              'ssh.failAuth': 'SSH authentication failed',
              'ssh.failAuthHint': 'Authentication was rejected or host key verification failed (see the ssh message on screen). Retrying cannot fix this, so auto-reconnect stopped. Fix the password/key, then Retry.',
              'ssh.retryExhaustedHint': 'Auto-reconnect reached its 5-attempt limit and stopped. Check the network, then Retry.',
              'ssh.failRemoteHint': 'ssh exit 1: the remote command failed; the connection has ended.',
              'ssh.closedHint': 'Remote session ended normally (exit 0). Retry reconnects to the last directory.',
              'ssh.failRemote': 'SSH closed (remote command failed)',
              'ssh.retry': 'Reconnect',
              'ssh.auto': 'SSH disconnected, reconnecting… ({n}/{max})',
              'ssh.setting': 'Auto-reconnect SSH after disconnect (3s→6s→12s→24s→30s, up to 5 attempts; not on auth failure)',
              'blocks.empty': '(empty command)',
              'blocks.running': 'Running…',
              'blocks.duration': 'Took {value}',
              'blocks.exit': 'Exit {code}',
              'blocks.exitUnknown': 'Exit code unknown',
              'blocks.prev': 'Previous command block (Cmd/Ctrl+Shift+↑)',
              'blocks.next': 'Next command block (Cmd/Ctrl+Shift+↓)',
              'blocks.close': 'Close block header',
              'fs.toggle': 'Files',
              'fs.loading': 'Loading…',
              'fs.emptyDir': 'Empty directory',
              'fs.noRemotes': 'No remote configured yet — add a machine in Settings first',
              'fs.up': 'Up one level',
              'fs.refresh': 'Refresh',
              'fs.newFolder': 'New folder',
              'fs.newFolderName': 'New folder',
              'fs.rename': 'Rename',
              'fs.renameTo': 'Rename to',
              'fs.remove': 'Delete',
              'fs.confirmRemove': 'Delete ',
              'fs.confirmDir': 'this whole directory',
              'fs.confirmFile': 'this file',
              'fs.confirmWarn': 'There is no recycle bin on the remote — this cannot be undone.',
              'fs.save': 'Save',
              'fs.cancel': 'Cancel',
              'fs.truncated': 'Too many entries — showing the first 2000',
            },
          }),
        'terminal-plus: locale',
      )

      /* ---------- 反向通道的宿主侧实现：把一段文本投递到当前会话 ----------
         服务全部惰性取（ctx.get）：uiSession / sessions / remote 任一缺席都不会拖垮
         整个插件，只是这条通道不可用，点按钮时给出可读的提示。 */
      var CLIENT_TIME_ZONE = (function () {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone
        } catch (error) {
          return undefined
        }
      })()

      function randomRequestId() {
        if (typeof window.crypto !== 'undefined' && typeof window.crypto.randomUUID === 'function')
          return window.crypto.randomUUID()
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (slot) {
          var value = (Math.random() * 16) | 0
          return ((slot === 'x' ? value : (value & 0x3) | 0x8)).toString(16)
        })
      }

      /**
       * 惰性取服务：uiSession 由 ui 插件提供，可能缺席。
       * 缺席时返回 undefined，让调用方走兜底，而不是让整个插件起不来。
       */
      function serviceSafe(name) {
        try {
          return ctx.get(name)
        } catch (error) {
          return undefined
        }
      }

      /** 当前会话：uiSession 的主视图绑定优先，退回 sessions 列表里被 mainView 持有的那个。 */
      function currentSessionId() {
        var uiSession = serviceSafe('uiSession')
        var key =
          uiSession !== undefined && uiSession !== null && typeof uiSession.current !== 'undefined'
            ? uiSession.current.getSnapshot().key
            : undefined
        if (typeof key === 'string' && key !== '') return key
        var sessions = serviceSafe('sessions')
        var list =
          sessions !== undefined && sessions !== null && typeof sessions.list !== 'undefined'
            ? sessions.list.getSnapshot()
            : undefined
        if (list === undefined || list === null || typeof list.byId !== 'object') return undefined
        var ids = Array.isArray(list.ids) ? list.ids : Object.keys(list.byId)
        for (var index = 0; index < ids.length; index += 1) {
          var row = list.byId[ids[index]]
          if (row !== undefined && (row.retainedBy === undefined ? 0 : row.retainedBy.mainView ?? 0) > 0)
            return row.id
        }
        return undefined
      }

      /**
       * 把一段终端内容投递到会话。
       * @param text - 正文（选区或整屏）
       * @param title - 终端标题，用于来源标注
       * @param options - `{ sessionId, scope }`；sessionId 是该终端**所属**会话
       *   （跨会话终端时比"当前正在看的会话"更合理），scope 决定标注措辞
       */
      sendSelection = function (text, title, options) {
        /* 归属优先：这个终端属于哪个会话，就发给哪个会话。拿不到（老版本没传
           sessionId、或终端已脱离会话）才退回"当前正在看的会话"。 */
        var owned = options === undefined || options === null ? undefined : options.sessionId
        var sessionId = typeof owned === 'string' && owned !== '' ? owned : currentSessionId()
        if (sessionId === undefined) throw new Error(t('send.noSession'))
        /* remote / remote.session 已在 inject 里声明，直接读；缺席只可能发生在
           宿主版本差异，这里给出可读提示而不是让按钮点了没反应。 */
        var channel = ctx.remote === undefined || ctx.remote === null ? undefined : ctx.remote.session
        if (channel === undefined || typeof channel.prompt !== 'function')
          throw new Error(t('send.noChannel'))
        /* 带一行来源标注：让模型知道这段文本出自终端，但不替用户决定拿它做什么。 */
        var label = typeof title === 'string' && title !== '' ? title : t('send.untitled')
        var body = t('send.prefix', { title: label }) + '\n' + text
        var request = {
          requestId: randomRequestId(),
          sessionId: sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: body }],
        }
        if (CLIENT_TIME_ZONE !== undefined) request.clientTimeZone = CLIENT_TIME_ZONE
        return Promise.resolve(channel.prompt(request)).then(function (result) {
          if (result !== undefined && result !== null && result.ok === false)
            throw new Error((result.error === undefined ? '' : result.error.message) || 'request rejected')
          return result
        })
      }
      terminalText = t

      /* 主题 hook：传给渲染层，主题切换时重取配色。 */
      var theme = {
        getSnapshot: () => ctx.theme.getTheme(),
        subscribe: (listener) => ctx.on('theme/change', listener),
      }

      /* 窗口持有：只保留当前会话里仍打开的终端标签，关闭的标签释放进程。 */
      ctx.effect(() => {
        var sync = () => {
          ctx.webTerminals.retainTabs(
            ctx.sidebarRight.openTabs.getSnapshot().filter((tab) => tab.kind === KIND),
          )
        }
        var unsubscribe = ctx.sidebarRight.openTabs.subscribe(sync)
        sync()
        return () => {
          unsubscribe()
          ctx.webTerminals.retainTabs([])
        }
      }, 'terminal-plus: window-holds')

      /* 定位一次终端标签对应的 TerminalView（terminalId 与 shellPath 来自导航参数）。 */
      var target = (sessionId, key) =>
        ctx.sidebarRight.tabDomain.occurrence(sessionId, { id: key }).navigation.getSnapshot().params
      var bookmarkTitleFor = (sessionId, key) => {
        var params = target(sessionId, key)
        var contentId
        try {
          contentId = ctx.sidebarRight.tabDomain.occurrence(sessionId, { id: key }).navigation.getSnapshot().address
        } catch (error) {
          contentId = undefined
        }
        return terminalTitleForTab(key, params === undefined ? undefined : params.title, contentId)
      }
      /* initialInput 是一次性动作而非持久标签配置。终端会随会话切换重挂载，
         因此投递状态存入 browser sessionStorage：同一浏览器会话内保持，关闭浏览器即清除。
         键只保存命令指纹，不把 SSH 命令或可能的敏感参数暴露在 storage 里。 */
      var initialInputStoragePrefix = 'dsh-terminal-workbench:initial-input:'
      var initialInputPrefix = (sessionId, key) =>
        initialInputStoragePrefix + encodeURIComponent(String(sessionId)) + ':' + encodeURIComponent(String(key)) + ':'
      var initialInputFingerprint = (input) => {
        var hash = 2166136261
        var text = String(input)
        for (var index = 0; index < text.length; index += 1) {
          hash ^= text.charCodeAt(index)
          hash = Math.imul(hash, 16777619)
        }
        return (hash >>> 0).toString(16)
      }
      var initialInputStorageKey = (sessionId, key, input) =>
        initialInputPrefix(sessionId, key) + initialInputFingerprint(input)
      var initialInputWasSent = (sessionId, key, input) => {
        try {
          return window.sessionStorage.getItem(initialInputStorageKey(sessionId, key, input)) === 'sent'
        } catch (error) {
          console.warn('[terminal-workbench] 无法读取初始命令投递状态：', error)
          return false
        }
      }
      var markInitialInputSent = (sessionId, key, input) => {
        try {
          window.sessionStorage.setItem(initialInputStorageKey(sessionId, key, input), 'sent')
        } catch (error) {
          console.warn('[terminal-workbench] 无法保存初始命令投递状态：', error)
        }
      }
      var clearInitialInputMarkers = (sessionId, key) => {
        var prefix = initialInputPrefix(sessionId, key)
        try {
          for (var index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
            var storageKey = window.sessionStorage.key(index)
            if (storageKey !== null && storageKey.startsWith(prefix)) window.sessionStorage.removeItem(storageKey)
          }
        } catch (error) {
          console.warn('[terminal-workbench] 无法清理初始命令投递状态：', error)
        }
      }
      /* 恢复用的身份只能来自导航参数：新建标签必须让 webTerminals 自己生成
         id（createWhenMissing=true），不能把绑定里的旧 id 当成已存在终端。 */
      var restoredTerminalId = (sessionId, key) => {
        var params = target(sessionId, key)
        return params !== undefined && 'terminalId' in params ? params.terminalId : undefined
      }
      /* 角标/关闭用的身份：导航参数没有时，从已挂载视图或持久绑定补齐。
         新建标签在首次渲染时可能还没有绑定，终端挂载后的标题刷新会再次解析。 */
      var terminalId = (sessionId, key) => {
        var params = target(sessionId, key)
        var views = ctx.webTerminals.views
        var mounted = views !== undefined && typeof views.get === 'function' ? views.get(sessionId)?.get(key) : undefined
        var binding
        var bindings = ctx.webTerminals.bindings
        if (bindings !== undefined && typeof bindings.get === 'function') {
          var contentId = ctx.sidebarRight.tabDomain.occurrence(sessionId, { id: key }).navigation.getSnapshot().address
          if (typeof contentId === 'string' && contentId !== '') binding = bindings.get(sessionId, contentId)
        }
        return resolveTerminalId(params, mounted, binding)
      }
      var view = (sessionId, key) => {
        var params = target(sessionId, key)
        var contentId = ctx.sidebarRight.tabDomain.occurrence(sessionId, { id: key }).navigation.getSnapshot().address
        return ctx.webTerminals.view(
          sessionId,
          key,
          contentId,
          restoredTerminalId(sessionId, key),
          params !== undefined && 'shellPath' in params ? params.shellPath : undefined,
        )
      }

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: 'dsh-terminal-plus',
            kind: KIND,
            multiple: true,
            priority: 'builtin',
            title: () => t('title'),
            guide: [
              {
                id: 'new',
                order: 20,
                title: () => t('title'),
                description: () => t('description'),
              },
            ],
          }),
        'terminal-plus: type',
      )

      ctx.effect(
        () =>
          ctx.sidebarRight.registerCloseHandler(KIND, (sessionId, tab) => {
            clearInitialInputMarkers(sessionId, tab.id)
            forgetSshSession(tab.id)
            forgetTerminalBlocks(tab.id)
            /* 统一走关闭策略：宿主已确认不存在的终端只丢标签，不留重试标记。 */
            closeTerminalTab(ctx, sessionId, tab, terminalId(sessionId, tab.id))
          }),
        'terminal-plus: close',
      )

      /* 新建终端快捷键（Ctrl+`），与原生一致。 */
      ctx.effect(
        () =>
          ctx.shortcuts.register({
            id: 'terminal.new',
            label: () => t('shortcut'),
            aliases: ['new terminal', 'shell'],
            defaults: {
              'desktop:macos': { code: 'Backquote', modifiers: ['control'] },
              'desktop:windows': { code: 'Backquote', modifiers: ['control'] },
              'desktop:linux': { code: 'Backquote', modifiers: ['control'] },
              'web:macos': { code: 'Backquote', modifiers: ['control'] },
              'web:windows': { code: 'Backquote', modifiers: ['control'] },
            },
            regions: ['page', 'editable', 'terminal'],
            modals: [],
            resolve: ({ target: element }) => {
              var found = ctx.sidebarRight.commandTarget(element)
              if (found === undefined) {
                return { status: 'blocked', reason: t('shortcut.noSession') }
              }
              return {
                status: 'handled',
                run: () => {
                  ctx.sidebarRight.openTabFromTarget(KIND, found)
                },
              }
            },
          }),
        'terminal-plus: shortcut',
      )

      /* 终端主体：懒加载渲染 chunk。 */
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: 'dsh-terminal-plus',
                locale: NS,
                inject: (sessionId) => (LAST_SESSION_ID = sessionId, {
                  view: (key) => view(sessionId, key),
                  keyedHooks: { terminal: (key) => view(sessionId, key).state },
                  hooks: { theme: theme },
                  bookmarkTitle: (key) => bookmarkTitleFor(sessionId, key),
                  /* 新建标签可携带一条初始命令（如 ssh user@host），由渲染层在首屏后写入。 */
                  initialInput: (key) => {
                    var params = target(sessionId, key)
                    var input =
                      params !== undefined && typeof params.initialInput === 'string' ? params.initialInput : undefined
                    return input !== undefined && !initialInputWasSent(sessionId, key, input) ? input : undefined
                  },
                  /* 原始命令（不判断是否投递过）：刷新后恢复 SSH 会话状态用。 */
                  initialInputRaw: (key) => {
                    var params = target(sessionId, key)
                    return params !== undefined && typeof params.initialInput === 'string' ? params.initialInput : undefined
                  },
                  /* 仅在渲染层成功写入 PTY 后标记，避免尚未写入就切换会话而丢命令。 */
                  markInitialInputSent: (key, input) => {
                    if (typeof input === 'string' && input !== '') markInitialInputSent(sessionId, key, input)
                  },
                  /* 恢复失败的旧标签由渲染层主动关掉，避免空壳堆积；
                     关掉后腾出的名额由 openTab 重新开一个真终端。 */
                  closeTab: (key) => {
                    ctx.sidebarRight.close(key)
                  },
                  openTab: () => {
                    ctx.sidebarRight.openTab(KIND)
                  },
                }),
              },
              TerminalPaneRoot,
            ),
          ),
        'terminal-plus: pane',
      )

      /* 标签标题。 */
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab.title',
                key: 'dsh-terminal-plus',
                locale: NS,
                inject: (sessionId) => (LAST_SESSION_ID = sessionId, {
                  sessionId,
                  terminalId: (key) => terminalId(sessionId, key),
                  view: (key) => view(sessionId, key),
                  keyedHooks: { terminal: (key) => view(sessionId, key).state },
                  hooks: { tabs: ctx.sidebarRight.openTabs },
                  bookmarkTitle: (key) => bookmarkTitleFor(sessionId, key),
                }),
              },
              TerminalTitle,
            ),
          ),
        'terminal-plus: title',
      )

      /* 网页标签类型：和终端共用右栏 dock，加号菜单里可直接新建。 */
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: WEB_TYPE_ID,
            kind: WEB_KIND,
            multiple: true,
            priority: 'builtin',
            title: () => '网页',
            guide: [
              {
                id: 'web',
                order: 30,
                title: () => '网页',
                description: () => '在右栏打开网页',
              },
            ],
          }),
        'terminal-plus: web type',
      )

      ctx.effect(
        () =>
          ctx.sidebarRight.registerCloseHandler(WEB_KIND, (sessionId, tab) => {
            forgetWebUrl(sessionId, tab.id)
          }),
        'terminal-plus: web close',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: WEB_TYPE_ID,
                locale: NS,
                inject: (sessionId) => ({ sessionId }),
              },
              WebPaneRoot,
            ),
          ),
        'terminal-plus: web pane',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab.title',
                key: WEB_TYPE_ID,
                locale: NS,
                inject: (sessionId) => ({ sessionId }),
              },
              WebTitle,
            ),
          ),
        'terminal-plus: web title',
      )

      /* 相机标签类型：和终端/网页共用右栏 dock，内容是同源 MJPEG。 */
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: CAMERA_TYPE_ID,
            kind: CAMERA_KIND,
            multiple: true,
            priority: 'builtin',
            title: () => '相机',
            guide: [
              {
                id: 'camera',
                order: 31,
                title: () => '相机',
                description: () => '在右栏查看相机画面',
              },
            ],
          }),
        'terminal-plus: camera type',
      )

      ctx.effect(
        () =>
          ctx.sidebarRight.registerCloseHandler(CAMERA_KIND, (sessionId, tab) => {
            forgetCameraTab(sessionId, tab.id)
          }),
        'terminal-plus: camera close',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: CAMERA_TYPE_ID,
                locale: NS,
                inject: (sessionId) => ({
                  sessionId,
                  closeTab: (key) => ctx.sidebarRight.close(key),
                }),
              },
              CameraPaneRoot,
            ),
          ),
        'terminal-plus: camera pane',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab.title',
                key: CAMERA_TYPE_ID,
                locale: NS,
                inject: (sessionId) => ({ sessionId }),
              },
              CameraTitle,
            ),
          ),
        'terminal-plus: camera title',
      )

      /* 宿主标签菜单：追加与自绘菜单共用的重命名/固定动作。宿主槽只能追加，
         因此保留自绘菜单作为兼容入口，避免替换宿主已有动作。 */
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.tab.menu.item', () => {
            var registerAction = function (id, order, label, action) {
              return ctx.slots.register(
                { name: 'sidebar.right.tab.menu.item', id: id, order: order },
                function TabMenuAction(props) {
                  var tab = props.tab
                  var meta = tabMetaOf(tab.id) ?? {}
                  var text = typeof label === 'function' ? label(meta) : label
                  return jsx('button', {
                    type: 'button',
                    role: 'menuitem',
                    className: 'wb-menu-item',
                    onClick: function () {
                      try { action(tab.id, meta) }
                      catch (error) { console.warn('[terminal-workbench] 标签菜单动作失败：', error) }
                      finally { props.dismiss() }
                    },
                    children: text,
                  })
                },
              )
            }
            var disposeRename = registerAction('dsh-terminal-workbench.rename', 20, '重命名终端', function (tabId, meta) {
              var input = window.prompt('重命名终端', meta.title ?? '')
              if (input !== null) setTabMeta(tabId, { title: input.trim() === '' ? undefined : input.trim() })
            })
            var disposePin = registerAction('dsh-terminal-workbench.pin', 21, function (meta) {
              return meta.pinned === true ? '取消固定终端' : '固定终端'
            }, function (tabId, meta) {
              setTabMeta(tabId, { pinned: meta.pinned !== true })
            })
            return function () { disposePin(); disposeRename() }
          }),
        'terminal-plus: tab menu items',
      )

      /* 标签右键菜单：官方菜单槽只追加动作，自绘菜单保留完整关闭/导出动作。 */
      ctx.effect(function () {
        var menu = null

        var closeMenu = function () {
          if (menu !== null) {
            menu.remove()
            menu = null
          }
        }

        var currentSession = function () {
          var host = Array.prototype.slice.call(document.querySelectorAll('[data-sidebar-right-session]')).find(function (el) {
            return el.closest('[hidden]') === null && el.getAttribute('aria-hidden') !== 'true'
          })
          var fromDom = host === undefined ? undefined : host.getAttribute('data-sidebar-right-session')
          return typeof fromDom === 'string' && fromDom !== '' ? fromDom : LAST_SESSION_ID
        }

        /* 标签顺序与 id 以 DOM 为准：钩子里的标签对象与 store 快照形态不同，
           直接读 [data-dockkit-tab] 才与用户看到的一致。 */
        var domTabIds = function (tabId) {
          var tabs = Array.prototype.slice.call(document.querySelectorAll('.wb-terminal-col [data-dockkit-tab]'))
          var session = currentSession()
          var source = tabs.find(function (el) {
            var owner = el.closest('[data-sidebar-right-session]')
            return el.getAttribute('data-dockkit-tab') === tabId && el.closest('[hidden]') === null &&
              owner !== null && owner.getAttribute('data-sidebar-right-session') === session
          })
          var pane = source === undefined ? null : source.closest('[data-dockkit-pane], [data-dockkit-float]')
          if (pane === null) throw new Error('找不到标签所属面板，未关闭任何终端')
          return Array.prototype.map.call(pane.querySelectorAll('[data-dockkit-tab]'), function (el) {
            return el.getAttribute('data-dockkit-tab')
          }).filter(function (id) { return typeof id === 'string' && id !== '' })
        }

        var actionsFor = function (tabId) {
          var session = currentSession()
          var closeTabs = function (ids) {
            if (typeof session !== 'string' || currentSession() !== session) {
              throw new Error('当前会话已切换，请重新打开标签菜单')
            }
            var failures = 0
            ids.forEach(function (id) {
              try { ctx.sidebarRight.close(id) }
              catch (error) {
                failures += 1
                console.warn('[terminal-workbench] 标签关闭失败：', error)
              }
            })
            if (failures > 0) throw new Error(String(failures) + ' 个标签未能关闭，请重试')
          }
          return [
            [
              '重命名',
              function () {
                var meta = tabMetaOf(tabId) ?? {}
                var input = window.prompt('重命名终端', meta.title ?? '')
                if (input === null) return
                var next = input.trim()
                setTabMeta(tabId, { title: next === '' ? undefined : next })
              },
            ],
            [
              tabMetaOf(tabId)?.pinned === true ? '取消固定' : '固定标签',
              function () {
                setTabMeta(tabId, { pinned: tabMetaOf(tabId)?.pinned !== true })
              },
            ],
            [
              '关闭其他',
              function () {
                closeTabs(domTabIds(tabId).filter(function (id) { return id !== tabId }))
              },
            ],
            [
              readFilesCollapsed() ? '展开文件标签行' : '收起文件标签行',
              function () {
                writeFilesCollapsed(readFilesCollapsed() !== true)
                document.dispatchEvent(new CustomEvent('dsh-terminal-workbench:files-row-toggle'))
              },
            ],
            [
              '向右分屏',
              function () {
                try {
                  if (ctx.sidebarRight.split() === undefined) {
                    console.warn('[terminal-workbench] 分屏未生效：已达 2 块上限、当前面板不支持或会话未挂载')
                  }
                } catch (error) {
                  console.warn('[terminal-workbench] 分屏失败：', error)
                }
              },
            ],
            [
              '导出输出…',
              function () {
                document.dispatchEvent(
                  new CustomEvent('dsh-terminal-workbench:export-log', { detail: { tabId: tabId } }),
                )
              },
            ],
            [
              '设置…',
              function () {
                document.dispatchEvent(new CustomEvent('dsh-terminal-workbench:open-settings'))
              },
            ],
            [
              '关闭右侧',
              function () {
                var ids = domTabIds(tabId)
                var at = ids.indexOf(tabId)
                if (at < 0) throw new Error('目标标签已经关闭，请重新打开菜单')
                closeTabs(ids.slice(at + 1))
              },
            ],
          ]
        }

        var openMenu = function (tabId, x, y) {
          closeMenu()
          var el = document.createElement('div')
          el.className = 'wb-tabmenu'
          el.setAttribute('role', 'menu')
          el.setAttribute('data-tab-id', tabId)
          actionsFor(tabId).forEach(function (pair) {
            var item = document.createElement('button')
            item.type = 'button'
            item.className = 'wb-menu-item'
            item.setAttribute('role', 'menuitem')
            item.textContent = pair[0]
            item.addEventListener('click', function () {
              try {
                pair[1]()
              } catch (error) {
                /* 单个动作失败不影响菜单与终端 */
                console.warn('[terminal-workbench] 单个动作失败不影响菜单与终端：', error)
                document.dispatchEvent(new CustomEvent('dsh-terminal-workbench:notice', {
                  detail: { tabId: tabId, message: error.message || String(error), error: true },
                }))
              }
              closeMenu()
            })
            el.appendChild(item)
          })
          el.style.left = x + 'px'
          el.style.top = y + 'px'
          document.body.appendChild(el)
          var rect = el.getBoundingClientRect()
          if (rect.right > window.innerWidth - 8) {
            el.style.left = Math.max(8, window.innerWidth - rect.width - 8) + 'px'
          }
          if (rect.bottom > window.innerHeight - 8) {
            el.style.top = Math.max(8, window.innerHeight - rect.height - 8) + 'px'
          }
          menu = el
        }

        var onContextMenu = function (event) {
          var target = event.target
          if (!(target instanceof Element)) return
          var tab = target.closest('.wb-terminal-col [data-dockkit-tab]')
          if (tab === null) {
            closeMenu()
            return
          }
          var tabId = tab.getAttribute('data-dockkit-tab')
          if (typeof tabId !== 'string' || tabId === '') return
          event.preventDefault()
          openMenu(tabId, event.clientX, event.clientY)
        }

        var onPointerDown = function (event) {
          var target = event.target
          if (!(target instanceof Element)) return
          if (menu !== null && !menu.contains(target)) closeMenu()
        }

        var onKeyDown = function (event) {
          if (event.key === 'Escape') closeMenu()
        }

        var onResize = function () {
          closeMenu()
        }

        document.addEventListener('contextmenu', onContextMenu, true)
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('resize', onResize)
        return function () {
          document.removeEventListener('contextmenu', onContextMenu, true)
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('resize', onResize)
          closeMenu()
        }
      }, 'terminal-plus: tab-menu')

      /* 原生设置页分区：设置里出现「终端工作台」页签（宿主未声明槽位时安静跳过）。 */
      try {
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: 'terminal-workbench',
              order: 30,
              label: function () {
                return '终端工作台'
              },
            },
            SettingsBody,
          )
        })
      } catch (error) {
        console.warn('[terminal-workbench] settings.section 注册失败：', error)
      }

      /* 终端标签与文件标签分两行：按需在标签条里插入一个 100% 宽的换行占位元素，
         只有「两类同时存在」时才插；单个标签类型时保持原状。 */
      ctx.effect(function () {
        var frame = null
        var sync = function () {
          var strips = document.querySelectorAll('.wb-terminal-col [data-dockkit-strip-tabs]')
          for (var i = 0; i < strips.length; i += 1) {
            var strip = strips[i]
            var tabs = strip.children
            var hasTerminal = false
            var hasOther = false
            for (var j = 0; j < tabs.length; j += 1) {
              var item = tabs[j]
              if (item.getAttribute('role') !== 'tab') continue
              if (item.querySelector('.tp-badge') !== null) hasTerminal = true
              else hasOther = true
            }
            var mark = strip.querySelector('[data-tp-strip-break]')
            var need = hasTerminal && hasOther
             /* 标签固定状态和顺序按持久化元数据恢复。 */
             var terminalTabs = []
             var metaChanged = false
             for (var k = 0; k < tabs.length; k += 1) {
               var terminalTab = tabs[k]
               if (terminalTab.getAttribute('role') !== 'tab' || terminalTab.querySelector('.tp-badge') === null) continue
               var terminalId = terminalTab.getAttribute('data-dockkit-tab')
               var terminalMeta = tabMetaOf(terminalId) ?? {}
               var savedOrder = Number.isFinite(Number(terminalMeta.order)) ? Number(terminalMeta.order) : terminalTabs.length
               terminalTabs.push({ el: terminalTab, id: terminalId, meta: terminalMeta, order: savedOrder })
             }
             terminalTabs.sort(function (left, right) {
               var pinDelta = (right.meta.pinned === true ? 1 : 0) - (left.meta.pinned === true ? 1 : 0)
               return pinDelta !== 0 ? pinDelta : left.order - right.order
             })
             terminalTabs.forEach(function (entry, index) {
               var pinnedValue = entry.meta.pinned === true ? 'true' : 'false'
               if (entry.el.getAttribute('data-tp-pinned') !== pinnedValue) entry.el.setAttribute('data-tp-pinned', pinnedValue)
               if (entry.el.style.order !== String(index)) entry.el.style.order = String(index)
               if (entry.meta.order !== index) {
                 TAB_META.set(entry.id, Object.assign({}, entry.meta, { order: index }))
                 metaChanged = true
               }
             })
             if (metaChanged) writeTabMetaStore()
            if (need && mark === null) {
              var breakEl = document.createElement('div')
              breakEl.setAttribute('data-tp-strip-break', '1')
              breakEl.setAttribute('aria-hidden', 'true')
              strip.appendChild(breakEl)
            } else if (need !== true && mark !== null) {
              mark.remove()
            }
            /* 折叠态只改属性，不往 React 管理的标签条里塞元素（会破坏 reconciliation）。 */
            if (need !== true) {
              strip.removeAttribute('data-tp-files-collapsed')
              continue
            }
            if (readFilesCollapsed()) strip.setAttribute('data-tp-files-collapsed', '1')
            else strip.removeAttribute('data-tp-files-collapsed')
          }
        }
        var schedule = function () {
          if (frame !== null) return
          frame = window.requestAnimationFrame(function () {
            frame = null
            sync()
          })
        }
        var observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true })
        document.addEventListener('dsh-terminal-workbench:files-row-toggle', schedule)
        schedule()
        return function () {
          observer.disconnect()
          document.removeEventListener('dsh-terminal-workbench:files-row-toggle', schedule)
          if (frame !== null) window.cancelAnimationFrame(frame)
          var marks = document.querySelectorAll('[data-tp-strip-break]')
          for (var i = 0; i < marks.length; i += 1) marks[i].remove()
        }
      }, 'terminal-plus: strip-rows')

      /* 标签变多时把激活标签滚进可视区，加号靠 sticky 常驻右侧。 */
      ctx.effect(function () {
        var frame = null
        var schedule = function () {
          if (frame !== null) return
          frame = window.requestAnimationFrame(function () {
            frame = null
            var strip = document.querySelector('.wb-terminal-col [data-dockkit-strip]')
            if (strip === null) return
            var active = strip.querySelector('[data-dockkit-tab][aria-selected="true"]')
            if (active === null) return
            var stripBox = strip.getBoundingClientRect()
            var tabBox = active.getBoundingClientRect()
            if (tabBox.right > stripBox.right - 36) {
              strip.scrollLeft += tabBox.right - stripBox.right + 40
            } else if (tabBox.left < stripBox.left) {
              strip.scrollLeft -= stripBox.left - tabBox.left + 8
            }
          })
        }
        var observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true })
        schedule()
        return function () {
          observer.disconnect()
          if (frame !== null) window.cancelAnimationFrame(frame)
        }
      }, 'terminal-plus: tab-scroll')

      /* 相机前缀跟随终端：记住最后一次选中的终端标签。相机/网页标签激活时
         没有终端标签是 aria-selected=true，必须靠这份记忆避免串到别的车。 */
      ctx.effect(function () {
        if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return undefined
        if (document.body === null || document.body === undefined) return undefined
        var observer = new MutationObserver(function () {
          rememberActiveTerminalTab()
        })
        observer.observe(document.body, {
          attributes: true,
          attributeFilter: [
            'aria-selected',
            'aria-hidden',
            'hidden',
            'data-dockkit-pane-active',
            'data-dockkit-float-active',
          ],
          subtree: true,
        })
        rememberActiveTerminalTab()
        return function () {
          observer.disconnect()
        }
      }, 'camera-prefix: active terminal')

      /* guide 入口：会话尚无终端标签时 DSH 会自动开一张指南页，
         这里提供卡片内容，避免它变成既无内容又挡住加号的死标签。 */
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.tab.guide.entry', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.tab.guide.entry',
                key: 'dsh-terminal-plus',
                locale: NS,
                inject: (sessionId) => (LAST_SESSION_ID = sessionId, {
                  hooks: { shortcuts: ctx.shortcuts.catalog },
                  loadShells: (signal) => ctx.webTerminals.launchShells(sessionId, signal),
                  selectShell: (path) => {
                    ctx.webTerminals.selectShell(path)
                  },
                  closeTab: (id) => {
                    ctx.sidebarRight.close(id)
                  },
                }),
              },
              TerminalGuide,
            ),
          ),
        'terminal-plus: guide',
      )
    }

    /* ---------- 加号弹层（不新开页面，就地在终端列内浮出） ---------- */

    var POPOVER_WIDTH = 320

    function AddPopover() {
      var collapsedGroups = useCollapsedGroups()
      /* 设置页改了书签时，浮层开着也能立刻刷新。 */
      var settingsTickState = react.useState(0)
      react.useEffect(function () {
        var bump = function () {
          settingsTickState[1](function (value) {
            return value + 1
          })
        }
        window.addEventListener(SETTINGS_EVENT, bump)
        return function () {
          window.removeEventListener(SETTINGS_EVENT, bump)
        }
      }, [])
      var posState = react.useState(null)
      var pos = posState[0]
      var setPos = posState[1]
      var posRef = react.useRef(null)
      posRef.current = pos
      var boxRef = react.useRef(null)
      var draftState = react.useState('')
      var draft = draftState[0]
      var setDraft = draftState[1]
      var webDraftState = react.useState('')
      var webDraft = webDraftState[0]
      var setWebDraft = webDraftState[1]
      var recentState = react.useState(readRecent)
      var recent = recentState[0]
      var setRecent = recentState[1]
      react.useEffect(function () {
        var onClear = function () { setRecent([]) }
        window.addEventListener('dsh-terminal-workbench:recent-cleared', onClear)
        return function () { window.removeEventListener('dsh-terminal-workbench:recent-cleared', onClear) }
      }, [])
      var shellsState = react.useState([])
      var shells = shellsState[0]
      var setShells = shellsState[1]

      var service = function (name) {
        try {
          return pluginCtx && typeof pluginCtx.get === "function" ? pluginCtx.get(name) : undefined
        } catch (error) {
          return undefined
        }
      }

      var close = function () {
        setPos(null)
        setDraft("")
        setWebDraft("")
      }

      /* 设置页「保存并连接」在本组件开标签（openTerminal 只在这里）。 */
      react.useEffect(
        function () {
          var onOpen = function (event) {
            var command = event.detail && typeof event.detail.command === "string" ? event.detail.command : ""
            if (command === "") return
            var name = event.detail && typeof event.detail.name === "string" ? event.detail.name : ""
            openTerminal(undefined, command, name)
          }
          document.addEventListener("dsh-terminal-workbench:open-ssh", onOpen)
          return function () {
            document.removeEventListener("dsh-terminal-workbench:open-ssh", onOpen)
          }
        },
        [],
      )

      /* 接管加号：捕获阶段吃掉 click，原生指南页不再打开。 */
      react.useEffect(
        function () {
          var onPointerDown = function (event) {
            var target = event.target
            var button = target && target.closest ? target.closest("[data-dockkit-add-tab]") : null
            if (button === null) return
            event.preventDefault()
            event.stopPropagation()
          }
          var onClick = function (event) {
            var target = event.target
            var button = target && target.closest ? target.closest("[data-dockkit-add-tab]") : null
            if (button !== null) {
              event.preventDefault()
              event.stopPropagation()
              if (posRef.current !== null) {
                setPos(null)
                return
              }
              var rect = button.getBoundingClientRect()
              var estimatedHeight = 320
              var viewportWidth = window.innerWidth
              var viewportHeight = window.innerHeight
              var openLeft = viewportWidth - rect.left < POPOVER_WIDTH + 8
              var rawLeft = openLeft ? rect.right - POPOVER_WIDTH : rect.left
              var left = Math.max(8, Math.min(rawLeft, viewportWidth - POPOVER_WIDTH - 8))
              var belowTop = rect.bottom + 4
              var aboveTop = rect.top - estimatedHeight - 4
              var openAbove = viewportHeight - rect.bottom < estimatedHeight + 8 && rect.top > estimatedHeight + 8
              var rawTop = openAbove ? aboveTop : belowTop
              var top = Math.max(8, Math.min(rawTop, viewportHeight - estimatedHeight - 8))
              setPos({ left: left, top: top })
              return
            }
            if (posRef.current === null) return
            var box = boxRef.current
            if (box !== null && box.contains(target)) return
            setPos(null)
          }
          var onKey = function (event) {
            if (event.key === "Escape") setPos(null)
          }
          document.addEventListener("pointerdown", onPointerDown, true)
          document.addEventListener("click", onClick, true)
          document.addEventListener("keydown", onKey, true)
          return function () {
            document.removeEventListener("pointerdown", onPointerDown, true)
            document.removeEventListener("click", onClick, true)
            document.removeEventListener("keydown", onKey, true)
          }
        },
        []
      )

      /* 窗口尺寸变化后关闭浮层，下一次点击加号会按新坐标重新定位。 */
      react.useEffect(
        function () {
          if (pos === null) return undefined
          var closeOnResize = function () {
            setPos(null)
          }
          window.addEventListener('resize', closeOnResize)
          return function () {
            window.removeEventListener('resize', closeOnResize)
          }
        },
        [pos]
      )

      /* 浮层打开时按需取当前会话的可用 shell。 */
      react.useEffect(
        function () {
          if (pos === null) return undefined
          var terminals = service("webTerminals")
          if (terminals === undefined || typeof terminals.launchShells !== "function") return undefined
          /* 取**可见**会话：多会话时隐藏面板的节点也在 DOM 里，
             与 currentSession 同一套过滤（[hidden] / aria-hidden）。 */
          var node = Array.prototype.slice.call(document.querySelectorAll("[data-sidebar-right-session]")).find(function (el) {
            return el.closest("[hidden]") === null && el.getAttribute("aria-hidden") !== "true"
          })
          var sessionId = node === undefined || node === null ? undefined : node.getAttribute("data-sidebar-right-session")
          if (!sessionId) return undefined
          var controller = new AbortController()
          Promise.resolve()
            .then(function () {
              return terminals.launchShells(sessionId, controller.signal)
            })
            .then(function (launch) {
              setShells(launch && Array.isArray(launch.shells) ? launch.shells : [])
            })
            .catch(function () {
              setShells([])
            })
          return function () {
            controller.abort()
          }
        },
        [pos]
      )

      var openTerminal = function (shellPath, initialInput, title) {
        var right = service("sidebarRight")
        if (right === undefined || typeof right.openTab !== "function") return
        if (shellPath !== undefined) {
          var terminals = service("webTerminals")
          if (terminals !== undefined && typeof terminals.selectShell === "function") terminals.selectShell(shellPath)
        }
        var params = {}
        if (shellPath !== undefined) params.shellPath = shellPath
        if (typeof initialInput === "string" && initialInput !== "") {
          var forRecent = initialInput
          /* ssh 投递走回显抑制（sshInitialInput）；recent 列表仍记原始命令。 */
          if (initialInput.indexOf(SSH_ECHO_MARK) !== -1) initialInput = sshInitialInput(initialInput)
          params.initialInput = initialInput
          setRecent(rememberRecent(forRecent, title))
        }
        if (typeof title === 'string' && title.trim() !== '') params.title = title.trim()
        close()
        try {
          right.openTab(KIND, { params: Object.keys(params).length === 0 ? undefined : params })
        } catch (error) {
          /* 服务未就绪：浮层已关闭，不阻断界面 */
          console.warn('[terminal-workbench] 服务未就绪：浮层已关闭，不阻断界面：', error)
        }
      }

      var openFiles = function () {
        var right = service("sidebarRight")
        close()
        if (right === undefined || typeof right.openTab !== "function") return
        try {
          right.openTab("files")
        } catch (error) {
          /* files 类型不可用时忽略 */
          console.warn('[terminal-workbench] files 类型不可用时忽略：', error)
        }
      }

      var openWeb = function (value) {
        var next = normalizeWebUrl(value)
        if (next === "") return
        var right = service("sidebarRight")
        close()
        if (right === undefined || typeof right.openTab !== "function") return
        /* 标签创建与首次渲染之间没有可靠的参数通道，先放进待领地址。 */
        PENDING_WEB_URL = next
        try {
          right.openTab(WEB_KIND, { params: { url: next } })
        } catch (error) {
          PENDING_WEB_URL = ""
          /* 类型未注册或服务未就绪：浮层已关闭，不阻断界面 */
          console.warn('[terminal-workbench] 打开网页失败：', error)
        }
      }

      if (pos === null) return null

      var submit = function () {
        var text = draft.trim()
        /* 主输入框里直接贴网址时开网页标签，不要当 shell 命令执行。 */
        if (text !== "" && looksLikeUrl(text)) {
          openWeb(text)
          return
        }
        openTerminal(undefined, text === "" ? undefined : text)
      }

      var bookmarkSection = function () {
        return renderBookmarkGroups({
          keyword: draft,
          collapsedGroups: collapsedGroups,
          emptyText: draft.trim() === '' ? '在设置里添加书签' : '没有匹配的书签',
          onOpen: function (mark) {
            openTerminal(undefined, sshCommand(mark), mark.name || bookmarkTarget(mark))
          },
        })
      }

      var popover = jsxs("div", {
        ref: boxRef,
        className: "wb-pop",
        style: { left: pos.left + "px", top: pos.top + "px", width: POPOVER_WIDTH + "px" },
        children: [
          jsx("div", { className: "wb-pop-title", children: "新建终端" }),
          jsx("input", {
            className: "wb-pop-input",
            autoFocus: true,
            spellCheck: false,
            value: draft,
            placeholder: "输入命令或 ssh user@host，回车新建",
            onChange: function (event) {
              setDraft(event.target.value)
            },
            onKeyDown: function (event) {
              if (event.key === "Enter") {
                event.preventDefault()
                submit()
              }
            },
          }),
          jsx("div", {
            className: "wb-pop-row",
            children:
              shells.length === 0
                ? [
                    jsx(
                      "button",
                      {
                        className: "wb-pop-chip",
                        onClick: function () {
                          openTerminal(undefined, undefined)
                        },
                        children: "新标签",
                      },
                      "default"
                    ),
                  ]
                : shells.map(function (shell) {
                    return jsx(
                      "button",
                      {
                        className: "wb-pop-chip",
                        onClick: function () {
                          openTerminal(shell.path, undefined)
                        },
                        children: shell.name,
                      },
                      shell.path
                    )
                  }),
          }),
          jsx("div", { className: "wb-pop-section", children: "网页" }),
          jsxs("div", {
            className: "wb-pop-webrow",
            children: [
              jsx("input", {
                className: "wb-pop-input",
                spellCheck: false,
                value: webDraft,
                placeholder: "输入网址，回车打开",
                onChange: function (event) {
                  setWebDraft(event.target.value)
                },
                onKeyDown: function (event) {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    openWeb(webDraft)
                  }
                },
              }),
              jsx("button", {
                type: "button",
                className: "wb-pop-chip",
                onClick: function () {
                  openWeb(webDraft)
                },
                children: "打开",
              }),
            ],
          }),
          jsx("div", { className: "wb-pop-section", children: "最近连接" }),
          recent.length === 0
            ? jsx("div", { className: "wb-pop-empty", children: "还没有记录" })
            : jsxs(
                "div",
                {
                  children: recent.map(function (item) {
                    return jsxs(
                      "button",
                      {
                        className: "wb-pop-item",
                        title: item.command,
                        onClick: function () {
                          openTerminal(undefined, item.command, item.label)
                        },
                        children: [
                          jsx("span", {
                            className: "wb-pop-dot",
                            style: { background: dotColor(item.command) },
                          }),
                          jsx("span", { className: "wb-pop-text", children: recentLabelOf(item) }),
                        ],
                      },
                      item.command
                    )
                  }),
                },
                {}
              ),
          recent.length === 0 ? null : jsx("button", {
            type: "button",
            className: "wb-recent-clear",
            onClick: function () { setRecent(clearRecent()) },
            children: "清除最近连接",
          }),
          jsx("div", { className: "wb-pop-section", children: "SSH 书签" }),
          bookmarkSection(),
          jsx("div", { className: "wb-pop-section", children: "面板" }),
          jsxs("button", {
            className: "wb-pop-item",
            onClick: openFiles,
            children: [jsx("span", { children: "📁" }), jsx("span", { children: "工作区文件" })],
          }),
        ],
      })
      return reactDom.createPortal(popover, document.body)
    }

    /* ---------- 相机悬浮按钮 ---------- */

    function CameraIcon() {
      return jsxs('svg', {
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '2',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        children: [
          jsx('path', {
            d: 'M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z',
          }),
          jsx('circle', { cx: '12', cy: '13', r: '3' }),
        ],
      })
    }

    /**
     * 相机入口：从加号面板拆出来的移动悬浮按钮。
     * x 由布局分界线决定（终端列右边缘），y 可拖动；展开后第一项是 IP 末位，
     * 前缀取当前 SSH 终端的主机网段，回车即可打开/复用对应相机书签。
     */
    function CameraDock(props) {
      var visible = props.visible !== false
      var boundary = typeof props.left === 'number' ? props.left : 0
      var openState = react.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var yState = react.useState(function () {
        var saved = readCameraFloatY()
        return saved > 0 ? clampCameraFloatY(saved) : clampCameraFloatY(window.innerHeight * 0.42)
      })
      var y = yState[0]
      var setY = yState[1]
      var prefixInfoState = react.useState(resolveCameraPrefixInfo)
      var prefixInfo = prefixInfoState[0]
      var setPrefixInfo = prefixInfoState[1]
      var prefixState = react.useState(function () {
        return prefixInfoState[0].prefix
      })
      var prefix = prefixState[0]
      var setPrefix = prefixState[1]
      var touchedState = react.useState(false)
      var prefixTouched = touchedState[0]
      var setPrefixTouched = touchedState[1]
      var octetState = react.useState('')
      var octet = octetState[0]
      var setOctet = octetState[1]
      var noticeState = react.useState('')
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      var touchedRef = react.useRef(false)
      var inputRef = react.useRef(null)
      var prefixInputRef = react.useRef(null)
      var buttonRef = react.useRef(null)
      var panelRef = react.useRef(null)

      var refreshPrefix = function (force) {
        var info = resolveCameraPrefixInfo()
        setPrefixInfo(function (previous) {
          return sameCameraPrefixInfo(previous, info) ? previous : info
        })
        if (force === true || !touchedRef.current) setPrefix(info.prefix)
        return info
      }

      var closePanel = function () {
        setOpen(false)
        setNotice('')
        setOctet('')
        touchedRef.current = false
        setPrefixTouched(false)
      }

      /* 收起时复位「手动前缀」标记，下次展开重新跟随终端。 */
      react.useEffect(
        function () {
          if (open) return
          touchedRef.current = false
          setPrefixTouched(false)
        },
        [open],
      )

      /* 展开期间跟随终端状态刷新：SSH 重连、切标签、窗口尺寸变化都能及时反映。 */
      react.useEffect(
        function () {
          if (!open) return undefined
          refreshPrefix(false)
          var timer = window.setInterval(function () {
            refreshPrefix(false)
          }, 1000)
          var onRefresh = function () {
            refreshPrefix(false)
          }
          var onResize = function () {
            setY(function (value) {
              return clampCameraFloatY(value)
            })
            refreshPrefix(false)
          }
          window.addEventListener('dsh-terminal-workbench:ssh-state', onRefresh)
          window.addEventListener(CAMERA_EVENT, onRefresh)
          window.addEventListener('resize', onResize)
          return function () {
            window.clearInterval(timer)
            window.removeEventListener('dsh-terminal-workbench:ssh-state', onRefresh)
            window.removeEventListener(CAMERA_EVENT, onRefresh)
            window.removeEventListener('resize', onResize)
          }
        },
        [open],
      )

      /* 展开后直接聚焦末位输入框，键盘用户不必再点一次。 */
      react.useEffect(
        function () {
          if (!open) return undefined
          var timer = window.setTimeout(function () {
            /* 读 DOM 当前值，而不是闭包里的 prefixInfo：展开瞬间 refreshPrefix
               可能刚把「上次前缀」填进来，闭包还是旧值，会错误地聚焦前缀框。 */
            var current = prefixInputRef.current !== null ? prefixInputRef.current.value : ''
            var target = current === '' && prefixInputRef.current !== null
              ? prefixInputRef.current
              : inputRef.current
            if (target !== null) target.focus()
          }, 0)
          return function () {
            window.clearTimeout(timer)
          }
        },
        [open],
      )

      /* 点面板外或按 Esc 收起。 */
      react.useEffect(
        function () {
          if (!open) return undefined
          var onPointerDown = function (event) {
            var target = event.target
            if (panelRef.current !== null && panelRef.current.contains(target)) return
            if (buttonRef.current !== null && buttonRef.current.contains(target)) return
            closePanel()
          }
          var onKey = function (event) {
            if (event.key === 'Escape') closePanel()
          }
          document.addEventListener('pointerdown', onPointerDown, true)
          document.addEventListener('keydown', onKey, true)
          return function () {
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('keydown', onKey, true)
          }
        },
        [open],
      )

      /* 拖动只改 y；x 始终由布局分界线决定。 */
      var onFabPointerDown = function (event) {
        if (event.button !== undefined && event.button !== 0) return
        event.preventDefault()
        var startY = event.clientY
        var startTop = y
        var latest = startTop
        var moved = false
        var move = function (moveEvent) {
          var dy = moveEvent.clientY - startY
          if (!moved && Math.abs(dy) > 4) moved = true
          if (!moved) return
          latest = clampCameraFloatY(startTop + dy)
          setY(latest)
        }
        var up = function () {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', up)
          if (moved) {
            writeCameraFloatY(latest)
            return
          }
          setOpen(function (value) {
            return !value
          })
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', up)
      }

      var submit = function () {
        var result = openCameraByOctet(prefix, octet, {
          vehicle: prefixInfo.vehicle,
          project: prefixInfo.project,
        })
        if (result.ok) {
          closePanel()
          return
        }
        setNotice(result.error)
      }

      var resetPrefix = function () {
        touchedRef.current = false
        setPrefixTouched(false)
        refreshPrefix(true)
      }

      var openExisting = function (camera) {
        var nextPrefix = normalizeCameraPrefix(prefix) || ipv4Prefix(camera.host)
        if (nextPrefix !== '') writeCameraPrefix(nextPrefix)
        var target = camera
        if (
          String(camera.terminalBookmarkId ?? '') === '' &&
          String(prefixInfo.terminalBookmarkId ?? '') !== ''
        ) {
          /* 从哪个终端打开就跟随哪个 SSH 书签；已有链接的不改，避免共享相机被抢走。 */
          target = upsertCamera(
            Object.assign({}, camera, { terminalBookmarkId: prefixInfo.terminalBookmarkId }),
          )
        }
        if (openCameraTab(target)) closePanel()
        else setNotice('右栏未就绪，无法打开相机标签')
      }

      if (!visible) return null

      var normalizedPrefix = normalizeCameraPrefix(prefix)
      var allCameras = readCameras()
      var byLastOctet = function (left, right) {
        return (
          (Number(String(left.host).split('.')[3]) || 0) -
          (Number(String(right.host).split('.')[3]) || 0)
        )
      }
      /* 列表跟随当前终端：当前车/项目的相机优先，其次同网段，最后才兜底全部。 */
      var owned = allCameras.filter(function (item) {
        return cameraBelongsToTerminal(item, prefixInfo)
      })
      owned.sort(byLastOctet)
      var ownedIds = Object.create(null)
      owned.forEach(function (item) {
        ownedIds[item.id] = true
      })
      var matching = normalizedPrefix === ''
        ? []
        : allCameras.filter(function (item) {
            return item.host.indexOf(normalizedPrefix) === 0 && ownedIds[item.id] !== true
          })
      matching.sort(byLastOctet)
      var sections = []
      if (owned.length > 0) {
        sections.push({
          title:
            '当前终端 · ' +
            (String(prefixInfo.vehicle ?? '').trim() || String(prefixInfo.project ?? '').trim()),
          items: owned,
        })
      }
      if (matching.length > 0) {
        sections.push({ title: '同一网段', items: matching })
      }
      if (sections.length === 0) {
        var others = allCameras.slice(0, 6)
        if (others.length > 0) {
          sections.push({
            title: prefixInfo.source === 'terminal' ? '其他相机书签' : '相机书签',
            items: others,
          })
        }
      }

      var sourceText = prefixTouched
        ? prefixInfo.source === 'terminal'
          ? '手动前缀（原跟随 ' + prefixInfo.title + '）'
          : '手动前缀'
        : prefixInfo.source === 'terminal'
          ? '前缀跟随终端 ' + prefixInfo.title + (prefixInfo.host === '' ? '' : '（' + prefixInfo.host + '）')
          : prefixInfo.source === 'memory'
            ? '未检测到 SSH 终端，沿用上次前缀'
            : '先在终端连接 SSH，或直接填写前缀'

      var panelWidth = Math.min(CAMERA_FAB_PANEL_WIDTH, Math.max(220, window.innerWidth - 16))
      var panelLeft = boundary - panelWidth - 12
      if (panelLeft < 8) panelLeft = boundary + 12
      panelLeft = Math.max(8, Math.min(panelLeft, window.innerWidth - panelWidth - 8))
      var panelTop = Math.max(8, Math.min(y - 70, window.innerHeight - 380))
      var panelStyle = { left: panelLeft + 'px', top: panelTop + 'px', width: panelWidth + 'px' }

      return jsxs(Fragment, {
        children: [
          jsx('button', {
            ref: buttonRef,
            type: 'button',
            className: 'wb-cam-fab',
            style: { left: boundary + 'px', top: y + 'px' },
            'data-open': open || undefined,
            'aria-label': '相机',
            'aria-expanded': open ? 'true' : 'false',
            'aria-controls': 'wb-cam-fab-panel',
            title: '相机：点击展开，拖动上下移动',
            onPointerDown: onFabPointerDown,
            onClick: function (event) {
              /* 键盘 Enter/Space 走 click（detail=0）；鼠标由 pointerup 处理，避免双触发。 */
              if (event.detail === 0) {
                setOpen(function (value) {
                  return !value
                })
              }
            },
            children: jsx(CameraIcon, {}),
          }),
          open
            ? reactDom.createPortal(
                jsxs('div', {
                  ref: panelRef,
                  id: 'wb-cam-fab-panel',
                  className: 'wb-cam-fab-panel',
                  style: panelStyle,
                  role: 'dialog',
                  'aria-label': '相机',
                  children: [
                    jsxs('div', {
                      className: 'wb-cam-fab-head',
                      children: [
                        jsx(CameraIcon, {}),
                        jsx('span', { className: 'wb-cam-fab-title', children: '相机' }),
                        jsx('button', {
                          type: 'button',
                          className: 'wb-cam-fab-close',
                          'aria-label': '关闭相机面板',
                          onClick: closePanel,
                          children: '×',
                        }),
                      ],
                    }),
                    jsxs('div', {
                      className: 'wb-cam-fab-ip',
                      children: [
                        jsx('input', {
                          ref: prefixInputRef,
                          className: 'wb-cam-fab-prefix',
                          spellCheck: false,
                          value: prefix,
                          placeholder: '192.168.10.',
                          'aria-label': '相机 IP 前缀',
                          onChange: function (event) {
                            touchedRef.current = true
                            setPrefixTouched(true)
                            setPrefix(event.target.value)
                            setNotice('')
                          },
                          onKeyDown: function (event) {
                            if (event.key !== 'Enter') return
                            event.preventDefault()
                            if (inputRef.current !== null) inputRef.current.focus()
                          },
                        }),
                        jsx('input', {
                          ref: inputRef,
                          className: 'wb-cam-fab-octet',
                          spellCheck: false,
                          inputMode: 'numeric',
                          maxLength: 3,
                          value: octet,
                          placeholder: '末位',
                          'aria-label': '相机 IP 末位',
                          onChange: function (event) {
                            setOctet(event.target.value.replace(/[^\d]/g, '').slice(0, 3))
                            setNotice('')
                          },
                          onKeyDown: function (event) {
                            if (event.key !== 'Enter') return
                            event.preventDefault()
                            submit()
                          },
                        }),
                        jsx('button', {
                          type: 'button',
                          className: 'wb-cam-fab-open',
                          onClick: submit,
                          children: '打开',
                        }),
                      ],
                    }),
                    jsx('div', {
                      className: 'wb-cam-fab-meta',
                      children: [
                        jsx('span', { children: sourceText }),
                        prefixTouched && prefixInfo.source === 'terminal'
                          ? jsx('button', {
                              type: 'button',
                              className: 'wb-cam-fab-reset',
                              onClick: resetPrefix,
                              children: '恢复跟随',
                            })
                          : null,
                      ],
                    }),
                    notice === ''
                      ? null
                      : jsx('div', { className: 'wb-cam-fab-notice', children: notice }),
                    sections.length === 0
                      ? null
                      : sections.map(function (section) {
                          return jsxs(
                            'div',
                            {
                              className: 'wb-cam-fab-list',
                              children: [
                                jsx('div', {
                                  className: 'wb-cam-fab-section',
                                  children: section.title,
                                }),
                                section.items.map(function (item) {
                                  return jsxs(
                                    'button',
                                    {
                                      type: 'button',
                                      className: 'wb-cam-fab-item',
                                      title: item.host + ':' + item.port,
                                      onClick: function () {
                                        openExisting(item)
                                      },
                                      children: [
                                        jsx('span', {
                                          className: 'wb-cam-fab-host',
                                          children: item.host,
                                        }),
                                        jsx('span', {
                                          className: 'wb-cam-fab-name',
                                          children: cameraLabel(item),
                                        }),
                                      ],
                                    },
                                    item.id,
                                  )
                                }),
                              ],
                            },
                            section.title + ':' + section.items.length,
                          )
                        }),
                    jsx('div', {
                      className: 'wb-cam-fab-hint',
                      children:
                        '列表优先显示当前终端的相机；前缀默认取 SSH 终端主机的 /24，可在 SSH 书签里填「相机前缀」覆盖。',
                    }),
                  ],
                }),
                document.body,
              )
            : null,
        ],
      })
    }

    function SidebarColumn(props) {
      return jsx("div", { className: "wb-sidebar-col", children: props.children });
    }

    function TerminalColumn(props) {
      return jsx("div", {
        className: "wb-terminal-col",
        "data-fullscreen": props.fullscreen ? "1" : undefined,
        children: props.children,
      });
    }

    function MainColumn(props) {
      return jsx("div", { className: "wb-main-col", children: props.children });
    }

    /* ---------- 拖拽手柄 ---------- */

    /**
     * 一条可拖拽的列分隔线。
     * 使用 window 级 pointermove 监听：指针移出手柄区域后仍能继续拖拽。
     */
    function DragHandle(props) {
      var state = react.useState(false);
      var dragging = state[0];
      var setDragging = state[1];
      var origin = react.useRef(0);
      var propsRef = react.useRef(props);
      propsRef.current = props;

      react.useEffect(
        function () {
          if (!dragging) return undefined;
          var move = function (e) {
            propsRef.current.onDrag(e.clientX - origin.current);
          };
          var up = function () {
            setDragging(false);
            if (propsRef.current.onEnd) propsRef.current.onEnd();
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
          window.addEventListener("pointercancel", up);
          return function () {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
          };
        },
        [dragging]
      );

      var down = function (e) {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        origin.current = e.clientX;
        setDragging(true);
        if (propsRef.current.onStart) propsRef.current.onStart();
      };

      var dbl = function () {
        if (propsRef.current.onDoubleClick) propsRef.current.onDoubleClick();
      };

      return jsx("div", {
        className: "wb-handle",
        style: { left: props.left + "px" },
        "data-active": dragging || undefined,
        onPointerDown: down,
        onDoubleClick: dbl
      });
    }

    /* ---------- 布局框 ---------- */

    function AppFrame(input) {
      var useStore = input.useStore;
      var usePanelInfo = input.usePanelInfo;
      var actions = input.actions;
      var renderSlot = input.renderSlot;

      var layoutInfo = useStore(function (state) {
        return state.layoutInfo;
      });
      var frameRef = react.useRef(null);
      var viewport = layoutInfo.viewportWidth;

      /* 帧宽度测量：写回 viewportWidth，列宽据此重算 */
      react.useLayoutEffect(
        function () {
          var el = frameRef.current;
          if (el === null) return undefined;
          var raf = null;
          var disposed = false;
          var measure = function () {
            var width = el.getBoundingClientRect().width;
            if (width > 0) actions.setViewportWidth(width);
          };
          measure();
          var observer = new ResizeObserver(function () {
            if (disposed) return;
            if (raf !== null) return;
            raf = requestAnimationFrame(function () {
              raf = null;
              measure();
            });
          });
          observer.observe(el);
          return function () {
            disposed = true;
            observer.disconnect();
            if (raf !== null) cancelAnimationFrame(raf);
          };
        },
        [actions]
      );

      var narrow = viewport < SIDEBAR_AUTO_COLLAPSE;
      var sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0;
      var sidebarPreference = sidebarCollapsed ? 0 : layoutInfo.sidebar === 0 ? 280 : layoutInfo.sidebar;
      var rightbarPreference =
        layoutInfo.rightbar === null ? viewport * RIGHTBAR_DEFAULT_RATIO : layoutInfo.rightbar;
      var darwin = document.documentElement.dataset.platform === "darwin";
      var collapsedWidth =
        darwin || document.documentElement.hasAttribute("data-windows-titlebar") ? 0 : 56;
      /* 原生右栏的「全屏」会经 layout.openRightbar(track, fullscreen) 进来；
         之前只存了 rightbarFullscreen 没用于布局，按钮点了等于没反应。 */
      var frame = computeFrame(
        layoutInfo,
        viewport,
        sidebarPreference,
        layoutInfo.rightbarShown ? rightbarPreference : 0,
        collapsedWidth
      );
      var rightbarFullscreen = frame.fullscreen;
      var cols = frame;

      var colsRef = react.useRef(cols);
      colsRef.current = cols;

      var dragState = react.useState(false);
      var dragging = dragState[0];
      var setDragging = dragState[1];
      var sidebarBase = react.useRef(0);
      var rightbarBase = react.useRef(0);

      var onSidebarStart = function () {
        sidebarBase.current = colsRef.current.sidebar;
        setDragging(true);
      };
      var onSidebarDrag = function (dx) {
        actions.setSidebar(sidebarBase.current + dx);
      };
      var onRightbarStart = function () {
        rightbarBase.current = colsRef.current.rightbar;
        setDragging(true);
      };
      var onRightbarDrag = function (dx) {
        actions.setRightbar(rightbarBase.current + dx);
      };
      var onDragEnd = function () {
        setDragging(false);
      };
      /* 双击分隔线等同原生「收起右侧面板」：走 side-panel 自己的状态，
         收起后原生展开按钮才会出现，布局层不再另存一套折叠布尔值。 */
      var onRightbarDouble = function () {
        try {
          var right =
            pluginCtx && typeof pluginCtx.get === "function" ? pluginCtx.get("sidebarRight") : undefined;
          if (right && typeof right.toggleExpanded === "function") right.toggleExpanded();
        } catch (error) {
          /* 服务未就绪时不折叠，避免进入无法恢复的收起态 */
          console.warn('[terminal-workbench] 服务未就绪时不折叠，避免进入无法恢复的收起态：', error)
        }
      };

      var activePanelId = usePanelInfo(function (info) {
        return info.activePanelId;
      });

      var sidebar = react.useMemo(
        function () {
          return renderSlot("sidebar", { collapsed: sidebarCollapsed, width: cols.sidebar });
        },
        [renderSlot, sidebarCollapsed, cols.sidebar]
      );

      var terminal = react.useMemo(
        function () {
          /* 收起时也不卸载面板：原生 side-panel 靠常驻挂载同步展开状态，
             卸载后它的展开按钮就不会再出现，收起态将无法恢复。 */
          return renderSlot("rightbar", {
            width: rightbarFullscreen ? viewport : cols.rightbar,
            viewportWidth: viewport,
            canShow: true
          });
        },
        [renderSlot, cols.rightbar, viewport, rightbarFullscreen]
      );

      var main = react.useMemo(
        function () {
          return renderSlot("main", {}, { entryKey: activePanelId || "conversation" });
        },
        [renderSlot, activePanelId]
      );

      var overlays = react.useMemo(
        function () {
          return renderSlot("shell.overlay", {});
        },
        [renderSlot]
      );

      var gridTemplate = frame.gridTemplate;

      return jsxs("div", {
        ref: frameRef,
        className: "wb-frame",
        style: { gridTemplateColumns: gridTemplate },
        "data-sidebar-collapsed": sidebarCollapsed || undefined,
        "data-rightbar-fullscreen": rightbarFullscreen ? "1" : undefined,
        "data-dragging": dragging || undefined,
        "data-rightbar-shown": layoutInfo.rightbarShown || undefined,
        children: [
          jsx(SidebarColumn, { children: sidebar }),
          jsx(TerminalColumn, {
            fullscreen: rightbarFullscreen,
            children: [terminal, jsx(AddPopover, {}), jsx(SettingsDialog, {})]
          }),
          jsx(MainColumn, { children: main }),
          jsx(CameraDock, {
            left: cols.sidebar + cols.rightbar,
            visible: !rightbarFullscreen && cols.rightbar > 0,
          }),
          jsx("div", { className: "wb-overlay", children: overlays }),
          !rightbarFullscreen &&
            !sidebarCollapsed &&
            jsx(DragHandle, {
              left: cols.sidebar,
              onStart: onSidebarStart,
              onDrag: onSidebarDrag,
              onEnd: onDragEnd
            }),
          !rightbarFullscreen &&
            cols.rightbar > 0 &&
            jsx(DragHandle, {
              left: cols.sidebar + cols.rightbar,
              onStart: onRightbarStart,
              onDrag: onRightbarDrag,
              onEnd: onDragEnd,
              onDoubleClick: onRightbarDouble
            })
        ]
      });
    }

    /* ---------- 布局 store ---------- */

    function createLayoutStore() {
      return clientStore.defineStore({
        init: function () {
          return {
            panelInfo: { activePanelId: null },
            layoutInfo: {
              sidebar: 280,
              viewportWidth: typeof window === "undefined" ? 1280 : window.innerWidth,
              narrowExpanded: false,
              rightbar: null,
              rightbarShown: true,
              rightbarTrack: true,
              rightbarFullscreen: false,
              rightbarInstant: false
            }
          };
        },
        actions: {
          selectPanel: function (d, panelId) {
            d.panelInfo.activePanelId = panelId;
          },
          /** 主面板集合变化后清理失效的选中项。 */
          retainMainPanels: function (d, panelIds) {
            if (d.panelInfo.activePanelId !== null && panelIds.indexOf(d.panelInfo.activePanelId) === -1) {
              d.panelInfo.activePanelId = null;
            }
          },
          setSidebar: function (d, px) {
            d.layoutInfo.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX);
          },
          toggleSidebar: function (d) {
            if (d.layoutInfo.viewportWidth < SIDEBAR_AUTO_COLLAPSE) {
              d.layoutInfo.narrowExpanded = !d.layoutInfo.narrowExpanded;
            } else {
              d.layoutInfo.sidebar = d.layoutInfo.sidebar === 0 ? 280 : 0;
            }
          },
          setViewportWidth: function (d, width) {
            if (d.layoutInfo.viewportWidth === width) return;
            if (
              (d.layoutInfo.viewportWidth < SIDEBAR_AUTO_COLLAPSE) !==
              (width < SIDEBAR_AUTO_COLLAPSE)
            ) {
              d.layoutInfo.narrowExpanded = false;
            }
            d.layoutInfo.viewportWidth = width;
          },
          setRightbar: function (d, px) {
            d.layoutInfo.rightbar = clampWidth(
              px,
              RIGHTBAR_MIN,
              Math.max(RIGHTBAR_MIN, d.layoutInfo.viewportWidth * RIGHTBAR_MAX_RATIO)
            );
          },
          openRightbar: function (d, track, fullscreen) {
            d.layoutInfo.rightbarShown = true;
            d.layoutInfo.rightbarTrack = track;
            d.layoutInfo.rightbarFullscreen = fullscreen;
          },
          closeRightbar: function (d) {
            d.layoutInfo.rightbarShown = false;
            d.layoutInfo.rightbarTrack = false;
            d.layoutInfo.rightbarFullscreen = false;
          }
        }
      });
    }

    /* ---------- layout 服务（对等内置 API） ---------- */

    var LayoutController = (function () {
      function LayoutController(panels, hasMainPanel, panelInfo) {
        this.panels = panels;
        this.hasMainPanel = hasMainPanel;
        this.panelInfo = panelInfo;
        this.navigation = new AbortController();
      }

      LayoutController.prototype.selectPanel = function (panelId) {
        if (panelId !== null && !this.hasMainPanel(panelId)) {
          throw new Error('layout.selectPanel: main panel "' + panelId + '" is not registered');
        }
        this.navigation.abort();
        this.panels.selectPanel(panelId);
      };

      LayoutController.prototype.beginNavigation = function () {
        this.navigation.abort();
        this.navigation = new AbortController();
        return this.navigation.signal;
      };

      LayoutController.prototype.dispose = function () {
        this.navigation.abort();
      };

      LayoutController.prototype.toggleSidebar = function () {
        this.panels.toggleSidebar();
      };

      LayoutController.prototype.openRightbar = function (track, fullscreen) {
        this.panels.openRightbar(track, fullscreen);
      };

      LayoutController.prototype.closeRightbar = function () {
        this.panels.closeRightbar();
      };

      return LayoutController;
    })();

    /* ---------- 插件体 ---------- */

    var layoutInject = ["slots", "locale", "shortcuts"];

    /* ---------- root 槽兜底 ---------- */

    /**
     * root 槽的"看门"注册者。
     *
     * 背景（v0.2.0 新增）：本插件的补丁层会禁用内置 ui-layout，而 ui-layout 是
     * root 槽唯一的注册者。一旦本插件这一侧没起来（加载失败、依赖缺失、渲染抛错
     * 后被摘掉），RootOutlet 会抛 SlotAssemblyError —— 浏览器只剩一片空白，
     * 连插件管理页都进不去（它是 main 槽里的面板），人也没有挽回手段。
     *
     * 做法：先注册一个只会"让位"的兜底面板。它在两件事之一发生时把自己摘掉：
     *   1. 真正的工作台面板在同一帧内注册上来（同步检查，赶在渲染之前）；
     *   2. 启动宽限期到期（覆盖异步加载、依赖晚到等更慢的路径）。
     * 摘掉之后 it 就不再占位，root 槽回到正常选举，留下的是工作台。
     * 只有这两种情况都没等到，兜底才真的显示出来——那种时候它给出的就是
     * 唯一的自救入口。
     */
    var ROOT_GUARD_GRACE_MS = 4000;

    var GUARD_CSS = [
      ".wb-guard{position:fixed;inset:0;z-index:3000;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-layer-1,#0f0f10);color:var(--dsw-alias-label-primary,#e8e8ea);font:13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif}",
      ".wb-guard-card{width:560px;max-width:100%;max-height:100%;overflow:auto;padding:20px 22px;border:1px solid var(--dsw-alias-border-l1,#2a2a2e);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#17171a);box-shadow:0 24px 60px #0000004d}",
      ".wb-guard-title{display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:15px;font-weight:600}",
      ".wb-guard-badge{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:5px;background:#FFB86C;color:#1d1f21;font-size:12px;font-weight:700}",
      ".wb-guard-text{margin:0 0 12px;opacity:.82}",
      ".wb-guard-label{margin:14px 0 6px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;opacity:.55}",
      ".wb-guard-code{display:block;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#2a2a2e);border-radius:8px;background:#0b0b0d;color:#19F9D8;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;user-select:all}",
      ".wb-guard-detail{margin-top:12px;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;opacity:.5;white-space:pre-wrap;overflow-wrap:anywhere}"
    ].join("");

    /** 兜底面板：把人送到唯一还能修好它的地方。 */
    function RootGuard(input) {
      var message = input && typeof input.message === "string" ? input.message : "";
      react.useEffect(
        function () {
          var el = document.createElement("style");
          el.setAttribute("data-workbench-guard", "");
          el.textContent = GUARD_CSS;
          document.head.appendChild(el);
          return function () {
            el.remove();
          };
        },
        []
      );
      return jsx("div", {
        className: "wb-guard",
        role: "alert",
        children: jsx("div", {
          className: "wb-guard-card",
          children: jsxs(Fragment, {
            children: [
              jsxs("div", {
                className: "wb-guard-title",
                children: [
                  jsx("span", { className: "wb-guard-badge", children: "!" }),
                  jsx("span", { children: "终端工作台没能接管界面" })
                ]
              }),
              jsx("p", {
                className: "wb-guard-text",
                children:
                  "本插件接管了内置三栏布局，但它这次没有加载成功，所以界面没有可渲染的框架。按下面任一种方式即可恢复。"
              }),
              jsx("div", { className: "wb-guard-label", children: "方式一（推荐）：命令行停用插件" }),
              jsx("code", {
                className: "wb-guard-code",
                children: "dsh plugin --profile <profile> remove dsh-terminal-workbench"
              }),
              jsx("p", { className: "wb-guard-text", style: { marginTop: "8px" }, children: "重启 dsh 后界面即恢复。" }),
              jsx("div", { className: "wb-guard-label", children: "方式二：手动改补丁层" }),
              jsxs("p", {
                className: "wb-guard-text",
                style: { margin: "0 0 6px" },
                children: ["把 profile 目录下", jsx("code", { children: " cordis.patch.yml " }), "里这段改成启用："]
              }),
              jsx("code", {
                className: "wb-guard-code",
                children: "- id: ui-layout\n  disabled: false"
              }),
              jsx("div", { className: "wb-guard-label", children: "方式三：只查原因不修" }),
              jsx("p", {
                className: "wb-guard-text",
                style: { margin: 0 },
                children: "打开开发者工具 Console，看 [terminal-workbench] 开头的日志与红色报错，据此判断是依赖缺失还是渲染异常。"
              }),
              message === ""
                ? null
                : jsx("div", { className: "wb-guard-detail", children: message })
            ]
          })
        })
      });
    }

    /**
     * 装上兜底面板，交给调用方负责摘除。
     *
     * 关键取舍：这里**必须自己直接注册**，不能走 `ctx.slots.register` 的
     * `ctx.inject` 包装——root 槽由 ui-layout 声明，而它已经被我们禁用，
     * 那个包装会在插件装配期阻塞等待一个永远不会出现的声明，进而把整条
     * 客户端条目判成 failed（连带 23 个依赖 layout 的插件全部 pending）。
     * 注册失败（槽未声明等）就地吞掉：此时本来也没有可占的位置。
     * @param ctx 插件上下文（需要 slots）
     * @returns {Function} 摘除函数（幂等）
     */
    function installRootGuard(ctx) {
      var disposed = false;
      var timer = null;
      var dispose = null;
      var takeDown = function () {
        if (disposed) return;
        disposed = true;
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        try {
          if (typeof dispose === "function") dispose();
        } catch (error) {
          console.warn("[terminal-workbench] 兜底面板摘除失败：", error);
        }
        dispose = null;
      };
      try {
        /* 三条必须同时成立的注册约束（都是实测踩出来的）：
           1. 不带 `priority`：root 是单槽，同优先级撞车会直接被拒
              （"single slot root already has a registration at priority 0"），
              而优先级数字越大渲染越靠后、越靠前越优先——兜底必须排在**后面**，
              等真正的工作台面板一来就立刻让位。
           2. 不写 `children: {}`：声明语义上"空对象"不等于"不声明"，
              后到的面板再声明 sidebar/main/rightbar 会撞成重复声明。
           3. 走 `ctx.slots.register` 而不是等 `ctx.inject`：root 由 ui-layout
              声明，而它已被本插件禁用，等它会把整条客户端条目卡成 pending→failed。 */
        dispose = ctx.slots.register(
          {
            name: "root",
            locale: "common",
            priority: 100
          },
          RootGuard
        );
      } catch (error) {
        /* 注册失败（例如 root 还没声明）：不该阻断主流程 */
        console.warn("[terminal-workbench] 兜底面板注册失败：", error);
        return takeDown;
      }
      /* 自检只是"锦上添花"：能读到就顺手判断，读不到（服务尚未完全就位、
         接口形态不同等）就完全跳过，交给下面的定时让位兜住。
         注意这里绝不能再让异常逃出 apply —— 装配期抛出会把整条客户端条目
         判成 failed，连带所有依赖 layout 的插件一起 pending。 */
      try {
        var entries = ctx.slots.entries("root");
        if (entries.length > 1) {
          takeDown();
          return takeDown;
        }
      } catch (error) {
        console.warn("[terminal-workbench] 兜底面板自检跳过，改由定时让位：", error);
      }
      timer = window.setTimeout(takeDown, ROOT_GUARD_GRACE_MS);
      return takeDown;
    }

    /**
     * 向宿主报到一次。
     *
     * 宿主那侧靠它判断"浏览器半侧到底起来没有"：超过宽限期仍无报到，就把
     * ui-layout 改回启用，避免白屏之后连插件管理页都进不去。
     * 用一个 `<img>` 而不是 fetch：不受 CORS 与拦截器影响，也不需要读响应。
     */
    function reportBoot() {
      /* 报到只发一次不够：页面刚起来时网络可能正忙，一次丢包就会让宿主
         误判“客户端没起来”。隔 2s / 6s 各补发一次；宿主侧 markClientLoaded
         是幂等的，多收几次没有副作用。 */
      var attempt = 0;
      function send() {
        attempt += 1;
        try {
          var img = new Image();
          img.src = "/__dsh-terminal-workbench/boot.gif?t=" + Date.now() + "&a=" + attempt;
        } catch (error) {
          console.warn("[terminal-workbench] 启动报到失败（不影响使用）：", error);
        }
        if (attempt < 3) window.setTimeout(send, attempt * 2000);
      }
      send();
    }

    function applyLayout(ctx) {
      pluginCtx = ctx;

      /* 样式：一次性注入，卸载移除 */
      ctx.effect(
        function () {
          var el = document.createElement("style");
          el.setAttribute("data-workbench-layout", "");
          el.textContent = LAYOUT_CSS;
          document.head.appendChild(el);
          return function () {
            el.remove();
          };
        },
        "workbench-layout: styles"
      );

      ctx.effect(
        function () {
          return ctx.locale.register("shortcuts.layout", {
            zh: { toggle: "展开／收起左侧栏" },
            en: { toggle: "Toggle left sidebar" }
          });
        },
        "workbench-layout: locale"
      );

      var t = ctx.locale.bind("shortcuts.layout");

      ctx.effect(
        function () {
          var handle = createLayoutStore();
          var instance = handle.create();
          var store = Object.assign({}, handle, {
            create: function () {
              return instance;
            }
          });

          /* 兜底注册者先上岗：万一下面的注册或渲染出岔子，界面还留一条自救路径。
             位置很关键——必须早于工作台面板注册，才能抢在第一次渲染之前占位。 */
          var guardTakeDown = installRootGuard(ctx);

          var layout = new LayoutController(
            instance.actions,
            function (id) {
              return ctx.slots.entries("main").some(function (entry) {
                return entry.options.key === id;
              });
            },
            {
              getSnapshot: function () {
                return instance.getSnapshot().panelInfo;
              },
              subscribe: function (listener) {
                return instance.subscribe(listener);
              }
            }
          );

          var disposePanelInfo = ctx.slots.provideRoot({ hooks: { panelInfo: layout.panelInfo } });
          var disposeService = ctx.reflect.provide("layout", layout);
          var disposeRegistration = ctx.slots.register(
            {
              name: "root",
              locale: "common",
              children: {
                sidebar: { kind: "single", scope: "root" },
                main: { kind: "keyed", scope: "root" },
                rightbar: { kind: "single", scope: "root" },
                "shell.overlay": { kind: "list", scope: "root" },
                "shell.leading": { kind: "single", scope: "root" }
              },
              store: store
            },
            AppFrame
          );
          /* 工作台面板已就位：兜底面板让位（它自己也做了同帧检查，这里再保险一次） */
          if (typeof guardTakeDown === "function") guardTakeDown();

          /* 报到必须放在 root 槽注册成功之后：host 侧看门狗靠它解除回退，
             发早了会掩盖"布局其实没挂上"的失败（v0.6.1 之前就在入口处发）。 */
          reportBoot();

          var disposeShortcut = ctx.shortcuts.register({
            id: "sidebar.left.toggle",
            label: function () {
              return t("toggle");
            },
            aliases: ["sidebar", "toggle left sidebar"],
            defaults: {
              "desktop:macos": { code: "KeyB", modifiers: ["primary"] },
              "desktop:windows": { code: "KeyB", modifiers: ["primary"] },
              "desktop:linux": { code: "KeyB", modifiers: ["primary"] },
              "web:windows": { code: "KeyB", modifiers: ["primary", "alt"] },
              "web:macos": { code: "KeyB", modifiers: ["primary", "alt"] }
            },
            regions: ["page", "editable"],
            modals: [],
            resolve: function () {
              return {
                status: "handled",
                run: function () {
                  layout.toggleSidebar();
                }
              };
            }
          });

          /* 默认打开终端：只在「当前会话一个终端标签都没有」时补开一次。
             旧守卫看的是 layoutInfo.rightbarShown——那个字段恒为 true、从不与
             实际标签状态同步，守卫等于恒真、分支是死代码。
             也不能看 sidebarRight.openTabs：那是**跨所有会话**的标签清单，
             历史会话里存过终端标签就会让守卫误判“已经开过”，当前会话反而
             一片空白（2026-11-08 现场）。正确依据是 mounted 会话 + tabsIn()。
             服务与会话表面的就绪时间不固定（冷启动时 1.5 秒经常不够），
             因此按 1s 重试，最多 5 分钟；成功或发现当前会话已有终端标签就停。 */
          var defaultTabTimer;
          var defaultTabAttempts = 0;
          var defaultTabDone = false;
          var currentSessionHasTerminal = function (right) {
            var sessionId =
              right.mounted && typeof right.mounted.getSnapshot === "function"
                ? right.mounted.getSnapshot()
                : undefined;
            if (sessionId === undefined) return undefined; // 会话表面还没挂上
            var tabs =
              typeof right.tabsIn === "function" ? right.tabsIn(sessionId) : [];
            return tabs.some(function (tab) {
              return tab && tab.kind === "terminal";
            });
          };
          var openDefaultTab = function () {
            if (defaultTabDone) return;
            defaultTabAttempts += 1;
            try {
              var right =
                typeof ctx.get === "function" ? ctx.get("sidebarRight") : undefined;
              if (!right || typeof right.openTab !== "function") {
                if (defaultTabAttempts < 300)
                  defaultTabTimer = setTimeout(openDefaultTab, 1000);
                return;
              }
              var hasTerminal = currentSessionHasTerminal(right);
              if (hasTerminal === undefined) {
                /* 会话还没挂上：openTab 现在只会抛 no session surface is mounted */
                if (defaultTabAttempts < 300)
                  defaultTabTimer = setTimeout(openDefaultTab, 1000);
                return;
              }
              if (hasTerminal) {
                defaultTabDone = true;
                return;
              }
              right.openTab("terminal");
              defaultTabDone = true;
            } catch (error) {
              /* 服务/会话表面尚未就绪：继续等，超时后再提示可手动打开 */
              if (defaultTabAttempts === 15) {
                console.warn(
                  '[terminal-workbench] 默认打开终端暂未成功，继续重试：',
                  error,
                );
              }
              if (defaultTabAttempts < 300) {
                defaultTabTimer = setTimeout(openDefaultTab, 1000);
              } else {
                console.warn(
                  '[terminal-workbench] 默认打开终端失败（可手动打开）：',
                  error,
                );
              }
            }
          };
          defaultTabTimer = setTimeout(openDefaultTab, 1500);

          return function () {
            clearTimeout(defaultTabTimer);
            disposeShortcut();
            disposeRegistration();
            disposeService();
            disposePanelInfo();
            if (typeof guardTakeDown === "function") guardTakeDown();
          };
        },
        "workbench-layout: frame"
      );
    }

    /* ---------- 单插件接线 ---------- */

    /* 两个子系统的依赖并集：布局要 slots/locale/shortcuts，终端要 sidebarRight* 与 webTerminals/theme。
       sidebarRight* 不能放这里：它们由 ui-sidebar-right 提供，而 ui-sidebar-right 又 inject layout，
       放进顶层会形成 layout ← sidebarRight ← layout 的死锁。改为布局先提供 layout，再在
       apply() 里用 ctx.inject 等 sidebarRight* 就绪后挂载终端半侧。 */
    /* remote / remote.session 供反向通道把终端选区投递到当前会话（session/prompt）；
       两者都是客户端核心服务（api-session-controller 提供），不 inject 时 ctx.get 会直接抛错。 */
    var inject = [
      "slots",
      "locale",
      "shortcuts",
      "webTerminals",
      "theme",
      "remote",
      "remote.session",
    ];

    /**
     * 单插件入口：布局（三栏）与终端（标签类型 + 渲染）同属一个工作台，共用同一份 ctx。
     * 两者的副作用都挂在 ctx.effect 上，卸载时由 cordis 逆序释放，无需在此返回 disposer。
     */
    /**
     * 旧窗口退场：服务重启后旧窗口的 URL token 失效，而启动器会另开一个带新 token 的窗口。
     * 这里每 5 秒做一次**不带凭据**的探活：
     *   - 401 → 服务活着但我的 token 已失效（就是"我是旧窗口"）→ 关掉自己；
     *   - 303/200 → 我的 token 还有效 → 什么都不做；
     *   - 网络错误 → 服务没起来 → 也什么都不做（绝不能重载，否则会停在错误页）。
     * window.close() 若被浏览器拒绝就什么都不会发生，不会连累其它窗口。
     */
    function watchStaleWindowClose(ctx) {
      ctx.effect(function () {
        var token = new URLSearchParams(window.location.search).get("token");
        if (token === null || token === "") return undefined;
        var closing = false;
        var probe = function () {
          if (closing) return;
          fetch("/?token=" + encodeURIComponent(token), {
            method: "GET",
            cache: "no-store",
            credentials: "omit",
            redirect: "manual",
          }).then(
            function (response) {
              if (response.status !== 401) return;
              closing = true;
              window.close();
            },
            function () {
              /* 服务不可达：保持安静 */
            },
          );
        };
        var timer = window.setInterval(probe, 15000);
        return function () {
          window.clearInterval(timer);
        };
      }, "workbench: stale-window-close");
    }

    function apply(ctx) {
      /* 书签文件先并进 localStorage，再装配界面——启动页第一次渲染就能看到。 */
      try {
        void syncFileBookmarks()
      } catch (error) {
        console.warn("[terminal-workbench] 书签文件同步失败（继续用本地设置）：", error);
      }
      /* 老相机书签补来源链接，并把归属对齐到当前 SSH 书签。 */
      try {
        syncCameraTerminalOwners()
      } catch (error) {
        console.warn("[terminal-workbench] 相机归属同步失败（继续用书签快照）：", error);
      }
      applyLayout(ctx);
      watchStaleWindowClose(ctx);
      var terminalStarted = false;
      try {
        ctx.inject(["sidebarRight", "sidebarRightTabs"], (scope) => {
          terminalStarted = true;
          try {
            applyTerminal(scope);
          } catch (error) {
            /* 终端半侧是"锦上添花"，接不上不该连累整块界面：
               布局已经正常，这里只记日志，让主人还能用对话与左侧栏。 */
            console.error("[terminal-workbench] 终端半侧装配失败（布局仍在工作）：", error);
          }
        });
      } catch (error) {
        console.error("[terminal-workbench] 终端半侧等待依赖失败（布局仍在工作）：", error);
      }
      /* 终端半若一直等不到依赖，界面会只有标签条、内容区空白。
         这里把缺哪个服务直接打到控制台，避免靠猜。 */
      window.setTimeout(function () {
        var report = ["sidebarRight", "sidebarRightTabs", "webTerminals", "slots"].map(function (name) {
          var value;
          try {
            value = ctx.get(name);
          } catch (error) {
            return name + "=ERR(" + String(error && error.message) + ")";
          }
          return name + "=" + (value === undefined || value === null ? "missing" : "ok");
        });
        console.warn("[terminal-workbench] 服务探测 " + (terminalStarted ? "已启动" : "未启动") + "：" + report.join(" "));
      }, 5000);
    }

    exports.apply = apply;
    exports.inject = inject;
    /* 测试缝：三栏宽度与整帧网格是纯算术，全屏是否真的改布局直接在这里验。 */
    exports.__twbLayout = {
      computeColumns: computeColumns,
      computeFrame: computeFrame,
      sidebarMin: SIDEBAR_MIN,
      sidebarMax: SIDEBAR_MAX,
      centerMin: CENTER_MIN,
      rightbarMin: RIGHTBAR_MIN,
    };
    /* 测试缝：OSC 133 状态机是纯逻辑，不需要真终端也能驱动。
       生产代码不读它，宿主侧 S5 也可以从这里取同一份块表。 */
    exports.__twbBlocks = {
      parseOsc133: parseOsc133,
      formatBlockDuration: formatBlockDuration,
      extractCommandBetween: extractCommandBetween,
      handleOsc133: handleOsc133,
      terminalBlocksOf: terminalBlocksOf,
      findTerminalBlock: findTerminalBlock,
      blockStartLineOf: blockStartLineOf,
      blockEndLineOf: blockEndLineOf,
      blockStateOf: blockStateOf,
      neighborTerminalBlock: neighborTerminalBlock,
      forgetTerminalBlocks: forgetTerminalBlocks,
    };
    exports.__twbShell = {
      remoteBootstrap: remoteBootstrap,
    };
    /* 测试缝：转发解析与 ssh 命令拼接是纯字符串逻辑，P1 回归直接驱动。 */
    exports.__twbSsh = {
      parseForwardSpec: parseForwardSpec,
      forwardArgsOf: forwardArgsOf,
      jumpHostSpec: jumpHostSpec,
      sshCommand: sshCommand,
      askpassBootstrap: askpassBootstrap,
      sshFailureOf: sshFailureOf,
      authFailureText: authFailureText,
      sshTextFingerprint: sshTextFingerprint,
      rememberSshBookmark: rememberSshBookmark,
      persistedSshBookmark: persistedSshBookmark,
      rememberSshSession: rememberSshSession,
      persistedSshSession: persistedSshSession,
      rememberSshContentId: rememberSshContentId,
      terminalBookmarkForTab: terminalBookmarkForTab,
      terminalTitleForTab: terminalTitleForTab,
      forgetPersistedSshSession: forgetPersistedSshSession,
      forgetPersistedSshSessionKey: forgetPersistedSshSessionKey,
      retryDelays: SSH_RETRY_DELAYS,
      connectTimeout: SSH_CONNECT_TIMEOUT,
      parseSshCommandLine: parseSshCommandLine,
      sshReconnectCommand: sshReconnectCommand,
      sshCommandFromTermLine: sshCommandFromTermLine,
      sshCommandFromBuffer: sshCommandFromBuffer,
      disconnectText: disconnectText,
      disconnectTextAtPrompt: disconnectTextAtPrompt,
      attachSshSession: attachSshSession,
      sshSessions: SSH_SESSIONS,
      authFailureText: authFailureText,
    };
    /* 测试缝：网页标签的地址栏归一化是纯字符串逻辑。 */
    exports.__twbWeb = {
      normalizeWebUrl: normalizeWebUrl,
      looksLikeUrl: looksLikeUrl,
      webUrlKey: webUrlKey,
      readStoredWebUrl: readStoredWebUrl,
      storeWebUrl: storeWebUrl,
      forgetWebUrl: forgetWebUrl,
    };
    /* 测试缝：相机书签的归一化/存取/标签绑定是纯逻辑。 */
    exports.__twbCamera = {
      normalizeCamera: normalizeCamera,
      readCameras: readCameras,
      writeCameras: writeCameras,
      cameraById: cameraById,
      upsertCamera: upsertCamera,
      removeCamera: removeCamera,
      blankCamera: blankCamera,
      cameraLabel: cameraLabel,
      cameraStreamLabel: cameraStreamLabel,
      cameraTabKey: cameraTabKey,
      readStoredCameraId: readStoredCameraId,
      storeCameraId: storeCameraId,
      forgetCameraTab: forgetCameraTab,
      readCameraFit: readCameraFit,
      writeCameraFit: writeCameraFit,
      ipv4Prefix: ipv4Prefix,
      normalizeCameraPrefix: normalizeCameraPrefix,
      normalizeLastOctet: normalizeLastOctet,
      cameraHostFromOctet: cameraHostFromOctet,
      cameraPrefixForTerminalBookmark: cameraPrefixForTerminalBookmark,
      cameraOwnerForTerminalBookmark: cameraOwnerForTerminalBookmark,
      cameraTerminalBookmarkMap: cameraTerminalBookmarkMap,
      cameraTerminalBookmarkForRecord: cameraTerminalBookmarkForRecord,
      hydrateCameraTerminalOwner: hydrateCameraTerminalOwner,
      syncCameraTerminalOwners: syncCameraTerminalOwners,
      sameCameraPrefixInfo: sameCameraPrefixInfo,
      orderTabsForCameraPrefix: orderTabsForCameraPrefix,
      rememberActiveTerminalTab: rememberActiveTerminalTab,
      resolveCameraPrefixInfo: resolveCameraPrefixInfo,
      readCameraPrefix: readCameraPrefix,
      writeCameraPrefix: writeCameraPrefix,
      cameraForHost: cameraForHost,
      cameraBelongsToTerminal: cameraBelongsToTerminal,
      cameraPasswordGroupKey: cameraPasswordGroupKey,
      cameraPasswordGroupLabel: cameraPasswordGroupLabel,
      readCameraPasswordGroups: readCameraPasswordGroups,
      writeCameraPasswordGroups: writeCameraPasswordGroups,
      resolveCameraCredentials: resolveCameraCredentials,
      applyCameraPasswordGroup: applyCameraPasswordGroup,
      passwordGroupsKey: CAMERA_PASSWORD_GROUPS_KEY,
      reset: resetCameraCache,
      defaultPath: CAMERA_DEFAULT_PATH,
      defaultRtspPath: CAMERA_DEFAULT_RTSP_PATH,
      defaultSpreaderRtspPath: CAMERA_DEFAULT_SPREADER_RTSP_PATH,
      defaultHanwhaRtspPath: CAMERA_DEFAULT_HANWHA_RTSP_PATH,
      defaultMjpegPath: CAMERA_DEFAULT_MJPEG_PATH,
      defaultSnapshot: CAMERA_DEFAULT_SNAPSHOT,
      rtspPort: CAMERA_RTSP_PORT,
    };
    /* 测试缝：访问角标映射与快照应用都是纯逻辑。 */
    exports.__twbTerminalAccess = {
      url: TERMINAL_ACCESS_URL,
      pollMs: TERMINAL_ACCESS_POLL_MS,
      badge: terminalAccessBadge,
      entry: terminalAccessEntry,
      resolveTerminalId: resolveTerminalId,
      snapshot: terminalAccessSnapshotOf,
      apply: setTerminalAccessSnapshot,
      reset: resetTerminalAccess,
    };

    return module.exports;
  },
});
/* chunk-rev: 4995dea6fdac */
