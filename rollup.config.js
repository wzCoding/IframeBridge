// rollup.config.js
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import typescript from '@rollup/plugin-typescript';
// import { terser } from 'rollup-plugin-terser';
import dts from 'rollup-plugin-dts';
import pkg from './package.json';

const input = 'src/index.ts';

// 外部模块，避免把依赖打包进 bundle
const externalDeps = [...Object.keys(pkg.peerDependencies || {}), ...Object.keys(pkg.dependencies || {})];

// UMD 全局变量映射，如果依赖了外部库，需要在这里指定对应的全局变量名称
const globals = {
  // 'some-lib': 'SomeLib'
};

export default [
  // ESM
  {
    input,
    external: externalDeps,
    plugins: [
      resolve({ browser: true }),
      commonjs(),
      json(),
      typescript({ tsconfig: './tsconfig.json', declaration: false })
    ],
    output: {
      file: pkg.module || 'dist/esm/index.js',
      format: 'es',
      sourcemap: true,
    },
  },

  // CJS
  {
    input,
    external: externalDeps,
    plugins: [
      resolve(),
      commonjs(),
      json(),
      typescript({ tsconfig: './tsconfig.json', declaration: false })
    ],
    output: {
      file: pkg.main || 'dist/cjs/index.js',
      format: 'cjs',
      sourcemap: true,
      exports: 'named'
    },
  },

  // UMD (non-minified)
  {
    input,
    external: externalDeps, // 如果希望 UMD 包内含所有依赖，把 external 改为 []
    plugins: [
      resolve({ browser: true }),
      commonjs(),
      json(),
      typescript({ tsconfig: './tsconfig.json', declaration: false })
    ],
    output: {
      file: 'dist/umd/iframe-bridge.umd.js',
      format: 'umd',
      name: 'IframeBridge',
      globals,
      sourcemap: true
    },
  },

  // UMD (minified)
  {
    input,
    external: externalDeps,
    plugins: [
      resolve({ browser: true }),
      commonjs(),
      json(),
      typescript({ tsconfig: './tsconfig.json', declaration: false }),
      // terser()
    ],
    output: {
      file: 'dist/umd/iframe-bridge.umd.min.js',
      format: 'umd',
      name: 'IframeBridge',
      globals,
      sourcemap: true
    },
  },

  // Optional: Bundle d.ts into single declaration file (requires rollup-plugin-dts)
  {
    input: 'dist/types/index.d.ts', // produced by tsc --emitDeclarationOnly
    plugins: [dts()],
    output: {
      file: 'dist/types/index.d.ts',
      format: 'es'
    }
  }
];
