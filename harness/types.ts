/** One model row a harness is willing to show. Credentials are never part of this. */
export interface HarnessModelRow {
  key: string;
  name: string;
  provider: string;
  model: string;
  enabled: boolean;
  isDefault?: boolean;
}

/** A provider row, when that harness has its own provider list. */
export interface HarnessProviderRow {
  id: string;
  name: string;
  url: string;
}

/** A harness's own model list. `path` is the file it was read from. */
export interface HarnessModelList {
  path: string;
  models: HarnessModelRow[];
  providers?: HarnessProviderRow[];
}

/** The model list could not be read, or this harness refused a write. */
export class HarnessModelsError extends Error {
  readonly path: string;
  readonly status: number;

  constructor(message: string, path: string, status = 404) {
    super(message);
    this.name = "HarnessModelsError";
    this.path = path;
    this.status = status;
  }
}

/**
 * One local coding harness. Its files stay in `configDir`.
 * Model reading and writing stay on the harness. The route only calls these.
 */
export interface HarnessDescriptor {
  id: string;
  label: string;
  /** Directory or file the settings screen names. Absolute path. */
  configDir(): string;
  /** Absent when this app already has a model editor for the harness (pi uses `/api/models`). */
  readModels?(): HarnessModelList;
  /** What the harness's own runtime mounts, when that is narrower than the file. */
  readChatModels?(): Promise<HarnessModelList>;
  /** Absent when the model list is read-only. */
  writeModel?(key: string, patch: { name?: string; enabled?: boolean }): boolean;
}
