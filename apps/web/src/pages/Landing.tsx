import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { withBase } from '../lib/base';
import { Link } from '../lib/router';
import { Brand } from '../components/Brand';
import { Credit } from '../components/Credit';

/*
 * Página de apresentação do sistema (antes do login).
 * Estrutura e visual inspirados no template "CelestialSaaS" de
 * PaulleDemon/awesome-landing-pages (licença MIT, © 2024 Paul).
 */

const icon = (d: ReactNode) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);

const FEATURES: { title: string; text: string; ico: ReactNode }[] = [
  {
    title: 'Frente de caixa rápida',
    text: 'Leitor de código de barras, atalhos de teclado e vários pagamentos na mesma venda: dinheiro, PIX, cartão, crediário e vale-troca.',
    ico: icon(<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M7 20h10M12 16v4" /></>),
  },
  {
    title: 'Vende mesmo sem internet',
    text: 'Se a conexão cair, o caixa continua vendendo e envia tudo sozinho quando ela voltar, sem duplicar nenhuma venda.',
    ico: icon(<><path d="M2 8.8a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0" /><circle cx="12" cy="19.5" r="1" /></>),
  },
  {
    title: 'Estoque com grade',
    text: 'Cor e tamanho em cada produto, estoque mínimo, histórico de cada movimento e entrada de mercadoria pelo XML da nota do fornecedor.',
    ico: icon(<><path d="M21 8 12 3 3 8l9 5 9-5Z" /><path d="m3 13 9 5 9-5" /></>),
  },
  {
    title: 'Nota fiscal integrada',
    text: 'NFC-e no balcão e NF-e para outros estados, com reenvio automático quando a SEFAZ está fora do ar.',
    ico: icon(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>),
  },
  {
    title: 'Crediário e trocas',
    text: 'Parcelas com limite por cliente, recebimento parcial, lembrete pelo WhatsApp e troca com vale-troca na hora.',
    ico: icon(<><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18M7 15h3" /></>),
  },
  {
    title: 'Loja online no mesmo estoque',
    text: 'Seus clientes compram pela internet o que está na prateleira. As peças ficam reservadas até você faturar o pedido.',
    ico: icon(<><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" /><path d="M3 6h18M16 10a4 4 0 0 1-8 0" /></>),
  },
];

export function LandingPage() {
  const [info, setInfo] = useState<{ name: string | null; shopSlug: string | null } | null>(null);
  useEffect(() => {
    api('/public/info').then(setInfo).catch(() => setInfo(null));
    document.title = 'Concept PDV — ponto de venda para sua loja';
    return () => {
      document.title = 'Concept PDV';
    };
  }, []);
  const shop = info?.shopSlug ? `/loja/${info.shopSlug}` : null;

  return (
    <div className="lp">
      <header className="lp-head">
        <Brand />
        <nav className="lp-nav" aria-label="Seções">
          <a href="#recursos">Recursos</a>
          <a href="#como-funciona">Como funciona</a>
          {shop && <Link to={shop}>Loja online</Link>}
        </nav>
        <Link className="btn primary" to="/entrar">
          Entrar
        </Link>
      </header>

      <section className="lp-hero">
        <h1>
          Venda no balcão
          <br />e na internet,
          <span>até sem internet</span>
        </h1>
        <p>
          Caixa, estoque, crediário, nota fiscal e loja online num sistema só, que abre em qualquer computador ou celular e continua
          vendendo quando a conexão cai.
        </p>
        <div className="lp-cta">
          <Link className="btn primary lg" to="/entrar">
            Entrar no sistema
          </Link>
          {shop ? (
            <Link className="btn soft lg" to={shop}>
              Ver a loja online
            </Link>
          ) : (
            <a className="btn soft lg" href="#recursos">
              Conhecer os recursos
            </a>
          )}
        </div>
        <div className="lp-shot">
          <img src={withBase('/landing/painel.webp')} alt="Painel do Concept PDV com faturamento, vendas por dia e formas de pagamento" width={1600} height={1000} />
        </div>
      </section>

      <section className="lp-section" id="recursos">
        <span className="lp-eyebrow">Simples. Rápido. Confiável.</span>
        <h2>Tudo o que a loja precisa</h2>
        <div className="lp-features">
          {FEATURES.map((f) => (
            <article key={f.title} className="lp-feature">
              <div className="ico">{f.ico}</div>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section" id="como-funciona">
        <span className="lp-eyebrow">Do estoque ao cupom</span>
        <h2>Como funciona</h2>
        <div className="lp-split">
          <ol>
            <li>
              <span>
                <b>Cadastre ou importe os produtos</b>
                <span>Monte a grade de cores e tamanhos ou leia o XML da nota do fornecedor: estoque e custo entram sozinhos.</span>
              </span>
            </li>
            <li>
              <span>
                <b>Abra o caixa e venda</b>
                <span>Cada operador entra direto no caixa da loja dele. Leia o código, receba e imprima o cupom em duas vias.</span>
              </span>
            </li>
            <li>
              <span>
                <b>Feche o dia com tudo conferido</b>
                <span>Fechamento cego com relatório impresso, painel de vendas, curva ABC e alerta de estoque baixo.</span>
              </span>
            </li>
          </ol>
          <div className="lp-shot">
            <img src={withBase('/landing/frente.webp')} alt="Frente de caixa do Concept PDV com itens da venda e total" width={1600} height={1000} loading="lazy" />
          </div>
        </div>
      </section>

      <section className="lp-band">
        <h2>Pronto para começar o dia?</h2>
        <p>Entre com o e-mail e a senha cadastrados pelo administrador da loja.</p>
        <Link className="btn lg" to="/entrar">
          Entrar no sistema
        </Link>
      </section>

      <footer className="lp-foot">
        <Brand />
        <span>
          {shop && (
            <Link to={shop} style={{ marginRight: 18 }}>
              Loja online
            </Link>
          )}
          <Link to="/entrar">Entrar</Link>
        </span>
        <Credit />
      </footer>
    </div>
  );
}
