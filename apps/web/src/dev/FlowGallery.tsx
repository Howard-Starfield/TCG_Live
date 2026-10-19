// Owned by L5 (web-flow): renders the live canvas for every core fixture in light and dark.
import { GalleryFrame } from './GalleryFrame';

export function FlowGallery() {
  return <GalleryFrame title="Live canvas">{() => <p className="text-fg-muted">Canvas arrives in Wave 1.</p>}</GalleryFrame>;
}
