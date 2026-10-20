export class SuspendSignal extends Error {
  constructor(readonly wakeAt: number) {
    super("workflow suspended");
    this.name = "SuspendSignal";
  }
}
