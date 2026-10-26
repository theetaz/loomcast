// Types for install.mjs, which stays plain JavaScript so it runs without a build step.

export declare const HOOK_EVENT: "SessionEnd";
export declare const HOOK_MARKER: string;
export declare const HOOK_SCRIPT: string;

export interface HookSettings {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

export declare function shellQuote(value: string): string;
export declare function hookCommand(options?: { node?: string; script?: string }): string;
export declare function hookSnippet(command: string): HookSettings;
export declare function mergeHookConfig(
  config: unknown,
  command: string,
): { config: HookSettings; changed: boolean };
export declare function installHook(
  file: string,
  command: string,
): Promise<{ path: string; changed: boolean; backup: string | null }>;
export declare function envLines(options?: { url?: string; workspace?: string }): string[];
