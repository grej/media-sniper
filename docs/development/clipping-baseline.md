# Clipping baseline

Baseline commit: `8eb58839d336ff3a0f85ea5292db2f276663e2d6` (Media Bridge 1.11.0)

Recorded on 2026-08-15 with Node.js 24.10.0 and npm 11.13.0 on macOS.

| Check | Result |
| --- | --- |
| `npm ci` | Passed; npm reported the existing audit state of 1 moderate and 5 high advisories. |
| `npm run type-check` | Passed. |
| `npm run build` | Passed; Vite 7.2.2 emitted `dist/`. |
| Unpacked load | Build structure verified; final Chrome/Brave manual matrix remains pending because the connected in-app browser cannot install unpacked Chromium extensions. |
| Existing direct download smoke | Pending deterministic local fixture. |
| Existing HLS download smoke | Pending deterministic local fixture. |

The dependency advisories were recorded but not auto-fixed because `npm audit fix`
would make unrelated dependency changes outside the clipping scope.

## M0 browser media spike

The Vite-bundled Mediabunny 1.54.0 path was exercised in a Chromium browser
against the deterministic 10-second local MP4 fixture:

- Blob Fast trim, 2–6 seconds: passed; 362,230-byte MP4, 132 progress events.
- Blob Exact trim, 2–6 seconds: passed with forced AVC/AAC conversion support.
- URL trim: passed and emitted `Range: bytes=0-` through the custom `fetchFn`.
- Pre-aborted exact conversion: passed with a deterministic `AbortError`.
- Extension production bundle: passed under the existing CSP; offscreen bundle
  includes Mediabunny and remains self-contained.
