/**
 * Abstraction over "where mod files live". Decoupling the loader from the file
 * system lets the same loader run under Node (headless/tests/Electron main) and,
 * later, against an in-memory or networked source — without the loader caring.
 */
export interface FileSource {
  /** Read a UTF-8 text file at a path relative to the source root. */
  readText(path: string): Promise<string>
  /** Whether a path exists. */
  exists(path: string): Promise<boolean>
}
