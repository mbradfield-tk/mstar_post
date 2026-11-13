import { clearLicCache } from "./lic";
import { clearPlaneCache } from "./plane";
import { clearViewerCaches } from "./Viewer3D";

// Loaded on demand by App (account change), and only after the Viewer chunk was used, so the
// app shell does not pull Three.js in just to empty caches that do not exist yet.
export function clearViewerModuleCaches(): void {
  clearPlaneCache();
  clearLicCache();
  clearViewerCaches();
}
