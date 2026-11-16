<div align="center">
  <img src="assets/teachit-mark.svg" alt="TeachIt logo" width="112" height="112">
  <h1>TeachIt</h1>
  <p><strong>Make the idea visible.</strong><br>A lightweight whiteboard for teaching, sketching, and recording what you know.</p>

  <p>
    <a href="https://github.com/singh-vidyush/teachit/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/License-MIT-7c5cff?style=for-the-badge&labelColor=171923"></a>
    <img alt="macOS supported" src="https://img.shields.io/badge/macOS-Apple%20Silicon-45d6b5?style=for-the-badge&labelColor=171923">
    <img alt="Open source" src="https://img.shields.io/badge/Open%20source-Contributions%20welcome-ff9d72?style=for-the-badge&labelColor=171923">
  </p>

  <p><a href="#get-started">Get started</a> · <a href="#features">Features</a> · <a href="#contributing">Contribute</a></p>
</div>

---

## Your canvas, ready for class

TeachIt brings the familiar [Excalidraw](https://excalidraw.com/) drawing experience into a focused desktop app. Sketch a concept, bring in reusable libraries, and record a walkthrough—all from one local workspace.

## Features

| Draw | Reuse | Present |
| --- | --- | --- |
| Excalidraw canvas, drawing tools, shapes, and editing controls. | Import downloaded `.excalidrawlib` files, including multiple libraries at once. | Record the TeachIt window to MP4 with microphone audio and an optional movable, resizable camera preview. |

Your board and imported libraries are stored locally. Camera and recording start only when you turn them on.

## Platform support

**macOS is supported today**, with an Apple Silicon build. The current app is not code-signed or notarized, so macOS may ask you to confirm before opening it.

**Windows is not packaged or verified yet.** Windows packaging, media capture, and file-opening support are tracked in the [Windows support issues](https://github.com/singh-vidyush/teachit/issues).

## Get started

You’ll need a recent version of Node.js and npm.

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

Builds are written to `release/`. The current build script targets the Mac architecture of the machine doing the build.

## Recording and privacy

TeachIt captures its own app window, not the whole desktop. Recordings go where you choose. The camera preview is off until enabled, and macOS requests screen recording, camera, and microphone access when needed.

TeachIt does not provide Excalidraw.com features such as cloud sync, collaboration, or shareable links.

## Contributing

TeachIt is free and open source, and contributions are welcome. Bug reports, feature ideas, documentation updates, and pull requests all help. Please open an [issue](https://github.com/singh-vidyush/teachit/issues) before larger changes so we can align on the approach.

1. Fork the repository and create a branch.
2. Install dependencies with `npm ci`.
3. Make your change and run `npm run build`.
4. Open a pull request with a clear summary and, where useful, screenshots or reproduction steps.

## License and credits

TeachIt is released under the [MIT License](LICENSE). It uses the [`@excalidraw/excalidraw`](https://www.npmjs.com/package/@excalidraw/excalidraw) package. Excalidraw retains its own name, trademarks, and license. Excalidraw font assets are copied locally after dependency installation so the editor can work without fetching fonts from a CDN.
