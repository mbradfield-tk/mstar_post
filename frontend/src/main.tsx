import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installColumnResize } from "./colresize";
import { installStickyScroll } from "./stickyscroll";
import "./styles.css";

installColumnResize();
installStickyScroll();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
