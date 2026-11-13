import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import { installColumnResize } from "./colresize";
import { installStickyScroll } from "./stickyscroll";
import "./styles.css";

installColumnResize();
installStickyScroll();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary label="The app"><App /></ErrorBoundary>
  </React.StrictMode>,
);
