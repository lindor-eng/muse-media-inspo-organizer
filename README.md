# Muse

A local macOS desktop app for collecting, organizing, and searching design reference — images and short video clips alike. Built with Electron, React, and TypeScript. Includes optional AI-powered auto-tagging and natural language search, powered by a bundled Ollama engine that runs entirely on-device.

**Supported formats:** JPG, PNG, GIF, WebP, SVG, TIFF, BMP, and MP4 / MOV / M4V video.

## Prerequisites

- **Node.js 22+** (check with `node -v`)
- **macOS** (Apple Silicon or Intel)

Neither Ollama nor ffmpeg is a prerequisite. Both are downloaded at build time (and on `npm start`), pinned to a specific version and checksum:

| Binary | Fetched into | By | First fetch |
|--------|--------------|----|-------------|
| Ollama engine | `resources/ollama/` | `scripts/fetch-ollama.mjs` | ~138 MB |
| ffmpeg | `resources/ffmpeg/` | `scripts/fetch-ffmpeg.mjs` | ~27 MB |

ffmpeg decodes video on import: it pulls the poster frame shown in the grid, reads the clip's duration, and samples the frames the vision model reads to write a description.

## Getting Started

```bash
# Clone the repo
git clone https://github.com/lindor-eng/muse-media-inspo-organizer.git
cd muse-media-inspo-organizer

# Install dependencies
npm install

# Start the app in development mode
npm start
```

The app will open an Electron window with hot-reload enabled for the renderer process.

## Project Structure

```
src/
├── main/                 # Electron main process
│   ├── index.ts          # Window creation, IPC registration
│   ├── ipc-handlers.ts   # All IPC handler registrations
│   ├── database/         # SQLite schema + repositories
│   ├── importer.ts       # Import pipeline (files, folders, zips, URLs, buffers)
│   ├── import-scan.ts    # Expands dropped folders/zips into media + folder structure
│   ├── video.ts          # ffmpeg: poster frames, duration, vision contact sheets
│   ├── color-extractor.ts
│   └── ai/              # Ollama integration (vision + text embeddings)
├── renderer/            # React frontend
│   ├── components/      # UI components (layout, grid, detail, sidebar)
│   ├── stores/          # Zustand state management
│   └── lib/             # IPC wrappers
└── preload/
    └── preload.ts       # contextBridge + file drop handling
```

## AI Features (Optional)

The app bundles and manages its own Ollama server — there's nothing to install or start by hand. On first launch it offers to download the two models it needs:

| Model | Size | Used for |
|-------|------|----------|
| `qwen3-vl:8b-instruct` | ~6 GB | Vision: auto-tagging, alt text, descriptions (stills and video alike) |
| `nomic-embed-text` | ~274 MB | Text embeddings for similarity + natural language search |

Models are stored in `userData/ollama-models`. If you decline (or the download fails), the app works normally — the AI features simply stay unavailable, and you can retry any time from **File → Update AI Model**.

If you already have an Ollama server on `127.0.0.1:11434`, the app attaches to it instead of spawning its own.

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Start the app in development mode |
| `npm run package` | Package the app for distribution |
| `npm run make` | Create distributable installers |
| `npm run lint` | Run ESLint |
| `npm run fetch:ollama` | Fetch/refresh the bundled Ollama engine (`--force` to re-download) |
| `npm run fetch:ffmpeg` | Fetch/refresh the bundled ffmpeg decoder (`--force` to re-download) |

## Tech Stack

- **Electron 41** — Desktop shell
- **React 19 + TypeScript** — Frontend
- **Tailwind CSS 4** — Styling
- **Zustand 5** — State management
- **SQLite (better-sqlite3)** — Local database
- **sharp** — Thumbnail generation and frame tiling
- **ffmpeg** — Bundled video decoder (poster frames, duration, frame sampling)
- **node-vibrant** — Color palette extraction
- **Ollama + Qwen3-VL** — Bundled on-device AI for auto-tagging and search

## Contributing

1. Fork the repo and clone locally
2. Create a branch for your feature: `git checkout -b feature/my-feature`
3. Install dependencies: `npm install`
4. Run the app: `npm start`
5. Make your changes — the renderer hot-reloads, but main process changes require a restart
6. Run the linter: `npm run lint`
7. Commit your changes and push to your fork
8. Open a pull request against `main`

### Notes for Contributors

- The library lives outside the repo, under Electron's `userData` directory: `library/library.db`, plus `library/originals/` and `library/thumbnails/` — all created automatically on first launch
- `resources/ollama/` and `resources/ffmpeg/` are gitignored; both are fetched at build time and are far too large for git
- The bundled ffmpeg is a GPLv3 build (no `--enable-nonfree`). Distributing it obliges you to offer its corresponding source — upstream build scripts and pins are documented at the top of `scripts/fetch-ffmpeg.mjs`. Never re-pin to an `--enable-nonfree` build; those cannot be redistributed at all, and the fetch script fails the build if it detects one
- The preload script handles external file drops since `webUtils.getPathForFile()` only works in the preload context; folders and zips are expanded in main by `import-scan.ts`, which mirrors their structure into Muse folders
- IPC communication follows the pattern: renderer calls `window.electronAPI.*` → preload invokes `ipcRenderer.invoke` → main handles in `ipc-handlers.ts`

## License

MIT
