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
          ctx.inject(["pluginNavigation"], function () {
            // rc.2 opens its list through the public package navigation face.
            ctx.pluginNavigation.openBundle("");
          });
        } else if (view.mode === "session" && view.sessionId) {
          ctx.uiWorkspace.openSession(view.sessionId);
        } else if (view.mode === "models") {
          ctx.slots.inject("settings.launcher", function () {
            return ctx.slots.register({ name: "settings.launcher", id: "coding-agent-models" }, function ModelsLauncher(props) {
              var openSection = props.openSection;
              React.useEffect(function () { openSection("models"); }, [openSection]);
              return null;
            });
          });
        }
      }
    };
  }
});
