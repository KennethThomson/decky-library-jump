import { findSP } from "@decky/ui";
import { injectLibraryJump } from "./bigpicture";
import { Settings } from "./settings";

// Runs in SharedJSContext. The real work happens in the Big Picture window (findSP()), where the library grid and
// gamepad events live. We evaluate injectLibraryJump() there and keep its config in sync with the settings.
const toBigPictureConfig = (settings: Settings) => ({
  HOLD_DELAY_MS: 450,
  START_INTERVAL_MS: settings.stepMs,
  WRAP_ON_TAP: settings.wrapOnTap,
});

export class Injector {
  private settings: Settings;
  private pollTimer: any = null;
  // The Big Picture window we last injected into; syncBigPicture() compares against it to notice a reload, stop() uses it to undo.
  private injectedWindow: any = null;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  private install(bigPictureWindow: any) {
    const injectedScript = `(${injectLibraryJump.toString()})(${JSON.stringify(toBigPictureConfig(this.settings))})`;
    try {
      bigPictureWindow.eval(injectedScript);
    } catch (error) {
      // eval was blocked: fall back to building the function directly
      try {
        new bigPictureWindow.Function(`return ${injectedScript}`)();
      } catch (fallbackError) {
        console.warn("[library-jump] injection failed", fallbackError);
        return;
      }
    }
    this.injectedWindow = bigPictureWindow;
  }

  /** (Re)inject if the Big Picture window changed or was reloaded; otherwise just push the current config. */
  private syncBigPicture = () => {
    let bigPictureWindow: any;
    try {
      bigPictureWindow = findSP();
    } catch {
      return;
    }
    if (!bigPictureWindow || typeof bigPictureWindow.eval !== "function") {
      return;
    }

    const isNewWindow = bigPictureWindow !== this.injectedWindow;
    const isPluginMissing = !bigPictureWindow.libraryJump || !bigPictureWindow.libraryJump.config;
    if (isNewWindow || isPluginMissing) {
      this.install(bigPictureWindow);
    } else {
      Object.assign(bigPictureWindow.libraryJump.config, toBigPictureConfig(this.settings));
    }
  };

  start() {
    this.syncBigPicture();
    this.pollTimer = setInterval(this.syncBigPicture, 2000);
  }

  update(settings: Settings) {
    this.settings = settings;
    this.syncBigPicture();
  }

  stop() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    try {
      const bigPictureWindow = this.injectedWindow || findSP();
      if (bigPictureWindow && bigPictureWindow.libraryJump) {
        bigPictureWindow.libraryJump.undo();
      }
    } catch {
      /* ignore */
    }
    this.injectedWindow = null;
  }
}
