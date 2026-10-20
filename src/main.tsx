import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import QuickMenu from "./QuickMenu";

const quickMenu = new URLSearchParams(window.location.search).get("quick-menu") === "1";
if (quickMenu) {
  document.documentElement.classList.add("quick-html");
  document.body.classList.add("quick-body");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{quickMenu ? <QuickMenu /> : <App />}</React.StrictMode>,
);
