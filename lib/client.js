// dsh-industrial-design client bundle.
//
// Renders an editable settings card into `plugins.bundle.config` (keyed by the
// bundle's package name) so the five flow parameters can be edited from the
// plugin's own Settings page, the same way dsh-image-gen's
// `ImageGenerationSettingsCard` does. Reads/writes go through the DSH 0.1.7+
// `configForms` service (keyed by the Loader entry id).
window.__ModuleLoader__.load({
  id: "dsh-industrial-design",
  factory: function (require) {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");

    var inject = ["slots"];
    var PACKAGE_ID = "dsh-industrial-design";
    var ENTRY_ID = "industrial-design";

    var FIELDS = [
      { key: "firstCategoryN", label: "首批同类项目数 N", kind: "number", hint: "首品类样本数，默认 30。示例：30" },
      { key: "consistencyThreshold", label: "一致性阈值", kind: "number", hint: "同源一致率门槛，默认 0.9。示例：0.9（≥90%）" },
      { key: "skeletonMatchThreshold", label: "S5.5 骨架吻合度阈值", kind: "number", hint: "几何骨架与锚定线稿吻合度门槛，默认 0.85。示例：0.85" },
      { key: "maxConvergenceRounds", label: "最大收敛轮次", kind: "number", hint: "触顶失败收敛轮次上限，默认 3。示例：3" },
      { key: "categoryList", label: "品类白名单（逗号分隔）", kind: "text", hint: "允许的 category_id 列表，留空=不限制。示例：handheld, wearable, appliance" }
    ];

    function safeGet(ctx, name) {
      if (!ctx || typeof ctx.get !== "function") return undefined;
      try { return ctx.get(name); } catch (_) { return undefined; }
    }

    function readSnapshot(scope) {
      if (scope && typeof scope.getSnapshot === "function") {
        try { return scope.getSnapshot(); } catch (_) { return { value: {}, writable: false }; }
      }
      return { value: {}, writable: false };
    }

    function subscribe(scope, cb) {
      if (scope && typeof scope.subscribe === "function") return scope.subscribe(cb);
      return function () {};
    }

    function findField(key) {
      for (var i = 0; i < FIELDS.length; i += 1) if (FIELDS[i].key === key) return FIELDS[i];
      return { key: key, kind: "text" };
    }

    function toText(def, current) {
      if (def.kind === "text") {
        return Array.isArray(current) ? current.join(", ") : (current == null ? "" : String(current));
      }
      return current == null ? "" : String(current);
    }

    function fromText(def, raw) {
      if (def.kind === "number") {
        var n = Number(raw);
        if (!isFinite(n)) return undefined;
        return n;
      }
      var parts = String(raw).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      return parts;
    }

    function SettingsCard(props) {
      var scope = props && props.scope ? props.scope : null;
      var [snap, setSnap] = React.useState(function () { return readSnapshot(scope); });
      var [error, setError] = React.useState(null);
      var [savedKey, setSavedKey] = React.useState(null);

      React.useEffect(function () {
        function onChange() { setSnap(readSnapshot(scope)); }
        var unsub = subscribe(scope, onChange);
        onChange();
        return unsub;
      }, [scope]);

      var value = (snap && snap.value) || {};
      var writable = !!(snap && snap.writable);

      function commit(key, raw) {
        var def = findField(key);
        var parsed = fromText(def, raw);
        if (parsed === undefined) { setError("请输入有效值"); setSavedKey(null); return; }
        setError(null);
        var write = scope && typeof scope.set === "function" ? scope.set(key, parsed) : Promise.resolve(false);
        Promise.resolve(write).then(function (ok) {
          setSavedKey(key);
          if (ok === false) setError("保存被拒绝（只读或未就绪）");
        }, function (e) {
          setError(e && e.message ? e.message : String(e));
        });
      }

      var rows = FIELDS.map(function (def) {
        var text = toText(def, value[def.key]);
        return React.createElement(
          "div",
          { key: def.key, style: { marginBottom: "12px" } },
          React.createElement(
            "label",
            { style: { display: "block", fontWeight: 600, fontSize: "12px", lineHeight: "18px", marginBottom: "4px", color: "#1f2328" } },
            def.label
          ),
          React.createElement("input", {
            type: def.kind === "number" ? "number" : "text",
            value: text,
            disabled: !writable,
            step: def.kind === "number" ? "any" : undefined,
            placeholder: def.hint,
            onChange: function (e) { commit(def.key, e.target.value); },
            style: {
              boxSizing: "border-box",
              width: "100%",
              padding: "6px 8px",
              fontSize: "12px",
              lineHeight: "18px",
              borderRadius: "6px",
              border: "1px solid #d1d5db",
              background: writable ? "#fff" : "#f3f4f6",
              color: "#1f2328"
            }
          }),
          React.createElement(
            "div",
            { style: { marginTop: "3px", fontSize: "11px", lineHeight: "16px", color: "#8b93a1" } },
            def.hint
          )
        );
      });

      return React.createElement(
        "div",
        { style: { padding: "4px 0 8px" } },
        React.createElement("div", { style: { fontWeight: 700, fontSize: "13px", lineHeight: "20px", marginBottom: "10px", color: "#1f2328" } }, "流程参数"),
        rows,
        savedKey ? React.createElement("div", { style: { color: "#16a34a", fontSize: "11px", lineHeight: "16px", marginTop: "2px" } }, "已保存") : null,
        error ? React.createElement("div", { style: { color: "#dc2626", fontSize: "11px", lineHeight: "16px", marginTop: "4px" } }, error) : null,
        !writable ? React.createElement("div", { style: { color: "#b45309", fontSize: "11px", lineHeight: "16px", marginTop: "6px" } }, "配置当前只读（宿主未开放可写配置）") : null
      );
    }

    function apply(ctx) {
      var configForms = safeGet(ctx, "configForms");
      var scope;
      if (configForms && typeof configForms.get === "function") {
        try { scope = configForms.get(ENTRY_ID); } catch (_) { scope = undefined; }
      }
      if (!scope || typeof scope.getSnapshot !== "function") {
        scope = {
          getSnapshot: function () { return { value: {}, writable: false, status: "unavailable" }; },
          subscribe: function () { return function () {}; },
          set: function () { return Promise.resolve(false); }
        };
      }
      var injectFace = function () { return { scope: scope }; };
      try {
        ctx.slots.inject("plugins.bundle.config", function () {
          return ctx.slots.register(
            { name: "plugins.bundle.config", key: PACKAGE_ID, inject: injectFace },
            SettingsCard
          );
        });
      } catch (e) {
        try { console.error("[dsh-industrial-design] settings card registration failed:", e); } catch (_) {}
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
