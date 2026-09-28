import QRCode from 'qrcode';
import { useMemo } from 'react';

/** Crisp SVG QR code. `data-url` carries the encoded URL (what a camera would read). */
export function QrCode({ value, label, testId, level = 'M', className }: { value: string; label: string; testId?: string; level?: 'L' | 'M' | 'Q'; className?: string }) {
  const { d, n } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: level });
    const size = qr.modules.size;
    let path = '';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (qr.modules.get(y, x)) path += `M${x} ${y}h1v1h-1z`;
    }
    return { d: path, n: size };
  }, [value, level]);
  const q = 2; // quiet zone in modules (the plate around it adds more)
  return (
    <svg
      className={className}
      viewBox={`${-q} ${-q} ${n + 2 * q} ${n + 2 * q}`}
      role="img"
      aria-label={label}
      data-testid={testId}
      data-url={value}
      shapeRendering="crispEdges"
    >
      <rect x={-q} y={-q} width={n + 2 * q} height={n + 2 * q} fill="#fff" />
      <path d={d} fill="#0e0e10" />
    </svg>
  );
}
