import type { Board } from '../domain/board';

/**
 * モックAIサービス：ダミーの単語を生成する
 * 実際のAI APIに置き換える際はここを差し替える
 */
export async function generateWordSuggestions(board: Board): Promise<string[]> {
  // モック実装：ダミーの単語を返す
  const dummyWords = [
    'コーヒー', '快適さ', '集客', 'メニュー', 'インテリア',
    '音楽', 'Wi-Fi', '座席', 'スタッフ', '照明',
    '値段', 'ブランド', '立地', 'オープン', '特産品'
  ];
  
  // ランダムに3つの単語を選択
  const existing = new Set(board.cards.map(card => card.text.trim()));
  const shuffled = dummyWords.filter(word => !existing.has(word)).sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 3);
}
