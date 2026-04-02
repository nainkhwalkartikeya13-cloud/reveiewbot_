import * as esbuild from 'esbuild';

await esbuild.build({
    entryPoints: ['src/action.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    outfile: 'dist/action.js',
    format: 'cjs',
    minify: false,           // Keep readable for debugging
    sourcemap: false,
    treeShaking: true,
    external: [],            // Bundle EVERYTHING into one file
    banner: {
        js: '// AXD Review Bot — GitHub Action (bundled)\n// https://github.com/KartikeyaNainkhwal/reviewbot\n',
    },
});

console.log('✅ Built dist/action.js');
