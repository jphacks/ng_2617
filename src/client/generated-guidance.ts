import type { Card } from '../domain/board';

/** React Flowの座標と保存された外枠から、端末固有の案内だけを計算する。 */
export function generatedGuidance(card: Card, viewport: { x: number; y: number; zoom: number }, bounds: { width: number; height: number }) {
  const left = viewport.x + card.position.x * viewport.zoom;
  const top = viewport.y + card.position.y * viewport.zoom;
  const width = card.shape.width * viewport.zoom;
  const height = card.shape.height * viewport.zoom;
  if (left >= 0 && top >= 0 && left + width <= bounds.width && top + height <= bounds.height) return { visible: true as const };
  const dx = left + width / 2 - bounds.width / 2;
  const dy = top + height / 2 - bounds.height / 2;
  const scale = Math.min((bounds.width / 2 - 35) / Math.max(Math.abs(dx), 1), (bounds.height / 2 - 35) / Math.max(Math.abs(dy), 1));
  return { visible: false as const, x: Math.max(35, Math.min(bounds.width - 35, bounds.width / 2 + dx * scale)),
    y: Math.max(35, Math.min(bounds.height - 35, bounds.height / 2 + dy * scale)), angle: Math.atan2(dy, dx) * 180 / Math.PI };
}
