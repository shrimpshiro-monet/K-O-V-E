/** Type declarations for scripts/check-bundle-secrets.mjs (imported by tests). */
export interface BundleHit {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly match: string;
}

export function scanBundleDir(bundleDir: string): BundleHit[];
