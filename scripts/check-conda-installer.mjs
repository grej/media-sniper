#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const recipe = await readFile(join(root, "recipe/recipe.yaml"), "utf8");
const launcher = await readFile(join(root, "packaging/conda/media-sniper-installer"), "utf8");
const packageMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

if (!recipe.includes(`version: "${packageMetadata.version}"`)) throw new Error("Conda recipe release version is stale");
if (!/name:\s*media-sniper-installer/.test(recipe)) throw new Error("Conda package identity is missing");
if (/post[-_]link|run_post_link/i.test(recipe + launcher)) throw new Error("Conda installer must not use post-link scripts");
if (!launcher.includes("Install Media Sniper Companion.app")) throw new Error("Launcher does not invoke the graphical installer");
if (!launcher.includes("install-receipt.json")) throw new Error("Launcher does not verify installation completion");
await access(join(root, "packaging/conda/media-sniper-installer"), constants.R_OK);
console.log("Validated clone-free Conda installer recipe and launcher");
