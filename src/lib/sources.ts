// SourceTracker accumulates the upstream URLs we hit, with the timestamp,
// so every tool response carries an auditable provenance trail.
// This is the Bloomberg "trust the number" property made machine-verifiable.

import type { SourceRef } from "./types";

export class SourceTracker {
  private refs: SourceRef[] = [];

  add(url: string): void {
    this.refs.push({ url, fetched_at: new Date().toISOString() });
  }

  out(): SourceRef[] {
    return this.refs;
  }
}
