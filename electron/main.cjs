const { app, BrowserWindow, ipcMain } = require("electron");
const { execFile, spawn } = require("child_process");
// Electron's bundled `fs` treats *.asar paths as archives, which locks them and
// breaks rename/write on app.asar (EBUSY). `original-fs` is the unpatched Node fs.
const fs = require("original-fs");
const path = require("path");
const os = require("os");

// ─── Platform ───────────────────────────────────────────────────────────────

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

// ─── Constants ────────────────────────────────────────────────────────────────

const ASAR_URL =
	"https://github.com/acord-standalone/acord-client/releases/download/latest/desktop.asar";

// Windows install folder names (under %LOCALAPPDATA%).
const DISCORD_NAMES = {
	stable: "Discord",
	ptb: "DiscordPTB",
	canary: "DiscordCanary",
};

// macOS application bundle names (under /Applications or ~/Applications).
const MAC_APP_NAMES = {
	stable: "Discord.app",
	ptb: "Discord PTB.app",
	canary: "Discord Canary.app",
};

// Running executable names, used by pgrep/pkill (mac) and Get-Process (win).
const DISCORD_PROCESS_NAMES = IS_MAC
	? { stable: "Discord", ptb: "Discord PTB", canary: "Discord Canary" }
	: { stable: "Discord", ptb: "DiscordPTB", canary: "DiscordCanary" };

// ─── Discord Discovery ────────────────────────────────────────────────────────

// Windows: %LOCALAPPDATA%/<Name>/app-<version>/resources
function findWindowsResourcesPath(discordPath) {
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

function findWindowsInstalls() {
	const localAppData = process.env.LOCALAPPDATA ?? "";
	const results = [];
	for (const [platform, name] of Object.entries(DISCORD_NAMES)) {
		const discordPath = path.join(localAppData, name);
		const resourcesPath = findWindowsResourcesPath(discordPath);
		if (resourcesPath) {
			const isPatched = isAcordPatched(resourcesPath);
			results.push({ platform, name, discordPath, resourcesPath, isPatched });
		}
	}
	return results;
}

// macOS: <App>.app/Contents/Resources holds app.asar directly (no versioned dir).
function findMacInstalls() {
	const searchDirs = ["/Applications", path.join(os.homedir(), "Applications")];
	const results = [];
	for (const [platform, appName] of Object.entries(MAC_APP_NAMES)) {
		for (const dir of searchDirs) {
			const appPath = path.join(dir, appName);
			const resourcesPath = path.join(appPath, "Contents", "Resources");
			const hasApp = fs.existsSync(path.join(resourcesPath, "app.asar"));
			if (hasApp || isAcordPatched(resourcesPath)) {
				results.push({
					platform,
					name: appName.replace(/\.app$/, ""),
					discordPath: appPath,
					resourcesPath,
					isPatched: isAcordPatched(resourcesPath),
				});
				break; // Prefer /Applications over ~/Applications.
			}
		}
	}
	return results;
}

function findDiscordInstalls() {
	return IS_MAC ? findMacInstalls() : findWindowsInstalls();
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

// Resolves with the command's stdout even on a non-zero exit (pgrep/pkill use
// exit codes to signal "no match"), so callers never reject on those.
function runCommand(file, args) {
	return new Promise((resolve) => {
		execFile(file, args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
			resolve({
				ok: !err,
				out: (stdout ?? "").toString().trim(),
				err: (stderr ?? "").toString().trim(),
			});
		});
	});
}

// ─── macOS privilege elevation ───────────────────────────────────────────────

// True when Acord's app.asar lives in a directory we can't write to (e.g. a
// root-owned /Applications), so the swap has to run with administrator rights.
function needsMacElevation(resourcesPath) {
	if (!IS_MAC) return false;
	try {
		fs.accessSync(resourcesPath, fs.constants.W_OK);
		return false;
	} catch {
		return true;
	}
}

function shQuote(value) {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function osaQuote(value) {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

// Runs a /bin/sh command as root via a native macOS authorization prompt.
async function runMacAdminShell(shellCommand) {
	const script = `do shell script ${osaQuote(shellCommand)} with administrator privileges`;
	const { ok, out, err } = await runCommand("osascript", ["-e", script]);
	if (!ok) {
		if (/User canceled|-128/.test(err)) {
			throw new Error("Administrator authorization was cancelled.");
		}
		throw new Error(err || out || "Administrator authorization failed.");
	}
	return out;
}

async function isDiscordProcessRunning(processName) {
	if (IS_MAC) {
		const { ok, out } = await runCommand("pgrep", ["-x", processName]);
		return ok && out.length > 0;
	}
	const output = await runPowerShell(
		`if (Get-Process -Name ${psQuote(processName)} -ErrorAction SilentlyContinue) { 'true' } else { 'false' }`,
	);
	return output === "true";
}

async function stopDiscordProcess(processName, onProgress) {
	const wasRunning = await isDiscordProcessRunning(processName);
	if (!wasRunning) return false;

	onProgress("Closing Discord...", 5);
	if (IS_MAC) {
		await runCommand("pkill", ["-x", processName]);
		// Wait up to ~5s for the process to actually exit before we touch app.asar.
		for (let i = 0; i < 25; i++) {
			if (!(await isDiscordProcessRunning(processName))) break;
			await new Promise((r) => setTimeout(r, 200));
		}
	} else {
		await runPowerShell(
			`Get-Process -Name ${psQuote(processName)} -ErrorAction SilentlyContinue | Stop-Process -Force; Wait-Process -Name ${psQuote(processName)} -Timeout 5 -ErrorAction SilentlyContinue`,
		);
	}
	return true;
}

function startDiscord(install) {
	if (IS_MAC) {
		if (!fs.existsSync(install.discordPath)) return;
		const proc = spawn("open", [install.discordPath], {
			detached: true,
			stdio: "ignore",
		});
		proc.unref();
		return;
	}

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
	if (!fs.existsSync(appAsar) && !fs.existsSync(backupAsar)) {
		throw new Error("Discord app.asar not found.");
	}

	onProgress("Finishing up...", 85);
	if (needsMacElevation(resourcesPath)) {
		await installAcordElevated(appAsar, backupAsar, buffer);
	} else {
		if (!fs.existsSync(backupAsar)) {
			fs.renameSync(appAsar, backupAsar);
			createdBackup = true;
		} else {
			fs.rmSync(appAsar, { recursive: true, force: true });
		}
		try {
			fs.writeFileSync(appAsar, Buffer.from(buffer));
		} catch (err) {
			if (
				createdBackup &&
				fs.existsSync(backupAsar) &&
				!fs.existsSync(appAsar)
			) {
				fs.renameSync(backupAsar, appAsar);
			}
			throw err;
		}
	}

	if (!isAcordPatched(resourcesPath)) {
		throw new Error("Install finished, but patch state could not be verified.");
	}
}

// Writes the downloaded asar to a temp file, then swaps it in as root: backs up
// the original to _app.asar (first install only) and moves the new one in place.
async function installAcordElevated(appAsar, backupAsar, buffer) {
	const tmpFile = path.join(os.tmpdir(), `acord-${Date.now()}.asar`);
	fs.writeFileSync(tmpFile, Buffer.from(buffer));
	try {
		const cmd =
			`if [ ! -e ${shQuote(backupAsar)} ]; then mv ${shQuote(appAsar)} ${shQuote(backupAsar)}; fi && ` +
			`mv -f ${shQuote(tmpFile)} ${shQuote(appAsar)}`;
		await runMacAdminShell(cmd);
	} finally {
		fs.rmSync(tmpFile, { force: true });
	}
}

async function uninstallAcord(resourcesPath) {
	const appAsar = path.join(resourcesPath, "app.asar");
	const appAsarTmp = path.join(resourcesPath, "app.asar.tmp");
	const backupAsar = path.join(resourcesPath, "_app.asar");

	if (!fs.existsSync(backupAsar)) {
		throw new Error("Backup not found. Acord may already be uninstalled.");
	}

	if (needsMacElevation(resourcesPath)) {
		// Overwrite the Acord asar with the original backup in one atomic move.
		await runMacAdminShell(`mv -f ${shQuote(backupAsar)} ${shQuote(appAsar)}`);
		if (isAcordPatched(resourcesPath)) {
			throw new Error("Removal finished, but patch state could not be verified.");
		}
		return;
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

// ─── Orchestration (shared by IPC + CLI) ────────────────────────────────────────

async function runInstall(resourcesPath, onProgress) {
	try {
		const restartInstall = await prepareDiscordForAction(
			resourcesPath,
			onProgress,
		);
		await installAcord(resourcesPath, onProgress);
		onProgress("Done!", 100);
		return { result: { success: true }, restartInstall };
	} catch (err) {
		return {
			result: {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			},
			restartInstall: null,
		};
	}
}

async function runUninstall(resourcesPath, onProgress) {
	onProgress("Preparing...", 0);
	await new Promise((r) => setTimeout(r, 80));
	try {
		const restartInstall = await prepareDiscordForAction(
			resourcesPath,
			onProgress,
		);
		onProgress("Removing files...", 50);
		await new Promise((r) => setTimeout(r, 150));
		await uninstallAcord(resourcesPath);
		onProgress("Done!", 100);
		return { result: { success: true }, restartInstall };
	} catch (err) {
		return {
			result: {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			},
			restartInstall: null,
		};
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
	const { result, restartInstall } = await runInstall(
		resourcesPath,
		sendProgress,
	);
	if (restartInstall) restartDiscordAfterResponse(restartInstall);
	return result;
});

ipcMain.handle("acord:uninstall", async (event, resourcesPath) => {
	const sendProgress = (message, percent) =>
		event.sender.send("acord:progress", { message, percent });
	const { result, restartInstall } = await runUninstall(
		resourcesPath,
		sendProgress,
	);
	if (restartInstall) restartDiscordAfterResponse(restartInstall);
	return result;
});

// ─── CLI ────────────────────────────────────────────────────────────────────────

// Accepts variant names and common aliases, mapped to our platform keys.
const PLATFORM_ALIASES = {
	stable: "stable",
	discord: "stable",
	ptb: "ptb",
	discordptb: "ptb",
	canary: "canary",
	discordcanary: "canary",
};

// Scans argv for `--install <variant>` / `--uninstall <variant>` (also `--install=stable`).
function parseCliAction(argv) {
	const args = argv.slice(1);
	for (let i = 0; i < args.length; i++) {
		let flag = args[i].toLowerCase();
		let value = args[i + 1];
		if (flag.includes("=")) [flag, value] = flag.split("=");
		if (flag === "--install" || flag === "--uninstall") {
			return {
				action: flag === "--install" ? "install" : "uninstall",
				variant: (value ?? "").toLowerCase(),
			};
		}
	}
	return null;
}

async function runCli({ action, variant }) {
	const platform = PLATFORM_ALIASES[variant];
	if (!platform) {
		console.error(
			`Unknown or missing variant '${variant || ""}'.\n` +
				`Usage: AcordClientInstaller --install|--uninstall <stable|ptb|canary>`,
		);
		return 1;
	}

	const install = findDiscordInstalls().find((i) => i.platform === platform);
	if (!install) {
		console.error(`Discord variant '${platform}' is not installed on this system.`);
		return 1;
	}

	const onProgress = (message, percent) =>
		console.log(`[${String(percent).padStart(3, " ")}%] ${message}`);

	const { result, restartInstall } =
		action === "install"
			? await runInstall(install.resourcesPath, onProgress)
			: await runUninstall(install.resourcesPath, onProgress);

	if (!result.success) {
		console.error(`Error: ${result.error}`);
		return 1;
	}

	console.log(
		action === "install"
			? `Acord installed for ${install.name}.`
			: `Acord uninstalled from ${install.name}.`,
	);

	// We are about to exit, so restart Discord synchronously rather than on a timer.
	if (restartInstall) {
		try {
			startDiscord(restartInstall);
			await new Promise((r) => setTimeout(r, 600));
		} catch {}
	}
	return 0;
}

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

const cliAction = parseCliAction(process.argv);

// Headless CLI mode (`--install`/`--uninstall`) skips the window entirely.
if (cliAction) {
	app.whenReady().then(async () => {
		const code = await runCli(cliAction);
		app.exit(code);
	});
} else {
	app.whenReady().then(() => {
		createWindow();

		app.on("activate", () => {
			if (BrowserWindow.getAllWindows().length === 0) createWindow();
		});
	});
}

app.on("window-all-closed", () => {
	app.quit();
});
