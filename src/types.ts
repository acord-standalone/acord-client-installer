export interface DiscordInstall {
	platform: string;
	name: string;
	discordPath: string;
	resourcesPath: string;
	isPatched: boolean;
}

export interface ProgressUpdate {
	message: string;
	percent: number;
}

export interface ActionResult {
	success: boolean;
	error?: string;
}

export interface AcordApi {
	findDiscordInstalls(): Promise<DiscordInstall[]>;
	install(resourcesPath: string): Promise<ActionResult>;
	uninstall(resourcesPath: string): Promise<ActionResult>;
	onProgress(callback: (update: ProgressUpdate) => void): () => void;
	closeWindow(): void;
}

declare global {
	interface Window {
		acord: AcordApi;
	}
}
