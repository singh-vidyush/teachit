# TeachIt

**TeachIt is a free, open-source whiteboard for teaching and explaining ideas.** It brings the Excalidraw drawing experience into a lightweight desktop app, with local saving, reusable libraries, a movable camera preview, and window-only screen recording.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#platform-support)

## What you can do

- Draw with Excalidraw's familiar canvas, tools, menus, and shape library.
- Keep your whiteboard and imported libraries saved locally on your Mac.
- Import multiple downloaded `.excalidrawlib` files at once, or open one from Finder.
- Record the TeachIt window to MP4 with microphone audio. The optional camera preview is included in the recording and can be dragged or resized.
- Keep recording overhead low: the camera preview starts only when enabled, requests a 640 × 360 stream, and recording data is written to disk in short chunks.

## Platform support

**macOS is the supported platform today.** The Apple Silicon app builds successfully. The current release is not code-signed or notarized, so macOS may ask you to confirm the first launch.

**Windows is not packaged or verified yet.** The Electron-based app may be portable, but there is no supported Windows build today. Windows packaging, media capture, and file-opening support are tracked in the [Windows support issues](https://github.com/singh-vidyush/teachit/issues).

## Install and run

You need a recent version of Node.js and npm.

```sh
git clone https://github.com/singh-vidyush/teachit.git
cd teachit
npm ci
npm run dev
```

Vite prints a local address to open in your browser. To run the desktop app during development:

```sh
npm run desktop
```

To build the macOS app and disk image on a Mac:

```sh
npm run desktop:mac
```

The app and `.dmg` are written to `release/`. The current build script targets the Mac architecture of the machine doing the build.

## Recording and privacy

TeachIt captures its own app window, not the entire desktop. Recordings are saved where you choose. The camera preview is off until you turn it on. macOS will request screen recording, camera, and microphone access when needed.

Whiteboard drawings and libraries stay in TeachIt's local app data. TeachIt does not provide Excalidraw.com features such as cloud sync, collaboration, or shareable links.

## Contributing

TeachIt is open to contributions. Bug reports, feature ideas, documentation updates, and pull requests are welcome. Please open an [issue](https://github.com/singh-vidyush/teachit/issues) before larger changes so we can agree on the direction.

For a code change:

1. Fork the repository and create a branch.
2. Install dependencies with `npm ci`.
3. Make the change and run `npm run build`.
4. Open a pull request with a clear summary and any relevant screenshots or reproduction steps.

## License and acknowledgements

TeachIt is released under the [MIT License](LICENSE). It uses the [`@excalidraw/excalidraw`](https://www.npmjs.com/package/@excalidraw/excalidraw) package; Excalidraw retains its own name, trademarks, and license. Excalidraw's bundled font assets are copied locally after dependency installation so the editor can work without fetching fonts from a CDN.
