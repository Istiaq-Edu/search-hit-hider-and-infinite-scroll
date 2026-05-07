import { render } from "preact";
import { OptionsPage } from "./OptionsPage";

const root = document.getElementById("app");
if (root) render(<OptionsPage />, root);
