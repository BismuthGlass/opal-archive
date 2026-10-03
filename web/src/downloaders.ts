import type { Component } from "solid-js";
import DownloadPanel from "./components/DownloadPanel";

/** What a download tab's panel is given: the tab it belongs to. */
export type PanelProps = { tab: number };

/**
 * Panels made for one downloader, by its name. A downloader not listed
 * gets the general panel, which is built from its manifest: the address
 * box, its options, the base tags, its login and what it has seen. Give a
 * downloader its own component here when it needs something else.
 */
const PANELS: Record<string, Component<PanelProps>> = {};

export const panelFor = (downloader: string): Component<PanelProps> =>
  PANELS[downloader] ?? DownloadPanel;
