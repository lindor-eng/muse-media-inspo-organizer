import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import path from 'node:path';
import fs from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { signAsync } from '@electron/osx-sign';

// Release builds are signed with these Developer ID certificates (both must be in the login
// keychain) and notarized through a notarytool keychain profile. Create the profile once with
//   xcrun notarytool store-credentials muse-notary
// MUSE_UNSIGNED=1 skips signing and notarization entirely (for machines without the
// certificates); MUSE_SKIP_NOTARIZE=1 signs but doesn't submit to Apple. Neither produces an
// installer Gatekeeper will accept, so both stamp the filename to keep it out of a release.
const APP_IDENTITY = 'Developer ID Application: Brian Lin (ANU6XZL47Z)';
const INSTALLER_IDENTITY = 'Developer ID Installer: Brian Lin (ANU6XZL47Z)';
const NOTARY_PROFILE = process.env.MUSE_NOTARY_PROFILE || 'muse-notary';
const UNSIGNED = process.env.MUSE_UNSIGNED === '1';
const NOTARIZE = !UNSIGNED && process.env.MUSE_SKIP_NOTARIZE !== '1';

/**
 * Submit the installer to Apple's notary service and staple the ticket to it. notarytool exits 0
 * even when Apple rejects the submission, so the verdict is read from its JSON output; on a
 * rejection the notary log (which names each offending binary) is printed before failing.
 */
function notarize(pkgPath: string): void {
  console.log(`[notarize] Submitting ${path.basename(pkgPath)} (profile "${NOTARY_PROFILE}")…`);
  const raw = execFileSync(
    'xcrun',
    ['notarytool', 'submit', pkgPath, '--keychain-profile', NOTARY_PROFILE, '--wait', '--output-format', 'json'],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const { id, status } = JSON.parse(raw) as { id: string; status: string };
  if (status !== 'Accepted') {
    execFileSync('xcrun', ['notarytool', 'log', id, '--keychain-profile', NOTARY_PROFILE], { stdio: 'inherit' });
    throw new Error(`Notarization ${status} (submission ${id}); see the log above.`);
  }
  execFileSync('xcrun', ['stapler', 'staple', pkgPath], { stdio: 'inherit' });
  console.log(`[notarize] Accepted and stapled (submission ${id})`);
}

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Muse',
    icon: path.resolve(__dirname, 'resources/icon'),
    asar: false,
    extraResource: [
      path.resolve(__dirname, 'resources/ollama'),
      path.resolve(__dirname, 'resources/ffmpeg'),
      // Loaded unpacked by users via File → Install Browser Extension (see src/main/browser-extension.ts).
      path.resolve(__dirname, 'browser-extension'),
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
      // Without the key the extension gets a random ID, and the capture server rejects it.
      const manifest = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, 'browser-extension/manifest.json'), 'utf-8'),
      );
      if (typeof manifest.key !== 'string') {
        throw new Error('browser-extension/manifest.json has no "key"; the extension ID would not be fixed.');
      }
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

      // Sign here rather than through packagerConfig.osxSign: the packager signs before this
      // hook runs, and the install + rebuild above would invalidate that seal. Covers every
      // binary in the bundle (Electron, the native modules, the Ollama tree, ffmpeg) with the
      // hardened runtime and a secure timestamp, which is what notarization requires.
      const appBundle = path.join(options.outputPaths[0], 'Muse.app');
      if (!UNSIGNED) {
        console.log(`[sign] Signing Muse.app as "${APP_IDENTITY}"…`);
        await signAsync({ app: appBundle, identity: APP_IDENTITY });
      }

      // Build the .pkg installer (its postinstall script strips any leftover quarantine flag)
      const scriptsDir = path.resolve(__dirname, 'resources/scripts');
      const outDir = path.resolve(__dirname, 'out/make');
      fs.mkdirSync(outDir, { recursive: true });
      // Version + arch in the filename so released installers are self-identifying and
      // successive builds don't silently overwrite each other.
      const componentPkg = path.join(outDir, 'Muse-component.pkg');
      const suffix = UNSIGNED ? '-unsigned' : NOTARIZE ? '' : '-unnotarized';
      const finalPkg = path.join(outDir, `Muse-Installer-${pkgJson.version}-${options.arch}${suffix}.pkg`);
      execSync(
        `pkgbuild --component "${appBundle}" --install-location /Applications --scripts "${scriptsDir}" "${componentPkg}"`,
        { stdio: 'inherit' }
      );
      const signArgs = UNSIGNED ? '' : `--sign "${INSTALLER_IDENTITY}" --timestamp `;
      execSync(
        `productbuild ${signArgs}--package "${componentPkg}" "${finalPkg}"`,
        { stdio: 'inherit' }
      );
      fs.unlinkSync(componentPkg);
      console.log(`[pkg] Built installer: ${finalPkg}`);

      if (NOTARIZE) notarize(finalPkg);
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
