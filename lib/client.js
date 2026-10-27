// dsh-kb-sync 浏览器半侧：在「插件 → dsh-kb-sync」页里渲染配置区
// 格式：lazy-CJS factory（官方 docs/subsystems/client-modules 与 ui-plugin-manager 的 slot 契约）
window.__ModuleLoader__.load({
  id: "dsh-kb-sync",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const exports = {};
    const name = "dsh-kb-sync";
    const inject = ["slots", "configForms"];

    const FIELDS = [
      ["remote", "服务器地址", "ssh://mnemon@host/home/mnemon/mnemon-sync.git；留空 = 只在本机"],
      ["device", "本机分片名", "留空 = 用主机名"],
      ["intervalMinutes", "兜底同步（分钟）", "0 = 关闭，只靠事件触发"],
      ["notifyUrl", "通知服务地址", "http://host:7392；留空 = 不实时通知"],
      ["notifyToken", "通知服务 token", ""],
    ];

    function useSnapshot(scope) {
      const [snap, setSnap] = React.useState(() => scope.getSnapshot());
      React.useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
      return snap || { value: {} };
    }

    function Field(props) {
      const { label, hint, value, onChange, password } = props;
      return h("label", { style: { display: "grid", gap: 4, marginBottom: 10 } },
        h("span", { style: { fontSize: 12, opacity: 0.75 } }, label),
        h("input", {
          type: password ? "password" : "text",
          value: value ?? "",
          onChange: (e) => onChange(e.target.value),
          placeholder: hint || "",
          style: { padding: "6px 8px", borderRadius: 6, border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit" },
        }),
        hint ? h("span", { style: { fontSize: 11, opacity: 0.55 } }, hint) : null);
    }

    function ConfigPage(props) {
      const { view } = props;
      const scope = props.scope || props.form;
      if (!scope || typeof scope.getSnapshot !== "function") {
        return h("div", { style: { fontSize: 12, opacity: 0.7 } }, "此版本宿主没有暴露 configForms，配置请改 profile 的 dsh-kb-sync 行。");
      }
      const snap = useSnapshot(scope);
      const value = snap.value || {};
      const [draft, setDraft] = React.useState({});
      const [status, setStatus] = React.useState("idle");
      const merged = (key) => (key in draft ? draft[key] : value[key]);
      const set = (key, v) => setDraft((d) => ({ ...d, [key]: v }));

      if (view === "summary") {
        return h("div", { style: { fontSize: 12, opacity: 0.75 } },
          value.remote ? "服务器：" + value.remote : "未配置服务器（只在本机）",
          " · 兜底 " + (value.intervalMinutes ?? 30) + " 分钟");
      }

      const save = async () => {
        setStatus("saving");
        try {
          for (const [key] of FIELDS) {
            if (!(key in draft)) continue;
            const v = draft[key];
            if (v === "" || v == null) await scope.unset(key);
            else await scope.set(key, key === "intervalMinutes" ? Number(v) || 30 : v);
          }
          if ("spaces" in draft) {
            const text = String(draft.spaces ?? "").trim();
            if (!text) await scope.unset("spaces");
            else await scope.set("spaces", JSON.parse(text));
          }
          setDraft({});
          setStatus("saved");
        } catch (error) {
          console.error("[kb-sync] save failed", error);
          setStatus("failed");
        }
      };

      return h("div", { style: { display: "grid", gap: 4, maxWidth: 720, padding: "4px 0 12px" } },
        h("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, "知识库同步"),
        ...FIELDS.map(([key, label, hint]) =>
          h(Field, {
            key, label, hint, password: key === "notifyToken",
            value: merged(key),
            onChange: (v) => set(key, v),
          })),
        h("label", { style: { display: "grid", gap: 4, marginBottom: 10 } },
          h("span", { style: { fontSize: 12, opacity: 0.75 } }, "空间策略（JSON）"),
          h("textarea", {
            rows: 6,
            value: draft.spaces !== undefined ? draft.spaces : JSON.stringify(value.spaces ?? {}, null, 2),
            onChange: (e) => set("spaces", e.target.value),
            style: { fontFamily: "monospace", fontSize: 12, padding: 8, borderRadius: 6, border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit" },
          }),
          h("span", { style: { fontSize: 11, opacity: 0.55 } },
            '例如 {"private-notes":{"mode":"local"},"draft":{"mode":"cloud","enabled":false}}'),
        ),
        h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
          h("button", { onClick: save, disabled: status === "saving", style: { padding: "6px 14px", borderRadius: 6, cursor: "pointer" } },
            status === "saving" ? "保存中…" : "保存"),
          status === "saved" ? h("span", { style: { fontSize: 12, color: "#3fb950" } }, "已保存，即时生效") : null,
          status === "failed" ? h("span", { style: { fontSize: 12, color: "#f85149" } }, "保存失败，看控制台") : null,
        ),
        h("div", { style: { fontSize: 11, opacity: 0.55, marginTop: 6 } },
          "写入由 kb-sync 事件链自动推送；查同步状态用 agent 的 kb_status 或命令行 kb-status。"),
      );
    }

    function apply(ctx) {
      let scope;
      try { scope = ctx.configForms && ctx.configForms.get ? ctx.configForms.get(name) : undefined; } catch (e) { console.error("[kb-sync] configForms.get failed", e); }
      try {
        ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register(
          { name: "plugins.bundle.config", key: name },
          (props) => h(ConfigPage, { view: props.view, form: props.form, scope }),
        ));
      } catch (e) { console.error("[kb-sync] slot register failed", e); }
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return exports;
  },
});
