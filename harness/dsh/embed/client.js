/* Native dsh Client entry: loaded by its own module table, never Next/React's. */
window.__ModuleLoader__.load({
  id: "@coding-agent-web/dsh-embed",
  factory: function (require) {
    var React = require("react");
    return {
      inject: ["slots", "layout", "uiWorkspace", "sessions"],
      apply: function (ctx) {
        var view = window.__CODING_AGENT_DSH_VIEW__ || {};
        var publishSelection = function () {
          var state = ctx.sessions.list.getSnapshot();
          var selected = Object.values(state.byId).find(function (row) { return row.retainedBy.mainView > 0; });
          window.parent.postMessage({ type: "coding-agent-dsh-selection", nativeId: selected ? selected.id : "" }, window.location.origin);
        };
        ctx.effect(function () { return ctx.sessions.list.subscribe(publishSelection); });
        publishSelection();
        if (view.mode === "plugins") {
          ctx.inject(["pluginNavigation"], function (scope) {
            // Injected capabilities belong to this child scope, not its parent.
            scope.pluginNavigation.openBundle("");
          });
        } else if (view.mode === "session" && view.sessionId) {
          var opened = false;
          var openSession = function () {
            var state = ctx.sessions.list.getSnapshot();
            if (opened || state.phase !== "ready" || !state.byId[view.sessionId]) return;
            opened = true;
            ctx.uiWorkspace.openSession(view.sessionId);
          };
          ctx.effect(function () {
            var stop = ctx.sessions.list.subscribe(openSession);
            openSession();
            return stop;
          });
        } else if (view.mode === "models") {
          ctx.slots.inject("settings.launcher", function () {
            return ctx.slots.register({ name: "settings.launcher", id: "coding-agent-models" }, function ModelsLauncher(props) {
              var open = props.openSettings;
              React.useEffect(function () { open(); }, [open]);
              return React.createElement("button", { type: "button", onClick: open }, "Models and credentials");
            });
          });
        }
      }
    };
  }
});
