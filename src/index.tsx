import { definePlugin } from "@decky/api";
import { DialogButton, Field, Focusable, Navigation, PanelSection, PanelSectionRow, SliderField, ToggleField, staticClasses } from "@decky/ui";
import { Fragment, useState } from "react";
import { FaForward as PluginIcon, FaGithub } from "react-icons/fa";
import { Injector } from "./injector";
import * as S from "./strings";
import { DEFAULTS, loadSettings, saveSettings, Settings, STEP_MAX, STEP_MIN, STEP_STEP } from "./settings";

const openLink = (url: string) => { Navigation.CloseSideMenus(); Navigation.NavigateToExternalWeb(url); };

// A link row: icon + button that opens the page in Steam's browser.
const LinkRow = ({ icon, label, url }: { icon: any; label: string; url: string }) => (
  <PanelSectionRow>
    <Field padding="none" bottomSeparator="none" childrenContainerWidth="max">
      <Focusable style={{ display: "flex", margin: "6px 0" }}>
        <div style={{ display: "flex", fontSize: "1.5em", justifyContent: "center", alignItems: "center", marginRight: ".5em" }}>{icon}</div>
        <DialogButton onClick={() => openLink(url)} style={{ padding: "10px", fontSize: "14px" }}>{label}</DialogButton>
      </Focusable>
    </Field>
  </PanelSectionRow>
);

// Spacing tweaks for Steam's slider/toggle internals. Inline style={{}} can't reach nested
// elements like .SliderControl or the description, so these need a <style> tag.
const PANEL_CSS = `
  .decky-lj-slider .SliderControl { margin-top: 12px }
  .decky-lj-slider [id*=_Description] { margin-top: 18px !important }
  .decky-lj-toggle [id*=_Description] { margin-top: 14px !important }
  .decky-lj-toggle { padding: 8px 0 }
`;

export default definePlugin(() => {
  let settings: Settings = loadSettings();
  const injector = new Injector(settings);
  injector.start();

  const Content = () => {
    const [panelSettings, setPanelSettings] = useState<Settings>(settings);
    const change = (patch: Partial<Settings>) => {
      settings = { ...settings, ...patch };
      saveSettings(settings);
      injector.update(settings);
      setPanelSettings(settings);
    };
    return (
      <Fragment>
        <PanelSection title={S.SETTINGS_TITLE}>
          <PanelSectionRow>
          <div className="decky-lj-slider">
            <style>{PANEL_CSS}</style>
            <SliderField
              label={S.SPEED_LABEL}
              description={S.SPEED_DESC}
              value={panelSettings.stepMs} min={STEP_MIN} max={STEP_MAX} step={STEP_STEP}
              showValue valueSuffix=" ms" resetValue={DEFAULTS.stepMs}
              notchCount={7} notchTicksVisible={false}
              notchLabels={[
                { notchIndex: 0, label: String(STEP_MIN) },
                { notchIndex: 6, label: String(STEP_MAX) },
              ]}
              onChange={(v: number) => change({ stepMs: v })}
            />
            </div>
          </PanelSectionRow>
          <PanelSectionRow>
            <div className="decky-lj-toggle">
            <ToggleField
              label={S.WRAP_LABEL}
              description={S.WRAP_DESC}
              checked={panelSettings.wrapOnTap} onChange={(v: boolean) => change({ wrapOnTap: v })}
            />
            </div>
          </PanelSectionRow>
        </PanelSection>
        <PanelSection title={S.LINKS_TITLE}>
          <LinkRow icon={<FaGithub />} label={S.LINK_GITHUB} url={S.REPO} />
          <PanelSectionRow><div style={{ fontSize: "12px", opacity: 0.8, paddingTop: "4px", paddingBottom: "6px" }}>{S.AUTHOR}</div></PanelSectionRow>
        </PanelSection>
      </Fragment>
    );
  };

  return {
    name: S.PLUGIN_NAME,
    titleView: <div className={staticClasses.Title} style={{ boxShadow: "none" }}>{S.PLUGIN_NAME}</div>,
    content: <Content />,
    icon: <PluginIcon />,
    onDismount() { injector.stop(); },
  };
});
