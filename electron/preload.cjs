const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("teachItDesktop", {
  onOpenFile(callback) {
    const listener = (_event, file) => callback(file);
    ipcRenderer.on("teachit:open-file", listener);
    ipcRenderer.send("teachit:ready");
    return () => ipcRenderer.removeListener("teachit:open-file", listener);
  },
  startRecording(mimeType) {
    return ipcRenderer.invoke("teachit:recording-start", mimeType);
  },
  writeRecordingChunk(data) {
    return ipcRenderer.invoke("teachit:recording-chunk", data);
  },
  finishRecording() {
    return ipcRenderer.invoke("teachit:recording-finish");
  },
  cancelRecording() {
    return ipcRenderer.invoke("teachit:recording-cancel");
  },
});
