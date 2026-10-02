// lib/src/components/chevron.jsx
function Chevron({ open }) {
  return /* @__PURE__ */ __dshReact.createElement(
    "svg",
    {
      className: "smp-chevron",
      "data-open": String(open),
      width: 16,
      height: 16,
      viewBox: "0 0 16 16",
      fill: "none",
      "aria-hidden": "true"
    },
    /* @__PURE__ */ __dshReact.createElement(
      "path",
      {
        d: "M4 6l4 4 4-4",
        stroke: "currentColor",
        strokeWidth: 1.4,
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    )
  );
}

// lib/src/components/field.jsx
function field(label, control, wide) {
  return /* @__PURE__ */ __dshReact.createElement("label", { className: "smp-field", key: label, "data-wide": Boolean(wide) }, /* @__PURE__ */ __dshReact.createElement("span", { className: "smp-label", key: "l" }, label), control);
}

// lib/src/components/group.jsx
function groupHead({ Chevron: Chevron2, open, onToggle, title, subText, action }) {
  return [
    /* @__PURE__ */ __dshReact.createElement("div", { className: "smp-groupTitleRow", key: "row" }, /* @__PURE__ */ __dshReact.createElement("button", { className: "smp-groupToggle", key: "toggle", onClick: onToggle }, /* @__PURE__ */ __dshReact.createElement(Chevron2, { key: "c", open }), /* @__PURE__ */ __dshReact.createElement("span", { className: "smp-groupTitle", key: "t" }, title)), /* @__PURE__ */ __dshReact.createElement("span", { style: { flex: 1 }, key: "sp" }), action),
    /* @__PURE__ */ __dshReact.createElement("div", { className: "smp-groupSub", key: "sub" }, subText)
  ];
}

// lib/src/components/form.js
var HINTS = {
  serverName: "\u4F8B\u5982 context7\uFF0C\u6700\u591A 32 \u5B57\u7B26",
  command: "npx",
  args: "-y @scope/pkg@latest",
  env: "TEST_TOKEN=sk-xxxxxxx\n\u591A\u4E2A\u53D8\u91CF\u4E00\u884C\u4E00\u4E2A\uFF0C\u4F8B\u5982\uFF1A\nAPI_KEY=sk-abc\nREGION=cn",
  url: "https://\u2026/mcp",
  project: "\u8BF7\u9009\u62E9\u9879\u76EE"
};
function skillFieldDefs() {
  return [
    { key: "name", label: "\u6280\u80FD\u540D", hint: "\u4F8B\u5982 code-review\uFF0C\u6700\u591A 64 \u5B57\u7B26" },
    { key: "description", label: "\u63CF\u8FF0", hint: "\u4E00\u53E5\u8BDD\u8BF4\u660E\u8FD9\u4E2A\u6280\u80FD\u505A\u4EC0\u4E48" },
    { key: "body", label: "\u6B63\u6587\uFF08SKILL.md\uFF09", kind: "textarea" }
  ];
}

// lib/src/components/filterRow.jsx
function filterRow({
  query,
  onQuery,
  project,
  projectChoices = [],
  customProject = false,
  onCustomProject,
  onProject,
  placeholder
}) {
  return /* @__PURE__ */ __dshReact.createElement("div", { className: "smp-filterRow", key: "filter" }, /* @__PURE__ */ __dshReact.createElement("div", { className: "smp-search", key: "search" }, /* @__PURE__ */ __dshReact.createElement("span", { className: "smp-searchIcon", key: "i" }, /* @__PURE__ */ __dshReact.createElement("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" }, /* @__PURE__ */ __dshReact.createElement(
    "path",
    {
      d: "M7 12a5 5 0 100-10 5 5 0 000 10zm3.5-1.5L14 14",
      stroke: "currentColor",
      strokeWidth: 1.3,
      strokeLinecap: "round"
    }
  ))), /* @__PURE__ */ __dshReact.createElement(
    "input",
    {
      className: "smp-searchInput",
      key: "in",
      placeholder,
      value: query,
      onChange: (event) => onQuery(event.target.value)
    }
  )), customProject ? /* @__PURE__ */ __dshReact.createElement(
    "input",
    {
      className: "smp-projectInput",
      key: "custom",
      placeholder: "\u9879\u76EE\u7EDD\u5BF9\u8DEF\u5F84",
      title: "\u9879\u76EE\u7EA7\u5C42\u663E\u793A\u8FD9\u4E2A\u8DEF\u5F84\u4E0B\u7684\u6761\u76EE",
      value: project,
      onChange: (event) => onProject(event.target.value)
    }
  ) : /* @__PURE__ */ __dshReact.createElement(
    "select",
    {
      className: "smp-projectSelect",
      key: "project",
      "data-placeholder": project === "",
      title: "\u9009\u62E9\u9879\u76EE\uFF08\u6765\u81EA DSH \u7684\u5DE5\u4F5C\u533A\uFF09",
      value: projectChoices.some(([path]) => path === project) ? project : "",
      onChange: (event) => {
        const value = event.target.value;
        if (value === "__custom__") {
          onCustomProject(true);
          return;
        }
        onCustomProject(false);
        onProject(value);
      }
    },
    /* @__PURE__ */ __dshReact.createElement("option", { value: "", key: "none" }, HINTS.project),
    projectChoices.map(([path, title]) => /* @__PURE__ */ __dshReact.createElement("option", { value: path, key: path }, title)),
    /* @__PURE__ */ __dshReact.createElement("option", { value: "__custom__", key: "custom" }, "\u81EA\u5B9A\u4E49\u8DEF\u5F84\u2026")
  ), customProject ? /* @__PURE__ */ __dshReact.createElement(
    "button",
    {
      className: "smp-button",
      "data-variant": "outline",
      key: "back",
      onClick: () => onCustomProject(false)
    },
    "\u9009\u5DE5\u4F5C\u533A"
  ) : null);
}

// lib/src/components/filters.js
function matchesName(name, query) {
  const needle = (query ?? "").trim().toLowerCase();
  if (needle === "") return true;
  if (typeof name !== "string") return false;
  return name.toLowerCase().includes(needle);
}
function tabLabel(title, count) {
  return `${title}\uFF08${count}\uFF09`;
}

// lib/src/components/tabs.jsx
var TAB_ITEMS = [
  { id: "mcp", title: "MCP" },
  { id: "skills", title: "Skills" }
];
function tabStrip({ active, counts = {}, onSelect }) {
  return /* @__PURE__ */ __dshReact.createElement("div", { className: "smp-tabs", key: "tabs" }, TAB_ITEMS.map((item) => /* @__PURE__ */ __dshReact.createElement(
    "button",
    {
      key: item.id,
      className: "smp-tab",
      "data-active": active === item.id,
      onClick: () => onSelect(item.id)
    },
    tabLabel(item.title, counts[item.id] ?? 0)
  )));
}

// lib/src/components/head.jsx
var PAGE_TITLE = "Skills & MCP";
var PAGE_INTRO = "\u5168\u5C40\u4E0E\u9879\u76EE\u7EA7\u5206\u5C42\u7BA1\u7406\uFF1B\u4FDD\u5B58\u540E\u7ACB\u5373\u751F\u6548\u3002";
function pageHead() {
  return /* @__PURE__ */ __dshReact.createElement("div", { className: "smp-pageHead", key: "head" }, /* @__PURE__ */ __dshReact.createElement("div", { key: "text" }, /* @__PURE__ */ __dshReact.createElement("h2", { className: "smp-pageTitle", key: "h" }, PAGE_TITLE), /* @__PURE__ */ __dshReact.createElement("p", { className: "smp-pageIntro", key: "p" }, PAGE_INTRO)));
}

// lib/src/crud/inflight.js
var DEFAULT_TIMEOUT = 15e3;
var UPDATE_GRACE = 4e3;
function pendingLabel(info) {
  switch (info?.kind) {
    case "delete":
      return "\u5220\u9664\u4E2D\u2026";
    case "toggle":
      return "\u5207\u6362\u4E2D\u2026";
    case "add":
      return "\u6B63\u5728\u5199\u5165\u914D\u7F6E\u6587\u4EF6\u2026";
    default:
      return "\u4FDD\u5B58\u4E2D\u2026";
  }
}
function hasSettled(info, row, now = Date.now()) {
  const age = now - (info?.at ?? now);
  switch (info?.kind) {
    case "delete":
      return row === void 0;
    // 行已消失（例如被别处删掉）时该操作已无意义，直接算完成，免得空转
    case "toggle":
      return row === void 0 || row.enabled === info.expectEnabled;
    case "add":
      return row !== void 0;
    case "update":
      return row !== void 0 && (row.serverName === info.expectName || age > UPDATE_GRACE);
    default:
      return true;
  }
}
function settleInflight(map = {}, { profileRows = [], now = Date.now(), timeout = DEFAULT_TIMEOUT } = {}) {
  const entries = Object.entries(map);
  if (entries.length === 0) return map;
  const kept = {};
  for (const [entryId, info] of entries) {
    const row = profileRows.find((candidate) => candidate.entryId === entryId);
    if (hasSettled(info, row, now)) continue;
    if (now - (info?.at ?? now) >= timeout) continue;
    kept[entryId] = info;
  }
  return Object.keys(kept).length === entries.length ? map : kept;
}
function pendingAdds(map = {}, profileRows = []) {
  return Object.entries(map).filter(([entryId, info]) => info.kind === "add" && !profileRows.some((row) => row.entryId === entryId));
}

// lib/src/components/sections.js
function projectMcpSubtitle(label, count) {
  return label === "" ? "\u672A\u9009\u62E9\u9879\u76EE \xB7 \u9762\u677F\u6DFB\u52A0\u7684\u6761\u76EE\u53EA\u6302\u8F7D\u5230\u8BE5\u9879\u76EE\u5185\u8FD0\u884C\u7684 agent" : `${label} \xB7 \u9762\u677F\u6DFB\u52A0 ${count} \u4E2A \xB7 \u53EA\u6302\u8F7D\u5230\u8BE5\u9879\u76EE\u5185\u8FD0\u884C\u7684 agent`;
}
function projectSkillSubtitle(label, count) {
  return label === "" ? "\u672A\u9009\u62E9\u9879\u76EE" : `${label} \xB7 \u9762\u677F\u6DFB\u52A0 ${count} \u4E2A \xB7 \u5199\u5165 <\u9879\u76EE>/.agents/skills/`;
}
function emptyMcpText(label) {
  return `${label} \u8FD8\u6CA1\u6709\u9879\u76EE\u7EA7 MCP \u2014\u2014 \u53EF\u4EE5\u70B9\u4E0A\u9762\u300C\u6DFB\u52A0\u670D\u52A1\u5668\u300D\uFF0C\u6216\u7528\u300C\u5BFC\u5165 MCP\u300D\u4ECE\u5176\u4ED6\u5DE5\u5177\u5BFC\u5165\u3002`;
}
function emptySkillText(label) {
  return `${label} \u8FD8\u6CA1\u6709\u9879\u76EE\u7EA7\u6280\u80FD\u3002`;
}

// lib/src/components/card.jsx
function maskEnv(env) {
  if (typeof env !== "string" || env.trim() === "") return "\u2014";
  return env.replace(/=.*/g, "=***");
}
function rowDetailPairs(row = {}) {
  const transport = row.transport || "streamable-http";
  const stdio = transport === "stdio";
  return [
    ["\u884C id", String(row.entryId ?? "").replace(/^include:/, "")],
    ["\u4F20\u8F93", transport],
    ["\u5730\u5740", stdio ? "\u2014" : row.target || "\u2014"],
    ["\u547D\u4EE4", stdio ? row.target || "\u2014" : "\u2014"],
    ["\u53C2\u6570", row.args ? row.args : "\u2014"],
    ["\u73AF\u5883\u53D8\u91CF", maskEnv(row.env)],
    ["\u8303\u56F4", "\u5168\u5C40\uFF08\u914D\u7F6E\u6587\u4EF6\u884C\uFF09"],
    ["\u72B6\u6001", row.enabled === false ? "\u5DF2\u505C\u7528" : "\u5DF2\u542F\u7528"]
  ];
}
function detailNodes(pairs, keyPrefix = "d") {
  return pairs.flatMap(([key, value]) => [
    /* @__PURE__ */ __dshReact.createElement("span", { className: "smp-detailsKey", key: `${keyPrefix}-k-${key}` }, key),
    /* @__PURE__ */ __dshReact.createElement("span", { className: "smp-detailsValue", key: `${keyPrefix}-v-${key}` }, value || "\u2014")
  ]);
}

// lib/src/components/dialog.jsx
function deleteConfirmDialog({ dialog, primitives, onCancel, onConfirm }) {
  if (dialog === null || dialog === void 0) return null;
  const Modal = primitives?.Modal;
  if (Modal === void 0) return null;
  const Button = primitives.Button ?? "button";
  return /* @__PURE__ */ __dshReact.createElement(
    Modal,
    {
      open: true,
      onClose: onCancel,
      title: `\u5220\u9664\u300C${dialog.label}\u300D\uFF1F`,
      closeLabel: "\u5173\u95ED",
      description: dialog.note,
      footer: /* @__PURE__ */ __dshReact.createElement(__dshReact.Fragment, null, /* @__PURE__ */ __dshReact.createElement(Button, { variant: "outline", key: "cancel", onClick: onCancel }, "\u53D6\u6D88"), /* @__PURE__ */ __dshReact.createElement(Button, { variant: "primary", key: "ok", onClick: onConfirm }, "\u5220\u9664"))
    }
  );
}

// lib/src/crud/skills.js
function scopeOfSkill(skill) {
  return typeof skill?.scope === "string" && skill.scope !== "" ? skill.scope : "global";
}
function skillEntryOf(draft, scope) {
  return {
    name: (draft.name ?? "").trim(),
    description: (draft.description ?? "").trim(),
    body: typeof draft.body === "string" ? draft.body : "",
    scope: scope === "" ? "global" : scope,
    enabled: draft.enabled === false ? false : true
  };
}
function upsertSkillByName(skills = [], entry) {
  const scope = scopeOfSkill(entry);
  return [
    ...skills.filter((item) => !(item.name === entry.name && scopeOfSkill(item) === scope)),
    entry
  ];
}
function removeSkill(skills = [], entry) {
  return skills.filter((item) => item !== entry);
}

// lib/src/crud/servers.js
function rowEntryId(serverName) {
  return `mcp-${serverName}`;
}
function inflightKeyForRow(entryId) {
  return entryId.startsWith("include:") ? entryId : `include:${entryId}`;
}
function commonFields(draft) {
  return {
    serverName: draft.serverName,
    transport: draft.transport ?? "streamable-http",
    command: draft.command ?? "",
    args: typeof draft.args === "string" ? draft.args : "",
    env: typeof draft.env === "string" ? draft.env : "",
    url: draft.url ?? "",
    headers: typeof draft.headers === "string" ? draft.headers : ""
  };
}
function addServerOp(draft, entryId = rowEntryId(draft.serverName)) {
  return { op: "add", entryId, ...commonFields(draft) };
}
function updateServerOp(entryId, draft) {
  return { op: "update", entryId, ...commonFields(draft) };
}
function toggleServerOp(entryId, enabled) {
  return { op: "toggle", entryId, enabled };
}
function deleteServerOp(entryId) {
  return { op: "delete", entryId };
}
function replaceProjectEntry(servers, entry, patch) {
  return servers.map((item) => item === entry ? { ...item, ...patch } : item);
}
function removeProjectEntry(servers, entry) {
  return servers.filter((item) => item !== entry);
}

// lib/src/crud/import.js
function takenNames({ scope, target, profileRows = [], servers = [] }) {
  if (scope === "global") return new Set(profileRows.map((row) => row.serverName));
  return new Set(
    servers.filter((server) => (server.scope ?? "global") === target).map((server) => server.serverName)
  );
}
function splitImport(found = [], taken = /* @__PURE__ */ new Set()) {
  const fresh = found.filter((server) => !taken.has(server.serverName));
  const skipped = found.filter((server) => taken.has(server.serverName));
  return { fresh, skipped };
}
function importLabel({ scope, fresh, skipped }) {
  const suffix = skipped > 0 ? `\uFF08\u8DF3\u8FC7 ${skipped} \u4E2A\uFF09` : "";
  return scope === "global" ? `\u5BFC\u5165 ${fresh} \u4E2A\u5230\u914D\u7F6E\u6587\u4EF6${suffix}` : `\u5BFC\u5165 ${fresh} \u4E2A${suffix}`;
}

// lib/src/styles/panel.css
var panel_default = `/*
 * Panel styles. Kept in its own file and inlined into lib/client.js by
 * esbuild (\`loader: { ".css": "text" }\`), because DSH's ModuleLoader evaluates
 * exactly one file per client bundle.
 */
.smp-page{box-sizing:border-box;width:100%;color:var(--dsw-alias-label-primary);flex-direction:column;align-items:center;gap:14px;display:flex}
.smp-page>*{width:100%;max-width:960px}
.smp-pageHead{box-sizing:border-box;justify-content:space-between;align-items:flex-start;gap:16px;display:flex}
.smp-pageTitle{margin:0;font-size:18px;font-weight:500;line-height:26px}
.smp-pageIntro{color:var(--dsw-alias-label-secondary);align-items:center;gap:4px;margin:4px 0 0;font-size:13px;line-height:20px;display:flex}
.smp-toolbar{justify-content:flex-end;align-items:center;gap:8px;display:flex;flex:none}
.smp-input,.smp-select,.smp-textarea{box-sizing:border-box;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);padding:0 10px;height:32px;font-size:13px}
.smp-textarea{height:auto;min-height:84px;padding:8px 10px;line-height:1.55;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.smp-input:focus-visible,.smp-select:focus-visible,.smp-textarea:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.smp-tabs{display:flex;gap:24px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.smp-tab{appearance:none;background:none;border:0;padding:0 2px 10px;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.smp-tab[data-active=true]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-label-primary)}
.smp-filterRow{display:flex;align-items:center;gap:8px}
.smp-search{flex:1 1 auto;min-width:140px;color:var(--dsw-alias-label-tertiary);align-items:center;display:flex;position:relative}
.smp-searchIcon{position:absolute;left:12px;display:inline-flex;pointer-events:none}
.smp-searchInput{box-sizing:border-box;width:100%;height:36px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);padding:0 12px 0 36px}
.smp-searchInput::placeholder{color:var(--dsw-alias-label-tertiary)}
.smp-projectInput{box-sizing:border-box;flex:0 1 220px;min-width:150px;height:36px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);padding:0 12px}
.smp-projectSelect[data-placeholder=true]{color:var(--dsw-alias-label-tertiary)}
.smp-projectSelect{box-sizing:border-box;flex:0 1 240px;min-width:170px;height:36px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);appearance:none;-webkit-appearance:none;padding:0 30px 0 10px;background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M4 6.5 8 10.5 12 6.5' stroke='%238b8f99' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;background-size:14px}
.smp-group{flex-direction:column;gap:10px;display:flex;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:14px}
.smp-group:first-of-type{border-top:0;padding-top:0}
.smp-groupTitleRow{align-items:center;gap:8px;min-height:36px;display:flex}
.smp-groupToggle{color:inherit;font:inherit;text-align:left;cursor:pointer;background:none;border:0;flex:none;align-items:center;gap:8px;padding:0;display:flex}
.smp-groupTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.smp-groupSub{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex-wrap:wrap;row-gap:4px;margin:-6px 0 0 20px;font-size:12px;line-height:18px;display:flex}
.smp-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .14s ease-in-out}
.smp-chevron[data-open=false]{transform:rotate(-90deg)}
/* Rows follow the Models settings page: one column list, head row with the
   actions pinned right, and an open body that can hold arbitrarily long text. */
.smp-cards{flex-direction:column;gap:8px;margin:12px 0 0;padding:0;list-style:none;display:flex}
.smp-card{border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl);flex-direction:column;gap:4px;padding:12px 14px;min-width:0;display:flex}
.smp-cardHead+.smp-cardDescription{margin-top:0}
.smp-cardHead{align-items:center;gap:10px;min-width:0;display:flex}
.smp-cardToggle{box-sizing:border-box;color:inherit;font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;align-items:center;gap:8px;min-width:0;padding:0;display:inline-flex}
.smp-cardIdentity{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;min-width:0;overflow-wrap:anywhere}
.smp-cardEnd{flex:none;align-items:center;gap:8px;display:inline-flex}
.smp-cardActions{align-items:center;gap:4px;margin-left:auto;flex:none;display:inline-flex}
.smp-cardActions .smp-actionsRow{margin:0;gap:4px}
.smp-cardActions .smp-button{box-sizing:border-box;height:28px;padding:0 10px;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm)}
.smp-cardDescription{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.smp-cardDetails{border-top:.5px solid var(--dsw-alias-border-l2);padding:12px 0 0}
.smp-card>.smp-cardDetails:first-child{border-top:0;padding-top:0}
.smp-formGrid:first-child{margin-top:0}
.smp-cardDetails .smp-details{margin:0}
.smp-details{grid-template-columns:76px minmax(0,1fr);gap:6px 10px;margin:8px 0 0;display:grid;font-size:12px;line-height:18px}
.smp-detailsKey{color:var(--dsw-alias-label-tertiary)}
.smp-detailsValue{color:var(--dsw-alias-label-secondary);word-break:break-all}
.smp-tag{display:inline-flex;align-items:center;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap}
.smp-tag[data-tone=neutral]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.smp-empty{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px;list-style:none}
.smp-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0;list-style:none}
.smp-formGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:10px}
.smp-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.smp-field[data-wide=true]{grid-column:1 / -1}
.smp-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.smp-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:32px;padding:0 14px;border:.5px solid transparent;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;flex:none}
.smp-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.smp-button:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.smp-button[data-variant=outline]{border-color:var(--dsw-alias-border-l3)}
.smp-button[data-variant=danger]{color:var(--dsw-alias-state-error-primary,#d92d20)}
.smp-cardActions .smp-button[data-variant=danger]{border-color:var(--dsw-alias-state-error-primary,#d92d20)}
.smp-spinner{display:inline-block;width:12px;height:12px;box-sizing:border-box;border:1.5px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:smp-spin .72s linear infinite;flex:none}
@keyframes smp-spin{to{transform:rotate(360deg)}}
.smp-pending{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.smp-segment{align-self:flex-start;display:inline-flex;align-items:center;gap:2px;padding:2px;background:var(--dsw-alias-bg-module-platform);border-radius:var(--dsw-radius-md);width:fit-content}
.smp-segment>button{box-sizing:border-box;height:28px;padding:0 12px;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:0 0;border:0;border-radius:var(--dsw-radius-sm);cursor:pointer}
.smp-segment>button[data-active=true]{background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary);font-weight:500}
.smp-cardDetails .smp-input{box-sizing:border-box;width:100%;height:36px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);padding:0 10px}
.smp-cardDetails .smp-select,.smp-select{box-sizing:border-box;height:36px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);appearance:none;-webkit-appearance:none;padding:0 30px 0 10px;background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M4 6.5 8 10.5 12 6.5' stroke='%238b8f99' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;background-size:14px}
.smp-cardDetails .smp-input[readonly]{color:var(--dsw-alias-label-secondary)}
.smp-button[data-variant=primary]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.smp-button[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.smp-button:disabled{opacity:.4;cursor:not-allowed}
.smp-actionsRow{display:flex;align-items:center;gap:8px;margin-top:10px}
.smp-error{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));font-size:12px;line-height:18px}
`;

// lib/src/client.js
window.__ModuleLoader__.load({
  id: "@local/dsh-skills-mcp-panel",
  factory(require2) {
    const React = require2("react");
    globalThis.__dshReact = React;
    const primitives = (() => {
      try {
        return require2("@deepseek-ai/dsh-client-ui-primitives");
      } catch {
        return null;
      }
    })();
    const h = React.createElement;
    const { useState, useEffect, useMemo } = React;
    const NS = "skills-mcp-panel";
    const CSS = panel_default;
    function snapshotOf(form) {
      const snapshot = form?.getSnapshot?.() ?? form?.store?.getSnapshot?.() ?? form?.snapshot;
      return snapshot?.value ?? snapshot ?? {};
    }
    function statusOf(form) {
      const snapshot = form?.getSnapshot?.() ?? form?.store?.getSnapshot?.() ?? form?.snapshot;
      return snapshot?.status ?? "ready";
    }
    function listOf(form, field2) {
      const value = snapshotOf(form)?.[field2];
      return Array.isArray(value) ? value : [];
    }
    function Panel(props) {
      const form = props.form;
      const [tick, setTick] = useState(0);
      const [tab, setTab] = useState("mcp");
      const [query, setQuery] = useState("");
      const [project, setProject] = useState("");
      const [open, setOpen] = useState({ mcpGlobal: true, mcpProject: true, skillsGlobal: true, skillsProject: true });
      const [expanded, setExpanded] = useState("");
      const [editing, setEditing] = useState(null);
      const [draft, setDraft] = useState({});
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [confirming, setConfirming] = useState("");
      const [deleteDialog, setDeleteDialog] = useState(null);
      const [inflight, setInflight] = useState({});
      const [customProject, setCustomProject] = useState(false);
      const [autoPicked, setAutoPicked] = useState(false);
      const [importOpen, setImportOpen] = useState(false);
      const [importSource, setImportSource] = useState("claude");
      const [importScope, setImportScope] = useState("global");
      const [importProject, setImportProject] = useState("");
      const [importCustomProject, setImportCustomProject] = useState(false);
      const refresh = () => setTick((n) => n + 1);
      useEffect(() => {
        const timer = setInterval(refresh, 700);
        return () => clearInterval(timer);
      }, []);
      useEffect(() => {
        const timer = setInterval(refresh, 1500);
        const unsubscribe = form?.subscribe?.(refresh);
        return () => {
          clearInterval(timer);
          if (typeof unsubscribe === "function") unsubscribe();
        };
      }, [form]);
      const [inventoryRows, setInventoryRows] = useState([]);
      useEffect(() => {
        let alive = true;
        const load = () => {
          try {
            const list = props.inventory?.list;
            if (typeof list !== "function") return;
            list().then((payload) => {
              if (!alive) return;
              const entries = payload?.value?.entries ?? payload?.entries ?? [];
              setInventoryRows((Array.isArray(entries) ? entries : []).map((row) => ({
                entryId: String(row?.entryId ?? row?.id ?? "?"),
                moduleName: String(row?.moduleName ?? row?.name ?? "?"),
                enabled: row?.enabled !== false,
                fiberPhase: String(row?.fiberPhase ?? "")
              })));
            }).catch(() => {
            });
          } catch {
          }
        };
        load();
        const timer = setInterval(load, 1e4);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [props.inventory]);
      const servers = useMemo(() => listOf(form, "servers"), [form, tick]);
      const skills = useMemo(() => listOf(form, "skills"), [form, tick]);
      const hostProfileRows = useMemo(() => listOf(form, "profileServers"), [form, tick]);
      const profileRows = useMemo(() => {
        if (hostProfileRows.length > 0) return hostProfileRows;
        return inventoryRows.filter((row) => row.moduleName === "@deepseek-ai/dsh-mcp-client").map((row) => ({
          entryId: row.entryId,
          serverName: row.entryId.replace(/^include:/, "").replace(/^mcp-/, ""),
          transport: "",
          target: "",
          enabled: row.enabled,
          phase: row.fiberPhase
        }));
      }, [hostProfileRows, inventoryRows]);
      const debugOn = typeof location !== "undefined" && /(?:^|[?&])smp=debug/.test(location.search);
      const debugMcp = inventoryRows.filter((row) => /mcp/i.test(row.entryId) || /mcp/i.test(row.moduleName));
      const rowOpsReady = snapshotOf(form)?.rowOpsReady === true;
      const matches = (row) => matchesName(row.serverName ?? row.name, query);
      const isGlobal = (row) => (row.scope ?? "global") === "global";
      const isProject = (row) => project !== "" && (row.scope ?? "global") === project;
      const serversGlobal = servers.filter((row) => isGlobal(row) && matches(row));
      const serversProject = servers.filter((row) => isProject(row) && matches(row));
      const skillsGlobal = skills.filter((row) => isGlobal(row) && matches(row));
      const skillsProject = skills.filter((row) => isProject(row) && matches(row));
      const profileGlobal = profileRows.filter(matches);
      const knownProjects = new Map(listOf(form, "workspaces").filter((workspace) => typeof workspace?.path === "string" && workspace.path !== "").map((workspace) => [workspace.path, typeof workspace.title === "string" && workspace.title !== "" ? workspace.title : workspace.path]));
      const projectLabel = (path) => {
        if (typeof path !== "string" || path === "") return "";
        const known = knownProjects.get(path);
        if (known !== void 0) return known;
        return path;
      };
      useEffect(() => {
        const cwd = snapshotOf(form)?.currentWorkspace;
        if (autoPicked || typeof cwd !== "string" || cwd === "" || project !== "") return;
        setAutoPicked(true);
        setProject(cwd);
      }, [form, autoPicked, project, tick]);
      useEffect(() => {
        setInflight((current) => settleInflight(current, { profileRows }));
      }, [tick, profileRows, inflight]);
      const pendingOps = Array.isArray(snapshotOf(form)?.rowOps) ? snapshotOf(form).rowOps : [];
      const pendingOf = (entryId) => pendingOps.find((op) => String(op?.entryId ?? "").replace(/^include:/, "") === String(entryId).replace(/^include:/, "")) ?? null;
      const projectChoices = useMemo(() => {
        const map = /* @__PURE__ */ new Map();
        for (const workspace of listOf(form, "workspaces")) {
          const path = typeof workspace?.path === "string" ? workspace.path : "";
          if (path !== "") map.set(path, typeof workspace.title === "string" && workspace.title !== "" ? workspace.title : path);
        }
        for (const row of [...servers, ...skills]) {
          const scope = row?.scope;
          if (typeof scope === "string" && scope !== "" && scope !== "global" && !map.has(scope)) map.set(scope, scope);
        }
        if (project !== "" && !map.has(project)) map.set(project, project);
        return [...map.entries()];
      }, [servers, skills, project, form, tick]);
      async function write(field_, value) {
        setBusy(true);
        setError("");
        try {
          if (typeof form?.set === "function") await form.set(field_, value);
          else if (props.mutate) await props.mutate(NS, [{ op: "set", path: [field_], value }]);
          refresh();
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
        }
      }
      const queueRowOp = (op) => write("rowOps", [
        ...listOf(form, "rowOps"),
        { ...op, entryId: String(op.entryId).replace(/^include:/, "").replace(/^[a-z-]+:/i, "") }
      ]);
      const replaceServer = (row) => write("servers", [
        ...servers.filter((item) => !(item.serverName === row.serverName && (item.scope ?? "global") === row.scope)),
        row
      ]);
      const replaceSkill = (row) => write("skills", upsertSkillByName(skills, row));
      const head = pageHead();
      const tabs = tabStrip({
        active: tab,
        counts: {
          mcp: serversGlobal.length + profileGlobal.length + serversProject.length,
          skills: skillsGlobal.length + skillsProject.length
        },
        onSelect: (next) => {
          setTab(next);
          setEditing(null);
          setExpanded("");
        }
      });
      const filterRowView = filterRow({
        query,
        onQuery: setQuery,
        project,
        projectChoices,
        customProject,
        onCustomProject: setCustomProject,
        onProject: setProject,
        placeholder: tab === "mcp" ? "\u641C\u7D22\u540D\u79F0" : "\u641C\u7D22\u6280\u80FD\u540D\u79F0"
      });
      function groupHead2(kindKey, title, subText, action) {
        return groupHead({
          Chevron,
          open: open[kindKey],
          title,
          subText,
          action,
          onToggle: () => setOpen({ ...open, [kindKey]: !open[kindKey] })
        });
      }
      function card(key, identity, description, enabled, details, actions) {
        const isOpen = expanded === key;
        return h("li", { className: "smp-card", key }, [
          h("div", { className: "smp-cardHead", key: "head" }, [
            h("button", {
              className: "smp-cardToggle",
              key: "toggle",
              "aria-expanded": isOpen,
              onClick: () => setExpanded(isOpen ? "" : key)
            }, [
              h(Chevron, { key: "c", open: isOpen }),
              h("span", { className: "smp-cardIdentity", key: "id" }, identity),
              enabled === false ? h("span", { className: "smp-tag", "data-tone": "neutral", key: "tag" }, "\u5DF2\u505C\u7528") : null
            ]),
            h("span", { className: "smp-cardActions", key: "actions" }, actions)
          ]),
          description ? h("div", { className: "smp-cardDescription", key: "desc" }, description) : null,
          isOpen ? h("div", { className: "smp-cardDetails", key: "details" }, [
            h(
              "div",
              { className: "smp-details", key: "grid" },
              details.flatMap(([k, v]) => [
                h("span", { className: "smp-detailsKey", key: `k-${k}` }, k),
                h("span", { className: "smp-detailsValue", key: `v-${k}` }, v || "\u2014")
              ])
            ),
            error ? h("div", { className: "smp-error", key: "err", style: { marginTop: 8 } }, error) : null
          ]) : null
        ]);
      }
      function profileCard(row) {
        const pendingDelete = confirming === row.entryId;
        const rowKey = `profile:${row.entryId}`;
        const rowOpen = expanded === rowKey;
        if (editing?.kind === "mcp" && editing.tier === "global" && editing.id === row.entryId) {
          return serverForm({ tier: "global", scope: "global" });
        }
        return h("li", { className: "smp-card", key: `profile:${row.entryId}` }, [
          h("div", { className: "smp-cardHead", key: "head" }, [
            h("button", {
              className: "smp-cardToggle",
              key: "toggle",
              "aria-expanded": rowOpen,
              onClick: () => setExpanded(rowOpen ? "" : rowKey)
            }, [
              h(Chevron, { key: "c", open: rowOpen }),
              h("span", { className: "smp-cardIdentity", key: "name" }, row.serverName || row.entryId)
            ]),
            h("span", { className: "smp-cardEnd", key: "end" }, [
              row.enabled === false ? h("span", { className: "smp-tag", "data-tone": "neutral", key: "off" }, "\u5DF2\u505C\u7528") : null,
              h("span", { className: "smp-tag", "data-tone": "neutral", key: "src" }, "\u914D\u7F6E\u6587\u4EF6")
            ]),
            pendingOf(row.entryId) !== null || inflight[row.entryId] !== void 0 ? h("span", { className: "smp-cardActions", key: "pending" }, [
              h("span", { className: "smp-pending", key: "p" }, [
                h("span", { className: "smp-spinner", key: "s" }),
                pendingLabel(inflight[row.entryId] ?? { kind: pendingOf(row.entryId)?.op })
              ])
            ]) : rowOpsReady ? h("span", { className: "smp-cardActions", key: "actions" }, [
              h("button", {
                className: "smp-button",
                "data-variant": "outline",
                key: "toggle",
                disabled: busy,
                onClick: () => {
                  const expectEnabled = row.enabled === false;
                  setInflight((m) => ({ ...m, [row.entryId]: { kind: "toggle", at: Date.now(), expectEnabled } }));
                  queueRowOp(toggleServerOp(row.entryId, expectEnabled));
                }
              }, row.enabled === false ? "\u542F\u7528" : "\u505C\u7528"),
              h("button", {
                className: "smp-button",
                "data-variant": "outline",
                key: "edit",
                disabled: busy,
                onClick: () => {
                  setEditing({ kind: "mcp", tier: "global", profile: row.entryId, id: row.entryId });
                  setDraft({
                    serverName: row.serverName,
                    transport: row.transport || "streamable-http",
                    url: row.target,
                    command: row.transport === "stdio" ? row.target : ""
                  });
                }
              }, "\u7F16\u8F91"),
              h("button", {
                className: "smp-button",
                "data-variant": "danger",
                key: "del",
                disabled: busy,
                onClick: () => {
                  const run = () => {
                    setInflight((m) => ({ ...m, [row.entryId]: { kind: "delete", at: Date.now() } }));
                    queueRowOp(deleteServerOp(row.entryId));
                  };
                  if (primitives?.Modal === void 0) {
                    if (window.confirm(`\u5220\u9664\u300C${row.serverName || row.entryId}\u300D\uFF1F`)) run();
                    return;
                  }
                  setDeleteDialog({ label: row.serverName || row.entryId, note: "\u4F1A\u4ECE cordis.patch.yml \u91CC\u79FB\u9664\u8FD9\u4E00\u884C\uFF08\u5199\u5165\u524D\u81EA\u52A8\u5907\u4EFD\uFF09\u3002", run });
                }
              }, "\u5220\u9664")
            ]) : null
          ]),
          h(
            "div",
            { className: "smp-cardDescription", key: "desc" },
            row.target ? `${row.transport || "streamable-http"} \xB7 ${row.target}` : `${String(row.entryId).replace(/^include:/, "")}${row.phase ? ` \xB7 ${row.phase}` : ""}`
          ),
          rowOpen ? h("div", { className: "smp-cardDetails", key: "details" }, [
            h(
              "div",
              { className: "smp-details", key: "grid" },
              detailNodes(rowDetailPairs(row))
            )
          ]) : null
        ]);
      }
      const IMPORT_CHOICES = [
        ["claude", "Claude"],
        ["codex", "Codex"],
        ["chatgpt", "ChatGPT"],
        ["cursor", "Cursor"],
        ["gemini", "Gemini CLI"],
        ["antigravity", "Google Antigravity"],
        ["reasonix", "Reasonix"],
        ["opencode", "opencode"],
        ["mimocode", "MimoCode"],
        ["teleagent", "TeleAgent"],
        ["kilo", "Kilo Code"],
        ["zcode", "ZCode"],
        ["grok", "Grok"],
        ["openclaw", "OpenClaw"],
        ["pi", "Pi"],
        ["hermes", "Hermes"],
        ["kimi", "KIMI"],
        ["qoder", "Qoder"],
        ["workbuddy", "WorkBuddy"],
        ["qwen", "Qwen"],
        ["continue", "Continue"],
        ["cline", "Cline"],
        ["goose", "goose"],
        ["zed", "Zed"],
        ["crush", "Crush"]
      ];
      const importCard = (scope) => {
        const raw = snapshotOf(form)?.importResult;
        const target = scope === "global" ? "" : importProject;
        const result = raw !== null && typeof raw === "object" && raw.nonce !== "" && raw.scope === scope && (scope === "global" || raw.project === target) ? raw : null;
        const needsProject = scope === "project" && target === "";
        const takenNames2 = takenNames({ scope, target, profileRows, servers });
        const { fresh: freshServers, skipped: skippedServers } = splitImport(result?.servers ?? [], takenNames2);
        if (!importOpen) {
          return h("li", { className: "smp-card", key: "import" }, [
            h("div", { className: "smp-cardHead", key: "head" }, [
              h("span", { className: "smp-cardIdentity", key: "t" }, scope === "global" ? "\u5BFC\u5165 MCP" : "\u5BFC\u5165 MCP"),
              h("span", { className: "smp-cardActions", key: "a" }, [
                h("button", { className: "smp-button", "data-variant": "outline", key: "go", disabled: busy, onClick: () => setImportOpen(true) }, "\u9009\u62E9\u6765\u6E90")
              ])
            ]),
            h(
              "div",
              { className: "smp-cardDescription", key: "d" },
              scope === "global" ? "\u4ECE\u5176\u4ED6\u7F16\u8F91\u5668/CLI \u7684**\u7528\u6237\u7EA7**\u914D\u7F6E\u6587\u4EF6\u5BFC\u5165\uFF08\u5199\u6210\u914D\u7F6E\u6587\u4EF6\u884C\uFF09\u3002" : "\u4ECE\u5176\u4ED6\u7F16\u8F91\u5668/CLI \u7684**\u9879\u76EE\u7EA7**\u6587\u4EF6\u5BFC\u5165\u5230\u9762\u677F\u7684\u9879\u76EE\u6761\u76EE\u3002"
            )
          ]);
        }
        return h("li", { className: "smp-card", key: "import" }, [
          h("div", { className: "smp-cardHead", key: "head" }, [
            h("span", { className: "smp-cardIdentity", key: "t" }, scope === "global" ? "\u5BFC\u5165\u5168\u5C40 MCP" : "\u5BFC\u5165\u9879\u76EE MCP"),
            h("span", { className: "smp-cardActions", key: "a" }, [
              h("button", { className: "smp-button", "data-variant": "outline", key: "close", onClick: () => setImportOpen(false) }, "\u6536\u8D77")
            ])
          ]),
          h("div", { className: "smp-segment", key: "segment" }, [
            h("button", { key: "g", "data-active": String(scope === "global"), onClick: () => setImportScope("global") }, "\u5168\u5C40"),
            h("button", { key: "p", "data-active": String(scope === "project"), onClick: () => setImportScope("project") }, "\u9879\u76EE\u7EA7")
          ]),
          h("div", { className: "smp-formGrid", key: "grid" }, [
            field("\u6765\u6E90", h("select", {
              className: "smp-select",
              value: importSource,
              onChange: (event) => setImportSource(event.target.value)
            }, IMPORT_CHOICES.map(([id, label]) => h("option", { value: id, key: id }, label)))),
            scope === "global" ? null : importCustomProject ? field("\u9879\u76EE\u8DEF\u5F84", h("div", { className: "smp-actionsRow", style: { marginTop: 0 } }, [
              h("input", {
                className: "smp-input",
                placeholder: "\u9879\u76EE\u7EDD\u5BF9\u8DEF\u5F84",
                style: { flex: "1 1 auto" },
                value: importProject,
                onChange: (event) => setImportProject(event.target.value)
              }),
              h("button", {
                className: "smp-button",
                "data-variant": "outline",
                key: "back",
                onClick: () => setImportCustomProject(false)
              }, "\u9009\u5DE5\u4F5C\u533A")
            ])) : field("\u9879\u76EE", h("div", { className: "smp-actionsRow", style: { marginTop: 0 } }, [
              h("select", {
                className: "smp-select",
                value: importProject,
                style: { flex: "1 1 auto" },
                onChange: (event) => {
                  if (event.target.value === "__custom__") {
                    setImportCustomProject(true);
                    return;
                  }
                  setImportProject(event.target.value);
                }
              }, [
                h("option", { value: "", key: "none" }, "\u9009\u62E9\u4E00\u4E2A\u5DE5\u4F5C\u533A\u2026"),
                ...projectChoices.map(([path, title]) => h("option", { value: path, key: path }, title)),
                h("option", { value: "__custom__", key: "custom" }, "\u81EA\u5B9A\u4E49\u8DEF\u5F84\u2026")
              ]),
              importProject !== "" ? h("button", {
                className: "smp-button",
                "data-variant": "outline",
                key: "clear",
                onClick: () => setImportProject("")
              }, "\u6E05\u9664") : null
            ]))
          ]),
          needsProject ? h("div", { className: "smp-cardDescription", key: "need" }, "\u5148\u9009\u62E9\u4E00\u4E2A\u5DE5\u4F5C\u533A\uFF08\u6216\u5207\u5230\u300C\u5168\u5C40\u300D\u8BFB\u7528\u6237\u7EA7\u914D\u7F6E\uFF09\u3002") : result === null ? h("div", { className: "smp-cardDescription", key: "hint" }, "\u70B9\u300C\u626B\u63CF\u300D\u540E\uFF0C\u4F1A\u628A\u8BE5\u5DE5\u5177\u5728\u9879\u76EE\u91CC\u7684 MCP \u6587\u4EF6\u4E0E\u80FD\u5BFC\u5165\u7684\u6761\u76EE\u5217\u51FA\u6765\u3002") : h("div", { key: "result" }, [
            ...result.files.map((file) => h(
              "div",
              { className: "smp-cardDescription", key: file.path },
              `${file.exists ? "\u2713" : "\u2717"} ${file.path}${file.exists ? ` \xB7 \u8BC6\u522B ${file.servers.length} \u4E2A${file.unsupported > 0 ? `\uFF08${file.unsupported} \u4E2A\u5F62\u6001\u4E0D\u652F\u6301\uFF09` : ""}` : " \xB7 \u6587\u4EF6\u4E0D\u5B58\u5728"}${file.error !== null && file.error !== "" ? ` \xB7 ${file.error}` : ""}`
            )),
            result.error !== null && result.error !== "" ? h("div", { className: "smp-error", key: "err" }, result.error) : null,
            h(
              "div",
              { className: "smp-cardDescription", key: "sum" },
              `\u65B0\u589E ${freshServers.length} \u4E2A\uFF1A${freshServers.map((server) => server.serverName).join("\u3001") || "\u2014"}`
            ),
            skippedServers.length > 0 ? h(
              "div",
              { className: "smp-cardDescription", key: "skip" },
              `\u5DF2\u5B58\u5728 ${skippedServers.length} \u4E2A\uFF08\u8DF3\u8FC7\uFF0C\u4E0D\u8986\u76D6\uFF09\uFF1A${skippedServers.map((server) => server.serverName).join("\u3001")}`
            ) : null
          ]),
          h("div", { className: "smp-actionsRow", key: "actions" }, [
            h("button", {
              className: "smp-button",
              "data-variant": "primary",
              key: "scan",
              disabled: busy || scope === "project" && target === "",
              onClick: () => write("importRequest", {
                source: importSource,
                scope,
                project: target,
                nonce: String(Date.now())
              })
            }, "\u626B\u63CF"),
            result !== null && freshServers.length > 0 ? h("button", {
              className: "smp-button",
              "data-variant": "outline",
              key: "do",
              disabled: busy || scope === "global" && !rowOpsReady,
              onClick: () => {
                if (scope === "global") {
                  const existing2 = new Set(profileRows.map((row) => row.serverName));
                  for (const server of result.servers) {
                    if (existing2.has(server.serverName)) continue;
                    queueRowOp(addServerOp({
                      serverName: server.serverName,
                      transport: server.transport,
                      url: server.transport === "stdio" ? "" : server.url,
                      command: server.transport === "stdio" ? server.command : "",
                      args: server.transport === "stdio" ? (server.args ?? []).join(" ") : "",
                      env: server.env ?? "",
                      headers: server.headers ?? ""
                    }));
                  }
                  return;
                }
                const existing = new Set(servers.map((server) => server.serverName));
                const fresh = result.servers.filter((server) => !existing.has(server.serverName));
                write("servers", [...servers, ...fresh]);
              }
            }, importLabel({ scope, fresh: freshServers.length, skipped: skippedServers.length })) : null
          ])
        ]);
      };
      const addButton = (tier, label, onClick) => h("button", {
        className: "smp-button",
        "data-variant": "primary",
        key: "add",
        disabled: !tier || busy,
        onClick
      }, label);
      function serverForm(tier) {
        if (!editing || editing.kind !== "mcp" || editing.tier !== tier.tier) return null;
        const scope = tier.scope;
        const profileEntry = typeof editing.profile === "string" && editing.profile !== "" ? editing.profile : null;
        return h("li", { className: "smp-card", key: "form", "data-wide": "true" }, [
          h("div", { className: "smp-cardDetails", key: "body" }, [
            h("div", { className: "smp-formGrid", key: "grid" }, [
              field("\u540D\u79F0\uFF08serverName\uFF09", h("input", {
                className: "smp-input",
                placeholder: "\u4F8B\u5982 test\uFF0C\u6700\u591A 32 \u5B57\u7B26",
                value: draft.serverName ?? "",
                onChange: (e) => setDraft({ ...draft, serverName: e.target.value })
              })),
              field("\u4F20\u8F93", h("select", { className: "smp-select", value: draft.transport ?? "streamable-http", onChange: (e) => setDraft({ ...draft, transport: e.target.value }) }, [
                h("option", { value: "streamable-http", key: "h" }, "streamable-http"),
                h("option", { value: "stdio", key: "s" }, "stdio")
              ])),
              (draft.transport ?? "streamable-http") === "stdio" ? field("\u547D\u4EE4", h("input", { className: "smp-input", placeholder: HINTS.command, value: draft.command ?? "", onChange: (e) => setDraft({ ...draft, command: e.target.value }) })) : field("URL", h("input", { className: "smp-input", placeholder: HINTS.url, value: draft.url ?? "", onChange: (e) => setDraft({ ...draft, url: e.target.value }) })),
              (draft.transport ?? "streamable-http") === "stdio" ? field("\u53C2\u6570\uFF08\u7A7A\u683C\u5206\u9694\uFF09", h("input", { className: "smp-input", placeholder: HINTS.args, value: draft.args ?? "", onChange: (e) => setDraft({ ...draft, args: e.target.value }) })) : null,
              (draft.transport ?? "streamable-http") === "stdio" && tier.tier !== "global" ? field("\u8FD0\u884C\u65F6", h("select", {
                className: "smp-select",
                value: draft.runtime ?? "auto",
                onChange: (e) => setDraft({ ...draft, runtime: e.target.value })
              }, [
                h("option", { value: "auto", key: "auto" }, "\u8DDF\u968F Harness\uFF08\u81EA\u5E26 node + pnpx\uFF0C\u63A8\u8350\uFF09"),
                h("option", { value: "system", key: "system" }, "\u7CFB\u7EDF npx\uFF08\u4E2A\u522B\u8001\u5305\u4E0D\u517C\u5BB9 pnpm\uFF09")
              ])) : null,
              (draft.transport ?? "streamable-http") === "stdio" ? field("\u73AF\u5883\u53D8\u91CF\uFF08KEY=VALUE\uFF0C\u6BCF\u884C\u4E00\u4E2A\uFF09", h("textarea", { className: "smp-textarea", rows: 3, placeholder: HINTS.env, value: draft.env ?? "", onChange: (e) => setDraft({ ...draft, env: e.target.value }) }), true) : null
            ]),
            error ? h("div", { className: "smp-error", key: "err", style: { marginTop: 8 } }, error) : null,
            profileEntry !== null ? h(
              "p",
              { className: "smp-note", key: "note", style: { marginTop: 8 } },
              `\u6539\u7684\u662F\u914D\u7F6E\u6587\u4EF6\u884C ${profileEntry.replace(/^include:/, "")}\uFF0CHost \u4F1A\u5199\u56DE profile patch\uFF08\u81EA\u52A8\u5907\u4EFD\uFF09\u3002`
            ) : null,
            h("div", { className: "smp-actionsRow", key: "actions" }, [
              h("button", {
                className: "smp-button",
                "data-variant": "primary",
                key: "save",
                disabled: busy || !draft.serverName,
                onClick: () => {
                  const transport = draft.transport ?? "streamable-http";
                  const argList = String(draft.args ?? "").trim() === "" ? [] : String(draft.args).trim().split(/\s+/);
                  if (profileEntry !== null) {
                    setInflight((m) => ({ ...m, [profileEntry]: { kind: "update", at: Date.now(), expectName: draft.serverName ?? "" } }));
                    queueRowOp(updateServerOp(profileEntry, {
                      serverName: draft.serverName ?? "",
                      transport,
                      url: transport === "stdio" ? "" : draft.url ?? "",
                      command: transport === "stdio" ? draft.command ?? "" : "",
                      args: transport === "stdio" ? String(draft.args ?? "") : "",
                      env: transport === "stdio" ? String(draft.env ?? "") : ""
                    }));
                  } else if (tier.tier === "global") {
                    setInflight((m) => ({ ...m, [inflightKeyForRow(rowEntryId(draft.serverName))]: { kind: "add", at: Date.now() } }));
                    queueRowOp(addServerOp({
                      serverName: draft.serverName ?? "",
                      transport,
                      url: transport === "stdio" ? "" : draft.url ?? "",
                      command: transport === "stdio" ? draft.command ?? "" : "",
                      args: transport === "stdio" ? String(draft.args ?? "") : "",
                      env: transport === "stdio" ? String(draft.env ?? "") : ""
                    }));
                  } else {
                    replaceServer({
                      scope,
                      id: draft.serverName,
                      serverName: draft.serverName,
                      transport,
                      url: transport === "stdio" ? "" : draft.url ?? "",
                      command: transport === "stdio" ? draft.command ?? "" : "",
                      args: transport === "stdio" ? argList : [],
                      env: transport === "stdio" ? draft.env ?? "" : "",
                      runtime: transport === "stdio" ? draft.runtime ?? "auto" : "auto",
                      enabled: true
                    });
                  }
                  setEditing(null);
                }
              }, profileEntry !== null ? "\u4FDD\u5B58\u5230\u914D\u7F6E\u884C" : "\u4FDD\u5B58"),
              h("button", { className: "smp-button", "data-variant": "outline", key: "cancel", onClick: () => setEditing(null) }, "\u53D6\u6D88")
            ])
          ])
        ]);
      }
      function skillForm(tier) {
        if (!editing || editing.kind !== "skill" || editing.tier !== tier.tier) return null;
        const scope = tier.scope;
        return h("li", { className: "smp-card", key: "form", "data-wide": "true" }, [
          h("div", { className: "smp-cardDetails", key: "body" }, [
            h("div", { className: "smp-formGrid", key: "grid" }, [
              ...skillFieldDefs().map((def) => field(
                def.label,
                def.kind === "textarea" ? h("textarea", { className: "smp-textarea", key: def.key, value: draft[def.key] ?? "", onChange: (e) => setDraft({ ...draft, [def.key]: e.target.value }) }) : h("input", { className: "smp-input", key: def.key, value: draft[def.key] ?? "", onChange: (e) => setDraft({ ...draft, [def.key]: e.target.value }) }),
                def.kind === "textarea"
              ))
            ]),
            error ? h("div", { className: "smp-error", key: "err", style: { marginTop: 8 } }, error) : null,
            h("div", { className: "smp-actionsRow", key: "actions" }, [
              h("button", {
                className: "smp-button",
                "data-variant": "primary",
                key: "save",
                disabled: busy || !draft.name,
                onClick: () => {
                  replaceSkill(skillEntryOf(draft, scope));
                  setEditing(null);
                }
              }, "\u4FDD\u5B58\u5230\u78C1\u76D8"),
              h("button", { className: "smp-button", "data-variant": "outline", key: "cancel", onClick: () => setEditing(null) }, "\u53D6\u6D88")
            ]),
            h(
              "p",
              { className: "smp-note", key: "hint", style: { marginTop: 10 } },
              scope === "global" ? "\u5199\u5165 $DSH_HOME/skills/<\u540D\u5B57>/SKILL.md" : `\u5199\u5165 ${scope}/.agents/skills/<\u540D\u5B57>/SKILL.md`
            )
          ])
        ]);
      }
      function tierSection({ tier, kind, title, subText, list }) {
        const openKey = `${kind}${tier === "global" ? "Global" : "Project"}`;
        const add = addButton(
          tier === "global" ? "global" : project === "" ? null : project,
          kind === "mcp" ? "\u6DFB\u52A0\u670D\u52A1\u5668" : "\u6DFB\u52A0\u6280\u80FD",
          () => {
            setEditing({ kind, tier });
            setDraft(kind === "mcp" ? { transport: "streamable-http" } : { name: "", description: "", body: "" });
          }
        );
        return h("section", { className: "smp-group", key: `${kind}:${tier}` }, [
          ...groupHead2(openKey, title, subText, add),
          open[openKey] ? list : null
        ]);
      }
      const pendingAdds2 = pendingAdds(inflight, profileRows);
      const mcpGlobalList = h("ul", { className: "smp-cards", key: "cards" }, [
        ...pendingAdds2.map(([entryId, info]) => h("li", { className: "smp-card", key: `pending:${entryId}` }, [
          h("div", { className: "smp-cardHead", key: "head" }, [
            h("span", { className: "smp-pending", key: "p" }, [
              h("span", { className: "smp-spinner", key: "s" }),
              `\u6B63\u5728\u5199\u5165\u914D\u7F6E\u6587\u4EF6\u2026\uFF08${String(entryId).replace(/^include:mcp-/, "")}\uFF09`
            ])
          ])
        ])),
        editing?.kind === "mcp" && editing.tier === "global" && editing.id === void 0 ? serverForm({ tier: "global", scope: "global" }) : null,
        // Legacy entries written before global MCP moved into the profile patch:
        // still mounted by the panel, so keep them visible until they are migrated.
        ...serversGlobal.map((server) => card(
          `mcp:legacy/${server.serverName}`,
          `${server.serverName}\uFF08\u65E7\u7684\u9762\u677F\u6761\u76EE\uFF09`,
          server.transport === "stdio" ? `${server.command} ${(server.args ?? []).join(" ")}`.trim() : server.url,
          server.enabled,
          [["\u4F20\u8F93", server.transport], ["\u8303\u56F4", "\u5168\u5C40\uFF08\u9762\u677F\u6302\u8F7D\uFF09"]],
          [
            h("button", {
              className: "smp-button",
              "data-variant": "danger",
              key: "del",
              disabled: busy,
              onClick: () => setDeleteDialog({
                label: server.serverName,
                note: "\u4F1A\u4ECE\u9762\u677F\u7684\u9879\u76EE\u7EA7\u914D\u7F6E\u91CC\u79FB\u9664\u8FD9\u4E2A\u6761\u76EE\u3002",
                run: () => write("servers", removeProjectEntry(servers, server))
              })
            }, "\u5220\u9664")
          ]
        )),
        ...profileGlobal.map(profileCard),
        profileGlobal.length === 0 && serversGlobal.length === 0 ? h("li", { className: "smp-empty", key: "empty", style: { gridColumn: "1 / -1" } }, "\u8FD8\u6CA1\u6709\u5168\u5C40 MCP \u2014\u2014 \u70B9\u53F3\u4E0A\u89D2\u300C\u6DFB\u52A0\u670D\u52A1\u5668\u300D\uFF0C\u4F1A\u4F5C\u4E3A\u4E00\u884C\u5199\u8FDB\u914D\u7F6E\u6587\u4EF6\u3002") : null
      ]);
      const mcpProjectList = h("ul", { className: "smp-cards", key: "cards" }, [
        ...serversProject.map((server) => editing?.kind === "mcp" && editing.tier === "project" && editing.id === server.serverName ? serverForm({ tier: "project", scope: project }) : card(
          `mcp:project/${server.serverName}`,
          server.serverName,
          server.transport === "stdio" ? `${server.command} ${(server.args ?? []).join(" ")}`.trim() : server.url,
          server.enabled,
          [["\u4F20\u8F93", server.transport], ["\u547D\u4EE4", server.transport === "stdio" ? `${server.command} ${(server.args ?? []).join(" ")}`.trim() : "\u2014"], ["\u5730\u5740", server.transport === "stdio" ? "\u2014" : server.url], ["\u73AF\u5883\u53D8\u91CF", server.env ? server.env.replace(/=.*/g, "=***") : "\u2014"], ["\u9879\u76EE", server.scope]],
          [
            h("button", {
              className: "smp-button",
              "data-variant": "outline",
              key: "edit",
              disabled: busy,
              onClick: () => {
                setEditing({ kind: "mcp", tier: "project", id: server.serverName });
                setDraft({ serverName: server.serverName, transport: server.transport, url: server.url, command: server.command, args: (server.args ?? []).join(" "), env: server.env ?? "", runtime: server.runtime ?? "auto" });
              }
            }, "\u7F16\u8F91"),
            h("button", {
              className: "smp-button",
              "data-variant": "outline",
              key: "toggle",
              disabled: busy,
              onClick: () => write("servers", replaceProjectEntry(servers, server, { enabled: server.enabled === false }))
            }, server.enabled === false ? "\u542F\u7528" : "\u505C\u7528"),
            h("button", {
              className: "smp-button",
              "data-variant": "danger",
              key: "del",
              disabled: busy,
              onClick: () => write("servers", servers.filter((item) => item !== server))
            }, "\u5220\u9664")
          ]
        )),
        editing?.kind === "mcp" && editing.tier === "project" && editing.id === void 0 ? serverForm({ tier: "project", scope: project }) : null,
        project !== "" && serversProject.length === 0 ? h("li", { className: "smp-empty", key: "empty", style: { gridColumn: "1 / -1" } }, emptyMcpText(projectLabel(project))) : null
      ]);
      const skillsGlobalList = h("ul", { className: "smp-cards", key: "cards" }, [
        ...skillsGlobal.map((skill) => card(
          `skill:global/${skill.name}`,
          skill.name,
          skill.description || "(\u65E0\u63CF\u8FF0)",
          skill.enabled,
          [["\u540D\u79F0", skill.name], ["\u63CF\u8FF0", skill.description], ["\u843D\u76D8", "$DSH_HOME/skills"]],
          [
            h("button", {
              className: "smp-button",
              "data-variant": "outline",
              key: "edit",
              disabled: busy,
              onClick: () => {
                setEditing({ kind: "skill", tier: "global" });
                setDraft({ name: skill.name, description: skill.description, body: skill.body });
              }
            }, "\u7F16\u8F91"),
            h("button", {
              className: "smp-button",
              "data-variant": "danger",
              key: "del",
              disabled: busy,
              onClick: () => write("skills", removeSkill(skills, skill))
            }, "\u5220\u9664")
          ]
        )),
        skillForm({ tier: "global", scope: "global" }),
        skillsGlobal.length === 0 && !(editing && editing.kind === "skill" && editing.tier === "global") ? h("li", { className: "smp-empty", key: "empty", style: { gridColumn: "1 / -1" } }, "\u8FD8\u6CA1\u6709\u9762\u677F\u6DFB\u52A0\u7684\u5168\u5C40\u6280\u80FD \u2014\u2014 \u70B9\u53F3\u4E0A\u89D2\u300C\u6DFB\u52A0\u6280\u80FD\u300D\uFF0C\u4FDD\u5B58\u540E\u5199\u5165\u78C1\u76D8\u3002") : null
      ]);
      const skillsProjectList = h("ul", { className: "smp-cards", key: "cards" }, [
        ...skillsProject.map((skill) => card(
          `skill:project/${skill.name}`,
          skill.name,
          skill.description || "(\u65E0\u63CF\u8FF0)",
          skill.enabled,
          [["\u540D\u79F0", skill.name], ["\u63CF\u8FF0", skill.description], ["\u843D\u76D8", `${skill.scope}/.agents/skills`]],
          [
            h("button", {
              className: "smp-button",
              "data-variant": "outline",
              key: "edit",
              disabled: busy,
              onClick: () => {
                setEditing({ kind: "skill", tier: "project" });
                setDraft({ name: skill.name, description: skill.description, body: skill.body });
              }
            }, "\u7F16\u8F91"),
            h("button", {
              className: "smp-button",
              "data-variant": "danger",
              key: "del",
              disabled: busy,
              onClick: () => write("skills", removeSkill(skills, skill))
            }, "\u5220\u9664")
          ]
        )),
        skillForm({ tier: "project", scope: project }),
        project !== "" && skillsProject.length === 0 ? h("li", { className: "smp-empty", key: "empty", style: { gridColumn: "1 / -1" } }, emptySkillText(projectLabel(project))) : null
      ]);
      const confirmDeleteDialog = deleteConfirmDialog({
        dialog: deleteDialog,
        primitives,
        onCancel: () => setDeleteDialog(null),
        onConfirm: () => {
          const run = deleteDialog?.run;
          setDeleteDialog(null);
          if (typeof run === "function") run();
        }
      });
      const mcpSections = [
        h("ul", { className: "smp-cards", key: "import" }, [importCard(importScope)]),
        tierSection({
          tier: "global",
          kind: "mcp",
          title: "\u5168\u5C40 MCP",
          list: mcpGlobalList,
          subText: `\u5168\u5C40 \xB7 \u914D\u7F6E\u6587\u4EF6 ${profileGlobal.length} \u4E2A \xB7 \u589E\u5220\u6539\u90FD\u4F1A\u5199\u56DE cordis.patch.yml\uFF08\u81EA\u52A8\u5907\u4EFD\uFF09`
        }),
        tierSection({
          tier: "project",
          kind: "mcp",
          title: "\u9879\u76EE\u7EA7 MCP",
          list: mcpProjectList,
          subText: project === "" ? projectMcpSubtitle("", 0) : projectMcpSubtitle(projectLabel(project), serversProject.length)
        })
      ];
      const skillsSections = [
        tierSection({
          tier: "global",
          kind: "skills",
          title: "\u5168\u5C40\u6280\u80FD",
          list: skillsGlobalList,
          subText: `\u5168\u5C40 \xB7 \u9762\u677F\u6DFB\u52A0 ${skillsGlobal.length} \u4E2A \xB7 \u5199\u5165 $DSH_HOME/skills/`
        }),
        tierSection({
          tier: "project",
          kind: "skills",
          title: "\u9879\u76EE\u7EA7\u6280\u80FD",
          list: skillsProjectList,
          subText: project === "" ? "\u672A\u9009\u62E9\u9879\u76EE" : projectSkillSubtitle(projectLabel(project), skillsProject.length)
        })
      ];
      return h("div", { className: "smp-page" }, [
        h("style", { key: "css" }, CSS),
        head,
        tabs,
        filterRowView,
        statusOf(form) === "loading" ? h("p", { className: "smp-empty", key: "loading" }, "\u6B63\u5728\u8BFB\u53D6\u8BBE\u7F6E\u2026") : null,
        error && !editing ? h("p", { className: "smp-error", key: "err" }, error) : null,
        confirmDeleteDialog,
        ...tab === "mcp" ? mcpSections : skillsSections,
        debugOn ? h("section", { className: "smp-group", key: "debug" }, [
          h("div", { className: "smp-groupTitleRow", key: "h" }, h("span", { className: "smp-groupTitle" }, `Loader \u8BCA\u65AD\uFF1A\u5171 ${inventoryRows.length} \u884C\uFF0C\u5176\u4E2D mcp \u76F8\u5173 ${debugMcp.length} \u884C`)),
          h(
            "ul",
            { className: "smp-cards", key: "list" },
            debugMcp.map((row) => h("li", { className: "smp-card", key: row.entryId }, [
              h("div", { className: "smp-cardContent", key: "c", style: { cursor: "default" } }, [
                h("div", { className: "smp-cardMainRow", key: "r" }, [
                  h("span", { className: "smp-cardIdentity", key: "i" }, row.entryId),
                  h("span", { className: "smp-cardEnd", key: "e" }, h("span", { className: "smp-tag", "data-tone": "neutral" }, `${row.enabled ? "on" : "off"}${row.fiberPhase ? ` \xB7 ${row.fiberPhase}` : ""}`))
                ]),
                h("div", { className: "smp-cardDescription", key: "d" }, row.moduleName)
              ])
            ]))
          )
        ]) : null
      ]);
    }
    return {
      inject: ["slots", "configForms", "remote", "remote.pluginInventory"],
      apply(ctx) {
        const form = ctx.configForms.get(NS);
        let inventory;
        try {
          inventory = ctx.remote?.pluginInventory;
        } catch {
          inventory = void 0;
        }
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "skills-mcp",
          order: 20,
          label: () => "Skills & MCP",
          inject: () => ({ form, inventory })
        }, Panel));
      }
    };
  }
});
