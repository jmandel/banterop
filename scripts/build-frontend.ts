// Build static frontends into ./public for production serving
// Usage: bun scripts/build-frontend.ts

import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
// Note: Tailwind is built via CLI in this script for reliability

type AppDef = {
  outPath: string;          // path under public/
  entry: string;            // TS/TSX entry
  html: string;             // source HTML to transform and copy
  css?: string;             // CSS entry (processed via Tailwind plugin)
  extraAssets?: string[];   // additional files to copy (images, misc)
};

const apps: AppDef[] = [
  {
    outPath: '',
    entry: 'src/frontend/scenarios/app.tsx',
    html: 'src/frontend/scenarios/index.html',
    css: 'src/frontend/ui/app.css',
    extraAssets: [
      'src/frontend/scenarios/interlocked-speech-bubbles.png',
    ],
  },
  {
    outPath: 'watch',
    entry: 'src/frontend/watch/app.tsx',
    html: 'src/frontend/watch/index.html',
    css: 'src/frontend/ui/app.css',
  },
  {
    outPath: 'client',
    entry: 'src/frontend/client/main.tsx',
    html: 'src/frontend/client/index.html',
    css: 'src/frontend/ui/app.css',
    extraAssets: [
      // images or other static assets can be added here
    ],
  },
];

async function ensureDir(path: string) {
  if (!existsSync(path)) await mkdir(path, { recursive: true });
}

async function copyFile(src: string, dest: string) {
  const data = await Bun.file(src).arrayBuffer();
  await ensureDir(dirname(dest));
  await Bun.write(dest, data);
}

function transformHtml(content: string, entryFilename: string, apiBase: string): string {
  // Swap TSX module script to built JS
  content = content.replace(/src="\.\/(app|main)\.(t|j)sx?"/g, (_m, name) => `src="./${name}.js"`);
  // Normalize API_BASE to relative '/api'
  content = content.replace(/API_BASE:\s*"http:\/\/localhost:3000\/api"/g, `API_BASE: ${JSON.stringify(apiBase)}`);
  content = content.replace(/href=\"\.\.\/ui\/app\.css\"/g, 'href=\".\/app.css\"');
  content = content.replace(/href=\"tailwindcss\"/g, 'href=\".\/app.css\"');
  return content;
}

async function buildApp(app: AppDef, apiBase: string) {
  const outdir = join('public', app.outPath);
  await ensureDir(outdir);

  const build = await Bun.build({
    entrypoints: [app.entry],
    outdir,
    target: 'browser',
    minify: true,
    define: {
      __API_BASE__: JSON.stringify(apiBase),
    },
  });
  if (!build.success) {
    console.error('Build failed for', app.outPath);
    for (const m of build.logs) console.error(m);
    process.exitCode = 1;
    return;
  }

  // Build CSS via Tailwind CLI if provided
  if (app.css) {
    const proc = Bun.spawn({
      cmd: [
        'bunx',
        '--bun',
        '@tailwindcss/cli',
        '-i',
        app.css,
        '-o',
        join(outdir, 'app.css'),
        '--minify',
      ],
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error('Tailwind build failed for', app.outPath);
      process.exitCode = exitCode;
      return;
    }
  }

  // Transform and copy index.html
  const html = await Bun.file(app.html).text();
  const entryName = basename(app.entry).replace(/\.(t|j)sx?$/, '.js');
  const transformed = transformHtml(html, entryName, apiBase);
  await Bun.write(join(outdir, 'index.html'), transformed);

  // Copy extra assets if present
  for (const asset of app.extraAssets || []) {
    if (existsSync(asset)) {
      await copyFile(asset, join(outdir, basename(asset)));
    }
  }
}

export async function buildAllFrontends(apiBase: string) {
  // Copy a simple home landing page
  await ensureDir('public');
  const siteOrigin = apiBase.startsWith('http') ? apiBase.replace(/\/?api$/, '') : '';

  for (const app of apps) {
    console.log('Building', app.outPath);
    await buildApp(app, apiBase);
  }
  console.log('Frontend build complete: ./public');
}

if (import.meta.main) {
  const apiBase = process.env.PUBLIC_API_BASE_URL || '/api';
  buildAllFrontends(apiBase).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
