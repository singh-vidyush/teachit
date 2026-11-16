import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fonts = resolve(root, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
const destination = resolve(root, "public/excalidraw-assets");

if (existsSync(fonts)) {
  mkdirSync(destination, { recursive: true });
  cpSync(fonts, destination, { recursive: true, force: true });
} else {
  console.warn("Excalidraw font assets were not found; the editor can load them from its CDN.");
}
