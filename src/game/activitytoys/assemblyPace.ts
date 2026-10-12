import type { Activity } from '../activity';
/** Explicit hand pace: about twelve real seconds per remaining batch, never faster. */
export function assemblyHandWarp(duration: number, batch: number, scale: number, ordinary: number): number {
  return Math.min(ordinary, Math.max(1, duration / Math.max(1, batch) / 12 / scale));
}
export class AssemblyPace {
  private activity: Activity | null = null;
  private ordinary = 1;
  constructor(private host: { clock: { warp: number }; activities: { current: Activity | null } }) {}
  begin(activity: Activity, batch: number, scale: number): void {
    if (this.activity || this.host.activities.current !== activity) return;
    this.activity = activity;
    this.ordinary = this.host.clock.warp;
    this.host.clock.warp = assemblyHandWarp(Math.max(0, activity.spec.duration - activity.elapsed), batch, scale, this.ordinary);
  }
  end(): void {
    // Cancel/finish/replacement already established the correct new activity/world warp.
    if (this.activity && this.host.activities.current === this.activity) this.host.clock.warp = this.ordinary;
    this.activity = null;
  }
}
