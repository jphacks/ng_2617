
'use client';

import { useEffect, useRef, useState } from 'react';
import './storm.css';

type StormAnimationProps = {
  onComplete: () => void;
};

export function StormAnimation({ onComplete }: StormAnimationProps) {
  const [frame, setFrame] = useState(0);
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    const frameTimer = window.setInterval(() => {
      setFrame(current => (current === 0 ? 1 : 0));
    }, 100);

    // 竜巻が通り過ぎた後、付箋が舞う時間も含めて終了
    const finishTimer = window.setTimeout(() => {
      onCompleteRef.current();
    }, 6500);

    return () => {
      window.clearInterval(frameTimer);
      window.clearTimeout(finishTimer);
    };
  }, []);

  return (
    <div className="storm-scene" aria-hidden="true">
      <div className="storm-overlay">
        <img
          className="storm-image"
          src={
            frame === 0
              ? '/images/storm-a.png'
              : '/images/storm-b.png'
          }
          alt=""
          draggable={false}
        />
      </div>

      <div className="flying-notes">
        <div
          className="flying-note"
          style={{
            animationDelay: '2.8s',
            animationDuration: '3.8s',
          }}
        />
      </div>
    </div>
  );
}
