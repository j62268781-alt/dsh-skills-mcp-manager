import { matchesName } from './components/filters.js'
import { pendingAdds as pendingAddsOf, pendingLabel, settleInflight } from './crud/inflight.js'
import { emptyMcpText, emptySkillText, globalMcpSubtitle, projectMcpSubtitle, projectSkillSubtitle } from './components/sections.js'
import { HINTS } from './components/form.js'
import { detailNodes, rowDetailPairs } from './components/card.js'
import { deleteConfirmDialog } from './components/dialog.js'
import { removeSkill, upsertSkillByName } from './crud/skills.js'
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
    /** Official UI primitives (Modal/Button) — same dialogs the built-in pages use. */
    const primitives = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives')
      } catch {
        return null
      }
    })()
    const h = React.createElement
    const { useState, useEffect, useMemo } = React

    /** Settings namespace = the Host entry id declared in cordis.patch.yml. */
    const NS = 'skills-mcp-panel'

const CSS = panelCss

    /** Read through the settings form's own snapshot store. */
    function snapshotOf(form) {
      const snapshot = form?.getSnapshot?.() ?? form?.store?.getSnapshot?.() ?? form?.snapshot
      return snapshot?.value ?? snapshot ?? {}
    }

    function statusOf(form) {
      const snapshot = form?.getSnapshot?.() ?? form?.store?.getSnapshot?.() ?? form?.snapshot
      return snapshot?.status ?? 'ready'
    }

    function listOf(form, field) {
      const value = snapshotOf(form)?.[field]
      return Array.isArray(value) ? value : []
    }

    const Chevron = ({ open }) => h('svg', {
      className: 'smp-chevron', 'data-open': String(open), width: 16, height: 16,
      viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
    }, h('path', { d: 'M4 6l4 4 4-4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))

    function field(label, control, wide) {
      return h('label', { className: 'smp-field', key: label, 'data-wide': String(Boolean(wide)) }, [
        h('span', { className: 'smp-label', key: 'l' }, label),
        control,
      ])
    }

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

      const rowOpsReady = snapshotOf(form)?.rowOpsReady === true

      // 只按名称搜索（以前是整行 JSON 匹配，会把 URL/参数/环境变量也算进去）
      const matches = (row) => matchesName(row.serverName ?? row.name, query)
      const isGlobal = (row) => (row.scope ?? 'global') === 'global'
      const isProject = (row) => project !== '' && (row.scope ?? 'global') === project

      const serversGlobal = servers.filter((row) => isGlobal(row) && matches(row))
      const serversProject = servers.filter((row) => isProject(row) && matches(row))
      const skillsGlobal = skills.filter((row) => isGlobal(row) && matches(row))
      const skillsProject = skills.filter((row) => isProject(row) && matches(row))
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

      const head = h('div', { className: 'smp-pageHead', key: 'head' }, [
        h('div', { key: 'text' }, [
          h('h2', { className: 'smp-pageTitle', key: 'h' }, 'Skills & MCP'),
          h('p', { className: 'smp-pageIntro', key: 'p' }, '全局与项目级分层管理；保存后立即生效。'),
        ]),
      ])

      const tabs = h('div', { className: 'smp-tabs', key: 'tabs' }, [
        h('button', {
          className: 'smp-tab', 'data-active': tab === 'mcp', key: 'mcp',
          onClick: () => { setTab('mcp'); setEditing(null); setExpanded('') },
        }, `MCP（${serversGlobal.length + profileGlobal.length + serversProject.length}）`),
        h('button', {
          className: 'smp-tab', 'data-active': tab === 'skills', key: 'skills',
          onClick: () => { setTab('skills'); setEditing(null); setExpanded('') },
        }, `Skills（${skillsGlobal.length + skillsProject.length}）`),
      ])

      /** One row holding the search and the project switch, like the reference page. */
      const filterRow = h('div', { className: 'smp-filterRow', key: 'filter' }, [
        h('div', { className: 'smp-search', key: 'search' }, [
          h('span', { className: 'smp-searchIcon', key: 'i' }, h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
            h('path', { d: 'M7 12a5 5 0 100-10 5 5 0 000 10zm3.5-1.5L14 14', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }))),
          h('input', {
            className: 'smp-searchInput', key: 'in',
            placeholder: tab === 'mcp' ? '搜索名称' : '搜索技能名称',
            value: query, onChange: (event) => setQuery(event.target.value),
          }),
        ]),
        customProject
          ? h('input', {
              className: 'smp-projectInput', key: 'custom',
              placeholder: '项目绝对路径', title: '项目级层显示这个路径下的条目',
              value: project, onChange: (event) => setProject(event.target.value),
            })
          : h('select', {
              className: 'smp-projectSelect', key: 'project',
              'data-placeholder': String(project === ''),
              title: '选择项目（来自 DSH 的工作区）',
              value: projectChoices.some(([path]) => path === project) ? project : '',
              onChange: (event) => {
                const value = event.target.value
                if (value === '__custom__') { setCustomProject(true); return }
                setCustomProject(false)
                setProject(value)
              },
            }, [
              h('option', { value: '', key: 'none' }, HINTS.project),
              ...projectChoices.map(([path, title]) => h('option', { value: path, key: path }, title)),
              h('option', { value: '__custom__', key: 'custom' }, '自定义路径…'),
            ]),
        customProject
          ? h('button', {
              className: 'smp-button', 'data-variant': 'outline', key: 'back',
              onClick: () => { setCustomProject(false) },
            }, '选工作区')
          : null,
      ])

      /** Group header: chevron toggle, title, sub line, trailing action. */
      function groupHead(kindKey, title, subText, action) {
        return [
          h('div', { className: 'smp-groupTitleRow', key: 'row' }, [
            h('button', {
              className: 'smp-groupToggle', key: 'toggle',
              onClick: () => setOpen({ ...open, [kindKey]: !open[kindKey] }),
            }, [h(Chevron, { key: 'c', open: open[kindKey] }), h('span', { className: 'smp-groupTitle', key: 't' }, title)]),
            h('span', { style: { flex: 1 }, key: 'sp' }),
            action,
          ]),
          h('div', { className: 'smp-groupSub', key: 'sub' }, subText),
        ]
      }

      /** One managed entry, rendered the way the reference page renders a plugin. */
      function card(key, identity, description, enabled, details, actions) {
        const isOpen = expanded === key
        return h('li', { className: 'smp-card', key }, [
          h('div', { className: 'smp-cardHead', key: 'head' }, [
            h('button', {
              className: 'smp-cardToggle', key: 'toggle', 'aria-expanded': isOpen,
              onClick: () => setExpanded(isOpen ? '' : key),
            }, [
              h(Chevron, { key: 'c', open: isOpen }),
              h('span', { className: 'smp-cardIdentity', key: 'id' }, identity),
              enabled === false ? h('span', { className: 'smp-tag', 'data-tone': 'neutral', key: 'tag' }, '已停用') : null,
            ]),
            h('span', { className: 'smp-cardActions', key: 'actions' }, actions),
          ]),
          description ? h('div', { className: 'smp-cardDescription', key: 'desc' }, description) : null,
          isOpen ? h('div', { className: 'smp-cardDetails', key: 'details' }, [
            h('div', { className: 'smp-details', key: 'grid' },
              details.flatMap(([k, v]) => [
                h('span', { className: 'smp-detailsKey', key: `k-${k}` }, k),
                h('span', { className: 'smp-detailsValue', key: `v-${k}` }, v || '—'),
              ])),
            error ? h('div', { className: 'smp-error', key: 'err', style: { marginTop: 8 } }, error) : null,
          ]) : null,
        ])
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
        return h('li', { className: 'smp-card', key: `profile:${row.entryId}` }, [
          h('div', { className: 'smp-cardHead', key: 'head' }, [
            h('button', {
              className: 'smp-cardToggle', key: 'toggle', 'aria-expanded': rowOpen,
              onClick: () => setExpanded(rowOpen ? '' : rowKey),
            }, [
              h(Chevron, { key: 'c', open: rowOpen }),
              h('span', { className: 'smp-cardIdentity', key: 'name' }, row.serverName || row.entryId),
            ]),
            h('span', { className: 'smp-cardEnd', key: 'end' }, [
              row.enabled === false ? h('span', { className: 'smp-tag', 'data-tone': 'neutral', key: 'off' }, '已停用') : null,
              h('span', { className: 'smp-tag', 'data-tone': 'neutral', key: 'src' }, '配置文件'),
            ]),
            pendingOf(row.entryId) !== null || inflight[row.entryId] !== undefined
              ? h('span', { className: 'smp-cardActions', key: 'pending' }, [
                  h('span', { className: 'smp-pending', key: 'p' }, [
                    h('span', { className: 'smp-spinner', key: 's' }),
                    pendingLabel(inflight[row.entryId] ?? { kind: pendingOf(row.entryId)?.op }),
                  ]),
                ])
              : rowOpsReady ? h('span', { className: 'smp-cardActions', key: 'actions' }, [
              h('button', {
                className: 'smp-button', 'data-variant': 'outline', key: 'toggle', disabled: busy,
                onClick: () => {
                  const expectEnabled = row.enabled === false
                  setInflight((m) => ({ ...m, [row.entryId]: { kind: 'toggle', at: Date.now(), expectEnabled } }))
                  queueRowOp(toggleServerOp(row.entryId, expectEnabled))
                },
              }, row.enabled === false ? '启用' : '停用'),
              h('button', {
                className: 'smp-button', 'data-variant': 'outline', key: 'edit', disabled: busy,
                onClick: () => {
                  setEditing({ kind: 'mcp', tier: 'global', profile: row.entryId, id: row.entryId })
                  setDraft({
                    serverName: row.serverName,
                    transport: row.transport || 'streamable-http',
                    url: row.target,
                    command: row.transport === 'stdio' ? row.target : '',
                  })
                },
              }, '编辑'),
              h('button', {
                className: 'smp-button', 'data-variant': 'danger', key: 'del', disabled: busy,
                onClick: () => {
                  const run = () => { setInflight((m) => ({ ...m, [row.entryId]: { kind: 'delete', at: Date.now() } })); queueRowOp(deleteServerOp(row.entryId)) }
                  if (primitives?.Modal === undefined) { if (window.confirm(`删除「${row.serverName || row.entryId}」？`)) run(); return }
                  setDeleteDialog({ label: row.serverName || row.entryId, note: '会从 cordis.patch.yml 里移除这一行（写入前自动备份）。', run })
                },
              }, '删除'),
            ]) : null,
          ]),
          h('div', { className: 'smp-cardDescription', key: 'desc' },
            row.target
              ? `${row.transport || 'streamable-http'} · ${row.target}`
              : `${String(row.entryId).replace(/^include:/, '')}${row.phase ? ` · ${row.phase}` : ''}`),
          rowOpen ? h('div', { className: 'smp-cardDetails', key: 'details' }, [
            h('div', { className: 'smp-details', key: 'grid' },
              detailNodes(rowDetailPairs(row), h)),
          ]) : null,
        ])
      }

      /** Import sources the Host can scan (ids must match the Host table). */
      const IMPORT_CHOICES = [
        ['claude', 'Claude'],
        ['codex', 'Codex'],
        ['chatgpt', 'ChatGPT'],
        ['cursor', 'Cursor'],
        ['gemini', 'Gemini CLI'],
        ['antigravity', 'Google Antigravity'],
        ['reasonix', 'Reasonix'],
        ['opencode', 'opencode'],
        ['mimocode', 'MimoCode'],
        ['teleagent', 'TeleAgent'],
        ['kilo', 'Kilo Code'],
        ['zcode', 'ZCode'],
        ['grok', 'Grok'],
        ['openclaw', 'OpenClaw'],
        ['pi', 'Pi'],
        ['hermes', 'Hermes'],
        ['kimi', 'KIMI'],
        ['qoder', 'Qoder'],
        ['workbuddy', 'WorkBuddy'],
        ['qwen', 'Qwen'],
        ['continue', 'Continue'],
        ['cline', 'Cline'],
        ['goose', 'goose'],
        ['zed', 'Zed'],
        ['crush', 'Crush'],
      ]

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
          return h('li', { className: 'smp-card', key: 'import' }, [
            h('div', { className: 'smp-cardHead', key: 'head' }, [
              h('span', { className: 'smp-cardIdentity', key: 't' }, scope === 'global' ? '导入 MCP' : '导入 MCP'),
              h('span', { className: 'smp-cardActions', key: 'a' }, [
                h('button', { className: 'smp-button', 'data-variant': 'outline', key: 'go', disabled: busy, onClick: () => setImportOpen(true) }, '选择来源'),
              ]),
            ]),
            h('div', { className: 'smp-cardDescription', key: 'd' },
              scope === 'global'
                ? '从其他编辑器/CLI 的**用户级**配置文件导入（写成配置文件行）。'
                : '从其他编辑器/CLI 的**项目级**文件导入到面板的项目条目。'),
          ])
        }
        return h('li', { className: 'smp-card', key: 'import' }, [
          h('div', { className: 'smp-cardHead', key: 'head' }, [
            h('span', { className: 'smp-cardIdentity', key: 't' }, scope === 'global' ? '导入全局 MCP' : '导入项目 MCP'),
            h('span', { className: 'smp-cardActions', key: 'a' }, [
              h('button', { className: 'smp-button', 'data-variant': 'outline', key: 'close', onClick: () => setImportOpen(false) }, '收起'),
            ]),
          ]),
          h('div', { className: 'smp-segment', key: 'segment' }, [
            h('button', { key: 'g', 'data-active': String(scope === 'global'), onClick: () => setImportScope('global') }, '全局'),
            h('button', { key: 'p', 'data-active': String(scope === 'project'), onClick: () => setImportScope('project') }, '项目级'),
          ]),
          h('div', { className: 'smp-formGrid', key: 'grid' }, [
            field('来源', h('select', {
              className: 'smp-select', value: importSource,
              onChange: (event) => setImportSource(event.target.value),
            }, IMPORT_CHOICES.map(([id, label]) => h('option', { value: id, key: id }, label)))),
            scope === 'global'
              ? null
              : importCustomProject
                ? field('项目路径', h('div', { className: 'smp-actionsRow', style: { marginTop: 0 } }, [
                    h('input', {
                      className: 'smp-input', placeholder: '项目绝对路径', style: { flex: '1 1 auto' },
                      value: importProject, onChange: (event) => setImportProject(event.target.value),
                    }),
                    h('button', {
                      className: 'smp-button', 'data-variant': 'outline', key: 'back',
                      onClick: () => setImportCustomProject(false),
                    }, '选工作区'),
                  ]))
                : field('项目', h('div', { className: 'smp-actionsRow', style: { marginTop: 0 } }, [
                    h('select', {
                      className: 'smp-select', value: importProject, style: { flex: '1 1 auto' },
                      onChange: (event) => {
                        if (event.target.value === '__custom__') { setImportCustomProject(true); return }
                        setImportProject(event.target.value)
                      },
                    }, [
                      h('option', { value: '', key: 'none' }, '选择一个工作区…'),
                      ...projectChoices.map(([path, title]) => h('option', { value: path, key: path }, title)),
                      h('option', { value: '__custom__', key: 'custom' }, '自定义路径…'),
                    ]),
                    importProject !== ''
                      ? h('button', {
                          className: 'smp-button', 'data-variant': 'outline', key: 'clear',
                          onClick: () => setImportProject(''),
                        }, '清除')
                      : null,
                  ])),
          ]),
          needsProject
            ? h('div', { className: 'smp-cardDescription', key: 'need' }, '先选择一个工作区（或切到「全局」读用户级配置）。')
            : result === null
            ? h('div', { className: 'smp-cardDescription', key: 'hint' }, '点「扫描」后，会把该工具在项目里的 MCP 文件与能导入的条目列出来。')
            : h('div', { key: 'result' }, [
                ...result.files.map((file) => h('div', { className: 'smp-cardDescription', key: file.path },
                  `${file.exists ? '✓' : '✗'} ${file.path}${file.exists ? ` · 识别 ${file.servers.length} 个${file.unsupported > 0 ? `（${file.unsupported} 个形态不支持）` : ''}` : ' · 文件不存在'}${file.error !== null && file.error !== '' ? ` · ${file.error}` : ''}`)),
                result.error !== null && result.error !== '' ? h('div', { className: 'smp-error', key: 'err' }, result.error) : null,
                h('div', { className: 'smp-cardDescription', key: 'sum' },
                  `新增 ${freshServers.length} 个：${freshServers.map((server) => server.serverName).join('、') || '—'}`),
                skippedServers.length > 0
                  ? h('div', { className: 'smp-cardDescription', key: 'skip' },
                      `已存在 ${skippedServers.length} 个（跳过，不覆盖）：${skippedServers.map((server) => server.serverName).join('、')}`)
                  : null,
              ]),
          h('div', { className: 'smp-actionsRow', key: 'actions' }, [
            h('button', {
              className: 'smp-button', 'data-variant': 'primary', key: 'scan',
              disabled: busy || (scope === 'project' && target === ''),
              onClick: () => write('importRequest', {
                source: importSource, scope, project: target, nonce: String(Date.now()),
              }),
            }, '扫描'),
            result !== null && freshServers.length > 0
              ? h('button', {
                  className: 'smp-button', 'data-variant': 'outline', key: 'do',
                  disabled: busy || (scope === 'global' && !rowOpsReady),
                  onClick: () => {
                    if (scope === 'global') {
                      // Global MCP lives in the profile patch: one row per import.
                      const existing = new Set(profileRows.map((row) => row.serverName))
                      for (const server of result.servers) {
                        if (existing.has(server.serverName)) continue
                        queueRowOp(addServerOp({
                          serverName: server.serverName, transport: server.transport,
                          url: server.transport === 'stdio' ? '' : server.url,
                          command: server.transport === 'stdio' ? server.command : '',
                          args: server.transport === 'stdio' ? (server.args ?? []).join(' ') : '',
                          env: server.env ?? '', headers: server.headers ?? '',
                        }))
                      }
                      return
                    }
                    const existing = new Set(servers.map((server) => server.serverName))
                    const fresh = result.servers.filter((server) => !existing.has(server.serverName))
                    write('servers', [...servers, ...fresh])
                  },
                }, importLabel({ scope, fresh: freshServers.length, skipped: skippedServers.length }))
              : null,
          ]),
        ])
      }

      const addButton = (tier, label, onClick) => h('button', {
        className: 'smp-button', 'data-variant': 'primary', key: 'add',
        disabled: !tier || busy,
        onClick,
      }, label)

      function serverForm(tier) {
        if (!editing || editing.kind !== 'mcp' || editing.tier !== tier.tier) return null
        const scope = tier.scope
        const profileEntry = typeof editing.profile === 'string' && editing.profile !== '' ? editing.profile : null
        return h('li', { className: 'smp-card', key: 'form', 'data-wide': 'true' }, [
          h('div', { className: 'smp-cardDetails', key: 'body' }, [
            h('div', { className: 'smp-formGrid', key: 'grid' }, [
              field('名称（serverName）', h('input', {
                className: 'smp-input',
                placeholder: '例如 test，最多 32 字符',
                value: draft.serverName ?? '',
                onChange: (e) => setDraft({ ...draft, serverName: e.target.value }),
              })),
              field('传输', h('select', { className: 'smp-select', value: draft.transport ?? 'streamable-http', onChange: (e) => setDraft({ ...draft, transport: e.target.value }) }, [
                h('option', { value: 'streamable-http', key: 'h' }, 'streamable-http'),
                h('option', { value: 'stdio', key: 's' }, 'stdio'),
              ])),
              (draft.transport ?? 'streamable-http') === 'stdio'
                ? field('命令', h('input', { className: 'smp-input', placeholder: HINTS.command, value: draft.command ?? '', onChange: (e) => setDraft({ ...draft, command: e.target.value }) }))
                : field('URL', h('input', { className: 'smp-input', placeholder: HINTS.url, value: draft.url ?? '', onChange: (e) => setDraft({ ...draft, url: e.target.value }) })),
              (draft.transport ?? 'streamable-http') === 'stdio'
                ? field('参数（空格分隔）', h('input', { className: 'smp-input', placeholder: HINTS.args, value: draft.args ?? '', onChange: (e) => setDraft({ ...draft, args: e.target.value }) }))
                : null,
              (draft.transport ?? 'streamable-http') === 'stdio' && tier.tier !== 'global'
                ? field('运行时', h('select', {
                    className: 'smp-select',
                    value: draft.runtime ?? 'auto',
                    onChange: (e) => setDraft({ ...draft, runtime: e.target.value }),
                  }, [
                    h('option', { value: 'auto', key: 'auto' }, '跟随 Harness（自带 node + pnpx，推荐）'),
                    h('option', { value: 'system', key: 'system' }, '系统 npx（个别老包不兼容 pnpm）'),
                  ]))
                : null,
              (draft.transport ?? 'streamable-http') === 'stdio'
                ? field('环境变量（KEY=VALUE，每行一个）', h('textarea', { className: 'smp-textarea', rows: 3, placeholder: HINTS.env, value: draft.env ?? '', onChange: (e) => setDraft({ ...draft, env: e.target.value }) }), true)
                : null,
            ]),
            error ? h('div', { className: 'smp-error', key: 'err', style: { marginTop: 8 } }, error) : null,
            profileEntry !== null
              ? h('p', { className: 'smp-note', key: 'note', style: { marginTop: 8 } },
                  `改的是配置文件行 ${profileEntry.replace(/^include:/, '')}，Host 会写回 profile patch（自动备份）。`)
              : null,
            h('div', { className: 'smp-actionsRow', key: 'actions' }, [
              h('button', {
                className: 'smp-button', 'data-variant': 'primary', key: 'save',
                disabled: busy || !draft.serverName,
                onClick: () => {
                  const transport = draft.transport ?? 'streamable-http'
                  const argList = String(draft.args ?? '').trim() === '' ? [] : String(draft.args).trim().split(/\s+/)
                  if (profileEntry !== null) {
                    // Edit the row in place: the Host rewrites the profile patch.
                    setInflight((m) => ({ ...m, [profileEntry]: { kind: 'update', at: Date.now(), expectName: draft.serverName ?? '' } }))
                    queueRowOp(updateServerOp(profileEntry, {
                      serverName: draft.serverName ?? '', transport,
                      url: transport === 'stdio' ? '' : (draft.url ?? ''),
                      command: transport === 'stdio' ? (draft.command ?? '') : '',
                      args: transport === 'stdio' ? String(draft.args ?? '') : '',
                      env: transport === 'stdio' ? String(draft.env ?? '') : '',
                    }))
                  } else if (tier.tier === 'global') {
                    // A global MCP becomes a real profile row, exactly like the
                    // shipped ones; the Host writes it (lock + backup + validation).
                    setInflight((m) => ({ ...m, [inflightKeyForRow(rowEntryId(draft.serverName))]: { kind: 'add', at: Date.now() } }))
                    queueRowOp(addServerOp({
                      serverName: draft.serverName ?? '', transport,
                      url: transport === 'stdio' ? '' : (draft.url ?? ''),
                      command: transport === 'stdio' ? (draft.command ?? '') : '',
                      args: transport === 'stdio' ? String(draft.args ?? '') : '',
                      env: transport === 'stdio' ? String(draft.env ?? '') : '',
                    }))
                  } else {
                    replaceServer({
                      scope, id: draft.serverName, serverName: draft.serverName, transport,
                      url: transport === 'stdio' ? '' : (draft.url ?? ''),
                      command: transport === 'stdio' ? (draft.command ?? '') : '',
                      args: transport === 'stdio' ? argList : [],
                      env: transport === 'stdio' ? (draft.env ?? '') : '',
                      runtime: transport === 'stdio' ? (draft.runtime ?? 'auto') : 'auto',
                      enabled: true,
                    })
                  }
                  setEditing(null)
                },
              }, profileEntry !== null ? '保存到配置行' : '保存'),
              h('button', { className: 'smp-button', 'data-variant': 'outline', key: 'cancel', onClick: () => setEditing(null) }, '取消'),
            ]),
          ]),
        ])
      }

      function skillForm(tier) {
        if (!editing || editing.kind !== 'skill' || editing.tier !== tier.tier) return null
        const scope = tier.scope
        return h('li', { className: 'smp-card', key: 'form', 'data-wide': 'true' }, [
          h('div', { className: 'smp-cardDetails', key: 'body' }, [
            h('div', { className: 'smp-formGrid', key: 'grid' }, [
              field('技能名', h('input', { className: 'smp-input', value: draft.name ?? '', onChange: (e) => setDraft({ ...draft, name: e.target.value }) })),
              field('描述', h('input', { className: 'smp-input', value: draft.description ?? '', onChange: (e) => setDraft({ ...draft, description: e.target.value }) })),
              field('正文（SKILL.md）', h('textarea', { className: 'smp-textarea', value: draft.body ?? '', onChange: (e) => setDraft({ ...draft, body: e.target.value }) }), true),
            ]),
            error ? h('div', { className: 'smp-error', key: 'err', style: { marginTop: 8 } }, error) : null,
            h('div', { className: 'smp-actionsRow', key: 'actions' }, [
              h('button', {
                className: 'smp-button', 'data-variant': 'primary', key: 'save',
                disabled: busy || !draft.name,
                onClick: () => {
                  replaceSkill({ scope, name: draft.name, description: draft.description ?? '', body: draft.body ?? '', enabled: true })
                  setEditing(null)
                },
              }, '保存到磁盘'),
              h('button', { className: 'smp-button', 'data-variant': 'outline', key: 'cancel', onClick: () => setEditing(null) }, '取消'),
            ]),
            h('p', { className: 'smp-note', key: 'hint', style: { marginTop: 10 } },
              scope === 'global' ? '写入 $DSH_HOME/skills/<名字>/SKILL.md' : `写入 ${scope}/.agents/skills/<名字>/SKILL.md`),
          ]),
        ])
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
            setEditing({ kind, tier })
            setDraft(kind === 'mcp' ? { transport: 'streamable-http' } : { name: '', description: '', body: '' })
          },
        )
        return h('section', { className: 'smp-group', key: `${kind}:${tier}` }, [
          ...groupHead(openKey, title, subText, add),
          open[openKey] ? list : null,
        ])
      }

      /**
       * Global MCP entries live in the profile patch as ordinary
       * `@deepseek-ai/dsh-mcp-client` rows — the same place the shipped rows live —
       * so this tier simply lists (and edits) those rows.
       */
      const pendingAdds = pendingAddsOf(inflight, profileRows)

      const mcpGlobalList = h('ul', { className: 'smp-cards', key: 'cards' }, [
        ...pendingAdds.map(([entryId, info]) => h('li', { className: 'smp-card', key: `pending:${entryId}` }, [
          h('div', { className: 'smp-cardHead', key: 'head' }, [
            h('span', { className: 'smp-pending', key: 'p' }, [
              h('span', { className: 'smp-spinner', key: 's' }),
              `正在写入配置文件…（${String(entryId).replace(/^include:mcp-/, '')}）`,
            ]),
          ]),
        ])),
        editing?.kind === 'mcp' && editing.tier === 'global' && editing.id === undefined ? serverForm({ tier: 'global', scope: 'global' }) : null,
        // Legacy entries written before global MCP moved into the profile patch:
        // still mounted by the panel, so keep them visible until they are migrated.
        ...serversGlobal.map((server) => card(
          `mcp:legacy/${server.serverName}`,
          `${server.serverName}（旧的面板条目）`,
          server.transport === 'stdio' ? `${server.command} ${(server.args ?? []).join(' ')}`.trim() : server.url,
          server.enabled,
          [['传输', server.transport], ['范围', '全局（面板挂载）']],
          [
            h('button', {
              className: 'smp-button', 'data-variant': 'danger', key: 'del', disabled: busy,
              onClick: () => setDeleteDialog({
                label: server.serverName,
                note: '会从面板的项目级配置里移除这个条目。',
                run: () => write('servers', removeProjectEntry(servers, server)),
              }),
            }, '删除'),
          ],
        )),
        ...profileGlobal.map(profileCard),
        profileGlobal.length === 0 && serversGlobal.length === 0
          ? h('li', { className: 'smp-empty', key: 'empty', style: { gridColumn: '1 / -1' } }, '还没有全局 MCP —— 点右上角「添加服务器」，会作为一行写进配置文件。')
          : null,
      ])

      const mcpProjectList = h('ul', { className: 'smp-cards', key: 'cards' }, [
        ...serversProject.map((server) => (editing?.kind === 'mcp' && editing.tier === 'project' && editing.id === server.serverName
          ? serverForm({ tier: 'project', scope: project })
          : card(
          `mcp:project/${server.serverName}`,
          server.serverName,
          server.transport === 'stdio' ? `${server.command} ${(server.args ?? []).join(' ')}`.trim() : server.url,
          server.enabled,
          [['传输', server.transport], ['命令', server.transport === 'stdio' ? `${server.command} ${(server.args ?? []).join(' ')}`.trim() : '—'], ['地址', server.transport === 'stdio' ? '—' : server.url], ['环境变量', server.env ? server.env.replace(/=.*/g, '=***') : '—'], ['项目', server.scope]],
          [
            h('button', {
              className: 'smp-button', 'data-variant': 'outline', key: 'edit', disabled: busy,
              onClick: () => { setEditing({ kind: 'mcp', tier: 'project', id: server.serverName }); setDraft({ serverName: server.serverName, transport: server.transport, url: server.url, command: server.command, args: (server.args ?? []).join(' '), env: server.env ?? '', runtime: server.runtime ?? 'auto' }) },
            }, '编辑'),
            h('button', {
              className: 'smp-button', 'data-variant': 'outline', key: 'toggle', disabled: busy,
              onClick: () => write('servers', replaceProjectEntry(servers, server, { enabled: server.enabled === false })),
            }, server.enabled === false ? '启用' : '停用'),
            h('button', {
              className: 'smp-button', 'data-variant': 'danger', key: 'del', disabled: busy,
              onClick: () => write('servers', servers.filter((item) => item !== server)),
            }, '删除'),
          ],
        ))),
        editing?.kind === 'mcp' && editing.tier === 'project' && editing.id === undefined ? serverForm({ tier: 'project', scope: project }) : null,
        project !== '' && serversProject.length === 0
          ? h('li', { className: 'smp-empty', key: 'empty', style: { gridColumn: '1 / -1' } }, emptyMcpText(projectLabel(project)))
          : null,
      ])

      const skillsGlobalList = h('ul', { className: 'smp-cards', key: 'cards' }, [
        ...skillsGlobal.map((skill) => card(
          `skill:global/${skill.name}`,
          skill.name,
          skill.description || '(无描述)',
          skill.enabled,
          [['名称', skill.name], ['描述', skill.description], ['落盘', '$DSH_HOME/skills']],
          [
            h('button', {
              className: 'smp-button', 'data-variant': 'outline', key: 'edit', disabled: busy,
              onClick: () => { setEditing({ kind: 'skill', tier: 'global' }); setDraft({ name: skill.name, description: skill.description, body: skill.body }) },
            }, '编辑'),
            h('button', {
              className: 'smp-button', 'data-variant': 'danger', key: 'del', disabled: busy,
              onClick: () => write('skills', removeSkill(skills, skill)),
            }, '删除'),
          ],
        )),
        skillForm({ tier: 'global', scope: 'global' }),
        skillsGlobal.length === 0 && !(editing && editing.kind === 'skill' && editing.tier === 'global')
          ? h('li', { className: 'smp-empty', key: 'empty', style: { gridColumn: '1 / -1' } }, '还没有面板添加的全局技能 —— 点右上角「添加技能」，保存后写入磁盘。')
          : null,
      ])

      const skillsProjectList = h('ul', { className: 'smp-cards', key: 'cards' }, [
        ...skillsProject.map((skill) => card(
          `skill:project/${skill.name}`,
          skill.name,
          skill.description || '(无描述)',
          skill.enabled,
          [['名称', skill.name], ['描述', skill.description], ['落盘', `${skill.scope}/.agents/skills`]],
          [
            h('button', {
              className: 'smp-button', 'data-variant': 'outline', key: 'edit', disabled: busy,
              onClick: () => { setEditing({ kind: 'skill', tier: 'project' }); setDraft({ name: skill.name, description: skill.description, body: skill.body }) },
            }, '编辑'),
            h('button', {
              className: 'smp-button', 'data-variant': 'danger', key: 'del', disabled: busy,
              onClick: () => write('skills', removeSkill(skills, skill)),
            }, '删除'),
          ],
        )),
        skillForm({ tier: 'project', scope: project }),
        project !== '' && skillsProject.length === 0
          ? h('li', { className: 'smp-empty', key: 'empty', style: { gridColumn: '1 / -1' } }, emptySkillText(projectLabel(project)))
          : null,
      ])

      const confirmDeleteDialog = deleteConfirmDialog({
        dialog: deleteDialog,
        primitives,
        h,
        onCancel: () => setDeleteDialog(null),
        onConfirm: () => {
          const run = deleteDialog?.run
          setDeleteDialog(null)
          if (typeof run === 'function') run()
        },
      })

      const mcpSections = [
        h('ul', { className: 'smp-cards', key: 'import' }, [importCard(importScope)]),
        tierSection({
          tier: 'global', kind: 'mcp', title: '全局 MCP', list: mcpGlobalList,
          subText: `全局 · 配置文件 ${profileGlobal.length} 个 · 增删改都会写回 cordis.patch.yml（自动备份）`,
        }),
        tierSection({
          tier: 'project', kind: 'mcp', title: '项目级 MCP', list: mcpProjectList,
          subText: project === '' ? projectMcpSubtitle('', 0) : projectMcpSubtitle(projectLabel(project), serversProject.length),
        }),
      ]

      const skillsSections = [
        tierSection({
          tier: 'global', kind: 'skills', title: '全局技能', list: skillsGlobalList,
          subText: `全局 · 面板添加 ${skillsGlobal.length} 个 · 写入 $DSH_HOME/skills/`,
        }),
        tierSection({
          tier: 'project', kind: 'skills', title: '项目级技能', list: skillsProjectList,
          subText: project === '' ? '未选择项目' : projectSkillSubtitle(projectLabel(project), skillsProject.length),
        }),
      ]

      return h('div', { className: 'smp-page' }, [
        h('style', { key: 'css' }, CSS),
        head,
        tabs,
        filterRow,
        statusOf(form) === 'loading' ? h('p', { className: 'smp-empty', key: 'loading' }, '正在读取设置…') : null,
        error && !editing ? h('p', { className: 'smp-error', key: 'err' }, error) : null,
        confirmDeleteDialog,
        ...(tab === 'mcp' ? mcpSections : skillsSections),
        debugOn
          ? h('section', { className: 'smp-group', key: 'debug' }, [
              h('div', { className: 'smp-groupTitleRow', key: 'h' }, h('span', { className: 'smp-groupTitle' }, `Loader 诊断：共 ${inventoryRows.length} 行，其中 mcp 相关 ${debugMcp.length} 行`)),
              h('ul', { className: 'smp-cards', key: 'list' },
                debugMcp.map((row) => h('li', { className: 'smp-card', key: row.entryId }, [
                  h('div', { className: 'smp-cardContent', key: 'c', style: { cursor: 'default' } }, [
                    h('div', { className: 'smp-cardMainRow', key: 'r' }, [
                      h('span', { className: 'smp-cardIdentity', key: 'i' }, row.entryId),
                      h('span', { className: 'smp-cardEnd', key: 'e' }, h('span', { className: 'smp-tag', 'data-tone': 'neutral' }, `${row.enabled ? 'on' : 'off'}${row.fiberPhase ? ` · ${row.fiberPhase}` : ''}`)),
                    ]),
                    h('div', { className: 'smp-cardDescription', key: 'd' }, row.moduleName),
                  ]),
                ]))),
            ])
          : null,
      ])
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
