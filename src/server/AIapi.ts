// 関連性の度合いの型定義
type RelationLevel = "low" | "mid" | "high";

// Gemini APIのレスポンスの型定義（簡易版）
interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
}

/**
 * Gemini APIを使って、入力された単語配列に対し指定した度合いで関連する単語Yを取得する関数
 * @param words 単語の配列 [X1, X2, X3, ...]
 * @param level 関連性の度合い ('low' | 'mid' | 'high')
 */
async function getWordByGemini(
  words: string[],
  level: RelationLevel,
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("環境変数 GEMINI_API_KEY が設定されていません。");
  }

  // Gemini APIのエンドポイント（※クエリパラメータにAPIキーを付与します）
  // 最もコストパフォーマンスが高い軽量モデル「gemini-2.5-flash」を使用
  const modelName = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  // 度合いに応じた指示（プロンプト）の切り替え
  let instruction = "";
  switch (level) {
    case "low":
      instruction =
        "入力されたどの単語とも、意味的な関連性ができるだけ低い（無関係に近い）単語を1つだけ考えてください。";
      break;
    case "mid":
      instruction =
        "入力された単語群と同じ大枠のジャンルに属するが、直接的な同義語やシソーラスではない、適度に関連性（中程度）のある単語を1つだけ考えてください。";
      break;
    case "high":
      instruction =
        "入力された単語群と非常に強い関連性や共通項があり、同じグループに深く属するような単語を1つだけ考えてください。";
      break;
  }

  const promptText = `${instruction}
出力は余計な解説や記号、前置きを含めず、**1つの単語（文字列）のみ**にしてください。

配列: ${JSON.stringify(words)}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: promptText,
              },
            ],
          },
        ],
        // 生成のパラメータ設定
        generationConfig: {
          temperature: level === "low" ? 0.8 : 0.5,
          maxOutputTokens: 30, // 出力トークンの上限
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini APIエラー (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as GeminiResponse;
    const resultY =
      data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;

    return resultY;
  } catch (error) {
    console.error("Gemini APIリクエストに失敗しました:", error);
    return null;
  }
}
