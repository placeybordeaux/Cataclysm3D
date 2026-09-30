import { chassisBodyRect, chassisOf, layoutOf, TEMPLATES, type BodyStyle, type Layout } from '../game/chassis';
import type { Vehicle } from '../game/vehicle';

// The renderer's view of a vehicle's body. Since vehicles v3 phase 1 the body is the vehicle's
// chassis template (src/game/chassis), placed on its grid by the game: the renderer draws
// exactly what gameplay collides with. This module keeps the names the renderer and tests
// used when the layout lived here.

export {
  STYLE_PARAMS, buildSections, liveryFromId, setVehicleWidth, vehicleWidth, VEHICLE_WIDTHS, wheelRadius,
  type BodyStyle, type DoorInfo, type Layout, type Livery, type RowInfo, type RowKind, type Section, type SideWall, type StyleParams, type VehicleWidth, type WheelInfo,
} from '../game/chassis';

/** The vehicle's template placed on its grid (cached by the chassis). */
export function analyze(v: Vehicle): Layout {
  return layoutOf(v);
}

/** The body style its chassis template is drawn with. */
export function classify(v: Vehicle): BodyStyle {
  return TEMPLATES[chassisOf(v).template].style;
}

/** The collision outline (the template's body), or null for frame templates (their cells). */
export function bodyRectFor(v: Vehicle): { x0: number; x1: number; y0: number; y1: number } | null {
  return chassisBodyRect(v);
}
