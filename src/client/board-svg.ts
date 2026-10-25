
import type { Board, Card, CardId } from '@/domain/board';
import { getCard, sameObjectId } from '@/domain/board';

const MARGIN = 40;
const HEADER_HEIGHT = 30;
const TEXT_PADDING = 14;

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;',
  })[char]!);
}

function cardById(board: Board, id: CardId): Card | undefined {
  return getCard(board, id);
}

function anchorPoint(
  card: Card,
  anchor: 'north' | 'east' | 'south' | 'west',
) {
  const { x, y } = card.position;
  const { width, height } = card.shape;

  switch (anchor) {
    case 'north':
      return { x: x + width / 2, y };
    case 'east':
      return { x: x + width, y: y + height / 2 };
    case 'south':
      return { x: x + width / 2, y: y + height };
    case 'west':
      return { x, y: y + height / 2 };
  }
}

function wrapText(text: string, maxChars: number): string[] {
  const result: string[] = [];

  for (const paragraph of text.split('\n')) {
    const chars = Array.from(paragraph);

    if (chars.length === 0) {
      result.push('');
      continue;
    }

    for (let i = 0; i < chars.length; i += maxChars) {
      result.push(chars.slice(i, i + maxChars).join(''));
    }
  }

  return result;
}

function renderText(
  text: string,
  x: number,
  y: number,
  maxChars: number,
  lineHeight: number,
  fontSize: number,
): string {
  return wrapText(text, maxChars).map((line, index) =>
    `<text x="${x}" y="${y + index * lineHeight}" font-size="${fontSize}">${escapeXml(line)}</text>`
  ).join('');
}

function renderCard(board: Board, card: Card): string {
  const { x, y } = card.position;
  const { width, height } = card.shape;
  const font = escapeXml(card.font || 'sans-serif');
  const color = /^#[0-9a-f]{6}$/i.test(card.color)
    ? card.color
    : '#FFF0A8';

  const parts: string[] = [
    `<g font-family="${font}" fill="#222">`,
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" fill="${color}" stroke="#777" stroke-width="1"/>`,
  ];

  let textY = y + 25;

  if (card.cardKind === 'block') {
    parts.push(
      `<text x="${x + TEXT_PADDING}" y="${textY}" font-size="15" font-weight="bold">関連カード</text>`,
    );
    textY += HEADER_HEIGHT;

    for (const relatedId of card.relatedIds) {
      const related = cardById(board, relatedId);
      const label = related?.text.trim() || '無題のカード';
      parts.push(
        `<text x="${x + TEXT_PADDING}" y="${textY}" font-size="11">・${escapeXml(label)}</text>`,
      );
      textY += 17;
    }

    textY += 10;
    parts.push(
      `<text x="${x + TEXT_PADDING}" y="${textY}" font-size="11" fill="#555">概要</text>`,
    );
    textY += 20;
  }

  const textBottom = y + height - (card.cardKind === 'block' ? 55 : 12);
  const maxChars = Math.max(1, Math.floor((width - TEXT_PADDING * 2) / 9));
  const lines = wrapText(card.text, maxChars);
  const availableLines = Math.max(
    1,
    Math.floor((textBottom - textY) / 19),
  );

  parts.push(renderText(
    lines.slice(0, availableLines).join('\n'),
    x + TEXT_PADDING,
    textY,
    maxChars,
    19,
    14,
  ));

  if (card.cardKind === 'block') {
    const counts = new Map<string, number>();

    for (const reaction of card.reactions) {
      counts.set(
        reaction.reactionId,
        (counts.get(reaction.reactionId) ?? 0) + 1,
      );
    }

    const reactionText = [
      ['👍', 'thumbs-up'],
      ['❤️', 'heart'],
      ['💡', 'idea'],
      ['🤔', 'thinking'],
      ['🎉', 'celebrate'],
    ]
      .filter(([, id]) => counts.has(id))
      .map(([icon, id]) => `${icon} ${counts.get(id)}`)
      .join('   ');

    if (reactionText) {
      parts.push(
        `<text x="${x + TEXT_PADDING}" y="${y + height - 18}" font-size="13">${escapeXml(reactionText)}</text>`,
      );
    }
  }

  parts.push('</g>');
  return parts.join('');
}

export function createBoardSvg(board: Board): string {
  if (board.cards.length === 0) {
    return [
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">',
      '<rect width="100%" height="100%" fill="#fff"/>',
      '<text x="30" y="60" font-family="sans-serif" font-size="18">空のボード</text>',
      '</svg>',
    ].join('');
  }

  const minX = Math.min(...board.cards.map(card => card.position.x));
  const minY = Math.min(...board.cards.map(card => card.position.y));
  const maxX = Math.max(...board.cards.map(card => card.position.x + card.shape.width));
  const maxY = Math.max(...board.cards.map(card => card.position.y + card.shape.height));

  const width = maxX - minX + MARGIN * 2;
  const height = maxY - minY + MARGIN * 2;
  const offsetX = MARGIN - minX;
  const offsetY = MARGIN - minY;

  const arrows = board.arrows.map(arrow => {
    const source = cardById(board, arrow.sourceCardId);
    const target = cardById(board, arrow.targetCardId);

    if (!source || !target) return '';

    const start = anchorPoint(source, arrow.sourceAnchor);
    const end = anchorPoint(target, arrow.targetAnchor);

    return `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="#555" stroke-width="2" marker-end="url(#arrowhead)"/>`;
  }).join('');

  const cards = [...board.cards]
    .sort((a, b) => a.position.z - b.position.z)
    .map(card => renderCard(board, card))
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="${width}" height="${height}"
     viewBox="${minX - MARGIN} ${minY - MARGIN} ${width} ${height}">
  <title>ブレインストーミングボード</title>
  <desc>確定済みのカードと矢印を出力したボード</desc>
  <defs>
    <marker id="arrowhead" markerWidth="10" markerHeight="8"
      refX="9" refY="4" orient="auto">
      <path d="M0,0 L10,4 L0,8 Z" fill="#555"/>
    </marker>
  </defs>
  <rect x="${minX - MARGIN}" y="${minY - MARGIN}"
    width="${width}" height="${height}" fill="#fff"/>
  <g>${arrows}</g>
  <g>${cards}</g>
</svg>`;
}

export function downloadBoardSvg(board: Board): void {
  const svg = createBoardSvg(board);
  const blob = new Blob([svg], {
    type: 'image/svg+xml;charset=utf-8',
  });

  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const filename =
    `brainstorm-board-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.svg`;

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
