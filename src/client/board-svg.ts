import type { Anchor, Board, Card } from '../domain/board';
import { getCard, REACTIONS } from '../domain/board.ts';
import { createBoardFile, downloadBlob, timestamp } from './board-file.ts';

const MARGIN = 40;
const PADDING = 14;
function escapeXml(value: string): string {
  return value.toWellFormed().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '�')
    .replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!);
}
function color(value: string): string {
  return /^(#[0-9a-f]{3,8}|[a-z]+|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+\-/]+\))$/i.test(value) ? value : '#FFF0A8';
}
function wrapText(text: string, maxChars: number): string[] {
  return text.split('\n').flatMap(paragraph => {
    const chars = Array.from(paragraph);
    if (!chars.length) return [''];
    const lines = [];
    for (let index = 0; index < chars.length; index += maxChars) lines.push(chars.slice(index, index + maxChars).join(''));
    return lines;
  });
}
function renderCard(board: Board, card: Card): string {
  const { x, y } = card.position;
  const { width, height } = card.shape;
  const maxChars = Math.max(1, Math.floor((width - PADDING * 2) / 14));
  const paragraphs: string[] = [];
  if (card.cardKind === 'block') {
    paragraphs.push('関連カード');
    for (const id of card.relatedIds) paragraphs.push(`・${getCard(board, id)?.text || '無題のカード'}`);
    paragraphs.push('概要');
  }
  paragraphs.push(card.text);
  if (card.cardKind === 'block') {
    const reactions = REACTIONS.map(reaction => {
      const count = card.reactions.filter(item => item.reactionId === reaction.reactionId).length;
      return count ? `${reaction.icon} ${count}` : '';
    }).filter(Boolean).join('   ');
    if (reactions) paragraphs.push(reactions);
  }
  const lines = paragraphs.flatMap(text => wrapText(text, maxChars));
  // 全文を残し、カードからはみ出す場合は文字群を縮小する。末尾を切り捨てない。
  const scale = Math.min(1, (height - PADDING * 2) / (lines.length * 20));
  const text = lines.map((line, index) => `<text x="0" y="${16 + index * 20}" font-size="14">${escapeXml(line)}</text>`).join('');
  return `<g font-family="${escapeXml(card.font || 'sans-serif')}" fill="#292929">
    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="5" fill="${escapeXml(color(card.color))}" stroke="#c7c2ac"/>
    <g transform="translate(${x + PADDING} ${y + PADDING}) scale(${scale})">${text}</g>
  </g>`;
}
type Point = { x: number; y: number };
function anchorPoint(card: Card, anchor: Anchor): Point {
  const { x, y } = card.position; const { width, height } = card.shape;
  switch (anchor) {
    case 'north': return { x: x + width / 2, y };
    case 'east': return { x: x + width, y: y + height / 2 };
    case 'south': return { x: x + width / 2, y: y + height };
    case 'west': return { x, y: y + height / 2 };
  }
}
function outside(point: Point, anchor: Anchor): Point {
  return { x: point.x + (anchor === 'east' ? 24 : anchor === 'west' ? -24 : 0),
    y: point.y + (anchor === 'south' ? 24 : anchor === 'north' ? -24 : 0) };
}
export function createBoardSvg(board: Board): string {
  createBoardFile(board); // JSONと同じモデル・参照・座標の検証を使う。
  if (!board.cards.length) return '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><rect width="100%" height="100%" fill="#fff"/><text x="30" y="60" font-family="sans-serif" font-size="18">空のボード</text></svg>';
  const points: Point[] = board.cards.flatMap(card => [card.position,
    { x: card.position.x + card.shape.width, y: card.position.y + card.shape.height }]);
  const arrows = board.arrows.map(arrow => {
    const source = getCard(board, arrow.sourceCardId)!; const target = getCard(board, arrow.targetCardId)!;
    const start = anchorPoint(source, arrow.sourceAnchor); const end = anchorPoint(target, arrow.targetAnchor);
    const a = outside(start, arrow.sourceAnchor); const b = outside(end, arrow.targetAnchor);
    const middle = { x: b.x, y: a.y };
    const route = [start, a, middle, b, end]; points.push(...route);
    return `<path d="M${route.map(point => `${point.x},${point.y}`).join(' L')}" fill="none" stroke="#64748b" stroke-width="2" marker-end="url(#arrowhead)"/>`;
  }).join('');
  const minX = Math.min(...points.map(point => point.x)) - MARGIN;
  const minY = Math.min(...points.map(point => point.y)) - MARGIN;
  const width = Math.max(...points.map(point => point.x)) + MARGIN - minX;
  const height = Math.max(...points.map(point => point.y)) + MARGIN - minY;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}">
<title>ブレインストーミングボード</title><desc>確定済みのカードと矢印を出力したボード</desc>
<defs><marker id="arrowhead" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 Z" fill="#64748b"/></marker></defs>
<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="#fff"/>
<g>${arrows}</g><g>${[...board.cards].sort((a, b) => a.position.z - b.position.z).map(card => renderCard(board, card)).join('')}</g></svg>`;
}
export function downloadBoardSvg(board: Board): void {
  downloadBlob(new Blob([createBoardSvg(board)], { type: 'image/svg+xml;charset=utf-8' }), `brainstorm-board-${timestamp()}.svg`);
}
