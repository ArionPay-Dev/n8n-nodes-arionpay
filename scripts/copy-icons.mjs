// Copy icons (and codex files) next to the compiled nodes and credentials.
import { cpSync, readdirSync, existsSync } from "node:fs";
const dirs = [...readdirSync("nodes").map((d) => `nodes/${d}`), "credentials"];
for (const dir of dirs) {
  for (const f of readdirSync(dir)) {
    if (/\.(svg|png)$/.test(f) || f.endsWith(".node.json")) {
      if (existsSync(`dist/${dir}`)) cpSync(`${dir}/${f}`, `dist/${dir}/${f}`);
    }
  }
}
