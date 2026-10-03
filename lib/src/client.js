import { IMPORT_CHOICES } from './importSources.js'
import { listOf, snapshotOf, statusOf } from './config.js'
import { Chevron } from './components/chevron.jsx'
import { field } from './components/field.jsx'
import { groupHead as groupHeadView } from './components/group.jsx'
import { filterRow } from './components/filterRow.jsx'
import { tabStrip } from './components/tabs.jsx'
import { pageHead } from './components/head.jsx'
import { matchesName } from './components/filters.js'
import { pendingAdds as pendingAddsOf, pendingLabel, settleInflight } from './crud/inflight.js'
import { emptyMcpText, emptySkillText, globalMcpSubtitle, projectMcpSubtitle, projectSkillSubtitle } from './components/sections.js'
import { HINTS, skillFieldDefs } from './components/form.js'
import { detailNodes, rowDetailPairs } from './components/card.jsx'
import { deleteConfirmDialog } from './components/dialog.jsx'
import { skillPreviewDialog } from './components/skillPreview.jsx'
import { skillDialogView } from './components/skillDialog.jsx'
import { removeSkill, skillEntryOf, upsertSkillByName } from './crud/skills.js'
import { addServerOp, deleteServerOp, inflightKeyForRow, removeProjectEntry, replaceProjectEntry, rowEntryId, toggleServerOp, updateServerOp } from './crud/servers.js'
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
  id: '@local/dsh-skills-mcp-panel',
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
    const { useState, useEffect, useMemo, useRef } = React

    /** Settings namespace = the Host entry id declared in cordis.patch.yml. */
    const NS = 'skills-mcp-panel'

const CSS = panelCss

    /** Read through the settings form's own snapshot store. */

    
    function Panel(props) {
      const form = props.form
      const [tick, setTick] = useState(0)
      const [tab, setTab] = useState('mcp')
      const [query, setQuery] = useState('')
      const [project, setProject] = useState('')
      const [open, setOpen] = useState({ mcpGlobal: true, mcpProject: true, skillsGlobal: true, skillsProject: true })
      const [expanded, setExpanded] = useState('')
      const [editing, setEditing] = useState(null)
      const [draft, setDraft] = useState({})
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [confirming, setConfirming] = useState('')
      const [deleteDialog, setDeleteDialog] = useState(null)
    /** Delete progress: the confirm dialog stays open until the receipt lands. */
    const [deleteNonce, setDeleteNonce] = useState("")
    const [deletePending, setDeletePending] = useState(false)
    const [deleteError, setDeleteError] = useState("")
    /** Skill preview dialog: the entry whose SKILL.md body is being shown. */
    const [skillPreview, setSkillPreview] = useState(null)
    /** Add/edit dialog: { mode, regionKey, scope, id, project, prevName } or null. */
    const [skillDialog, setSkillDialog] = useState(null)
    const [skillDraft, setSkillDraft] = useState({ name: "", description: "", body: "" })
    const [skillError, setSkillError] = useState("")
    const [skillNonce, setSkillNonce] = useState("")
    /** When the current skill op was sent (for freshness fallback matching). */
    const skillSentAtRef = useRef(0)
    /** Preview body fetched on demand (the list no longer carries bodies). */
    const [previewBody, setPreviewBody] = useState("")
    const [previewPending, setPreviewPending] = useState(false)
    const [previewNonce, setPreviewNonce] = useState("")
    /** Edit needs the body too; the list no longer carries it. */
    const [editBodyNonce, setEditBodyNonce] = useState("")
    const [editBodyPending, setEditBodyPending] = useState(false)
    useEffect(() => {
      // Disk delete: close the confirm dialog only once the Host has done it.
      if (deleteNonce !== "") {
        const delResult = snapshotOf(form)?.skillResult
        if (delResult?.nonce === deleteNonce) {
          if (delResult.ok === true) {
            setDeleteDialog(null)
            setDeleteError("")
          } else {
            setDeleteError(String(delResult.reason ?? "删除失败"))
          }
          setDeletePending(false)
          setDeleteNonce("")
        }
      }

      // Edit body: same channel, separate nonce. Fill the draft so the textarea is
      // not empty (the discovered list deliberately carries no bodies).
      if (editBodyNonce !== "") {
        const editRead = snapshotOf(form)?.skillResult
        if (editRead?.nonce === editBodyNonce) {
          setSkillDraft((current) => ({
            ...current,
            body: editRead.ok === true ? String(editRead.body ?? "") : String(current.body ?? ""),
          }))
          setEditBodyPending(false)
          setEditBodyNonce("")
        }
      }

      // Preview body: a separate on-demand read shares the same result channel.
      if (previewNonce !== "") {
        const readResult = snapshotOf(form)?.skillResult
        if (readResult?.nonce === previewNonce) {
          setPreviewBody(readResult.ok === true ? String(readResult.body ?? "") : String(readResult.reason ?? "读取失败"))
          setPreviewPending(false)
          setPreviewNonce("")
        }
      }
      if (skillNonce === "") return
      // Read the snapshot here, not while rendering: `form` is declared later in
      // this component, so touching it during render hit its temporal dead zone.
      const result = snapshotOf(form)?.skillResult
      // Match by nonce, or fall back to freshness: a receipt produced after we sent
      // the request belongs to us even if the nonce comes back differently.
      const freshReceipt = typeof result?.at === 'string' && result.at !== '' &&
        Date.parse(result.at) >= skillSentAtRef.current - 1000
      if (result?.nonce !== skillNonce && !freshReceipt) return
      if (result.ok === true) {
        setSkillDialog(null)
        setSkillNonce("")
        setSkillError("")
        return
      }
      setSkillError(String(result.reason ?? "写入失败"))
      // No dependency array on purpose: the receipt only becomes visible after the
      // settings document updates, which re-renders this component. Listing deps
      // (nonce/form/draft) meant the effect ran once at submit time and never saw
      // the answer: the dialog stayed open and the list never refreshed.
    })
      /**
       * Operations we started but whose effect we have not seen yet. The Host
       * clears its queue BEFORE writing the patch, so the queue alone would drop
       * the spinner while the row still looks unchanged — this keeps it up until
       * the projection actually reflects the change (or a safety timeout).
       */
      const [inflight, setInflight] = useState({})
      const [customProject, setCustomProject] = useState(false)
      const [autoPicked, setAutoPicked] = useState(false)
      const [importOpen, setImportOpen] = useState(false)
      const [importSource, setImportSource] = useState('claude')
      const [importScope, setImportScope] = useState('global')
      const [importProject, setImportProject] = useState('')
      const [importCustomProject, setImportCustomProject] = useState(false)

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

      const servers = useMemo(() => listOf(form, 'servers'), [form, tick])
      const skills = useMemo(() => listOf(form, 'skills'), [form, tick])
      const hostProfileRows = useMemo(() => listOf(form, 'profileServers'), [form, tick])

      /** Host projection first; the inventory entry list is the fallback. */
      const profileRows = useMemo(() => {
        if (hostProfileRows.length > 0) return hostProfileRows
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
      }, [hostProfileRows, inventoryRows])

      const debugOn = typeof location !== 'undefined' && /(?:^|[?&])smp=debug/.test(location.search)
      const debugMcp = inventoryRows.filter((row) => /mcp/i.test(row.entryId) || /mcp/i.test(row.moduleName))

      // `rowOpsReady` is a one-shot "first rowOps pass done" marker, but its schema
      // default is `false`, so a document that lost the field reads as an explicit
      // false — which hid every 编辑/停用/删除 button on profile-driven rows.
      // Treat "the Host has published anything" (it always sends skillDirs) as ready.
      const settingsDoc = snapshotOf(form) ?? {}
      const rowOpsReady = settingsDoc.rowOpsReady === true
        || Object.keys(settingsDoc.skillDirs ?? {}).length > 0

      // 只按名称搜索（以前是整行 JSON 匹配，会把 URL/参数/环境变量也算进去）
      const matches = (row) => matchesName(row.serverName ?? row.name, query)
      const isGlobal = (row) => (row.scope ?? 'global') === 'global'
      const isProject = (row) => project !== '' && (row.scope ?? 'global') === project

      const serversGlobal = servers.filter((row) => isGlobal(row) && matches(row))
      const serversProject = servers.filter((row) => isProject(row) && matches(row))
      const skillsGlobal = skills.filter((row) => isGlobal(row) && matches(row))
      const skillsProject = skills.filter((row) => isProject(row) && matches(row))
      // Skills already on disk (DSH's own roots) — listed read-only, not managed here.
      const skillDirs = snapshotOf(form)?.skillDirs ?? {}
      const currentProjectSkillsDir =
        listOf(form, "workspaces").find((workspace) => workspace.path === project)?.agentsSkillsDir ?? ""
      const discovered = listOf(form, "discoveredSkills")
      // The panel's own skills are on disk too (it writes them), so skip any
      // discovered entry the panel already manages — it has its own card.
      // Which root a skill lives in: ~/.agents vs ~/.dsh (and the project twins).
      const rootTag = (source) => (String(source).endsWith("-agents") ? "agents" : "dsh")
      const tagNode = (source, key) => (
        <span className="smp-tag" data-tone="neutral" key={key}>{rootTag(source)}</span>
      )
      const managedGlobal = new Set(skillsGlobal.map((skill) => skill.name))
      const managedProject = new Set(skillsProject.map((skill) => skill.name))
      const discoveredGlobal = discovered.filter((entry) =>
        (entry.scope ?? "global") === "global" && !managedGlobal.has(entry.name) && matchesName(entry.name, query))
      const discoveredProject = discovered.filter((entry) =>
        entry.scope === project && !managedProject.has(entry.name) && matchesName(entry.name, query))
      const profileGlobal = profileRows.filter(matches)

      /**
       * Human label for a project path: the workspace registry title when we
       * have one, otherwise the last path segment. A path the user typed by hand
       * (not in the registry) keeps its full spelling.
       */
      const knownProjects = new Map(listOf(form, 'workspaces')
        .filter((workspace) => typeof workspace?.path === 'string' && workspace.path !== '')
        .map((workspace) => [workspace.path, typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : workspace.path]))
      const projectLabel = (path) => {
        if (typeof path !== 'string' || path === '') return ''
        const known = knownProjects.get(path)
        if (known !== undefined) return known
        // Not a registered workspace: the user typed it, so show it in full.
        return path
      }
      /** Row ops still queued: the Host applies them within a couple of seconds. */
      // Open on the workspace this session actually runs in, once.
      useEffect(() => {
        const cwd = snapshotOf(form)?.currentWorkspace
        if (autoPicked || typeof cwd !== 'string' || cwd === '' || project !== '') return
        setAutoPicked(true)
        setProject(cwd)
      }, [form, autoPicked, project, tick])

      useEffect(() => {
        setInflight((current) => settleInflight(current, { profileRows }))
      }, [tick, profileRows, inflight])

      const pendingOps = Array.isArray(snapshotOf(form)?.rowOps) ? snapshotOf(form).rowOps : []
      const pendingOf = (entryId) => pendingOps.find((op) => String(op?.entryId ?? '').replace(/^include:/, '') === String(entryId).replace(/^include:/, '')) ?? null
      /**
       * Project picker options: the workspace registry first (published by the
       * Host), then any project scope already configured in this panel.
       */
      const projectChoices = useMemo(() => {
        const map = new Map()
        for (const workspace of listOf(form, 'workspaces')) {
          const path = typeof workspace?.path === 'string' ? workspace.path : ''
          if (path !== '') map.set(path, typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : path)
        }
        for (const row of [...servers, ...skills]) {
          const scope = row?.scope
          if (typeof scope === 'string' && scope !== '' && scope !== 'global' && !map.has(scope)) map.set(scope, scope)
        }
        if (project !== '' && !map.has(project)) map.set(project, project)
        return [...map.entries()]
      }, [servers, skills, project, form, tick])

      async function write(field_, value) {
        setBusy(true)
        setError('')
        try {
          if (typeof form?.set === 'function') await form.set(field_, value)
          else if (props.mutate) await props.mutate(NS, [{ op: 'set', path: [field_], value }])
          refresh()
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      /**
       * Queue one command against a profile-configured row.
       *
       * The inventory reports loader entry ids (`include:mcp-context7`) while the
       * profile patch keys rows by their bare id, so strip the directive prefix.
       */
      const queueRowOp = (op) => write('rowOps', [
        ...listOf(form, 'rowOps'),
        { ...op, entryId: String(op.entryId).replace(/^include:/, '').replace(/^[a-z-]+:/i, '') },
      ])

      /** Replace one row of a list, matching by tier identity. */
      const replaceServer = (row) => write('servers', [
        ...servers.filter((item) => !(item.serverName === row.serverName && (item.scope ?? 'global') === row.scope)),
        row,
      ])
      const replaceSkill = (row) => write('skills', upsertSkillByName(skills, row))

      const head = pageHead()

      const tabs = tabStrip({
        active: tab,
        counts: {
          mcp: serversGlobal.length + profileGlobal.length + serversProject.length,
          // Count what the tab actually lists: the panel's own skills plus the
          // ones discovered on disk (that is why it used to read 0 while cards showed).
          skills: skillsGlobal.length + skillsProject.length + discoveredGlobal.length + discoveredProject.length,
        },
        onSelect: (next) => { setTab(next); setEditing(null); setExpanded('') },
      })

      /** One row holding the search and the project switch, like the reference page. */
      const filterRowView = filterRow({
        query,
        onQuery: setQuery,
        project,
        projectChoices,
        customProject,
        onCustomProject: setCustomProject,
        onProject: setProject,
        placeholder: tab === 'mcp' ? '搜索名称' : '搜索技能名称',
      })

      /** Group header: chevron toggle, title, sub line, trailing action. */
      function groupHead(kindKey, title, subText, action) {
        return groupHeadView({
          Chevron,
          open: open[kindKey],
          title,
          subText,
          action,
          onToggle: () => setOpen({ ...open, [kindKey]: !open[kindKey] }),
        })
      }

      /** One managed entry, rendered the way the reference page renders a plugin. */
      function card(key, identity, description, enabled, details, actions) {
        const isOpen = expanded === key
        return (
          <li className="smp-card" key={key}>
            <div className="smp-cardHead" key="head">
              <button
                className="smp-cardToggle"
                key="toggle"
                aria-expanded={isOpen}
                onClick={() => setExpanded(isOpen ? '' : key)}
              >
                <Chevron key="c" open={isOpen} />
                <span className="smp-cardIdentity" key="id">{identity}</span>
                {enabled === false ? <span className="smp-tag" data-tone="neutral" key="tag">已停用</span> : null}
              </button>
              <span className="smp-cardActions" key="actions">{actions}</span>
            </div>
            {description ? <div className="smp-cardDescription" key="desc">{description}</div> : null}
            {isOpen ? (
              <div className="smp-cardDetails" key="details">
                <div className="smp-details" key="grid">{detailNodes(details, 'k')}</div>
                {error ? <div className="smp-error" key="err" style={{ marginTop: 8 }}>{error}</div> : null}
              </div>
            ) : null}
          </li>
        )
      }

      /** Read-only row for an MCP entry the profile itself configures. */
      function profileCard(row) {
        const pendingDelete = confirming === row.entryId
        const rowKey = `profile:${row.entryId}`
        const rowOpen = expanded === rowKey
        // Edit in place: the row itself turns into the form.
        if (editing?.kind === 'mcp' && editing.tier === 'global' && editing.id === row.entryId) {
          return serverForm({ tier: 'global', scope: 'global' })
        }
        const pending = pendingOf(row.entryId) !== null || inflight[row.entryId] !== undefined
        return (
          <li className="smp-card" key={`profile:${row.entryId}`}>
            <div className="smp-cardHead" key="head">
              <button
                className="smp-cardToggle" key="toggle" aria-expanded={rowOpen}
                onClick={() => setExpanded(rowOpen ? "" : rowKey)}
              >
                <Chevron key="c" open={rowOpen} />
                <span className="smp-cardIdentity" key="name">{row.serverName || row.entryId}</span>
              </button>
              <span className="smp-cardEnd" key="end">
                {row.enabled === false ? <span className="smp-tag" data-tone="neutral" key="off">已停用</span> : null}
                <span className="smp-tag" data-tone="neutral" key="src">配置文件</span>
              </span>
              {pending ? (
                <span className="smp-cardActions" key="pending">
                  <span className="smp-pending" key="p">
                    <span className="smp-spinner" key="s" />
                    {pendingLabel(inflight[row.entryId] ?? { kind: pendingOf(row.entryId)?.op })}
                  </span>
                </span>
              ) : rowOpsReady ? (
                <span className="smp-cardActions" key="actions">
                  <button
                    className="smp-button" data-variant="outline" key="toggle" disabled={busy}
                    onClick={() => {
                      const expectEnabled = row.enabled === false
                      setInflight((m) => ({ ...m, [row.entryId]: { kind: "toggle", at: Date.now(), expectEnabled } }))
                      queueRowOp(toggleServerOp(row.entryId, expectEnabled))
                    }}
                  >
                    {row.enabled === false ? "启用" : "停用"}
                  </button>
                  <button
                    className="smp-button" data-variant="outline" key="edit" disabled={busy}
                    onClick={() => {
                      setEditing({ kind: "mcp", tier: "global", profile: row.entryId, id: row.entryId })
                      setDraft({
                        serverName: row.serverName,
                        transport: row.transport || "streamable-http",
                        url: row.target,
                        command: row.transport === "stdio" ? row.target : "",
                      })
                    }}
                  >
                    编辑
                  </button>
                  <button
                    className="smp-button" data-variant="danger" key="del" disabled={busy}
                    onClick={() => {
                      const run = () => {
                        setInflight((m) => ({ ...m, [row.entryId]: { kind: "delete", at: Date.now() } }))
                        queueRowOp(deleteServerOp(row.entryId))
                      }
                      if (primitives?.Modal === undefined) {
                        if (window.confirm(`删除「${row.serverName || row.entryId}」？`)) run()
                        return
                      }
                      setDeleteDialog({
                        label: row.serverName || row.entryId,
                        note: "会从 cordis.patch.yml 里移除这一行（写入前自动备份）。",
                        run,
                      })
                    }}
                  >
                    删除
                  </button>
                </span>
              ) : null}
            </div>
            <div className="smp-cardDescription" key="desc">
              {row.target
                ? `${row.transport || "streamable-http"} · ${row.target}`
                : `${String(row.entryId).replace(/^include:/, "")}${row.phase ? ` · ${row.phase}` : ""}`}
            </div>
            {rowOpen ? (
              <div className="smp-cardDetails" key="details">
                <div className="smp-details" key="grid">{detailNodes(rowDetailPairs(row))}</div>
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
        const raw = snapshotOf(form)?.importResult
        const target = scope === 'global' ? '' : importProject
        const result = raw !== null && typeof raw === 'object' && raw.nonce !== '' && raw.scope === scope
          && (scope === 'global' || raw.project === target) ? raw : null
        const needsProject = scope === 'project' && target === ''
        // Import never overwrites: names already managed for this scope are skipped.
        const takenNames = takenNamesOf({ scope, target, profileRows, servers })
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
                  ? "从其他编辑器/CLI 的**用户级**配置文件导入（写成配置文件行）。"
                  : "从其他编辑器/CLI 的**项目级**文件导入到面板的项目条目。"}
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
                onClick={() => write("importRequest", { source: importSource, scope, project: target, nonce: String(Date.now()) })}
              >
                扫描
              </button>
              {result !== null && freshServers.length > 0 ? (
                <button
                  className="smp-button" data-variant="outline" key="do"
                  disabled={busy || (scope === "global" && !rowOpsReady)}
                  onClick={() => {
                    if (scope === "global") {
                      // Global MCP lives in the profile patch: one row per import.
                      const existing = new Set(profileRows.map((row) => row.serverName))
                      for (const server of result.servers) {
                        if (existing.has(server.serverName)) continue
                        queueRowOp(addServerOp({
                          serverName: server.serverName, transport: server.transport,
                          url: server.transport === "stdio" ? "" : server.url,
                          command: server.transport === "stdio" ? server.command : "",
                          args: server.transport === "stdio" ? (server.args ?? []).join(" ") : "",
                          env: server.env ?? "", headers: server.headers ?? "",
                        }))
                      }
                      return
                    }
                    const existing = new Set(servers.map((server) => server.serverName))
                    const fresh = result.servers.filter((server) => !existing.has(server.serverName))
                    write("servers", [...servers, ...fresh])
                  }}
                >
                  {importLabel({ scope, fresh: freshServers.length, skipped: skippedServers.length })}
                </button>
              ) : null}
            </div>
          </li>
        )
      }

      const addButton = (tier, label, onClick) => (
        <button
          className="smp-button"
          data-variant="primary"
          key="add"
          disabled={!tier || busy}
          onClick={onClick}
        >
          {label}
        </button>
      )

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
                    onChange={(e) => setDraft({ ...draft, transport: e.target.value })}
                  >
                    <option value="streamable-http" key="h">streamable-http</option>
                    <option value="stdio" key="s">stdio</option>
                  </select>
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
                      <textarea
                        className="smp-textarea" rows={3} placeholder={HINTS.env}
                        value={draft.env ?? ""}
                        onChange={(e) => setDraft({ ...draft, env: e.target.value })}
                      />
                    ), true)
                  : null}
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
                      setInflight((m) => ({ ...m, [profileEntry]: { kind: "update", at: Date.now(), expectName: draft.serverName ?? "" } }))
                      queueRowOp(updateServerOp(profileEntry, {
                        serverName: draft.serverName ?? "", transport,
                        url: transport === "stdio" ? "" : (draft.url ?? ""),
                        command: transport === "stdio" ? (draft.command ?? "") : "",
                        args: transport === "stdio" ? String(draft.args ?? "") : "",
                        env: transport === "stdio" ? String(draft.env ?? "") : "",
                      }))
                    } else if (tier.tier === "global") {
                      // A global MCP becomes a real profile row, exactly like the
                      // shipped ones; the Host writes it (lock + backup + validation).
                      setInflight((m) => ({ ...m, [inflightKeyForRow(rowEntryId(draft.serverName))]: { kind: "add", at: Date.now() } }))
                      queueRowOp(addServerOp({
                        serverName: draft.serverName ?? "", transport,
                        url: transport === "stdio" ? "" : (draft.url ?? ""),
                        command: transport === "stdio" ? (draft.command ?? "") : "",
                        args: transport === "stdio" ? String(draft.args ?? "") : "",
                        env: transport === "stdio" ? String(draft.env ?? "") : "",
                      }))
                    } else {
                      replaceServer({
                        scope, id: draft.serverName, serverName: draft.serverName, transport,
                        url: transport === "stdio" ? "" : (draft.url ?? ""),
                        command: transport === "stdio" ? (draft.command ?? "") : "",
                        args: transport === "stdio" ? argList : [],
                        env: transport === "stdio" ? (draft.env ?? "") : "",
                        runtime: transport === "stdio" ? (draft.runtime ?? "auto") : "auto",
                        enabled: true,
                      })
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

      function skillForm(tier) {
        if (!editing || editing.kind !== "skill" || editing.tier !== tier.tier) return null
        const scope = tier.scope
        return (
          <li className="smp-card" key="form" data-wide="true">
            <div className="smp-cardDetails" key="body">
              <div className="smp-formGrid" key="grid">
                {skillFieldDefs().map((def) => field(
                  def.label,
                  def.kind === "textarea" ? (
                    <textarea
                      className="smp-textarea" key={def.key}
                      value={draft[def.key] ?? ""}
                      onChange={(e) => setDraft({ ...draft, [def.key]: e.target.value })}
                    />
                  ) : (
                    <input
                      className="smp-input" key={def.key}
                      value={draft[def.key] ?? ""}
                      onChange={(e) => setDraft({ ...draft, [def.key]: e.target.value })}
                    />
                  ),
                  def.kind === "textarea",
                ))}
              </div>
              {error ? <div className="smp-error" key="err" style={{ marginTop: 8 }}>{error}</div> : null}
              <div className="smp-actionsRow" key="actions">
                <button
                  className="smp-button" data-variant="primary" key="save"
                  disabled={busy || !draft.name}
                  onClick={() => {
                    replaceSkill(skillEntryOf(draft, scope))
                    setEditing(null)
                  }}
                >
                  保存到磁盘
                </button>
                <button className="smp-button" data-variant="outline" key="cancel" onClick={() => setEditing(null)}>
                  取消
                </button>
              </div>
              <p className="smp-note" key="hint" style={{ marginTop: 10 }}>
                {scope === "global" ? "写入 $DSH_HOME/skills/<名字>/SKILL.md" : `写入 ${scope}/.agents/skills/<名字>/SKILL.md`}
              </p>
            </div>
          </li>
        )
      }

      /** The two tiers share one renderer: 全局 and 项目级 differ only in scope. */
      function tierSection({ tier, kind, title, subText, list }) {
        // `tier` is the string 'global' | 'project'; the Open key must stay
        // distinct per tier or React reuses one section for both.
        const openKey = `${kind}${tier === 'global' ? 'Global' : 'Project'}`
        const add = addButton(
          tier === 'global' ? 'global' : (project === '' ? null : project),
          kind === 'mcp' ? '添加服务器' : '添加技能',
          () => {
            if (kind === "mcp") {
              setEditing({ kind, tier })
              setDraft({ transport: "streamable-http" })
              return
            }
            const isGlobal = tier === "global"
            const id = isGlobal ? "dsh" : "agents"
            setSkillError("")
            setSkillDraft({ name: "", description: "", body: "" })
            setSkillDialog({
              mode: "add", scope: isGlobal ? "global" : "project", id, project,
              regionKey: `${isGlobal ? "global" : "project"}:${id}`, prevName: "",
            })
          },
        )
        return (
          <section className="smp-group" key={`${kind}:${tier}`}>
            {groupHead(openKey, title, subText, add)}
            {open[openKey] ? list : null}
          </section>
        )
      }

      /**
       * Global MCP entries live in the profile patch as ordinary
       * `@deepseek-ai/dsh-mcp-client` rows — the same place the shipped rows live —
       * so this tier simply lists (and edits) those rows.
       */
      const pendingAdds = pendingAddsOf(inflight, profileRows)

      const mcpGlobalList = (
        <ul className="smp-cards" key="cards">
          {pendingAdds.map(([entryId, info]) => (
            <li className="smp-card" key={`pending:${entryId}`}>
              <div className="smp-cardHead" key="head">
                <span className="smp-pending" key="p">
                  <span className="smp-spinner" key="s" />
                  {`正在写入配置文件…（${String(entryId).replace(/^include:mcp-/, "")}）`}
                </span>
              </div>
            </li>
          ))}
          {editing?.kind === "mcp" && editing.tier === "global" && editing.id === undefined
            ? serverForm({ tier: "global", scope: "global" })
            : null}
          {/* Legacy entries written before global MCP moved into the profile patch:
              still mounted by the panel, so keep them visible until they are migrated. */}
          {serversGlobal.map((server) => card(
            `mcp:legacy/${server.serverName}`,
            `${server.serverName}（旧的面板条目）`,
            server.transport === "stdio" ? `${server.command} ${(server.args ?? []).join(" ")}`.trim() : server.url,
            server.enabled,
            [["传输", server.transport], ["范围", "全局（面板挂载）"]],
            [
              <button
                key="del" className="smp-button" data-variant="danger" disabled={busy}
                onClick={() => setDeleteDialog({
                  label: server.serverName,
                  note: "会从面板的项目级配置里移除这个条目。",
                  run: () => write("servers", removeProjectEntry(servers, server)),
                })}
              >
                删除
              </button>,
            ],
          ))}
          {profileGlobal.map(profileCard)}
          {profileGlobal.length === 0 && serversGlobal.length === 0 ? (
            <li className="smp-empty" key="empty" style={{ gridColumn: "1 / -1" }}>
              还没有全局 MCP —— 点右上角「添加服务器」，会作为一行写进配置文件。
            </li>
          ) : null}
        </ul>
      )

      const mcpProjectList = (
        <ul className="smp-cards" key="cards">
          {serversProject.map((server) => (
            editing?.kind === "mcp" && editing.tier === "project" && editing.id === server.serverName
              ? serverForm({ tier: "project", scope: project })
              : card(
                `mcp:project/${server.serverName}`,
                server.serverName,
                server.transport === "stdio" ? `${server.command} ${(server.args ?? []).join(" ")}`.trim() : server.url,
                server.enabled,
                [
                  ["传输", server.transport],
                  ["命令", server.transport === "stdio" ? `${server.command} ${(server.args ?? []).join(" ")}`.trim() : "—"],
                  ["地址", server.transport === "stdio" ? "—" : server.url],
                  ["环境变量", server.env ? server.env.replace(/=.*/g, "=***") : "—"],
                  ["项目", server.scope],
                ],
                [
                  <button
                    key="edit" className="smp-button" data-variant="outline" disabled={busy}
                    onClick={() => {
                      setEditing({ kind: "mcp", tier: "project", id: server.serverName })
                      setDraft({
                        serverName: server.serverName, transport: server.transport, url: server.url,
                        command: server.command, args: (server.args ?? []).join(" "),
                        env: server.env ?? "", runtime: server.runtime ?? "auto",
                      })
                    }}
                  >
                    编辑
                  </button>,
                  <button
                    key="toggle" className="smp-button" data-variant="outline" disabled={busy}
                    onClick={() => write("servers", replaceProjectEntry(servers, server, { enabled: server.enabled === false }))}
                  >
                    {server.enabled === false ? "启用" : "停用"}
                  </button>,
                  <button
                    key="del" className="smp-button" data-variant="danger" disabled={busy}
                    onClick={() => write("servers", servers.filter((item) => item !== server))}
                  >
                    删除
                  </button>,
                ],
              )
          ))}
          {editing?.kind === "mcp" && editing.tier === "project" && editing.id === undefined
            ? serverForm({ tier: "project", scope: project })
            : null}
          {project !== "" && serversProject.length === 0 ? (
            <li className="smp-empty" key="empty" style={{ gridColumn: "1 / -1" }}>
              {emptyMcpText(projectLabel(project))}
            </li>
          ) : null}
        </ul>
      )

      const skillsGlobalList = (
        <ul className="smp-cards" key="cards">
          {discoveredGlobal.map((skill) => card(
            `disk:${skill.path}`,
            [<span key="n">{skill.name}</span>, tagNode(skill.source, "tag")],
            skill.description || "(无描述)",
            true,
            [["来源", skill.source], ["路径", skill.path]],
            [
              <button className="smp-button" data-variant="outline" key="view" onClick={() => openPreview(skill)}>预览</button>,
              <button
                className="smp-button" data-variant="outline" key="edit" disabled={busy}
                onClick={() => {
                  const parts = String(skill.source).split("-")
                  const scope = parts[0] === "project" ? "project" : "global"
                  const id = parts[1] === "dsh" ? "dsh" : "agents"
                  setSkillError("")
                  setSkillDraft({ name: skill.name, description: skill.description ?? "", body: skill.body ?? "" })
                  setSkillDialog({
                    mode: "edit", scope, id, project: skill.scope === "global" ? "" : skill.scope,
                    regionKey: `${scope}:${id}`, prevName: skill.name, path: skill.path ?? "",
                  })
                  loadSkillBody(skill)
                }}
              >
                编辑
              </button>,
                <button
                  className="smp-button" data-variant="danger" key="del" disabled={busy}
                  onClick={() => confirmDeleteSkill(skill)}
                >
                  删除
                </button>
            ],
          ))}
          {skillsGlobal.map((skill) => card(
            `skill:global/${skill.name}`,
            [<span key="n">{skill.name}</span>, tagNode("user-dsh", "tag")],
            skill.description || "(无描述)",
            skill.enabled,
            [["名称", skill.name], ["描述", skill.description], ["落盘", "$DSH_HOME/skills"]],
            [
              <button
                key="view" className="smp-button" data-variant="outline"
                onClick={() => openPreview({ ...skill, source: "user-dsh", scope: "global", path: skill.path })}
              >
                预览
              </button>,
              <button
                key="view" className="smp-button" data-variant="outline"
                onClick={() => openPreview({ ...skill, source: "project-agents", scope: skill.scope, path: skill.path })}
              >
                预览
              </button>,
              <button
                key="edit" className="smp-button" data-variant="outline" disabled={busy}
                onClick={() => {
                  setEditing({ kind: "skill", tier: "global" })
                  setDraft({ name: skill.name, description: skill.description, body: skill.body })
                }}
              >
                编辑
              </button>,
              <button
                key="del" className="smp-button" data-variant="danger" disabled={busy}
                onClick={() => setDeleteDialog({ label: skill.name, note: "会从面板配置里移除，并删除磁盘上的对应目录（先备份）。", run: () => { setDeleteDialog(null); write("skills", removeSkill(skills, skill)) } })}
              >
                删除
              </button>,
            ],
          ))}
          {skillForm({ tier: "global", scope: "global" })}
          {skillsGlobal.length === 0 && discoveredGlobal.length === 0 && !(editing && editing.kind === "skill" && editing.tier === "global") ? (
            <li className="smp-empty" key="empty" style={{ gridColumn: "1 / -1" }}>
              还没有面板添加的全局技能 —— 点右上角「添加技能」，保存后写入磁盘。
            </li>
          ) : null}
        </ul>
      )

      const skillsProjectList = (
        <ul className="smp-cards" key="cards">
          {discoveredProject.map((skill) => card(
            `disk:${skill.path}`,
            [<span key="n">{skill.name}</span>, tagNode(skill.source, "tag")],
            skill.description || "(无描述)",
            true,
            [["来源", skill.source], ["路径", skill.path]],
            [
              <button className="smp-button" data-variant="outline" key="view" onClick={() => openPreview(skill)}>预览</button>,
              <button
                className="smp-button" data-variant="outline" key="edit" disabled={busy}
                onClick={() => {
                  const parts = String(skill.source).split("-")
                  const scope = parts[0] === "project" ? "project" : "global"
                  const id = parts[1] === "dsh" ? "dsh" : "agents"
                  setSkillError("")
                  setSkillDraft({ name: skill.name, description: skill.description ?? "", body: skill.body ?? "" })
                  setSkillDialog({
                    mode: "edit", scope, id, project: skill.scope === "global" ? "" : skill.scope,
                    regionKey: `${scope}:${id}`, prevName: skill.name, path: skill.path ?? "",
                  })
                  loadSkillBody(skill)
                }}
              >
                编辑
              </button>,
                <button
                  className="smp-button" data-variant="danger" key="del" disabled={busy}
                  onClick={() => confirmDeleteSkill(skill)}
                >
                  删除
                </button>
            ],
          ))}
          {skillsProject.map((skill) => card(
            `skill:project/${skill.name}`,
            [<span key="n">{skill.name}</span>, tagNode("project-agents", "tag")],
            skill.description || "(无描述)",
            skill.enabled,
            [["名称", skill.name], ["描述", skill.description], ["落盘", `${skill.scope}/.agents/skills`]],
            [
              <button
                key="edit" className="smp-button" data-variant="outline" disabled={busy}
                onClick={() => {
                  setEditing({ kind: "skill", tier: "project" })
                  setDraft({ name: skill.name, description: skill.description, body: skill.body })
                }}
              >
                编辑
              </button>,
              <button
                key="del" className="smp-button" data-variant="danger" disabled={busy}
                onClick={() => setDeleteDialog({ label: skill.name, note: "会从面板配置里移除，并删除磁盘上的对应目录（先备份）。", run: () => { setDeleteDialog(null); write("skills", removeSkill(skills, skill)) } })}
              >
                删除
              </button>,
            ],
          ))}
          {skillForm({ tier: "project", scope: project })}
          {project !== "" && skillsProject.length === 0 && discoveredProject.length === 0 ? (
            <li className="smp-empty" key="empty" style={{ gridColumn: "1 / -1" }}>
              {emptySkillText(projectLabel(project))}
            </li>
          ) : null}
        </ul>
      )

      const writableRootList = [
        { scope: "global", id: "dsh" }, { scope: "global", id: "agents" },
        { scope: "project", id: "agents" }, { scope: "project", id: "dsh" },
      ]
      /** Removing a skill from disk is destructive-ish: confirm first (a backup is kept). */
      const confirmDeleteSkill = (skill) => {
        const parts = String(skill.source ?? "").split("-")
        const scope = parts[0] === "project" ? "project" : "global"
        const id = parts[1] === "dsh" ? "dsh" : "agents"
        setDeleteDialog({
          label: skill.name,
          note: "会先把目录备份到同级的 .smp-backup-* 再删除；备份会保留，需要时可手动恢复。",
          run: () => {
            const nonce = String(Date.now())
            setDeleteError("")
            setDeletePending(true)
            setDeleteNonce(nonce)
            setSkillError("")
            setSkillNonce(nonce)
            skillSentAtRef.current = Date.now()
            write("skillRequest", {
              op: "delete", scope, id,
              project: skill.scope === "global" ? "" : skill.scope,
              name: skill.name, prevName: "", description: "", body: "",
              path: skill.path ?? "", nonce,
            })
          },
        })
      }

      /** Load one skill's body on demand before editing it. */
      const loadSkillBody = (skill) => {
        if (!skill?.path) return
        const nonce = String(Date.now())
        setEditBodyPending(true)
        setEditBodyNonce(nonce)
        write("skillRequest", { op: "read", path: skill.path, nonce })
      }

      const openPreview = (skill) => {
        setSkillPreview(skill)
        setPreviewBody("")
        setPreviewPending(true)
        const nonce = String(Date.now())
        setPreviewNonce(nonce)
        // Only the path is sent; the Host answers with the file's body.
        write("skillRequest", { op: "read", path: skill.path ?? "", nonce })
      }

      const skillDialogElement = skillDialogView({
        dialog: skillDialog, draft: skillDraft,
        // Only offer the tier this dialog was opened from: a global entry must not be
        // addable into a project root, and a project entry not into a global root.
        // Edit dialogs inherit the tier from their own regionKey.
        roots: (Array.isArray(writableRootList) ? writableRootList : []).filter(
          (root) => root.scope === (String(skillDialog?.regionKey ?? '').startsWith('project') ? 'project' : 'global'),
        ),
        error: skillError, pending: skillNonce !== "" || editBodyPending, primitives,
        onRegion: (regionKey) => {
          const parts = regionKey.split(":")
          setSkillDialog((current) => (current === null ? current : { ...current, regionKey, scope: parts[0], id: parts[1] }))
        },
        onName: (name) => setSkillDraft((current) => ({ ...current, name })),
        onDescription: (description) => setSkillDraft((current) => ({ ...current, description })),
        onBody: (body) => setSkillDraft((current) => ({ ...current, body })),
        onCancel: () => { setSkillDialog(null); setSkillError(""); setSkillNonce("") },
        onSave: () => {
          if (skillDialog === null) return
          // Never save an edit before the body arrived: it would erase the file.
          if (editBodyPending) return
          const nonce = String(Date.now())
          const isEdit = skillDialog.mode === "edit"
          const renamed = isEdit && (skillDraft.name ?? "") !== skillDialog.prevName
          setSkillError("")
          setSkillNonce(nonce)
          skillSentAtRef.current = Date.now()
          write("skillRequest", {
            op: isEdit ? (renamed ? "rename" : "update") : "create",
            scope: skillDialog.scope, id: skillDialog.id, project: skillDialog.project,
            name: skillDraft.name ?? "", prevName: skillDialog.prevName ?? "",
            description: skillDraft.description ?? "", body: skillDraft.body ?? "",
            nonce,
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
          // Do not close here: a disk delete stays open with 删除中… until the
          // receipt arrives (or shows why it failed).
          const run = deleteDialog?.run
          if (typeof run === 'function') run()
        },
      })

      const mcpSections = [
        <ul className="smp-cards" key="import">{importCard(importScope)}</ul>,
        tierSection({
          tier: "global", kind: "mcp", title: "全局 MCP", list: mcpGlobalList,
          subText: `全局 · 配置文件 ${profileGlobal.length} 个 · 增删改都会写回 cordis.patch.yml（自动备份）`,
        }),
        tierSection({
          tier: "project", kind: "mcp", title: "项目级 MCP", list: mcpProjectList,
          subText: project === "" ? projectMcpSubtitle("", 0) : projectMcpSubtitle(projectLabel(project), serversProject.length),
        }),
      ]

      const skillsSections = [
        tierSection({
          tier: "global", kind: "skills", title: "全局技能", list: skillsGlobalList,
          subText: `全局 · 面板 ${skillsGlobal.length} 个 · 磁盘 ${discoveredGlobal.length} 个 · 写入 ${skillDirs.userDsh || '$DSH_HOME/skills/'}（DSH 也读 ${skillDirs.userAgents || '~/.agents/skills'}）`,
        }),
        tierSection({
          tier: "project", kind: "skills", title: "项目级技能", list: skillsProjectList,
          subText: project === ""
            ? "未选择项目"
            : `${projectSkillSubtitle(projectLabel(project), skillsProject.length)} · 磁盘 ${discoveredProject.length} 个${currentProjectSkillsDir === "" ? "" : `（${currentProjectSkillsDir}）`}`,
        }),
      ]

      return (
        <div className="smp-page">
          <style key="css">{CSS}</style>
          {head}
          {tabs}
          {filterRowView}
          {statusOf(form) === "loading" ? <p className="smp-empty" key="loading">正在读取设置…</p> : null}
          {error && !editing ? <p className="smp-error" key="err">{error}</p> : null}
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
