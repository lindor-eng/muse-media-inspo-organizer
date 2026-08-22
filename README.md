# Muse

A local macOS desktop app for collecting, organizing, and searching design/image files. Built with Electron, React, and TypeScript. Includes optional AI-powered auto-tagging and natural language search, powered by a bundled Ollama engine that runs entirely on-device.

## Prerequisites

- **Node.js 22+** (check with `node -v`)
- **macOS** (Apple Silicon or Intel)

Ollama is **not** a prerequisite — the engine is downloaded into `resources/ollama/` at build time (and on `npm start`) by `scripts/fetch-ollama.mjs`, pinned to a specific version and checksum. The first fetch pulls ~138 MB.

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
│   ├── importer.ts       # File import pipeline
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
| `qwen3-vl:8b-instruct` | ~6 GB | Vision: auto-tagging, alt text, descriptions |
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

## Tech Stack

- **Electron 41** — Desktop shell
- **React 19 + TypeScript** — Frontend
- **Tailwind CSS 4** — Styling
- **Zustand 5** — State management
- **SQLite (better-sqlite3)** — Local database
- **sharp** — Thumbnail generation
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
- `resources/ollama/` is gitignored; it's fetched at build time and is far too large for git
- The preload script handles external file drops since `webUtils.getPathForFile()` only works in the preload context
- IPC communication follows the pattern: renderer calls `window.electronAPI.*` → preload invokes `ipcRenderer.invoke` → main handles in `ipc-handlers.ts`

## License

MIT
