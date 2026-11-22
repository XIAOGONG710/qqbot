export interface ManifestEntry { v?: number; qq?: number; at?: string; kind?: string; pieces: { slot: string; module?: string; list: string; chars?: number; sha256: string; omitted?: boolean }[] }
export interface DiffRow { slot: string; index: number; status: 'match' | 'mismatch' | 'only-self' | 'only-prompt' | 'omitted'; module?: string }
export interface DiffResult { rows: DiffRow[]; selfAt?: string; manifestAt?: string; qq?: number; kind?: string }
export function latestManifest(logsDir: string, options?: { qq?: number }): ManifestEntry | undefined;
export function compareSelf(self: { at?: string; lines?: { slot: string; text: string }[] } | undefined, manifest: ManifestEntry | undefined, selfSlots: readonly string[]): DiffResult;
export function describe(result: DiffResult): string;
