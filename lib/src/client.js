import { NAME as NS } from '../../src/identity.js'
// Shared with the Host half on purpose: the form must open on the same reconnect numbers the
// write path fills in, and duplicating them here is how the two drift apart.
import { CONNECTION_DRAFT_DEFAULTS } from '../../src/mcp/connection.js'
import { IMPORT_CHOICES } from './importSources.js'
import { listOf, snapshotOf, statusOf } from './config.js'
import { Chevron } from './components/chevron.jsx'
import { field } from './components/field.jsx'
import { filterRow } from './components/filterRow.jsx'
import { tabStrip } from './components/tabs.jsx'
import { pageHead } from './components/head.jsx'
import { matchesName } from './components/filters.js'
import { orderedScopeGroups, scopeKey } from './components/scopeOrder.js'
import { pendingAdds as pendingAddsOf, pendingLabel, settleInflight } from './crud/inflight.js'
import { emptyMcpText, emptySkillText } from './components/sections.js'
import { HINTS, skillFieldDefs } from './components/form.js'
import { detailNodes, hasInjectedPath, rowDetailPairs, toolsForServer } from './components/card.jsx'
import { anchorStyle, measureMenuAnchor } from './components/menuAnchor.js'
import { AUTH_CHANNEL, AUTH_DONE } from '../../src/mcp/oauth/channel.js'
import { toolListNode } from './components/toolList.jsx'
import { deleteConfirmDialog } from './components/dialog.jsx'
import { skillPreviewDialog } from './components/skillPreview.jsx'
import { skillDialogView } from './components/skillDialog.jsx'
import { dropOptimisticSkill, hideSkillUntilGone, removalTargetOf } from './crud/skills.js'
import { addServerOp, connectionDraft, deleteServerOp, draftFromRow, headersDraft, inflightKeyForRow, rowEntryId, toggleServerOp, updateServerOp } from './crud/servers.js'
import { importLabel, splitImport, takenNames as takenNamesOf } from './crud/import.js'
import panelCss from './styles/panel.css'

/**
 * Client half of the Skills & MCP panel.
 *
 * Layout mirrors Settings → 内置插件 (`dsh-client-ui-settings-plugin-inventory`):
 * page head, tab strip, one filter row (search + project switch), then two
 * collapsible tiers per tab — 全局 and 项目级 — rendering the same card grid.
 * Same metrics and `--dsw-alias-*` tokens, no Harness Client package imports.
 */
window.__ModuleLoader__.load({
  id: '@j62268781-alt/dsh-skills-mcp-manager',
  factory(require) {
    const React = require('react')
    // JSX 文件通过这个全局拿 React（见 esbuild.config.mjs 的 jsxFactory）
    globalThis.__dshReact = React
    /** Official UI primitives (Modal/Button) — same dialogs the built-in pages use. */
    const primitives = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives')
      } catch {
        return null
      }
    })()
    const h = React.createElement
    /**
     * One boolean control: the Host's own `Switch` when available, our capsule otherwise.
     *
     * Extracted because it had been written out three times (MCP card, skill card, form) with
     * slightly different labels and callbacks; a fourth copy for the connection-policy rows
     * would have made "which switch is this" a per-site question. One renderer also means the
     * fallback path is exercised by every call site, not just the one that happened to keep it.
     *
     * @param checked - current state.
     * @param onChange - receives the **next** state (not an event).
     * @param label - accessible name; also what the fallback button announces.
     * @param disabled - when true the control cannot change.
     */
    const switchControl = (checked, onChange, label, disabled = false) => (
      primitives?.Switch !== undefined
        ? <primitives.Switch key="switch" checked={checked} disabled={disabled} label={label} onChange={onChange} />
        : (
          <button
            className="smp-switch" key="switch" type="button"
            role="switch" aria-checked={checked} aria-label={label}
            data-on={checked ? 'true' : 'false'} disabled={disabled}
            onClick={() => onChange(!checked)}
          >
            <span className="smp-switchKnob" key="k" />
          </button>
        )
    )
    const { useState, useEffect, useMemo, useRef } = React


const CSS = panelCss

    /** Read through the settings form's own snapshot store. */

    
    function Panel(props) {
      const form = props.form
      const [tick, setTick] = useState(0)

    /**
     * Subscribe to the settings store itself.
     *
     * The 700ms poll below only re-renders; it does not force the renderer's
     * settings snapshot to refresh, so a change could take ~9.5s to show up (the
     * first create after opening the panel) while the Host had already published.
     * A real subscription reacts as soon as the store updates.
     */
    useEffect(() => {
      const store = form?.store ?? form
      const subscribe = typeof store?.subscribe === 'function' ? store.subscribe.bind(store) : null
      if (subscribe === null) return undefined
      const unsubscribe = subscribe(() => setTick((n) => n + 1))
      return typeof unsubscribe === 'function' ? unsubscribe : undefined
    }, [form])
      const [tab, setTab] = useState('mcp')
      const [query, setQuery] = useState('')
      const [expanded, setExpanded] = useState('')
      /**
       * Which row's `…` popup is open, by `entryId` ('' = none).
       *
       * One at a time on purpose: two open menus cannot both be dismissed by a single
       * outside click, and the panel never needs two.
       */
      const [menuFor, setMenuFor] = useState('')
      /**
       * 弹出菜单锚点（视口坐标）。
       *
       * `null` = 没量到（测试渲染器没有布局）或菜单没开，此时退回 CSS 的绝对定位。
       * 有值时菜单用 `position: fixed` —— 既不受祖先 overflow 裁剪，也能自己决定上下。
       */
      const [menuAnchor, setMenuAnchor] = useState(null)
      const [editing, setEditing] = useState(null)
      const [draft, setDraft] = useState({})
      /**
       * The scope chosen in the server form: `{ value, custom }`.
       *
       * The project filter used to live in the toolbar because the project tier was a
       * separate, separately-stored list. Scope is a property of a server now, so the
       * choice moved into the form — and this is where the toolbar's project selector
       * functionality went.
       */
      const [scopeDraft, setScopeDraft] = useState({ value: '', custom: false })
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [confirming, setConfirming] = useState('')
      const [deleteDialog, setDeleteDialog] = useState(null)
      /** Per-server reconnect progress / error, shown in the `…` menu. */
      const [reconnectState, setReconnectState] = useState({})
    /** Delete progress: the confirm dialog stays open until the receipt lands. */
    const [deleteNonce, setDeleteNonce] = useState("")
    const [deletePending, setDeletePending] = useState(false)
    const [deleteError, setDeleteError] = useState("")
    /**
     * Optimistic inserts. The Host finishes a skill op instantly (the receipt comes
     * back in ~0ms), but the renderer's settings snapshot can arrive many seconds
     * later, so the list used to lag ~8s. Show the card immediately and let the real
     * data take over as soon as it lands.
     */
    const [optimistic, setOptimistic] = useState([])
    /**
     * Tombstones for deleted skills. The renderer's settings snapshot lags the Host by
     * seconds, so a deleted card stayed visible until the document caught up.
     */
    const [removedKeys, setRemovedKeys] = useState([])
    const opCtxRef = useRef(null)

    /**
     * 请求 nonce 的单调序号。
     *
     * 以前每处都写 `String(Date.now())`：同一毫秒内发出的两次操作会得到同一个串，
     * 于是「上一次的回执」会被当成这一次的回执 —— 表现是删除/保存的转圈一闪而过。
     * （客户端集成测试在 Node 18 上偶发复现过。）
     */
    const nonceSeqRef = useRef(0)
    const nextNonce = () => `${Date.now().toString(36)}-${(nonceSeqRef.current += 1)}`

    /** Path of the skill currently being deleted: its card shows a spinner. */
    const [skillPendingPath, setSkillPendingPath] = useState("")
    /** Skill preview dialog: the entry whose SKILL.md body is being shown. */
    const [skillPreview, setSkillPreview] = useState(null)
    /**
     * Add/edit dialog state: `{ mode, scope, project, projectCustom, id, prevName, path }`.
     *
     * The destination is three orthogonal fields rather than one 「区域」 key: 层级 (`scope`)、
     * 工作区 (`project`) 与 目录 (`id`). `regionKey` used to encode the same thing as a
     * `scope:id` string, which forced a parse at every read site and could not express "the
     * project is being typed right now" (`projectCustom`).
     */
    const [skillDialog, setSkillDialog] = useState(null)
    const [skillDraft, setSkillDraft] = useState({ name: "", description: "", body: "" })
    const [skillError, setSkillError] = useState("")
    const [skillNonce, setSkillNonce] = useState("")
    /** When the current skill op was sent (for freshness fallback matching). */
    const skillSentAtRef = useRef(0)
    /**
     * Clear the skill-dialog in-flight markers.
     *
     * Both markers are cleared by a **matching receipt**, which is fine while a request is
     * genuinely in flight — but an op that never produces one leaves them set forever. The
     * paths that do that are ordinary: cancelling an edit before its body arrives, a Host
     * reload mid-op, or a dropped request. The next dialog then opens already showing
     * 「保存中…」 and 「正在与磁盘同步…」 with nothing in flight, and the save button is dead.
     *
     * Called from **every** entry point (添加技能 / 编辑 / 取消), so a stale marker can never
     * leak across dialogs. The flag is deliberately not cleared while a dialog is open, or a
     * real in-flight op would lose its progress state.
     */
    const resetSkillPending = () => {
      setSkillNonce("")
      setEditBodyPending(false)
      setEditBodyNonce("")
    }

    /**
     * Finish a skill **delete**, from either channel.
     *
     * `deleteNonce` is cleared in both cases so a failed delete can be retried; the difference is
     * only whether the card is hidden (backed by the Host's tombstone) or merely dropped from the
     * optimistic list (a skill that really is still on disk stays listed by the document, so its
     * card comes back by itself).
     */
    const finishSkillDelete = (delResult) => {
      const target = deleteTargetRef.current
      setSkillPendingPath("")
      if (delResult?.ok === true) {
        setDeleteDialog(null)
        setDeleteError("")
        // Drop the card now: the renderer's snapshot can lag the Host, and a
        // panel-created skill also leaves an optimistic entry behind.
        if (target !== null) {
          setOptimistic((list) => dropOptimisticSkill(list, target.name))
          setRemovedKeys((list) => hideSkillUntilGone(list, target.name, target.scopeKey))
        }
      } else {
        // The dialog already closed, so surface the reason where the card was.
        setSkillError(String(delResult?.reason ?? "删除失败"))
        // A stale card for a skill the Host cannot find (already deleted from
        // disk) only made the user click 删除 again and again: drop the local
        // optimistic card.
        if (target !== null) setOptimistic((list) => dropOptimisticSkill(list, target.name))
      }
      deleteTargetRef.current = null
      setDeletePending(false)
      setDeleteNonce("")
    }

    /**
     * Apply a **successful** skill write to the local list.
     *
     * Shared by both channels: the HTTP route answers with the result directly, while the
     * settings-queue path learns about it later through `skillResult`. They must produce
     * identical state, or the same click would behave differently depending on which channel
     * happened to serve it.
     *
     * Only called from effects/handlers, never during render: it reads `form`, which is declared
     * later in this component (touching it during render hit its temporal dead zone).
     */
    const applyOptimisticSkillWrite = (ctx) => {
      if (ctx === null) return
      const dirs = runtime.skillDirs ?? {}
      const isProject = ctx.scope === "project" && String(ctx.project ?? "") !== ""
      const base = isProject
        ? `${String(ctx.project).replace(/\/+$/, "")}/${ctx.id === "dsh" ? ".dsh" : ".agents"}/skills`
        : String(ctx.id === "dsh" ? (dirs.userDsh ?? "") : (dirs.userAgents ?? ""))
      if (ctx.kind === "create" && ctx.name !== "") {
        // Show the card immediately: the projection needs a reconcile tick plus a publish,
        // which is where the multi-second wait came from.
        setOptimistic((list) => [...list.filter((e) => !(e.name === ctx.name && e.scope === (isProject ? ctx.project : "global"))), {
          name: ctx.name, description: ctx.description,
          source: `${isProject ? "project" : "user"}-${ctx.id === "dsh" ? "dsh" : "agents"}`,
          scope: isProject ? ctx.project : "global",
          path: base !== "" ? `${base}/${ctx.name}/SKILL.md` : "",
          optimistic: true,
        }])
      } else {
        const gone = ctx.kind === "delete" ? ctx.name : ctx.prevName
        setOptimistic((list) => list.filter((e) => e.name !== gone))
        if (ctx.kind === "delete") {
          const scopeKey = ctx.scope === "project" && String(ctx.project ?? "") !== "" ? ctx.project : "global"
          setRemovedKeys((list) => [...new Set([...list, `${gone}::${scopeKey}`])])
        }
      }
    }

    /**
     * The skill whose delete is in flight: `{ name, scopeKey, path }`.
     *
     * The delete goes through the same `skillRequest` channel as the dialog ops,
     * but it is not started from that dialog — so it cannot rely on `opCtxRef`
     * (which the dialog sets on save). Without this, a delete receipt matched no
     * context and the card was never dropped locally.
     */
    const deleteTargetRef = useRef(null)
    /** Preview body fetched on demand (the list no longer carries bodies). */
    const [previewBody, setPreviewBody] = useState("")
    const [previewPending, setPreviewPending] = useState(false)
    const [previewNonce, setPreviewNonce] = useState("")
    /** Edit needs the body too; the list no longer carries it. */
    const [editBodyNonce, setEditBodyNonce] = useState("")
    const [editBodyPending, setEditBodyPending] = useState(false)
      /**
       * A delete whose receipt never arrives (the Host can be reloaded mid-op)
       * must not spin forever on the card. The nonce is deliberately kept, so a
       * late receipt still drops the card.
       */
      useEffect(() => {
        if (skillPendingPath === "") return undefined
        const timer = setTimeout(() => {
          setSkillPendingPath("")
          setDeletePending(false)
          setSkillError("删除没有回执（应用可能正在重载），请刷新后再确认一次")
        }, 15000)
        return () => clearTimeout(timer)
      }, [skillPendingPath])
      /**
       * A body read whose receipt never arrives must not wedge the dialog.
       *
       * `editBodyPending` gates the save button ("never save an edit before the body arrived: it
       * would erase the file"), so a lost receipt would leave the dialog permanently unsaveable —
       * the same failure shape the delete flow's 15 s guard exists for.
       *
       * A **separate** effect on purpose: putting this inside the receipt effect above would
       * `return` early and skip every receipt handler below it.
       */
      useEffect(() => {
        if (!editBodyPending || editBodyNonce === "") return undefined
        const timer = setTimeout(() => {
          setEditBodyPending(false)
          setEditBodyNonce("")
          setSkillError("读取正文没有回执（应用可能正在重载），请关掉重开一次")
        }, 15000)
        return () => clearTimeout(timer)
      }, [editBodyPending, editBodyNonce])

      /**
       * Operations we started but whose effect we have not seen yet. The Host
       * clears its queue BEFORE writing the patch, so the queue alone would drop
       * the spinner while the row still looks unchanged — this keeps it up until
       * the projection actually reflects the change (or a safety timeout).
       */
      const [inflight, setInflight] = useState({})
      /**
       * Close the `…` popup on any click outside it, and on Escape.
       *
       * The scrim inside the menu already catches clicks that land on the page, but not
       * clicks on the browser chrome / another window, and not the keyboard at all. A menu
       * that outlives the interaction is worse than no menu: the next click lands on an
       * item the user never meant to reach.
       *
       * Bound only while a menu is open, so the panel adds no permanent global listener.
       */
      useEffect(() => {
        if (menuFor === '') return undefined
        // `document` is absent in the offline render harness, and a menu that cannot bind
        // a key handler is not worth crashing the whole panel over.
        if (typeof document === 'undefined') return undefined
        const onKey = (event) => { if (event.key === 'Escape') setMenuFor('') }
        document.addEventListener('keydown', onKey)
        /**
         * 滚动或改变窗口大小时关掉菜单。
         *
         * 菜单现在是视口坐标（fixed），页面一滚它就会停在原地、指向一个已经不在这儿
         * 的按钮。关掉比让它飘着好 —— 用户再点一次的成本是一次点击，而一个错位的
         * 菜单会让人点错东西。
         */
        const onReflow = () => setMenuFor('')
        document.addEventListener('scroll', onReflow, true)
        globalThis.window?.addEventListener?.('resize', onReflow)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('scroll', onReflow, true)
          globalThis.window?.removeEventListener?.('resize', onReflow)
        }
      }, [menuFor])
      const [customProject, setCustomProject] = useState(false)
      const [importOpen, setImportOpen] = useState(false)
      const [importSource, setImportSource] = useState('claude')
      const [importScope, setImportScope] = useState('global')
      const [importProject, setImportProject] = useState('')
      const [importCustomProject, setImportCustomProject] = useState(false)
    /** The last scan answer, held in memory (it never touches the profile patch). */
    const [importScan, setImportScan] = useState(null)

      const refresh = () => setTick((n) => n + 1)

      /**
       * The Host writes its projection (profile rows, workspaces) straight into
       * the settings document; that does not reliably surface through the form's
       * own subscription, which is why the global list used to lag until you left
       * and reopened the page. Poll while the panel is open — a snapshot read.
       */
      useEffect(() => {
        const timer = setInterval(refresh, 700)
        return () => clearInterval(timer)
      }, [])
      useEffect(() => {
        const timer = setInterval(refresh, 1500)
        const unsubscribe = form?.subscribe?.(refresh)
        return () => {
          clearInterval(timer)
          if (typeof unsubscribe === 'function') unsubscribe()
        }
      }, [form])

      // The read-only inventory is the client's own view of the Loader: it always
      // names the MCP rows the profile configures, so it backs the 全局 tier when
      // the Host projection has not landed yet.
      const [inventoryRows, setInventoryRows] = useState([])
      useEffect(() => {
        let alive = true
        const load = () => {
          try {
            const list = props.inventory?.list
            if (typeof list !== 'function') return
            list().then((payload) => {
              if (!alive) return
              const entries = payload?.value?.entries ?? payload?.entries ?? []
              setInventoryRows((Array.isArray(entries) ? entries : []).map((row) => ({
                entryId: String(row?.entryId ?? row?.id ?? '?'),
                moduleName: String(row?.moduleName ?? row?.name ?? '?'),
                enabled: row?.enabled !== false,
                fiberPhase: String(row?.fiberPhase ?? ''),
              })))
            }).catch(() => {})
          } catch {
            // a missing or failing inventory must never blank the page
          }
        }
        load()
        const timer = setInterval(load, 10000)
        return () => { alive = false; clearInterval(timer) }
      }, [props.inventory])

      // Config-backed lists are gone: skills are disk-only and MCP rows come from /runtime.
      const [runtime, setRuntime] = useState({
        serverTools: [], serverStatus: [], serverToolsError: { reason: 'loading', detail: '' },
        /** Host 现算的完整读模型；任何一项缺失都按空值处理（旧 Host）。 */
        servers: [], skills: [], skillDirs: {}, workspaces: [], currentWorkspace: '',
        filter: {}, probe: {}, oauth: { servers: {} }, discovery: {},
      })
      /**
       * 回调页发来的「授权完成」信号计数。
       *
       * 把它放进下面那个 effect 的依赖里，信号一到就会**立刻**重新拉一次 `/runtime`，
       * 而不是等每 5 秒的轮询。授权是在另一个标签页里完成的，面板没有别的办法知道
       * 用户什么时候回来；同源广播是这里唯一可用的即时通道。
       */
      const [refreshPing, setRefreshPing] = useState(0)
      /**
       * 让面板**立刻**重新读一次运行时状态。
       *
       * 三个来源共用它：回调页的广播、一次成功的行命令、一次成功的技能写入。它们的共同点
       * 是「Host 那边刚发生了什么，别等下一个 5 秒轮询」。
       */
      const bumpRefresh = () => setRefreshPing((n) => n + 1)
      useEffect(() => {
        if (typeof BroadcastChannel === 'undefined') return undefined
        let channel
        try {
          channel = new BroadcastChannel(AUTH_CHANNEL)
        } catch {
          // 老浏览器 / 被策略禁用：静默降级到轮询，快只是附加价值，不是正确性的前提。
          return undefined
        }
        const onMessage = (event) => {
          if (event?.data === AUTH_DONE) bumpRefresh()
        }
        channel.addEventListener('message', onMessage)
        return () => {
          channel.removeEventListener('message', onMessage)
          channel.close()
        }
      }, [])
      useEffect(() => {
        let alive = true
        let pending = false
        let controller
        let lastLoadedAt = 0
        const load = async (force = false) => {
          /**
           * 为什么不再用 `document.visibilityState === 'hidden'` 来跳过一次拉取。
           *
           * 这个判断原先是一道「后台页别空转」的省电开关，但它把**「不可见」和「不该更新」
           * 混为一谈**，而真机上代价很大：只要浏览器（或 DSH 的 Web 视图）把页面判成
           * hidden，倒计时就会**永远停在某一个数字上**，而界面上没有任何迹象表明它在冻着 ——
           * 用户唯一能做的就是把卡片切换一下（那会重建 effect、立刻拉一次），于是现象变成
           * 「点一下才刷新」。
           *
           * 真正的省电手段是 `visibilitychange`：页面回到可见时立刻补一次（下面已经监听了）。
           * 所以这里只在**明确隐藏**时退让成低频，而不是完全不动 —— 后台页每 15 秒一次的成本
           * 可以忽略，换来的是「计时器永远在走」这个更重要的性质。
           */
          if (pending) return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && !force) {
            // 隐藏时降频：距上次成功拉取不足 15s 就跳过。
            if (Date.now() - lastLoadedAt < 15000) return
          }
          pending = true
          controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 10000)
          try {
            const response = await fetch(`/${NS}/runtime`, {
              credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const payload = await response.json()
            if (!Array.isArray(payload?.serverTools) || !Array.isArray(payload?.serverStatus)
              || typeof payload?.serverToolsError?.reason !== 'string') throw new Error('响应格式无效')
            lastLoadedAt = Date.now()
            if (alive) setRuntime(payload)
          } catch (error) {
            // Keep the last known rows/skills: a transient runtime failure must not make the
            // list itself vanish. Only the observation data is cleared, and the status tag
            // says "unknown" instead of pretending the servers are gone.
            if (alive) setRuntime((current) => ({
              ...current,
              serverTools: [], serverStatus: [],
              serverToolsError: { reason: 'runtime-unavailable', detail: String(error?.message ?? error) },
            }))
          } finally {
            clearTimeout(timeout)
            pending = false
          }
        }
        load()
        const timer = setInterval(load, 5000)
        /** 回到前台立刻补一次（低频策略不能拖到下一个 5s 才「看见」）。 */
        const onVisible = () => { void load(true) }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive = false
          controller?.abort()
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
        // `refreshPing`：回调页广播、或刚写完一次行/技能命令时立刻重拉一次。
      }, [tab, expanded, refreshPing])
      /**
       * Drop a delete tombstone once the runtime snapshot no longer lists that skill
       * (or once the list has moved on). This is local rendering state only.
       */
      useEffect(() => {
        if (removedKeys.length === 0) return
        const now = new Set((runtime.skills ?? []).map((entry) => `${entry.name}::${entry.scope ?? 'global'}`))
        const keep = removedKeys.filter((key) => now.has(key))
        if (keep.length !== removedKeys.length) setRemovedKeys(keep)
      }, [runtime.skills, removedKeys])
      const serverTools = runtime.serverTools
      /** Per-server tool filter rules, as the Host published them. */
      const toolFilters = useMemo(() => {
        const raw = snapshotOf(form)?.toolFilters
        return raw !== null && typeof raw === 'object' ? raw : {}
      }, [form, tick])
      /** Whether the register shadow is actually installed, and why not when it is not. */
      const filterState = runtime.filter ?? {}
      const serverToolsError = runtime.serverToolsError
      // Retry timing is inferred by the Host; labels must continue to say “预计”.
      const serverStatus = runtime.serverStatus


      /**
       * OAuth availability, as the Host published it.
       *
       * `ready` decides whether the 「需要授权」 note offers a button or falls back to the
       * manual-header advice. Both halves matter: on an older Host, or one where the SDK
       * could not be patched, there must be **no button** — a button that can only fail looks
       * like the user's mistake.
       */
      const oauthState = runtime.oauth ?? {}
      /** Per-server authorization state (`present` / `refreshable` / `waiting` / `expiresAt`). */
      const oauthServers = runtime.oauth?.servers ?? {}
      /** Result of the last `authorize` / `logout` this panel issued, per server. */
      const [oauthResult, setOauthResult] = useState({})
      /** The server whose authorize call is in flight, or ''. */
      const [oauthPending, setOauthPending] = useState('')
      /** Server whose authorization URL was just copied (for the 「已复制」 flash). */
      const [copiedUrlFor, setCopiedUrlFor] = useState('')

      /** The Host's per-server authorization state, or an empty shell. */
      const oauthServerState = (serverName) => {
        const entry = oauthServers[serverName]
        return entry !== null && typeof entry === 'object' ? entry : {}
      }

      /**
       * The authorization URL to show for one server.
       *
       * Two sources, and the local one wins: a URL this panel just received is fresher than
       * the 5 s projection, and it is the one the user is expected to open **now**. Falling
       * back to the projection covers the case where the transport hit a 401 on its own and
       * the Host recorded the URL without any panel request.
       */
      const authorizeUrlFor = (serverName) => {
        const local = String(oauthResult[serverName]?.authorizeUrl ?? '')
        if (local !== '') return local
        return String(oauthServerState(serverName).authorizeUrl ?? '')
      }

      /** The failure text for one server, or ''. */
      const oauthFailureFor = (serverName) => {
        const result = oauthResult[serverName]
        if (result === undefined || result === null) return ''
        if (result.ok === true) return ''
        const reason = String(result.reason ?? '')
        const detail = String(result.detail ?? '')
        if (detail !== '' && detail !== reason) return `${reason === '' ? '授权失败' : reason}：${detail}`
        return reason === '' ? '授权失败' : reason
      }

      /** Ask the Host to begin an authorization and show whatever it returns. */
      const startOAuth = async (serverName) => {
        if (oauthPending !== '') return
        setOauthPending(serverName)
        setCopiedUrlFor('')
        try {
          const result = await sendOAuth({ action: 'authorize', serverName })
          setOauthResult((previous) => ({ ...previous, [serverName]: result }))
        } finally {
          setOauthPending('')
        }
      }

      /** Drop the stored credentials for one server (the user asked to start over). */
      const revokeOAuth = async (serverName) => {
        if (oauthPending !== '') return
        setOauthPending(serverName)
        try {
          const result = await sendOAuth({ action: 'logout', serverName })
          setOauthResult((previous) => ({ ...previous, [serverName]: result }))
        } finally {
          setOauthPending('')
        }
      }

      /**
       * Copy the authorization URL.
       *
       * Same interaction DSH's own account login uses — 「复制登录链接」 rather than opening a
       * browser automatically. That is not laziness: a Host-side `open` cannot work in a
       * remote/headless session, and would fail silently there.
       */
      const copyAuthorizeUrl = (serverName) => {
        const url = authorizeUrlFor(serverName)
        if (url === '') return
        try {
          void navigator.clipboard?.writeText?.(url)
          setCopiedUrlFor(serverName)
        } catch {
          // Clipboard can be unavailable (insecure origin, denied permission). The URL is
          // already selectable in the input next to the button, so nothing is lost.
          setCopiedUrlFor('')
        }
      }

      /** Runtime rows first; the client-side Loader inventory is the fallback. */
      const profileRows = useMemo(() => {
        const runtimeRows = Array.isArray(runtime.servers) ? runtime.servers : []
        if (runtimeRows.length > 0) return runtimeRows
        return inventoryRows
          .filter((row) => row.moduleName === '@deepseek-ai/dsh-mcp-client')
          .map((row) => ({
            entryId: row.entryId,
            serverName: row.entryId.replace(/^include:/, '').replace(/^mcp-/, ''),
            transport: '',
            target: '',
            enabled: row.enabled,
            phase: row.fiberPhase,
          }))
      }, [runtime.servers, inventoryRows])

      const debugOn = typeof location !== 'undefined' && /(?:^|[?&])smp=debug/.test(location.search)
      const debugMcp = inventoryRows.filter((row) => /mcp/i.test(row.entryId) || /mcp/i.test(row.moduleName))

      // Row actions are backed by HTTP routes now; there is no capability marker to wait for.
      const rowOpsReady = true

      // 只按名称搜索（以前是整行 JSON 匹配，会把 URL/参数/环境变量也算进去）
      const matches = (row) => matchesName(row.serverName ?? row.name, query)
      const isGlobal = (row) => (row.scope ?? 'global') === 'global'

      /**
       * Skills are **one list across every workspace**, exactly like MCP.
       *
       * There used to be a 项目 filter on this tab, and it hid every project skill except the
       * selected one — so a skill you had just added to another workspace simply was not on
       * screen. MCP dropped that filter when both tiers became rows; skills now do the same.
       * The workspace a card belongs to is on the card (its scope tag), which is the same way
       * a server says it.
       *
       * The dialog still picks a region (and, for a project skill, a workspace) — that is a
       * property of the entry being created, not a filter over the list.
       */
      // Skills already on disk (DSH's own roots) — listed read-only, not managed here.
      const skillDirs = runtime.skillDirs ?? {}
      const discoveredFromDoc = runtime.skills ?? []
      const docKeys = new Set(discoveredFromDoc.map((entry) => `${entry.name}::${entry.scope}`))
      const removedSet = new Set(removedKeys)
      const discovered = [
        ...discoveredFromDoc.filter((entry) => !removedSet.has(`${entry.name}::${entry.scope}`)),
        ...optimistic.filter((entry) => !docKeys.has(`${entry.name}::${entry.scope}`)),
      ]
      /**
       * Which on-disk root a skill came from (`dsh` or `agents`), from its `source`
       * (`user-agents`, `project-dsh`, …).
       *
       * This is what the card's tag needs: the scope says *whose* the skill is, and this says
       * which of the two roots under it the file actually lives in.
       */
      const rootIdOfSource = (source) => (String(source).endsWith("-agents") ? "agents" : "dsh")
      const discoveredOnly = discovered.filter((entry) => matchesName(entry.name, query))
      /**
       * Human label for a project path: the workspace registry title when we
       * have one, otherwise the last path segment. A path the user typed by hand
       * (not in the registry) keeps its full spelling.
       */
      const knownProjects = new Map((runtime.workspaces ?? [])
        .filter((workspace) => typeof workspace?.path === 'string' && workspace.path !== '')
        .map((workspace) => [workspace.path, typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : workspace.path]))
      const projectLabel = (path) => {
        if (typeof path !== 'string' || path === '') return ''
        const known = knownProjects.get(path)
        if (known !== undefined) return known
        // Not a registered workspace: the user typed it, so show it in full.
        return path
      }
      /**
       * A project scope as a short card tag: the workspace registry title when the
       * path is known, otherwise the path's last segment. A tag has room for a name,
       * not for a path — the full path stays in the expanded 「作用域」 row.
       */
      /**
       * A scope as the card's tag.
       *
       * Global reads 「全局」 — a project reads the workspace's name. This is the **same
       * vocabulary on both tabs**: MCP used to leave a global row untagged and a skill used to
       * tag by *root* (`dsh` / `agents`), which answered a different question. The tag says
       * whose entry it is; which of the two roots under that scope holds the file is the
       * 「落盘」 row in the expanded details.
       *
       * A path that is not in the registry is the user's own, so its last segment is used: a
       * tag has room for a name, not a path.
       */
      const scopeTagLabel = (path) => {
        if (typeof path !== 'string' || path === '' || path === 'global') return '全局'
        const known = knownProjects.get(path)
        if (known !== undefined) return known
        const parts = path.replace(/\/+$/, '').split('/')
        return parts[parts.length - 1] || ''
      }

      /**
       * The absolute directory a skill is written to — the real path, not a label.
       *
       * The panel offers **four** writable roots: two per scope. DSH's own provider reads all
       * four (`src/skills/discover.js`), so "全局" is not one place but two
       * (`~/.agents/skills`, `~/.dsh/skills`), and so is a project
       * (`<工作区>/.agents/skills`, `<工作区>/.dsh/skills`). Showing the actual path is what
       * makes the choice checkable — 「全局 · agents」 does not tell you where that is.
       */
      const skillRootLabel = (scope, id) => {
        const useAgents = id === 'agents'
        const leaf = useAgents ? '.agents/skills' : '.dsh/skills'
        if (typeof scope !== 'string' || scope === '' || scope === 'global') {
          // The two user-level roots. Use the same values the Host publishes so the label is
          // the path that will actually be written, not a guess (`~` is expanded there).
          const dirs = skillDirs
          if (useAgents) return dirs.userAgents || '~/.agents/skills'
          return dirs.userDsh || '~/.dsh/skills'
        }
        return `${scope.replace(/\/+$/, '')}/${leaf}`
      }
      /**
       * The workspace a new **project-scoped** entry proposes.
       *
       * The toolbar project switch is gone, so nothing is preselected there any more; this is
       * where "which workspace" comes from. The session's own workspace first (that is the one
       * the user is working in), then whatever the panel already has entries for. The field is
       * editable, so this is a default and not a constraint.
       *
       * Deliberately not state: the old version copied the workspace into state once, which
       * then went stale as soon as the session moved. This is read at the moment the dialog
       * opens.
       */
      const defaultWorkspace = () => {
        const current = runtime.currentWorkspace
        if (typeof current === 'string' && current !== '') return current
        const configured = profileRows.map((row) => row.scope).find((scope) => typeof scope === 'string' && scope !== '' && scope !== 'global')
        return configured ?? ''
      }

      /** Row ops still queued: the Host applies them within a couple of seconds. */
      useEffect(() => {
        setInflight((current) => settleInflight(current, { profileRows }))
      }, [tick, profileRows, inflight])

      const pendingOps = []
      const pendingOf = (entryId) => pendingOps.find((op) => String(op?.entryId ?? '').replace(/^include:/, '') === String(entryId).replace(/^include:/, '')) ?? null
      /**
       * Project picker options: the workspace registry first (published by the
       * Host), then any project scope already configured in this panel.
       */
      const projectChoices = useMemo(() => {
        const map = new Map()
        for (const workspace of runtime.workspaces ?? []) {
          const path = typeof workspace?.path === 'string' ? workspace.path : ''
          if (path !== '') map.set(path, typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : path)
        }
        // Any project scope the panel already has entries for, so the add dialog can offer a
        // workspace that is not (or no longer) in the registry.
        for (const row of profileRows) {
          const scope = row?.scope
          if (typeof scope === 'string' && scope !== '' && scope !== 'global' && !map.has(scope)) map.set(scope, scope)
        }
        return [...map.entries()]
      }, [profileRows, runtime.workspaces, form, tick])

      /**
       * Workspace paths in registry order — the order MCP groups are displayed in.
       *
       * Deliberately only the registry, not `projectChoices`: the picker appends
       * hand-typed paths so they stay selectable, but the *display* order should be the
       * one the user sees in DSH's own workspace list. Scopes outside the registry sort
       * after the known ones (see `orderedScopeGroups`).
       */
      const workspacePaths = useMemo(() => (runtime.workspaces ?? [])
        .map((workspace) => (typeof workspace?.path === 'string' ? workspace.path : ''))
        .filter((path) => path !== ''), [runtime.workspaces])

      async function write(field_, value) {
        setBusy(true)
        setError('')
        try {
          if (typeof form?.set === 'function') await form.set(field_, value)
          else if (props.mutate) await props.mutate(NS, [{ op: 'set', path: [field_], value }])
          refresh()
          // 技能增删改也走这里；写完让运行时列表跟着刷新一次。
          bumpRefresh()
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      /**
       * The Host's own id for a row: the projection reports loader entry ids
       * (`include:mcp-context7`) while the profile patch keys rows by their bare id.
       */
      const bareRowId = (entryId) => String(entryId).replace(/^include:/, '').replace(/^[a-z-]+:/i, '')

      /**
       * Send one command against a profile-configured row.
       *
       * Over HTTP, to the Host's own route: the write takes ~1–5 ms, and this is the only
       * transport whose round-trip is in the same order of magnitude. The settings queue it
       * replaced cost 2–4 s of *waiting* per command (a 500 ms drain poll, a fixed 1200 ms
       * pause, the Loader reload, then this panel's own poll) — which is what made adding or
       * deleting a server feel like it needed a manual edit of the yml.
       *
       * The queue is still written when the route is unusable (an older Host, a profile without
       * a web server, or a request that failed outright): the Host drains both, so falling back
       * is safe, and the user's command is never silently dropped.
       *
       * Returns the Host's `{ ok, reason }`. Callers show `reason` on failure and roll their
       * optimistic state back — the point of the short path is that a failure is known in
       * milliseconds, not after a 15 s timeout.
       */
      const sendRowOp = async (op) => {
        const payload = { ...op, entryId: bareRowId(op.entryId) }
        if (typeof fetch !== 'function') return { ok: false, reason: '当前环境没有 fetch' }
        try {
          const response = await fetch(`/${NS}/rows`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          // 404/405: this Host has no command route; 401/403: the request was not trusted.
          if (response.status === 404 || response.status === 405) {
            return { ok: false, reason: '这个 Host 没有行命令路由（Host 侧改动需要重启一次 DSH）' }
          }
          if (response.status === 401 || response.status === 403) {
            return { ok: false, reason: '请求未被信任（请从 DSH 面板里操作）' }
          }
          if (!response.ok) {
            let reason = `HTTP ${String(response.status)}`
            try {
              const body = await response.json()
              if (typeof body?.reason === 'string' && body.reason !== '') reason = body.reason
            } catch { /* keep the status code */ }
            return { ok: false, reason }
          }
          const result = await response.json()
          if (result?.ok === true) {
            return { ok: true, reason: '', servers: Array.isArray(result.servers) ? result.servers : null }
          }
          return { ok: false, reason: String(result?.reason ?? '写入失败') }
        } catch (error) {
          return { ok: false, reason: String(error?.message ?? error) }
        }
      }

      /**
       * Send one skill **write** to the Host, preferring the HTTP route.
       *
       * Same reasoning as `sendRowOp` above, and the same three-way fallback. The measured
       * problem: writing the file takes **1 ms**, but the settings-queue round-trip stacked four
       * polls (600 ms request drain + this panel's settings poll + the Host's 2 s reconcile tick
       * + the 5 s projection publish) for a worst case of **9.1 s**. Deleting only *looked* fast
       * because it drops its card optimistically — it used the same slow channel.
       *
       * `read` deliberately stays on the queue: it is a read, it already shows 「正在读取正文…」,
       * and the route refuses it (so a mistake here fails loudly instead of silently working).
       *
       * Returns `{ ok, reason, queued? }`. A queued send is reported as success because the Host
       * will drain it — the caller must not roll back an optimistic card in that case.
       */
      const sendSkillWrite = async (request) => {
        if (typeof fetch !== 'function') return { ok: false, reason: '当前环境没有 fetch' }
        try {
          const response = await fetch(`/${NS}/skills`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
          })
          if (response.status === 404 || response.status === 405) {
            return { ok: false, reason: '这个 Host 没有技能写入路由（Host 侧改动需要重启一次 DSH）' }
          }
          if (response.status === 401 || response.status === 403) {
            return { ok: false, reason: '请求未被信任（请从 DSH 面板里操作）' }
          }
          if (!response.ok) {
            let reason = `HTTP ${String(response.status)}`
            try {
              const body = await response.json()
              if (typeof body?.reason === 'string' && body.reason !== '') reason = body.reason
            } catch { /* keep the status code */ }
            return { ok: false, reason }
          }
          const result = await response.json()
          if (result?.ok === true) return { ok: true, reason: '' }
          return { ok: false, reason: String(result?.reason ?? '写入失败') }
        } catch (error) {
          return { ok: false, reason: String(error?.message ?? error) }
        }
      }

      /** Read one skill body (GET; only files the Host's scan found are readable). */
      const readSkillBody = async (path) => {
        if (typeof fetch !== 'function') return { ok: false, reason: '当前环境没有 fetch' }
        if (typeof path !== 'string' || path === '') return { ok: false, reason: '没有文件路径' }
        try {
          const response = await fetch(`/${NS}/skill?path=${encodeURIComponent(path)}`, {
            credentials: 'same-origin', cache: 'no-store',
          })
          if (response.status === 404 || response.status === 405) {
            return { ok: false, reason: '这个 Host 没有技能读取路由（Host 侧改动需要重启一次 DSH）' }
          }
          if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
          return await response.json()
        } catch (error) {
          return { ok: false, reason: String(error?.message ?? error) }
        }
      }

      /** Run one reconnect command; the response is the outcome. */
      const sendReconnect = async ({ tier, serverName, scope }) => {
        if (typeof fetch !== 'function') return { ok: false, reason: '当前环境没有 fetch' }
        try {
          const response = await fetch(`/${NS}/reconnect`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tier, serverName, scope }),
          })
          if (response.status === 404 || response.status === 405) {
            return { ok: false, reason: '这个 Host 没有重连路由（Host 侧改动需要重启一次 DSH）' }
          }
          if (response.status === 401 || response.status === 403) {
            return { ok: false, reason: '请求未被信任（请从 DSH 面板里操作）' }
          }
          if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
          return await response.json()
        } catch (error) {
          return { ok: false, reason: String(error?.message ?? error) }
        }
      }

      /** Ask the Host to scan one external tool's MCP config files. */
      const scanImport = async ({ source, scope, project }) => {
        if (typeof fetch !== 'function') return { ok: false, files: [], servers: [], error: '当前环境没有 fetch' }
        try {
          const response = await fetch(`/${NS}/import`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source, scope, project }),
          })
          if (response.status === 404 || response.status === 405) {
            return { ok: false, files: [], servers: [], error: '这个 Host 没有导入扫描路由（Host 侧改动需要重启一次 DSH）' }
          }
          if (response.status === 401 || response.status === 403) {
            return { ok: false, files: [], servers: [], error: '请求未被信任（请从 DSH 面板里操作）' }
          }
          if (!response.ok) return { ok: false, files: [], servers: [], error: `HTTP ${response.status}` }
          return await response.json()
        } catch (error) {
          return { ok: false, files: [], servers: [], error: String(error?.message ?? error) }
        }
      }

      /**
       * Send one OAuth command to the Host.
       *
       * Unlike rows and skill writes this has **no fallback channel**, on purpose. The
       * settings queue cannot carry the answer: `authorize` must return an authorization URL
       * the user is about to open, and a queue round-trip is 2–4 s of blank dialog with
       * nothing to show. So a missing route is reported as "this Host cannot do OAuth"
       * rather than being silently downgraded — the honest failure is the useful one here.
       *
       * Returns `{ ok, ...payload }`. Never throws: a thrown error inside a click handler
       * would leave the card spinning forever.
       */
      const sendOAuth = async ({ action, serverName }) => {
        if (typeof fetch !== 'function') return { ok: false, reason: '当前环境没有 fetch，无法发起授权' }
        try {
          const response = await fetch(`/${NS}/oauth`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, serverName }),
          })
          // 404/405: this Host has no OAuth route (older build, or the Host half failed to
          // register). 401/403: the request was not trusted. Both mean "the feature is not
          // available here", which the card must say instead of pretending to try.
          if (response.status === 404 || response.status === 405) {
            return { ok: false, reason: '这个 Host 版本没有 OAuth 通道（Host 侧改动需要重启一次 DSH）' }
          }
          if (response.status === 401 || response.status === 403) {
            return { ok: false, reason: '请求未被信任（请从 DSH 面板里操作）' }
          }
          if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
          const result = await response.json()
          return result !== null && typeof result === 'object' ? result : { ok: false, reason: '响应格式无效' }
        } catch (error) {
          return { ok: false, reason: String(error?.message ?? error) }
        }
      }

      /**
       * The filter rule for one server, in the shape the editor needs.
       *
       * The panel stores the rule per server, so every edit rewrites just that one
       * key and leaves the other servers' rules alone — the settings document is
       * shared, and replacing the whole map would clobber a concurrent edit.
       */
      const filterFor = (serverName) => {
        const rule = toolFilters[serverName]
        return {
          mode: rule?.mode === 'allow' || rule?.mode === 'deny' ? rule.mode : 'off',
          tools: Array.isArray(rule?.tools) ? rule.tools : [],
        }
      }

      const writeFilter = (serverName, next) => {
        const map = { ...toolFilters }
        if (next.mode === 'off') delete map[serverName]
        else map[serverName] = { mode: next.mode, tools: next.tools }
        return write('toolFilters', map)
      }

      /** Strip the `mcp__<server>__` prefix so the list shows only what differs. */
      const leafOf = (serverName) => (fullName) => {
        const prefix = `mcp__${serverName}__`
        return fullName.startsWith(prefix) ? fullName.slice(prefix.length) : fullName
      }

      /**
       * Connection status for one server, as the Host published it.
       *
       * Matched on tier **and** scope: the same serverName can legitimately exist as a
       * global row and as a project entry, and they are different connections with
       * different fates — showing one's status on the other's card would be a lie.
       */
      const statusFor = (serverName, tier, scope) => {
        if (typeof serverName !== 'string' || serverName === '') return null
        const wantScope = scope ?? ''
        return serverStatus.find((item) => item.serverName === serverName && item.tier === tier && (item.scope ?? '') === wantScope)
          ?? serverStatus.find((item) => item.serverName === serverName && item.tier === tier)
          ?? null
      }

      /**
       * Dotted status, in the shape Chrome's extension list uses: a small coloured dot,
       * then the state in words, then the supporting numbers.
       *
       * The pill these replaced read as a **badge** — a pebble sitting at the end of the
       * row, visually as heavy as the card's own tags (「已停用」/「配置文件」), which made a
       * routine state look like a warning and a real warning look like chrome. A dot does
       * the opposite: colour carries the signal at a glance, the word beside it carries the
       * meaning, and weight drops out of the way.
       *
       * Four colours cover every state, and only four — a fifth would mean two states that
       * look alike but need different actions:
       *   ok      绿  连上了，可用
       *   warn    黄  还在自己努力（连接中）**或**在等你动手（需要授权）
       *   danger  红  不会自愈（已放弃重试 / 异常）
       *   neutral 灰  没什么可报告（未挂载 / 状态未知 / 已关闭）
       *
       * 黄与红的分界是「要不要用户动手、以及会不会自己好」：连接中会在预算内自愈，
       * 需要授权等用户补凭据，两者都还没失败。红只留给必须用户处理且**不会**自己好的。
       * 主题里除红/绿外只有一档状态色，所以「需要授权」与「连接中」同为黄 —— 区分靠文字。
       *
       * `detail` rides on the `title`, which is where a long explanation belongs: the
       * row stays one line, and hovering gives the whole reason (including why an auth
       * challenge is not a failure).
       */
      const STATUS_DOTS = {
        connected: { dot: 'ok', text: '可用' },
        // 「连接中」同时覆盖首次连接（pending）与断线重试（retrying）：对用户来说是同一件事
        // ——还在连。区分它们只会让标签更长，而两档都不需要用户动手。
        retrying: { dot: 'warn', text: '连接中' },
        pending: { dot: 'warn', text: '连接中' },
        'gave-up': { dot: 'danger', text: '已放弃重试' },
        failed: { dot: 'danger', text: '异常' },
        // 需要授权**不是故障**：受保护的服务器拒绝未授权连接是协议规定的正常行为，
        // 红色会让人去修一台根本没坏的服务器。黄 = 有一件事等你做。
        'needs-auth': { dot: 'warn', text: '需要授权' },
        unmounted: { dot: 'neutral', text: '未挂载' },
        disabled: { dot: 'neutral', text: '已关闭' },
        // 观测机制没装上时如实说「状态未知」。只在 Host 明确报告 unknown 时出现
        // （旧 Host 根本不发布 serverStatus，那种情况整个标签都不渲染）——
        // 因为「看不见」和「一切正常」长得一样，是这类告警最坏的失败方式。
        unknown: { dot: 'neutral', text: '状态未知' },
      }

      const statusDot = (serverName, tier, scope) => {
        const item = statusFor(serverName, tier, scope) ?? (serverToolsError?.reason ? {
          status: 'unknown', detail: serverToolsError.reason === 'loading' ? '正在读取连接状态' : serverToolsError.detail,
        } : null)
        const spec = STATUS_DOTS[item?.status]
        if (spec === undefined) return null
        // 数字只对「已经量出来的东西」有意义：连上了才有工具数，重试中才有剩余时间。
        // 其余状态挂一个 0 只会让人以为「它没有工具」。
        const tools = item.status === 'connected' && item.toolCount > 0 ? `${item.toolCount} 个工具` : ''
        // Time left is an estimate from the configured budget, so it is labelled as one.
        const left = item.status === 'retrying' && item.remainingSeconds > 0 ? `约 ${item.remainingSeconds}s` : ''
        const trailing = [tools, left].filter((part) => part !== '')
        return (
          <span className="smp-status" key="status" title={item.detail || undefined}>
            <span className="smp-dot" data-dot={spec.dot} key="d" aria-hidden="true" />
            <span className="smp-statusText" key="t">{spec.text}</span>
            {trailing.map((part, index) => (
              <span className="smp-statusMeta" key={`m${index}`}>{part}</span>
            ))}
          </span>
        )
      }

      /**
       * Manual re-connect for a server that will not recover on its own.
       *
       * Offered exactly where it helps: the mcp-client gives up permanently once its
       * retry budget runs out, and only a **new instance** (or a raised budget) brings
       * it back. Not offered while connected, disabled, or unmounted — there would be
       * nothing to re-establish.
       *
       * Returns `{ node, failure }` rather than a bare node: the failure text belongs
       * inside the popup (under the item it came from), not beside the trigger, so the
       * caller needs both pieces.
       */
      const reconnectAction = (serverName, tier, scope) => {
        // 白名单，不是黑名单 —— 这个方向很重要。
        //
        // 「重连」只在**确实卡住且重连有意义**时才出现：已放弃重试 / 异常 / 连接中
        // （连接中给它是为了让用户能立刻催一次，而不是等预算跑完）。
        //
        // 其余一律不给，而且每一条都有理由：
        //   connected  连着，重连只会打断它
        //   needs-auth 缺的是**授权**不是连接 —— 重连治不了，给了等于教用户反复点无效按钮
        //   unknown    不知道状态，重连可能修好也可能搞坏一台正常的
        //   unmounted  当前会话里压根没挂，没有连接可重建
        //   disabled   停用了（调用方也会挡住整组操作）
        //
        // 写黑名单时漏掉一个状态就会多给一个按钮（needs-auth 就这么漏过一次），
        // 而白名单漏掉一个只是**少**给一个按钮 —— 后者是可以接受的失败方向。
        const item = statusFor(serverName, tier, scope)
        const RECONNECTABLE = new Set(['gave-up', 'failed', 'retrying', 'pending'])
        if (item === null || !RECONNECTABLE.has(item.status)) return null
        const state = reconnectState[serverName] ?? {}
        const waiting = state.pending === true
        const failure = String(state.error ?? '')
        return {
          node: (
            <button
              className="smp-menuItem" key="reconnect" disabled={busy || waiting}
              onClick={() => {
                setReconnectState((current) => ({ ...current, [serverName]: { pending: true, error: '' } }))
                void sendReconnect({ tier, serverName, scope: scope ?? '' }).then((result) => {
                  setReconnectState((current) => ({
                    ...current,
                    [serverName]: { pending: false, error: result.ok ? '' : String(result.reason ?? '重连失败') },
                  }))
                  if (result.ok) bumpRefresh()
                })
              }}
            >
              {waiting ? '重连中…' : '重连'}
            </button>
          ),
          failure,
        }
      }

      /**
       * A small horizontal switch, the shape a plugin list uses for on/off.
       *
       * Replaces the 「启用 / 停用」 button pair: a switch says which state the row is in
       * as well as offering the change, and it reads at a glance across a column of rows.
       * The button only said what clicking would do, so a disabled row looked identical
       * to an enabled one until you read the label.
       *
       * Optimistic while the op is in flight (`inflight` carries the expected value), so
       * the knob moves on click instead of after the Host's round trip — with a 2s window
       * and an HMR write behind it, waiting reads as "the click did nothing".
       */
      /**
       * Send a command, then either confirm it (drop the spinner) or undo it and say why.
       *
       * Optimistic UI is only honest if a failure is visible: the card disappeared (or the
       * switch moved) the moment it was clicked, so a rejected command has to put it back and
       * report the reason. Silently keeping the optimistic state would show the user a config
       * the file does not contain — worse than the wait this replaced.
       *
       * On success the entry is **kept but marked `confirmed`**, which is not the same as
       * settling it. The spinner means "we are still writing"; once the Host has answered, that
       * question is answered and the spinner must go — it used to stay until the *projection*
       * came back on the panel's next poll, which is up to ~1.5 s of spinning after a write
       * that took milliseconds. The entry stays until the row actually appears so the card
       * keeps rendering from the confirmed values: dropping it here would make an added card
       * vanish and flash back when the projection landed.
       */
      const commandRowOp = (op, entryId) => {
        const key = inflightKeyForRow(entryId)
        void sendRowOp(op).then((result) => {
          if (result.ok) {
            setInflight((m) => (m[key] === undefined ? m : { ...m, [key]: { ...m[key], confirmed: true } }))
            // The route answers with the rows it just wrote: apply them before the poll.
            if (Array.isArray(result.servers)) {
              setRuntime((current) => ({ ...current, servers: result.servers }))
            }
            bumpRefresh()
            return
          }
          setInflight((m) => {
            const next = { ...m }
            delete next[key]
            return next
          })
          setError(result.reason)
        })
      }

      const enabledSwitch = (row) => {
        const key = inflightKeyForRow(row.entryId)
        const on = row.enabled !== false
        const expected = inflight[key]?.kind === 'toggle' ? inflight[key].expectEnabled : undefined
        const shown = expected === undefined ? on : expected
        const toggle = (next) => {
          setInflight((m) => ({ ...m, [key]: { kind: 'toggle', at: Date.now(), expectEnabled: next } }))
          commandRowOp(toggleServerOp(row.entryId, next), key)
        }
        const label = shown ? '停用' : '启用'
        /**
         * The Host's own switch, so this control looks like every other toggle in the
         * settings app — same capsule, same thumb, same brand colour, and the same rule that
         * the visual state keys off `aria-checked` rather than a parallel class. Our
         * hand-rolled pill was a different size *and* a different colour, which read as
         * "this is some third party's control".
         *
         * `@deepseek-ai/*` is external in the bundle, so this resolves against the running
         * Host and cannot drift. The fallback is only for a Host that predates it.
         *
         * Shared with the form's connection switches (`switchControl`) so there is one
         * implementation of "a boolean control in this panel", not three that drift.
         */
        return switchControl(shown, toggle, label, busy)
      }

      /**
       * The `…` trigger plus its vertical popup.
       *
       * Why a popup instead of a row of buttons: three buttons per card made the action
       * area wider than the identity it belonged to, and on a two-column grid they pushed
       * the server name out of view. A menu keeps the row calm and puts the actions one
       * click away, which is where a rarely used 删除 belongs anyway.
       *
       * The panel closes on outside click and on Escape, because a menu that survives an
       * unrelated click is a trap: the next click lands on a menu item the user never
       * meant to open.
       */
      const moreMenu = (row, items) => {
        const open = menuFor === row.entryId
        const visible = items.filter((item) => item !== null && item !== undefined)
        if (visible.length === 0) return null
        return (
          <span className="smp-more" key="more">
            <button
              className="smp-moreTrigger" key="t" type="button" disabled={busy}
              aria-haspopup="menu" aria-expanded={open} aria-label="更多操作"
              onClick={(event) => {
                if (open) {
                  setMenuFor('')
                  return
                }
                /**
                 * 打开前量一次触发按钮的位置，决定菜单往下还是往上，并换算成视口坐标。
                 * 量不出来（离线渲染、没有布局）时 anchor 为 null，菜单退回 CSS 的默认
                 * 绝对定位 —— 那正是测试渲染器走的那条路。
                 */
                const rect = event?.currentTarget?.getBoundingClientRect?.()
                setMenuAnchor(measureMenuAnchor({
                  rect,
                  // 每一版增删菜单项都会改变高度，所以按**当前**项数估，不写死数字。
                  itemCount: visible.length,
                  viewportWidth: globalThis.window?.innerWidth,
                  viewportHeight: globalThis.window?.innerHeight,
                }))
                setMenuFor(row.entryId)
              }}
            >
              ⋯
            </button>
            {open ? (
              <>
                {/* 点击遮罩关闭：不能让菜单在一次无关的点击后还开着，
                    否则下一次点击会落在用户没打算打开的菜单项上。 */}
                <span className="smp-menuScrim" key="scrim" onClick={() => setMenuFor('')} />
                <span
                  className="smp-menu" key="menu" role="menu"
                  data-placement={menuAnchor?.placement ?? 'down'}
                  style={anchorStyle(menuAnchor)}
                >
                  {visible}
                </span>
              </>
            ) : null}
          </span>
        )
      }

      const head = pageHead()

      const tabs = tabStrip({
        active: tab,
        counts: {
          // Count what the tab lists: one list, so one number. It used to sum three
          // arrays (panel-owned globals, profile globals, panel-owned projects) because
          // the tiers were stored separately.
          mcp: profileRows.length,
          // Count what the tab actually lists: the panel's own skills plus the ones
          // discovered on disk (that is why it used to read 0 while cards showed). Both
          // halves are now cross-workspace, so the number matches the list on screen.
          skills: discoveredOnly.length,
        },
        onSelect: (next) => { setTab(next); setEditing(null); setExpanded('') },
      })

      /** One row holding the search and the project switch, like the reference page. */
      /**
       * The MCP "add" action, on the search row.
       *
       * It no longer needs a project to be selected first: the scope is chosen inside the
       * form. (It used to be disabled until a project was picked, because a project server
       * had nowhere to record its scope but the toolbar.)
       */
      const mcpAddButton = () => (
        <button
          className="smp-button" data-variant="primary" key="add" disabled={busy}
          onClick={() => {
            setEditing({ kind: "mcp", tier: "global", id: undefined })
            /**
             * A new server's form opens on the values that will actually be written.
             *
             * The reconnect numbers used to be blank with the default only in the placeholder
             * («500（默认）»), and the write path omitted the keys so the client supplied
             * them. That made the form read as "unset" while a real value was in force, and
             * the value lived in another package. Both halves now state them: the inputs are
             * prefilled and `connectionFields` writes them (see src/mcp/connection.js).
             *
             * `command` defaults to npx for the same reason — it is the overwhelmingly common
             * stdio executable, and typing it every time is friction with no decision behind it.
             */
            setDraft({
              transport: "streamable-http",
              command: HINTS.command,
              ...CONNECTION_DRAFT_DEFAULTS,
            })
            // The scope defaults to the session's own workspace when there is one — that is
            // almost always the one meant — and the form is where it gets changed. It used to
            // come from the toolbar's project selector, which no longer exists.
            setScopeDraft({ value: defaultWorkspace(), custom: false })
          }}
        >
          添加服务器
        </button>
      )

      /**
       * The skills "add" action, on the search row — the same slot MCP uses.
       *
       * No project is preselected from the toolbar any more: there is no toolbar project
       * switch (the list is cross-workspace now), so the dialog opens on a **global** root and
       * the region picker is where you choose. Picking a project region reveals the workspace
       * field, defaulted to the session's own workspace — that is almost always the one meant.
       */
      const skillsAddButton = () => (
        <button
          className="smp-button" data-variant="primary" key="add" disabled={busy}
          onClick={() => {
            setSkillError("")
            setSkillDraft({ name: "", description: "", body: "" })
            // Reset the in-flight markers. They are cleared by a matching receipt, so an op that
            // never got one (a cancel, a Host reload, a dropped request) used to leave the dialog
            // showing 「保存中…」 + 「正在与磁盘同步…」 the moment it opened — with nothing in flight.
            resetSkillPending()
            setSkillDialog({
              mode: "add", scope: "global", id: "dsh",
              // Remembered for when the tier is switched to 项目级: the workspace the user is
              // working in is almost always the one meant, but it is not preselected while the
              // destination is a user-level root.
              project: defaultWorkspace(), projectCustom: false, prevName: "",
            })
          }}
        >
          添加技能
        </button>
      )

      const filterRowView = filterRow({
        query,
        onQuery: setQuery,
        // Neither tab has a project switch: MCP never needed one (a server's scope is chosen in
        // its own form) and skills no longer do either (the list shows every workspace at once,
        // and a skill's workspace is chosen in the add dialog).
        placeholder: tab === 'mcp' ? '搜索名称' : '搜索技能名称',
        // Both tabs put their primary action on this row, in the same slot: the trigger and
        // the list it appends to stay on one screen. (MCP used to keep its form at the
        // bottom of the list while this button sat at the top, so the click looked inert.)
        actions: tab === 'mcp' ? mcpAddButton() : skillsAddButton(),
      })

      /**
       * The 「需要授权」block: what is happening, and the one action that can fix it.
       *
       * Rendered inside the expanded details rather than only as a tag: a tag alone leaves the
       * user with "需要授权" and no idea what to do, and the default assumption for a
       * non-connected server is "it is broken" — the exact misreading this status exists to
       * prevent. The Host's `detail` already says "这不是故障", so it is shown verbatim and
       * only the next step is added here.
       *
       * **Two different next steps**, decided by the Host's `oauthState.ready`:
       *
       *   · OAuth available → a 「授权」 button. Clicking it returns an authorization URL; the
       *     user opens it, logs in, and the callback lands on the Host's own port. This is
       *     the whole point of the feature.
       *   · OAuth unavailable → the old advice (add an `Authorization` header by hand), plus
       *     the Host's stated reason. Never a button that cannot work: a button that fails
       *     silently is worse than no button, because it looks like the user's fault.
       *
       * Deliberately still offers no 重连: reconnecting cannot supply a missing grant.
       */
      function needsAuthNote(serverName, tier, scope) {
        const item = statusFor(serverName, tier, scope)
        if (item?.status !== 'needs-auth') return null
        const why = String(item.detail ?? '') || '这台服务器要求先授权（OAuth）才能连接，这不是故障。'
        const ready = oauthState?.ready === true
        if (!ready) {
          const reason = String(oauthState?.detail ?? '')
          return (
            <p className="smp-note" key="needsAuth" style={{ marginTop: 6 }}>
              {`${why} OAuth 授权在这个 Host 上不可用${reason === '' ? '' : `（${reason}）`}，所以只能靠凭据补上：给这一行加一个 Authorization 请求头，或换成服务器提供的带 token 的地址。`}
            </p>
          )
        }
        const failure = oauthFailureFor(serverName)
        const pending = oauthPending === serverName
        const status = oauthServerState(serverName)
        return (
          <div className="smp-note" key="needsAuth" style={{ marginTop: 6 }}>
            <p style={{ margin: 0 }}>{why}</p>
            <div className="smp-oauthRow">
              <button
                className="smp-button" data-variant="primary" type="button" disabled={pending}
                onClick={() => void startOAuth(serverName)}
              >
                {/**
                 * 「授权」还是「重新授权」，由**磁盘上有没有凭据**决定，和菜单里那个
                 * 入口用同一个判据。
                 *
                 * 真机上这两处曾经各说各话：菜单说「重新授权」（因为凭据确实在），
                 * 正文按钮说「授权」（因为它只看连接状态）。同一个动作两个名字，用户
                 * 会以为按钮要重新走一遍全新的流程。
                 */}
                {pending ? '正在获取授权链接…' : status.present ? '重新授权' : '授权'}
              </button>
              {status.present && status.refreshable === true ? (
                <button
                  className="smp-button" type="button" disabled={pending}
                  onClick={() => void revokeOAuth(serverName)}
                >
                  清除凭据
                </button>
              ) : null}
            </div>
            {/**
               * 已经有凭据却仍然被要求授权 —— 说明**服务器不接受这份令牌**，而不是
               * 「还没授权」。这两种情况要分开说：前者重试没有意义，得重新授权或去
               * 检查服务器端的鉴权配置；后者才是点一下就好。
               */}
            {status.present === true && failure === '' ? (
              <p className="smp-note" style={{ margin: '4px 0 0' }}>
                {"已经保存了授权凭据，但这台服务器仍然拒绝了连接。可能是令牌被撤销、或服务器端的鉴权配置变了 —— 重新授权通常能解决；若反复失败，请检查服务器是否还要求其它的请求头。"}
              </p>
            ) : null}
            {failure === '' ? null : <p className="smp-note smp-oauthError" style={{ margin: '4px 0 0' }}>{failure}</p>}
            {authorizeUrlFor(serverName) === '' ? null : (
              <div className="smp-oauthLink">
                <p style={{ margin: '6px 0 2px' }}>在浏览器里打开这个链接完成登录，完成后回到这里：</p>
                <div className="smp-oauthLinkRow">
                  <input
                    className="smp-oauthUrl" readOnly
                    value={authorizeUrlFor(serverName)}
                    onFocus={(event) => event.target.select()}
                  />
                  <button className="smp-button" data-variant="outline" type="button" onClick={() => copyAuthorizeUrl(serverName)}>
                    {copiedUrlFor === serverName ? '已复制' : '复制链接'}
                  </button>
                </div>
                <p className="smp-note" style={{ margin: '2px 0 0' }}>
                  授权完成后如果状态没变，点一次「重连」让它重新建立连接。
                </p>
              </div>
            )}
          </div>
        )
      }

      /**
       * One skill card — the **same** card the MCP tab renders.
       *
       * `smp-cardRow` puts 「标题 + 描述」 in the left column and the actions in the right,
       * with the whole row vertically centred. The earlier skills card kept its actions
       * inside `smp-cardHead`, so they centred against the title line only and sat high in a
       * two-line card — visibly different from the MCP rows next to them on the same page.
       *
       * Actions are a `…` menu for the same reason the MCP rows use one: three inline
       * buttons per card made the action area wider than the name it belonged to. Only the
       * **enabled switch** stays inline, and a skill genuinely has that state
       * (`enabled: false` keeps the entry but stops writing it), so the control means
       * something here rather than being copied for looks.
       *
       * `pending` replaces the whole action group with a plain spinner + label, exactly like
       * an MCP row does while a write is in flight. Rendering it *inside* the delete button
       * (the earlier approach) kept that button's danger border visible, which read as a
       * stray pill around 「删除中…」.
       */
      function card(key, identity, description, enabled, details, menuItems, pending, statusNode, authNote) {
        const isOpen = expanded === key
        return (
          <li className="smp-card" key={key}>
            <div className="smp-cardRow" key="row">
              <div className="smp-cardMain" key="main">
                <div className="smp-cardHead" key="head">
                  <button
                    className="smp-cardToggle"
                    key="toggle"
                    aria-expanded={isOpen}
                    onClick={() => setExpanded(isOpen ? '' : key)}
                  >
                    <Chevron key="c" open={isOpen} />
                    <span className="smp-cardIdentity" key="id">{identity}</span>
                  </button>
                  <span className="smp-cardEnd" key="end">
                    {/* 停用时状态整组不渲染：一个已停用的条目没有状态可报，留一个过期的
                        标签会撒谎。「已停用」本身就由右边的开关表达。 */}
                    {enabled === false ? null : statusNode ?? null}
                  </span>
                </div>
                {description ? <div className="smp-cardDescription" key="desc">{description}</div> : null}
              </div>
              {pending ? (
                <span className="smp-cardActions" key="pending">
                  <span className="smp-pending" key="p">
                    <span className="smp-spinner" key="s" />{pending}
                  </span>
                </span>
              ) : (
                <span className="smp-cardActions" key="actions">

                  {moreMenu({ entryId: key }, menuItems)}
                </span>
              )}
            </div>
            {isOpen ? (
              <div className="smp-cardDetails" key="details">
                <div className="smp-details" key="grid">{detailNodes(details, 'k')}</div>
                {authNote ?? null}
                {error ? <div className="smp-error" key="err" style={{ marginTop: 8 }}>{error}</div> : null}
              </div>
            ) : null}
          </li>
        )
      }

      /** Read-only row for an MCP entry the profile itself configures. */
      /**
       * One card for a configured row — used by **both** tabs.
       *
       * `tier` exists only to name the tab it belongs to (and therefore which form and
       * which status scope to use); the row, the actions and the tool list are identical,
       * because both tiers are now the same kind of thing. The project tab used to render
       * from the plugin's own `config.servers` with a second card implementation, which is
       * how the two drifted apart.
       */
      function profileCard(row, tier = 'global') {
        const isGlobalTier = tier === 'global'
        const rowKey = `profile:${row.entryId}`
        const rowOpen = expanded === rowKey
        const rowStatusScope = isGlobalTier ? '' : (row.scope ?? '')
        // Edit in place: the row itself turns into the form.
        if (editing?.kind === 'mcp' && editing.tier === tier && editing.id === row.entryId) {
          return serverForm({ tier, scope: row.scope ?? 'global' })
        }
        /**
         * Whether to show the spinner.
         *
         * `confirmed` means the Host has already answered this command, so there is nothing
         * left to wait for: the write is done, and a spinner would misreport that as "still
         * working". The entry itself survives until the projection lists the row (an optimistic
         * add keeps rendering its own values); only the spinner goes.
         *
         * A command sent through the settings-queue fallback is never marked confirmed — its
         * write really is still pending until the Host drains the queue, so it keeps spinning.
         */
        const inflightInfo = inflight[inflightKeyForRow(row.entryId)]
        // A toggle's optimistic feedback is the switch itself. Hiding it behind a spinner
        // (as add/update/delete do) removes exactly the control that should visibly move,
        // and the test that clicks it looks for the switch right after the click.
        const spinning = inflightInfo !== undefined && inflightInfo.confirmed !== true && inflightInfo.kind !== 'toggle'
        const pending = pendingOf(row.entryId) !== null || spinning
        const reconnect = reconnectAction(row.serverName, tier, rowStatusScope)
        // 只有「启用中**且**确实异常」才给重连：停用的服务器没有连接可重建，
        // 而连接正常时重连只是一个会打断它的按钮。这两个条件都由 reconnectAction
        // 的 null 返回表达，所以这里只需要判它有没有。
        /**
         * OAuth 授权入口放在 `…` 菜单里。
         *
         * 之前它是卡片正文里的一颗按钮，只在状态恰好是「需要授权」时出现 —— 于是这台服务器
         * 一旦被判定成别的状态（或用户想重新授权、想提前换一个账号），入口就消失了。
         * 菜单是「对这台服务器能做什么」的固定清单，授权属于那一类：**一直在这里**，
         * 能不能用由服务器类型决定，而不是由某一刻的状态决定。
         *
         * 只在 OAuth 通道真的可用、且是 http 传输时才出现：一个点了只会失败的项目
         * 比没有更糟（与 filterState/probeState 的 reason 是同一条规矩）。
         */
        /**
         * 「授权 / 重新授权」什么时候该出现。
         *
         * 它不是「永远有用」的：一台**已经连上、又没有存过凭据**的服务器，已经用事实
         * 证明它不需要授权（context7 这类公开端点就是如此）。此时菜单里的「授权」不是
         * 能力清单的一部分，而是一个会把人带进 OAuth 弹窗的噪音 —— 点下去只会失败。
         *
         * 所以只在真有用的时候出现：
         *   · 存过凭据但没连上 → 「重新授权」（十有八九就是凭据坏了）；
         *   · 没存过凭据，且状态未知 → 「授权」（可能还没探到，给一个入口）；
         *   · 没存过凭据，但状态是「需要授权」 → 「授权」（唯一正确的下一步）；
         *   · 已连接 → 不出现（无论有没有凭据）；
         *   · 其它失败状态（重试中/已放弃）→ 不出现，那不是授权能治的。
         *
         * 想给一台公开服务器换账号的用户仍然有路：先「清除凭据」（正文注记里），
         * 状态回到未知后「授权」会重新出现。
         */
        const oauthCredentials = oauthServerState(row.serverName)
        const oauthRowStatus = statusFor(row.serverName, tier, rowStatusScope)
        const oauthWorthOffering = oauthCredentials.present === true
          ? oauthRowStatus?.status !== 'connected'
          : (oauthRowStatus === null || oauthRowStatus.status === 'needs-auth')
        const oauthMenuItem = oauthState?.ready === true && row.transport === 'streamable-http' && oauthWorthOffering ? (
          <button
            className="smp-menuItem" key="oauth" disabled={busy || oauthPending !== ''}
            onClick={() => {
              setMenuFor('')
              // `startOAuth` 会让 Host 直接拉起系统浏览器，用户不需要复制链接。
              void startOAuth(row.serverName)
            }}
          >
            {oauthPending === row.serverName
              ? '正在获取授权链接…'
              : oauthServerState(row.serverName).present
                ? '重新授权'
                : '授权'}
          </button>
        ) : null
        const menuItems = [
          reconnect === null ? null : reconnect.node,
          oauthMenuItem,
          <button
            className="smp-menuItem" key="edit" disabled={busy}
            onClick={() => {
              setMenuFor('')
              // `original` is kept so the save can tell "the user cleared
              // this field" from "the form never showed it" (an older Host
              // does not project the connection fields at all).
              setEditing({ kind: "mcp", tier, profile: row.entryId, id: row.entryId, original: row })
              setDraft(draftFromRow(row))
              // Prefill the scope picker from the row, and treat a path outside the
              // known workspaces as "custom" so it stays visible and editable.
              const rowScope = row.scope && row.scope !== 'global' ? row.scope : ''
              setScopeDraft({
                value: rowScope,
                custom: rowScope !== '' && !projectChoices.some(([path]) => path === rowScope),
              })
            }}
          >
            编辑
          </button>,
          <button
            className="smp-menuItem" data-variant="danger" key="del" disabled={busy}
            onClick={() => {
              setMenuFor('')
              const run = () => {
                setInflight((m) => ({ ...m, [inflightKeyForRow(row.entryId)]: { kind: "delete", at: Date.now() } }))
                commandRowOp(deleteServerOp(row.entryId), row.entryId)
              }
              if (primitives?.Modal === undefined) {
                if (window.confirm(`删除「${row.serverName || row.entryId}」？`)) run()
                return
              }
              setDeleteDialog({
                label: row.serverName || row.entryId,
                note: "会从 cordis.patch.yml 里移除这一行（写入前自动备份）。",
                // Row ops report progress on the row itself (spinner + label),
                // so this dialog closes immediately on confirm.
                closeOnConfirm: true,
                run,
              })
            }}
          >
            删除
          </button>,
          reconnect?.failure ? (
            <span className="smp-menuError" key="reconnectError">{reconnect.failure}</span>
          ) : null,
        ]
        return (
          <li className="smp-card" key={`profile:${row.entryId}`}>
            <div className="smp-cardRow" key="row">
            <div className="smp-cardMain" key="main">
            <div className="smp-cardHead" key="head">
              <button
                className="smp-cardToggle" key="toggle" aria-expanded={rowOpen}
                onClick={() => setExpanded(rowOpen ? "" : rowKey)}
              >
                <Chevron key="c" open={rowOpen} />
                <span className="smp-cardIdentity" key="name">
                  {row.serverName || row.entryId}
                  {/* 作用域跟着名字走：它描述的是「这台服务器是谁的」，与右边的运行状态
                      （连没连上）是两件事。
                      全局行也带标签：列表现在跨工作区混排，一个没标签的卡片会让人以为
                      「它没有归属」，而事实是「它属于所有工作区」。两个页签用同一套词表
                      （全局 / 工作区名），所以 MCP 与 Skills 的卡片读起来一致。 */}
                  <span className="smp-tag" data-tone="neutral" key="scope">{scopeTagLabel(row.scope)}</span>
                </span>
              </button>
              <span className="smp-cardEnd" key="end">
                {/* 停用时状态圆点整组不渲染：没有连接可报告，留着过期的绿点会撒谎。
                    关掉这件事本身由右边的开关表达（灰点 + 「已关闭」是同一个意思，
                    两个都画只是重复）。 */}
                {row.enabled === false ? null : statusDot(row.serverName, tier, rowStatusScope)}
              </span>
            </div>
            <div className="smp-cardDescription" key="desc">
              {row.target
                ? `${row.transport || "streamable-http"} · ${row.target}`
                : `${String(row.entryId).replace(/^include:/, "")}${row.phase ? ` · ${row.phase}` : ""}`}
            </div>
            </div>
            {/*
              操作区是**右列**，与「标题 + 描述」这一整列垂直居中对齐。
              它以前嵌在 cardHead 内部，于是只能跟标题那一行居中——而卡片有两行，
              结果就是偏上，与宿主设置页的分组行（左标题右控件、整行居中）不一致。
            */}
            {pending ? (
              <span className="smp-cardActions" key="pending">
                <span className="smp-pending" key="p">
                  <span className="smp-spinner" key="s" />
                  {pendingLabel(inflight[inflightKeyForRow(row.entryId)] ?? { kind: pendingOf(row.entryId)?.op })}
                </span>
              </span>
            ) : rowOpsReady ? (
              <span className="smp-cardActions" key="actions">
                {enabledSwitch(row)}
                {moreMenu(row, menuItems)}
              </span>
            ) : null}
          </div>
            {rowOpen ? (
              <div className="smp-cardDetails" key="details">
                <div className="smp-details" key="grid">{detailNodes(rowDetailPairs(row))}</div>
                {toolListNode(toolsForServer(serverTools, row.serverName, serverToolsError), `tools-${row.entryId}`, {
                  ...filterFor(row.serverName),
                  leafOf: leafOf(row.serverName),
                  onMode: (mode) => {
                    // Entering a mode with nothing selected would leave the server
                    // either fully open (`allow`) or untouched (`deny`); the Host
                    // treats an empty allow rule as "not configured" for that reason.
                    const current = filterFor(row.serverName)
                    void writeFilter(row.serverName, { mode, tools: current.tools })
                  },
                  onToggle: (leaf, checked) => {
                    const current = filterFor(row.serverName)
                    const next = checked
                      ? [...new Set([...current.tools, leaf])]
                      : current.tools.filter((name) => name !== leaf)
                    void writeFilter(row.serverName, { mode: current.mode, tools: next })
                  },
                })}
                {/* Filtering that silently is not running must say so: "off" and
                    "could not be installed" look identical in the UI otherwise, and
                    only one of them is the user's own configuration. */}
                {filterState.installed !== true ? (
                  <p className="smp-note" key="filterOff" style={{ marginTop: 6 }}>
                    {`工具过滤当前未生效${filterState.reason ? `：${filterState.reason}` : ''}——勾选会被保存，但要等它可用后才会真正挡住工具。`}
                  </p>
                ) : null}
                {/* 「需要授权」必须给出下一步做什么。只标一个标签会让人以为服务器坏了，
                    而这恰恰是这个状态要避免的误解——它不是故障，是一次等待用户完成的授权。
                    用这张卡片自己的 tier/scope：合并成一个列表后，全局行与项目行都可能
                    出现「需要授权」，写死 'global' 会让项目行永远取不到自己的那条状态。 */}
                {needsAuthNote(row.serverName, tier, rowStatusScope)}
                {/* A tool already in the registry cannot be unregistered by this
                    plugin, so a rule turned on now only takes full effect once the
                    server re-registers its tools. The concrete way to force that is
                    this card's own 停用/启用: disabling disposes the mcp-client fiber,
                    which unregisters its tools, and enabling re-mounts it and re-runs
                    `syncTools` — every tool goes back through the shadow. Saying *how*
                    is the difference between a feature and a silent no-op. */}
                {filterState.installed === true && filterFor(row.serverName).mode !== 'off' ? (
                  <p className="smp-note" key="filterSync" style={{ marginTop: 6 }}>
                    改动会在该服务器重新注册工具时完全生效。想立刻看到效果：把这张卡片「停用」再「启用」（几秒即可），或重启 DSH——插件无法注销别的插件已经注册的工具，而「停用」会连带注销它的工具。
                  </p>
                ) : null}
                {filterState.installed === true && Array.isArray(filterState.preExisting) && filterState.preExisting.length > 0 ? (
                  <p className="smp-note" key="filterLate" style={{ marginTop: 6 }}>
                    {`有 ${filterState.preExisting.length} 个 MCP 工具在过滤生效前就已注册，它们无法再被挡下（重启 DSH 后会彻底生效）。`}
                  </p>
                ) : null}
              </div>
            ) : null}
          </li>
        )
      }

      /** Import sources the Host can scan (ids must match the Host table). */

      /**
       * Explicit import. `scope: 'global'` reads a tool's user-level file and
       * writes profile rows; `'project'` reads the selected workspace and writes
       * panel project entries.
       */
      const importCard = (scope) => {
        const target = scope === 'global' ? '' : importProject
        const raw = importScan
        const result = raw !== null && typeof raw === 'object' && raw.scope === scope
          && (scope === 'global' || raw.project === target) ? raw : null
        const needsProject = scope === 'project' && target === ''
        // Import never overwrites: names already managed for this scope are skipped.
        const takenNames = takenNamesOf({ scope, target, profileRows })
        const { fresh: freshServers, skipped: skippedServers } = splitImport(result?.servers ?? [], takenNames)
        if (!importOpen) {
          return (
            <li className="smp-card" key="import">
              <div className="smp-cardHead" key="head">
                <span className="smp-cardIdentity" key="t">{scope === "global" ? "导入 MCP" : "导入 MCP"}</span>
                <span className="smp-cardActions" key="a">
                  <button
                    className="smp-button" data-variant="outline" key="go" disabled={busy}
                    onClick={() => setImportOpen(true)}
                  >
                    选择来源
                  </button>
                </span>
              </div>
              <div className="smp-cardDescription" key="d">
                {scope === "global"
                  ? "从其他编辑器/CLI 的用户级配置文件导入（写成配置文件行）。"
                  : "从其他编辑器/CLI 的项目级文件导入到面板的项目条目。"}
              </div>
            </li>
          )
        }
        return (
          <li className="smp-card" key="import">
            <div className="smp-cardHead" key="head">
              <span className="smp-cardIdentity" key="t">{scope === "global" ? "导入全局 MCP" : "导入项目 MCP"}</span>
              <span className="smp-cardActions" key="a">
                <button className="smp-button" data-variant="outline" key="close" onClick={() => setImportOpen(false)}>收起</button>
              </span>
            </div>
            <div className="smp-segment" key="segment">
              <button key="g" data-active={String(scope === "global")} onClick={() => setImportScope("global")}>全局</button>
              <button key="p" data-active={String(scope === "project")} onClick={() => setImportScope("project")}>项目级</button>
            </div>
            <div className="smp-formGrid" key="grid">
              {field("来源", (
                <select className="smp-select" value={importSource} onChange={(event) => setImportSource(event.target.value)}>
                  {IMPORT_CHOICES.map(([id, label]) => <option value={id} key={id}>{label}</option>)}
                </select>
              ))}
              {scope === "global" ? null : importCustomProject ? field("项目路径", (
                <div className="smp-actionsRow" style={{ marginTop: 0 }}>
                  <input
                    className="smp-input" placeholder="项目绝对路径" style={{ flex: "1 1 auto" }}
                    value={importProject} onChange={(event) => setImportProject(event.target.value)}
                  />
                  <button className="smp-button" data-variant="outline" key="back" onClick={() => setImportCustomProject(false)}>选工作区</button>
                </div>
              )) : field("项目", (
                <div className="smp-actionsRow" style={{ marginTop: 0 }}>
                  <select
                    className="smp-select" value={importProject} style={{ flex: "1 1 auto" }}
                    onChange={(event) => {
                      if (event.target.value === "__custom__") { setImportCustomProject(true); return }
                      setImportProject(event.target.value)
                    }}
                  >
                    <option value="" key="none">选择一个工作区…</option>
                    {projectChoices.map(([path, title]) => <option value={path} key={path}>{title}</option>)}
                    <option value="__custom__" key="custom">自定义路径…</option>
                  </select>
                  {importProject !== "" ? (
                    <button className="smp-button" data-variant="outline" key="clear" onClick={() => setImportProject("")}>清除</button>
                  ) : null}
                </div>
              ))}
            </div>
            {needsProject ? (
              <div className="smp-cardDescription" key="need">先选择一个工作区（或切到「全局」读用户级配置）。</div>
            ) : result === null ? (
              <div className="smp-cardDescription" key="hint">点「扫描」后，会把该工具在项目里的 MCP 文件与能导入的条目列出来。</div>
            ) : (
              <div key="result">
                {result.files.map((file) => (
                  <div className="smp-cardDescription" key={file.path}>
                    {`${file.exists ? "✓" : "✗"} ${file.path}${file.exists ? ` · 识别 ${file.servers.length} 个${file.unsupported > 0 ? `（${file.unsupported} 个形态不支持）` : ""}` : " · 文件不存在"}${file.error !== null && file.error !== "" ? ` · ${file.error}` : ""}`}
                  </div>
                ))}
                {result.error !== null && result.error !== "" ? <div className="smp-error" key="err">{result.error}</div> : null}
                <div className="smp-cardDescription" key="sum">
                  {`新增 ${freshServers.length} 个：${freshServers.map((server) => server.serverName).join("、") || "—"}`}
                </div>
                {skippedServers.length > 0 ? (
                  <div className="smp-cardDescription" key="skip">
                    {`已存在 ${skippedServers.length} 个（跳过，不覆盖）：${skippedServers.map((server) => server.serverName).join("、")}`}
                  </div>
                ) : null}
              </div>
            )}
            <div className="smp-actionsRow" key="actions">
              <button
                className="smp-button" data-variant="primary" key="scan"
                disabled={busy || (scope === "project" && target === "")}
                onClick={() => {
                  setBusy(true)
                  setError("")
                  void scanImport({ source: importSource, scope, project: target }).then((payload) => {
                    setImportScan(payload)
                    setBusy(false)
                    if (payload?.ok !== true) setError(String(payload?.error ?? "扫描失败"))
                  })
                }}
              >
                扫描
              </button>
              {result !== null && freshServers.length > 0 ? (
                <button
                  className="smp-button" data-variant="outline" key="do"
                  onClick={() => {
                    const wantedScope = scope === "global" ? "global" : target
                    const existing = new Set(profileRows
                      .filter((row) => (row.scope ?? 'global') === wantedScope)
                      .map((row) => row.serverName))
                    for (const server of result.servers) {
                      if (existing.has(server.serverName)) continue
                      void sendRowOp(addServerOp({
                        serverName: server.serverName,
                        transport: server.transport,
                        url: server.transport === "stdio" ? "" : server.url,
                        command: server.transport === "stdio" ? server.command : "",
                        args: server.transport === "stdio" ? (server.args ?? []).join(" ") : "",
                        env: server.env ?? "", headers: server.headers ?? "",
                        scope: scope === "global" ? "" : target,
                        scopeChanged: scope !== "global",
                      })).then((outcome) => { if (!outcome.ok) setError(outcome.reason) })
                    }
                    setImportScan(null)
                  }}
                >
                  {importLabel({ scope, fresh: freshServers.length, skipped: skippedServers.length })}
                </button>
              ) : null}
            </div>
          </li>
        )
      }

      function serverForm(tier) {
        if (!editing || editing.kind !== "mcp" || editing.tier !== tier.tier) return null
        const scope = tier.scope
        const profileEntry = typeof editing.profile === "string" && editing.profile !== "" ? editing.profile : null
        const stdio = (draft.transport ?? "streamable-http") === "stdio"
        return (
          <li className="smp-card" key="form" data-wide="true">
            <div className="smp-cardDetails" key="body">
              <div className="smp-formGrid" key="grid">
                {field("名称（serverName）", (
                  <input
                    className="smp-input"
                    placeholder="例如 test，最多 32 字符"
                    value={draft.serverName ?? ""}
                    onChange={(e) => setDraft({ ...draft, serverName: e.target.value })}
                  />
                ))}
                {field("传输", (
                  <select
                    className="smp-select"
                    value={draft.transport ?? "streamable-http"}
                    onChange={(e) => {
                      const transport = e.target.value
                      // Switching to stdio prefills `npx` **only when the field is still empty**:
                      // a value the user typed (or one loaded from a row being edited) must not
                      // be overwritten by a convenience default.
                      const blank = String(draft.command ?? '').trim() === ''
                      setDraft({
                        ...draft,
                        transport,
                        ...(transport === 'stdio' && blank ? { command: HINTS.command } : {}),
                      })
                    }}
                  >
                    <option value="streamable-http" key="h">streamable-http</option>
                    <option value="stdio" key="s">stdio</option>
                  </select>
                ))}
                {/*
                  The scope picker, moved here from the toolbar.
                  It used to *filter* the list by project, which only made sense while the
                  project tier was a separate list of separately-stored entries. Now a
                  server's scope is simply a property of that server, so the choice belongs
                  where the server is created — and the same workspace list is reused.
                */}
                {field("作用域（哪个工作区可用）", (
                  <div className="smp-scopePick" key="scope">
                    <select
                      className="smp-select"
                      key="sel"
                      value={scopeDraft.custom ? "__custom__" : (scopeDraft.value || "global")}
                      onChange={(e) => {
                        const value = e.target.value
                        if (value === "__custom__") { setScopeDraft({ value: '', custom: true }); return }
                        setScopeDraft({ value: value === 'global' ? '' : value, custom: false })
                      }}
                    >
                      <option value="global" key="g">全局 —— 所有工作区都能用</option>
                      {projectChoices.map(([path, title]) => <option value={path} key={path}>{title}</option>)}
                      <option value="__custom__" key="c">自定义路径…</option>
                    </select>
                    {scopeDraft.custom ? (
                      <input
                        className="smp-input" key="custom"
                        placeholder="项目绝对路径"
                        value={scopeDraft.value}
                        onChange={(e) => setScopeDraft({ ...scopeDraft, value: e.target.value })}
                      />
                    ) : null}
                  </div>
                ))}
                {stdio
                  ? field("命令", (
                      <input
                        className="smp-input" placeholder={HINTS.command}
                        value={draft.command ?? ""}
                        onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                      />
                    ))
                  : field("URL", (
                      <input
                        className="smp-input" placeholder={HINTS.url}
                        value={draft.url ?? ""}
                        onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                      />
                    ))}
                {/* http 的鉴权头：host 端按 KEY=VALUE 解析（parseEnv），所以提示也用等号。
                    此前这个字段只在 form.js 里声明、从未渲染，等于没有写入入口。 */}
                {stdio
                  ? null
                  : field("请求头（KEY=VALUE，每行一个）", (
                      <textarea
                        className="smp-textarea" rows={3} placeholder={HINTS.headers}
                        value={draft.headers ?? ""}
                        onChange={(e) => setDraft({ ...draft, headers: e.target.value })}
                      />
                    ), true)}
                {stdio
                  ? field("参数（空格分隔）", (
                      <input
                        className="smp-input" placeholder={HINTS.args}
                        value={draft.args ?? ""}
                        onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                      />
                    ))
                  : null}
                {stdio && tier.tier !== "global"
                  ? field("运行时", (
                      <select
                        className="smp-select"
                        value={draft.runtime ?? "auto"}
                        onChange={(e) => setDraft({ ...draft, runtime: e.target.value })}
                      >
                        <option value="auto" key="auto">跟随 Harness（自带 node + pnpx，推荐）</option>
                        <option value="system" key="system">系统 npx（个别老包不兼容 pnpm）</option>
                      </select>
                    ))
                  : null}
                {stdio
                  ? field("环境变量（KEY=VALUE，每行一个）", (
                      <div className="smp-envField" key="env">
                        <textarea
                          className="smp-textarea" rows={3} placeholder={HINTS.env}
                          value={draft.env ?? ""}
                          onChange={(e) => setDraft({ ...draft, env: e.target.value })}
                        />
                        {/* 全局 stdio 行会被注入一条 PATH（让 npx/node 能被找到）。
                            它确实属于这一行，所以如实回填、不隐藏；但要讲清楚它是自动的，
                            否则用户会以为是自己配的，删掉就会让 stdio 服务器起不来。 */}
                        {hasInjectedPath(draft.env) ? (
                          <p className="smp-note" key="pathNote">
                            其中的 <code>PATH</code> 是 DSH 自动注入的（跟随系统 PATH，让 <code>npx</code>/<code>node</code> 能被找到）——保持原样即可，删掉会让这个 stdio 服务器启动失败。
                          </p>
                        ) : null}
                      </div>
                    ), true)
                  : null}
                {/* 连接策略：直接落进 MCP 客户端的 failOnStartupError / reconnect.*。

                    标题原来是「连接与重连（留空 = 用 DSH 默认值）」，但现在：
                      · 这个字段里只有一个开关，没有可「留空」的东西；
                      · 下面三个重连数字**预填了真实默认值**，也不再靠留空表达默认。
                    一条让用户去找输入框的提示，旁边却没有输入框，比不写还糟。

                    两个开关都用宿主自己的 `Switch`（与卡片上的启用开关同一个组件）：
                    布尔设置用开关比用勾选框更符合这个设置页的语言，而且开关同时说明
                    「现在是哪一档」，勾选框只说明「点了会怎样」。 */}
                {field("连接失败处理", (
                  <div className="smp-switchRow" key="fail">
                    <span className="smp-switchRowText">
                      {"连不上时拒绝激活（failOnStartupError）"}
                      <span className="smp-switchRowHint">默认关闭</span>
                    </span>
                    <span className="smp-switchSlot" key="slot">
                      {switchControl(
                        draft.failOnStartupError === true,
                        (next) => setDraft({ ...draft, failOnStartupError: next }),
                        "连不上时拒绝激活（failOnStartupError）",
                      )}
                    </span>
                  </div>
                ), true)}
                {/* 两个开关分属不同概念（连接策略 / OAuth 安全），中间要有一条横线。
                    没有它时两块文字挨在一起，读起来像一个开关组里的两行，而不是两项
                    各自独立的设置。`role="separator"` 让读屏也念出这是一处分隔。 */}
                <div className="smp-divider" role="separator" aria-orientation="horizontal" key="divider" />
                {/* 明文 token 端点的例外。**默认关闭**，而且刻意放在表单最下方、
                    紧挨着连接设置：它是个安全降级，不该出现在显眼位置让人顺手打开。
                    文案必须说清后果 —— 用户开它的时候要知道凭据会明文过网。 */}
                {field("内网 OAuth（仅 http 授权服务器）", (
                  <div className="smp-switchRow" key="allowInsecure">
                    <span className="smp-switchRowText">
                      {"允许明文 token 端点"}
                      <span className="smp-switchRowHint">
                        {"仅当授权服务器没有 TLS 时打开；开启后 access_token / refresh_token 会以明文发到内网，同网段可被嗅探"}
                      </span>
                    </span>
                    <span className="smp-switchSlot" key="slot">
                      {switchControl(
                        draft.allowInsecureTokenEndpoint === true,
                        (next) => setDraft({ ...draft, allowInsecureTokenEndpoint: next }),
                        "允许明文 token 端点",
                      )}
                    </span>
                  </div>
                ), true)}
                {field("工具调用超时（ms）", (
                  <input
                    className="smp-input" type="number" min={1} step={1}
                    placeholder={String(CONNECTION_DRAFT_DEFAULTS.toolCallTimeoutMs)}
                    value={draft.toolCallTimeoutMs ?? ""}
                    onChange={(e) => setDraft({ ...draft, toolCallTimeoutMs: e.target.value })}
                  />
                ))}
                {field("重连首次延迟（ms）", (
                  <input
                    className="smp-input" type="number" min={1} step={1} placeholder={String(CONNECTION_DRAFT_DEFAULTS.reconnectInitialDelayMs)}
                    value={draft.reconnectInitialDelayMs ?? ""}
                    onChange={(e) => setDraft({ ...draft, reconnectInitialDelayMs: e.target.value })}
                  />
                ))}
                {field("重连最大延迟（ms）", (
                  <input
                    className="smp-input" type="number" min={1} step={1} placeholder={String(CONNECTION_DRAFT_DEFAULTS.reconnectMaxDelayMs)}
                    value={draft.reconnectMaxDelayMs ?? ""}
                    onChange={(e) => setDraft({ ...draft, reconnectMaxDelayMs: e.target.value })}
                  />
                ))}
                {field("重连最大次数", (
                  <input
                    className="smp-input" type="number" min={1} step={1} placeholder={String(CONNECTION_DRAFT_DEFAULTS.reconnectMaxAttempts)}
                    value={draft.reconnectMaxAttempts ?? ""}
                    onChange={(e) => setDraft({ ...draft, reconnectMaxAttempts: e.target.value })}
                  />
                ))}
              </div>
              {error ? <div className="smp-error" key="err" style={{ marginTop: 8 }}>{error}</div> : null}
              {profileEntry !== null ? (
                <p className="smp-note" key="note" style={{ marginTop: 8 }}>
                  {`改的是配置文件行 ${profileEntry.replace(/^include:/, "")}，Host 会写回 profile patch（自动备份）。`}
                </p>
              ) : null}
              <div className="smp-actionsRow" key="actions">
                <button
                  className="smp-button" data-variant="primary" key="save"
                  disabled={busy || !draft.serverName}
                  onClick={() => {
                    const transport = draft.transport ?? "streamable-http"
                    const argList = String(draft.args ?? "").trim() === "" ? [] : String(draft.args).trim().split(/\s+/)
                    if (profileEntry !== null) {
                      // Edit the row in place: the Host rewrites the profile patch.
                      setInflight((m) => ({ ...m, [inflightKeyForRow(profileEntry)]: { kind: "update", at: Date.now(), expectName: draft.serverName ?? "" } }))
                      commandRowOp(updateServerOp(profileEntry, {
                        ...draft,
                        serverName: draft.serverName ?? "", transport,
                        url: transport === "stdio" ? "" : (draft.url ?? ""),
                        command: transport === "stdio" ? (draft.command ?? "") : "",
                        args: transport === "stdio" ? String(draft.args ?? "") : "",
                        env: transport === "stdio" ? String(draft.env ?? "") : "",
                        headers: transport === "stdio" ? "" : String(draft.headers ?? ""),
                      }, editing.original), profileEntry)
                    } else {
                      // Every new server becomes a real profile row — global or project.
                      // The only difference is `scope`, which the op carries; the Host
                      // writes it through the same lock + backup + validation path.
                      // The scope is recorded with the in-flight marker, not just sent in
                      // the op: the Host clears `rowOps` before it writes the patch, so by
                      // the time the row lands the op is gone and only this map still knows
                      // which workspace group the card belongs to.
                      //
                      // `draft` rides along so the card can be drawn **now**, from exactly the
                      // values being written, instead of showing a spinner for the round-trip.
                      const optimisticKey = inflightKeyForRow(rowEntryId(draft.serverName))
                      setInflight((m) => ({
                        ...m,
                        [optimisticKey]: {
                          kind: "add", at: Date.now(), scope: scopeDraft.value,
                          draft: { ...draft, transport },
                        },
                      }))
                      commandRowOp(addServerOp({
                        ...draft,
                        serverName: draft.serverName ?? "", transport,
                        url: transport === "stdio" ? "" : (draft.url ?? ""),
                        command: transport === "stdio" ? (draft.command ?? "") : "",
                        args: transport === "stdio" ? String(draft.args ?? "") : "",
                        env: transport === "stdio" ? String(draft.env ?? "") : "",
                        headers: transport === "stdio" ? "" : String(draft.headers ?? ""),
                        // The scope comes from the form's own picker: it is a property of
                        // this server, not of whatever the toolbar happened to be showing.
                        scope: scopeDraft.value,
                        scopeChanged: true,
                      }), optimisticKey)
                    }
                    setEditing(null)
                  }}
                >
                  {profileEntry !== null ? "保存到配置行" : "保存"}
                </button>
                <button className="smp-button" data-variant="outline" key="cancel" onClick={() => setEditing(null)}>
                  取消
                </button>
              </div>
            </div>
          </li>
        )
      }

      /**
       * The `…` menu for a **discovered** skill (on disk, not in this panel's config).
       *
       * 预览/编辑/删除 act on the file the Host scanned; there is no config entry to remove,
       * which is why 删除 opens the confirm dialog with the backup wording rather than
       * dropping a `config.skills[]` row.
       */
      function diskSkillMenuItems(skill) {
        return [
          <button
            className="smp-menuItem" key="view" disabled={busy || skillPendingPath === skill.path}
            onClick={() => { setMenuFor(''); openPreview(skill) }}
          >
            预览
          </button>,
          <button
            className="smp-menuItem" key="edit" disabled={busy || skillPendingPath === skill.path}
            onClick={() => {
              setMenuFor('')
              const parts = String(skill.source).split("-")
              const scope = parts[0] === "project" ? "project" : "global"
              const id = parts[1] === "dsh" ? "dsh" : "agents"
              setSkillError("")
              setSkillDraft({ name: skill.name, description: skill.description ?? "", body: skill.body ?? "" })
              resetSkillPending()
              setSkillDialog({
                mode: "edit", scope, id, project: skill.scope === "global" ? "" : skill.scope,
                projectCustom: false, prevName: skill.name, path: skill.path ?? "",
              })
              loadSkillBody(skill)
            }}
          >
            编辑
          </button>,
          <button
            className="smp-menuItem" data-variant="danger" key="del" disabled={busy || skillPendingPath === skill.path}
            onClick={() => { setMenuFor(''); confirmDeleteSkill(skill) }}
          >
            删除
          </button>,
        ]
      }

      /**
       * Global MCP entries live in the profile patch as ordinary
       * `@deepseek-ai/dsh-mcp-client` rows — the same place the shipped rows live —
       * so this tier simply lists (and edits) those rows.
       */
      const pendingAdds = pendingAddsOf(inflight, profileRows)

      /**
       * The skills list — one list, grouped by scope in workspace order.
       *
       * Deliberately the same shape as the MCP list: 全局 first, then the workspaces in
       * registry order, then scopes the registry does not know. Two differences remain, and
       * both are about *data*, not layout:
       *
       *   · a skill is written to a **different directory per scope** (a server is not), so
       *     the 区域 picker survives in the dialog;
       *   · a skill can sit on disk **without** being in the panel's config (DSH's own
       *     roots), which is why a card is either "managed" (has config, gets a switch) or
       *     "discovered" (disk only, no switch — there is nothing to toggle).
       *
       * Grouping carries no heading of its own: the card states its own scope, exactly as on
       * the MCP tab, and a second layer of titles would only repeat it.
       */
      /**
       * Every skill, grouped by workspace in registry order — the same shape as the MCP list.
       *
       * A skill is a file; there is exactly one kind of entry now, so the card has no
       * "managed vs discovered" branch and no enable switch.
       */
      const skillGroups = orderedScopeGroups(
        discoveredOnly.map((skill) => ({ skill, scope: skill.scope ?? 'global' })),
        workspacePaths,
      )

      const skillCard = ({ skill }) => {
        const scopeValue = skill.scope ?? 'global'
        const rootId = rootIdOfSource(skill.source)
        const key = `disk:${skill.path}`
        const pending = skillPendingPath === skill.path ? '删除中…' : null
        const identity = [
          <span key="n">{skill.name}</span>,
          <span className="smp-tag" data-tone="neutral" key="scope">{scopeTagLabel(scopeValue)}</span>,
        ]
        return card(
          key,
          identity,
          skill.description || "(无描述)",
          undefined,
          [["来源", skill.source], ["路径", skill.path]],
          diskSkillMenuItems(skill),
          pending,
        )
      }

      const skillsList = (
        <ul className="smp-cards" key="cards">
          {skillGroups.map((group) => group.items.map((entry) => skillCard(entry)))}
          {skillGroups.length === 0 ? (
            <li className="smp-empty" key="empty" style={{ gridColumn: "1 / -1" }}>
              {emptySkillText('')}
            </li>
          ) : null}
        </ul>
      )

      /** Removing a skill from disk is destructive-ish: confirm first (a backup is kept). */
      const confirmDeleteSkill = (skill) => {
        const parts = String(skill.source ?? "").split("-")
        const scope = parts[0] === "project" ? "project" : "global"
        const id = parts[1] === "dsh" ? "dsh" : "agents"
        setDeleteDialog({
          label: skill.name,
          note: "会先把目录备份到同级的 .smp-backup-* 再删除；备份会保留，需要时可手动恢复。",
          // Progress shows on the card itself, like MCP row deletes.
          closeOnConfirm: true,
          run: () => {
            const target = removalTargetOf(skill)
            deleteTargetRef.current = { ...target, path: String(skill.path ?? "") }
            setDeleteError("")
            setSkillPendingPath(String(skill.path ?? ""))
            setSkillError("")
            setSkillNonce("pending")
            const request = {
              op: "delete", scope, id,
              project: skill.scope === "global" ? "" : skill.scope,
              name: skill.name, prevName: "", description: "", body: "",
              path: skill.path ?? "", nonce: "",
            }
            void sendSkillWrite(request).then((result) => {
              setSkillNonce("")
              finishSkillDelete(result)
            })
          },
        })
      }

      /**          },
        })
      }

      /**
       * `config.skills[]` 条目没有 `path`：按 Host 的落盘规则推出来。
       *
       * 0.5.5 之后不再新建这类条目；保留这段只是为了老条目仍能预览。`id` 决定两个根中的
       * 哪一个（dsh / agents），少看它就会读错文件。
       */
      const diskPathOfSkill = (skill) => {
        const name = String(skill?.name ?? "")
        if (name === "") return ""
        const scope = skill?.scope ?? "global"
        const rootId = skill?.id === "agents" ? "agents" : "dsh"
        const dirs = runtime.skillDirs ?? {}
        const base = scope === "global"
          ? String(rootId === "agents" ? (dirs.userAgents ?? "") : (dirs.userDsh ?? ""))
          : `${String(scope).replace(/\/+$/, "")}/${rootId === "dsh" ? ".dsh" : ".agents"}/skills`
        return base === "" ? "" : `${base}/${name}/SKILL.md`
      }

      /** Load one skill's body on demand before editing it. */
      const loadSkillBody = (skill) => {
        if (!skill?.path) return
        setEditBodyPending(true)
        setEditBodyNonce(nextNonce())
        void readSkillBody(skill.path).then((result) => {
          setSkillDraft((current) => ({
            ...current,
            body: result.ok === true ? String(result.body ?? "") : String(current.body ?? ""),
          }))
          setEditBodyPending(false)
          setEditBodyNonce("")
          if (result.ok !== true) setSkillError(String(result.reason ?? "读取正文失败"))
        })
      }

      const openPreview = (skill) => {
        setSkillPreview(skill)
        setPreviewBody("")
        setPreviewPending(true)
        setPreviewNonce(nextNonce())
        void readSkillBody(skill.path ?? "").then((result) => {
          setPreviewBody(result.ok === true ? String(result.body ?? "") : String(result.reason ?? "读取失败"))
          setPreviewPending(false)
          setPreviewNonce("")
        })
      }

      /**
       * The absolute directory the current dialog choices resolve to.
       *
       * Shown in the dialog as 「将写入 …」: the three pickers are what the user thinks in, but
       * DSH reads **two** roots per scope and a hand-typed project path is resolved to the
       * nearest enclosing project root, so the answers differ from the inputs often enough
       * that stating the result is worth a line.
       */
      const skillDialogTarget = skillRootLabel(
        skillDialog?.scope === 'project' ? (skillDialog?.project ?? '') : 'global',
        skillDialog?.id,
      )

      const skillDialogElement = skillDialogView({
        dialog: skillDialog, draft: skillDraft,
        resolvedPath: skillDialog === null || (skillDialog.scope === 'project' && String(skillDialog.project ?? '') === '')
          // Nothing to resolve yet: a project entry with no workspace picks nothing, and a
          // path would be a guess dressed up as a fact.
          ? ''
          : skillDialogTarget,
        workspaceChoices: projectChoices,
        error: skillError, pending: skillNonce !== "" || editBodyPending, primitives,
        onScope: (scope) => setSkillDialog((current) => (current === null ? current : { ...current, scope })),
        onProject: (next) => setSkillDialog((current) => {
          if (current === null) return current
          // 「自定义路径…」 switches the same field into a free-text input; the value is kept so
          // switching back and forth does not lose what was typed.
          if (next === '__custom__') return { ...current, projectCustom: true }
          return { ...current, projectCustom: false, project: next }
        }),
        onProjectCustom: (next) => setSkillDialog((current) => (current === null ? current : { ...current, project: next })),
        onRoot: (id) => setSkillDialog((current) => (current === null ? current : { ...current, id: id === 'agents' ? 'agents' : 'dsh' })),
        onName: (name) => setSkillDraft((current) => ({ ...current, name })),
        onDescription: (description) => setSkillDraft((current) => ({ ...current, description })),
        onBody: (body) => setSkillDraft((current) => ({ ...current, body })),
        onCancel: () => { setSkillDialog(null); setSkillError(""); resetSkillPending() },
        onSave: () => {
          if (skillDialog === null) return
          // Never save an edit before the body arrived: it would erase the file.
          if (editBodyPending) return
          const isEdit = skillDialog.mode === "edit"
          const renamed = isEdit && (skillDraft.name ?? "") !== skillDialog.prevName
          const editOp = isEdit ? (renamed ? "rename" : "update") : "create"
          const sent = {
            kind: editOp,
            name: String(skillDraft.name ?? ""),
            prevName: String(skillDialog.prevName ?? ""),
            description: String(skillDraft.description ?? ""),
            scope: skillDialog.scope, id: skillDialog.id, project: skillDialog.project,
          }
          setSkillError("")
          setSkillNonce("pending")
          const request = {
            op: editOp,
            scope: skillDialog.scope, id: skillDialog.id, project: skillDialog.project,
            name: skillDraft.name ?? "", prevName: skillDialog.prevName ?? "",
            description: skillDraft.description ?? "", body: skillDraft.body ?? "",
            nonce: "",
          }
          void sendSkillWrite(request).then((result) => {
            setSkillNonce("")
            if (result.ok === true) {
              applyOptimisticSkillWrite(sent)
              setSkillDialog(null)
              setSkillError("")
              bumpRefresh()
              return
            }
            // Roll back visibly: the dialog stays open with the reason.
            setSkillError(String(result.reason ?? "写入失败"))
          })
        },
      })

      const skillPreviewDialogView = skillPreviewDialog({
        skill: skillPreview, body: previewBody, pending: previewPending, primitives,
        onClose: () => { setSkillPreview(null); setPreviewPending(false); setPreviewNonce("") },
      })

      const confirmDeleteDialog = deleteConfirmDialog({
        dialog: deleteDialog,
        primitives,
        pending: deletePending,
        error: deleteError,
        onCancel: () => { setDeleteDialog(null); setDeletePending(false); setDeleteError(""); setDeleteNonce(""); },
        onConfirm: () => {
          // Skill deletes stay open with 删除中… until the receipt arrives (or shows
          // why it failed). Row deletes report progress on the row itself, so they
          // close right away and the card shows its own spinner.
          if (deleteDialog?.closeOnConfirm === true) {
            setDeleteDialog(null)
            setDeletePending(false)
            setDeleteError("")
            setDeleteNonce("")
          }
          const run = deleteDialog?.run
          if (typeof run === 'function') run()
        },
      })

      /**
       * One list, ordered 全局 → 工作区（按工作区顺序）→ 其他作用域.
       *
       * There used to be two sections — 全局 MCP and 项目级 MCP — because the two tiers were
       * genuinely different things: global servers were rows, project servers lived in a
       * field this plugin owned and were mounted at runtime. Both are rows now and `scope`
       * is the only difference, so a second list would be a distinction the data no longer
       * makes.
       *
       * What the *order* carries is which workspace a row belongs to. Within a group the
       * patch's own row order is kept, and that order **is** creation order — `insertRow`
       * appends — so a new server lands at the end of its own workspace without anything
       * extra having to remember that. Groups get no heading of their own: the card already
       * carries a workspace tag, and a second layer of titles would say it twice.
       */
      /**
       * The rows to draw: deletions we asked for are **already gone**.
       *
       * The patch write takes ~1–5 ms, but the panel only sees the result after a round-trip
       * (500 ms drain poll + Loader reload + republish), so a deleted card used to sit there
       * with a spinner for a couple of seconds — reading as "the click did nothing" and
       * inviting a second click. Hiding it on click is safe because `inflight` is not a
       * guess: `settleInflight` keeps the marker only while the row is still listed, and
       * drops it either when the projection catches up (nothing to hide any more) or after
       * its timeout — so if the delete silently failed, the card comes back on its own.
       */
      const deletedIds = new Set(
        Object.entries(inflight)
          .filter(([, info]) => info?.kind === 'delete')
          .map(([entryId]) => String(entryId).replace(/^include:/, '')),
      )
      const mcpRows = profileRows
        .filter((row) => !deletedIds.has(String(row.entryId).replace(/^include:/, '')))
        .filter(matches)
      // An add in flight has no row yet, so it needs a placeholder or the click looks like
      // nothing happened until the write lands. Bucketing it by scope keeps that placeholder
      // in the workspace it is being added to instead of at the end of the page.
      const pendingByScope = new Map()
      for (const [entryId, info] of pendingAdds) {
        const scope = scopeKey(info?.scope)
        pendingByScope.set(scope, [...(pendingByScope.get(scope) ?? []), entryId])
      }
      /**
       * A row we asked to add, rendered as a **real card** until the projection lists it.
       *
       * This used to be a bare spinner (「正在写入配置文件…」). Writing the patch takes ~1–5 ms
       * (measured), but the panel only learns about it a round-trip later: the Host drains
       * `rowOps` on a 500 ms poll, writes the patch, waits for the Loader to reload it, and
       * republishes. So the user filled in a form and then watched a placeholder for seconds —
       * for a row that already existed on disk. Rendering the card they described hides that
       * wait, and the card is replaced by the real one *in place* because both carry the same
       * `entryId`, which the op already knows at click time (`include:mcp-<name>`).
       *
       * A fallback spinner covers the one case with no draft to draw: an op queued by another
       * session, which this panel never saw typed.
       */
      const optimisticCard = (entryId) => {
        const info = inflight[entryId]
        const draftRow = info?.draft
        if (draftRow === undefined) {
          return (
            <li className="smp-card" key={`pending:${entryId}`}>
              <div className="smp-cardHead" key="head">
                <span className="smp-pending" key="p">
                  <span className="smp-spinner" key="s" />
                  {`正在写入配置文件…（${String(entryId).replace(/^include:mcp-/, "")}）`}
                </span>
              </div>
            </li>
          )
        }
        const scope = scopeKey(info?.scope)
        const stdio = (draftRow.transport ?? 'streamable-http') === 'stdio'
        // Keep the `include:` prefix: that is the shape the projection publishes (rows live in
        // an `insert:` list), and `profileCard` looks its own pending state up by that exact
        // key. Dropping it would make the optimistic card render live action buttons.
        return profileCard({
          entryId: String(entryId),
          serverName: draftRow.serverName ?? '',
          scope: scope === '' ? '' : scope,
          transport: draftRow.transport ?? 'streamable-http',
          target: stdio
            ? [draftRow.command, draftRow.args].filter((part) => String(part ?? '').trim() !== '').join(' ')
            : (draftRow.url ?? ''),
          command: draftRow.command ?? '',
          args: draftRow.args ?? '',
          env: draftRow.env ?? '',
          headersText: draftRow.headers ?? '',
          enabled: true,
          phase: '',
        }, scope === '' ? 'global' : 'project')
      }
      const mcpGroups = orderedScopeGroups(
        mcpRows,
        workspacePaths,
        // A scope whose only member is still being written must still get a group, or its
        // card would have nowhere to sit.
        [...pendingByScope.keys()],
      )
      const mcpList = (
        <ul className="smp-cards" key="cards">
          {mcpGroups.map((group) => [
            // `.map(profileCard)` would pass the array **index** as the `tier` argument —
            // which silently made every global card report its status against tier `0`, so
            // the tags vanished. Wrap the call.
            ...group.items.map((row) => profileCard(row, (row.scope ?? 'global') === 'global' ? 'global' : 'project')),
            ...(pendingByScope.get(group.scope) ?? []).map(optimisticCard),
          ])}
          {mcpRows.length === 0 && pendingAdds.length === 0 ? (
            <li className="smp-empty" key="empty" style={{ gridColumn: "1 / -1" }}>
              {emptyMcpText('')}
            </li>
          ) : null}
        </ul>
      )

      // The MCP tab is one list, so its heading had nothing to collapse. The summary it
      // carried now sits above the search box (see the page render below), and its count
      // follows the filtered list.
      const mcpSummary = `共 ${mcpRows.length} 个 · 作用域见卡片上的工作区标签 · 增删改都会写回 cordis.patch.yml（自动备份）`

      const mcpSections = [
        <ul className="smp-cards" key="import">{importCard(importScope)}</ul>,
        // The form sits directly above the list it appends to — not at the bottom of it.
        // The trigger is on the search row; the form must not be a whole page away from it.
        editing?.kind === "mcp" && editing.id === undefined ? (
          <ul className="smp-cards" key="formWrap">{serverForm({ tier: editing.tier })}</ul>
        ) : null,
        // No heading and no wrapper: the summary line above the search box already says
        // what the list is, and a section around a single list only added spacing of its
        // own. As a plain sibling of the import card, this list inherits the page rhythm.
        mcpList,
      ]

      /**
       * The skills tab, rendered **the same way as MCP**: one list under a summary line,
       * with no per-tier section wrappers.
       *
       * The old shape was two collapsible sections (「全局技能」/「项目级技能」) whose headings
       * carried the add buttons. That made the two tabs look like different products even
       * though they manage the same kind of thing, and it hid the list behind a chevron the
       * MCP tab does not have. The workspace grouping those sections expressed is now the
       * list's *order* (see `skillGroups`).
       *
       * The line mirrors the MCP one: a count for **the list as rendered**, who the entries
       * belong to, and where a write lands. Deliberately not a per-tier breakdown — the list
       * is one list now, so "面板 N 个 · 磁盘 M 个" would describe two subsets the user cannot
       * tell apart on screen.
       */
      const skillsSummary = [
        `共 ${skillGroups.reduce((total, group) => total + group.items.length, 0)} 个`,
        '作用域见卡片上的标签',
        // Both scopes have two roots each; name them so the summary is not the half of it that
        // happens to be the default.
        `全局写 ${skillDirs.userDsh || '~/.dsh/skills'} 或 ${skillDirs.userAgents || '~/.agents/skills'}，项目级写 <工作区>/.dsh/skills 或 <工作区>/.agents/skills`,
      ].join(' · ')

      const skillsSections = [skillsList]

      return (
        <div className="smp-page">
          <style key="css">{CSS}</style>
          {head}
          {tabs}
          {/* One summary line per tab, in the same place: above the search box, describing
              the whole list. It replaced the per-section subtitles, which said the same
              numbers twice once the sections became one list. */}
          <div className="smp-groupSub smp-summaryAbove" key="summary">
            {tab === "mcp" ? mcpSummary : skillsSummary}
          </div>
          {filterRowView}
          {statusOf(form) === "loading" ? <p className="smp-empty" key="loading">正在读取设置…</p> : null}
          {error && !editing ? <p className="smp-error" key="err">{error}</p> : null}
          {/* A disk-skill delete fails with its dialog already closed, so its
              reason used to be written into state nobody rendered. */}
          {skillError !== "" && skillDialog === null ? <p className="smp-error" key="skillerr">{skillError}</p> : null}
          {confirmDeleteDialog}
          {skillPreviewDialogView}
          {skillDialogElement}
          {tab === "mcp" ? mcpSections : skillsSections}
          {debugOn ? (
            <section className="smp-group" key="debug">
              <div className="smp-groupTitleRow" key="h">
                <span className="smp-groupTitle">
                  {`Loader 诊断：共 ${inventoryRows.length} 行，其中 mcp 相关 ${debugMcp.length} 行`}
                </span>
              </div>
              <ul className="smp-cards" key="list">
                {debugMcp.map((row) => (
                  <li className="smp-card" key={row.entryId}>
                    <div className="smp-cardContent" key="c" style={{ cursor: "default" }}>
                      <div className="smp-cardMainRow" key="r">
                        <span className="smp-cardIdentity" key="i">{row.entryId}</span>
                        <span className="smp-cardEnd" key="e">
                          <span className="smp-tag" data-tone="neutral">
                            {`${row.enabled ? "on" : "off"}${row.fiberPhase ? ` · ${row.fiberPhase}` : ""}`}
                          </span>
                        </span>
                      </div>
                      <div className="smp-cardDescription" key="d">{row.moduleName}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )
    }

    return {
      inject: ['slots', 'configForms', 'remote', 'remote.pluginInventory'],
      apply(ctx) {
        const form = ctx.configForms.get(NS)
        // Services reached through `remote` must be injected first; a bare access
        // throws in cordis and would fail the whole client half.
        let inventory
        try {
          inventory = ctx.remote?.pluginInventory
        } catch {
          inventory = undefined
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'skills-mcp',
          order: 20,
          label: () => 'Skills & MCP',
          inject: () => ({ form, inventory }),
        }, Panel))
      },
    }
  },
})
