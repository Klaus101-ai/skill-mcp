// Local type declarations for ./hint.mjs (the product does not depend on
// @opencode/plugin: it is not installed in this repo, see README «Plugin»).
// Signatures mirror plugin/hint.mjs; keep the two in sync.

export interface HintItem {
  name: string;
  why: string;
}

export interface HintSystemPart {
  type: "text";
  text: string;
}

export interface HintMessage {
  role?: string;
  content?: unknown;
}

/** Structural subset of the opencode `context` hook event this hook reads. */
export interface HintContextEvent {
  agent?: string;
  system: HintSystemPart[];
  messages?: HintMessage[];
}

export type ContextHook = (event: HintContextEvent) => void;

export interface HintHookOptions {
  env?: Record<string, string | undefined>;
  debug?: boolean | ((msg: string) => void);
  configPath?: string;
  config?: { deny?: Record<string, string[]>; allow?: Record<string, string[]> };
  roots?: string[];
  discover?: (roots: string[]) => { skills: Array<{ path?: string; description?: string }> };
  buildIndex?: (skills: unknown[]) => unknown;
  search?: (index: unknown, query: string, opts?: { limit?: number }) => Array<{ name: string; path: string }>;
  now?: () => number;
}

export declare const HINT_SOURCE: string;
export declare const HINT_NOTE: string;
export declare const HINT_TAG: string;
export declare const HINT_MARKER: string;
export declare const MAX_ITEMS: number;
export declare const MAX_BLOCK_CHARS: number;
export declare const BUDGET_MS: number;
export declare const DEFAULT_CONFIG_PATH: string;

export declare function isHintOff(value: unknown): boolean;
export declare function normalizeConfig(raw: unknown): { deny: Record<string, string[]>; allow: Record<string, string[]> };
export declare function nameMatches(name: string, patterns: readonly string[]): boolean;
export declare function buildHintBlock(items: readonly HintItem[] | null | undefined): string;
export declare function createContextHook(options?: HintHookOptions): ContextHook;
