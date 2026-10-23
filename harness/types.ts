/** One local coding harness. Its own files stay in `configDir`. */
export interface HarnessDescriptor {
  id: string;
  label: string;
  /** Directory or file the settings screen edits. Absolute path. */
  configDir(): string;
}
