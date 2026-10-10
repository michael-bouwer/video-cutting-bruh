import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installTheme } from "./lib/theme";

installTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Dev-only handle for debugging from the devtools console.
if (import.meta.env.DEV) {
  Promise.all([
    import("./store"),
    import("./lib/media"),
    import("./lib/project"),
    import("./lib/history"),
    import("./engine/player"),
    import("./lib/screenshot"),
  ]).then(([store, media, project, history, engine, screenshot]) => {
    (window as unknown as Record<string, unknown>).__vcb = { useStore: store.useStore, media, project, history, player: engine.player, screenshot };
  });
}
