
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

    const finishTimer = window.setTimeout(() => {
      onCompleteRef.current();
    }, 4000);

    return () => {
      window.clearInterval(frameTimer);
      window.clearTimeout(finishTimer);
    };
  }, []);

  return (
    <div className="storm-overlay" aria-hidden="true">
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
  );
}
