'use client';

import { useEffect, useState } from 'react';
import './storm.css';

type StormAnimationProps = {
  onComplete: () => void;
};

export function StormAnimation({ onComplete }: StormAnimationProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const frameTimer = window.setInterval(() => {
      setFrame(current => current === 0 ? 1 : 0);
    }, 100);

    const finishTimer = window.setTimeout(onComplete, 2200);

    return () => {
      window.clearInterval(frameTimer);
      window.clearTimeout(finishTimer);
    };
  }, [onComplete]);

  return (
    <div className="storm-overlay" aria-hidden="true">
      <img
        className="storm-image"
        src={frame === 0
          ? '/images/storm-a.png'
          : '/images/storm-b.png'}
        alt=""
        draggable={false}
      />
    </div>
  );
}