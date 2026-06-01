const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("acord", {
	findDiscordInstalls: () => ipcRenderer.invoke("acord:findDiscordInstalls"),
	install: (resourcesPath) => ipcRenderer.invoke("acord:install", resourcesPath),
	uninstall: (resourcesPath) =>
		ipcRenderer.invoke("acord:uninstall", resourcesPath),
	onProgress: (callback) => {
		const listener = (_event, update) => callback(update);
		ipcRenderer.on("acord:progress", listener);
		return () => ipcRenderer.removeListener("acord:progress", listener);
	},
	closeWindow: () => ipcRenderer.send("window:close"),
});
