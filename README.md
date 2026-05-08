# Muse

A local macOS desktop app for collecting, organizing, and searching design/image files. Built with Electron, React, and TypeScript. Includes optional AI-powered auto-tagging and natural language search via Ollama.

## Prerequisites

- **Node.js 22+** (check with `node -v`)
- **macOS** (Apple Silicon or Intel)
- **Ollama** (optional, for AI features): `brew install ollama`

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

AI features require Ollama running locally. Without it, the app works normally — AI features simply won't be available.

```bash
# Start Ollama
ollama serve

# Pull the vision model for auto-tagging + alt text
ollama pull llava:7b-v1.6-mistral-q4_K_M

# Pull the text embedding model for similarity / search
ollama pull nomic-embed-text
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Start the app in development mode |
| `npm run package` | Package the app for distribution |
| `npm run make` | Create distributable installers |
| `npm run lint` | Run ESLint |

## Tech Stack

- **Electron 41** — Desktop shell
- **React 19 + TypeScript** — Frontend
- **Tailwind CSS 4** — Styling
- **Zustand 5** — State management
- **SQLite (better-sqlite3)** — Local database
- **sharp** — Thumbnail generation
- **node-vibrant** — Color palette extraction
- **Ollama + LLaVA** — AI auto-tagging (optional)

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

- The database file (`data/library.db`) is gitignored — it's created automatically on first launch
- Imported images are copied into `data/originals/` with thumbnails in `data/thumbnails/`
- The preload script handles external file drops since `webUtils.getPathForFile()` only works in the preload context
- IPC communication follows the pattern: renderer calls `window.electronAPI.*` → preload invokes `ipcRenderer.invoke` → main handles in `ipc-handlers.ts`

## License

MIT
