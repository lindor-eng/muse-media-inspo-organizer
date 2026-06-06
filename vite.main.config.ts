import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        'better-sqlite3',
        'sqlite-vec',
        'sharp',
        'chokidar',
        'node-vibrant',
        'node-vibrant/node',
        'archiver',
        'extract-zip',
      ],
      output: {
        entryFileNames: '[name].js',
      },
    },
  },
  resolve: {
    browserField: false,
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
});
