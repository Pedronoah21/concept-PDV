import { withBase } from '../lib/base';

/** Logotipo do Concept PDV (ícone + nome). */
export function Brand({ className = '' }: { className?: string }) {
  return (
    <span className={`brandmark ${className}`}>
      <img src={withBase('/icon.svg')} alt="" width={30} height={30} />
      <span>
        Concept <b>PDV</b>
      </span>
    </span>
  );
}
