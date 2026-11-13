export interface Settings {
    stepMs: number; // time between jumps while holding (150-450)
    wrapOnTap: boolean;
}
export const DEFAULTS: Settings = { stepMs: 200, wrapOnTap: true };
const KEY = "decky-library-jump.settings";
export const STEP_MIN = 150,
    STEP_MAX = 450,
    STEP_STEP = 10;

export function loadSettings(): Settings {
    try {
        const savedSettings = JSON.parse(localStorage.getItem(KEY) || "{}");
        const ms = Number(savedSettings.stepMs);
        return {
            stepMs: isFinite(ms)
                ? Math.min(STEP_MAX, Math.max(STEP_MIN, ms))
                : DEFAULTS.stepMs,
            wrapOnTap:
                typeof savedSettings.wrapOnTap === "boolean"
                    ? savedSettings.wrapOnTap
                    : DEFAULTS.wrapOnTap,
        };
    } catch {
        return { ...DEFAULTS };
    }
}
export function saveSettings(s: Settings) {
    try {
        localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
        /* ignore */
    }
}
