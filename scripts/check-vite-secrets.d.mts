/** Type declarations for scripts/check-vite-secrets.mjs (imported by tests). */
export interface ViteNameHit {
  readonly file: string;
  readonly line: number;
  readonly name: string;
}

export function findSecretViteNames(root: string): ViteNameHit[];
