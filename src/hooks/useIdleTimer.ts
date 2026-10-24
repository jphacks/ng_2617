'use client';

import { useState, useEffect, useCallback } from 'react';

type UseIdleTimerProps = {
  timeoutSeconds: number; // 何秒操作がなかったら発火するか (例: 30)
  onIdle: () => void;     // タイムアウトした時に実行する関数
};

export function useIdleTimer({ timeoutSeconds, onIdle }: UseIdleTimerProps) {
  const [isIdle, setIsIdle] = useState(false);

  const handleIdle = useCallback(() => {
    setIsIdle(true);
    onIdle(); // 親から渡された「タイムアウト時の処理」を呼ぶ
  }, [onIdle]);

  useEffect(() => {
    let timer: NodeJS.Timeout;

    // タイマーをリセットして再設定する関数
    const resetTimer = () => {
      setIsIdle(false);
      clearTimeout(timer);
      timer = setTimeout(handleIdle, timeoutSeconds * 1000);
    };

    // 監視するイベントの種類（クリック、キー入力など）
    const events = ['mousedown', 'keydown'];

    // イベントが起きたらタイマーをリセット
    events.forEach((event) => {
      window.addEventListener(event, resetTimer);
    });

    // 初期化時にもタイマーをスタート
    resetTimer();

    // クリーンアップ（コンポーネントが消える時にイベントリスナーを削除）
    return () => {
      clearTimeout(timer);
      events.forEach((event) => {
        window.removeEventListener(event, resetTimer);
      });
    };
  }, [timeoutSeconds, handleIdle]);

  return { isIdle };
}