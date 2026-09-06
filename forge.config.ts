import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Muse',
    icon: path.resolve(__dirname, 'resources/icon'),
    asar: false,
    extraResource: [
      path.resolve(__dirname, 'resources/ollama'),
      path.resolve(__dirname, 'resources/ffmpeg'),
    ],
  },
  rebuildConfig: {},
  makers: [
    new MakerZIP({}, ['darwin']),
  ],
  hooks: {
    // Runs for `start` and `make` alike, so dev and packaged builds use the same pinned
    // engine and decoder — no reliance on whatever ollama/ffmpeg happens to be installed on
    // the machine.
    generateAssets: async () => {
      execSync('node scripts/fetch-ollama.mjs', { cwd: __dirname, stdio: 'inherit' });
      execSync('node scripts/fetch-ffmpeg.mjs', { cwd: __dirname, stdio: 'inherit' });
    },

    // Fail loudly rather than shipping an app whose bundled binaries are missing. A release
    // built without the Ollama check went out once already and left users with an unfixable
    // "engine isn't running" dialog; a build without ffmpeg would silently reject every
    // video import instead.
    prePackage: async () => {
      const required: Array<{ binary: string; script: string }> = [
        { binary: 'resources/ollama/ollama', script: 'npm run fetch:ollama' },
        { binary: 'resources/ffmpeg/ffmpeg', script: 'npm run fetch:ffmpeg' },
      ];
      for (const { binary, script } of required) {
        const full = path.resolve(__dirname, binary);
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
          throw new Error(`Bundled binary missing at ${full}\nRun \`${script}\` before packaging.`);
        }
      }
    },

    postPackage: async (_config, options) => {
      const appPath = path.join(options.outputPaths[0], 'Muse.app', 'Contents', 'Resources', 'app');
      const nodeModulesPath = path.join(appPath, 'node_modules');

      if (!fs.existsSync(nodeModulesPath)) {
        fs.mkdirSync(nodeModulesPath, { recursive: true });
      }

      // Install only production dependencies in the packaged app
      const pkgJson = JSON.parse(fs.readFileSync(path.join(appPath, 'package.json'), 'utf-8'));
      const prodPkg = {
        name: pkgJson.name,
        version: pkgJson.version,
        main: pkgJson.main,
        dependencies: pkgJson.dependencies,
      };
      fs.writeFileSync(path.join(appPath, 'package.json'), JSON.stringify(prodPkg, null, 2));
      execSync('npm install --omit=dev', { cwd: appPath, stdio: 'inherit' });

      // Rebuild native modules against Electron's Node.js version
      const electronPath = path.join(options.outputPaths[0], 'Muse.app', 'Contents', 'Frameworks', 'Electron Framework.framework');
      const electronVersion = '41.5.0';
      execSync(
        `npx @electron/rebuild --version ${electronVersion} --module-dir "${appPath}" --arch arm64`,
        { cwd: appPath, stdio: 'inherit' }
      );

      // Build unsigned .pkg installer with postinstall script to remove quarantine
      const appBundle = path.join(options.outputPaths[0], 'Muse.app');
      const scriptsDir = path.resolve(__dirname, 'resources/scripts');
      const outDir = path.resolve(__dirname, 'out/make');
      fs.mkdirSync(outDir, { recursive: true });
      // Version + arch in the filename so released installers are self-identifying and
      // successive builds don't silently overwrite each other.
      const componentPkg = path.join(outDir, 'Muse-component.pkg');
      const finalPkg = path.join(outDir, `Muse-Installer-${pkgJson.version}-${options.arch}.pkg`);
      execSync(
        `pkgbuild --component "${appBundle}" --install-location /Applications --scripts "${scriptsDir}" "${componentPkg}"`,
        { stdio: 'inherit' }
      );
      execSync(
        `productbuild --package "${componentPkg}" "${finalPkg}"`,
        { stdio: 'inherit' }
      );
      fs.unlinkSync(componentPkg);
      console.log(`[pkg] Built installer: ${finalPkg}`);
    },
  },
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
};

export default config;
