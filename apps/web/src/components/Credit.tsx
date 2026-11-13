import { withBase } from '../lib/base';

/** Crédito discreto do desenvolvedor. `dark` para fundos escuros (logo em branco). */
export function Credit({ dark = false }: { dark?: boolean }) {
  return (
    <span className={`credit${dark ? ' dark' : ''}`}>
      <span>Desenvolvido por</span>
      <img src={withBase('/apoena-dev.png')} alt="Apoena Dev" width={88} height={18} />
    </span>
  );
}
