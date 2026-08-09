import { render } from "solid-js/web";
import { App } from "./App.tsx";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root missing");

render(() => <App />, container);
