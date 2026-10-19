// 把 api 與 worker 各打包成一個檔案；node_modules 裡的套件保留為外部依賴，@acc/shared 打包進去。
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@acc/'));

await build({
  entryPoints: { api: 'src/api.ts', worker: 'src/worker.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external,
});
console.log('backend build 完成');
