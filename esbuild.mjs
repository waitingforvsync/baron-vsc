import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');

const extensionOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: false,
};

const testOptions = {
  entryPoints: ['test/parser.test.ts'],
  bundle: true,
  outfile: 'out/test/parser.test.cjs',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
};

if (test) {
  await esbuild.build(testOptions);
} else if (watch) {
  const ctx = await esbuild.context(extensionOptions);
  await ctx.watch();
  console.log('watching...');
} else {
  await esbuild.build(extensionOptions);
}
