import { defineConfig, type Plugin } from 'vite';

// ビルドごとの ID。Actions ではコミット SHA、手元では時刻
const BUILD_ID = (process.env.GITHUB_SHA ?? '').slice(0, 12) || `local-${Date.now().toString(36)}`;

/** dist/version.json を書く。ページは起動時にこれを見て、古い index.html なら読み直す */
function versionFile(): Plugin {
  return {
    name: 'version-file',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID, builtAt: new Date().toISOString() }) });
    },
  };
}

// base: './' で GitHub Pages の /<repo>/ 配下でも相対パスで読める
export default defineConfig({
  base: './',
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [versionFile()],
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
});
