// The meter register ("Rollenzählwerk"): digit drums like the counter of a German electricity
// meter, with the fractional drums in red. Digits are drawn by CSS, so the DOM text is only the
// accessible value (e.g. "0.6 kWh"), which also keeps Playwright text assertions simple.
import { useEffect, useRef, useState, type CSSProperties } from 'react';

const ROLL_MS = 420;

interface DrumProps {
  digit: number;
  /** 0..1: how far the drum has turned towards the next digit (continuous last drum). */
  turn?: number;
  fraction: boolean;
}

function Drum({ digit, turn = 0, fraction }: DrumProps) {
  const target = digit + Math.min(0.999, Math.max(0, turn));
  const [pos, setPos] = useState(target);
  const [instant, setInstant] = useState(false);
  const prev = useRef(target);

  useEffect(() => {
    const from = prev.current;
    prev.current = target;
    if (target >= from - 1e-6) {
      setInstant(false);
      setPos(target);
      return;
    }
    // Wrapped (9 -> 0): keep rolling forward on the second half of the strip, then snap back.
    setInstant(false);
    setPos(target + 10);
    const t = setTimeout(() => {
      setInstant(true);
      setPos(target);
    }, ROLL_MS + 40);
    return () => clearTimeout(t);
  }, [target]);

  const style = { '--pos': pos } as CSSProperties;
  return (
    <span className={`drum${fraction ? ' drum--fraction' : ''}`}>
      <span className={`drum__strip${instant ? ' drum__strip--instant' : ''}${turn > 0 ? ' drum__strip--smooth' : ''}`} style={style} />
    </span>
  );
}

export interface RegisterProps {
  /** Fixed-width digits with at most one ".", e.g. "0012.6". */
  digits: string;
  /** 0..1 progress of the last drum towards its next digit. */
  lastTurn?: number;
  unit: string;
  /** Accessible and DOM text, e.g. "1.26 kWh". */
  text: string;
  size?: 'xl' | 'lg' | 'md' | 'sm';
  testId?: string;
  /** Machine-readable value for tests (e.g. "0.6"). */
  value?: string;
  className?: string;
  /** Red fractional drums (energy, like a meter) or plain ones (money). */
  fraction?: 'red' | 'plain';
}

export function Register({ digits, lastTurn = 0, unit, text, size = 'lg', testId, value, className, fraction = 'red' }: RegisterProps) {
  const chars = [...digits];
  const dot = chars.indexOf('.');
  const lastDigit = chars.length - 1;
  return (
    <span className={`register register--${size}${className ? ` ${className}` : ''}`} data-testid={testId} data-value={value} role="img" aria-label={text}>
      <span className="register__window" aria-hidden="true">
        {chars.map((c, i) =>
          c === '.' ? (
            <span key={i} className="register__dot" />
          ) : (
            <Drum key={i} digit={Number(c)} fraction={fraction === 'red' && dot >= 0 && i > dot} turn={i === lastDigit ? lastTurn : 0} />
          ),
        )}
      </span>
      <span className="register__unit" aria-hidden="true">
        {unit}
      </span>
      <span className="sr-only">{text}</span>
    </span>
  );
}
