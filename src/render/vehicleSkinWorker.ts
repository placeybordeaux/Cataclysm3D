import { paintSkin, type SkinInput, type SkinLayoutInfo } from './vehicleSkin';

// Paints vehicle skins off the main thread (a car's skin is ~50k texels of procedural
// pixel art: several ms that would otherwise land in one frame when it streams in).
// Message in: { id, info, inp }; out: { id, width, height, data } with the pixels transferred.

self.onmessage = (e: MessageEvent<{ id: number; info: SkinLayoutInfo; inp: SkinInput }>) => {
  const { id, info, inp } = e.data;
  const skin = paintSkin(info, inp);
  (self as unknown as { postMessage(m: unknown, transfer: Transferable[]): void }).postMessage({ id, width: skin.layout.width, height: skin.layout.height, data: skin.data }, [skin.data.buffer]);
};
