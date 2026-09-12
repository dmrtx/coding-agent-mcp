import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const distDir = path.join(projectRoot, "dist");

// `dist` is a generated, ignored directory at one fixed path. Cleaning it
// before TypeScript emits prevents removed modules (for example an abandoned
// integration) from surviving as stale runtime artifacts.
fs.rmSync(distDir, { recursive: true, force: true });
