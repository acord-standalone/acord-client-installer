const { app, BrowserWindow, ipcMain } = require("electron");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// ─── Constants ────────────────────────────────────────────────────────────────

const ASAR_URL =
	"https://github.com/acord-standalone/acord-client/releases/download/latest/desktop.asar";

const DISCORD_NAMES = {
	stable: "Discord",
	ptb: "DiscordPTB",
	canary: "DiscordCanary",
};

const DISCORD_PROCESS_NAMES = {
	stable: "Discord",
	ptb: "DiscordPTB",
	canary: "DiscordCanary",
};

// ─── Discord Discovery ────────────────────────────────────────────────────────

function findResourcesPath(discordPath) {
	if (!fs.existsSync(discordPath)) return null;
	try {
		const entries = fs.readdirSync(discordPath);
		let latestDir = "";
		for (const entry of entries) {
			if (entry.startsWith("app-")) {
				const resources = path.join(discordPath, entry, "resources");
				if (fs.existsSync(resources) && entry > latestDir) {
					latestDir = entry;
				}
			}
		}
		if (!latestDir) return null;
		return path.join(discordPath, latestDir, "resources");
	} catch {
		return null;
	}
}

function findDiscordInstalls() {
	const localAppData = process.env.LOCALAPPDATA ?? "";
	const results = [];
	for (const [platform, name] of Object.entries(DISCORD_NAMES)) {
		const discordPath = path.join(localAppData, name);
		const resourcesPath = findResourcesPath(discordPath);
		if (resourcesPath) {
			const isPatched = isAcordPatched(resourcesPath);
			results.push({ platform, name, discordPath, resourcesPath, isPatched });
		}
	}
	return results;
}

function isAcordPatched(resourcesPath) {
	const backupAsar = path.join(resourcesPath, "_app.asar");
	return fs.existsSync(backupAsar);
}

function findDiscordInstallByResourcesPath(resourcesPath) {
	const normalizedPath = path.normalize(resourcesPath).toLowerCase();
	return (
		findDiscordInstalls().find(
			(install) =>
				path.normalize(install.resourcesPath).toLowerCase() === normalizedPath,
		) ?? null
	);
}

// ─── Install / Uninstall ──────────────────────────────────────────────────────

function runPowerShell(command) {
	return new Promise((resolve, reject) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
			{ windowsHide: true, maxBuffer: 1024 * 1024 },
			(err, stdout) => {
				if (err) return reject(err);
				resolve(stdout.toString().trim());
			},
		);
	});
}

function psQuote(value) {
	return `'${value.replaceAll("'", "''")}'`;
}

async function isDiscordProcessRunning(processName) {
	const output = await runPowerShell(
		`if (Get-Process -Name ${psQuote(processName)} -ErrorAction SilentlyContinue) { 'true' } else { 'false' }`,
	);
	return output === "true";
}

async function stopDiscordProcess(processName, onProgress) {
	const wasRunning = await isDiscordProcessRunning(processName);
	if (!wasRunning) return false;

	onProgress("Closing Discord...", 5);
	await runPowerShell(
		`Get-Process -Name ${psQuote(processName)} -ErrorAction SilentlyContinue | Stop-Process -Force; Wait-Process -Name ${psQuote(processName)} -Timeout 5 -ErrorAction SilentlyContinue`,
	);
	return true;
}

function startDiscord(install) {
	const processName = DISCORD_PROCESS_NAMES[install.platform] ?? install.name;
	const updateExe = path.join(install.discordPath, "Update.exe");
	if (!fs.existsSync(updateExe)) return;

	const proc = spawn(updateExe, ["--processStart", `${processName}.exe`], {
		detached: true,
		stdio: "ignore",
	});
	proc.unref();
}

function restartDiscordAfterResponse(install) {
	setTimeout(() => {
		try {
			startDiscord(install);
		} catch {}
	}, 250);
}

async function prepareDiscordForAction(resourcesPath, onProgress) {
	const install = findDiscordInstallByResourcesPath(resourcesPath);
	const processName = install
		? (DISCORD_PROCESS_NAMES[install.platform] ?? install.name)
		: null;
	const wasRunning = processName
		? await stopDiscordProcess(processName, onProgress)
		: false;

	return install && wasRunning ? install : null;
}

async function installAcord(resourcesPath, onProgress) {
	const appAsar = path.join(resourcesPath, "app.asar");
	const backupAsar = path.join(resourcesPath, "_app.asar");
	let createdBackup = false;

	onProgress("Downloading Acord...", 10);

	const response = await fetch(ASAR_URL);
	if (!response.ok) {
		throw new Error(
			`Download failed: ${response.status} ${response.statusText}`,
		);
	}

	onProgress("Preparing files...", 45);
	const buffer = await response.arrayBuffer();

	onProgress("Backing up original...", 68);
	if (!fs.existsSync(appAsar)) {
		throw new Error("Discord app.asar not found.");
	}
	if (!fs.existsSync(backupAsar)) {
		fs.renameSync(appAsar, backupAsar);
		createdBackup = true;
	} else {
		fs.rmSync(appAsar, { recursive: true, force: true });
	}

	onProgress("Finishing up...", 85);
	try {
		fs.writeFileSync(appAsar, Buffer.from(buffer));
	} catch (err) {
		if (createdBackup && fs.existsSync(backupAsar) && !fs.existsSync(appAsar)) {
			fs.renameSync(backupAsar, appAsar);
		}
		throw err;
	}

	if (!isAcordPatched(resourcesPath)) {
		throw new Error("Install finished, but patch state could not be verified.");
	}
}

function uninstallAcord(resourcesPath) {
	const appAsar = path.join(resourcesPath, "app.asar");
	const appAsarTmp = path.join(resourcesPath, "app.asar.tmp");
	const backupAsar = path.join(resourcesPath, "_app.asar");

	if (!fs.existsSync(backupAsar)) {
		throw new Error("Backup not found. Acord may already be uninstalled.");
	}

	fs.rmSync(appAsarTmp, { recursive: true, force: true });

	if (fs.existsSync(appAsar)) {
		fs.renameSync(appAsar, appAsarTmp);
	}

	try {
		fs.renameSync(backupAsar, appAsar);
	} catch (err) {
		if (fs.existsSync(appAsarTmp) && !fs.existsSync(appAsar)) {
			fs.renameSync(appAsarTmp, appAsar);
		}
		throw err;
	}

	fs.rmSync(appAsarTmp, { recursive: true, force: true });

	if (isAcordPatched(resourcesPath)) {
		throw new Error("Removal finished, but patch state could not be verified.");
	}
}

// ─── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.on("window:close", (event) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	win?.close();
});

ipcMain.handle("acord:findDiscordInstalls", () => findDiscordInstalls());

ipcMain.handle("acord:install", async (event, resourcesPath) => {
	const sendProgress = (message, percent) =>
		event.sender.send("acord:progress", { message, percent });
	try {
		const restartInstall = await prepareDiscordForAction(
			resourcesPath,
			sendProgress,
		);
		await installAcord(resourcesPath, sendProgress);
		sendProgress("Done!", 100);
		if (restartInstall) {
			restartDiscordAfterResponse(restartInstall);
		}
		return { success: true };
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
});

ipcMain.handle("acord:uninstall", async (event, resourcesPath) => {
	const sendProgress = (message, percent) =>
		event.sender.send("acord:progress", { message, percent });
	sendProgress("Preparing...", 0);
	await new Promise((r) => setTimeout(r, 80));
	try {
		const restartInstall = await prepareDiscordForAction(
			resourcesPath,
			sendProgress,
		);
		sendProgress("Removing files...", 50);
		await new Promise((r) => setTimeout(r, 150));
		uninstallAcord(resourcesPath);
		sendProgress("Done!", 100);
		if (restartInstall) {
			restartDiscordAfterResponse(restartInstall);
		}
		return { success: true };
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
});

// ─── Window ───────────────────────────────────────────────────────────────────

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

function createWindow() {
	const win = new BrowserWindow({
		title: "Acord Installer",
		width: 300,
		height: 500,
		useContentSize: true,
		resizable: false,
		maximizable: false,
		fullscreenable: false,
		frame: false,
		autoHideMenuBar: true,
		backgroundColor: "#1e1f22",
		icon: path.join(__dirname, "..", "icon.png"),
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	win.setMenu(null);

	if (DEV_SERVER_URL) {
		win.loadURL(DEV_SERVER_URL);
	} else {
		win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
	}
}

app.whenReady().then(() => {
	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	app.quit();
});
