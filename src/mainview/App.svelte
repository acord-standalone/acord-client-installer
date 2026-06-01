<script lang="ts">
  import { onMount, tick } from "svelte";
  import gsap from "gsap";
  import { Electroview } from "electrobun/view";
  import type { AcordRPCSchema, DiscordInstall } from "../bun/index.ts";

  // --- RPC ---

  let progressMessage = $state("Preparing...");
  let progressPercent = $state(0);
  let progressBarEl: HTMLElement | null = $state(null);
  let completeFromProgress: (() => void) | null = null;
  let finishingFromProgress = false;

  const rpc = Electroview.defineRPC<AcordRPCSchema>({
    handlers: {
      messages: {
        progress: ({ message, percent }) => {
          progressMessage = message;
          progressPercent = percent;
          if (percent >= 100 && message === "Done!") {
            completeFromProgress?.();
            completeFromProgress = null;
            void finishFromProgress();
          }
          if (progressBarEl) {
            gsap.to(progressBarEl, {
              width: `${percent}%`,
              duration: 0.35,
              ease: "power2.out",
            });
          }
        },
      },
    },
  });

  new Electroview({ rpc });

  // --- State ---

  type Page = "splash" | "platform" | "installing" | "done";
  type Mode = "install" | "uninstall";

  let page = $state<Page>("splash");
  let installs = $state<DiscordInstall[]>([]);
  let selectedInstall = $state<DiscordInstall | null>(null);
  let mode = $state<Mode>("install");
  let result = $state<{ success: boolean; error?: string } | null>(null);
  let pageWrapper: HTMLElement | null = $state(null);
  let resultIconEl: HTMLElement | null = $state(null);

  // --- Navigation ---

  async function navigate(to: Page) {
    const el = pageWrapper;
    if (el) {
      await new Promise<void>((res) =>
        gsap.to(el, {
          opacity: 0,
          y: -14,
          duration: 0.22,
          ease: "power2.in",
          onComplete: res,
        }),
      );
    }
    page = to;
    await tick();
    if (pageWrapper) {
      gsap.fromTo(
        pageWrapper,
        { opacity: 0, y: 14 },
        { opacity: 1, y: 0, duration: 0.28, ease: "power2.out" },
      );
    }
    if (to === "done") {
      setTimeout(() => {
        if (!resultIconEl) return;
        gsap.killTweensOf(resultIconEl);
        gsap.fromTo(
          resultIconEl,
          { scale: 0, rotation: -20 },
          {
            scale: 1,
            rotation: 0,
            duration: 0.5,
            ease: "elastic.out(1, 0.5)",
            clearProps: "transform",
          },
        );
      }, 80);
    }
  }

  // --- Helpers ---

  const PLATFORM_LABELS: Record<string, string> = {
    stable: "Discord",
    ptb: "Discord PTB",
    canary: "Discord Canary",
  };
  const PLATFORM_COLORS: Record<string, string> = {
    stable: "#5865f2",
    ptb: "#3ba45c",
    canary: "#f0b232",
  };
  const label = (p: string) => PLATFORM_LABELS[p] ?? p;
  const color = (p: string) => PLATFORM_COLORS[p] ?? "#5865f2";

  async function refreshInstalls() {
    installs = await rpc.request.findDiscordInstalls();
  }

  function waitForProgressComplete() {
    return new Promise<{ success: boolean }>((resolve) => {
      completeFromProgress = () => resolve({ success: true });
    });
  }

  function setPatched(resourcesPath: string, isPatched: boolean) {
    installs = installs.map((install) =>
      install.resourcesPath === resourcesPath
        ? { ...install, isPatched }
        : install,
    );
  }

  // --- Actions ---

  async function finishFromProgress() {
    if (finishingFromProgress || page !== "installing") return;
    finishingFromProgress = true;
    result = { success: true };
    if (selectedInstall) {
      setPatched(selectedInstall.resourcesPath, mode === "install");
    }
    await tick();
    await navigate("done");
    refreshInstalls().catch(() => {});
    finishingFromProgress = false;
  }

  async function startInstall(install: DiscordInstall) {
    selectedInstall = install;
    mode = "install";
    finishingFromProgress = false;
    progressMessage = "Preparing...";
    progressPercent = 0;
    await navigate("installing");
    const progressDone = waitForProgressComplete();
    result = await Promise.race([
      rpc.request.install({
        resourcesPath: install.resourcesPath,
      }),
      progressDone,
    ]);
    completeFromProgress = null;
    if (result.success) {
      setPatched(install.resourcesPath, true);
    }
    if (page === "installing") {
      await navigate("done");
    }
    try {
      await refreshInstalls();
    } catch {}
  }

  async function startUninstall(install: DiscordInstall) {
    selectedInstall = install;
    mode = "uninstall";
    finishingFromProgress = false;
    progressMessage = "Preparing...";
    progressPercent = 0;
    await navigate("installing");
    const progressDone = waitForProgressComplete();
    result = await Promise.race([
      rpc.request.uninstall({
        resourcesPath: install.resourcesPath,
      }),
      progressDone,
    ]);
    completeFromProgress = null;
    if (result.success) {
      setPatched(install.resourcesPath, false);
    }
    if (page === "installing") {
      await navigate("done");
    }
    await new Promise((r) => setTimeout(r, 400));
    try {
      await refreshInstalls();
    } catch {}
  }

  async function goToPlatform() {
    await navigate("platform");
    refreshInstalls().catch(() => {});
  }

  // --- Mount ---

  onMount(async () => {
    gsap.from(".acord-logo", {
      scale: 0.55,
      opacity: 0,
      duration: 0.9,
      ease: "elastic.out(1, 0.55)",
    });
    gsap.from(".splash-title", {
      y: 18,
      opacity: 0,
      duration: 0.5,
      delay: 0.35,
      ease: "power2.out",
    });
    gsap.from(".splash-sub", {
      y: 18,
      opacity: 0,
      duration: 0.5,
      delay: 0.46,
      ease: "power2.out",
    });

    setTimeout(async () => {
      try {
        await refreshInstalls();
      } catch {}
      await navigate("platform");
    }, 2400);
  });
</script>

<div class="app">
  <div class="page-wrapper" bind:this={pageWrapper}>
    <!-- SPLASH -->
    {#if page === "splash"}
      <div class="page splash-page">
        <img
          class="acord-logo"
          src="https://raw.githubusercontent.com/acord-standalone/assets/refs/heads/main/logo/acord-circle.png"
          alt="Acord"
          draggable="false"
        />
        <h1 class="splash-title">Acord</h1>
        <p class="splash-sub">Discord Client Mod</p>
        <div class="dots">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>

      <!-- PLATFORM SELECT -->
    {:else if page === "platform"}
      <div class="page platform-page">
        <div class="platform-header">
          <img
            class="logo-sm"
            src="https://raw.githubusercontent.com/acord-standalone/assets/refs/heads/main/logo/acord-circle.png"
            alt="Acord"
            draggable="false"
          />
          <div>
            <h2 class="page-title">Acord Installer</h2>
            <p class="page-sub">Select a Discord variant</p>
          </div>
        </div>

        <div class="divider"></div>

        <p class="section-tag">INSTALL</p>
        <div class="card-list">
          {#if installs.length === 0}
            <div class="empty-state">
              <div class="empty-icon">🔍</div>
              <p class="empty-title">Discord not found</p>
              <p class="empty-sub">Please install Discord first</p>
            </div>
          {:else}
            {#each installs as inst}
              <button class="platform-card" onclick={() => startInstall(inst)}>
                <div
                  class="card-icon"
                  style="background:{color(inst.platform)}"
                >
                  {inst.platform[0].toUpperCase()}
                </div>
                <div class="card-body">
                  <span class="card-name">{label(inst.platform)}</span>
                  <span class="card-status" class:patched={inst.isPatched}>
                    {inst.isPatched ? "● Installed" : "○ Not Installed"}
                  </span>
                </div>
                <span class="card-chevron">›</span>
              </button>
            {/each}
          {/if}
        </div>

        {#if installs.some((i) => i.isPatched)}
          <p class="section-tag remove-section-tag">REMOVE</p>
          <div class="card-list">
            {#each installs.filter((i) => i.isPatched) as inst}
              <button
                class="platform-card uninstall-card"
                onclick={() => startUninstall(inst)}
              >
                <div class="card-icon" style="background:#da373c">
                  {inst.platform[0].toUpperCase()}
                </div>
                <div class="card-body">
                  <span class="card-name">{label(inst.platform)}</span>
                  <span class="card-status remove">● Remove</span>
                </div>
                <span class="card-chevron">›</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- INSTALLING -->
    {:else if page === "installing"}
      <div class="page installing-page">
        <img
          class="logo-sm"
          src="https://raw.githubusercontent.com/acord-standalone/assets/refs/heads/main/logo/acord-circle.png"
          alt="Acord"
          draggable="false"
        />
        <h2 class="page-title">
          {mode === "install" ? "Installing" : "Removing"}
        </h2>
        {#if selectedInstall}
          <div
            class="platform-pill"
            style="background:{color(selectedInstall.platform)}"
          >
            {label(selectedInstall.platform)}
          </div>
        {/if}

        <div class="progress-wrap">
          <div class="progress-track">
            <div
              class="progress-fill"
              bind:this={progressBarEl}
              style="width:{progressPercent}%"
            ></div>
          </div>
          <div class="progress-labels">
            <span class="progress-msg">{progressMessage}</span>
            <span class="progress-pct">{progressPercent}%</span>
          </div>
        </div>
      </div>

      <!-- DONE -->
    {:else if page === "done"}
      <div class="page done-page">
        <div
          bind:this={resultIconEl}
          class="result-icon"
          class:success={result?.success}
          class:error={!result?.success}
        >
          {result?.success ? "✓" : "✕"}
        </div>
        <h2 class="page-title">
          {#if result?.success}
            {mode === "install"
              ? "Installation Complete!"
              : "Removal Complete!"}
          {:else}
            An Error Occurred
          {/if}
        </h2>
        {#if !result?.success}
          <p class="error-text">{result?.error}</p>
        {/if}
        <div class="done-actions">
          <button class="btn primary" onclick={goToPlatform}>
            {result?.success ? "Another Variant" : "Try Again"}
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  :global(*) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }
  :global(:root) {
    --native-frame-x: 14px;
    --native-frame-y: 39px;
  }
  :global(html, body) {
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background: #1e1f22;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      sans-serif;
    color: #dbdee1;
    -webkit-font-smoothing: antialiased;
    user-select: none;
    -webkit-user-select: none;
  }
  :global(#app) {
    width: calc(100vw - var(--native-frame-x));
    height: calc(100vh - var(--native-frame-y));
    overflow: hidden;
  }
  :global(button) {
    cursor: pointer;
    border: none;
    background: none;
    font-family: inherit;
  }

  /* Layout */
  .app {
    width: calc(100vw - var(--native-frame-x));
    height: calc(100vh - var(--native-frame-y));
    background: #1e1f22;
    overflow: hidden;
    position: relative;
  }
  .page-wrapper {
    width: 100%;
    height: 100%;
  }
  .page {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 20px 18px 16px;
  }

  /* Splash */
  .splash-page {
    justify-content: center;
    gap: 10px;
    background: #1e1f22;
  }
  .acord-logo {
    width: 78px;
    height: 78px;
    border-radius: 50%;
    box-shadow: 0 0 40px rgba(88, 101, 242, 0.45);
    margin-bottom: 4px;
  }
  .splash-title {
    font-size: 26px;
    font-weight: 700;
    color: #fff;
    letter-spacing: -0.5px;
  }
  .splash-sub {
    font-size: 13px;
    color: #949ba4;
  }
  .dots {
    display: flex;
    gap: 6px;
    margin-top: 20px;
  }
  .dots span {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #5865f2;
    animation: dot-bounce 1.4s ease-in-out infinite both;
  }
  .dots span:nth-child(2) {
    animation-delay: 0.18s;
  }
  .dots span:nth-child(3) {
    animation-delay: 0.36s;
  }
  @keyframes dot-bounce {
    0%,
    80%,
    100% {
      transform: scale(0.35);
      opacity: 0.3;
    }
    40% {
      transform: scale(1);
      opacity: 1;
    }
  }

  /* Platform page */
  .platform-page {
    align-items: stretch;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 14px 14px 12px;
  }
  .platform-page::-webkit-scrollbar {
    width: 4px;
  }
  .platform-page::-webkit-scrollbar-track {
    background: transparent;
  }
  .platform-page::-webkit-scrollbar-thumb {
    background: #3a3d44;
    border-radius: 2px;
  }
  .platform-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }
  .logo-sm {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .page-title {
    font-size: 15px;
    font-weight: 700;
    color: #fff;
    line-height: 1.2;
  }
  .page-sub {
    font-size: 11.5px;
    color: #949ba4;
    margin-top: 2px;
  }
  .divider {
    height: 1px;
    background: rgba(255, 255, 255, 0.06);
    margin-bottom: 8px;
    flex-shrink: 0;
  }
  .section-tag {
    font-size: 10.5px;
    font-weight: 700;
    color: #949ba4;
    letter-spacing: 0.6px;
    margin-bottom: 4px;
  }
  .remove-section-tag {
    margin-top: 8px;
  }
  .card-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .platform-card {
    display: flex;
    align-items: center;
    gap: 10px;
    background: #2b2d31;
    border-radius: 8px;
    padding: 9px 12px;
    color: #dbdee1;
    transition:
      background 0.14s,
      transform 0.1s;
    text-align: left;
    width: 100%;
  }
  .platform-card:hover {
    background: #35373c;
  }
  .platform-card:active {
    transform: scale(0.975);
  }
  .card-icon {
    width: 30px;
    height: 30px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 800;
    color: #fff;
    flex-shrink: 0;
  }
  .card-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .card-name {
    font-size: 13.5px;
    font-weight: 600;
  }
  .card-status {
    font-size: 11px;
    color: #949ba4;
  }
  .card-status.patched {
    color: #23a55a;
  }
  .card-status.remove {
    color: #da373c;
  }
  .card-chevron {
    font-size: 20px;
    color: #4e5058;
    line-height: 1;
  }

  /* Empty state */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 20px 0 14px;
    gap: 4px;
  }
  .empty-icon {
    font-size: 30px;
    margin-bottom: 6px;
  }
  .empty-title {
    font-size: 13px;
    font-weight: 600;
    color: #dbdee1;
  }
  .empty-sub {
    font-size: 11.5px;
    color: #949ba4;
  }

  /* Installing page */
  .installing-page {
    justify-content: center;
    gap: 10px;
  }
  .installing-page .logo-sm {
    margin-bottom: 2px;
    box-shadow: 0 0 30px rgba(88, 101, 242, 0.3);
  }
  .installing-page .page-title {
    font-size: 17px;
  }
  .platform-pill {
    padding: 4px 14px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 700;
    color: #fff;
    letter-spacing: 0.2px;
  }
  .progress-wrap {
    width: 100%;
    margin-top: 6px;
  }
  .progress-track {
    height: 5px;
    background: #2b2d31;
    border-radius: 999px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #5865f2 0%, #7289da 100%);
    border-radius: 999px;
    width: 0%;
    will-change: width;
  }
  .progress-labels {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 9px;
  }
  .progress-msg {
    font-size: 11.5px;
    color: #949ba4;
  }
  .progress-pct {
    font-size: 11.5px;
    color: #949ba4;
    font-weight: 700;
  }

  /* Done page */
  .done-page {
    justify-content: center;
    gap: 10px;
    text-align: center;
  }
  .result-icon {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    font-weight: 800;
    color: #fff;
    margin-bottom: 2px;
  }
  .result-icon.success {
    background: #2d7d46;
    box-shadow: 0 0 24px rgba(35, 165, 90, 0.4);
  }
  .result-icon.error {
    background: #a12d2f;
    box-shadow: 0 0 24px rgba(218, 55, 60, 0.4);
  }
  .done-page .page-title {
    font-size: 16px;
  }
  .error-text {
    font-size: 11.5px;
    color: #f23f43;
    max-width: 240px;
    line-height: 1.5;
    word-break: break-word;
  }
  .done-actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    margin-top: 4px;
    padding: 0 8px;
  }

  /* Buttons */
  .btn {
    padding: 9px 16px;
    border-radius: 8px;
    font-size: 13.5px;
    font-weight: 600;
    transition:
      background 0.14s,
      transform 0.1s;
    width: 100%;
  }
  .btn.primary {
    background: #5865f2;
    color: #fff;
  }
  .btn.primary:hover {
    background: #4752c4;
  }
  .btn:active {
    transform: scale(0.97);
  }
</style>
