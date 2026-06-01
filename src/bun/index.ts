import { BrowserView, BrowserWindow, Updater } from "electrobun/bun";
import { $ } from "bun";
import * as fs from "fs";
import * as path from "path";

// ─── Constants ────────────────────────────────────────────────────────────────

const ASAR_URL =
	"https://github.com/acord-standalone/acord-client/releases/download/latest/desktop.asar";

const DISCORD_NAMES: Record<string, string> = {
	stable: "Discord",
	ptb: "DiscordPTB",
	canary: "DiscordCanary",
};

const DISCORD_PROCESS_NAMES: Record<string, string> = {
	stable: "Discord",
	ptb: "DiscordPTB",
	canary: "DiscordCanary",
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DiscordInstall {
	platform: string;
	name: string;
	discordPath: string;
	resourcesPath: string;
	isPatched: boolean;
}

export type AcordRPCSchema = {
	bun: {
		requests: {
			findDiscordInstalls: { params: undefined; response: DiscordInstall[] };
			install: {
				params: { resourcesPath: string };
				response: { success: boolean; error?: string };
			};
			uninstall: {
				params: { resourcesPath: string };
				response: { success: boolean; error?: string };
			};
		};
		messages: Record<string, never>;
	};
	webview: {
		requests: Record<string, never>;
		messages: {
			progress: { message: string; percent: number };
		};
	};
};

// ─── Discord Discovery ────────────────────────────────────────────────────────

function findResourcesPath(discordPath: string): string | null {
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

function findDiscordInstalls(): DiscordInstall[] {
	const localAppData = process.env.LOCALAPPDATA ?? "";
	const results: DiscordInstall[] = [];
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

function isAcordPatched(resourcesPath: string): boolean {
	const backupAsar = path.join(resourcesPath, "_app.asar");
	return fs.existsSync(backupAsar);
}

function findDiscordInstallByResourcesPath(
	resourcesPath: string,
): DiscordInstall | null {
	const normalizedPath = path.normalize(resourcesPath).toLowerCase();
	return (
		findDiscordInstalls().find(
			(install) =>
				path.normalize(install.resourcesPath).toLowerCase() === normalizedPath,
		) ?? null
	);
}

// ─── Install / Uninstall ──────────────────────────────────────────────────────

type ProgressFn = (message: string, percent: number) => void;

async function runPowerShell(command: string): Promise<string> {
	const result = await $`powershell -NoProfile -ExecutionPolicy Bypass -Command ${command}`.quiet();
	return result.stdout.toString().trim();
}

function psQuote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

async function isDiscordProcessRunning(processName: string): Promise<boolean> {
	const output = await runPowerShell(
		`if (Get-Process -Name ${psQuote(processName)} -ErrorAction SilentlyContinue) { 'true' } else { 'false' }`,
	);
	return output === "true";
}

async function stopDiscordProcess(
	processName: string,
	onProgress: ProgressFn,
): Promise<boolean> {
	const wasRunning = await isDiscordProcessRunning(processName);
	if (!wasRunning) return false;

	onProgress("Closing Discord...", 5);
	await runPowerShell(
		`Get-Process -Name ${psQuote(processName)} -ErrorAction SilentlyContinue | Stop-Process -Force; Wait-Process -Name ${psQuote(processName)} -Timeout 5 -ErrorAction SilentlyContinue`,
	);
	return true;
}

function startDiscord(install: DiscordInstall): void {
	const processName = DISCORD_PROCESS_NAMES[install.platform] ?? install.name;
	const updateExe = path.join(install.discordPath, "Update.exe");
	if (!fs.existsSync(updateExe)) return;

	const proc = Bun.spawn([updateExe, "--processStart", `${processName}.exe`], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	proc.unref();
}

function restartDiscordAfterResponse(install: DiscordInstall): void {
	setTimeout(() => {
		try {
			startDiscord(install);
		} catch {}
	}, 250);
}

async function prepareDiscordForAction(
	resourcesPath: string,
	onProgress: ProgressFn,
): Promise<DiscordInstall | null> {
	const install = findDiscordInstallByResourcesPath(resourcesPath);
	const processName = install
		? (DISCORD_PROCESS_NAMES[install.platform] ?? install.name)
		: null;
	const wasRunning = processName
		? await stopDiscordProcess(processName, onProgress)
		: false;

	return install && wasRunning ? install : null;
}

async function installAcord(
	resourcesPath: string,
	onProgress: ProgressFn,
): Promise<void> {
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

function uninstallAcord(resourcesPath: string): void {
	const appAsar = path.join(resourcesPath, "app.asar");
	const appAsarTmp = path.join(resourcesPath, "app.asar.tmp");
	const backupAsar = path.join(resourcesPath, "_app.asar");

	if (!fs.existsSync(backupAsar)) {
		throw new Error(
			"Backup not found. Acord may already be uninstalled.",
		);
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

// ─── RPC ──────────────────────────────────────────────────────────────────────

const rpc = BrowserView.defineRPC<AcordRPCSchema>({
	handlers: {
		requests: {
			findDiscordInstalls: () => findDiscordInstalls(),

			install: async ({ resourcesPath }) => {
				const sendProgress: ProgressFn = (message, percent) => {
					rpc.send.progress({ message, percent });
				};
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
			},

			uninstall: async ({ resourcesPath }) => {
				const sendProgress: ProgressFn = (message, percent) => {
					rpc.send.progress({ message, percent });
				};
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
			},
		},
		messages: {},
	},
});

// ─── Window ───────────────────────────────────────────────────────────────────

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

async function getMainViewUrl(): Promise<string> {
	const channel = await Updater.localInfo.channel();
	if (channel === "dev") {
		try {
			await fetch(DEV_SERVER_URL, { method: "HEAD" });
			return DEV_SERVER_URL;
		} catch {
			// fall through
		}
	}
	return "views://mainview/index.html";
}

const url = await getMainViewUrl();

new BrowserWindow({
	title: "Acord Installer",
	url,
	rpc,
	frame: { width: 300, height: 500, x: 200, y: 200 }
});
