const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node16',
  sourcemap: !production,
  minify: production,
  logLevel: 'info'
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ['webview-ui/index.tsx'],
  bundle: true,
  outfile: 'media/main.js',
  format: 'iife',
  platform: 'browser',
  target: ['chrome100', 'firefox100', 'safari14'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': production ? '"production"' : '"development"'
  }
};

async function main() {
  const contexts = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig)
  ]);
  if (watch) {
    await Promise.all(contexts.map(c => c.watch()));
    console.log('[esbuild] watching for changes...');
  } else {
    await Promise.all(contexts.map(c => c.rebuild()));
    await Promise.all(contexts.map(c => c.dispose()));
    console.log('[esbuild] build complete');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
