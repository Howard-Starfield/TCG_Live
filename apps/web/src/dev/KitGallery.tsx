// Owned by L3 (web-kit): shows every ui/ component state in light and dark.
import { GalleryFrame } from './GalleryFrame';

export function KitGallery() {
  return <GalleryFrame title="UI kit">{() => <p className="text-fg-muted">Components arrive in Wave 1.</p>}</GalleryFrame>;
}
