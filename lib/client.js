// dsh-kb-sync 设置页（极简：服务器地址 + 本机名 + 同步状态）
window.__ModuleLoader__.load({
  id: "dsh-kb-sync",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const exports = {};
    const name = "dsh-kb-sync";
    const inject = ["slots"];
    const API = "http://127.0.0.1:7394/kb/config";

    const styles = {
      box: { display: "grid", gap: 10, maxWidth: 620, padding: "4px 0 12px" },
      row: { display: "grid", gap: 4 },
      label: { fontSize: 12, opacity: 0.75 },
      input: { padding: "7px 9px", borderRadius: 6, border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit", fontSize: 13 },
      pill: (bg, fg) => ({ display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 10px", borderRadius: 999, fontSize: 12, background: bg, color: fg }),
      btn: { padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, width: "fit-content" },
      hint: { fontSize: 11, opacity: 0.55 },
    };

    function StatusPill({ state }) {
      if (!state) return h("span", { style: styles.pill("rgba(127,127,127,.18)", "inherit") }, "读取中…");
      if (!state.configured) return h("span", { style: styles.pill("rgba(255,180,60,.18)", "#ffb43c") }, "未配置");
      if (state.syncing) return h("span", { style: styles.pill("rgba(80,160,255,.18)", "#6bb2ff") }, "正在同步…");
      return h("span", { style: styles.pill("rgba(63,185,80,.18)", "#3fb950") }, "已同步");
    }

    function Page() {
      const [state, setState] = React.useState(null);
      const [host, setHost] = React.useState("");
      const [device, setDevice] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [dirty, setDirty] = React.useState(false);

      const load = React.useCallback(async () => {
        try {
          const res = await fetch(API, { cache: "no-store" });
          const data = await res.json();
          setState(data);
          if (!dirty) { setHost(data.host || data.remote || ""); setDevice(data.device || data.defaultDevice || ""); }
        } catch (error) {
          setState({ configured: false, offline: true });
        }
      }, [dirty]);

      React.useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);

      const save = async () => {
        setBusy(true);
        try {
          const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ host, device }) });
          const data = await res.json();
          setDirty(false);
          await load();
          if (data.ok === false) console.warn("[kb-sync] sync failed", data);
        } catch (error) {
          console.error("[kb-sync] save failed", error);
        } finally { setBusy(false); }
      };

      return h("div", { style: styles.box },
        h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 2 } },
          h("span", { style: { fontSize: 13, fontWeight: 600 } }, "知识库同步"),
          h(StatusPill, { state }),
          state && state.lastSync ? h("span", { style: styles.hint }, "上次 " + new Date(state.lastSync).toLocaleString()) : null,
        ),
        h("label", { style: styles.row },
          h("span", { style: styles.label }, "服务器 IP（或完整地址）"),
          h("input", {
            style: styles.input,
            value: host,
            placeholder: "10.0.0.5",
            onChange: (e) => { setHost(e.target.value); setDirty(true); },
          }),
          h("span", { style: styles.hint }, "只填 IP 即可：默认走 ssh://mnemon@<IP>/home/mnemon/mnemon-sync.git；也可直接粘完整地址；留空 = 只在本机"),
        ),
        h("label", { style: styles.row },
          h("span", { style: styles.label }, "本机名"),
          h("input", {
            style: styles.input,
            value: device,
            placeholder: state?.defaultDevice || "本机设备名",
            onChange: (e) => { setDevice(e.target.value); setDirty(true); },
          }),
          h("span", { style: styles.hint }, "默认是本机设备名，可改；用来在多台设备里区分分片"),
        ),
        h("div", { style: { display: "flex", gap: 10, alignItems: "center", marginTop: 4 } },
          h("button", { style: styles.btn, onClick: save, disabled: busy }, busy ? "同步中…" : "保存并同步"),
          state && state.offline ? h("span", { style: { fontSize: 11, color: "#f85149" } }, "插件未运行（127.0.0.1:7394 无响应）") : null,
        ),
      );
    }

    function apply(ctx) {
      try {
        ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register(
          { name: "plugins.bundle.config", key: name },
          () => h(Page),
        ));
      } catch (e) { console.error("[kb-sync] slot register failed", e); }
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return exports;
  },
});
