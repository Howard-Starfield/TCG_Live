import type { ComponentType } from 'react';
import { lazy } from 'react';

// Dev-only gallery routes. Each gallery page is owned by its lane: KitGallery (L3), FlowGallery (L5).
export const galleries: Record<string, ComponentType> = {
  '#/__kit': lazy(() => import('./KitGallery').then(module => ({ default: module.KitGallery }))),
  '#/__flow': lazy(() => import('./FlowGallery').then(module => ({ default: module.FlowGallery }))),
  '#/__lists': lazy(() => import('./ListsGallery').then(module => ({ default: module.ListsGallery })))
};

export function resolveGallery(hash: string): ComponentType | null {
  const Page = galleries[hash.split('?')[0] ?? ''];
  return Page ?? null;
}
