import type { AddonInput } from './types.ts';

// Kept only for the navigation after a successful post; refreshing cannot repost it.
export const wikiThanks = $state<{ addon: AddonInput | null }>({ addon: null });
