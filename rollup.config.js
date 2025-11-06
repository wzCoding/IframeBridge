import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import typescript from 'rollup-plugin-typescript2';
import { terser } from 'rollup-plugin-terser';
import dts from 'rollup-plugin-dts';
import path from 'path';

const pkg = require('./package.json');

const input = 'src/index.ts';
const name = 'IframeBridge'; // UMD 全局名（若需要 UMD）

export default [
  // ESM & CJS build
  {
    input,
    external: [
      // 列出要作为外部的依赖（不打包）
      ...Object.keys(pkg.peerDependencies || {}),
      ...Object.keys(pkg.dependencies || {}) // 可选择把 dependencies 也 externalize
    ],
    plugins: [
      resolve({ browser: true, extensions: ['.js', '.ts', '.json'] }),
      commonjs(),
      json(),
      typescript({
        tsconfig: path.resolve(__dirname, 'tsconfig.json'),
        useTsconfigDeclarationDir: true,
        clean: true
      })
    ],
    output: [
      { file: pkg.module || 'dist/esm/index.js', format: 'es', sourcemap: true },
      { file: pkg.main || 'dist/cjs/index.js', format: 'cjs', sourcemap: true, exports: 'named' }
    ]
  },

  // Minified UMD build (optional)
  {
    input,
    external: [
      ...Object.keys(pkg.peerDependencies || {})
    ],
    plugins: [
      resolve({ browser: true }),
      commonjs(),
      json(),
      typescript({
        tsconfig: path.resolve(__dirname, 'tsconfig.json'),
        tsconfigOverride: { compilerOptions: { declaration: false } }
      }),
      terser()
    ],
    output: {
      file: pkg.browser || 'dist/umd/index.min.js',
      format: 'umd',
      name,
      sourcemap: true,
      globals: {
        // 对外部依赖的全局变量映射
      }
    }
  },

  // Bundle type declarations into a single file
  {
    input: 'dist/types/src/index.d.ts', // rollup-plugin-typescript2 会生成 declaration 到这里
    output: [{ file: pkg.types || 'dist/types/index.d.ts', format: 'es' }],
    plugins: [dts()]
  }
];
