import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { VitePlugin } from '@electron-forge/plugin-vite';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Muse',
    asar: false,
    extraResource: [
      path.resolve(__dirname, 'resources/ollama'),
    ],
  },
  rebuildConfig: {},
  makers: [
    new MakerZIP({}, ['darwin']),
    new MakerDMG({
      format: 'ULFO',
      name: 'Muse',
    }),
  ],
  hooks: {
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
