export type Message =
  | { type: 'ss:status' }
  | { type: 'ss:revealAll' }
  | { type: 'ss:hideAll' }
  | { type: 'ss:blocked'; count: number; pageTotal: number; pageId: string }
  | { type: 'ss:resetStats' };

export interface PageStatus {
  host: string;
  site: string;
  active: boolean;
  reason: 'active' | 'disabled' | 'allowlisted' | 'site-off' | 'blocklisted' | 'loading';
  mode: string;
  blocked: number;
  revealed: number;
  pageCount: number;
  titleHidden: boolean;
}
