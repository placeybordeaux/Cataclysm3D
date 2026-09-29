// ui2 public API (docs/UI2.md). Import from here, not from the individual files, so the
// toolkit can reorganise internally.

export { h, ui2Layers, viewport } from './dom';
export { installTheme, palette, currentMetrics, setScalePref, scalePref, onScaleChange } from './theme';
export { setHost, standaloneHost, acquireSurface, pushKeys, shortcut, routeKey, settings, saveSettings, surfacesOpen, type Ui2Host } from './host';
export { iconEl, setLooksLike, iconsReady } from './icons';
export { openPanel, findPanel, topPanel, openPanels, closeGroup, resetWindowPositions, type Panel, type PanelOpts } from './window';
export { button, tabs, scrollList, capacityBar, progressBar, type TabDef } from './widgets';
export { itemCell, emptySlot, type CellMode } from './itemcell';
export { makeDraggable, registerDropTarget, targetAt, dragging, flashNote, type DragPayload, type DropTarget, type DraggableOpts } from './dragdrop';
export { openContextMenu, closeMenu, menuOpen, type MenuItem } from './menu';
export { attachTooltip, hideTooltip, itemTooltip, suppressTooltips, type TipContent } from './tooltip';
export { toast, toastState } from './toast';
export { confirmModal, countPrompt } from './modal';
export { startProgress, type ProgressHandle } from './progress';
export { Hotbar, HOTBAR_KEYS, type HotbarBinding } from './hotbar';
export { paperDollView, type DollSlot } from './paperdoll';
export { containerView, containerPanel, capacityBars, locationTarget, wireItemCell, splitPrompt, sectionLabel } from './containers';
export { worldContextProviders, worldMenu, type WorldTarget, type WorldContextProvider } from './world';
export type { InventoryModel, Capacity, MoveOutcome } from './model';
export * from './logic/items';
export * from './logic/dnd';
export type { ToastSpec, ToastCategory } from './logic/toasts';
