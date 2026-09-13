import { defineConfig } from 'vite';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { renameSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { build as viteBuild } from 'vite';
import {
  DEFAULT_COMPANION_INSTALL_URL,
  makeVariantManifest,
  variantForMode,
} from './build/extension-variants.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const variant = variantForMode(mode);
  const isCompanion = variant === 'companion';
  const isProduction = mode !== 'development';
  const outputDirectory = isCompanion ? 'dist-companion' : 'dist';
  const companionInstallUrl = isCompanion
    ? process.env.MEDIA_SNIPER_COMPANION_INSTALL_URL ?? DEFAULT_COMPANION_INSTALL_URL
    : '';
  const compileTimeConstants = {
    __COMPANION_BUILD__: JSON.stringify(isCompanion),
    __COMPANION_INSTALL_URL__: JSON.stringify(companionInstallUrl),
  };

  return {
    define: compileTimeConstants,
    build: {
      outDir: outputDirectory,
      emptyOutDir: true,
      rollupOptions: {
        input: {
          // Chromium MV3 service workers do not support dynamic import(). Use
          // a companion-only entry so its native-host service is registered
          // through a static module graph without leaking into the standard
          // extension build.
          'background': resolve(
            __dirname,
            isCompanion ? 'src/service-worker-companion.ts' : 'src/service-worker.ts',
          ),
          'offscreen/offscreen': resolve(__dirname, 'src/offscreen/offscreen.html'),
          // Content script excluded - will be built separately as IIFE
          'popup/popup': resolve(__dirname, 'src/popup/popup.html'),
          'options/options': resolve(__dirname, 'src/options/options.html'),
        },
        output: {
          // ES modules for service worker and other scripts
          format: 'es',
          entryFileNames: (chunkInfo) => {
            // Keep HTML files in their directories, JS files follow the same structure
            if (chunkInfo.name.includes('popup')) {
              return 'popup/popup.js';
            }
            if (chunkInfo.name.includes('options')) {
              return 'options/options.js';
            }
            if (chunkInfo.name.includes('background')) {
              return 'background.js';
            }
            if (chunkInfo.name.includes('offscreen')) {
              return 'offscreen/offscreen.js';
            }
            return '[name].js';
          },
          chunkFileNames: '[name].js',
          assetFileNames: (assetInfo) => {
            // Keep HTML files in their directories
            if (assetInfo.name?.endsWith('.html')) {
              if (assetInfo.name.includes('popup')) {
                return 'popup/popup.html';
              }
              if (assetInfo.name.includes('options')) {
                return 'options/options.html';
              }
              if (assetInfo.name.includes('offscreen')) {
                return 'offscreen/offscreen.html';
              }
            }
            return '[name].[ext]';
          },
        },
      },
      sourcemap: !isProduction,
      minify: isProduction,
      target: 'es2020',
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
      extensions: ['.ts', '.tsx', '.js'],
    },
    plugins: [
      {
        name: 'test-fixture-byte-ranges',
        configureServer(server) {
          server.middlewares.use('/__proxied-media', (request, response, next) => {
            const requestUrl = new URL(request.url ?? '/', 'http://fixture');
            const authenticated = request.headers.cookie?.includes('media_session=e2e') &&
              request.headers.referer?.includes('/tests/e2e/fixtures/proxied-player.html');
            if (requestUrl.pathname === '/something_720p.mp4') {
              if (!authenticated || requestUrl.searchParams.get('v-acctoken') !== 'e2e-secret') {
                response.statusCode = 403;
                response.setHeader('Content-Type', 'text/html');
                return void response.end('<h1>Forbidden</h1>');
              }
              const file = encodeURIComponent('protected/video_720p.mp4?v-acctoken=e2e-secret');
              response.statusCode = 302;
              response.setHeader(
                'Location',
                `/__proxied-media/remote_control.php?file=${file}&rnd=123456`,
              );
              return void response.end();
            }
            if (requestUrl.pathname === '/preview_720p.mp4.jpg') {
              response.statusCode = 200;
              response.setHeader('Content-Type', 'image/jpeg');
              response.setHeader('Content-Length', '4');
              return void response.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
            }
            if (requestUrl.pathname !== '/remote_control.php') return next();
            if (
              !authenticated ||
              requestUrl.searchParams.get('file') !==
                'protected/video_720p.mp4?v-acctoken=e2e-secret' ||
              requestUrl.searchParams.get('rnd') !== '123456'
            ) {
              response.statusCode = 403;
              response.setHeader('Content-Type', 'application/json');
              return void response.end('{"error":"invalid capability"}');
            }

            const fixturePath = resolve(__dirname, 'tests/fixtures/direct-faststart.mp4');
            const bytes = readFileSync(fixturePath);
            const match = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
            const start = match ? Number(match[1]) : 0;
            const requestedEnd = match?.[2] ? Number(match[2]) : bytes.length - 1;
            const end = Math.min(requestedEnd, bytes.length - 1);
            if (!Number.isSafeInteger(start) || start < 0 || start > end) {
              response.statusCode = 416;
              response.setHeader('Content-Range', `bytes */${bytes.length}`);
              return void response.end();
            }
            const part = bytes.subarray(start, end + 1);
            response.statusCode = 206;
            response.setHeader('Accept-Ranges', 'bytes');
            response.setHeader('Content-Type', 'video/mp4');
            response.setHeader('Content-Length', part.length);
            response.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
            return void response.end(part);
          });

          server.middlewares.use('/__range-fixtures', (request, response, next) => {
            const filename = basename(new URL(request.url ?? '/', 'http://fixture').pathname);
            const fixturePath = resolve(__dirname, 'tests/fixtures', filename);
            if (!existsSync(fixturePath)) return next();
            const bytes = readFileSync(fixturePath);
            response.setHeader('Accept-Ranges', 'bytes');
            response.setHeader('Content-Type', filename.endsWith('.webm') ? 'video/webm' : 'video/mp4');
            const match = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
            if (!match) {
              response.setHeader('Content-Length', bytes.length);
              return void response.end(bytes);
            }
            const start = Number(match[1]);
            const requestedEnd = match[2] ? Number(match[2]) : bytes.length - 1;
            const end = Math.min(requestedEnd, bytes.length - 1);
            if (!Number.isSafeInteger(start) || start < 0 || start > end) {
              response.statusCode = 416;
              response.setHeader('Content-Range', `bytes */${bytes.length}`);
              return void response.end();
            }
            const part = bytes.subarray(start, end + 1);
            response.statusCode = 206;
            response.setHeader('Content-Length', part.length);
            response.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
            return void response.end(part);
          });
        },
      },
      {
        name: 'generate-variant-manifest',
        buildStart() {
          const baseManifest = JSON.parse(
            readFileSync(resolve(__dirname, 'manifest.json'), 'utf8'),
          );
          const manifest = makeVariantManifest(baseManifest, variant);
          this.emitFile({
            type: 'asset',
            fileName: 'manifest.json',
            source: `${JSON.stringify(manifest, null, 2)}\n`,
          });
        },
      },
      // Plugin to move HTML files to correct locations and fix script paths
      {
        name: 'move-html-files',
        closeBundle() {
          const htmlMoves = [
            { from: `${outputDirectory}/src/popup/popup.html`, to: `${outputDirectory}/popup/popup.html` },
            { from: `${outputDirectory}/src/options/options.html`, to: `${outputDirectory}/options/options.html` },
            { from: `${outputDirectory}/src/offscreen/offscreen.html`, to: `${outputDirectory}/offscreen/offscreen.html` },
          ];
          
          htmlMoves.forEach(({ from, to }) => {
            if (existsSync(from)) {
              renameSync(from, to);
            }
          });
          
          // Fix script paths to be relative
          const htmlFiles = [
            `${outputDirectory}/popup/popup.html`,
            `${outputDirectory}/options/options.html`,
            `${outputDirectory}/offscreen/offscreen.html`,
          ];
          
          htmlFiles.forEach((file) => {
            if (existsSync(file)) {
              let content = readFileSync(file, 'utf-8');
              // Replace absolute paths with relative paths
              content = content.replace(/src="\/(popup|options|offscreen)\/([^"]+)"/g, 'src="./$2"');
              writeFileSync(file, content, 'utf-8');
            }
          });
        },
      },
      // Plugin to build content script separately as IIFE (content scripts can't use ES modules)
      {
        name: 'build-content-script-as-iife',
        async writeBundle() {
          // Use writeBundle instead of closeBundle to avoid recursion
          // This runs after files are written but before closeBundle
          const buildingContentScript = (globalThis as any).__buildingContentScript;
          if (buildingContentScript) {
            return;
          }
          
          (globalThis as any).__buildingContentScript = true;
          
          try {
            // Build content script separately with IIFE format
            await viteBuild({
              configFile: false, // Don't use the main config file
              build: {
                outDir: resolve(__dirname, outputDirectory),
                emptyOutDir: false,
                rollupOptions: {
                  input: resolve(__dirname, 'src/content.ts'),
                  output: {
                    format: 'iife',
                    entryFileNames: 'content.js',
                    inlineDynamicImports: true, // Bundle everything into one file
                  },
                },
                minify: isProduction,
                sourcemap: !isProduction,
                target: 'es2020',
              },
              resolve: {
                alias: {
                  '@': resolve(__dirname, './src'),
                },
                extensions: ['.ts', '.tsx', '.js'],
              },
              define: compileTimeConstants,
              optimizeDeps: {
                exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
              },
              plugins: [], // No plugins to avoid recursion
            });
          } finally {
            (globalThis as any).__buildingContentScript = false;
          }
        },
      },
    ],
    // Exclude FFmpeg packages from optimization
    optimizeDeps: {
      exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
    },
    // Watch options
    server: {
      watch: {
        ignored: ['**/ffmpeg/**'],
      },
    },
  };
});
